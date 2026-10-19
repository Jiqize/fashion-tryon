import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { z } from 'zod'

import { MAX_CONCURRENCY } from '../config.js'
import { scopes } from '../contracts.js'
import { RunnerError } from '../errors.js'
import type { ImageGenerationPort, VisionPort } from '../ports.js'
import { createDecisions, type DecisionOp, type DecisionResult } from './decisions.js'
import { createEngine, type Engine, type EngineEvent } from './engine.js'
import {
  batchCounts,
  cropBoxSchema,
  groupStatus,
  pairingModes,
  regenTags,
  type BatchCounts,
  type BatchState,
  type GroupStatus,
} from './model.js'
import { setCropOverride } from './prepare.js'
import { sourceRootOf } from './publish.js'
import { mergeScan, scanSource } from './scan.js'
import { findUiDir } from '../ui-dir.js'
import { openBatch, type BatchStore } from './store.js'

const HOST = '127.0.0.1'
const MAX_BODY_BYTES = 1024 * 1024
const SESSION_FILE = '.studio-session.json'
// 退出时等待运行中作业的上限
const DRAIN_TIMEOUT_MS = 30_000
const HEARTBEAT_MS = 15_000
const IMMUTABLE = 'private, max-age=31536000, immutable'
const CSP = [
  "default-src 'none'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ')

export interface StudioServerOptions {
  sourceRoot: string
  port?: number
  deps: { vision: VisionPort; images: ImageGenerationPort }
  /** 单次生图单价（元），只随视图下发供页面显示预计费用。 */
  imagePriceCny?: number
}

export interface StudioServer {
  url: string
  batchDir: string
  close(): Promise<void>
}

/** 页面视图中的组：附状态与计数，不含服装描述里的提示词与组 prompt。 */
export interface GroupView extends Omit<BatchState['groups'][number], 'basePrompt' | 'brief'> {
  status: GroupStatus
  counts: { tasks: number; done: number; running: number; queued: number; failed: number; excluded: number }
  garments?: Array<{ part: string; item: string }>
}

export interface BatchView extends Omit<BatchState, 'sourceRoot' | 'groups' | 'tasks'> {
  /** 素材根目录名（不含上级路径） */
  name: string
  groups: GroupView[]
  tasks: Array<Omit<BatchState['tasks'][number], 'versions' | 'pending'> & {
    versions: Array<Omit<BatchState['tasks'][number]['versions'][number], 'prompt'>>
    pending: Array<Omit<BatchState['tasks'][number]['pending'][number], 'prompt'>>
  }>
  counts: BatchCounts
  paused: boolean
  imagePriceCny?: number
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

const settingsBody = z.object({
  mode: z.enum(pairingModes).optional(),
  scope: z.enum(scopes).optional(),
  candidates: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
  concurrency: z.number().int().min(1).max(MAX_CONCURRENCY).optional(),
}).strict()

const groupSettingsBody = z.object({
  mode: z.enum(pairingModes).optional(),
  scope: z.enum(scopes).optional(),
}).strict()

const cropBody = z.object({ assetId: z.string().min(1), box: cropBoxSchema.nullable() }).strict()
const startBody = z.object({ groupIds: z.array(z.string().min(1)).optional() }).strict()
const retryBody = z.object({ taskIds: z.array(z.string().min(1)).optional() }).strict()
const emptyBody = z.object({}).strict()

const decisionBody: z.ZodType<DecisionOp> = z.discriminatedUnion('op', [
  z.object({ op: z.literal('pass'), groupId: z.string().min(1) }).strict(),
  z.object({ op: z.literal('exclude'), taskId: z.string().min(1), excluded: z.boolean() }).strict(),
  z.object({ op: z.literal('choose'), taskId: z.string().min(1), versionId: z.string().min(1) }).strict(),
  z.object({
    op: z.literal('regenerate'),
    taskId: z.string().min(1),
    tags: z.array(z.enum(regenTags)),
    note: z.string().optional(),
  }).strict(),
  z.object({ op: z.literal('withdraw'), groupId: z.string().min(1) }).strict(),
]) as z.ZodType<DecisionOp>

function parseBody<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value ?? {})
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
      .join('; ')
    throw new RunnerError('VALIDATION_ERROR', `请求参数不正确：${detail}`)
  }
  return parsed.data
}

interface Session {
  port: number
  token: string
}

async function readSession(batchDir: string): Promise<Session | undefined> {
  try {
    const raw = JSON.parse(await readFile(path.join(batchDir, SESSION_FILE), 'utf8')) as Partial<Session>
    const { port, token } = raw
    if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port >= 65_536) return undefined
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,}$/.test(token)) return undefined
    return { port, token }
  } catch {
    return undefined
  }
}

async function writeSession(batchDir: string, session: Session): Promise<void> {
  const file = path.join(batchDir, SESSION_FILE)
  await writeFile(file, `${JSON.stringify(session)}\n`, { mode: 0o600 })
  // 已存在的文件 writeFile 不改权限，这里补一次
  await chmod(file, 0o600)
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.removeListener('error', onError)
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, HOST)
  })
}

function sameToken(given: string | null, expected: string): boolean {
  if (given === null) return false
  const left = Buffer.from(given)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  })
  response.end(body)
}

function sendBytes(
  response: ServerResponse,
  bytes: Buffer,
  contentType: string,
  cacheControl = 'no-store',
): void {
  response.writeHead(200, {
    'cache-control': cacheControl,
    'content-length': bytes.byteLength,
    'content-type': contentType,
    'x-content-type-options': 'nosniff',
    ...(contentType.startsWith('text/html') ? { 'content-security-policy': CSP } : {}),
  })
  response.end(bytes)
}

function mediaTypeOf(filePath: string): string {
  const extension = path.extname(filePath).toLocaleLowerCase('en-US')
  if (extension === '.png') return 'image/png'
  if (extension === '.webp') return 'image/webp'
  return 'image/jpeg'
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const declared = Number(request.headers['content-length'])
  const chunks: Buffer[] = []
  let bytes = Number.isFinite(declared) && declared > MAX_BODY_BYTES ? declared : 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    bytes += buffer.byteLength
    // 超限后只排空不再保存
    if (bytes <= MAX_BODY_BYTES) chunks.push(buffer)
  }
  if (bytes > MAX_BODY_BYTES) throw new HttpError(413, 'Request body exceeds 1 MiB')
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new RunnerError('VALIDATION_ERROR', '请求体不是合法 JSON')
  }
}

function findTaskPrompt(state: BatchState, taskId: string): string {
  const task = state.tasks.find((candidate) => candidate.id === taskId)
  if (task === undefined) throw new RunnerError('NOT_FOUND', `找不到这张图：${taskId}`)
  const group = state.groups.find((candidate) => candidate.id === task.groupId)
  // 已出图：采用版本的 prompt；未出图：待派发首轮作业上的 prompt，其次组的 basePrompt
  const chosen = task.versions.find((version) => version.id === task.chosenVersionId)?.prompt
  const prompt = chosen
    ?? task.pending.find((job) => job.kind === 'first' && job.prompt !== undefined)?.prompt
    ?? group?.basePrompt
  if (prompt === undefined) throw new RunnerError('NOT_FOUND', '提示词还在生成中，稍后再试')
  return prompt
}

/** 组装页面视图：去掉 prompt 全文与素材根路径，附组状态与计数；错误文案经 scrub 去掉绝对路径。 */
function toView(
  state: BatchState,
  name: string,
  paused: boolean,
  imagePriceCny: number | undefined,
  scrub: (message: string) => string,
): BatchView {
  const { sourceRoot: _sourceRoot, groups, tasks, ...rest } = state
  return {
    ...rest,
    name,
    groups: groups.map((group) => {
      const { basePrompt: _basePrompt, brief, ...visible } = group
      const own = tasks.filter((task) => task.groupId === group.id)
      return {
        ...visible,
        ...(visible.error === undefined ? {} : { error: { ...visible.error, message: scrub(visible.error.message) } }),
        status: groupStatus(state, group.id),
        counts: {
          tasks: own.length,
          done: own.filter((task) => task.status === 'done').length,
          running: own.filter((task) => task.status === 'running').length,
          queued: own.filter((task) => task.status === 'queued').length,
          failed: own.filter((task) => task.status === 'failed' && !task.excluded).length,
          excluded: own.filter((task) => task.excluded).length,
        },
        ...(brief === undefined ? {} : { garments: brief.garments }),
      }
    }),
    tasks: tasks.map((task) => ({
      ...task,
      ...(task.error === undefined ? {} : { error: { ...task.error, message: scrub(task.error.message) } }),
      versions: task.versions.map(({ prompt: _prompt, ...version }) => version),
      pending: task.pending.map(({ prompt: _prompt, ...job }) => job),
    })),
    counts: batchCounts(state),
    paused,
    ...(imagePriceCny === undefined ? {} : { imagePriceCny }),
  }
}

/**
 * 修改尚未开始的组的搭配模式或换装范围：丢掉这些组的首轮任务与提示词，
 * 由随后的 mergeScan 按新模式重建任务、后台准备重新生成提示词。
 */
function resetIdleGroups(draft: BatchState, groupIds: ReadonlySet<string>): void {
  for (const group of draft.groups) {
    if (!groupIds.has(group.id)) continue
    delete group.brief
    delete group.basePrompt
    delete group.error
  }
  draft.tasks = draft.tasks.filter((task) => !groupIds.has(task.groupId) || task.versions.length > 0)
}

function isIdleGroup(group: BatchState['groups'][number]): boolean {
  return !group.started && group.delivered === undefined
}

async function initialize(store: BatchStore, sourceRoot: string): Promise<void> {
  const scanned = await scanSource(sourceRoot)
  await store.update((draft) => {
    Object.assign(draft, mergeScan(draft, scanned))
  })
}

/**
 * 启动本地看板服务：打开批次（加锁）→ 扫描合并 → 创建引擎（恢复未完成作业）→ 监听 127.0.0.1。
 */
export async function startStudioServer(options: StudioServerOptions): Promise<StudioServer> {
  const sourceRoot = path.resolve(options.sourceRoot)
  const info = await stat(sourceRoot).catch(() => undefined)
  if (info === undefined || !info.isDirectory()) {
    throw new RunnerError('NOT_FOUND', `素材根目录不存在：${sourceRoot}`)
  }
  const store = await openBatch(sourceRoot)
  let engine: Engine | undefined
  try {
    await initialize(store, sourceRoot)
    engine = createEngine(store, { vision: options.deps.vision, images: options.deps.images })
    return await serve(store, engine, sourceRoot, options)
  } catch (error) {
    await engine?.stop().catch(() => undefined)
    await store.close().catch(() => undefined)
    throw error
  }
}

async function serve(
  store: BatchStore,
  engine: Engine,
  sourceRoot: string,
  options: StudioServerOptions,
): Promise<StudioServer> {
  const decisions = createDecisions(store, engine)
  const batchName = path.basename(sourceRoot)
  // 素材根目录的上级路径（含 realpath 形式，如 macOS 的 /private/var）不出现在页面与事件里
  const realRoot = await realpath(sourceRoot).catch(() => sourceRoot)
  const hiddenPrefixes = [...new Set([path.dirname(sourceRoot), path.dirname(realRoot)])]
    .filter((prefix) => prefix !== path.parse(prefix).root)
    .sort((left, right) => right.length - left.length)
  const uiDir = await findUiDir()
  const clients = new Set<ServerResponse>()
  let paused = false
  let origin = ''

  const saved = await readSession(store.dir)
  const token = saved?.token ?? randomBytes(24).toString('hex')

  function broadcast(event: EngineEvent): void {
    const safe = event.type === 'notice' ? { ...event, message: scrub(event.message) } : event
    const frame = `event: change\ndata: ${JSON.stringify(safe)}\n\n`
    for (const client of clients) client.write(frame)
  }
  const unsubscribe = engine.on('change', broadcast)

  /** 服务端自己改动状态后通知页面（引擎事件之外）。 */
  function changed(groupIds: Iterable<string> = []): void {
    for (const groupId of groupIds) broadcast({ type: 'group', groupId })
    broadcast({ type: 'batch' })
  }

  function backgroundPrepare(): void {
    void engine.prepareAll().catch(() => undefined)
  }

  // 错误文案里不带出素材根目录的上级路径
  function scrub(message: string): string {
    let result = message
    for (const prefix of hiddenPrefixes) result = result.split(prefix).join('…')
    return result.slice(0, 500)
  }

  async function rescan(): Promise<void> {
    const scanned = await scanSource(sourceRoot)
    await store.update((draft) => {
      Object.assign(draft, mergeScan(draft, scanned))
    })
    changed()
    backgroundPrepare()
  }

  async function applySettings(body: z.infer<typeof settingsBody>): Promise<void> {
    if (body.mode !== undefined || body.scope !== undefined || body.candidates !== undefined) {
      const scanned = body.mode !== undefined || body.scope !== undefined ? await scanSource(sourceRoot) : undefined
      const touched = new Set<string>()
      await store.update((draft) => {
        const previous = { mode: draft.settings.mode, scope: draft.settings.scope }
        for (const group of draft.groups) {
          if (isIdleGroup(group)) {
            // 未开始且没有单独覆盖的组跟随新的整批设置
            if ((body.mode !== undefined && group.mode === undefined && body.mode !== previous.mode) ||
              (body.scope !== undefined && group.scope === undefined && body.scope !== previous.scope)) {
              touched.add(group.id)
            }
          } else {
            // 已开始的组固定为原设置，不受整批改动影响
            group.mode ??= previous.mode
            group.scope ??= previous.scope
          }
        }
        if (body.mode !== undefined) draft.settings.mode = body.mode
        if (body.scope !== undefined) draft.settings.scope = body.scope
        if (body.candidates !== undefined) draft.settings.candidates = body.candidates
        if (touched.size > 0 && scanned !== undefined) {
          resetIdleGroups(draft, touched)
          Object.assign(draft, mergeScan(draft, scanned))
        }
      })
      changed(touched)
      if (touched.size > 0) backgroundPrepare()
    }
    // 并发即时生效，由引擎写回设置
    if (body.concurrency !== undefined) engine.setConcurrency(body.concurrency)
  }

  async function applyGroupSettings(groupId: string, body: z.infer<typeof groupSettingsBody>): Promise<void> {
    const group = store.state().groups.find((candidate) => candidate.id === groupId)
    if (group === undefined) throw new RunnerError('NOT_FOUND', `找不到这套：${groupId}`)
    if (!isIdleGroup(group)) throw new RunnerError('VALIDATION_ERROR', '这套已开始生成，不能再改设置')
    const scanned = await scanSource(sourceRoot)
    await store.update((draft) => {
      const target = draft.groups.find((candidate) => candidate.id === groupId)!
      if (body.mode !== undefined) target.mode = body.mode
      if (body.scope !== undefined) target.scope = body.scope
      resetIdleGroups(draft, new Set([groupId]))
      Object.assign(draft, mergeScan(draft, scanned))
    })
    changed([groupId])
    backgroundPrepare()
  }

  /** 准备失败的组：清除错误后在后台重新准备（裁切、服装描述、首轮 prompt），结果经 SSE 刷新。 */
  async function retryPrepare(groupId: string): Promise<void> {
    await store.update((draft) => {
      const group = draft.groups.find((candidate) => candidate.id === groupId)
      if (group === undefined) throw new RunnerError('NOT_FOUND', `找不到这套：${groupId}`)
      if (group.error === undefined) throw new RunnerError('VALIDATION_ERROR', `${group.sku} 没有准备失败，不需要重新准备`)
      delete group.error
    })
    changed([groupId])
    backgroundPrepare()
  }

  function decisionResponse(response: ServerResponse, result: DecisionResult): void {
    changed()
    if (result.ok) sendJson(response, 200, result)
    else sendJson(response, 400, { ok: false, code: result.code, message: scrub(result.message) })
  }

  async function serveAsset(response: ServerResponse, assetId: string, variant: string): Promise<void> {
    const asset = store.state().assets.find((candidate) => candidate.id === assetId)
    if (asset === undefined) throw new HttpError(404, 'Not found')
    const sourcePath = path.resolve(sourceRoot, asset.relativePath)
    if (variant === 'source') {
      sendBytes(response, await readFile(sourcePath), asset.mediaType, IMMUTABLE)
      return
    }
    // 裁后副本会随手动裁切变化，不做长缓存
    if (variant === 'prepared') {
      if (asset.preparedRelativePath === undefined) throw new HttpError(404, 'Not found')
      const preparedPath = store.resolve(asset.preparedRelativePath)
      sendBytes(response, await readFile(preparedPath), mediaTypeOf(preparedPath), 'private, no-cache')
      return
    }
    if (variant === 'thumb') {
      const relative = asset.preparedRelativePath ?? path.relative(store.dir, sourcePath).split(path.sep).join('/')
      const thumb = await store.thumbnail(relative, 480)
      sendBytes(response, await readFile(store.resolve(thumb)), 'image/jpeg', 'private, no-cache')
      return
    }
    throw new HttpError(404, 'Not found')
  }

  async function serveVersion(response: ServerResponse, versionId: string, variant: string): Promise<void> {
    const version = store.state().tasks
      .flatMap((task) => task.versions)
      .find((candidate) => candidate.id === versionId)
    if (version === undefined) throw new HttpError(404, 'Not found')
    if (variant === 'full') {
      sendBytes(response, await readFile(store.resolve(version.relativePath)), version.mediaType, IMMUTABLE)
      return
    }
    if (variant === 'thumb') {
      const thumb = await store.thumbnail(version.relativePath, 480)
      sendBytes(response, await readFile(store.resolve(thumb)), 'image/jpeg', IMMUTABLE)
      return
    }
    throw new HttpError(404, 'Not found')
  }

  async function serveUi(response: ServerResponse, name: string): Promise<void> {
    if (uiDir === undefined) throw new HttpError(404, 'Not found')
    const filePath = path.join(uiDir, name)
    const bytes = await readFile(filePath).catch(() => undefined)
    if (bytes === undefined) throw new HttpError(404, 'Not found')
    const type = name.endsWith('.html')
      ? 'text/html; charset=utf-8'
      : name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8'
    sendBytes(response, bytes, type)
  }

  function openEvents(request: IncomingMessage, response: ServerResponse): void {
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'text/event-stream; charset=utf-8',
      connection: 'keep-alive',
      'x-content-type-options': 'nosniff',
    })
    clients.add(response)
    // 连接建立时先发一次整批刷新
    response.write(`event: change\ndata: ${JSON.stringify({ type: 'batch' })}\n\n`)
    request.on('close', () => clients.delete(response))
  }

  async function handlePost(
    request: IncomingMessage,
    response: ServerResponse,
    segments: string[],
  ): Promise<boolean> {
    const route = segments.join('/')
    const known = ['api/settings', 'api/start', 'api/pause', 'api/resume', 'api/retry', 'api/rescan', 'api/decisions', 'api/undo']
    const groupRoute = segments.length === 4 && segments[0] === 'api' && segments[1] === 'groups' &&
      (segments[3] === 'settings' || segments[3] === 'crop' || segments[3] === 'prepare')
    if (!known.includes(route) && !groupRoute) return false
    if (request.headers.origin !== origin) throw new HttpError(403, 'Cross-origin request is not allowed')
    const requestType = String(request.headers['content-type'] ?? '').split(';', 1)[0]!.trim().toLocaleLowerCase('en-US')
    if (requestType !== 'application/json') throw new HttpError(415, 'Request body must use application/json')
    const body = await readJsonBody(request)

    if (groupRoute) {
      const groupId = segments[2]!
      if (segments[3] === 'settings') {
        await applyGroupSettings(groupId, parseBody(groupSettingsBody, body))
      } else if (segments[3] === 'prepare') {
        parseBody(emptyBody, body)
        await retryPrepare(groupId)
      } else {
        const crop = parseBody(cropBody, body)
        await setCropOverride(store, crop.assetId, crop.box)
        changed([groupId])
        backgroundPrepare()
      }
      sendJson(response, 200, { ok: true })
      return true
    }

    switch (route) {
      case 'api/settings':
        await applySettings(parseBody(settingsBody, body))
        break
      case 'api/start': {
        const { groupIds } = parseBody(startBody, body)
        await engine.start(groupIds)
        break
      }
      case 'api/pause':
        parseBody(emptyBody, body)
        paused = true
        // 不等运行中的作业结束，立即返回
        void engine.pause().catch(() => undefined)
        break
      case 'api/resume':
        parseBody(emptyBody, body)
        paused = false
        engine.resume()
        break
      case 'api/retry': {
        const { taskIds } = parseBody(retryBody, body)
        await engine.retryFailed(taskIds)
        break
      }
      case 'api/rescan':
        parseBody(emptyBody, body)
        await rescan()
        break
      case 'api/decisions':
        decisionResponse(response, await decisions.apply(parseBody(decisionBody, body)))
        return true
      case 'api/undo':
        parseBody(emptyBody, body)
        decisionResponse(response, await decisions.undo())
        return true
    }
    sendJson(response, 200, { ok: true })
    return true
  }

  async function handleGet(
    request: IncomingMessage,
    response: ServerResponse,
    segments: string[],
    url: URL,
  ): Promise<boolean> {
    const route = segments.join('/')
    if (route === '') {
      await serveUi(response, 'index.html')
      return true
    }
    if (route === 'ui/app.js' || route === 'ui/app.css') {
      await serveUi(response, segments[1]!)
      return true
    }
    if (route === 'api/batch') {
      sendJson(response, 200, { state: toView(store.state(), batchName, paused, options.imagePriceCny, scrub) })
      return true
    }
    if (route === 'api/events') {
      openEvents(request, response)
      return true
    }
    if (segments.length === 3 && segments[0] === 'api' && segments[1] === 'prompt') {
      sendJson(response, 200, { prompt: findTaskPrompt(store.state(), segments[2]!) })
      return true
    }
    if (segments.length === 3 && segments[0] === 'files' && segments[1] === 'asset') {
      await serveAsset(response, segments[2]!, url.searchParams.get('variant') ?? 'thumb')
      return true
    }
    if (segments.length === 3 && segments[0] === 'files' && segments[1] === 'version') {
      await serveVersion(response, segments[2]!, url.searchParams.get('variant') ?? 'thumb')
      return true
    }
    return false
  }

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', origin || `http://${HOST}`)
      if (!sameToken(url.searchParams.get('token'), token)) throw new HttpError(401, 'Unauthorized')
      let segments: string[]
      try {
        segments = url.pathname.split('/').filter((segment) => segment !== '').map(decodeURIComponent)
      } catch {
        throw new HttpError(404, 'Not found')
      }
      // ID 只按值查找；含路径字符的片段一律视为不存在
      if (segments.some((segment) => segment === '.' || segment === '..' || /[\\/]/.test(segment))) {
        throw new HttpError(404, 'Not found')
      }
      const handled = request.method === 'GET'
        ? await handleGet(request, response, segments, url)
        : request.method === 'POST'
          ? await handlePost(request, response, segments)
          : false
      if (!handled) throw new HttpError(404, 'Not found')
    })().catch((error: unknown) => {
      if (response.headersSent) {
        response.end()
        return
      }
      if (error instanceof HttpError) {
        sendJson(response, error.status, { ok: false, code: 'HTTP_ERROR', message: error.message })
        return
      }
      if (error instanceof RunnerError) {
        sendJson(response, 400, { ok: false, code: error.code, message: scrub(error.message) })
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      sendJson(response, 500, { ok: false, code: 'IO_ERROR', message: scrub(message) })
    })
  })

  // 端口：显式指定 > 上次会话的端口 > 随机；上次的端口被占用时退回随机端口
  let port: number
  try {
    port = await listen(server, options.port ?? saved?.port ?? 0)
  } catch (error) {
    if (options.port !== undefined || saved === undefined || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
      unsubscribe()
      throw error
    }
    port = await listen(server, 0)
  }
  origin = `http://${HOST}:${String(port)}`
  await writeSession(store.dir, { port, token })

  const heartbeat = setInterval(() => {
    for (const client of clients) client.write(': ping\n\n')
  }, HEARTBEAT_MS)
  heartbeat.unref()

  let closing: Promise<void> | undefined
  return {
    url: `${origin}/?token=${token}`,
    batchDir: store.dir,
    close() {
      closing ??= (async () => {
        clearInterval(heartbeat)
        unsubscribe()
        for (const client of clients) client.end()
        clients.clear()
        const closed = new Promise<void>((resolve) => server.close(() => resolve()))
        server.closeAllConnections()
        await closed
        // 停止派发，等运行中的作业最多 30 秒，再中止剩余作业
        let timer: ReturnType<typeof setTimeout> | undefined
        await Promise.race([
          engine.pause().catch(() => undefined),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, DRAIN_TIMEOUT_MS)
          }),
        ])
        if (timer !== undefined) clearTimeout(timer)
        await engine.stop()
        await store.close()
      })()
      return closing
    },
  }
}
