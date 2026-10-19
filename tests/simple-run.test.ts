import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'

import { runCli, type CliIo } from '../src/cli.js'
import type { SimpleGenerateRequest, SimpleGenerator } from '../src/simple/generators.js'
import { scanSimple } from '../src/simple/layout.js'
import { buildSimplePrompt, referenceRole } from '../src/simple/prompt.js'
import { applyCropPlan, parseCropPlan } from '../src/simple/crop.js'
import { createFakeGenerator } from '../src/simple/generators.js'
import { acquireRunLock } from '../src/simple/lock.js'
import { readRunRecord, type RunRecord } from '../src/simple/record.js'
import { runSimple } from '../src/simple/run.js'
import { KEEP_FRAME_SENTENCE, updateCollection, type GroupPrefs } from '../src/simple/collection.js'
import { fixtureImageBytes } from './helpers/image-bytes.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeRoot(files: string[]): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'simple-run-'))
  roots.push(root)
  for (const [index, file] of files.entries()) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await writeFile(path.join(root, file), await fixtureImageBytes(index + 1))
  }
  return root
}

class FakeGenerator implements SimpleGenerator {
  readonly name = 'fake'
  readonly calls: SimpleGenerateRequest[] = []
  constructor(private readonly failOn?: string) {}
  async generate(request: SimpleGenerateRequest): Promise<void> {
    this.calls.push(request)
    if (this.failOn !== undefined && request.outPath.includes(this.failOn)) throw new Error('boom')
    await sharp({ create: { width: 8, height: 12, channels: 3, background: '#808080' } })
      .png()
      .toFile(request.outPath)
  }
}

describe('scanSimple', () => {
  it('reads groups from both folder layouts and sorts files naturally', async () => {
    const root = await makeRoot([
      '服装/EX1/0 (10).jpg',
      '服装/EX1/0 (2).jpg',
      '模特/EX1/0 (1).jpg',
      'EF2_套装/衣服/a.jpg',
      'EF2_套装/模特/b.jpg',
      '成图/EX1/old.png',
    ])
    const groups = await scanSimple(root)
    expect(groups.map((group) => group.sku)).toEqual(['EF2', 'EX1'])
    const ex = groups.find((group) => group.sku === 'EX1')!
    expect(ex.garments.map((file) => file.relativePath)).toEqual(['服装/EX1/0 (2).jpg', '服装/EX1/0 (10).jpg'])
    expect(ex.models).toHaveLength(1)
  })

  it('checks file headers without hashing contents', async () => {
    const root = await makeRoot(['服装/EX1/g1.jpg', '模特/EX1/m1.jpg'])
    await writeFile(path.join(root, '服装/EX1/not-image.jpg'), 'not an image')
    const [group] = await scanSimple(root)
    expect(group!.garments.map((file) => file.relativePath)).toEqual(['服装/EX1/g1.jpg'])
    expect([...group!.garments, ...group!.models].map((file) => [file.mediaType, file.contentHash])).toEqual([['image/jpeg', ''], ['image/jpeg', '']])
  })
})

describe('buildSimplePrompt', () => {
  it('lists reference roles taken from file names', () => {
    expect(referenceRole('01-细节-领口.jpg')).toBe('细节-领口')
    expect(referenceRole('0 (1).jpg')).toBeUndefined()
    const prompt = buildSimplePrompt(['全身-正面.jpg', '0 (3).jpg'])
    expect(prompt).toContain('图2：全身-正面')
    expect(prompt).toContain('图3：服装参考图')
    expect(prompt).toContain('【去掉什么】')
  })

  it('top mode keeps the model bottoms and shoes', () => {
    const prompt = buildSimplePrompt(['平铺-正面.jpg'], 'top')
    expect(prompt).toContain('图2是这件上衣的参考图。')
    expect(prompt).toContain('【换什么】只换上衣')
    expect(prompt).toContain('图1的下装、鞋、袜和腰带保持原样')
    expect(prompt).not.toContain('换成参考图里这一整套')
  })

  it('outfit mode includes visible inner layers and keeps garment labels', () => {
    const prompt = buildSimplePrompt(['a.jpg'])
    expect(prompt).toContain('露出的内搭')
    expect(prompt).toContain('衣服自带的印花、贴标和字样照参考图原样还原')
  })

  it('describes unnamed references as different angles', () => {
    const prompt = buildSimplePrompt(['a.jpg', 'b.jpg'])
    expect(prompt).toContain('图2到图3是同一套服装的参考图，从不同角度拍摄')
  })
})

describe('runSimple', () => {
  it('generates one image per model with all garments, delivers without overwriting, writes a report', async () => {
    const root = await makeRoot([
      '服装/EX1/g1.jpg',
      '服装/EX1/g2.jpg',
      '模特/EX1/m1.jpg',
      '模特/EX1/m2.jpg',
      '成图/EX1/m1.png',
    ])
    const generator = new FakeGenerator()
    const result = await runSimple({ sourceRoot: root, generator, now: () => new Date(2026, 9, 14, 9, 5, 7) })

    expect(generator.calls).toHaveLength(2)
    expect(generator.calls[0]!.referencePaths).toHaveLength(2)
    expect(path.basename(generator.calls[0]!.modelPath)).toBe('m1.jpg')
    expect(result.counts).toMatchObject({ planned: 2, delivered: 2, failed: 0, skippedGroups: 0 })
    expect(result.status).toBe('completed')
    expect(result.runDir).toBe(path.join(root, '成图', '_runs', '20261014-090507'))
    expect((await readdir(path.join(root, '成图', 'EX1'))).sort()).toEqual(['m1-v2.png', 'm1.png', 'm2.png'])
    const report = await readFile(result.reportPath, 'utf8')
    expect(report).toContain('成图/EX1/m1-v2.png')
    expect(report).toContain('<title>试衣结果</title>')
  })

  it('runs only the requested skus with the requested swap mode', async () => {
    const root = await makeRoot(['服装/EX1/g1.jpg', '模特/EX1/m1.jpg', '服装/EF2/g1.jpg', '模特/EF2/m1.jpg'])
    const generator = new FakeGenerator()
    const result = await runSimple({ sourceRoot: root, generator, skus: ['EF2'], swap: 'top' })
    expect(result.groups.map((group) => group.sku)).toEqual(['EF2'])
    expect(generator.calls).toHaveLength(1)
    expect(generator.calls[0]!.prompt).toContain('只换上衣')
    await expect(runSimple({ sourceRoot: root, generator, skus: ['NOPE'] })).rejects.toThrow('找不到款号：NOPE')
  })

  it('caps references, skips incomplete groups and records failures', async () => {
    const root = await makeRoot([
      '服装/EX1/g1.jpg',
      '服装/EX1/g2.jpg',
      '服装/EX1/g3.jpg',
      '模特/EX1/m1.jpg',
      '模特/EX1/m2.jpg',
      '服装/EF2/g1.jpg',
    ])
    const generator = new FakeGenerator('EX1-m2')
    const result = await runSimple({ sourceRoot: root, generator, maxReferences: 2 })
    expect(generator.calls[0]!.referencePaths).toHaveLength(2)
    expect(result.counts).toMatchObject({ delivered: 1, failed: 1, skippedGroups: 1 })
    expect(result.status).toBe('partial')
    const ex = result.groups.find((group) => group.sku === 'EX1')!
    expect(ex.note).toBe('服装图 3 张，只用了前 2 张')
    expect(ex.shots[1]!.error).toBe('boom')
  })
})

describe('run command', () => {
  it('prints one JSON line with report path and counts', async () => {
    const root = await makeRoot(['服装/EX1/g1.jpg', '模特/EX1/m1.jpg'])
    let stdout = ''
    let stderr = ''
    const io: CliIo = { stdout: (text) => { stdout += text }, stderr: (text) => { stderr += text } }
    const opened: string[] = []
    const code = await runCli(['run', root, '--json'], io, {
      simpleGenerator: new FakeGenerator(),
      openUrl: (url) => opened.push(url),
    })
    expect(code).toBe(0)
    const json = JSON.parse(stdout.trim()) as Record<string, unknown>
    expect(json).toMatchObject({ ok: true, command: 'run', status: 'completed', engine: 'fake', counts: { delivered: 1 } })
    expect(json.runId).toMatch(/^\d{8}-\d{6}$/)
    expect(json.graph).toBe(path.join(String(json.runDir), 'graph.html'))
    expect(opened).toEqual([json.report])
    expect(stderr).toContain('OK EX1 m1.jpg')
  })
})

describe('crop plan', () => {
  it('crops from originals into 裁图/<款号>/ and run uses the crops', async () => {
    const root = await makeRoot(['服装/EX1/g1.jpg', '服装/EX1/g2.jpg', '模特/EX1/m1.jpg'])
    const plan = parseCropPlan({
      EX1: [
        { from: 'g1.jpg', role: '全身-正面' },
        { from: 'g2.jpg', role: '细节-领口', box: [0, 0, 500, 500] },
        // 贴边且四舍五入会多出 1 像素的框
        { from: 'g2.jpg', role: '细节-下摆', box: [50, 510, 1000, 1000] },
      ],
    })
    const [outcome] = await applyCropPlan(root, plan)
    expect(outcome!.files).toEqual(['裁图/EX1/01-全身-正面.jpg', '裁图/EX1/02-细节-领口.jpg', '裁图/EX1/03-细节-下摆.jpg'])
    const detail = await sharp(path.join(root, '裁图/EX1/02-细节-领口.jpg')).metadata()
    expect([detail.width, detail.height]).toEqual([12, 16])

    await expect(applyCropPlan(root, plan)).rejects.toThrow(/--replace/)
    await applyCropPlan(root, parseCropPlan({ EX1: [{ from: 'g1.jpg', role: '半身' }] }), { replace: true })
    expect(await readdir(path.join(root, '裁图/EX1'))).toEqual(['01-半身.jpg'])

    const generator = new FakeGenerator()
    const result = await runSimple({ sourceRoot: root, generator })
    expect(result.groups[0]!.referenceSource).toBe('crops')
    expect(generator.calls[0]!.referencePaths).toHaveLength(1)
    expect(result.groups[0]!.prompt).toContain('图2是这套服装的参考图')
    expect(await readFile(result.reportPath, 'utf8')).toContain('裁图/ 里的裁切图')
  })

  it('rejects unknown groups, files and bad boxes before writing', async () => {
    const root = await makeRoot(['服装/EX1/g1.jpg', '模特/EX1/m1.jpg'])
    await expect(applyCropPlan(root, parseCropPlan({ NO: [{ from: 'g1.jpg', role: 'a' }] }))).rejects.toThrow(/没有这个款号/)
    await expect(applyCropPlan(root, parseCropPlan({ EX1: [{ from: 'x.jpg', role: 'a' }] }))).rejects.toThrow(/没有 x.jpg/)
    expect(() => parseCropPlan({ EX1: [{ from: 'g1.jpg', role: 'a', box: [500, 0, 400, 100] }] })).toThrow(/千分比/)
  })
})

async function exists(file: string): Promise<boolean> {
  return readFile(file).then(() => true, () => false)
}

describe('runSimple run record', () => {
  const twoByTwo = ['服装/EX1/g1.jpg', '模特/EX1/m1.jpg', '模特/EX1/m2.jpg', '服装/EF2/g1.jpg', '模特/EF2/m1.jpg', '模特/EF2/m2.jpg']

  it('writes the full plan before the first image and finishes completed', async () => {
    const root = await makeRoot(twoByTwo)
    const fake = createFakeGenerator({ delayMs: 50 })
    let snapshot: RunRecord | undefined
    const runDir = path.join(root, '成图', '_runs', '20261015-090000')
    const generator: SimpleGenerator = {
      name: 'fake',
      async generate(request, signal) {
        snapshot ??= await readRunRecord(runDir)
        await fake.generate(request, signal)
      },
    }
    const result = await runSimple({ sourceRoot: root, generator, runId: '20261015-090000' })
    const shots = snapshot!.groups.flatMap((group) => group.shots)
    expect(shots).toHaveLength(4)
    expect(shots.map((shot) => shot.state)).toEqual(['generating', 'queued', 'queued', 'queued'])
    // 生成中的那张单独计数，不算进排队
    expect(snapshot!.counts).toMatchObject({ planned: 4, queued: 3, generating: 1, delivered: 0 })
    expect(snapshot!.current).toEqual({ sku: shots[0]!.model.split('/')[1], model: shots[0]!.model })
    expect(snapshot!.status).toBe('running')
    expect(snapshot!.params).toEqual({ swap: 'outfit', skus: null, maxReferences: 6, engine: 'fake' })
    expect(result.groups.flatMap((group) => group.shots).every((shot) => shot.state === 'done')).toBe(true)
    expect(result.status).toBe('completed')
    expect(result.finishedAt).not.toBeNull()
    expect(await exists(path.join(root, '成图', '_runs', '.lock'))).toBe(false)
    expect(await readRunRecord(runDir)).toEqual(result)
  })

  it('records a redacted failure and ends partial', async () => {
    const root = await makeRoot(['服装/EX1/g1.jpg', '模特/EX1/m1.jpg', '模特/EX1/m2.jpg'])
    const generator: SimpleGenerator = {
      name: 'fake',
      async generate(request) {
        if (request.outPath.includes('EX1-m2')) throw new Error('bad key sk-test-leak-0123456789')
        await createFakeGenerator().generate(request, new AbortController().signal)
      },
    }
    const result = await runSimple({ sourceRoot: root, generator })
    const failed = result.groups[0]!.shots[1]!
    expect(failed.state).toBe('failed')
    expect(failed.error).not.toContain('sk-test-leak-0123456789')
    expect(result.status).toBe('partial')
    expect(await readFile(path.join(result.runDir, 'run.json'), 'utf8')).not.toContain('sk-test-leak-0123456789')
  })

  it('cancels mid-run: keeps delivered, drops the current shot, returns normally', async () => {
    const root = await makeRoot(twoByTwo)
    const controller = new AbortController()
    const fake = createFakeGenerator({ delayMs: 50 })
    let calls = 0
    const generator: SimpleGenerator = {
      name: 'fake',
      async generate(request, signal) {
        calls += 1
        if (calls === 2) setTimeout(() => controller.abort(), 10)
        await fake.generate(request, signal)
      },
    }
    const result = await runSimple({ sourceRoot: root, generator, signal: controller.signal })
    const shots = result.groups.flatMap((group) => group.shots)
    expect(shots.map((shot) => shot.state)).toEqual(['done', 'cancelled', 'cancelled', 'cancelled'])
    expect(result.status).toBe('cancelled')
    expect(result.current).toBeNull()
    const firstSku = result.groups[0]!.sku
    expect(await readdir(path.join(root, '成图', firstSku))).toEqual(['m1.png'])
    expect(await exists(path.join(root, '成图', '_runs', '.lock'))).toBe(false)
  })

  it('refuses to start while another run holds the lock', async () => {
    const root = await makeRoot(['服装/EX1/g1.jpg', '模特/EX1/m1.jpg'])
    await acquireRunLock(root, { runId: '20261015-080000', pid: process.pid, startedAt: new Date().toISOString() })
    await expect(runSimple({ sourceRoot: root, generator: createFakeGenerator(), runId: '20261015-090000' }))
      .rejects.toMatchObject({ code: 'RUN_IN_PROGRESS' })
    expect(await readdir(path.join(root, '成图', '_runs'))).toEqual(['.lock'])
  })

  it('validates skus before creating a run dir or taking the lock', async () => {
    const root = await makeRoot(['服装/EX1/g1.jpg', '模特/EX1/m1.jpg'])
    await expect(runSimple({ sourceRoot: root, generator: createFakeGenerator(), skus: ['NOPE'] }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(readdir(path.join(root, '成图'))).rejects.toThrow()
  })

  it('updates the heartbeat while running', async () => {
    const root = await makeRoot(['服装/EX1/g1.jpg', '模特/EX1/m1.jpg'])
    const beats = new Set<string>()
    await runSimple({
      sourceRoot: root,
      generator: createFakeGenerator({ delayMs: 100 }),
      heartbeatMs: 20,
      onSave: async (record) => { if (record.status === 'running' && record.heartbeatAt !== null) beats.add(record.heartbeatAt) },
    })
    expect(beats.size).toBeGreaterThanOrEqual(3)
  })
})

describe('run command run id and fake engine', () => {
  const io: CliIo = { stdout: () => undefined, stderr: () => undefined }
  const capture = (): { io: CliIo; out: () => Record<string, unknown> } => {
    let stdout = ''
    return {
      io: { stdout: (text) => { stdout += text }, stderr: () => undefined },
      out: () => JSON.parse(stdout.trim()) as Record<string, unknown>,
    }
  }

  it('rejects a malformed --run-id and an existing run', async () => {
    const root = await makeRoot(['服装/EX1/g1.jpg', '模特/EX1/m1.jpg'])
    const bad = capture()
    expect(await runCli(['run', root, '--json', '--no-open', '--run-id', 'bad'], bad.io, { simpleGenerator: createFakeGenerator() })).toBe(1)
    expect(bad.out()).toMatchObject({ ok: false, error: { code: 'VALIDATION_ERROR' } })
    expect(await runCli(['run', root, '--json', '--no-open', '--run-id', '20261015-090000'], io, { simpleGenerator: createFakeGenerator() })).toBe(0)
    const again = capture()
    expect(await runCli(['run', root, '--json', '--no-open', '--run-id', '20261015-090000'], again.io, { simpleGenerator: createFakeGenerator() })).toBe(1)
    expect(JSON.stringify(again.out())).toContain('run 已存在')
  })

  it('only offers the fake engine when FASHION_TRYON_FAKE_ENGINE is set', async () => {
    const root = await makeRoot(['服装/EX1/g1.jpg', '模特/EX1/m1.jpg'])
    const off = capture()
    expect(await runCli(['run', root, '--json', '--no-open', '--engine', 'fake'], off.io, { env: {} })).toBe(1)
    expect(JSON.stringify(off.out())).toContain('Unknown engine: fake')
    const on = capture()
    expect(await runCli(['run', root, '--json', '--no-open', '--engine', 'fake'], on.io, { env: { FASHION_TRYON_FAKE_ENGINE: '{"delayMs":1}' } })).toBe(0)
    expect(on.out()).toMatchObject({ ok: true, engine: 'fake', status: 'completed' })
  })
})

describe('runSimple with collection prefs', () => {
  const files = ['服装/EX1/g1.jpg', '服装/EX1/g2.jpg', '模特/EX1/m1.jpg', '模特/EX1/m2.jpg', '服装/EF2/a.jpg', '模特/EF2/m1.jpg']
  const setPrefs = (root: string, sku: string, prefs: Partial<GroupPrefs>): Promise<unknown> =>
    updateCollection(root, (state) => { state.groups[sku] = { pairing: 'fixedGarment', keepFrame: false, halfModels: [], ...prefs } })

  it('keeps run.json unchanged for default prefs', async () => {
    const root = await makeRoot(files)
    await applyCropPlan(root, parseCropPlan({ EX1: [{ from: 'g1.jpg', role: '全身-正面' }] }))
    const result = await runSimple({ sourceRoot: root, generator: createFakeGenerator(), runId: '20261015-090000' })
    const { pid: _pid, startedAt: _s, finishedAt: _f, heartbeatAt: _h, ...rest } = result
    const runDir = '<root>/成图/_runs/20261015-090000'
    // 改动前（Task 3 之前）同一输入产出的运行记录
    const expected = {
      schemaVersion: 2,
      runId: '20261015-090000',
      sourceRoot: '<root>',
      runDir,
      reportPath: `${runDir}/report.html`,
      graphPath: `${runDir}/graph.html`,
      engine: 'fake',
      params: { swap: 'outfit', skus: null, maxReferences: 6, engine: 'fake' },
      status: 'completed',
      current: null,
      derivedFrom: null,
      groups: [
        {
          sku: 'EF2', referenceSource: 'originals', swap: 'outfit', promptEdited: false,
          references: [{ file: '服装/EF2/a.jpg', thumb: 'ref/EF2/g1.jpg' }],
          prompt: buildSimplePrompt(['a.jpg']),
          shots: [{ model: '模特/EF2/m1.jpg', modelThumb: 'ref/EF2/m1.jpg', state: 'done', result: 'out/EF2-m1.png', delivered: '成图/EF2/m1.png' }],
        },
        {
          sku: 'EX1', referenceSource: 'crops', swap: 'outfit', promptEdited: false,
          references: [{ file: '裁图/EX1/01-全身-正面.jpg', thumb: 'ref/EX1/g1.jpg', role: '全身-正面' }],
          prompt: buildSimplePrompt(['01-全身-正面.jpg']),
          shots: [
            { model: '模特/EX1/m1.jpg', modelThumb: 'ref/EX1/m1.jpg', state: 'done', result: 'out/EX1-m1.png', delivered: '成图/EX1/m1.png' },
            { model: '模特/EX1/m2.jpg', modelThumb: 'ref/EX1/m2.jpg', state: 'done', result: 'out/EX1-m2.png', delivered: '成图/EX1/m2.png' },
          ],
        },
      ],
      counts: { planned: 3, queued: 0, generating: 0, delivered: 3, failed: 0, cancelled: 0, skippedGroups: 0 },
    }
    expect(JSON.stringify(rest).split(root).join('<root>')).toBe(JSON.stringify(expected))
  })

  it('fixedModel with one model expands one group per garment', async () => {
    const root = await makeRoot(['服装/EX1/g1.jpg', '服装/EX1/g2.jpg', '服装/EX1/g3.jpg', '模特/EX1/m1.jpg'])
    await setPrefs(root, 'EX1', { pairing: 'fixedModel' })
    const generator = new FakeGenerator()
    const result = await runSimple({ sourceRoot: root, generator, runId: '20261015-090000' })
    expect(result.groups.map((group) => [group.item, group.pairing])).toEqual([
      ['服装/EX1/g1.jpg', 'fixedModel'], ['服装/EX1/g2.jpg', 'fixedModel'], ['服装/EX1/g3.jpg', 'fixedModel'],
    ])
    expect(result.groups.flatMap((group) => group.shots.map((shot) => shot.delivered))).toEqual(['成图/EX1/g1-m1.png', '成图/EX1/g2-m1.png', '成图/EX1/g3-m1.png'])
    expect(generator.calls.map((call) => call.referencePaths.length)).toEqual([1, 1, 1])
    expect(result.groups[1]!.references[0]!.thumb).toBe('ref/EX1/2/g1.jpg')
    expect(result.groups[1]!.shots[0]).toMatchObject({ modelThumb: 'ref/EX1/2/m1.jpg', result: 'out/EX1-2-m1.png' })
    expect(await exists(path.join(result.runDir, 'prompt-EX1-3.txt'))).toBe(true)
  })

  it('skips a fixedModel group with two models and runs the others', async () => {
    const root = await makeRoot(files)
    await setPrefs(root, 'EX1', { pairing: 'fixedModel' })
    const result = await runSimple({ sourceRoot: root, generator: new FakeGenerator() })
    const ex = result.groups.find((group) => group.sku === 'EX1')!
    expect(ex).toMatchObject({ note: 'EX1：固定模特只能选 1 个模特', shots: [] })
    expect(result.counts).toMatchObject({ skippedGroups: 1, delivered: 1 })
    expect(await readdir(path.join(root, '成图', 'EF2'))).toEqual(['m1.png'])
  })

  it('oneToOne pairs garments with models and leaves the rest', async () => {
    const root = await makeRoot(['服装/EX1/g1.jpg', '服装/EX1/g2.jpg', '服装/EX1/g3.jpg', '模特/EX1/m1.jpg', '模特/EX1/m2.jpg'])
    await setPrefs(root, 'EX1', { pairing: 'oneToOne' })
    const result = await runSimple({ sourceRoot: root, generator: new FakeGenerator() })
    expect(result.groups).toHaveLength(2)
    expect(result.groups.flatMap((group) => group.shots.map((shot) => shot.delivered))).toEqual(['成图/EX1/g1-m1.png', '成图/EX1/g2-m2.png'])
  })

  it('follows the garment and model order dragged on the page (start_run path)', async () => {
    const root = await makeRoot(['服装/EX1/g1.jpg', '服装/EX1/g2.jpg', '服装/EX1/g3.jpg', '模特/EX1/m1.jpg', '模特/EX1/m2.jpg'])
    await setPrefs(root, 'EX1', { pairing: 'oneToOne' })
    await updateCollection(root, (state) => { state.itemOrder.EX1 = { garments: ['服装/EX1/g3.jpg'], models: ['模特/EX1/m2.jpg'] } })
    const result = await runSimple({ sourceRoot: root, generator: new FakeGenerator() })
    expect(result.groups.flatMap((group) => group.shots.map((shot) => shot.delivered))).toEqual(['成图/EX1/g3-m2.png', '成图/EX1/g1-m1.png'])
  })

  it('uses the crop order dragged on the page for fixed garment references', async () => {
    const root = await makeRoot(['服装/EX1/g1.jpg', '模特/EX1/m1.jpg'])
    await applyCropPlan(root, parseCropPlan({ EX1: [{ from: 'g1.jpg', role: '全身-正面' }, { from: 'g1.jpg', role: '细节-领口' }] }))
    await updateCollection(root, (state) => { state.itemOrder.EX1 = { crops: ['裁图/EX1/02-细节-领口.jpg'] } })
    const result = await runSimple({ sourceRoot: root, generator: new FakeGenerator() })
    expect(result.groups[0]!.references.map((ref) => ref.file)).toEqual(['裁图/EX1/02-细节-领口.jpg', '裁图/EX1/01-全身-正面.jpg'])
  })

  it('never overwrites an existing item delivery', async () => {
    const root = await makeRoot(['服装/EX1/g1.jpg', '模特/EX1/m1.jpg', '成图/EX1/g1-m1.png'])
    await setPrefs(root, 'EX1', { pairing: 'fixedModel' })
    const result = await runSimple({ sourceRoot: root, generator: new FakeGenerator() })
    expect(result.groups[0]!.shots[0]!.delivered).toBe('成图/EX1/g1-m1-v2.png')
  })

  it('appends the shot extra prompt only when generating', async () => {
    const root = await makeRoot(['服装/EX1/g1.jpg', '模特/EX1/m1.jpg', '模特/EX1/m2.jpg'])
    await setPrefs(root, 'EX1', { halfModels: ['模特/EX1/m2.jpg'] })
    const generator = new FakeGenerator()
    const result = await runSimple({ sourceRoot: root, generator })
    expect(result.groups[0]!.shots.map((shot) => shot.extraPrompt)).toEqual([undefined, KEEP_FRAME_SENTENCE])
    expect(generator.calls[0]!.prompt.endsWith(KEEP_FRAME_SENTENCE)).toBe(false)
    expect(generator.calls[1]!.prompt.endsWith(`\n${KEEP_FRAME_SENTENCE}`)).toBe(true)
    expect(await readFile(path.join(result.runDir, 'prompt-EX1.txt'), 'utf8')).not.toContain(KEEP_FRAME_SENTENCE)
  })
})

describe('corrupt collection settings', () => {
  it('fails before taking the lock or creating a run folder', async () => {
    const root = await makeRoot(['服装/EX1/g1.jpg', '模特/EX1/m1.jpg'])
    await mkdir(path.join(root, '成图', '_runs'), { recursive: true })
    await writeFile(path.join(root, '成图', '_runs', 'collection.json'), '{not json', 'utf8')
    await expect(runSimple({ sourceRoot: root, generator: new FakeGenerator(), runId: '20261016-080000' }))
      .rejects.toMatchObject({ message: '合集设置文件损坏：成图/_runs/collection.json' })
    expect((await readdir(path.join(root, '成图', '_runs'))).sort()).toEqual(['collection.json'])
  })
})
