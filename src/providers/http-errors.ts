import { RunnerError } from '../errors.js'

export type ProviderName = 'apimart' | 'dashscope'

const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504])
const URL_PARSE_FAILURE = /invalid url|failed to parse url/i

export function redactProviderDetail(value: string, secrets: readonly string[] = []): string {
  let safe = value
  for (const secret of secrets) {
    if (secret !== '') safe = safe.split(secret).join('[REDACTED]')
  }
  safe = safe
    .replace(/Authorization\s*:\s*Bearer\s+[^\s"',}]+/gi, 'Authorization: [REDACTED]')
    .replace(/Bearer\s+[^\s"',}]+/gi, '[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
  return safe.length > 400 ? `${safe.slice(0, 399)}…` : safe
}

function httpCode(status: number): {
  code: 'PROVIDER_TIMEOUT' | 'PROVIDER_RATE_LIMIT' | 'PROVIDER_AUTH' | 'PROVIDER_ERROR'
  retryable: boolean
} {
  if (status === 408) return { code: 'PROVIDER_TIMEOUT', retryable: true }
  if (status === 429) return { code: 'PROVIDER_RATE_LIMIT', retryable: true }
  if (status === 401 || status === 403) return { code: 'PROVIDER_AUTH', retryable: false }
  return { code: 'PROVIDER_ERROR', retryable: RETRYABLE_HTTP_STATUSES.has(status) }
}

export async function normalizeProviderError(
  provider: ProviderName,
  responseOrError: Response | unknown,
  secrets: readonly string[] = [],
): Promise<RunnerError> {
  if (responseOrError instanceof RunnerError) {
    return new RunnerError(
      responseOrError.code,
      redactProviderDetail(responseOrError.message, secrets),
      { retryable: responseOrError.retryable },
    )
  }
  if (responseOrError instanceof Response) {
    const detail = redactProviderDetail(await responseOrError.text().catch(() => ''), secrets)
    const normalized = httpCode(responseOrError.status)
    return new RunnerError(
      normalized.code,
      `${provider} HTTP ${String(responseOrError.status)}${detail === '' ? '' : `: ${detail}`}`,
      { retryable: normalized.retryable },
    )
  }
  if (!(responseOrError instanceof Error)) {
    // 非 Error 抛出物无法判断是否为瞬时故障，一律不可重试。
    const detail = redactProviderDetail(String(responseOrError), secrets)
    return new RunnerError(
      'PROVIDER_ERROR',
      `${provider} threw a non-error value${detail === '' ? '' : `: ${detail}`}`,
      { retryable: false },
    )
  }
  if (responseOrError instanceof TypeError && URL_PARSE_FAILURE.test(responseOrError.message)) {
    // base URL 配置错误不是瞬时故障，重试只会重复失败。
    return new RunnerError(
      'CONFIG_ERROR',
      `${provider} base URL is not a valid absolute URL`,
      { retryable: false },
    )
  }
  const rawParts = [responseOrError.message]
  if (responseOrError.cause !== undefined) {
    const cause = responseOrError.cause
    if (typeof cause === 'object' && cause !== null) {
      const code = 'code' in cause && typeof cause.code === 'string' ? cause.code : undefined
      const message = cause instanceof Error
        ? cause.message
        : 'message' in cause && typeof cause.message === 'string'
          ? cause.message
          : undefined
      if (code !== undefined) rawParts.push(code)
      if (message !== undefined) rawParts.push(message)
    } else {
      rawParts.push(String(cause))
    }
  }
  const detail = redactProviderDetail([...new Set(rawParts.filter(Boolean))].join(' | '), secrets)
  return new RunnerError(
    'PROVIDER_TIMEOUT',
    `${provider} network failure${detail === '' ? '' : `: ${detail}`}`,
    { retryable: true },
  )
}
