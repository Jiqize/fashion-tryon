import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { roleOfSegment, scanInput, stableId } from '../../src/studio/fs-scan.js'
import { fixtureImageBytes, writeFixtureRealImage } from '../helpers/image-bytes.js'

const roots: string[] = []

/** 同一个名字的两种 Unicode 写法，用来证明归一化与排序不依赖 localeCompare。 */
const COMPOSED = 'é款'.normalize('NFC')
const DECOMPOSED = 'é款'.normalize('NFD')

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'fashion-tryon-scan-'))
  roots.push(root)
  return root
}

async function sha256(filePath: string): Promise<string> {
  return createHash('sha256').update(await readFile(filePath)).digest('hex')
}

describe('scanInput', () => {
  it('scans supported images read-only and records every skipped reason', async () => {
    const root = await tempRoot()
    await mkdir(path.join(root, '.git'), { recursive: true })
    await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true })
    await mkdir(path.join(root, '.tryon-cache'), { recursive: true })
    await mkdir(path.join(root, '成图', '款A'), { recursive: true })

    const valid = await writeFixtureRealImage(root, '款A/服装/look.JPG', 11)
    await writeFile(path.join(root, 'empty.png'), new Uint8Array())
    await writeFile(path.join(root, 'notes.txt'), 'not an image')
    await writeFixtureRealImage(root, '.git/ignored.jpg', 12)
    await writeFixtureRealImage(root, 'node_modules/pkg/ignored.png', 13)
    await writeFixtureRealImage(root, '.tryon-cache/ignored.webp', 14)
    await writeFixtureRealImage(root, '成图/款A/ignored.png', 15)

    const oversized = path.join(root, 'oversized.webp')
    const handle = await open(oversized, 'w')
    await handle.truncate(64 * 1024 * 1024 + 1)
    await handle.close()

    const before = { hash: await sha256(valid), stat: await stat(valid) }
    const result = await scanInput(root)
    const after = { hash: await sha256(valid), stat: await stat(valid) }

    expect(result.files).toEqual([
      expect.objectContaining({
        sourcePath: valid,
        relativePath: '款A/服装/look.JPG',
        mediaType: 'image/jpeg',
        contentHash: before.hash,
      }),
    ])
    expect(result.skipped).toEqual([
      expect.objectContaining({ relativePath: '.git', reason: 'reserved_directory' }),
      expect.objectContaining({ relativePath: '.tryon-cache', reason: 'reserved_directory' }),
      expect.objectContaining({ relativePath: 'empty.png', reason: 'empty' }),
      expect.objectContaining({ relativePath: 'node_modules', reason: 'reserved_directory' }),
      expect.objectContaining({ relativePath: 'notes.txt', reason: 'unsupported_format' }),
      expect.objectContaining({ relativePath: 'oversized.webp', reason: 'too_large' }),
      expect.objectContaining({ relativePath: '成图', reason: 'reserved_directory' }),
    ])
    expect(after.hash).toBe(before.hash)
    expect(after.stat.mtimeMs).toBe(before.stat.mtimeMs)
    expect(after.stat.size).toBe(before.stat.size)
  })

  it('skips AppleDouble and OS metadata files instead of treating them as garments', async () => {
    const root = await tempRoot()
    await writeFixtureRealImage(root, '款A/服装/look.jpg', 21)
    // AppleDouble 伴生文件：扩展名合法、体积非零，必须整体跳过
    await writeFile(path.join(root, '款A', '服装', '._look.jpg'), new Uint8Array(4096).fill(7))
    await writeFile(path.join(root, '款A', '服装', '.DS_Store'), new Uint8Array(64).fill(1))
    await writeFile(path.join(root, '款A', 'Thumbs.db'), new Uint8Array(64).fill(2))
    await writeFile(path.join(root, '款A', 'desktop.ini'), 'x')

    const result = await scanInput(root)

    expect(result.files.map((file) => file.relativePath)).toEqual(['款A/服装/look.jpg'])
    expect(result.skipped.map((entry) => [entry.relativePath, entry.reason])).toEqual([
      ['款A/Thumbs.db', 'system_file'],
      ['款A/desktop.ini', 'system_file'],
      ['款A/服装/.DS_Store', 'system_file'],
      ['款A/服装/._look.jpg', 'system_file'],
    ])
  })

  it('rejects files whose header does not match the declared extension', async () => {
    const root = await tempRoot()
    await writeFile(path.join(root, 'renamed.jpg'), await fixtureImageBytes(31, 'png'))
    await writeFile(path.join(root, 'text.png'), 'PK not an image at all')
    await writeFixtureRealImage(root, 'real.webp', 32)

    const result = await scanInput(root)

    expect(result.files.map((file) => file.relativePath)).toEqual(['real.webp'])
    expect(result.skipped).toEqual([
      expect.objectContaining({
        relativePath: 'renamed.jpg',
        reason: 'unsupported_format',
        message: expect.stringContaining('image/jpeg'),
      }),
      expect.objectContaining({ relativePath: 'text.png', reason: 'unsupported_format' }),
    ])
  })

  it('rejects a missing path or a path that is not a readable directory', async () => {
    const root = await tempRoot()
    const file = await writeFixtureRealImage(root, 'file.jpg', 41)

    await expect(scanInput(path.join(root, 'missing'))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(scanInput(file)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })
})

describe('unicode normalisation', () => {
  it('normalises scanned relative paths to NFC while keeping the on-disk source path', async () => {
    const root = await tempRoot()
    await writeFixtureRealImage(root, `${DECOMPOSED}/look.jpg`, 61)
    const storedName = (await readdir(root))[0]!

    const result = await scanInput(root)

    expect(result.files).toHaveLength(1)
    expect(result.files[0]!.relativePath).toBe(`${COMPOSED}/look.jpg`)
    expect(result.files[0]!.sourcePath).toBe(path.join(root, storedName, 'look.jpg'))
    await expect(readFile(result.files[0]!.sourcePath)).resolves.toBeDefined()
  })
})

describe('roleOfSegment and stableId', () => {
  it('maps role directory names case-insensitively and derives stable ids', () => {
    expect(roleOfSegment(' 服装 ')).toBe('garment')
    expect(roleOfSegment('Models')).toBe('model')
    expect(roleOfSegment('成图')).toBeNull()
    expect(stableId('task', 'a', 'b')).toBe(stableId('task', 'a', 'b'))
    expect(stableId('task', 'a', 'b')).toMatch(/^task_[a-f0-9]{20}$/)
    expect(stableId('task', 'a', 'b')).not.toBe(stableId('task', 'ab'))
  })
})
