import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildTryonPrompt } from '../src/prepare/prompt.js'
import { createDashscopeAdapter } from '../src/providers/dashscope.js'

function completion(content: unknown, finishReason = 'stop'): Response {
  return new Response(JSON.stringify({
    choices: [{ finish_reason: finishReason, message: { content } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('createDashscopeAdapter', () => {
  let workspace = ''
  let garment = ''

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'fashion-tryon-dashscope-'))
    garment = path.join(workspace, 'garment.jpg')
    await writeFile(garment, new Uint8Array([1]))
  })

  afterEach(async () => {
    sleeps.length = 0
    await rm(workspace, { recursive: true, force: true })
  })

  const sleeps: number[] = []

  function adapter(fetchImpl: typeof fetch) {
    return createDashscopeAdapter({
      apiKey: 'dashscope-test-key',
      baseUrl: 'https://dashscope.example/compatible-mode/v1',
      maxTokens: 8192,
      model: 'qwen-test-vision',
      requestTimeoutMs: 60_000,
    }, fetchImpl, async (ms) => {
      sleeps.push(ms)
    })
  }

  it('parses a fenced brief and sends the garment image with the configured model', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(completion('```json\n' + JSON.stringify({
      imageType: 'flat_lay',
      garments: [{ part: '上装', item: '红色衬衫' }],
      suggestedPrompt: 'replace top',
      uncertainty: [],
    }) + '\n```'))
    const vision = adapter(fetchImpl as unknown as typeof fetch)

    await expect(vision.brief({ imagePath: garment, contentHash: 'a'.repeat(64), scope: 'top' }, new AbortController().signal))
      .resolves.toMatchObject({ garments: [{ part: '上装', item: '红色衬衫' }] })

    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string)
    const content = body.messages[0].content as Array<Record<string, any>>
    const images = content.filter((item) => item.type === 'image_url')
      .map((item) => item.image_url.url as string)
    expect(images).toEqual(['data:image/jpeg;base64,AQ=='])
    expect(body).toMatchObject({ model: 'qwen-test-vision', max_tokens: 8192, stream: false })
  })

  it('locates the complete target garment with one normalized bbox', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(completion(JSON.stringify({
      bbox: [100, 120, 900, 940],
    })))
    const vision = adapter(fetchImpl as unknown as typeof fetch)

    await expect(vision.locateGarment({
      imagePath: garment,
      contentHash: 'a'.repeat(64),
      model: 'qwen-framing-model',
    }, new AbortController().signal)).resolves.toEqual({
      bbox: [100, 120, 900, 940],
    })

    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string)
    const content = body.messages[0].content as Array<Record<string, any>>
    const instruction = content[0]!.text as string
    const images = content.filter((item) => item.type === 'image_url')
    expect(body.model).toBe('qwen-framing-model')
    expect(images).toHaveLength(1)
    expect(images[0]!.image_url.url).toBe('data:image/jpeg;base64,AQ==')
    expect(instruction).toContain('目标服装整体边界')
    expect(instruction).toContain('成套或多层')
    expect(instruction).toContain('0-1000')
  })

  it.each([
    [{}, 'missing'],
    [{ bbox: [900, 100, 100, 900] }, 'reversed'],
    [{ bbox: [-1, 100, 900, 900] }, 'out of range'],
    [{ bbox: ['100', 100, 900, 900] }, 'non numeric'],
  ])('rejects invalid garment framing bbox: %s (%s)', async (value, _label) => {
    const vision = adapter(vi.fn().mockResolvedValue(
      completion(JSON.stringify(value)),
    ) as unknown as typeof fetch)

    await expect(vision.locateGarment({
      imagePath: garment,
      contentHash: 'a'.repeat(64),
    }, new AbortController().signal)).rejects.toMatchObject({
      code: 'PROVIDER_RESPONSE',
      retryable: false,
    })
  })

  it('reports length truncation before parsing', async () => {
    const truncated = adapter(vi.fn().mockResolvedValue(
      completion('{"imageType":"fla', 'length'),
    ) as unknown as typeof fetch)
    await expect(truncated.brief(
      { imagePath: garment, contentHash: 'a'.repeat(64), scope: 'full' },
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'VISION_TRUNCATED', retryable: false })
  })

  it('removes uncertain inferred attributes before they become hard requirements', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(completion(JSON.stringify({
      imageType: 'on_model',
      garments: [
        {
          part: '上装',
          item: '米白色绞花毛衣，羊绒/马海毛混纺质感，圆领宽松版型',
        },
        {
          part: '下装',
          item: '深棕色灯芯绒阔腿裤，高腰宽松版型，裤长至脚踝（仅可见至大腿中部，推断为及踝）',
        },
      ],
      suggestedPrompt: '替换为参考图中可见的整套服装',
      uncertainty: [
        '毛衣确切纤维成分不可辨认，羊绒/马海毛为视觉推断',
        '裤子长度仅可见至大腿中部，及踝为推断',
      ],
    })))
    const vision = adapter(fetchImpl as unknown as typeof fetch)

    const brief = await vision.brief({
      imagePath: garment,
      contentHash: 'a'.repeat(64),
      scope: 'full',
    }, new AbortController().signal)
    const prepared = buildTryonPrompt(brief, 'full')

    expect(brief.garments).toEqual([
      { part: '上装', item: '米白色绞花毛衣，圆领宽松版型' },
      { part: '下装', item: '深棕色灯芯绒阔腿裤，高腰宽松版型' },
    ])
    expect(brief.uncertainty).toEqual([
      '毛衣确切纤维成分不可辨认，羊绒/马海毛为视觉推断',
      '裤子长度仅可见至大腿中部，及踝为推断',
    ])
    const [requirements, exclusions] = prepared.reviewExpectation.split('以下不确定项不作为审核要求')
    expect(requirements).not.toMatch(/羊绒|马海毛|脚踝|及踝|推断/)
    expect(exclusions).toMatch(/羊绒|马海毛|及踝|推断/)
    expect(prepared.reviewExpectation).toContain('米白色绞花毛衣，圆领宽松版型')
    expect(prepared.reviewExpectation).toContain('深棕色灯芯绒阔腿裤，高腰宽松版型')
  })

  it('asks the brief model to omit attributes that are not directly visible', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(completion(JSON.stringify({
      imageType: 'flat_lay',
      garments: [{ part: '上装', item: '米白色绞花毛衣' }],
      suggestedPrompt: '替换为参考图中可见上装',
      uncertainty: [],
    })))
    const vision = adapter(fetchImpl as unknown as typeof fetch)

    await vision.brief({
      imagePath: garment,
      contentHash: 'a'.repeat(64),
      scope: 'top',
    }, new AbortController().signal)

    const body = JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string)
    const instruction = body.messages[0].content[0].text as string
    expect(instruction).toContain('item 只写图片中可直接观察到的属性')
    expect(instruction).toContain('不可辨认的属性必须从 item 省略，只能写入 uncertainty')
    expect(instruction).toContain('不得推断纤维成分')
    expect(instruction).toContain('不得推断画外或被遮挡部位的长度落点')
  })

  it('preserves visible garment identity when only individual attributes are uncertain', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(completion(JSON.stringify({
      imageType: 'on_model',
      garments: [
        {
          part: 'top',
          item: 'light gray hooded wrap cardigan with a wool-blend texture，full-length sleeves，gray-white striped ribbed hem',
        },
        {
          part: 'inner_top',
          item: 'gray-white striped crew-neck inner top',
        },
      ],
      suggestedPrompt: 'replace all original top layers with the visible two-piece top',
      uncertainty: [
        'exact fabric composition of cardigan (wool vs blend)',
        'cardigan sleeve length (full vs three-quarter)',
      ],
    })))
    const vision = adapter(fetchImpl as unknown as typeof fetch)

    const brief = await vision.brief({
      imagePath: garment,
      contentHash: 'a'.repeat(64),
      scope: 'top',
    }, new AbortController().signal)
    const prepared = buildTryonPrompt(brief, 'top')

    expect(brief.garments[0]).toEqual({
      part: 'top',
      item: 'light gray hooded wrap cardigan，gray-white striped ribbed hem',
    })
    expect(brief.garments[1]).toEqual({
      part: 'inner_top',
      item: 'gray-white striped crew-neck inner top',
    })
    expect(prepared.reviewExpectation).not.toMatch(/只核对上装替换为：top(?:；|$)/)
    expect(prepared.reviewExpectation).toContain('light gray hooded wrap cardigan')
    expect(prepared.reviewExpectation).toContain('gray-white striped crew-neck inner top')
  })

  it('retries a rate-limited vision call with backoff before surfacing it', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('slow down', { status: 429 }))
      .mockResolvedValueOnce(completion(JSON.stringify({ bbox: [100, 100, 900, 900] })))
    const vision = adapter(fetchImpl as unknown as typeof fetch)

    await expect(vision.locateGarment(
      { imagePath: garment, contentHash: 'a'.repeat(64) },
      new AbortController().signal,
    )).resolves.toEqual({ bbox: [100, 100, 900, 900] })

    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(sleeps).toHaveLength(1)
    expect(sleeps[0]).toBeGreaterThanOrEqual(1_000)
    expect(sleeps[0]).toBeLessThanOrEqual(3_000)
  })

  it('stops retrying after two attempts and never retries a non-retryable failure', async () => {
    const rateLimited = vi.fn().mockResolvedValue(new Response('slow down', { status: 429 }))
    await expect(adapter(rateLimited as unknown as typeof fetch).locateGarment(
      { imagePath: garment, contentHash: 'a'.repeat(64) },
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMIT', retryable: true })
    expect(rateLimited).toHaveBeenCalledTimes(3)

    sleeps.length = 0
    const rejected = vi.fn().mockResolvedValue(new Response('bad request', { status: 400 }))
    await expect(adapter(rejected as unknown as typeof fetch).locateGarment(
      { imagePath: garment, contentHash: 'a'.repeat(64) },
      new AbortController().signal,
    )).rejects.toMatchObject({ retryable: false })
    expect(rejected).toHaveBeenCalledTimes(1)
    expect(sleeps).toEqual([])
  })

  it('accepts a brief without suggestedPrompt', async () => {
    const briefFetch = vi.fn().mockResolvedValue(completion(JSON.stringify({
      imageType: 'flat_lay',
      garments: [{ part: '上装', item: '米白色针织衫' }],
      uncertainty: [],
    })))
    await expect(adapter(briefFetch as unknown as typeof fetch).brief(
      { imagePath: garment, contentHash: 'a'.repeat(64), scope: 'top' },
      new AbortController().signal,
    )).resolves.toMatchObject({
      garments: [{ part: '上装', item: '米白色针织衫' }],
      suggestedPrompt: '',
    })
  })
})
