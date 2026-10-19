import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { readCollection } from '../src/simple/collection.js'
import { applyCropPlan, cropOne, parseCropPlan } from '../src/simple/crop.js'
import { fixtureImageBytes } from './helpers/image-bytes.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeRoot(files: string[]): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'simple-crop-'))
  roots.push(root)
  for (const [index, file] of files.entries()) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await writeFile(path.join(root, file), await fixtureImageBytes(index + 1))
  }
  return root
}

const base = ['服装/EX1/g1.jpg', '服装/EX1/g2.jpg', '模特/EX1/m1.jpg']

describe('cropOne', () => {
  it('writes the same bytes as applyCropPlan for the same box', async () => {
    const root = await makeRoot(base)
    await applyCropPlan(root, parseCropPlan({ EX1: [{ from: 'g1.jpg', role: '细节-领口', box: [100, 0, 900, 500] }] }))
    const planned = await readFile(path.join(root, '裁图/EX1/01-细节-领口.jpg'))
    await rm(path.join(root, '裁图'), { recursive: true })
    expect(await cropOne(root, 'EX1', { from: 'g1.jpg', role: '细节-领口', box: [100, 0, 900, 500] })).toBe('裁图/EX1/01-细节-领口.jpg')
    expect(await readFile(path.join(root, '裁图/EX1/01-细节-领口.jpg'))).toEqual(planned)
  })

  it('appends with the next number and leaves other crops untouched', async () => {
    const root = await makeRoot(base)
    await applyCropPlan(root, parseCropPlan({ EX1: [{ from: 'g1.jpg', role: '全身-正面' }, { from: 'g2.jpg', role: '细节-领口' }] }))
    const before = [await readFile(path.join(root, '裁图/EX1/01-全身-正面.jpg')), await readFile(path.join(root, '裁图/EX1/02-细节-领口.jpg'))]
    expect(await cropOne(root, 'EX1', { from: '服装/EX1/g2.jpg', role: '背面' })).toBe('裁图/EX1/03-背面.jpg')
    expect(await readFile(path.join(root, '裁图/EX1/01-全身-正面.jpg'))).toEqual(before[0])
    expect(await readFile(path.join(root, '裁图/EX1/02-细节-领口.jpg'))).toEqual(before[1])
  })

  it('asks before replacing a crop with the same role', async () => {
    const root = await makeRoot(base)
    await applyCropPlan(root, parseCropPlan({ EX1: [{ from: 'g1.jpg', role: '全身-正面' }, { from: 'g2.jpg', role: '细节-领口' }] }))
    const first = await readFile(path.join(root, '裁图/EX1/01-全身-正面.jpg'))
    const second = await readFile(path.join(root, '裁图/EX1/02-细节-领口.jpg'))
    await expect(cropOne(root, 'EX1', { from: 'g1.jpg', role: '细节-领口' })).rejects.toMatchObject({
      code: 'CROP_EXISTS',
      message: '裁图/EX1/ 里已有「细节-领口」，替换吗？',
    })
    expect(await readdir(path.join(root, '裁图/EX1'))).toEqual(['01-全身-正面.jpg', '02-细节-领口.jpg'])
    expect(await readFile(path.join(root, '裁图/EX1/02-细节-领口.jpg'))).toEqual(second)

    expect(await cropOne(root, 'EX1', { from: 'g1.jpg', role: '细节-领口' }, { replace: true })).toBe('裁图/EX1/02-细节-领口.jpg')
    expect(await readdir(path.join(root, '裁图/EX1'))).toEqual(['01-全身-正面.jpg', '02-细节-领口.jpg'])
    expect(await readFile(path.join(root, '裁图/EX1/02-细节-领口.jpg'))).not.toEqual(second)
    expect(await readFile(path.join(root, '裁图/EX1/01-全身-正面.jpg'))).toEqual(first)
  })

  it('re-crops an existing crop with a box', async () => {
    const root = await makeRoot(base)
    await applyCropPlan(root, parseCropPlan({ EX1: [{ from: 'g1.jpg', role: '全身-正面' }] }))
    expect(await cropOne(root, 'EX1', { from: '裁图/EX1/01-全身-正面.jpg', role: '半身', box: [0, 0, 1000, 600] })).toBe('裁图/EX1/02-半身.jpg')
  })

  it('rejects files outside the garments and crops of the sku', async () => {
    const root = await makeRoot(base)
    await expect(cropOne(root, 'EX1', { from: '../外部.jpg', role: 'a' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'EX1 没有这张图：../外部.jpg',
    })
    await expect(cropOne(root, 'EX1', { from: '模特/EX1/m1.jpg', role: 'a' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(cropOne(root, 'EX1', { from: 'g1.jpg', role: 'a/b' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(cropOne(root, 'EX1', { from: 'g1.jpg', role: 'a', box: [500, 0, 400, 100] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(cropOne(root, 'NO', { from: 'g1.jpg', role: 'a' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(await readdir(root)).not.toContain('裁图')
  })
})

describe('crop source records', () => {
  it('records the source garment and inherits it when cropping a crop', async () => {
    const root = await makeRoot(base)
    expect(await cropOne(root, 'EX1', { from: 'g1.jpg', role: '全身-正面' })).toBe('裁图/EX1/01-全身-正面.jpg')
    expect((await readCollection(root)).cropFrom['裁图/EX1/01-全身-正面.jpg']).toBe('服装/EX1/g1.jpg')
    expect(await cropOne(root, 'EX1', { from: '裁图/EX1/01-全身-正面.jpg', role: '半身', box: [0, 0, 1000, 600] })).toBe('裁图/EX1/02-半身.jpg')
    expect((await readCollection(root)).cropFrom['裁图/EX1/02-半身.jpg']).toBe('服装/EX1/g1.jpg')
  })

  it('overwrites the record when replacing a crop with the same role', async () => {
    const root = await makeRoot(base)
    await cropOne(root, 'EX1', { from: 'g1.jpg', role: '全身-正面' })
    await cropOne(root, 'EX1', { from: '服装/EX1/g2.jpg', role: '全身-正面' }, { replace: true })
    expect((await readCollection(root)).cropFrom['裁图/EX1/01-全身-正面.jpg']).toBe('服装/EX1/g2.jpg')
  })

  it('records sources for applyCropPlan', async () => {
    const root = await makeRoot(base)
    await applyCropPlan(root, parseCropPlan({ EX1: [{ from: 'g1.jpg', role: '全身-正面' }, { from: 'g2.jpg', role: '细节-领口' }] }))
    expect((await readCollection(root)).cropFrom).toEqual({
      '裁图/EX1/01-全身-正面.jpg': '服装/EX1/g1.jpg',
      '裁图/EX1/02-细节-领口.jpg': '服装/EX1/g2.jpg',
    })
  })
})

describe('corrupt collection settings', () => {
  it('fails before writing any crop file', async () => {
    const root = await makeRoot(base)
    await mkdir(path.join(root, '成图', '_runs'), { recursive: true })
    await writeFile(path.join(root, '成图', '_runs', 'collection.json'), '{not json', 'utf8')
    await expect(cropOne(root, 'EX1', { from: 'g1.jpg', role: '全身-正面' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(applyCropPlan(root, parseCropPlan({ EX1: [{ from: 'g2.jpg', role: '细节-领口' }] }))).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(readdir(path.join(root, '裁图'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
