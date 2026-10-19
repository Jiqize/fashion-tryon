import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createApimartAdapter } from '../src/providers/apimart.js'

const realSetImmediate = setImmediate

/** 下载结果必须是真图片；测试用最小合成图代替随手写的字节。 */
async function pngBytes(): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({ create: { width: 4, height: 4, channels: 3, background: '#123456' } })
      .png()
      .toBuffer(),
  )
}

function imageResponse(bytes: Uint8Array, contentType = 'image/png'): Response {
  return new Response(bytes, { status: 200, headers: { 'content-type': contentType } })
}

function jsonResponse(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

interface TestGenerationCheckpoint {
  providerRequestId?: string
  onProviderRequestId?: (providerRequestId: string) => Promise<void>
}

describe('createApimartAdapter', () => {
  let workspace = ''
  let garmentPath = ''
  let modelPath = ''

  beforeEach(async () => {
    vi.useFakeTimers()
    workspace = await mkdtemp(path.join(tmpdir(), 'fashion-tryon-apimart-'))
    garmentPath = path.join(workspace, 'garment.jpg')
    modelPath = path.join(workspace, 'model.jpg')
    await mkdir(workspace, { recursive: true })
    await writeFile(garmentPath, new Uint8Array([1, 2, 3]))
    await writeFile(modelPath, new Uint8Array([4, 5, 6]))
  })

  afterEach(async () => {
    vi.useRealTimers()
    await rm(workspace, { recursive: true, force: true })
  })

  function adapter(fetchImpl: typeof fetch, pollTimeoutMs = 20) {
    return createApimartAdapter(
      {
        apiKey: 'apimart-test-key',
        baseUrl: 'https://api.example/v1',
        pollIntervalMs: 2,
        pollTimeoutMs,
        requestTimeoutMs: 60_000,
        transferTimeoutMs: 180_000,
      },
      fetchImpl,
    )
  }

  async function generate(
    fetchImpl: typeof fetch,
    pollTimeoutMs = 20,
    checkpoint?: TestGenerationCheckpoint,
  ) {
    const pending = adapter(fetchImpl, pollTimeoutMs).generate(
      {
        garmentPath,
        modelPath,
        prompt: 'replace clothing',
        model: 'gemini-test-image',
        size: '3:4',
      },
      new AbortController().signal,
      checkpoint,
    )
    let settled = false
    let value: Awaited<typeof pending> | undefined
    let failure: unknown
    void pending.then(
      (result) => {
        value = result
        settled = true
      },
      (error: unknown) => {
        failure = error
        settled = true
      },
    )
    for (let turn = 0; turn < 500 && !settled; turn += 1) {
      await new Promise<void>((resolve) => realSetImmediate(resolve))
      await vi.runOnlyPendingTimersAsync()
    }
    if (!settled) throw new Error('provider test did not settle')
    if (failure !== undefined) throw failure
    return value!
  }

  it('uploads garment then model, submits, polls, downloads nested URL, and returns request ID', async () => {
    const png = await pngBytes()
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { url: 'https://upload.example/garment.jpg' }))
      .mockResolvedValueOnce(jsonResponse(200, { url: 'https://upload.example/model.jpg' }))
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ task_id: 'task-1' }] }))
      .mockResolvedValueOnce(jsonResponse(200, { data: { status: 'pending' } }))
      .mockResolvedValueOnce(jsonResponse(200, {
        data: {
          status: 'completed',
          result: { images: [{ url: [['https://cdn.example/result.png']] }] },
        },
      }))
      .mockResolvedValueOnce(imageResponse(png))

    const result = await generate(fetchImpl as unknown as typeof fetch)

    expect(result).toMatchObject({
      bytes: png,
      mediaType: 'image/png',
      providerRequestId: 'task-1',
    })
    expect(fetchImpl.mock.calls.slice(0, 2).map((call) => call[0])).toEqual([
      'https://api.example/v1/uploads/images',
      'https://api.example/v1/uploads/images',
    ])
    const submitBody = JSON.parse(fetchImpl.mock.calls[2]![1]!.body as string)
    expect(submitBody).toEqual({
      model: 'gemini-test-image',
      prompt: 'replace clothing',
      size: '3:4',
      n: 1,
      image_urls: ['https://upload.example/garment.jpg', 'https://upload.example/model.jpg'],
    })
    expect(fetchImpl.mock.calls[5]![0]).toBe('https://cdn.example/result.png')
  })

  it('checkpoints the provider task ID before a later poll failure', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { url: 'https://upload.example/garment.jpg' }))
      .mockResolvedValueOnce(jsonResponse(200, { url: 'https://upload.example/model.jpg' }))
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ task_id: 'task-checkpoint' }] }))
      .mockRejectedValueOnce(new Error('poll offline'))
    const checkpointed: string[] = []

    await expect(generate(fetchImpl as unknown as typeof fetch, 20, {
      onProviderRequestId: async (providerRequestId) => {
        checkpointed.push(providerRequestId)
      },
    })).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' })

    expect(checkpointed).toEqual(['task-checkpoint'])
  })

  it('resumes an existing provider task without uploading or submitting again', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, {
        data: {
          status: 'completed',
          result: { images: [{ url: 'https://cdn.example/resumed.png' }] },
        },
      }))
      .mockResolvedValueOnce(imageResponse(await pngBytes()))

    const result = await generate(fetchImpl as unknown as typeof fetch, 20, {
      providerRequestId: 'task-existing',
    })

    expect(result.providerRequestId).toBe('task-existing')
    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      'https://api.example/v1/tasks/task-existing',
      'https://cdn.example/resumed.png',
    ])
  })

  it('records the request stage and underlying network cause', async () => {
    const cause = Object.assign(new Error('Connect Timeout Error'), {
      code: 'UND_ERR_CONNECT_TIMEOUT',
    })
    const fetchImpl = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed', { cause }))

    await expect(generate(fetchImpl as unknown as typeof fetch)).rejects.toMatchObject({
      code: 'PROVIDER_TIMEOUT',
      retryable: true,
      message: expect.stringMatching(/garment upload.*UND_ERR_CONNECT_TIMEOUT/),
    })
  })

  it('does not automatically retry an ambiguous generation submission', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { url: 'https://upload.example/garment.jpg' }))
      .mockResolvedValueOnce(jsonResponse(200, { url: 'https://upload.example/model.jpg' }))
      .mockRejectedValueOnce(new TypeError('fetch failed'))

    await expect(generate(fetchImpl as unknown as typeof fetch)).rejects.toMatchObject({
      code: 'PROVIDER_SUBMISSION_UNKNOWN',
      retryable: false,
      message: expect.stringContaining('generation submit'),
    })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('normalizes failed task, poll timeout, 429, and malformed task ID', async () => {
    const prefix = () => [
      jsonResponse(200, { url: 'https://upload.example/g.jpg' }),
      jsonResponse(200, { url: 'https://upload.example/m.jpg' }),
    ]
    const failedFetch = vi.fn()
    for (const response of [
      ...prefix(),
      jsonResponse(200, { data: [{ task_id: 'failed-task' }] }),
      jsonResponse(200, { data: { status: 'failed', error: { message: 'bad input' } } }),
    ]) failedFetch.mockResolvedValueOnce(response)
    await expect(generate(failedFetch as unknown as typeof fetch)).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
      retryable: false,
    })

    const timeoutFetch = vi.fn()
    for (const response of [
      ...prefix(),
      jsonResponse(200, { data: [{ task_id: 'slow-task' }] }),
    ]) timeoutFetch.mockResolvedValueOnce(response)
    timeoutFetch.mockImplementation(() =>
      Promise.resolve(jsonResponse(200, { data: { status: 'processing' } })),
    )
    await expect(generate(timeoutFetch as unknown as typeof fetch, 4)).rejects.toMatchObject({
      code: 'PROVIDER_TIMEOUT',
      retryable: true,
    })

    const limitedFetch = vi.fn().mockResolvedValueOnce(jsonResponse(429, { error: 'slow down' }))
    await expect(generate(limitedFetch as unknown as typeof fetch)).rejects.toMatchObject({
      code: 'PROVIDER_RATE_LIMIT',
      retryable: true,
    })

    const malformedFetch = vi.fn()
      .mockResolvedValueOnce(prefix()[0])
      .mockResolvedValueOnce(prefix()[1])
      .mockResolvedValueOnce(jsonResponse(200, { data: [] }))
    await expect(generate(malformedFetch as unknown as typeof fetch)).rejects.toMatchObject({
      code: 'PROVIDER_RESPONSE',
      retryable: false,
    })
  })

  function completedTask(resultUrl: string) {
    return jsonResponse(200, {
      data: { status: 'completed', result: { images: [{ url: resultUrl }] } },
    })
  }

  function submittedPrefix(taskId: string, ...rest: Response[]) {
    const fetchImpl = vi.fn()
    for (const response of [
      jsonResponse(200, { url: 'https://upload.example/garment.jpg' }),
      jsonResponse(200, { url: 'https://upload.example/model.jpg' }),
      jsonResponse(200, { data: [{ task_id: taskId }] }),
      ...rest,
    ]) fetchImpl.mockResolvedValueOnce(response)
    return fetchImpl
  }

  it('treats a generation submit HTTP 502 as an unknown submission and never resubmits', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { url: 'https://upload.example/garment.jpg' }))
      .mockResolvedValueOnce(jsonResponse(200, { url: 'https://upload.example/model.jpg' }))
      .mockResolvedValueOnce(jsonResponse(502, { error: 'bad gateway' }))

    await expect(generate(fetchImpl as unknown as typeof fetch)).rejects.toMatchObject({
      code: 'PROVIDER_SUBMISSION_UNKNOWN',
      retryable: false,
      message: expect.stringContaining('outcome unknown'),
    })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(fetchImpl.mock.calls[2]![0]).toBe('https://api.example/v1/images/generations')
  })

  it('treats a generation submit HTTP 429 as a rate limit the provider did not accept', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { url: 'https://upload.example/garment.jpg' }))
      .mockResolvedValueOnce(jsonResponse(200, { url: 'https://upload.example/model.jpg' }))
      .mockResolvedValueOnce(jsonResponse(429, { error: 'too many requests' }))
    const checkpointed: string[] = []

    await expect(generate(fetchImpl as unknown as typeof fetch, 20, {
      onProviderRequestId: async (id) => {
        checkpointed.push(id)
      },
    })).rejects.toMatchObject({
      code: 'PROVIDER_RATE_LIMIT',
      retryable: true,
      message: expect.stringContaining('generation submit'),
    })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(fetchImpl.mock.calls[2]![0]).toBe('https://api.example/v1/images/generations')
    expect(checkpointed).toEqual([])
  })

  it('reports a hung request as a provider timeout instead of a user abort', async () => {
    vi.useRealTimers()
    const fetchImpl = vi.fn((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal!.reason as Error)
        }, { once: true })
      }))
    const provider = createApimartAdapter({
      apiKey: 'apimart-test-key',
      baseUrl: 'https://api.example/v1',
      pollIntervalMs: 1,
      pollTimeoutMs: 60_000,
      requestTimeoutMs: 25,
      transferTimeoutMs: 25,
    }, fetchImpl as unknown as typeof fetch)

    await expect(provider.generate(
      { garmentPath, modelPath, prompt: 'p', model: 'm', size: '3:4' },
      new AbortController().signal,
      { providerRequestId: 'task-hung' },
    )).rejects.toMatchObject({
      code: 'PROVIDER_TIMEOUT',
      retryable: true,
      message: expect.stringContaining('task poll'),
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('bounds polling by wall-clock time using the injected clock', async () => {
    vi.useRealTimers()
    let current = 1_000
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { data: { status: 'processing' } }))
    const provider = createApimartAdapter(
      {
        apiKey: 'apimart-test-key',
        baseUrl: 'https://api.example/v1',
        pollIntervalMs: 0,
        pollTimeoutMs: 100,
        requestTimeoutMs: 1_000,
        transferTimeoutMs: 1_000,
      },
      fetchImpl as unknown as typeof fetch,
      () => {
        current += 60
        return current
      },
    )

    await expect(provider.generate(
      { garmentPath, modelPath, prompt: 'p', model: 'm', size: '3:4' },
      new AbortController().signal,
      { providerRequestId: 'task-slow' },
    )).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT', retryable: true })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['http://cdn.example/result.png'],
    ['https://127.0.0.1:9222/result.png'],
    ['https://192.168.1.10/result.png'],
    ['https://[::1]/result.png'],
    ['https://10.0.0.5/result.png'],
  ])('refuses to download an unsafe result URL %s', async (resultUrl) => {
    const fetchImpl = submittedPrefix('task-url', completedTask(resultUrl))

    await expect(generate(fetchImpl as unknown as typeof fetch)).rejects.toMatchObject({
      code: 'PROVIDER_RESPONSE',
      retryable: false,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(4)
  })

  it('refuses a download redirect and asks fetch not to follow one', async () => {
    const fetchImpl = submittedPrefix(
      'task-redirect',
      completedTask('https://cdn.example/result.png'),
      new Response('', { status: 302, headers: { location: 'https://evil.example/x' } }),
    )

    await expect(generate(fetchImpl as unknown as typeof fetch)).rejects.toMatchObject({
      code: 'PROVIDER_RESPONSE',
      retryable: false,
      message: expect.stringContaining('redirected'),
    })
    expect((fetchImpl.mock.calls[4]![1] as RequestInit).redirect).toBe('manual')
  })

  it('rejects a response whose declared Content-Length exceeds the limit', async () => {
    const fetchImpl = submittedPrefix(
      'task-huge',
      completedTask('https://cdn.example/result.png'),
      new Response(await pngBytes(), {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': String(64 * 1024 * 1024) },
      }),
    )

    await expect(generate(fetchImpl as unknown as typeof fetch)).rejects.toMatchObject({
      code: 'PROVIDER_RESPONSE',
      retryable: false,
      message: expect.stringContaining('byte limit'),
    })
  })

  it('rejects downloaded bytes that are not a decodable image of the declared type', async () => {
    const notAnImage = submittedPrefix(
      'task-html',
      completedTask('https://cdn.example/result.png'),
      imageResponse(new TextEncoder().encode('<html>error page</html>')),
    )
    await expect(generate(notAnImage as unknown as typeof fetch)).rejects.toMatchObject({
      code: 'PROVIDER_RESPONSE',
      retryable: false,
      message: expect.stringContaining('not a decodable image'),
    })

    const mismatched = submittedPrefix(
      'task-mismatch',
      completedTask('https://cdn.example/result.jpg'),
      imageResponse(await pngBytes(), 'image/jpeg'),
    )
    await expect(generate(mismatched as unknown as typeof fetch)).rejects.toMatchObject({
      code: 'PROVIDER_RESPONSE',
      retryable: false,
      message: expect.stringContaining('does not match'),
    })
  })

  it('rejects a downloaded result whose content type and extension are unsupported', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, { url: 'https://upload.example/garment.jpg' }))
      .mockResolvedValueOnce(jsonResponse(200, { url: 'https://upload.example/model.jpg' }))
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ task_id: 'task-media' }] }))
      .mockResolvedValueOnce(jsonResponse(200, {
        data: {
          status: 'completed',
          result: { images: [{ url: 'https://cdn.example/result.bin' }] },
        },
      }))
      .mockResolvedValueOnce(imageResponse(new Uint8Array([9, 8, 7]), 'application/octet-stream'))

    await expect(generate(fetchImpl as unknown as typeof fetch)).rejects.toMatchObject({
      code: 'PROVIDER_RESPONSE',
      retryable: false,
    })
  })
})
