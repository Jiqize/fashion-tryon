import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { RunnerError } from '../src/errors.js'
import { createApimartAdapter } from '../src/providers/apimart.js'
import { createDashscopeAdapter } from '../src/providers/dashscope.js'
import { normalizeProviderError } from '../src/providers/http-errors.js'

describe('provider error redaction', () => {
  let workspace = ''

  afterEach(async () => {
    if (workspace !== '') await rm(workspace, { recursive: true, force: true })
  })

  it('caps upstream details and removes configured keys and Authorization values', async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'fashion-tryon-provider-secret-'))
    const image = path.join(workspace, 'image.jpg')
    await writeFile(image, new Uint8Array([1]))
    const secret = 'sk-provider-super-secret-value'
    const upstream = `${'x'.repeat(500)} ${secret} Authorization: Bearer ${secret}`
    const adapter = createDashscopeAdapter({
      apiKey: secret,
      baseUrl: 'https://dashscope.example/v1',
      maxTokens: 8192,
      model: 'qwen-test',
      requestTimeoutMs: 60_000,
    },
    vi.fn().mockResolvedValue(new Response(upstream, { status: 500 })) as unknown as typeof fetch,
    async () => undefined,
    )

    let caught: unknown
    try {
      await adapter.brief(
        { imagePath: image, contentHash: 'a'.repeat(64), scope: 'full' },
        new AbortController().signal,
      )
    } catch (error) {
      caught = error
    }
    const serialized = JSON.stringify(caught)
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain('Bearer')
    expect((caught as Error).message.length).toBeLessThanOrEqual(440)
  })

  it('keeps the APIMART key out of submission-unknown and per-request timeout messages', async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'fashion-tryon-apimart-secret-'))
    const garmentPath = path.join(workspace, 'garment.jpg')
    const modelPath = path.join(workspace, 'model.jpg')
    await writeFile(garmentPath, new Uint8Array([1]))
    await writeFile(modelPath, new Uint8Array([2]))
    const secret = 'sk-apimart-super-secret-value'
    const generateRequest = {
      garmentPath,
      modelPath,
      prompt: 'replace clothing',
      model: 'image-model',
      size: '3:4',
    } as const
    const config = {
      apiKey: secret,
      baseUrl: 'https://api.example/v1',
      pollIntervalMs: 1,
      pollTimeoutMs: 60_000,
      requestTimeoutMs: 25,
      transferTimeoutMs: 25,
    }
    const uploaded = (): Response => new Response(
      JSON.stringify({ url: 'https://upload.example/file.jpg' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )

    const submitFetch = vi.fn()
      .mockResolvedValueOnce(uploaded())
      .mockResolvedValueOnce(uploaded())
      .mockResolvedValueOnce(new Response(
        `gateway echoed Authorization: Bearer ${secret}`,
        { status: 502 },
      ))
    let submitFailure: unknown
    try {
      await createApimartAdapter(config, submitFetch as unknown as typeof fetch)
        .generate(generateRequest, new AbortController().signal)
    } catch (error) {
      submitFailure = error
    }
    expect(submitFailure).toMatchObject({ code: 'PROVIDER_SUBMISSION_UNKNOWN', retryable: false })
    expect((submitFailure as Error).message).not.toContain(secret)
    expect(JSON.stringify(submitFailure)).not.toContain(secret)

    const hungFetch = vi.fn((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal!.reason as Error)
        }, { once: true })
      }))
    let timeoutFailure: unknown
    try {
      await createApimartAdapter(config, hungFetch as unknown as typeof fetch)
        .generate(generateRequest, new AbortController().signal, { providerRequestId: 'task-hung' })
    } catch (error) {
      timeoutFailure = error
    }
    expect(timeoutFailure).toMatchObject({ code: 'PROVIDER_TIMEOUT', retryable: true })
    expect((timeoutFailure as Error).message).not.toContain(secret)
    expect(JSON.stringify(timeoutFailure)).not.toContain(secret)
  })
})

describe('normalizeProviderError', () => {
  it.each([408, 429, 500, 502, 503, 504])(
    'marks HTTP %s as retryable',
    async (status) => {
      await expect(normalizeProviderError('apimart', new Response('temporary', { status })))
        .resolves.toMatchObject({ retryable: true })
    },
  )

  it.each([400, 401, 403, 404])(
    'marks HTTP %s as non-retryable',
    async (status) => {
      await expect(normalizeProviderError('dashscope', new Response('permanent', { status })))
        .resolves.toMatchObject({ retryable: false })
    },
  )

  it('classifies a network timeout as retryable', async () => {
    await expect(normalizeProviderError('dashscope', new Error('socket timeout'))).resolves.toMatchObject({
      code: 'PROVIDER_TIMEOUT',
      retryable: true,
    })
  })

  it('treats a non-error throw as a permanent provider failure', async () => {
    await expect(normalizeProviderError('apimart', 'boom')).resolves.toMatchObject({
      code: 'PROVIDER_ERROR',
      retryable: false,
    })
  })

  it('treats a URL parse failure as a configuration error', async () => {
    await expect(normalizeProviderError('dashscope', new TypeError('Invalid URL')))
      .resolves.toMatchObject({ code: 'CONFIG_ERROR', retryable: false })
  })

  it('redacts configured keys from an already-normalized RunnerError', async () => {
    const secret = 'provider-key-without-standard-prefix'
    const normalized = await normalizeProviderError(
      'apimart',
      new RunnerError('PROVIDER_ERROR', `upstream rejected ${secret}`),
      [secret],
    )

    expect(normalized.message).not.toContain(secret)
    expect(normalized.message).toContain('[REDACTED]')
  })
})
