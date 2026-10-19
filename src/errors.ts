export const runnerErrorCodes = [
  'UNSUPPORTED_SCHEMA',
  'VALIDATION_ERROR',
  'CONFIG_ERROR',
  'NEEDS_INPUT',
  'NEEDS_APPROVAL',
  'NO_RUNNABLE_TASKS',
  'IO_ERROR',
  'NOT_FOUND',
  'INTEGRITY_ERROR',
  'INPUT_CHANGED',
  'ABORTED',
  'PROVIDER_ERROR',
  'PROVIDER_TIMEOUT',
  'PROVIDER_RATE_LIMIT',
  'PROVIDER_SUBMISSION_UNKNOWN',
  'PROVIDER_AUTH',
  'PROVIDER_RESPONSE',
  'VISION_TRUNCATED',
  'RUN_IN_PROGRESS',
  'CROP_EXISTS',
] as const

export type RunnerErrorCode = (typeof runnerErrorCodes)[number]

export interface SerializedRunnerError {
  code: RunnerErrorCode
  message: string
  retryable: boolean
}

export interface RunnerErrorOptions {
  retryable?: boolean
  cause?: unknown
}

export class RunnerError extends Error {
  readonly code: RunnerErrorCode
  readonly retryable: boolean

  constructor(code: RunnerErrorCode, message: string, options: RunnerErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'RunnerError'
    this.code = code
    this.retryable = options.retryable ?? false
  }

  toJSON(): SerializedRunnerError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    }
  }
}

export function exitCodeFor(error: unknown): 1 | 2 {
  if (
    error instanceof RunnerError &&
    (
      error.code === 'NEEDS_INPUT' ||
      error.code === 'NEEDS_APPROVAL' ||
      error.code === 'NO_RUNNABLE_TASKS'
    )
  ) {
    return 2
  }
  return 1
}

/** 错误文本写入记录或返回给宿主前统一打码：Bearer 令牌与 sk- 密钥，截断 400 字。 */
export function redactSecrets(value: string): string {
  return value
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .slice(0, 400)
}
