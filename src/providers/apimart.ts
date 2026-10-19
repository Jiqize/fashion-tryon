import { readFile } from 'node:fs/promises'
import path from 'node:path'

import sharp from 'sharp'

import type { ApimartConfig } from '../config.js'
import { RunnerError } from '../errors.js'
import type { GeneratedImage, ImageGenerationPort } from '../ports.js'
import { normalizeProviderError, redactProviderDetail } from './http-errors.js'

type Stage = 'garment upload' | 'model upload' | 'generation submit' | 'task poll' | 'result download'

/** JSON 响应体上限，防止异常大响应把内存打满。 */
const MAX_JSON_BYTES = 8 * 1024 * 1024
/** 图片响应体上限。 */
const MAX_IMAGE_BYTES = 32 * 1024 * 1024

const IMAGE_FORMATS: Record<GeneratedImage['mediaType'], string> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
}

function url(baseUrl: string, pathname: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${pathname.replace(/^\/+/, '')}`
}

function mediaType(filePath: string): 'image/jpeg' | 'image/png' | 'image/webp' {
  const extension = path.extname(filePath).toLocaleLowerCase('en-US')
  if (extension === '.png') return 'image/png'
  if (extension === '.webp') return 'image/webp'
  return 'image/jpeg'
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new RunnerError('ABORTED', 'APIMART request was aborted')
}

/** 单请求超时触发的中止；与 run signal 的用户中止必须区分开。 */
function isTimeoutAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new RunnerError('ABORTED', 'APIMART request was aborted'))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new RunnerError('ABORTED', 'APIMART request was aborted'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** 提交阶段的结果永远不确定，绝不允许自动重提。 */
function submissionUnknown(stage: Stage, message: string, apiKey: string, cause: unknown): RunnerError {
  return new RunnerError(
    'PROVIDER_SUBMISSION_UNKNOWN',
    redactProviderDetail(`${stage}: ${message}; outcome unknown, not automatically retried`, [apiKey]),
    { cause },
  )
}

function stageError(stage: Stage, normalized: RunnerError, apiKey: string): RunnerError {
  return new RunnerError(
    normalized.code,
    redactProviderDetail(`${stage}: ${normalized.message}`, [apiKey]),
    {
      // 提交阶段一律不可重试，其余阶段沿用规范化后的语义。
      retryable: stage === 'generation submit' ? false : normalized.retryable,
      cause: normalized,
    },
  )
}

async function request(
  fetchImpl: typeof fetch,
  requestUrl: string,
  init: RequestInit,
  stage: Stage,
  signal: AbortSignal,
  apiKey: string,
  timeoutMs: number,
): Promise<Response> {
  throwIfAborted(signal)
  let response: Response
  try {
    response = await fetchImpl(requestUrl, {
      ...init,
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    })
  } catch (error) {
    // 只有 run signal 自身被取消才算用户中止；单请求超时属于 provider 超时。
    if (signal.aborted) throw new RunnerError('ABORTED', 'APIMART request was aborted')
    const normalized = isTimeoutAbort(error)
      ? new RunnerError(
          'PROVIDER_TIMEOUT',
          `request exceeded the ${String(timeoutMs)} ms per-request timeout`,
          { retryable: true },
        )
      : await normalizeProviderError('apimart', error, [apiKey])
    if (stage === 'generation submit') {
      throw submissionUnknown(stage, normalized.message, apiKey, normalized)
    }
    throw stageError(stage, normalized, apiKey)
  }
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    // 下载禁止跨 host 跳转；重定向一律当作不可信响应。
    throw new RunnerError('PROVIDER_RESPONSE', `${stage}: APIMART response was redirected`)
  }
  if (!response.ok) {
    const normalized = await normalizeProviderError('apimart', response, [apiKey])
    if (stage === 'generation submit' && response.status === 429) {
      // 429 表示服务商未受理该任务，可以由调用方降速后重新提交。
      throw new RunnerError(
        'PROVIDER_RATE_LIMIT',
        redactProviderDetail(`${stage}: ${normalized.message}`, [apiKey]),
        { retryable: true, cause: normalized },
      )
    }
    if (stage === 'generation submit' && normalized.retryable) {
      // 上游可能已经受理该任务，5xx/408 同样不得触发自动重提。
      throw submissionUnknown(stage, normalized.message, apiKey, normalized)
    }
    throw stageError(stage, normalized, apiKey)
  }
  return response
}

/** 先看 Content-Length，再在流式读取过程中强制同一上限。 */
async function readLimitedBody(
  response: Response,
  limitBytes: number,
  context: string,
): Promise<Uint8Array> {
  const tooLarge = (): RunnerError => new RunnerError(
    'PROVIDER_RESPONSE',
    `APIMART ${context} exceeds the ${String(limitBytes)} byte limit`,
  )
  const declared = response.headers.get('content-length')
  if (declared !== null) {
    const size = Number(declared)
    if (Number.isFinite(size) && size > limitBytes) throw tooLarge()
  }
  const body = response.body
  if (body === null) return new Uint8Array()
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limitBytes) throw tooLarge()
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return merged
}

async function jsonBody(response: Response, context: string): Promise<Record<string, unknown>> {
  const bytes = await readLimitedBody(response, MAX_JSON_BYTES, context)
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('not object')
    return value as Record<string, unknown>
  } catch {
    throw new RunnerError('PROVIDER_RESPONSE', `APIMART returned malformed ${context}`)
  }
}

function collectUrls(value: unknown, output: string[]): void {
  if (typeof value === 'string' && /^https?:\/\//.test(value)) {
    output.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectUrls(item, output)
  }
}

/** 回环与私有网段不得作为结果地址，避免被引导访问本机服务。 */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLocaleLowerCase('en-US')
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.startsWith('[')) {
    const address = host.slice(1, -1)
    if (address === '::1' || address === '::') return true
    const first = address.split(':')[0] ?? ''
    return /^f[cd][0-9a-f]{0,2}$/.test(first) || /^fe[89ab][0-9a-f]?$/.test(first)
  }
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (octets === null) return false
  const first = Number(octets[1])
  const second = Number(octets[2])
  if (first === 0 || first === 10 || first === 127) return true
  if (first === 172 && second >= 16 && second <= 31) return true
  if (first === 192 && second === 168) return true
  return first === 169 && second === 254
}

function safeResultUrl(value: string): URL {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new RunnerError('PROVIDER_RESPONSE', 'APIMART result URL is not a valid URL')
  }
  if (parsed.protocol !== 'https:') {
    throw new RunnerError('PROVIDER_RESPONSE', 'APIMART result URL must use https')
  }
  if (isPrivateHost(parsed.hostname)) {
    throw new RunnerError('PROVIDER_RESPONSE', 'APIMART result URL points to a private address')
  }
  return parsed
}

function outputMediaType(response: Response, resultUrl: URL): GeneratedImage['mediaType'] {
  const header = response.headers.get('content-type')?.split(';')[0]?.trim().toLocaleLowerCase('en-US')
  if (header === 'image/jpeg' || header === 'image/png' || header === 'image/webp') return header
  const extension = path.extname(resultUrl.pathname).toLocaleLowerCase('en-US')
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
  if (extension === '.png') return 'image/png'
  if (extension === '.webp') return 'image/webp'
  throw new RunnerError('PROVIDER_RESPONSE', 'APIMART result has an unsupported media type')
}

/** 下载字节必须是能解码的真实图片，且格式与 media type 一致。 */
async function assertDecodableImage(
  bytes: Uint8Array,
  declared: GeneratedImage['mediaType'],
): Promise<void> {
  let format: string | undefined
  try {
    format = (await sharp(bytes).metadata()).format
  } catch {
    throw new RunnerError('PROVIDER_RESPONSE', 'APIMART result is not a decodable image')
  }
  if (format !== IMAGE_FORMATS[declared]) {
    throw new RunnerError(
      'PROVIDER_RESPONSE',
      `APIMART result image format ${format ?? 'unknown'} does not match ${declared}`,
    )
  }
}

export function createApimartAdapter(
  config: ApimartConfig,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): ImageGenerationPort {
  const auth = { Authorization: `Bearer ${config.apiKey}` }

  const upload = async (
    filePath: string,
    stage: 'garment upload' | 'model upload',
    signal: AbortSignal,
  ): Promise<string> => {
    const body = new FormData()
    body.append('file', new Blob([await readFile(filePath)], { type: mediaType(filePath) }), path.basename(filePath))
    const response = await request(fetchImpl, url(config.baseUrl, 'uploads/images'), {
      method: 'POST',
      headers: auth,
      body,
    }, stage, signal, config.apiKey, config.transferTimeoutMs)
    const parsed = await jsonBody(response, 'upload response')
    if (typeof parsed.url !== 'string' || !/^https?:\/\//.test(parsed.url)) {
      throw new RunnerError('PROVIDER_RESPONSE', 'APIMART upload response is missing url')
    }
    return parsed.url
  }

  return {
    async generate(generateRequest, signal, checkpoint) {
      let taskId = checkpoint?.providerRequestId
      if (taskId === undefined) {
        const imageUrls = generateRequest.referencePaths === undefined
          ? [
              await upload(generateRequest.garmentPath, 'garment upload', signal),
              await upload(generateRequest.modelPath, 'model upload', signal),
            ]
          : [await upload(generateRequest.modelPath, 'model upload', signal)]
        for (const referencePath of generateRequest.referencePaths ?? []) {
          imageUrls.push(await upload(referencePath, 'garment upload', signal))
        }
        const submit = await request(fetchImpl, url(config.baseUrl, 'images/generations'), {
          method: 'POST',
          headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: generateRequest.model,
            prompt: generateRequest.prompt,
            size: generateRequest.size,
            n: 1,
            image_urls: imageUrls,
          }),
        }, 'generation submit', signal, config.apiKey, config.requestTimeoutMs)
        const submitted = await jsonBody(submit, 'generation response')
        const data = submitted.data
        const submittedTaskId = Array.isArray(data) && typeof data[0] === 'object' && data[0] !== null
          ? (data[0] as Record<string, unknown>).task_id
          : undefined
        if (typeof submittedTaskId !== 'string' || submittedTaskId === '') {
          throw new RunnerError('PROVIDER_RESPONSE', 'APIMART generation response is missing task_id')
        }
        taskId = submittedTaskId
        await checkpoint?.onProviderRequestId?.(taskId)
      }

      // 墙钟 deadline：网关半死时不会因为 sleep 计数而无限等待。
      const deadline = now() + config.pollTimeoutMs
      let resultUrl: URL | undefined
      while (resultUrl === undefined) {
        if (now() >= deadline) {
          throw new RunnerError('PROVIDER_TIMEOUT', `APIMART task ${taskId} timed out`, {
            retryable: true,
          })
        }
        await sleep(config.pollIntervalMs, signal)
        const polled = await request(fetchImpl, url(config.baseUrl, `tasks/${encodeURIComponent(taskId)}`), {
          headers: auth,
        }, 'task poll', signal, config.apiKey, config.requestTimeoutMs)
        const pollBody = await jsonBody(polled, 'task response')
        const task = typeof pollBody.data === 'object' && pollBody.data !== null && !Array.isArray(pollBody.data)
          ? pollBody.data as Record<string, unknown>
          : undefined
        const status = task?.status
        if (status === 'failed' || status === 'error' || status === 'cancelled') {
          throw new RunnerError('PROVIDER_ERROR', `APIMART task ${taskId} failed`)
        }
        if (status === 'completed') {
          const result = typeof task?.result === 'object' && task.result !== null
            ? task.result as Record<string, unknown>
            : undefined
          const images = Array.isArray(result?.images) ? result.images : []
          const urls: string[] = []
          for (const image of images) {
            if (typeof image === 'object' && image !== null) {
              collectUrls((image as Record<string, unknown>).url, urls)
            }
          }
          if (urls.length === 0) {
            throw new RunnerError('PROVIDER_RESPONSE', `APIMART task ${taskId} has no image URL`)
          }
          resultUrl = safeResultUrl(urls[0]!)
        }
      }

      const downloaded = await request(
        fetchImpl,
        resultUrl.toString(),
        { redirect: 'manual' },
        'result download',
        signal,
        config.apiKey,
        config.transferTimeoutMs,
      )
      const declared = outputMediaType(downloaded, resultUrl)
      const bytes = await readLimitedBody(downloaded, MAX_IMAGE_BYTES, 'result image')
      await assertDecodableImage(bytes, declared)
      return {
        bytes,
        mediaType: declared,
        providerRequestId: taskId,
      }
    },
  }
}
