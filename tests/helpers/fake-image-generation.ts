import { RunnerError } from '../../src/errors.js'
import type {
  GeneratedImage,
  GenerateRequest,
  ImageGenerationPort,
} from '../../src/ports.js'

const ONE_PIXEL_PNG = new Uint8Array(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
))

export type GenerateHandler = (
  request: GenerateRequest,
  callIndex: number,
  signal: AbortSignal,
) => Promise<GeneratedImage> | GeneratedImage

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new RunnerError('ABORTED', 'fake generation aborted'))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new RunnerError('ABORTED', 'fake generation aborted'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export class FakeImageGeneration implements ImageGenerationPort {
  readonly calls: GenerateRequest[] = []
  active = 0
  maxActive = 0

  constructor(
    private readonly handler: GenerateHandler = (_request, callIndex) => ({
      bytes: ONE_PIXEL_PNG,
      mediaType: 'image/png',
      providerRequestId: `fake-${String(callIndex + 1)}`,
    }),
    private readonly latencyMs = 0,
  ) {}

  async generate(request: GenerateRequest, signal: AbortSignal): Promise<GeneratedImage> {
    const callIndex = this.calls.length
    this.calls.push(request)
    this.active += 1
    this.maxActive = Math.max(this.maxActive, this.active)
    try {
      if (this.latencyMs > 0) await delay(this.latencyMs, signal)
      return await this.handler(request, callIndex, signal)
    } finally {
      this.active -= 1
    }
  }
}

export function fakePng(requestId = 'fake-request'): GeneratedImage {
  return { bytes: ONE_PIXEL_PNG, mediaType: 'image/png', providerRequestId: requestId }
}

/**
 * 可控闸门：关闭时 wait() 挂起，打开后全部放行（之后的 wait 直接通过，直到再次关闭）。
 * 假服务商在返回前等它，测试就能确定地观察"生成中"的中间状态，而不靠固定延迟赌时序。
 */
export class Gate {
  private pending: { promise: Promise<void>; resolve: () => void } | undefined

  get closed(): boolean {
    return this.pending !== undefined
  }

  close(): void {
    if (this.pending !== undefined) return
    let resolve: () => void = () => {}
    const promise = new Promise<void>((done) => {
      resolve = done
    })
    this.pending = { promise, resolve }
  }

  open(): void {
    this.pending?.resolve()
    this.pending = undefined
  }

  /** 等闸门打开；中止信号触发时立即以 ABORTED 失败，避免停止引擎时卡住。 */
  wait(signal?: AbortSignal): Promise<void> {
    const pending = this.pending
    if (pending === undefined) return Promise.resolve()
    if (signal === undefined) return pending.promise
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new RunnerError('ABORTED', 'fake generation aborted'))
        return
      }
      const onAbort = (): void => reject(new RunnerError('ABORTED', 'fake generation aborted'))
      signal.addEventListener('abort', onAbort, { once: true })
      void pending.promise.then(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      })
    })
  }
}
