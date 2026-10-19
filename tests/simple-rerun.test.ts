import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'

import { runCli, type CliIo } from '../src/cli.js'
import { applyCropPlan, parseCropPlan } from '../src/simple/crop.js'
import type { SimpleGenerateRequest, SimpleGenerator } from '../src/simple/generators.js'
import { acquireRunLock } from '../src/simple/lock.js'
import { buildSimplePrompt } from '../src/simple/prompt.js'
import { readRunRecord, runsDir, type RunRecord } from '../src/simple/record.js'
import { KEEP_FRAME_SENTENCE, updateCollection } from '../src/simple/collection.js'
import { buildNewRunPlan, buildRedoPlan, buildRerunPlan, currentSettings, defaultPrompt, deliveryStem, parseNewRunRequest, parseRedoRequest, parseRerunRequest } from '../src/simple/rerun.js'
import { runSimple } from '../src/simple/run.js'
import { fixtureImageBytes } from './helpers/image-bytes.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

class FakeGenerator implements SimpleGenerator {
  readonly name = 'fake'
  readonly calls: SimpleGenerateRequest[] = []
  async generate(request: SimpleGenerateRequest): Promise<void> {
    this.calls.push(request)
    await sharp({ create: { width: 8, height: 12, channels: 3, background: '#808080' } }).png().toFile(request.outPath)
  }
}

const SOURCE_RUN = '20261015-090000'

// 2 款 × 2 张模特图；EX1 有裁图，EF2 用服装原图
async function makeSource(): Promise<{ root: string; source: RunRecord }> {
  const root = await mkdtemp(path.join(tmpdir(), 'simple-rerun-'))
  roots.push(root)
  const files = ['服装/EX1/g1.jpg', '服装/EX1/g2.jpg', '模特/EX1/m1.jpg', '模特/EX1/m2.jpg', '服装/EF2/a.jpg', '模特/EF2/m1.jpg', '模特/EF2/m2.jpg']
  for (const [index, file] of files.entries()) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await writeFile(path.join(root, file), await fixtureImageBytes(index + 1))
  }
  await applyCropPlan(root, parseCropPlan({ EX1: [{ from: 'g1.jpg', role: '全身-正面' }, { from: 'g2.jpg', role: '细节-领口' }] }))
  const source = await runSimple({ sourceRoot: root, generator: new FakeGenerator(), runId: SOURCE_RUN })
  return { root, source }
}

async function snapshot(root: string): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== '_runs') await walk(full)
      } else {
        result.set(path.relative(root, full), createHash('sha256').update(await readFile(full)).digest('hex'))
      }
    }
  }
  await walk(root)
  return result
}

describe('buildRerunPlan', () => {
  it('keeps the source settings when nothing is edited', async () => {
    const { root, source } = await makeSource()
    const plan = await buildRerunPlan(root, parseRerunRequest({ fromRunId: SOURCE_RUN, shots: [{ sku: 'EX1', model: '模特/EX1/m2.jpg' }] }), {})
    const group = source.groups.find((candidate) => candidate.sku === 'EX1')!
    expect(plan).toEqual({
      fromRunId: SOURCE_RUN,
      engine: 'codex',
      maxReferences: 6,
      groups: [{
        sku: 'EX1',
        swap: 'outfit',
        references: [{ file: '裁图/EX1/01-全身-正面.jpg', role: '全身-正面' }, { file: '裁图/EX1/02-细节-领口.jpg', role: '细节-领口' }],
        prompt: group.prompt,
        promptEdited: false,
        models: ['模特/EX1/m2.jpg'],
      }],
    })
    expect(plan.groups[0]!.prompt).toBe(buildSimplePrompt(['01-全身-正面.jpg', '02-细节-领口.jpg']))
    expect(currentSettings(source, group)).toEqual({
      swap: 'outfit',
      references: plan.groups[0]!.references,
      prompt: group.prompt,
      promptEdited: false,
    })
  })

  it('follows reordered references and renamed roles in the default prompt', async () => {
    const { root } = await makeSource()
    const references = [{ file: '裁图/EX1/02-细节-领口.jpg', role: '细节-下摆' }, { file: path.join(root, '服装/EX1/g2.jpg') }]
    const plan = await buildRerunPlan(root, parseRerunRequest({
      fromRunId: SOURCE_RUN,
      shots: [{ sku: 'EX1', model: '模特/EX1/m1.jpg' }],
      groups: { EX1: { references } },
    }), {})
    expect(plan.groups[0]!.references).toEqual([{ file: '裁图/EX1/02-细节-领口.jpg', role: '细节-下摆' }, { file: '服装/EX1/g2.jpg' }])
    expect(plan.groups[0]!.prompt).toBe(defaultPrompt(plan.groups[0]!.references, 'outfit'))
    expect(plan.groups[0]!.prompt).toContain('图2：细节-下摆\n图3：服装参考图')
  })

  it('marks a prompt as edited only when it differs from the default', async () => {
    const { root, source } = await makeSource()
    const same = await buildRerunPlan(root, parseRerunRequest({
      fromRunId: SOURCE_RUN, shots: [{ sku: 'EF2', model: '模特/EF2/m1.jpg' }], groups: { EF2: { prompt: source.groups.find((group) => group.sku === 'EF2')!.prompt } },
    }), {})
    expect(same.groups[0]!.promptEdited).toBe(false)
    const edited = await buildRerunPlan(root, parseRerunRequest({
      fromRunId: SOURCE_RUN, shots: [{ sku: 'EF2', model: '模特/EF2/m1.jpg' }], groups: { EF2: { prompt: '只换衣服' } },
    }), {})
    expect(edited.groups[0]).toMatchObject({ prompt: '只换衣服', promptEdited: true })
  })

  it('uses the top prompt after switching swap', async () => {
    const { root } = await makeSource()
    const plan = await buildRerunPlan(root, parseRerunRequest({
      fromRunId: SOURCE_RUN, shots: [{ sku: 'EF2', model: '模特/EF2/m1.jpg' }], groups: { EF2: { swap: 'top' } },
    }), {})
    expect(plan.groups[0]).toMatchObject({ swap: 'top', promptEdited: false, prompt: buildSimplePrompt(['a.jpg'], 'top') })
  })

  it('includes model images that were not in the source run, in scan order', async () => {
    const { root } = await makeSource()
    await writeFile(path.join(root, '模特/EX1/m0.jpg'), await fixtureImageBytes(9))
    const plan = await buildRerunPlan(root, parseRerunRequest({
      fromRunId: SOURCE_RUN,
      shots: [{ sku: 'EF2', model: '模特/EF2/m1.jpg' }, { sku: 'EX1', model: '模特/EX1/m2.jpg' }, { sku: 'EX1', model: '模特/EX1/m0.jpg' }, { sku: 'EX1', model: '模特/EX1/m2.jpg' }],
    }), {})
    expect(plan.groups.map((group) => [group.sku, group.models])).toEqual([['EF2', ['模特/EF2/m1.jpg']], ['EX1', ['模特/EX1/m0.jpg', '模特/EX1/m2.jpg']]])
  })

  it('rejects bad requests with clear messages', async () => {
    const { root } = await makeSource()
    const shot = [{ sku: 'EX1', model: '模特/EX1/m1.jpg' }]
    const attempt = (value: unknown): Promise<unknown> => Promise.resolve().then(() => buildRerunPlan(root, parseRerunRequest(value), {}))
    await expect(attempt({ fromRunId: 'bad', shots: shot })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(attempt({ fromRunId: '20261015-120000', shots: shot })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(attempt({ fromRunId: SOURCE_RUN, shots: [] })).rejects.toMatchObject({ message: '没有勾选要重出的图' })
    await expect(attempt({ fromRunId: SOURCE_RUN, shots: [{ sku: 'NO', model: 'x.jpg' }] })).rejects.toMatchObject({ message: '来源 run 里没有这个款号：NO' })
    await expect(attempt({ fromRunId: SOURCE_RUN, shots: [{ sku: 'EX1', model: '模特/EF2/m1.jpg' }] })).rejects.toMatchObject({ message: 'EX1 没有这张模特图：模特/EF2/m1.jpg' })
    for (const file of ['../x.jpg', '成图/EX1/m1.png', '模特/EX1/m1.jpg']) {
      await expect(attempt({ fromRunId: SOURCE_RUN, shots: shot, groups: { EX1: { references: [{ file }] } } }))
        .rejects.toMatchObject({ message: `EX1 的参考图不可用：${file}` })
    }
    await expect(attempt({ fromRunId: SOURCE_RUN, shots: shot, groups: { EX1: { references: [] } } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    const seven = Array.from({ length: 7 }, () => ({ file: '服装/EX1/g1.jpg' }))
    await expect(attempt({ fromRunId: SOURCE_RUN, shots: shot, groups: { EX1: { references: seven } } })).rejects.toMatchObject({ message: '参考图 7 张，超过上限 6 张' })
    await expect(attempt({ fromRunId: SOURCE_RUN, shots: shot, maxReferences: 11 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('picks the fake engine when FASHION_TRYON_FAKE_ENGINE is set', async () => {
    const { root } = await makeSource()
    const request = parseRerunRequest({ fromRunId: SOURCE_RUN, shots: [{ sku: 'EX1', model: '模特/EX1/m1.jpg' }] })
    expect((await buildRerunPlan(root, request, { FASHION_TRYON_FAKE_ENGINE: '{}' })).engine).toBe('fake')
    expect((await buildRerunPlan(root, { ...request, engine: 'apimart' }, { FASHION_TRYON_FAKE_ENGINE: '{}' })).engine).toBe('apimart')
  })
})

describe('runSimple with a rerun plan', () => {
  it('reruns only the planned shot and delivers it as -v2', async () => {
    const { root } = await makeSource()
    const before = await snapshot(root)
    const plan = await buildRerunPlan(root, parseRerunRequest({
      fromRunId: SOURCE_RUN, shots: [{ sku: 'EX1', model: '模特/EX1/m2.jpg' }], groups: { EX1: { prompt: '人工提示词' } },
    }), {})
    const generator = new FakeGenerator()
    const record = await runSimple({ sourceRoot: root, generator, runId: '20261015-100000', planned: plan.groups, derivedFrom: SOURCE_RUN })
    expect(record).toMatchObject({ derivedFrom: SOURCE_RUN, status: 'completed', params: { swap: 'outfit', skus: ['EX1'], maxReferences: 6, engine: 'fake' } })
    expect(record.counts.planned).toBe(1)
    expect(record.groups[0]).toMatchObject({ sku: 'EX1', referenceSource: 'custom', swap: 'outfit', prompt: '人工提示词', promptEdited: true })
    expect(record.groups[0]!.references.map((ref) => ref.file)).toEqual(['裁图/EX1/01-全身-正面.jpg', '裁图/EX1/02-细节-领口.jpg'])
    expect(generator.calls.map((call) => call.prompt)).toEqual(['人工提示词'])
    expect(generator.calls[0]!.referencePaths).toHaveLength(2)
    expect(record.groups[0]!.shots[0]!.delivered).toBe('成图/EX1/m2-v2.png')

    const after = await snapshot(root)
    expect([...after.keys()].filter((key) => !before.has(key))).toEqual([path.join('成图', 'EX1', 'm2-v2.png')])
    for (const [key, hash] of before) expect(after.get(key)).toBe(hash)
    expect((await readRunRecord(path.join(runsDir(root), SOURCE_RUN))).derivedFrom).toBeNull()
  })

  it('refuses to start while another run holds the lock', async () => {
    const { root } = await makeSource()
    const plan = await buildRerunPlan(root, parseRerunRequest({ fromRunId: SOURCE_RUN, shots: [{ sku: 'EX1', model: '模特/EX1/m1.jpg' }] }), {})
    await acquireRunLock(root, { runId: '20261015-110000', pid: process.pid, startedAt: new Date().toISOString() })
    await expect(runSimple({ sourceRoot: root, generator: new FakeGenerator(), runId: '20261015-110500', planned: plan.groups, derivedFrom: SOURCE_RUN }))
      .rejects.toMatchObject({ code: 'RUN_IN_PROGRESS' })
  })
})

describe('rerun command', () => {
  it('runs a plan file with the fake engine', async () => {
    const { root } = await makeSource()
    const plan = await buildRerunPlan(root, parseRerunRequest({ fromRunId: SOURCE_RUN, shots: [{ sku: 'EF2', model: '模特/EF2/m1.jpg' }] }), { FASHION_TRYON_FAKE_ENGINE: '{}' })
    const planFile = path.join(root, 'plan.json')
    await writeFile(planFile, JSON.stringify(plan))
    let stdout = ''
    const io: CliIo = { stdout: (text) => { stdout += text }, stderr: () => undefined }
    const code = await runCli(['rerun', root, '--plan', planFile, '--run-id', '20261015-120000', '--no-open', '--json'], io, { env: { FASHION_TRYON_FAKE_ENGINE: '{}' } })
    expect(code).toBe(0)
    expect(JSON.parse(stdout.trim())).toMatchObject({ ok: true, command: 'rerun', status: 'completed', runId: '20261015-120000', derivedFrom: SOURCE_RUN, engine: 'fake' })
    expect((await readRunRecord(path.join(runsDir(root), '20261015-120000'))).groups[0]!.shots[0]!.delivered).toBe('成图/EF2/m1-v2.png')
  })
})

describe('buildNewRunPlan', () => {
  const allGroups = {
    EX1: { models: ['模特/EX1/m1.jpg', '模特/EX1/m2.jpg'] },
    EF2: { models: ['模特/EF2/m1.jpg', '模特/EF2/m2.jpg'] },
  }
  const pick = (groups: { sku: string; swap: string; prompt: string; references: { file: string; role?: string }[] }[]) =>
    groups.map((group) => ({ sku: group.sku, swap: group.swap, prompt: group.prompt, references: group.references.map((ref) => ({ file: ref.file, ...(ref.role === undefined ? {} : { role: ref.role }) })) }))

  for (const swap of ['outfit', 'top'] as const) {
    it(`matches runSimple defaults with swap ${swap}`, async () => {
      const { root } = await makeSource()
      const plan = await buildNewRunPlan(root, parseNewRunRequest({ groups: allGroups, swap }), {})
      const scanned = await runSimple({ sourceRoot: root, generator: new FakeGenerator(), runId: '20261015-130000', swap })
      expect(plan.fromRunId).toBeUndefined()
      expect(pick(plan.groups)).toEqual(pick(scanned.groups))
      expect(plan.groups.map((group) => [group.sku, group.models, group.referenceSource, group.promptEdited]))
        .toEqual(scanned.groups.map((group) => [group.sku, group.shots.map((shot) => shot.model), group.referenceSource, false]))
    })
  }

  it('records custom references and edited prompts', async () => {
    const { root } = await makeSource()
    const reordered = await buildNewRunPlan(root, parseNewRunRequest({
      groups: { EX1: { models: ['模特/EX1/m1.jpg'], references: [{ file: '裁图/EX1/02-细节-领口.jpg', role: '细节-领口' }, { file: '裁图/EX1/01-全身-正面.jpg', role: '全身-正面' }] } },
    }), {})
    expect(reordered.groups[0]).toMatchObject({ referenceSource: 'custom', promptEdited: false })
    expect(reordered.groups[0]!.prompt).toBe(buildSimplePrompt(['02-细节-领口.jpg', '01-全身-正面.jpg']))
    const edited = await buildNewRunPlan(root, parseNewRunRequest({ groups: { EF2: { models: ['模特/EF2/m1.jpg'], prompt: '只换衣服' } } }), {})
    expect(edited.groups[0]).toMatchObject({ referenceSource: 'custom', prompt: '只换衣服', promptEdited: true })
  })

  it('rejects bad requests with clear messages', async () => {
    const { root } = await makeSource()
    await mkdir(path.join(root, '模特/EG3'), { recursive: true })
    await writeFile(path.join(root, '模特/EG3/m.jpg'), await fixtureImageBytes(20))
    const attempt = (value: unknown): Promise<unknown> => Promise.resolve().then(() => buildNewRunPlan(root, parseNewRunRequest(value), {}))
    await expect(attempt({ groups: {} })).rejects.toMatchObject({ message: '没有勾选要出图的图' })
    await expect(attempt({ groups: { X: { models: ['x.jpg'] } } })).rejects.toMatchObject({ message: '找不到款号：X' })
    await expect(attempt({ groups: { EX1: { models: ['模特/EF2/m1.jpg'] } } })).rejects.toMatchObject({ message: 'EX1 没有这张模特图：模特/EF2/m1.jpg' })
    await expect(attempt({ groups: { EG3: { models: ['模特/EG3/m.jpg'] } } })).rejects.toMatchObject({ message: 'EG3 缺少服装图，不能出图' })
    await expect(attempt({ groups: { EX1: { models: ['模特/EX1/m1.jpg'], references: [{ file: '../x.jpg' }] } } }))
      .rejects.toMatchObject({ message: 'EX1 的参考图不可用：../x.jpg' })
    await expect(attempt({ groups: { EX1: { models: ['模特/EX1/m1.jpg', '模特/EX1/m2.jpg'], pairing: 'fixedModel' } } }))
      .rejects.toMatchObject({ message: 'EX1：固定模特只能选 1 个模特' })
    await expect(attempt({ fromRunId: SOURCE_RUN, groups: {} })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(attempt({ shots: [{ sku: 'EX1', model: '模特/EX1/m1.jpg' }] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('runs through the rerun command without derivedFrom', async () => {
    const { root } = await makeSource()
    const plan = await buildNewRunPlan(root, parseNewRunRequest({ groups: { EF2: { models: ['模特/EF2/m1.jpg'] } } }), { FASHION_TRYON_FAKE_ENGINE: '{}' })
    const planFile = path.join(root, 'plan.json')
    await writeFile(planFile, JSON.stringify(plan))
    let stdout = ''
    const io: CliIo = { stdout: (text) => { stdout += text }, stderr: () => undefined }
    const code = await runCli(['rerun', root, '--plan', planFile, '--run-id', '20261015-140000', '--no-open', '--json'], io, { env: { FASHION_TRYON_FAKE_ENGINE: '{}' } })
    expect(code).toBe(0)
    expect(JSON.parse(stdout.trim())).toMatchObject({ ok: true, status: 'completed', derivedFrom: null })
    const record = await readRunRecord(path.join(runsDir(root), '20261015-140000'))
    expect(record).toMatchObject({ derivedFrom: null })
    expect(record.groups[0]).toMatchObject({ referenceSource: 'originals' })
    expect(record.groups[0]!.shots[0]!.delivered).toBe('成图/EF2/m1-v2.png')
  })
})

describe('buildNewRunPlan pairing', () => {
  it('keeps the fixedGarment plan identical to the previous format', async () => {
    const { root } = await makeSource()
    const plan = await buildNewRunPlan(root, parseNewRunRequest({
      groups: { EX1: { models: ['模特/EX1/m2.jpg'] }, EF2: { models: ['模特/EF2/m1.jpg'], swap: 'top' } },
    }), {})
    // 改动前同一输入（shots + groups.EF2.swap）产出的计划
    const expected = {
      engine: 'codex',
      maxReferences: 6,
      groups: [
        {
          sku: 'EF2', referenceSource: 'custom', swap: 'top', references: [{ file: '服装/EF2/a.jpg' }],
          prompt: buildSimplePrompt(['a.jpg'], 'top'), promptEdited: false, models: ['模特/EF2/m1.jpg'],
        },
        {
          sku: 'EX1', referenceSource: 'crops', swap: 'outfit',
          references: [{ file: '裁图/EX1/01-全身-正面.jpg', role: '全身-正面' }, { file: '裁图/EX1/02-细节-领口.jpg', role: '细节-领口' }],
          prompt: buildSimplePrompt(['01-全身-正面.jpg', '02-细节-领口.jpg']), promptEdited: false, models: ['模特/EX1/m2.jpg'],
        },
      ],
    }
    expect(JSON.stringify(plan)).toBe(JSON.stringify(expected))
  })

  it('expands fixedModel into item groups using the default crop of each garment', async () => {
    const { root } = await makeSource()
    await updateCollection(root, (state) => { state.groups.EX1 = { pairing: 'fixedModel', keepFrame: false, halfModels: [] } })
    const plan = await buildNewRunPlan(root, parseNewRunRequest({ groups: { EX1: { models: ['模特/EX1/m1.jpg'] } }, keepFrame: true }), {})
    expect(plan.groups.map((group) => [group.item, group.pairing, group.keepFrame, group.references.map((ref) => ref.file), group.models])).toEqual([
      ['服装/EX1/g1.jpg', 'fixedModel', true, ['裁图/EX1/01-全身-正面.jpg'], ['模特/EX1/m1.jpg']],
      ['服装/EX1/g2.jpg', 'fixedModel', true, ['裁图/EX1/02-细节-领口.jpg'], ['模特/EX1/m1.jpg']],
    ])
    expect(plan.groups[0]!.prompt.endsWith(`\n${KEEP_FRAME_SENTENCE}`)).toBe(true)
  })

  it('rejects itemRefs pointing at another sku crop', async () => {
    const { root } = await makeSource()
    await applyCropPlan(root, parseCropPlan({ EF2: [{ from: 'a.jpg', role: '全身' }] }))
    await expect(buildNewRunPlan(root, parseNewRunRequest({
      groups: { EX1: { models: ['模特/EX1/m1.jpg'], pairing: 'fixedModel', itemRefs: { '服装/EX1/g1.jpg': '裁图/EF2/01-全身.jpg' } } },
    }), {})).rejects.toMatchObject({ message: 'EX1 的参考图不可用：裁图/EF2/01-全身.jpg' })
  })
})

describe('half-body models on rerun', () => {
  it('adds the keep-frame sentence for models marked half after the source run', async () => {
    const { root } = await makeSource()
    await updateCollection(root, (state) => { state.groups.EX1 = { pairing: 'fixedGarment', keepFrame: false, halfModels: ['模特/EX1/m2.jpg'] } })
    const plan = await buildRerunPlan(root, parseRerunRequest({
      fromRunId: SOURCE_RUN, shots: [{ sku: 'EX1', model: '模特/EX1/m1.jpg' }, { sku: 'EX1', model: '模特/EX1/m2.jpg' }],
    }), {})
    expect(plan.groups[0]!.extraPrompts).toEqual({ '模特/EX1/m2.jpg': KEEP_FRAME_SENTENCE })
    const redo = await buildRedoPlan(root, parseRedoRequest({ items: [{ runId: SOURCE_RUN, sku: 'EX1', model: '模特/EX1/m2.jpg', note: '袖子太长' }] }), 'fake')
    expect(redo.groups[0]!.extraPrompts).toEqual({ '模特/EX1/m2.jpg': `${KEEP_FRAME_SENTENCE}\n袖子太长` })
  })

  it('skips the half-body extra when the rerun prompt already has the sentence', async () => {
    const { root } = await makeSource()
    await updateCollection(root, (state) => { state.groups.EX1 = { pairing: 'fixedGarment', keepFrame: false, halfModels: ['模特/EX1/m2.jpg'] } })
    const plan = await buildRerunPlan(root, parseRerunRequest({
      fromRunId: SOURCE_RUN, shots: [{ sku: 'EX1', model: '模特/EX1/m2.jpg' }], groups: { EX1: { prompt: `自己写的\n${KEEP_FRAME_SENTENCE}` } },
    }), {})
    expect(plan.groups[0]!.extraPrompts).toBeUndefined()
  })

  it('does not repeat the sentence when the group already keeps the frame', async () => {
    const { root } = await makeSource()
    await updateCollection(root, (state) => { state.groups.EX1 = { pairing: 'fixedGarment', keepFrame: false, halfModels: ['模特/EX1/m2.jpg'] } })
    const first = await buildRerunPlan(root, parseRerunRequest({ fromRunId: SOURCE_RUN, shots: [{ sku: 'EX1', model: '模特/EX1/m2.jpg' }] }), {})
    const rerun = await runSimple({ sourceRoot: root, generator: new FakeGenerator(), runId: '20261015-095000', planned: first.groups, derivedFrom: SOURCE_RUN })
    expect(rerun.groups[0]!.shots[0]!.extraPrompt).toBe(KEEP_FRAME_SENTENCE)
    const again = await buildRedoPlan(root, parseRedoRequest({ items: [{ runId: '20261015-095000', sku: 'EX1', model: '模特/EX1/m2.jpg' }] }), 'fake')
    expect(again.groups[0]!.extraPrompts).toEqual({ '模特/EX1/m2.jpg': KEEP_FRAME_SENTENCE })
  })
})

describe('item groups', () => {
  const ITEM_RUN = '20261015-091000'

  // EX1 固定模特：3 张衣服、1 个模特，m1 标了半身
  async function makeItemSource(): Promise<{ root: string; source: RunRecord }> {
    const root = await mkdtemp(path.join(tmpdir(), 'simple-item-'))
    roots.push(root)
    for (const [index, file] of ['服装/EX1/g1.jpg', '服装/EX1/g2.jpg', '服装/EX1/g3.jpg', '模特/EX1/m1.jpg'].entries()) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true })
      await writeFile(path.join(root, file), await fixtureImageBytes(index + 1))
    }
    await updateCollection(root, (state) => { state.groups.EX1 = { pairing: 'fixedModel', keepFrame: false, halfModels: ['模特/EX1/m1.jpg'] } })
    const source = await runSimple({ sourceRoot: root, generator: new FakeGenerator(), runId: ITEM_RUN })
    return { root, source }
  }

  it('deliveryStem joins item and model names', () => {
    expect(deliveryStem('模特/EX1/m1.jpg')).toBe('m1')
    expect(deliveryStem('模特/EX1/m1.jpg', '服装/EX1/g2.jpg')).toBe('g2-m1')
  })

  it('reruns only the group with the same item', async () => {
    const { root } = await makeItemSource()
    const plan = await buildRerunPlan(root, parseRerunRequest({ fromRunId: ITEM_RUN, shots: [{ sku: 'EX1', model: '模特/EX1/m1.jpg', item: '服装/EX1/g2.jpg' }] }), {})
    expect(plan.groups).toHaveLength(1)
    expect(plan.groups[0]).toMatchObject({ item: '服装/EX1/g2.jpg', pairing: 'fixedModel', references: [{ file: '服装/EX1/g2.jpg' }], models: ['模特/EX1/m1.jpg'] })
    const attempt = (shot: Record<string, string>): Promise<unknown> => buildRerunPlan(root, parseRerunRequest({ fromRunId: ITEM_RUN, shots: [shot] }), {})
    await expect(attempt({ sku: 'EX1', model: '模特/EX1/m1.jpg', item: '服装/EX1/g9.jpg' })).rejects.toMatchObject({ message: '来源 run 里没有这张：EX1 模特/EX1/m1.jpg' })
    await expect(attempt({ sku: 'EX1', model: '模特/EX1/m1.jpg' })).rejects.toMatchObject({ message: '来源 run 里没有这张：EX1 模特/EX1/m1.jpg' })
  })

  it('buildRedoPlan copies the source group and adds notes as extra prompts', async () => {
    const { root } = await makeSource()
    const plan = await buildRedoPlan(root, parseRedoRequest({
      items: [
        { runId: SOURCE_RUN, sku: 'EX1', model: '模特/EX1/m1.jpg' },
        { runId: SOURCE_RUN, sku: 'EX1', model: '模特/EX1/m2.jpg', note: '袖子太长' },
      ],
    }), 'fake')
    expect(plan.fromRunId).toBeUndefined()
    expect(plan.engine).toBe('fake')
    expect(plan.groups).toHaveLength(1)
    expect(plan.groups[0]).toMatchObject({ sku: 'EX1', models: ['模特/EX1/m1.jpg', '模特/EX1/m2.jpg'], extraPrompts: { '模特/EX1/m2.jpg': '袖子太长' } })
    await expect(buildRedoPlan(root, parseRedoRequest({ items: [] }), 'codex')).rejects.toMatchObject({ message: '待重出是空的' })
    await expect(buildRedoPlan(root, parseRedoRequest({ items: [{ runId: '20261015-120000', sku: 'EX1', model: '模特/EX1/m1.jpg' }] }), 'codex'))
      .rejects.toMatchObject({ message: '找不到出图记录：20261015-120000' })
    await expect(buildRedoPlan(root, parseRedoRequest({ items: [{ runId: SOURCE_RUN, sku: 'EX1', model: '模特/EF2/m1.jpg' }] }), 'codex'))
      .rejects.toMatchObject({ message: `${SOURCE_RUN} 里没有这张：EX1 模特/EF2/m1.jpg` })
  })

  it('buildRedoPlan groups from different runs of the same sku use separate paths', async () => {
    const { root } = await makeSource()
    // run B：EX1 用另一组参考图出 m2
    const runB = '20261015-093000'
    await runSimple({
      sourceRoot: root, generator: new FakeGenerator(), runId: runB,
      planned: [{ sku: 'EX1', swap: 'outfit', references: [{ file: '服装/EX1/g2.jpg' }, { file: '服装/EX1/g1.jpg' }], prompt: 'B 的提示词', promptEdited: true, models: ['模特/EX1/m2.jpg'] }],
    })
    const plan = await buildRedoPlan(root, parseRedoRequest({
      items: [{ runId: SOURCE_RUN, sku: 'EX1', model: '模特/EX1/m1.jpg' }, { runId: runB, sku: 'EX1', model: '模特/EX1/m2.jpg' }],
    }), 'fake')
    expect(plan.groups).toHaveLength(2)
    // 生成器把模特缩略图原样当成图，用来核对交付的图是哪一组生成的
    class EchoGenerator extends FakeGenerator {
      override async generate(request: SimpleGenerateRequest): Promise<void> {
        this.calls.push({ ...request, referencePaths: [...request.referencePaths] })
        await writeFile(request.outPath, await readFile(request.modelPath))
      }
    }
    const generator = new EchoGenerator()
    const runDir = path.join(runsDir(root), '20261015-094000')
    const record = await runSimple({ sourceRoot: root, generator, runId: '20261015-094000', planned: plan.groups })
    const [first, second] = record.groups
    expect(first!.shots[0]!.modelThumb).toBe('ref/EX1/m1.jpg')
    expect(second!.shots[0]!.modelThumb).not.toBe(first!.shots[0]!.modelThumb)
    expect(second!.references.map((ref) => ref.thumb)).not.toContain(first!.references[0]!.thumb)
    expect(second!.shots[0]!.result).not.toBe(first!.shots[0]!.result)
    expect(await readFile(path.join(runDir, 'prompt-EX1.txt'), 'utf8')).toBe(`${first!.prompt}\n`)
    expect(await readFile(path.join(runDir, 'prompt-EX1-1.txt'), 'utf8')).toBe('B 的提示词\n')
    expect(generator.calls[1]!.referencePaths).toHaveLength(2)
    // 交付的 m1-v2 就是用 m1 缩略图生成的那张
    expect(first!.shots[0]!.delivered).toBe('成图/EX1/m1-v2.png')
    expect(await readFile(path.join(root, first!.shots[0]!.delivered!))).toEqual(await readFile(path.join(runDir, first!.shots[0]!.modelThumb)))
    expect(await readFile(path.join(root, second!.shots[0]!.delivered!))).toEqual(await readFile(path.join(runDir, second!.shots[0]!.modelThumb)))
    expect(await readFile(path.join(runDir, first!.shots[0]!.modelThumb))).not.toEqual(await readFile(path.join(runDir, second!.shots[0]!.modelThumb)))
  })

  it('buildRedoPlan keeps item, the half-body sentence and the note', async () => {
    const { root } = await makeItemSource()
    const plan = await buildRedoPlan(root, parseRedoRequest({
      items: [{ runId: ITEM_RUN, sku: 'EX1', model: '模特/EX1/m1.jpg', item: '服装/EX1/g3.jpg', note: '领口不对' }],
    }), 'codex')
    expect(plan.groups[0]).toMatchObject({ item: '服装/EX1/g3.jpg', pairing: 'fixedModel', extraPrompts: { '模特/EX1/m1.jpg': `${KEEP_FRAME_SENTENCE}\n领口不对` } })
    const record = await runSimple({ sourceRoot: root, generator: new FakeGenerator(), runId: '20261015-092000', planned: plan.groups })
    expect(record.groups[0]!.shots[0]).toMatchObject({ extraPrompt: `${KEEP_FRAME_SENTENCE}\n领口不对`, delivered: '成图/EX1/g3-m1-v2.png' })
  })
})

describe('buildRedoPlan source files', () => {
  it('rejects items whose reference or model photo is gone', async () => {
    const { root } = await makeSource()
    await rm(path.join(root, '裁图/EX1/02-细节-领口.jpg'))
    await expect(buildRedoPlan(root, parseRedoRequest({ items: [{ runId: SOURCE_RUN, sku: 'EX1', model: '模特/EX1/m1.jpg' }] }), 'fake'))
      .rejects.toMatchObject({ message: 'EX1 的参考图不可用：裁图/EX1/02-细节-领口.jpg' })
    await rm(path.join(root, '模特/EF2/m2.jpg'))
    await expect(buildRedoPlan(root, parseRedoRequest({ items: [{ runId: SOURCE_RUN, sku: 'EF2', model: '模特/EF2/m2.jpg' }] }), 'fake'))
      .rejects.toMatchObject({ message: 'EF2 没有这张模特图：模特/EF2/m2.jpg' })
  })
})
