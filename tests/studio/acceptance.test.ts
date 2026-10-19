import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { runCli } from '../../src/cli.js'
import { RunnerError } from '../../src/errors.js'
import type {
  GenerateRequest,
  GeneratedImage,
  GenerationCheckpoint,
  ImageGenerationPort,
  VisionPort,
} from '../../src/ports.js'
import { createEngine, type Engine, type EngineEvent } from '../../src/studio/engine.js'
import type { BatchState } from '../../src/studio/model.js'
import { mergeScan, scanSource } from '../../src/studio/scan.js'
import { startStudioServer, type StudioServer } from '../../src/studio/server.js'
import { batchDirFor, openBatch, type BatchStore } from '../../src/studio/store.js'
import { Gate } from '../helpers/fake-image-generation.js'
import { cleanupSourceTrees, makeJpeg, makeSourceTree } from './helpers.js'

// spec 第 7 节验收 2、3、7、8、9、10 与旧命令删除；1、4、5、6 由看板浏览器测试覆盖，11 见 tests/paid-e2e.test.ts
const servers: StudioServer[] = []
const engines: Engine[] = []
const stores: BatchStore[] = []
const children: ChildProcess[] = []

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await new Promise((resolve) => child.once('exit', resolve))
    }
  }
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await Promise.all(engines.splice(0).map((engine) => engine.stop()))
  await Promise.all(stores.splice(0).map((store) => store.close()))
  await cleanupSourceTrees()
})

class FakeVisionLite implements VisionPort {
  async locateGarment(): Promise<{ bbox: [number, number, number, number] }> {
    return { bbox: [100, 100, 900, 900] }
  }

  async brief(): Promise<{
    imageType: 'flat_lay'
    garments: Array<{ part: string; item: string }>
    suggestedPrompt: string
    uncertainty: string[]
  }> {
    return { imageType: 'flat_lay', garments: [{ part: '上装', item: '测试上衣' }], suggestedPrompt: '', uncertainty: [] }
  }
}

/** 确定性伪随机：同一 seed 每次得到同一序列。 */
function seeded(seed: number): () => number {
  let value = seed
  return () => {
    value = (value * 1_103_515_245 + 12_345) % 2_147_483_648
    return value / 2_147_483_648
  }
}

/**
 * 假服务商：可配置延迟、失败率与前 N 次提交限流。
 * 限流发生在受理前（不回调 task ID）；受理后回调唯一的 task ID，并记录并发峰值。
 * holdFrom：第 N 次（从 0 起）及之后的调用停在闸门处，直到测试打开 gate；
 * holdUntilActive：调用先停在闸门处，同时进行的调用达到 N 个时一起放行。
 */
class FakeProvider implements ImageGenerationPort {
  readonly submitted: string[] = []
  readonly resumed: string[] = []
  readonly gate = new Gate()
  rateLimitedCalls = 0
  active = 0
  maxActive = 0
  private calls = 0
  private readonly random: () => number

  constructor(
    private readonly options: {
      delayMs?: number
      failRate?: number
      rateLimited?: number
      seed?: number
      holdFrom?: number
      holdUntilActive?: number
    } = {},
  ) {
    this.random = seeded(options.seed ?? 7)
    if (options.holdFrom !== undefined || options.holdUntilActive !== undefined) this.gate.close()
  }

  async generate(
    _request: GenerateRequest,
    signal: AbortSignal,
    checkpoint?: GenerationCheckpoint,
  ): Promise<GeneratedImage> {
    const index = this.calls
    this.calls += 1
    this.active += 1
    this.maxActive = Math.max(this.maxActive, this.active)
    try {
      if (this.options.holdUntilActive !== undefined && this.active >= this.options.holdUntilActive) this.gate.open()
      if (index >= (this.options.holdFrom ?? 0)) await this.gate.wait(signal)
      await new Promise((resolve) => setTimeout(resolve, this.options.delayMs ?? 5))
      if (index < (this.options.rateLimited ?? 0)) {
        this.rateLimitedCalls += 1
        throw new RunnerError('PROVIDER_RATE_LIMIT', 'generation submit: HTTP 429', { retryable: true })
      }
      if (this.random() < (this.options.failRate ?? 0)) {
        throw new RunnerError('PROVIDER_RESPONSE', 'fake provider failure')
      }
      let providerRequestId = checkpoint?.providerRequestId
      if (providerRequestId === undefined) {
        providerRequestId = `fake-${String(this.submitted.length + 1)}`
        this.submitted.push(providerRequestId)
        await checkpoint?.onProviderRequestId?.(providerRequestId)
      } else {
        this.resumed.push(providerRequestId)
      }
      await new Promise((resolve) => setTimeout(resolve, this.options.delayMs ?? 5))
      if (signal.aborted) throw new RunnerError('ABORTED', 'aborted')
      return { bytes: await makeJpeg(), mediaType: 'image/jpeg', providerRequestId }
    } finally {
      this.active -= 1
    }
  }
}

interface ViewTask {
  id: string
  groupId: string
  status: string
  garmentAssetId: string
  modelAssetId: string
  excluded: boolean
  chosenVersionId?: string
  versions: Array<{ id: string; sha256: string }>
}

interface View {
  groups: Array<{ id: string; sku: string; status: string; incompleteReason?: string }>
  assets: Array<{ id: string; relativePath: string }>
  tasks: ViewTask[]
}

async function start(root: string, images: ImageGenerationPort): Promise<StudioServer> {
  const server = await startStudioServer({ sourceRoot: root, deps: { vision: new FakeVisionLite(), images } })
  servers.push(server)
  return server
}

function api(url: string, pathname: string): string {
  const base = new URL(url)
  const target = new URL(pathname, base.origin)
  target.searchParams.set('token', base.searchParams.get('token')!)
  return target.toString()
}

async function post(url: string, pathname: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(api(url, pathname), {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: new URL(url).origin },
    body: JSON.stringify(body),
  })
  const payload = (await response.json()) as Record<string, unknown>
  expect(response.status, JSON.stringify(payload)).toBe(200)
  return payload
}

async function view(url: string): Promise<View> {
  const response = await fetch(api(url, '/api/batch'))
  expect(response.status).toBe(200)
  return ((await response.json()) as { state: View }).state
}

async function waitView(url: string, predicate: (state: View) => boolean, timeout = 15_000): Promise<View> {
  let latest: View | undefined
  await vi.waitFor(async () => {
    latest = await view(url)
    expect(predicate(latest)).toBe(true)
  }, { timeout, interval: 20 })
  return latest!
}

function groupBySku(state: View, sku: string): View['groups'][number] {
  return state.groups.find((group) => group.sku === sku)!
}

function tasksOf(state: View, sku: string): ViewTask[] {
  const group = groupBySku(state, sku)
  return state.tasks.filter((task) => task.groupId === group.id)
}

function pathOf(state: View, assetId: string): string {
  return state.assets.find((asset) => asset.id === assetId)!.relativePath
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** 素材目录（不含 成图/）逐文件 sha256。 */
async function hashTree(root: string): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      const relative = path.relative(root, absolute)
      if (entry.isDirectory()) {
        if (relative === '成图') continue
        await walk(absolute)
      } else {
        result.set(relative, sha256(await readFile(absolute)))
      }
    }
  }
  await walk(root)
  return result
}

/** 成图/<sku>/ 下每个文件的 sha256。 */
async function deliveredHashes(root: string, sku: string): Promise<Map<string, string>> {
  const dir = path.join(root, '成图', sku)
  const result = new Map<string, string>()
  for (const name of (await readdir(dir)).sort()) result.set(name, sha256(await readFile(path.join(dir, name))))
  return result
}

async function readState(root: string): Promise<BatchState> {
  return JSON.parse(await readFile(path.join(batchDirFor(root), 'studio.json'), 'utf8')) as BatchState
}

describe('acceptance 2: pairing modes', () => {
  it('builds tasks per mode and isolates incomplete groups from the rest', async () => {
    const root = await makeSourceTree({
      M1_固定服装: { garments: 1, models: 3 },
      M2_一对一: { garments: 3, models: 3 },
      M3_固定模特: { garments: 3, models: 1 },
      M4_数量不符: { garments: 2, models: 3 },
      M5_缺模特: { garments: 1, models: 0 },
    })
    const server = await start(root, new FakeProvider())
    const initial = await view(server.url)
    for (const [sku, mode] of [['M2', 'pair'], ['M3', 'fixedModel'], ['M4', 'pair']] as const) {
      await post(server.url, `/api/groups/${groupBySku(initial, sku).id}/settings`, { mode })
    }

    const state = await view(server.url)
    const pairs = (sku: string) => tasksOf(state, sku).map((task) => [
      path.basename(pathOf(state, task.garmentAssetId)),
      path.basename(pathOf(state, task.modelAssetId)),
    ])
    expect(pairs('M1')).toEqual([['01.jpg', '01.jpg'], ['01.jpg', '02.jpg'], ['01.jpg', '03.jpg']])
    expect(pairs('M2')).toEqual([['01.jpg', '01.jpg'], ['02.jpg', '02.jpg'], ['03.jpg', '03.jpg']])
    expect(pairs('M3')).toEqual([['01.jpg', '01.jpg'], ['02.jpg', '01.jpg'], ['03.jpg', '01.jpg']])
    expect(tasksOf(state, 'M4')).toEqual([])
    expect(tasksOf(state, 'M5')).toEqual([])
    expect(groupBySku(state, 'M4')).toMatchObject({ status: 'incomplete' })
    expect(groupBySku(state, 'M4').incompleteReason).toContain('数量不一致')
    expect(groupBySku(state, 'M5')).toMatchObject({ status: 'incomplete', incompleteReason: '缺少模特图' })

    await post(server.url, '/api/start', {})
    const done = await waitView(server.url, (current) =>
      ['M1', 'M2', 'M3'].every((sku) => groupBySku(current, sku).status === 'review'))
    expect(done.tasks.filter((task) => task.status === 'done')).toHaveLength(9)
    expect(groupBySku(done, 'M4').status).toBe('incomplete')
  }, 30_000)
})

describe('acceptance 3: judge while generating', () => {
  it('delivers the first finished group while later groups are still generating', async () => {
    const root = await makeSourceTree({
      A01: { garments: 1, models: 3 },
      A02: { garments: 1, models: 3 },
      A03: { garments: 1, models: 3 },
      A04: { garments: 1, models: 3 },
    })
    // 按套优先：前 3 次调用就是 A01 的 3 张；之后的调用停在闸门处，其余套确定仍在生成
    const images = new FakeProvider({ holdFrom: 3 })
    const server = await start(root, images)
    await post(server.url, '/api/settings', { concurrency: 3 })
    await post(server.url, '/api/start', {})

    const ready = await waitView(server.url, (state) => groupBySku(state, 'A01').status === 'review')
    const others = ['A02', 'A03', 'A04'].map((sku) => groupBySku(ready, sku).status)
    expect(others.every((status) => status === 'generating' || status === 'queued')).toBe(true)

    const passed = await post(server.url, '/api/decisions', { op: 'pass', groupId: groupBySku(ready, 'A01').id })
    expect(passed).toMatchObject({ ok: true })
    expect([...(await deliveredHashes(root, 'A01')).keys()]).toHaveLength(3)
    const after = await view(server.url)
    expect(groupBySku(after, 'A01').status).toBe('delivered')
    expect(['A02', 'A03', 'A04'].every((sku) => groupBySku(after, sku).status !== 'review')).toBe(true)
    // 交付第 1 套不打断其余套的生成
    images.gate.open()
    await waitView(server.url, (state) => ['A02', 'A03', 'A04'].every((sku) => groupBySku(state, sku).status === 'review'))
  }, 30_000)
})

describe('acceptance 7: concurrency and rate limits', () => {
  it('never exceeds 10 running jobs, backs off on rate limits and never submits a job twice', async () => {
    const root = await makeSourceTree({
      R01: { garments: 1, models: 8 },
      R02: { garments: 1, models: 8 },
      R03: { garments: 1, models: 8 },
    })
    const store = await openBatch(root)
    stores.push(store)
    const scanned = await scanSource(root)
    await store.update((draft) => {
      draft.settings.concurrency = 10
      Object.assign(draft, mergeScan(draft, scanned))
    })
    // 调用先停住，凑齐 3 个同时进行再放行：并发峰值 >2 不依赖落盘速度
    const images = new FakeProvider({ delayMs: 15, rateLimited: 6, holdUntilActive: 3 })
    // 退避只推进虚拟时间
    const engine = createEngine(store, { vision: new FakeVisionLite(), images, sleep: async () => undefined, random: () => 0 })
    engines.push(engine)
    const notices: string[] = []
    engine.on('change', (event: EngineEvent) => {
      if (event.type === 'notice') notices.push(event.message)
    })

    await engine.start()
    await engine.idle()

    const state = store.state()
    expect(state.tasks).toHaveLength(24)
    expect(state.tasks.every((task) => task.status === 'done' && task.versions.length === 1)).toBe(true)
    expect(images.maxActive).toBeLessThanOrEqual(10)
    expect(images.maxActive).toBeGreaterThan(2)
    expect(images.rateLimitedCalls).toBe(6)
    expect(notices.some((message) => message.startsWith('服务商限流'))).toBe(true)
    // 每个作业只受理一次：受理 ID 不重复，且与版本数、计费次数一致
    expect(new Set(images.submitted).size).toBe(images.submitted.length)
    expect(images.submitted).toHaveLength(24)
    expect(images.resumed).toEqual([])
    expect(state.generationCallsUsed).toBe(24)
  }, 30_000)
})

describe('acceptance 8: crash recovery', () => {
  interface LogEntry { type: 'submit' | 'resume'; id: string }

  async function readLog(logPath: string): Promise<LogEntry[]> {
    const text = await readFile(logPath, 'utf8').catch(() => '')
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as LogEntry)
  }

  function launch(root: string, logPath: string, hangAfter: number): Promise<{ child: ChildProcess; url: string }> {
    const child = spawn(process.execPath, [
      '--import', 'tsx', path.resolve('tests/studio/studio-child.ts'), root, logPath, String(hangAfter),
    ], { cwd: path.resolve('.'), stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(child)
    return new Promise((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      child.stdout!.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
        const line = stdout.split('\n')[0]
        if (stdout.includes('\n') && line !== undefined) resolve({ child, url: (JSON.parse(line) as { url: string }).url })
      })
      child.once('exit', (code) => reject(new Error(`studio exited early (${String(code)}): ${stderr}`)))
    })
  }

  async function kill(child: ChildProcess): Promise<void> {
    const exited = new Promise((resolve) => child.once('exit', resolve))
    child.kill('SIGKILL')
    await exited
  }

  it('restarts a killed studio process without resubmitting or losing judgments', async () => {
    const root = await makeSourceTree({ C01: { garments: 1, models: 2 }, C02: { garments: 1, models: 2 } })
    const logPath = path.join(path.dirname(root), 'provider-log.jsonl')

    // 第一次：前 2 次提交（C01）正常完成，第 3 次（C02 第 1 张）受理后挂起
    const first = await launch(root, logPath, 2)
    await post(first.url, '/api/settings', { concurrency: 1 })
    await post(first.url, '/api/start', {})
    const ready = await waitView(first.url, (state) => groupBySku(state, 'C01').status === 'review')
    await vi.waitFor(async () => expect((await readLog(logPath)).length).toBe(3), { timeout: 15_000, interval: 20 })
    await post(first.url, '/api/decisions', { op: 'pass', groupId: groupBySku(ready, 'C01').id })
    const delivered = await deliveredHashes(root, 'C01')
    expect(delivered.size).toBe(2)

    await kill(first.child)
    const hanging = (await readLog(logPath))[2]!
    const crashed = await readState(root)
    const submitted = crashed.tasks.flatMap((task) => task.pending.filter((job) => job.submittedAt !== undefined))
    expect(submitted.map((job) => job.providerRequestId)).toEqual([hanging.id])

    // 重启：挂起的作业只续取结果，其余作业正常完成
    const second = await launch(root, logPath, -1)
    expect(second.url).toBe(first.url)
    const finished = await waitView(second.url, (state) => state.tasks.every((task) => task.status === 'done'))
    const log = await readLog(logPath)
    expect(log.filter((entry) => entry.type === 'resume').map((entry) => entry.id)).toEqual([hanging.id])
    const submits = log.filter((entry) => entry.type === 'submit').map((entry) => entry.id)
    expect(submits).toHaveLength(4)
    expect(new Set(submits).size).toBe(4)
    expect(groupBySku(finished, 'C01').status).toBe('delivered')
    expect(groupBySku(finished, 'C02').status).toBe('review')
    expect(finished.tasks.every((task) => task.versions.length === 1)).toBe(true)
    expect(await deliveredHashes(root, 'C01')).toEqual(delivered)
    expect((await readState(root)).generationCallsUsed).toBe(4)
  }, 60_000)
})

describe('acceptance 9: delivery', () => {
  it('delivers only chosen, non-excluded versions and never overwrites existing files', async () => {
    const root = await makeSourceTree({ D01: { garments: 1, models: 2 }, D02: { garments: 1, models: 2 } })
    const server = await start(root, new FakeProvider())
    await post(server.url, '/api/settings', { candidates: 2 })
    await post(server.url, '/api/start', {})
    const ready = await waitView(server.url, (state) => state.groups.every((group) => group.status === 'review'))
    const d01 = groupBySku(ready, 'D01').id
    const d02 = groupBySku(ready, 'D02').id
    const chosenHash = (task: ViewTask) => task.versions.find((version) => version.id === task.chosenVersionId)!.sha256
    const otherVersion = (task: ViewTask) => task.versions.find((version) => version.id !== task.chosenVersionId)!
    const [d01First, d01Second] = tasksOf(ready, 'D01') as [ViewTask, ViewTask]
    const [d02First, d02Second] = tasksOf(ready, 'D02') as [ViewTask, ViewTask]
    expect(ready.tasks.every((task) => task.versions.length === 2)).toBe(true)

    await post(server.url, '/api/decisions', { op: 'pass', groupId: d01 })
    const firstDelivery = await deliveredHashes(root, 'D01')
    expect([...firstDelivery.values()].sort()).toEqual([chosenHash(d01First), chosenHash(d01Second)].sort())

    // 再次交付同样内容：不重复写入
    await post(server.url, '/api/decisions', { op: 'withdraw', groupId: d01 })
    await post(server.url, '/api/decisions', { op: 'pass', groupId: d01 })
    expect(await deliveredHashes(root, 'D01')).toEqual(firstDelivery)

    // 换版本后再交付：已有文件不覆盖，新版本加后缀写出
    await post(server.url, '/api/decisions', { op: 'withdraw', groupId: d01 })
    await post(server.url, '/api/decisions', { op: 'choose', taskId: d01First.id, versionId: otherVersion(d01First).id })
    await post(server.url, '/api/decisions', { op: 'pass', groupId: d01 })
    const secondDelivery = await deliveredHashes(root, 'D01')
    expect(secondDelivery.size).toBe(3)
    for (const [name, hash] of firstDelivery) expect(secondDelivery.get(name)).toBe(hash)
    expect([...secondDelivery.values()]).toContain(otherVersion(d01First).sha256)
    expect([...secondDelivery.values()]).not.toContain(otherVersion(d01Second).sha256)

    // 不交付的任务与未采用的版本都不进入 成图/
    await post(server.url, '/api/decisions', { op: 'exclude', taskId: d02First.id, excluded: true })
    await post(server.url, '/api/decisions', { op: 'pass', groupId: d02 })
    const d02Delivery = [...(await deliveredHashes(root, 'D02')).values()]
    expect(d02Delivery).toEqual([chosenHash(d02Second)])
    for (const version of [...d02First.versions, otherVersion(d02Second)]) {
      expect(d02Delivery).not.toContain(version.sha256)
    }
  }, 30_000)
})

describe('acceptance 10: read-only input', () => {
  it('leaves every source file outside 成图/ byte-identical through a full batch', async () => {
    const root = await makeSourceTree({
      E01: { garments: 1, models: 3 },
      E02: { garments: 2, models: 2 },
      E03: { garments: 2, models: 1 },
    })
    const before = await hashTree(root)
    const server = await start(root, new FakeProvider({ failRate: 0.3, seed: 11 }))
    const initial = await view(server.url)
    await post(server.url, `/api/groups/${groupBySku(initial, 'E02').id}/settings`, { mode: 'pair' })
    await post(server.url, `/api/groups/${groupBySku(initial, 'E03').id}/settings`, { mode: 'fixedModel' })
    await post(server.url, '/api/start', {})

    // 失败率 30%：失败的任务重试到全部完成
    let state = await waitView(server.url, (current) =>
      current.tasks.every((task) => task.status === 'done' || task.status === 'failed'))
    for (let round = 0; round < 10 && state.tasks.some((task) => task.status === 'failed'); round += 1) {
      await post(server.url, '/api/retry', {})
      state = await waitView(server.url, (current) =>
        current.tasks.every((task) => task.status === 'done' || task.status === 'failed'))
    }
    expect(state.tasks.every((task) => task.status === 'done')).toBe(true)

    const regenTask = tasksOf(state, 'E01')[0]!
    await post(server.url, '/api/decisions', { op: 'regenerate', taskId: regenTask.id, tags: ['color'] })
    state = await waitView(server.url, (current) =>
      current.tasks.find((task) => task.id === regenTask.id)!.versions.length >= 2 &&
      current.groups.every((group) => group.status === 'review'))
    for (const group of state.groups) {
      await post(server.url, '/api/decisions', { op: 'pass', groupId: group.id })
    }
    expect((await readdir(path.join(root, '成图'))).sort()).toEqual(expect.arrayContaining(['E01', 'E02', 'E03']))
    expect((await stat(batchDirFor(root))).isDirectory()).toBe(true)
    expect(path.dirname(batchDirFor(root))).toBe(path.dirname(root))
    expect(await hashTree(root)).toEqual(before)
  }, 60_000)
})

describe('legacy pipeline removal', () => {
  it('rejects the old preflight command and exposes only studio, run, rerun, editor, hub, open, crop, mcp and status', async () => {
    let stdout = ''
    let stderr = ''
    const io = { stdout: (text: string) => { stdout += text }, stderr: (text: string) => { stderr += text } }
    const code = await runCli(['preflight', '/tmp/any', '--json'], io)
    expect(code).toBe(1)
    expect(`${stdout}${stderr}`).toMatch(/unknown command 'preflight'/)

    stdout = ''
    expect(await runCli(['--help'], io)).toBe(0)
    const commands = stdout.split('Commands:')[1]!.split('\n')
      .map((line) => line.trim().split(/\s+/)[0])
      .filter((name): name is string => name !== undefined && name !== '')
    expect(commands).toEqual(['studio', 'run', 'rerun', 'editor', 'hub', 'open', 'crop', 'mcp', 'status', 'help'])
  })
})
