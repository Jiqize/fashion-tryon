import { createHash } from 'node:crypto'
import { mkdir, open, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'

import { prepareAsset, type PrepareSourceAsset } from '../src/prepare/images.js'
import { makeFixtureRoot, removeFixtureRoot } from './helpers/fixtures.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeFixtureRoot))
})

async function root(): Promise<string> {
  const value = await makeFixtureRoot('fashion-tryon-prepare-')
  roots.push(value)
  return value
}

async function digest(filePath: string): Promise<string> {
  return createHash('sha256').update(await readFile(filePath)).digest('hex')
}

async function asset(
  filePath: string,
  overrides: Partial<PrepareSourceAsset> = {},
): Promise<PrepareSourceAsset> {
  return {
    id: 'asset_test',
    role: 'garment',
    sourcePath: filePath,
    relativePath: path.basename(filePath),
    contentHash: await digest(filePath),
    ...overrides,
  }
}

describe('prepareAsset', () => {
  it('turns a 50 MiB source into an immutable JPEG working copy below 1 MB and 1600 px', async () => {
    const workspace = await root()
    const runDir = path.join(workspace, 'run')
    const source = path.join(workspace, 'noise.jpg')
    await mkdir(runDir, { recursive: true })
    const width = 1800
    const height = 1800
    const raw = Buffer.alloc(width * height * 3)
    let seed = 17
    for (let index = 0; index < raw.length; index += 1) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      raw[index] = (seed >> 16) & 0xff
    }
    await sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 100 }).toFile(source)
    const handle = await open(source, 'r+')
    await handle.truncate(50 * 1024 * 1024)
    await handle.close()
    const before = { hash: await digest(source), size: (await stat(source)).size }

    const prepared = await prepareAsset(await asset(source, { role: 'model' }), { runDir })
    const metadata = await sharp(prepared.path).metadata()

    expect(prepared.path.startsWith(path.join(runDir, 'prepared') + path.sep)).toBe(true)
    expect(prepared.path.endsWith('.jpg')).toBe(true)
    expect(prepared.bytes).toBeLessThan(1_000_000)
    expect(Math.max(metadata.width!, metadata.height!)).toBeLessThanOrEqual(1600)
    expect(await digest(source)).toBe(before.hash)
    expect((await stat(source)).size).toBe(before.size)
  })

  it('scales and clamps bbox margins, and rejects a malformed bbox instead of using the full image', async () => {
    const workspace = await root()
    const runDir = path.join(workspace, 'run')
    const source = path.join(workspace, 'plain.jpg')
    await sharp({ create: { width: 2048, height: 2048, channels: 3, background: '#999' } })
      .jpeg()
      .toFile(source)
    const warnings: string[] = []

    const cropped = await prepareAsset(
      await asset(source, { id: 'edge', bbox: [0, 0, 100, 100] }),
      { runDir, onWarning: (warning) => warnings.push(warning) },
    )
    expect(cropped.cropBox).toEqual({ left: 0, top: 0, width: 245, height: 273 })
    expect(cropped.cropped).toBe(true)

    await expect(prepareAsset(
      await asset(source, { id: 'bad', bbox: [900, 900, 100, 100] as never }),
      { runDir, onWarning: (warning) => warnings.push(warning) },
    )).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE' })
    expect(warnings).toEqual([])
  })

  it('rejects an asset ID that could escape the prepared directory', async () => {
    const workspace = await root()
    const runDir = path.join(workspace, 'run')
    const source = path.join(workspace, 'plain.jpg')
    await sharp({ create: { width: 80, height: 120, channels: 3, background: '#999' } })
      .jpeg()
      .toFile(source)

    await expect(prepareAsset(
      await asset(source, { id: '../escape' }),
      { runDir },
    )).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('flattens a transparent PNG onto white instead of black, and warns', async () => {
    const workspace = await root()
    const runDir = path.join(workspace, 'run')
    const source = path.join(workspace, 'cutout.png')
    // 中心不透明、四角完全透明的抠图 PNG，是电商平铺图最常见形态
    const size = 1200
    const raw = Buffer.alloc(size * size * 4)
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const offset = (y * size + x) * 4
        const inside = x > 300 && x < 900 && y > 300 && y < 900
        raw[offset] = 230
        raw[offset + 1] = 220
        raw[offset + 2] = 210
        raw[offset + 3] = inside ? 255 : 0
      }
    }
    await sharp(raw, { raw: { width: size, height: size, channels: 4 } }).png().toFile(source)
    const warnings: string[] = []

    const prepared = await prepareAsset(
      await asset(source, { id: 'alpha', role: 'model' }),
      { runDir, onWarning: (warning) => warnings.push(warning) },
    )
    const { data, info } = await sharp(prepared.path).raw().toBuffer({ resolveWithObject: true })
    const corners = [
      0,
      (info.width - 1) * info.channels,
      (info.height - 1) * info.width * info.channels,
      ((info.height - 1) * info.width + info.width - 1) * info.channels,
    ]
    for (const corner of corners) {
      expect(data[corner]).toBeGreaterThan(230)
      expect(data[corner + 1]).toBeGreaterThan(230)
      expect(data[corner + 2]).toBeGreaterThan(230)
    }
    expect(prepared.warnings).toContain('源图含透明通道，已合成白底：cutout.png')
    expect(warnings).toContain('源图含透明通道，已合成白底：cutout.png')
  })

  it('converts a wide-gamut source to sRGB, attaches an sRGB profile and warns', async () => {
    const workspace = await root()
    const runDir = path.join(workspace, 'run')
    const source = path.join(workspace, 'p3.jpg')
    await sharp({ create: { width: 900, height: 900, channels: 3, background: { r: 220, g: 40, b: 40 } } })
      .withIccProfile('p3')
      .jpeg()
      .toFile(source)
    const warnings: string[] = []

    const prepared = await prepareAsset(
      await asset(source, { id: 'widegamut', role: 'model' }),
      { runDir, onWarning: (warning) => warnings.push(warning) },
    )
    const metadata = await sharp(prepared.path).metadata()

    expect(metadata.space).toBe('srgb')
    expect(metadata.icc).toBeDefined()
    expect(Buffer.from(metadata.icc!).toString('latin1').replace(/\0/g, '')).toMatch(/sRGB/i)
    expect(warnings).toContain('源图色彩空间非 sRGB，已转换为 sRGB：p3.jpg')
  })

  it('degrades edge length instead of dropping quality below the floor', async () => {
    const workspace = await root()
    const runDir = path.join(workspace, 'run')
    const source = path.join(workspace, 'noise.jpg')
    const size = 1600
    const raw = Buffer.alloc(size * size * 3)
    let seed = 4242
    for (let index = 0; index < raw.length; index += 1) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      raw[index] = (seed >> 16) & 0xff
    }
    await sharp(raw, { raw: { width: size, height: size, channels: 3 } })
      .jpeg({ quality: 100 })
      .toFile(source)
    const gentleWarnings: string[] = []
    // 略微超限：在原始边长上把质量降到 70 即可，低于 75 必须给出警告
    const gentle = await prepareAsset(
      await asset(source, { id: 'gentle', role: 'model' }),
      { runDir, maxBytes: 1_300_000, onWarning: (warning) => gentleWarnings.push(warning) },
    )
    expect(Math.max(gentle.width, gentle.height)).toBe(1600)
    expect(gentleWarnings).toContain('为满足体积上限，压缩质量已降至 q70：noise.jpg')

    const tightWarnings: string[] = []
    // 体积上限压到 60 KB：质量下限 60 也放不下，必须继续降边长而不是把质量压到 30
    const tight = await prepareAsset(
      await asset(source, { id: 'tight', role: 'model' }),
      { runDir, maxBytes: 60_000, onWarning: (warning) => tightWarnings.push(warning) },
    )
    expect(tight.bytes).toBeLessThan(60_000)
    expect(Math.max(tight.width, tight.height)).toBeLessThan(1600)
    expect(tightWarnings.some((warning) => warning.includes('压缩质量'))).toBe(false)

    await expect(prepareAsset(
      await asset(source, { id: 'impossible', role: 'model' }),
      { runDir, maxBytes: 500 },
    )).rejects.toMatchObject({ code: 'IO_ERROR', message: /quality 60/ })
  })

  it('rejects a degenerate bbox and a bbox that covers the whole image', async () => {
    const workspace = await root()
    const runDir = path.join(workspace, 'run')
    const source = path.join(workspace, 'garment.jpg')
    await sharp({ create: { width: 1000, height: 1000, channels: 3, background: '#777' } })
      .jpeg()
      .toFile(source)

    await expect(prepareAsset(
      await asset(source, { id: 'tiny', bbox: [500, 500, 505, 505] }),
      { runDir },
    )).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE' })

    await expect(prepareAsset(
      await asset(source, { id: 'whole', bbox: [0, 0, 1000, 1000] }),
      { runDir },
    )).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE' })
  })
})
