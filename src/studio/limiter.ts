import { RunnerError } from '../errors.js'

export interface Limiter {
  acquire(signal: AbortSignal): Promise<() => void>
  setLimit(n: number): void
  /** 服务商限流：有效并发减半，返回本次应暂停派发的毫秒数。 */
  onRateLimited(): number
  /** 生成成功：连续 10 次成功后有效并发 +1，不超过用户设置的上限。 */
  onSuccess(): void
  readonly limit: number
  readonly effectiveLimit: number
  readonly active: number
}

export interface LimiterOptions {
  random?: () => number
}

const BACKOFF_BASE_MS = 5_000
const BACKOFF_MAX_MS = 60_000
const BACKOFF_JITTER = 0.2
const SUCCESSES_TO_RAISE = 10

interface Waiter {
  resolve: (release: () => void) => void
  reject: (error: RunnerError) => void
  signal: AbortSignal
  onAbort: () => void
}

/**
 * 可调并发闸门：同时持有的名额不超过当前有效上限；运行中调高上限立即放行排队者，
 * 调低时已持有的名额照常用完，只是不再放行新的。
 * 有效上限随限流自适应：限流减半，连续成功逐步回升到用户设置的上限。
 */
export function createLimiter(initialLimit: number, options: LimiterOptions = {}): Limiter {
  const random = options.random ?? Math.random
  let limit = checkLimit(initialLimit)
  let effective = limit
  // 限流降速后、尚未回升到用户上限之前为 true
  let degraded = false
  let active = 0
  // 连续限流次数（决定退避时长）与限流后的连续成功次数
  let consecutiveLimits = 0
  let successStreak = 0
  const queue: Waiter[] = []

  function checkLimit(n: number): number {
    if (!Number.isInteger(n) || n < 1) {
      throw new RunnerError('VALIDATION_ERROR', 'Concurrency limit must be a positive integer')
    }
    return n
  }

  function releaseOnce(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      active -= 1
      drain()
    }
  }

  function drain(): void {
    while (active < effective && queue.length > 0) {
      const waiter = queue.shift()!
      waiter.signal.removeEventListener('abort', waiter.onAbort)
      if (waiter.signal.aborted) {
        waiter.reject(new RunnerError('ABORTED', 'Generation was aborted'))
        continue
      }
      active += 1
      waiter.resolve(releaseOnce())
    }
  }

  return {
    acquire(signal) {
      if (signal.aborted) return Promise.reject(new RunnerError('ABORTED', 'Generation was aborted'))
      if (active < effective && queue.length === 0) {
        active += 1
        return Promise.resolve(releaseOnce())
      }
      return new Promise((resolve, reject) => {
        const waiter: Waiter = {
          resolve,
          reject,
          signal,
          onAbort: () => {
            const index = queue.indexOf(waiter)
            if (index >= 0) queue.splice(index, 1)
            reject(new RunnerError('ABORTED', 'Generation was aborted'))
          },
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
        queue.push(waiter)
      })
    },
    setLimit(n) {
      const next = checkLimit(n)
      // 降速中保持已降的有效上限（但不超过新上限），靠连续成功回升；未降速时直接跟随
      effective = degraded ? Math.min(effective, next) : next
      limit = next
      drain()
    },
    onRateLimited() {
      effective = Math.max(1, Math.floor(effective / 2))
      degraded = true
      successStreak = 0
      const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** consecutiveLimits)
      consecutiveLimits += 1
      return Math.round(base * (1 + random() * BACKOFF_JITTER))
    },
    onSuccess() {
      consecutiveLimits = 0
      if (!degraded) return
      successStreak += 1
      if (successStreak < SUCCESSES_TO_RAISE) return
      successStreak = 0
      effective = Math.min(limit, effective + 1)
      if (effective >= limit) degraded = false
      drain()
    },
    get limit() {
      return limit
    },
    get effectiveLimit() {
      return effective
    },
    get active() {
      return active
    },
  }
}
