import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { afterEach, describe, expect, it } from 'vitest'

import { runCli, type CliIo } from '../src/cli.js'
import { readEditorSession } from '../src/editor/server.js'
import {
  cancelRunTool,
  cropTool,
  listRunsTool,
  rerunTool,
  runStatusTool,
  scanTool,
  startRunTool,
  type LaunchConfig,
  type RunDetail,
} from '../src/mcp/tools.js'
import { claimRunDir } from '../src/mcp/launch.js'
import { scanSimple } from '../src/simple/layout.js'
import { readActiveLock } from '../src/simple/lock.js'
import { readRunRecord, runsDir } from '../src/simple/record.js'
import { buildRerunPlan, parseRerunRequest } from '../src/simple/rerun.js'
import { KEEP_FRAME_SENTENCE, updateCollection } from '../src/simple/collection.js'
import { fixtureImageBytes } from './helpers/image-bytes.js'

const roots: string[] = []
const pids: number[] = []

afterEach(async () => {
  // 默认打开的 start_run / rerun 会拉起编辑服务
  for (const root of roots) {
    const session = await readEditorSession(root)
    if (session !== undefined) pids.push(session.pid)
  }
  for (const pid of pids.splice(0)) {
    try { process.kill(pid, 'SIGKILL') } catch { /* 已退出 */ }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeRoot(files: string[]): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mcp-tools-'))
  roots.push(root)
  for (const [index, file] of files.entries()) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await writeFile(path.join(root, file), await fixtureImageBytes(index + 1))
  }
  return root
}

const TWO_BY_TWO = ['服装/EX1/g1.jpg', '模特/EX1/m1.jpg', '模特/EX1/m2.jpg', '服装/EF2/g1.jpg', '模特/EF2/m1.jpg', '模特/EF2/m2.jpg']

/** 环境里去掉真实密钥，避免测试碰到本机 .env 里的配置 */
function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('APIMART_') || key === 'IMAGE_MODEL') delete env[key]
  }
  return { ...env, ...extra }
}

function config(delayMs = 300, extra: NodeJS.ProcessEnv = {}): LaunchConfig {
  return {
    cliCommand: [process.execPath, '--import', 'tsx', path.resolve('src/cli.ts')],
    env: cleanEnv({ FASHION_TRYON_FAKE_ENGINE: JSON.stringify({ delayMs }), ...extra }),
  }
}

async function track<T extends { runDir: string }>(promise: Promise<T>): Promise<T> {
  const result = await promise
  const record = await readRunRecord(result.runDir)
  if (record.pid !== null) pids.push(record.pid)
  return result
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out')
    await sleep(100)
  }
}

async function waitDone(root: string, runId: string): Promise<RunDetail> {
  let last: RunDetail | undefined
  await waitUntil(async () => {
    last = await runStatusTool({ sourceRoot: root, runId })
    return last.status !== 'running'
  })
  return last!
}

async function hashTree(root: string, skip: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      const rel = path.relative(root, full)
      if (skip.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`))) continue
      if (entry.isDirectory()) await walk(full)
      else out[rel] = createHash('sha256').update(await readFile(full)).digest('hex')
    }
  }
  await walk(root)
  return out
}

describe('scan and crop tools', () => {
  it('matches scanSimple with absolute paths in both layouts and flags incomplete groups', async () => {
    const root = await makeRoot(['服装/EX1/g1.jpg', '模特/EX1/m1.jpg', 'EF2_套装/衣服/a.jpg', 'EF2_套装/模特/b.jpg', '服装/NO3/g.jpg'])
    const result = await scanTool({ sourceRoot: root })
    const expected = await scanSimple(root)
    expect(result.groups.map((group) => group.sku)).toEqual(expected.map((group) => group.sku))
    for (const [index, group] of result.groups.entries()) {
      expect(group.garments).toEqual(expected[index]!.garments.map((file) => file.sourcePath))
      expect(group.models).toEqual(expected[index]!.models.map((file) => file.sourcePath))
      expect(group.garments.every((file) => path.isAbsolute(file))).toBe(true)
    }
    expect(result.groups.find((group) => group.sku === 'NO3')!.note).toBe('缺少模特图')
    expect(result.groups.find((group) => group.sku === 'EX1')!.note).toBeUndefined()
    await expect(scanTool({ sourceRoot: 'relative/path' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('produces the same crops as the CLI and keeps existing crops without replace', async () => {
    const plan = { EX1: [{ from: 'g1.jpg', role: '全身-正面' }, { from: 'g1.jpg', role: '细节-领口', box: [0, 0, 500, 500] }] }
    const viaTool = await makeRoot(['服装/EX1/g1.jpg', '模特/EX1/m1.jpg'])
    const viaCli = await makeRoot(['服装/EX1/g1.jpg', '模特/EX1/m1.jpg'])
    const result = await cropTool({ sourceRoot: viaTool, plan })
    expect(result.groups[0]!.files).toEqual([path.join(viaTool, '裁图/EX1/01-全身-正面.jpg'), path.join(viaTool, '裁图/EX1/02-细节-领口.jpg')])
    const planFile = path.join(viaCli, 'plan.json')
    await writeFile(planFile, JSON.stringify(plan))
    const io: CliIo = { stdout: () => undefined, stderr: () => undefined }
    expect(await runCli(['crop', viaCli, '--plan', planFile, '--json'], io)).toBe(0)
    expect(await hashTree(path.join(viaTool, '裁图'), [])).toEqual(await hashTree(path.join(viaCli, '裁图'), []))

    const before = await hashTree(path.join(viaTool, '裁图'), [])
    await expect(cropTool({ sourceRoot: viaTool, plan: { EX1: [{ from: 'g1.jpg', role: '半身' }] } })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(await hashTree(path.join(viaTool, '裁图'), [])).toEqual(before)
  })
})

describe('background runs', () => {
  it('claims a distinct run directory for submissions in the same second', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mcp-claim-'))
    roots.push(root)
    const claimed = await Promise.all(Array.from({ length: 5 }, () => claimRunDir(root)))
    expect(new Set(claimed.map((item) => item.runId)).size).toBe(5)
    expect((await readdir(runsDir(root))).sort()).toEqual(claimed.map((item) => item.runId).sort())
  })

  it('starts quickly, reports monotonic progress and delivers like the CLI', async () => {
    const root = await makeRoot(TWO_BY_TWO)
    const opened: string[] = []
    const started = Date.now()
    const run = await track(startRunTool({ sourceRoot: root }, { ...config(400), openUrl: (url) => opened.push(url) }))
    expect(Date.now() - started).toBeLessThan(2000)
    expect(run.status).toBe('running')
    expect(run.counts.planned).toBe(4)
    expect(opened).toEqual([run.editorUrl])

    const seen: number[] = []
    let sawCurrent = false
    for (let index = 0; index < 3; index += 1) {
      const status = await runStatusTool({ sourceRoot: root })
      seen.push(status.counts.delivered)
      if (status.current !== null) sawCurrent = true
      await sleep(350)
    }
    expect(seen).toEqual([...seen].sort((a, b) => a - b))
    expect(sawCurrent).toBe(true)
    const done = await waitDone(root, run.runId)
    expect(done.status).toBe('completed')
    expect(done.counts).toMatchObject({ planned: 4, delivered: 4, queued: 0 })
    expect(done.groups[0]!.shots[0]!.delivered).toBe(path.join(root, '成图', done.groups[0]!.sku, 'm1.png'))

    const direct = await makeRoot(TWO_BY_TWO)
    const io: CliIo = { stdout: () => undefined, stderr: () => undefined }
    await runCli(['run', direct, '--json', '--no-open', '--engine', 'fake'], io, { env: { FASHION_TRYON_FAKE_ENGINE: '{}' } })
    const names = async (dir: string): Promise<string[]> =>
      Object.keys(await hashTree(path.join(dir, '成图'), ['_runs'])).sort()
    expect(await names(root)).toEqual(await names(direct))
  })

  it('allows one run per source root', async () => {
    const root = await makeRoot(TWO_BY_TWO)
    const other = await makeRoot(TWO_BY_TWO)
    const first = await track(startRunTool({ sourceRoot: root, open: false }, config(500)))
    const attempt = startRunTool({ sourceRoot: root, open: false }, config(500))
    await expect(attempt).rejects.toMatchObject({ code: 'RUN_IN_PROGRESS' })
    await expect(attempt).rejects.toThrow(first.runId)
    const second = await track(startRunTool({ sourceRoot: other, open: false }, config(500)))
    expect(second.status).toBe('running')
    await cancelRunTool({ sourceRoot: root, runId: first.runId })
    await cancelRunTool({ sourceRoot: other, runId: second.runId })
  })

  it('cancels mid-run and is idempotent afterwards', async () => {
    const root = await makeRoot(TWO_BY_TWO)
    const run = await track(startRunTool({ sourceRoot: root, open: false }, config(600)))
    await waitUntil(async () => (await runStatusTool({ sourceRoot: root, runId: run.runId })).counts.delivered >= 1)
    const cancelled = await cancelRunTool({ sourceRoot: root, runId: run.runId })
    expect(cancelled.status).toBe('cancelled')
    const shots = cancelled.groups.flatMap((group) => group.shots)
    const delivered = shots.filter((shot) => shot.state === 'done')
    expect(delivered.length).toBeGreaterThanOrEqual(1)
    expect(shots.filter((shot) => shot.state === 'cancelled').length).toBeGreaterThanOrEqual(1)
    expect(shots.some((shot) => shot.state === 'queued' || shot.state === 'generating')).toBe(false)
    const deliveredFiles = Object.keys(await hashTree(path.join(root, '成图'), ['_runs']))
    expect(deliveredFiles).toHaveLength(delivered.length)
    const again = await cancelRunTool({ sourceRoot: root, runId: run.runId })
    expect(again.status).toBe('cancelled')
    expect(again.counts).toEqual(cancelled.counts)
  })

  it('marks a killed run as interrupted and frees the root', async () => {
    const root = await makeRoot(TWO_BY_TWO)
    const run = await track(startRunTool({ sourceRoot: root, open: false }, config(800)))
    const record = await readRunRecord(run.runDir)
    process.kill(record.pid!, 'SIGKILL')
    await waitUntil(async () => (await runStatusTool({ sourceRoot: root, runId: run.runId })).status === 'interrupted')
    await sleep(1100)
    const next = await track(startRunTool({ sourceRoot: root, open: false }, config(10)))
    expect(next.runId).not.toBe(run.runId)
    expect((await waitDone(root, next.runId)).status).toBe('completed')
  })

  it('rejects apimart without a key and unknown skus before creating a run', async () => {
    const root = await makeRoot(TWO_BY_TWO)
    await expect(startRunTool({ sourceRoot: root, engine: 'apimart', open: false }, config()))
      .rejects.toMatchObject({ code: 'CONFIG_ERROR' })
    await expect(startRunTool({ sourceRoot: root, skus: ['NOPE'], open: false }, config()))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(readdir(runsDir(root))).rejects.toThrow()
  })

  it('reports NO_RUNNABLE_TASKS when every group lacks images', async () => {
    const root = await makeRoot(['服装/EX1/g1.jpg'])
    await expect(startRunTool({ sourceRoot: root, open: false }, config()))
      .rejects.toMatchObject({ code: 'NO_RUNNABLE_TASKS' })
  })
})

describe('rerun', () => {
  const SOURCE = '20261015-090000'

  async function sourceRun(): Promise<string> {
    const root = await makeRoot(TWO_BY_TWO)
    const io: CliIo = { stdout: () => undefined, stderr: () => undefined }
    await runCli(['run', root, '--json', '--no-open', '--engine', 'fake', '--run-id', SOURCE], io, { env: { FASHION_TRYON_FAKE_ENGINE: '{}' } })
    return root
  }

  it('reruns only the requested shot in the background', async () => {
    const root = await sourceRun()
    const opened: string[] = []
    const started = Date.now()
    const run = await track(rerunTool(
      { sourceRoot: root, fromRunId: SOURCE, shots: [{ sku: 'EX1', model: path.join(root, '模特/EX1/m2.jpg') }] },
      { ...config(200), openUrl: (url) => opened.push(url) },
    ))
    expect(Date.now() - started).toBeLessThan(2000)
    expect(run).toMatchObject({ derivedFrom: SOURCE, status: 'running' })
    expect(run.counts.planned).toBe(1)
    expect(opened).toEqual([run.editorUrl])
    const done = await waitDone(root, run.runId)
    expect(done.counts).toMatchObject({ planned: 1, delivered: 1 })
    expect(done.groups[0]!.shots[0]!.delivered).toBe(path.join(root, '成图/EX1/m2-v2.png'))
    const listed = await listRunsTool({ sourceRoot: root })
    expect(listed.runs.map((item) => [item.runId, item.derivedFrom])).toEqual([[run.runId, SOURCE], [SOURCE, null]])
  })

  it('reruns only the requested fixedModel combo when the shot has an item', async () => {
    const root = await makeRoot(['服装/EX1/g1.jpg', '服装/EX1/g2.jpg', '服装/EX1/g3.jpg', '模特/EX1/m1.jpg'])
    await updateCollection(root, (state) => { state.groups.EX1 = { pairing: 'fixedModel', keepFrame: false, halfModels: [] } })
    const io: CliIo = { stdout: () => undefined, stderr: () => undefined }
    await runCli(['run', root, '--json', '--no-open', '--engine', 'fake', '--run-id', SOURCE], io, { env: { FASHION_TRYON_FAKE_ENGINE: '{}' } })
    const run = await track(rerunTool(
      { sourceRoot: root, fromRunId: SOURCE, shots: [{ sku: 'EX1', item: path.join(root, '服装/EX1/g2.jpg'), model: '模特/EX1/m1.jpg' }], open: false },
      config(0),
    ))
    await waitDone(root, run.runId)
    const record = await readRunRecord(run.runDir)
    expect(record.groups.map((group) => [group.sku, group.item, group.shots.map((shot) => shot.delivered)])).toEqual([
      ['EX1', '服装/EX1/g2.jpg', ['成图/EX1/g2-m1-v2.png']],
    ])
  })

  it('tells which garment, rule and extra prompt each combo uses in run_status', async () => {
    const root = await makeRoot(['服装/EX1/g1.jpg', '服装/EX1/g2.jpg', '模特/EX1/m1.jpg', '服装/EF2/g1.jpg', '模特/EF2/m1.jpg'])
    await updateCollection(root, (state) => { state.groups.EX1 = { pairing: 'fixedModel', keepFrame: false, halfModels: ['模特/EX1/m1.jpg'] } })
    const io: CliIo = { stdout: () => undefined, stderr: () => undefined }
    await runCli(['run', root, '--json', '--no-open', '--engine', 'fake', '--run-id', SOURCE], io, { env: { FASHION_TRYON_FAKE_ENGINE: '{}' } })
    const status = await runStatusTool({ sourceRoot: root, runId: SOURCE })
    const combos = status.groups.filter((group) => group.sku === 'EX1')
    expect(combos.map((group) => [group.item, group.pairing])).toEqual([
      [path.join(root, '服装/EX1/g1.jpg'), 'fixedModel'],
      [path.join(root, '服装/EX1/g2.jpg'), 'fixedModel'],
    ])
    expect(combos[0]!.shots[0]!.extraPrompt).toBe(KEEP_FRAME_SENTENCE)
    // 从未设置过的款不多出字段
    const plain = status.groups.find((group) => group.sku === 'EF2')!
    expect(plain).not.toHaveProperty('item')
    expect(plain).not.toHaveProperty('pairing')
    expect(plain).not.toHaveProperty('keepFrame')
    expect(plain.shots[0]).not.toHaveProperty('extraPrompt')
  })

  it('exposes the current settings of each group in run_status', async () => {
    const root = await sourceRun()
    const status = await runStatusTool({ sourceRoot: root, runId: SOURCE })
    const group = status.groups.find((item) => item.sku === 'EX1')!
    expect(group).toMatchObject({
      swap: 'outfit',
      referenceSource: 'originals',
      references: [{ file: path.join(root, '服装/EX1/g1.jpg') }],
      promptEdited: false,
    })
    expect(group.prompt).toContain('图2是这套服装的参考图')
    expect(status.derivedFrom).toBeNull()
  })

  it('rejects a rerun while another run is going', async () => {
    const root = await sourceRun()
    const first = await track(startRunTool({ sourceRoot: root, open: false }, config(500)))
    const attempt = rerunTool({ sourceRoot: root, fromRunId: SOURCE, shots: [{ sku: 'EX1', model: '模特/EX1/m1.jpg' }], open: false }, config(500))
    await expect(attempt).rejects.toMatchObject({ code: 'RUN_IN_PROGRESS' })
    await expect(attempt).rejects.toThrow(first.runId)
    await cancelRunTool({ sourceRoot: root, runId: first.runId })
  })

  it('writes the same plan as buildRerunPlan and creates nothing on bad input', async () => {
    const root = await sourceRun()
    const request = {
      fromRunId: SOURCE,
      shots: [{ sku: 'EF2', model: '模特/EF2/m1.jpg' }, { sku: 'EX1', model: '模特/EX1/m1.jpg' }],
      groups: { EX1: { swap: 'top' as const, references: [{ file: '服装/EX1/g1.jpg', role: '全身-正面' }] }, EF2: { prompt: '人工' } },
    }
    const launch = config(0)
    const expected = await buildRerunPlan(root, parseRerunRequest(request), launch.env)
    const run = await track(rerunTool({ sourceRoot: root, ...request, open: false }, launch))
    expect(JSON.parse(await readFile(path.join(run.runDir, 'rerun-plan.json'), 'utf8'))).toEqual(expected)
    await waitDone(root, run.runId)
    // run.json 先写完成、随后才释放锁
    await waitUntil(async () => (await readActiveLock(root)) === null)

    const before = (await listRunsTool({ sourceRoot: root })).runs.length
    await expect(rerunTool({ sourceRoot: root, fromRunId: SOURCE, shots: [], open: false }, launch)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    await expect(rerunTool({ sourceRoot: root, fromRunId: SOURCE, shots: [{ sku: 'EX1', model: '模特/EX1/m1.jpg' }], engine: 'apimart', open: false }, launch))
      .rejects.toMatchObject({ code: 'CONFIG_ERROR' })
    expect((await listRunsTool({ sourceRoot: root })).runs).toHaveLength(before)
  })
})

describe('history and status', () => {
  it('lists legacy and new runs newest first', async () => {
    const root = await makeRoot(['服装/EX1/g1.jpg', '模特/EX1/m1.jpg'])
    const legacyDir = path.join(runsDir(root), '20200101-000000')
    await mkdir(legacyDir, { recursive: true })
    await writeFile(path.join(legacyDir, 'run.json'), JSON.stringify({
      runDir: legacyDir,
      engine: 'codex',
      groups: [{ sku: 'EX1', referenceSource: 'originals', references: [], prompt: 'p', shots: [{ model: '模特/EX1/m1.jpg', modelThumb: 'ref/EX1/m1.jpg', result: 'out/x.png' }] }],
      counts: { delivered: 1, failed: 0, skippedGroups: 0 },
    }))
    const io: CliIo = { stdout: () => undefined, stderr: () => undefined }
    const env = { FASHION_TRYON_FAKE_ENGINE: '{}' }
    await runCli(['run', root, '--json', '--no-open', '--engine', 'fake', '--run-id', '20261015-090000'], io, { env })
    await runCli(['run', root, '--json', '--no-open', '--engine', 'fake', '--run-id', '20261015-090001'], io, { env })
    const { runs } = await listRunsTool({ sourceRoot: root })
    expect(runs.map((run) => run.runId)).toEqual(['20261015-090001', '20261015-090000', '20200101-000000'])
    expect(runs[2]!.params).toBeNull()
    expect(runs[2]!.statusText).toBe('已完成')
    expect(runs[0]!.params).toMatchObject({ engine: 'fake' })
  })

  it('returns NOT_FOUND when there are no runs', async () => {
    const root = await makeRoot(['服装/EX1/g1.jpg', '模特/EX1/m1.jpg'])
    await expect(runStatusTool({ sourceRoot: root })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(runStatusTool({ sourceRoot: root, runId: '20261015-090000' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('spec guarantees', () => {
  it('never touches source files outside 成图/ and 裁图/', async () => {
    const root = await makeRoot(TWO_BY_TWO)
    const before = await hashTree(root, ['成图', '裁图'])
    await cropTool({ sourceRoot: root, plan: { EX1: [{ from: 'g1.jpg', role: '全身-正面' }] } })
    const run = await track(startRunTool({ sourceRoot: root, open: false }, config(10)))
    await waitDone(root, run.runId)
    expect(await hashTree(root, ['成图', '裁图'])).toEqual(before)
  })

  it('does not leak the apimart key anywhere', async () => {
    const port = await new Promise<number>((resolve) => {
      const server = createServer()
      server.listen(0, '127.0.0.1', () => {
        const address = server.address() as { port: number }
        server.close(() => resolve(address.port))
      })
    })
    const secret = 'sk-test-leak-0123456789'
    const root = await makeRoot(['服装/EX1/g1.jpg', '模特/EX1/m1.jpg'])
    const launch = config(10, {
      APIMART_API_KEY: secret,
      IMAGE_MODEL: 'fake',
      APIMART_BASE_URL: `http://127.0.0.1:${String(port)}`,
    })
    const run = await track(startRunTool({ sourceRoot: root, engine: 'apimart', open: false }, launch))
    const done = await waitDone(root, run.runId)
    expect(done.status).toBe('partial')
    const texts = [
      JSON.stringify(run),
      JSON.stringify(done),
      ...await Promise.all(['run.json', 'run-data.js', 'graph.html', 'run.log', 'report.html']
        .map((name) => readFile(path.join(run.runDir, name), 'utf8'))),
    ]
    for (const text of texts) expect(text).not.toContain(secret)
  })
})
