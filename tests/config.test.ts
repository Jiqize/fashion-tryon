import { describe, expect, it } from 'vitest'

import {
  loadRunnerConfig,
  requireApimartConfig,
  requireDashscopeConfig,
} from '../src/config.js'
import { RunnerError, exitCodeFor } from '../src/errors.js'

describe('runner configuration', () => {
  it('loads fake-only defaults without requiring production keys', () => {
    const config = loadRunnerConfig({}, {})

    expect(config).toMatchObject({
      size: '3:4',
      concurrency: 5,
      maxRetries: 1,
      apimartBaseUrl: 'https://api.apimart.ai/v1',
      dashscopeBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      dashscopeMaxTokens: 8192,
    })
    expect(config.apimartApiKey).toBeUndefined()
    expect(config.dashscopeApiKey).toBeUndefined()
    expect(config.imagePriceCny).toBeUndefined()
  })

  it('reads an optional image price and caps concurrency at ten', () => {
    expect(loadRunnerConfig({ IMAGE_PRICE_CNY: '0.35' }, {}).imagePriceCny).toBe(0.35)
    expect(() => loadRunnerConfig({ IMAGE_PRICE_CNY: 'abc' }, {})).toThrow(RunnerError)
    expect(loadRunnerConfig({}, { concurrency: 10 }).concurrency).toBe(10)
    expect(() => loadRunnerConfig({}, { concurrency: 11 })).toThrow(RunnerError)
  })

  it('applies environment values and typed CLI overrides', () => {
    const config = loadRunnerConfig(
      {
        APIMART_API_KEY: 'api-image-key',
        DASHSCOPE_API_KEY: 'api-vision-key',
        IMAGE_MODEL: 'image-model-env',
        VISION_MODEL: 'vision-model-env',
      },
      { size: '16:9', concurrency: 2, maxRetries: 3, imageModel: 'image-model-cli' },
    )

    expect(config).toMatchObject({
      size: '16:9',
      concurrency: 2,
      maxRetries: 3,
      imageModel: 'image-model-cli',
      visionModel: 'vision-model-env',
    })
  })

  it('exposes per-request timeout defaults for JSON calls and transfers', () => {
    const config = loadRunnerConfig({}, {})

    expect(config).toMatchObject({ requestTimeoutMs: 60_000, transferTimeoutMs: 180_000 })
    expect(requireApimartConfig({ ...config, apimartApiKey: 'k' })).toMatchObject({
      requestTimeoutMs: 60_000,
      transferTimeoutMs: 180_000,
    })
    expect(requireDashscopeConfig({
      ...config,
      dashscopeApiKey: 'k',
      visionModel: 'vision-model',
    })).toMatchObject({ requestTimeoutMs: 60_000 })
  })

  it('accepts loopback http base URLs used by local fakes', () => {
    const config = loadRunnerConfig(
      { APIMART_BASE_URL: 'http://127.0.0.1:8080/v1', DASHSCOPE_BASE_URL: 'http://localhost:8081/v1' },
      {},
    )

    expect(config.apimartBaseUrl).toBe('http://127.0.0.1:8080/v1')
    expect(config.dashscopeBaseUrl).toBe('http://localhost:8081/v1')
  })

  it('rejects a non-loopback http base URL', () => {
    expect(() => loadRunnerConfig({ APIMART_BASE_URL: 'http://api.apimart.ai/v1' }, {})).toThrow(
      expect.objectContaining({
        code: 'CONFIG_ERROR',
        message: 'APIMART_BASE_URL must use https',
      }),
    )
  })

  it('requires an explicit switch for a custom https provider host', () => {
    const overrides = { DASHSCOPE_BASE_URL: 'https://vision.example.com/v1' }

    expect(() => loadRunnerConfig(overrides, {})).toThrow(
      expect.objectContaining({
        code: 'CONFIG_ERROR',
        message: expect.stringContaining('FASHION_TRYON_ALLOW_CUSTOM_PROVIDER_HOST'),
      }),
    )
    expect(
      loadRunnerConfig({ ...overrides, FASHION_TRYON_ALLOW_CUSTOM_PROVIDER_HOST: '1' }, {}).dashscopeBaseUrl,
    ).toBe('https://vision.example.com/v1')
  })

  it.each([
    ['APIMART_API_KEY', requireApimartConfig],
    ['DASHSCOPE_API_KEY', requireDashscopeConfig],
  ])('requires only %s when constructing that production config', (variable, requireConfig) => {
    const config = loadRunnerConfig({}, {})

    expect(() => requireConfig(config)).toThrow(
      expect.objectContaining({
        code: 'CONFIG_ERROR',
        message: variable,
      }),
    )
  })
})

describe('RunnerError', () => {
  it('serializes only stable safe fields and maps needs-input errors to exit code 2', () => {
    const fakeSecret = 'sk-this-must-never-escape'
    const error = new RunnerError('NEEDS_INPUT', 'Answers are required', {
      cause: new Error(fakeSecret),
    })

    const serialized = JSON.stringify(error)
    expect(serialized).toBe(
      '{"code":"NEEDS_INPUT","message":"Answers are required","retryable":false}',
    )
    expect(serialized).not.toContain(fakeSecret)
    expect(exitCodeFor(error)).toBe(2)
    expect(exitCodeFor(new RunnerError('CONFIG_ERROR', 'bad config'))).toBe(1)
  })
})
