import { z } from 'zod'

import { imageSizes, type ImageSize } from './contracts.js'
import { RunnerError } from './errors.js'

const DEFAULT_APIMART_BASE_URL = 'https://api.apimart.ai/v1'
const DEFAULT_DASHSCOPE_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
/** studio 默认并发与上限；遇限流由引擎自动降速。 */
export const DEFAULT_CONCURRENCY = 5
export const MAX_CONCURRENCY = 10

/** 只有这两个官方 host 免于自定义 host 开关；其余 host 必须显式放行。 */
const DEFAULT_PROVIDER_HOSTS = new Set(['api.apimart.ai', 'dashscope.aliyuncs.com'])
/** 回环地址允许 http，供本机测试与 fake server 使用。 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
const ALLOW_CUSTOM_PROVIDER_HOST = 'FASHION_TRYON_ALLOW_CUSTOM_PROVIDER_HOST'

export interface ConfigOverrides {
  size?: ImageSize
  concurrency?: number
  maxRetries?: number
  imageModel?: string
  visionModel?: string
  apimartBaseUrl?: string
  dashscopeBaseUrl?: string
  pollIntervalMs?: number
  pollTimeoutMs?: number
  requestTimeoutMs?: number
  transferTimeoutMs?: number
  dashscopeMaxTokens?: number
}

export interface RunnerConfig {
  size: ImageSize
  concurrency: number
  maxRetries: number
  imageModel?: string | undefined
  visionModel?: string | undefined
  apimartApiKey?: string | undefined
  dashscopeApiKey?: string | undefined
  apimartBaseUrl: string
  dashscopeBaseUrl: string
  pollIntervalMs: number
  pollTimeoutMs: number
  requestTimeoutMs: number
  transferTimeoutMs: number
  dashscopeMaxTokens: number
  /** 单次生图单价（元），只用于显示预计与已用费用。 */
  imagePriceCny?: number | undefined
}

export interface ApimartConfig {
  apiKey: string
  baseUrl: string
  pollIntervalMs: number
  pollTimeoutMs: number
  /** 单次 JSON 请求超时（上传/提交/轮询之外的 JSON 语义）。 */
  requestTimeoutMs: number
  /** 单次上传或下载超时。 */
  transferTimeoutMs: number
}

export interface DashscopeConfig {
  apiKey: string
  baseUrl: string
  maxTokens: number
  model: string
  requestTimeoutMs: number
}

const configSchema = z.object({
  size: z.enum(imageSizes),
  concurrency: z.number().int().min(1).max(MAX_CONCURRENCY),
  maxRetries: z.number().int().min(0).max(3),
  imageModel: z.string().min(1).optional(),
  visionModel: z.string().min(1).optional(),
  apimartApiKey: z.string().min(1).optional(),
  dashscopeApiKey: z.string().min(1).optional(),
  apimartBaseUrl: z.url(),
  dashscopeBaseUrl: z.url(),
  pollIntervalMs: z.number().int().positive(),
  pollTimeoutMs: z.number().int().positive(),
  requestTimeoutMs: z.number().int().positive(),
  transferTimeoutMs: z.number().int().positive(),
  dashscopeMaxTokens: z.number().int().positive(),
  imagePriceCny: z.number().positive().optional(),
})

/**
 * base URL 必须是 https（回环地址除外），且非默认 host 需要显式环境开关。
 * 错误只提变量名与开关名，不回显 URL 值或任何 credential。
 */
function assertProviderBaseUrl(
  variable: string,
  value: string,
  env: NodeJS.ProcessEnv,
): void {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new RunnerError('CONFIG_ERROR', `${variable} must be an absolute URL`)
  }
  const host = parsed.hostname.toLocaleLowerCase('en-US')
  const loopback = LOOPBACK_HOSTS.has(host)
  if (parsed.protocol !== 'https:' && !loopback) {
    throw new RunnerError('CONFIG_ERROR', `${variable} must use https`)
  }
  if (loopback || DEFAULT_PROVIDER_HOSTS.has(host)) return
  if (nonEmpty(env[ALLOW_CUSTOM_PROVIDER_HOST]) !== '1') {
    throw new RunnerError(
      'CONFIG_ERROR',
      `${variable} points to a non-default provider host; set ${ALLOW_CUSTOM_PROVIDER_HOST}=1 to allow it`,
    )
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

/** 未设置时为 undefined；非数字交给 schema 报 CONFIG_ERROR。 */
function priceOf(value: string | undefined): number | undefined {
  const trimmed = nonEmpty(value)
  return trimmed === undefined ? undefined : Number(trimmed)
}

export function loadRunnerConfig(
  env: NodeJS.ProcessEnv,
  overrides: ConfigOverrides,
): RunnerConfig {
  const candidate = {
    size: overrides.size ?? '3:4',
    concurrency: overrides.concurrency ?? DEFAULT_CONCURRENCY,
    maxRetries: overrides.maxRetries ?? 1,
    imageModel: nonEmpty(overrides.imageModel) ?? nonEmpty(env.IMAGE_MODEL),
    visionModel: nonEmpty(overrides.visionModel) ?? nonEmpty(env.VISION_MODEL),
    apimartApiKey: nonEmpty(env.APIMART_API_KEY),
    dashscopeApiKey: nonEmpty(env.DASHSCOPE_API_KEY),
    apimartBaseUrl:
      nonEmpty(overrides.apimartBaseUrl) ??
      nonEmpty(env.APIMART_BASE_URL) ??
      DEFAULT_APIMART_BASE_URL,
    dashscopeBaseUrl:
      nonEmpty(overrides.dashscopeBaseUrl) ??
      nonEmpty(env.DASHSCOPE_BASE_URL) ??
      DEFAULT_DASHSCOPE_BASE_URL,
    pollIntervalMs: overrides.pollIntervalMs ?? 3_000,
    pollTimeoutMs: overrides.pollTimeoutMs ?? 300_000,
    requestTimeoutMs: overrides.requestTimeoutMs ?? 60_000,
    transferTimeoutMs: overrides.transferTimeoutMs ?? 180_000,
    dashscopeMaxTokens: overrides.dashscopeMaxTokens ?? 8_192,
    imagePriceCny: priceOf(env.IMAGE_PRICE_CNY),
  }

  const result = configSchema.safeParse(candidate)
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`)
      .join('; ')
    throw new RunnerError('CONFIG_ERROR', `Invalid runner configuration: ${details}`)
  }
  assertProviderBaseUrl('APIMART_BASE_URL', result.data.apimartBaseUrl, env)
  assertProviderBaseUrl('DASHSCOPE_BASE_URL', result.data.dashscopeBaseUrl, env)
  return result.data
}

export function requireApimartConfig(config: RunnerConfig): ApimartConfig {
  if (config.apimartApiKey === undefined) {
    throw new RunnerError('CONFIG_ERROR', 'APIMART_API_KEY')
  }
  return {
    apiKey: config.apimartApiKey,
    baseUrl: config.apimartBaseUrl,
    pollIntervalMs: config.pollIntervalMs,
    pollTimeoutMs: config.pollTimeoutMs,
    requestTimeoutMs: config.requestTimeoutMs,
    transferTimeoutMs: config.transferTimeoutMs,
  }
}

export function requireDashscopeConfig(config: RunnerConfig): DashscopeConfig {
  if (config.dashscopeApiKey === undefined) {
    throw new RunnerError('CONFIG_ERROR', 'DASHSCOPE_API_KEY')
  }
  if (config.visionModel === undefined) {
    throw new RunnerError('CONFIG_ERROR', 'VISION_MODEL')
  }
  return {
    apiKey: config.dashscopeApiKey,
    baseUrl: config.dashscopeBaseUrl,
    maxTokens: config.dashscopeMaxTokens,
    model: config.visionModel,
    requestTimeoutMs: config.requestTimeoutMs,
  }
}
