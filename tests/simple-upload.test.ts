import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { scanSimple } from '../src/simple/layout.js'
import { placeUpload, UPLOAD_MAX_BYTES, validateNewSku } from '../src/simple/upload.js'
import { fixtureImageBytes } from './helpers/image-bytes.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeRoot(files: string[]): Promise<string> {
  const parent = await mkdtemp(path.join(tmpdir(), 'simple-upload-'))
  roots.push(parent)
  const root = path.join(parent, 'root')
  await mkdir(root)
  for (const [index, file] of files.entries()) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await writeFile(path.join(root, file), await fixtureImageBytes(index + 1))
  }
  return root
}

async function image(seed: number, format: 'jpeg' | 'png' | 'webp' = 'jpeg'): Promise<Buffer> {
  return Buffer.from(await fixtureImageBytes(seed, format))
}

async function scanned(root: string, sku: string, kind: 'garments' | 'models'): Promise<string[]> {
  return (await scanSimple(root)).find((group) => group.sku === sku)?.[kind].map((file) => file.relativePath) ?? []
}

describe('placeUpload', () => {
  it('writes into the existing per-sku folder', async () => {
    const root = await makeRoot(['A/服装/x.jpg', 'A/模特/m.jpg'])
    const bytes = await image(10, 'png')
    expect(await placeUpload(root, { sku: 'A', kind: 'garment', fileName: 'y.png', bytes })).toEqual({ file: 'A/服装/y.png' })
    expect(await readFile(path.join(root, 'A/服装/y.png'))).toEqual(bytes)
    expect(await scanned(root, 'A', 'garments')).toContain('A/服装/y.png')
  })

  it('follows the per-role layout for existing and new skus', async () => {
    const root = await makeRoot(['衣服/A/g.jpg', '人物/A/m.jpg'])
    expect(await placeUpload(root, { sku: 'A', kind: 'model', fileName: 'm2.jpg', bytes: await image(11) })).toEqual({ file: '人物/A/m2.jpg' })
    expect(await placeUpload(root, { sku: 'B', kind: 'garment', fileName: 'g.jpg', bytes: await image(12) })).toEqual({ file: '衣服/B/g.jpg' })
    expect(await scanned(root, 'B', 'garments')).toEqual(['衣服/B/g.jpg'])
  })

  it('creates <sku>/服装 and <sku>/模特 in an empty root', async () => {
    const root = await makeRoot([])
    expect(await placeUpload(root, { sku: 'C', kind: 'garment', fileName: 'g.jpg', bytes: await image(13) })).toEqual({ file: 'C/服装/g.jpg' })
    expect(await placeUpload(root, { sku: 'C', kind: 'model', fileName: 'm.webp', bytes: await image(14, 'webp') })).toEqual({ file: 'C/模特/m.webp' })
    expect(await scanned(root, 'C', 'models')).toEqual(['C/模特/m.webp'])
  })

  it('adds the missing kind next to the existing one', async () => {
    const perSku = await makeRoot(['D_套装/服装/g.jpg'])
    expect(await placeUpload(perSku, { sku: 'D', kind: 'model', fileName: 'm.jpg', bytes: await image(15) })).toEqual({ file: 'D_套装/模特/m.jpg' })
    const perRole = await makeRoot(['服装/E/g.jpg', '人物/F/m.jpg', '服装/F/g.jpg'])
    expect(await placeUpload(perRole, { sku: 'E', kind: 'model', fileName: 'm.jpg', bytes: await image(16) })).toEqual({ file: '人物/E/m.jpg' })
  })

  it('never overwrites: adds (2), (3) and survives concurrent same names', async () => {
    const root = await makeRoot(['A/服装/x.jpg', 'A/模特/m.jpg'])
    const original = await readFile(path.join(root, 'A/服装/x.jpg'))
    expect((await placeUpload(root, { sku: 'A', kind: 'garment', fileName: 'x.jpg', bytes: await image(20) })).file).toBe('A/服装/x (2).jpg')
    expect((await placeUpload(root, { sku: 'A', kind: 'garment', fileName: 'x.jpg', bytes: await image(21) })).file).toBe('A/服装/x (3).jpg')
    expect(await readFile(path.join(root, 'A/服装/x.jpg'))).toEqual(original)
    const results = await Promise.all(Array.from({ length: 5 }, async (_, index) =>
      placeUpload(root, { sku: 'A', kind: 'model', fileName: 'same.jpg', bytes: await image(30 + index) })))
    expect(new Set(results.map((result) => result.file)).size).toBe(5)
    expect((await readdir(path.join(root, 'A/模特'))).filter((name) => name.startsWith('.'))).toEqual([])
  })

  it('rejects unsupported, oversized and mislabeled files', async () => {
    const root = await makeRoot(['A/服装/x.jpg', 'A/模特/m.jpg'])
    const jpg = await image(40)
    const put = (fileName: string, bytes: Buffer) => placeUpload(root, { sku: 'A', kind: 'garment', fileName, bytes })
    for (const name of ['a.heic', 'a.gif', 'a.pdf']) {
      await expect(put(name, jpg)).rejects.toMatchObject({ message: `${name}：只支持 jpg、png、webp` })
    }
    await expect(put('big.jpg', Buffer.concat([jpg, Buffer.alloc(UPLOAD_MAX_BYTES)]))).rejects.toMatchObject({ message: 'big.jpg：超过 50 MB' })
    await expect(put('fake.jpg', await image(41, 'png'))).rejects.toMatchObject({ message: 'fake.jpg：不是有效的图片' })
    expect((await put('UP.JPG', jpg)).file).toBe('A/服装/UP.JPG')
  })

  it('rejects path-like file names without writing outside the root', async () => {
    const root = await makeRoot(['A/服装/x.jpg', 'A/模特/m.jpg'])
    const jpg = await image(50)
    for (const name of ['../x.jpg', '.hidden.jpg', 'a/b.jpg', 'a\\b.jpg']) {
      await expect(placeUpload(root, { sku: 'A', kind: 'garment', fileName: name, bytes: jpg })).rejects.toMatchObject({ message: `文件名不能用：${name}` })
    }
    expect(await readdir(path.dirname(root))).toEqual(['root'])
    expect(await readdir(path.join(root, 'A/服装'))).toEqual(['x.jpg'])
  })
})

describe('validateNewSku', () => {
  it('rejects bad and duplicate skus', async () => {
    const root = await makeRoot(['A/服装/x.jpg', 'A/模特/m.jpg'])
    await expect(validateNewSku(root, 'NEW1')).resolves.toBeUndefined()
    await expect(validateNewSku(root, 'A')).rejects.toMatchObject({ message: '款号已存在：A' })
    await expect(validateNewSku(root, 'a')).rejects.toMatchObject({ message: '款号已存在：a' })
    for (const sku of ['a/b', 'a\\b', 'a_b', 'a b', '..', '.x', '成图', '裁图', '_runs', '服装', '模特', '', '   ', 'x'.repeat(65)]) {
      await expect(validateNewSku(root, sku)).rejects.toMatchObject({ message: expect.stringMatching(/^款号不能用：/) as unknown as string })
    }
    await expect(placeUpload(root, { sku: 'a_b', kind: 'garment', fileName: 'g.jpg', bytes: await image(60) })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })
})
