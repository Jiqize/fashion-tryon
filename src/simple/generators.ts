import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import path from 'node:path'

import sharp from 'sharp'

import { RunnerError } from '../errors.js'
import type { ImageGenerationPort } from '../ports.js'

// 精简流程的出图引擎：一次调用 = 模特照 + 若干服装参考图 → 一张成图，写到 outPath

export interface SimpleGenerateRequest {
  modelPath: string
  referencePaths: string[]
  prompt: string
  outPath: string
}

export interface SimpleGenerator {
  readonly name: string
  generate(request: SimpleGenerateRequest, signal: AbortSignal): Promise<void>
}

export interface CodexOptions {
  /** codex 可执行文件，默认 `codex` */
  bin?: string
  model?: string
  /** 单次调用超时，默认 300 秒；codex 卡住时不报错，只能靠超时 */
  timeoutMs?: number
  attempts?: number
}

async function nonEmpty(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).size > 0
  } catch {
    return false
  }
}

function runOnce(bin: string, args: string[], timeoutMs: number, signal: AbortSignal): Promise<string> {
  return new Promise((resolve) => {
    // stdin 必须关闭：codex exec 在 stdin 打开时会一直等输入
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const collect = (chunk: Buffer): void => {
      output = (output + chunk.toString('utf8')).slice(-4000)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const kill = (): void => {
      child.kill('SIGTERM')
    }
    const timer = setTimeout(kill, timeoutMs)
    signal.addEventListener('abort', kill, { once: true })
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', kill)
      resolve(output)
    }
    child.on('error', (error) => {
      output += `\n${error.message}`
      done()
    })
    child.on('close', done)
  })
}

/** Codex CLI 内置出图。必须串行调用：并发时 codex 可能把图存错位置。 */
export function createCodexGenerator(options: CodexOptions = {}): SimpleGenerator {
  const bin = options.bin ?? 'codex'
  // 2026-10-14 ChatGPT 账号已不支持 gpt-5.5（400 invalid_request_error），换 gpt-5.6-terra
  const model = options.model ?? 'gpt-5.6-terra'
  const timeoutMs = options.timeoutMs ?? 300_000
  const attempts = options.attempts ?? 3
  return {
    name: 'codex',
    async generate(request, signal) {
      const instruction = [
        'Use your built-in image generation tool (imagegen) to create ONE image and save it to the EXACT absolute path:',
        request.outPath,
        'Do NOT write code or call any external API — use your native image generation tool only.',
        // codex 只支持这三种尺寸，写别的会一直挂到超时
        'Size: 1024x1536.',
        request.prompt,
        'Apart from labels and prints that are on the reference garment itself, do not add any brand name, magazine name or logo.',
      ].join('\n')
      const args = [
        'exec', '--skip-git-repo-check', '--ignore-user-config', '-s', 'workspace-write',
        '-c', 'approval_policy=never', '-c', `model=${model}`, '-c', 'model_reasoning_effort=low',
        '-C', path.dirname(request.outPath),
        ...[request.modelPath, ...request.referencePaths].flatMap((file) => ['-i', file]),
        '--', instruction,
      ]
      let lastOutput = ''
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        if (signal.aborted) throw new RunnerError('ABORTED', 'Run was aborted')
        lastOutput = await runOnce(bin, args, timeoutMs, signal)
        if (await nonEmpty(request.outPath)) return
      }
      throw new RunnerError(
        'PROVIDER_RESPONSE',
        `codex 出图 ${String(attempts)} 次都没有生成文件：${lastOutput.trim().split('\n').slice(-3).join(' ')}`,
        { retryable: true },
      )
    },
  }
}

/** APIMart 出图：沿用现有适配器，图1 为模特照，其后为服装参考图。 */
export function createApimartGenerator(
  port: ImageGenerationPort,
  settings: { model: string; size: Parameters<ImageGenerationPort['generate']>[0]['size'] },
): SimpleGenerator {
  return {
    name: 'apimart',
    async generate(request, signal) {
      const image = await port.generate({
        garmentPath: request.referencePaths[0]!,
        modelPath: request.modelPath,
        referencePaths: request.referencePaths,
        prompt: request.prompt,
        model: settings.model,
        size: settings.size,
      }, signal)
      // 服务商可能返回 jpeg / webp，统一转成 png 落盘
      await sharp(image.bytes).png().toFile(request.outPath)
    },
  }
}

/** 测试用假引擎：等 delayMs（可被取消）后写一张 8×12 灰图；outPath 含 failOn 时报错。不产生费用。 */
export function createFakeGenerator(options: { delayMs?: number; failOn?: string } = {}): SimpleGenerator {
  return {
    name: 'fake',
    async generate(request, signal) {
      await new Promise<void>((resolve, reject) => {
        const abort = (): void => {
          clearTimeout(timer)
          reject(new RunnerError('ABORTED', 'Run was aborted'))
        }
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', abort)
          resolve()
        }, options.delayMs ?? 0)
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
      })
      if (options.failOn !== undefined && request.outPath.includes(options.failOn)) {
        throw new RunnerError('PROVIDER_ERROR', `fake failure: ${request.outPath}`)
      }
      await sharp({ create: { width: 8, height: 12, channels: 3, background: '#808080' } })
        .png()
        .toFile(request.outPath)
    },
  }
}
