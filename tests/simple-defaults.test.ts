import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { applyCropPlan, parseCropPlan } from '../src/simple/crop.js'
import { defaultGroupSettings } from '../src/simple/defaults.js'
import { scanSimple } from '../src/simple/layout.js'
import { buildSimplePrompt } from '../src/simple/prompt.js'
import { fixtureImageBytes } from './helpers/image-bytes.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeRoot(files: string[]): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'simple-defaults-'))
  roots.push(root)
  for (const [index, file] of files.entries()) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await writeFile(path.join(root, file), await fixtureImageBytes(index + 1))
  }
  return root
}

async function groupOf(root: string, sku: string) {
  return (await scanSimple(root)).find((group) => group.sku === sku)!
}

describe('defaultGroupSettings', () => {
  it('uses crops when 裁图/<款号>/ has images', async () => {
    const root = await makeRoot(['服装/EX1/g1.jpg', '服装/EX1/g2.jpg', '模特/EX1/m1.jpg'])
    await applyCropPlan(root, parseCropPlan({ EX1: [{ from: 'g1.jpg', role: '全身-正面' }, { from: 'g2.jpg', role: '细节-领口' }] }))
    const defaults = await defaultGroupSettings(root, await groupOf(root, 'EX1'), 6, 'outfit')
    expect(defaults).toEqual({
      referenceSource: 'crops',
      references: [{ file: '裁图/EX1/01-全身-正面.jpg', role: '全身-正面' }, { file: '裁图/EX1/02-细节-领口.jpg', role: '细节-领口' }],
      prompt: buildSimplePrompt(['01-全身-正面.jpg', '02-细节-领口.jpg']),
    })
  })

  it('uses originals without crops and follows swap', async () => {
    const root = await makeRoot(['服装/EF2/a.jpg', '模特/EF2/m1.jpg'])
    const defaults = await defaultGroupSettings(root, await groupOf(root, 'EF2'), 6, 'top')
    expect(defaults).toEqual({ referenceSource: 'originals', references: [{ file: '服装/EF2/a.jpg' }], prompt: buildSimplePrompt(['a.jpg'], 'top') })
  })

  it('keeps the first N originals and notes the cut', async () => {
    const root = await makeRoot([...Array.from({ length: 8 }, (_, index) => `服装/EX1/${String(index + 1)}.jpg`), '模特/EX1/m1.jpg'])
    const defaults = await defaultGroupSettings(root, await groupOf(root, 'EX1'), 6, 'outfit')
    expect(defaults.references.map((ref) => ref.file)).toEqual(['1', '2', '3', '4', '5', '6'].map((name) => `服装/EX1/${name}.jpg`))
    expect(defaults.note).toBe('服装图 8 张，只用了前 6 张')
  })

  it('notes missing garments or models with no references', async () => {
    const root = await makeRoot(['服装/A/g.jpg', '模特/B/m.jpg'])
    expect(await defaultGroupSettings(root, await groupOf(root, 'A'), 6, 'outfit')).toMatchObject({ references: [], note: '缺少模特图，跳过' })
    expect(await defaultGroupSettings(root, await groupOf(root, 'B'), 6, 'outfit')).toMatchObject({ references: [], note: '缺少服装图，跳过' })
  })
})
