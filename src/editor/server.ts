import { randomBytes } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import path from 'node:path'

import { z } from 'zod'

import { RunnerError, redactSecrets } from '../errors.js'
import { cancelRunTool, newRunTool, redoRunTool, rerunTool, type LaunchConfig } from '../mcp/tools.js'
import { groupPrefs, KEEP_FRAME_SENTENCE, updateCollection, type RedoItem } from '../simple/collection.js'
import { CROP_DIR, cropOne, listCrops } from '../simple/crop.js'
import { renderGraphPage } from '../simple/graph.js'
import { scanSimple } from '../simple/layout.js'
import { readActiveLock } from '../simple/lock.js'
import { readRunRecord, RUN_ID_PATTERN, runsDir, type RunRecord } from '../simple/record.js'
import { currentSettings, defaultPrompt } from '../simple/rerun.js'
import { placeUpload, UPLOAD_MAX_BYTES, validateNewSku } from '../simple/upload.js'
import { findUiDir } from '../ui-dir.js'
import { renderCollectionPage } from './collection-page.js'
import { collectionView } from './collection-view.js'
import {
  authorize,
  claimSession,
  HOST,
  HttpError,
  listen,
  parseBody,
  pathSegments,
  pingSession,
  readJsonBody,
  readSessionFile,
  releaseSession,
  send,
  sendError,
  sendHtml,
  sendJson,
  type ServiceSession,
} from './http.js'
import { restoreItem, trashItem } from '../simple/trash.js'
import { ensureHub } from './hub-launch.js'
import { hubPageUrl } from './hub-server.js'
import { displayName, findProjectByRoot } from './projects.js'
import { imageTag, settleThumbnails, thumbnail } from './thumbs.js'

// 节点图编辑服务：按素材根目录一个进程，只监听 127.0.0.1
// 页面在这里改参考图、提示词、换装范围后提交重出；重出与 MCP rerun 走同一个 rerunTool
// 合集页（/materials/）往素材根目录放图、新建款、保存合集设置与待重出并新建出图；新建出图、待重出与重出走同一条后台通路
// 给了 idleExitMs 时，闲置这么久没有请求就调用 onIdle；默认不自动退出，后台出图进程不受影响

const SESSION_FILE = '.editor.json'
const COOKIE = 'ft_editor'
const UPLOAD_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/octet-stream'])
const UI_FILES = new Set(['controls.js', 'editor.js', 'editor.css', 'editor-panel.js', 'collection.js', 'collection-drawer.js'])
const IMAGE_TYPES: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }

export interface EditorServerOptions {
  sourceRoot: string
  port?: number
  launch: LaunchConfig
  idleExitMs?: number
  onIdle?: () => void
}

export interface EditorServer {
  url: string
  origin: string
  token: string
  close(): Promise<void>
}

export type EditorSession = ServiceSession

export function editorSessionPath(sourceRoot: string): string {
  return path.join(runsDir(path.resolve(sourceRoot)), SESSION_FILE)
}

export async function readEditorSession(sourceRoot: string): Promise<EditorSession | undefined> {
  return readSessionFile(editorSessionPath(sourceRoot))
}

/** 会话指向的服务是否在运行：进程在且 /api/ping 回 ok。 */
export function pingEditor(session: EditorSession): Promise<boolean> {
  return pingSession(session)
}

export function editorPageUrl(origin: string, token: string, runId: string): string {
  return `${origin}/runs/${runId}/?token=${token}`
}

export function editorMaterialsUrl(origin: string, token: string): string {
  return `${origin}/materials/?token=${token}`
}

const promptBody = z.object({
  references: z.array(z.object({ file: z.string().min(1), role: z.string().min(1).optional() })),
  swap: z.enum(['outfit', 'top']),
  keepFrame: z.boolean().optional(),
})

const prefsBody = z.object({
  sku: z.string().min(1),
  pairing: z.enum(['fixedGarment', 'fixedModel', 'oneToOne']).optional(),
  keepFrame: z.boolean().optional(),
  halfModels: z.array(z.string().min(1)).optional(),
})

const orderBody = z.object({ order: z.array(z.string()).max(1000) })

const itemOrderBody = z.object({
  sku: z.string().min(1),
  kind: z.enum(['garment', 'model', 'crop']),
  order: z.array(z.string().min(1)).max(1000),
})

const trashBody = z.object({ sku: z.string().min(1), file: z.string().min(1) })
const restoreBody = z.object({ sku: z.string().min(1), id: z.string().min(1) })

const redoBody = z.object({
  action: z.enum(['add', 'remove', 'note']),
  delivered: z.string().min(1),
  note: z.string().optional(),
})

const redoRunBody = z.object({ engine: z.enum(['codex', 'apimart']).optional() })

const NOTE_MAX = 200
const POST_ROUTES = ['api/prompt', 'api/crop', 'api/rerun', 'api/sku', 'api/upload', 'api/new-run', 'api/collection/prefs', 'api/collection/order', 'api/collection/item-order', 'api/item/delete', 'api/item/restore', 'api/redo', 'api/redo/run']

const skuBody = z.object({ sku: z.string() })

const cropBody = z.object({
  sku: z.string().min(1),
  from: z.string().min(1),
  role: z.string(),
  box: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  replace: z.boolean().optional(),
})

/** 上传的原始字节：先看 content-length，超限直接拒绝；流式累计超限同样拒绝，不再继续收。 */
async function readUploadBody(request: IncomingMessage, response: ServerResponse): Promise<Buffer> {
  const tooLarge = (): HttpError => {
    // 不读完剩下的请求体：回完就关连接
    response.setHeader('connection', 'close')
    return new HttpError(413, '超过 50 MB')
  }
  if (Number(request.headers['content-length'] ?? 0) > UPLOAD_MAX_BYTES) throw tooLarge()
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    bytes += buffer.byteLength
    if (bytes > UPLOAD_MAX_BYTES) throw tooLarge()
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

export async function startEditorServer(options: EditorServerOptions): Promise<EditorServer> {
  const root = path.resolve(options.sourceRoot)
  const realRoot = await realpath(root)
  const token = randomBytes(24).toString('hex')
  const env = options.launch.env ?? process.env
  const engineDefault = env.FASHION_TRYON_FAKE_ENGINE !== undefined ? 'fake' as const : 'codex' as const
  const sessionPath = editorSessionPath(root)
  // 错误文案里不带出素材根目录的上级路径
  const hiddenPrefixes = [path.dirname(root), path.dirname(realRoot)]
    .filter((prefix) => prefix !== path.parse(prefix).root)
    .sort((left, right) => right.length - left.length)
  const scrub = (message: string): string => {
    let result = redactSecrets(message)
    for (const prefix of hiddenPrefixes) result = result.split(prefix).join('…')
    return result.slice(0, 500)
  }
  let origin = ''

  async function findRecord(runId: string): Promise<RunRecord> {
    if (!RUN_ID_PATTERN.test(runId)) throw new HttpError(404, 'Not found')
    return readRunRecord(path.join(runsDir(root), runId))
  }

  /** 素材根目录内的图片：服装原图、模特图、裁图/、成图/（不含 _runs/）。 */
  /** /source/ 与 /thumb/ 允许的图：素材里的服装图、模特图，以及 裁图/、成图/ 下的图（_runs 除外）。 */
  async function sourceImage(segments: string[]): Promise<{ real: string; type: string; tag: string }> {
    const relative = segments.join('/').normalize('NFC')
    const type = IMAGE_TYPES[path.extname(relative).toLocaleLowerCase('en-US')]
    if (type === undefined) throw new HttpError(404, 'Not found')
    const inOutputs = (segments[0] === CROP_DIR || segments[0] === '成图') && segments[1] !== '_runs' && segments.length >= 2
    const scanned = inOutputs ? [] : await scanSimple(root)
    const inInputs = scanned.some((group) =>
      [...group.garments, ...group.models].some((file) => file.relativePath === relative))
    if (!inOutputs && !inInputs) throw new HttpError(404, 'Not found')
    // 符号链接指到根目录外的不给
    const real = await realpath(path.join(root, ...segments)).catch(() => undefined)
    if (real === undefined || !real.startsWith(`${realRoot}${path.sep}`)) throw new HttpError(404, 'Not found')
    const info = await stat(real).catch(() => undefined)
    if (info === undefined || !info.isFile()) throw new HttpError(404, 'Not found')
    return { real, type, tag: imageTag(relative, info.size, info.mtimeMs) }
  }

  /** 图片带 ETag：浏览器可缓存，原图一改（大小或修改时间变了）就重新取。 */
  async function sendImage(request: IncomingMessage, response: ServerResponse, etag: string, type: string, load: () => Promise<Buffer>): Promise<void> {
    const headers = { 'cache-control': 'no-cache', etag: `"${etag}"` }
    if (request.headers['if-none-match'] === headers.etag) {
      response.writeHead(304, headers)
      response.end()
      return
    }
    send(response, 200, await load(), type, headers)
  }

  async function serveSource(request: IncomingMessage, response: ServerResponse, segments: string[]): Promise<void> {
    const image = await sourceImage(segments)
    await sendImage(request, response, image.tag, image.type, () => readFile(image.real))
  }

  /** 页面缩略图：长边 320 的 JPEG，生成一次后缓存。 */
  async function serveThumb(request: IncomingMessage, response: ServerResponse, segments: string[]): Promise<void> {
    const image = await sourceImage(segments)
    await sendImage(request, response, `t-${image.tag}`, 'image/jpeg', () => thumbnail(root, image.real, image.tag))
  }

  /** run 目录里页面要用的文件：run-data.js 与 ref/、out/ 下的图片。 */
  async function serveRunFile(response: ServerResponse, runId: string, rest: string[]): Promise<void> {
    const record = await findRecord(runId)
    const name = rest.join('/')
    if (name === 'run-data.js') {
      send(response, 200, await readFile(path.join(record.runDir, name)), 'text/javascript; charset=utf-8')
      return
    }
    const type = IMAGE_TYPES[path.extname(name).toLocaleLowerCase('en-US')]
    if (type === undefined || (rest[0] !== 'ref' && rest[0] !== 'out')) throw new HttpError(404, 'Not found')
    const bytes = await readFile(path.join(record.runDir, ...rest)).catch(() => undefined)
    if (bytes === undefined) throw new HttpError(404, 'Not found')
    send(response, 200, bytes, type)
  }

  async function editorView(runId: string): Promise<unknown> {
    const record = await findRecord(runId)
    const scanned = new Map((await scanSimple(root)).map((group) => [group.sku, group]))
    const active = await readActiveLock(root)
    return {
      runId: record.runId,
      derivedFrom: record.derivedFrom,
      activeRunId: active?.runId ?? null,
      maxReferences: record.params?.maxReferences ?? 6,
      engineDefault: env.FASHION_TRYON_FAKE_ENGINE !== undefined ? 'fake' : 'codex',
      groups: await Promise.all(record.groups.map(async (group) => {
        const files = scanned.get(group.sku)
        const inRun = new Set(group.shots.map((shot) => shot.model))
        return {
          sku: group.sku,
          ...(group.note === undefined ? {} : { note: group.note }),
          settings: currentSettings(record, group),
          ...(group.keepFrame === true ? { keepFrame: true } : {}),
          garments: files?.garments.map((file) => file.relativePath) ?? [],
          crops: (await listCrops(root, group.sku)).map((file) => `${CROP_DIR}/${group.sku}/${path.basename(file)}`),
          models: files?.models.map((file) => ({ file: file.relativePath, inRun: inRun.has(file.relativePath) })) ?? [],
        }
      })),
    }
  }

  async function savePrefs(input: z.infer<typeof prefsBody>): Promise<unknown> {
    const sku = input.sku.normalize('NFC')
    const group = (await scanSimple(root)).find((candidate) => candidate.sku === sku)
    if (group === undefined) throw new RunnerError('VALIDATION_ERROR', `找不到款号：${sku}`)
    const models = new Set(group.models.map((file) => file.relativePath))
    const halfModels = input.halfModels?.map((file) => file.normalize('NFC'))
    const missing = halfModels?.find((file) => !models.has(file))
    if (missing !== undefined) throw new RunnerError('VALIDATION_ERROR', `${sku} 没有这张模特图：${missing}`)
    const state = await updateCollection(root, (current) => {
      current.groups[sku] = {
        ...groupPrefs(current, sku),
        ...(input.pairing === undefined ? {} : { pairing: input.pairing }),
        ...(input.keepFrame === undefined ? {} : { keepFrame: input.keepFrame }),
        ...(halfModels === undefined ? {} : { halfModels }),
      }
    })
    return groupPrefs(state, sku)
  }

  /** 待重出清单：加入要求成图有出图记录；同一张不重复；备注最长 200 字。 */
  async function editRedo(input: z.infer<typeof redoBody>): Promise<RedoItem[]> {
    const delivered = input.delivered.normalize('NFC')
    if (input.note !== undefined && [...input.note].length > NOTE_MAX) {
      throw new RunnerError('VALIDATION_ERROR', `备注不能超过 ${String(NOTE_MAX)} 字`)
    }
    const note = input.note === undefined || input.note === '' ? undefined : input.note
    let added: RedoItem | undefined
    if (input.action === 'add') {
      const view = await collectionView(root, engineDefault)
      const found = view.groups.flatMap((group) => group.outputs.map((output) => ({ sku: group.sku, output })))
        .find((entry) => entry.output.file === delivered)
      if (found === undefined || found.output.runId === null || found.output.model === null) {
        throw new RunnerError('VALIDATION_ERROR', '这张成图没有出图记录，不能加入待重出')
      }
      added = {
        delivered,
        runId: found.output.runId,
        sku: found.sku,
        model: found.output.model,
        ...(found.output.item === null ? {} : { item: found.output.item }),
        ...(note === undefined ? {} : { note }),
      }
    }
    const state = await updateCollection(root, (current) => {
      if (input.action === 'add') {
        if (!current.redo.some((entry) => entry.delivered === delivered)) {
          // 同一组合（款号 + 衣服 + 模特）只重出一次：加入另一版本时替换旧的
          const same = (entry: RedoItem): boolean => entry.sku === added!.sku && entry.item === added!.item && entry.model === added!.model
          current.redo = [...current.redo.filter((entry) => !same(entry)), added!]
        }
      } else if (input.action === 'remove') {
        current.redo = current.redo.filter((entry) => entry.delivered !== delivered)
      } else {
        current.redo = current.redo.map((entry) => {
          if (entry.delivered !== delivered) return entry
          const { note: _old, ...rest } = entry
          return note === undefined ? rest : { ...rest, note }
        })
      }
    })
    return state.redo
  }

  async function handleGet(request: IncomingMessage, response: ServerResponse, segments: string[], url: URL): Promise<void> {
    const route = segments.join('/')
    if (route === '') {
      // 根地址一律到合集页；每次出图的节点图从合集页进入
      response.writeHead(302, { location: '/materials/', 'cache-control': 'no-store' })
      response.end()
      return
    }
    if (route === 'materials') {
      if (!url.pathname.endsWith('/')) {
        response.writeHead(302, { location: '/materials/', 'cache-control': 'no-store' })
        response.end()
        return
      }
      const html = renderCollectionPage()
      sendHtml(response, html)
      return
    }
    if (route === 'api/collection') {
      // 项目列表读不了（如文件损坏）时退回文件夹名，不影响合集页
      const project = await findProjectByRoot(env, root).catch(() => undefined)
      sendJson(response, 200, await collectionView(root, engineDefault, project === undefined ? path.basename(root) : displayName(project)))
      return
    }
    if (route === 'projects') {
      // 合集页顶栏「项目」：项目服务在跑就复用，否则拉起，再跳过去
      const hub = await ensureHub(options.launch)
      response.writeHead(302, { location: hubPageUrl(hub.origin, hub.token), 'cache-control': 'no-store' })
      response.end()
      return
    }
    if (segments.length === 2 && segments[0] === 'ui' && UI_FILES.has(segments[1]!)) {
      const uiDir = await findUiDir()
      const bytes = uiDir === undefined ? undefined : await readFile(path.join(uiDir, segments[1]!)).catch(() => undefined)
      if (bytes === undefined) throw new HttpError(404, 'Not found')
      send(response, 200, bytes, route.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8')
      return
    }
    if (route === 'api/ping') {
      sendJson(response, 200, { ok: true })
      return
    }
    if (segments.length === 4 && segments[0] === 'api' && segments[1] === 'runs' && segments[3] === 'editor') {
      sendJson(response, 200, await editorView(segments[2]!))
      return
    }
    if (segments[0] === 'source' && segments.length >= 2) {
      await serveSource(request, response, segments.slice(1))
      return
    }
    if (segments[0] === 'thumb' && segments.length >= 2) {
      await serveThumb(request, response, segments.slice(1))
      return
    }
    if (segments[0] === 'runs' && segments.length >= 2) {
      const runId = segments[1]!
      if (segments.length === 2) {
        // 页面里的相对地址要求目录形式
        if (!url.pathname.endsWith('/')) {
          response.writeHead(302, { location: `/runs/${runId}/`, 'cache-control': 'no-store' })
          response.end()
          return
        }
        const html = renderGraphPage(await findRecord(runId))
        sendHtml(response, html)
        return
      }
      await serveRunFile(response, runId, segments.slice(2))
      return
    }
    throw new HttpError(404, 'Not found')
  }

  async function handlePost(request: IncomingMessage, response: ServerResponse, segments: string[], url: URL): Promise<void> {
    const route = segments.join('/')
    const cancelRoute = segments.length === 4 && segments[0] === 'api' && segments[1] === 'runs' && segments[3] === 'cancel'
    if (!POST_ROUTES.includes(route) && !cancelRoute) {
      throw new HttpError(404, 'Not found')
    }
    if (request.headers.origin !== origin) throw new HttpError(403, 'Cross-origin request is not allowed')
    const requestType = String(request.headers['content-type'] ?? '').split(';', 1)[0]!.trim().toLocaleLowerCase('en-US')
    if (route === 'api/upload') {
      // 上传是原始字节，不受 1 MiB JSON 上限影响
      if (!UPLOAD_TYPES.has(requestType)) throw new HttpError(415, 'Upload must be an image')
      const kind = url.searchParams.get('kind')
      if (kind !== 'garment' && kind !== 'model') throw new RunnerError('VALIDATION_ERROR', '请求参数不对：kind')
      const bytes = await readUploadBody(request, response)
      const placed = await placeUpload(root, {
        sku: url.searchParams.get('sku') ?? '',
        kind,
        fileName: url.searchParams.get('name') ?? '',
        bytes,
      })
      sendJson(response, 200, placed)
      return
    }
    if (requestType !== 'application/json') throw new HttpError(415, 'Request body must use application/json')
    const body = await readJsonBody(request)

    if (cancelRoute) {
      const runId = segments[2]!
      if (!RUN_ID_PATTERN.test(runId)) throw new HttpError(404, 'Not found')
      sendJson(response, 200, await cancelRunTool({ sourceRoot: root, runId }))
      return
    }
    if (route === 'api/prompt') {
      const { references, swap, keepFrame } = parseBody(promptBody, body)
      const refs = references.map((ref) => ({ file: ref.file, ...(ref.role === undefined ? {} : { role: ref.role }) }))
      const prompt = defaultPrompt(refs, swap)
      sendJson(response, 200, { prompt: keepFrame === true ? `${prompt}\n${KEEP_FRAME_SENTENCE}` : prompt })
      return
    }
    if (route === 'api/collection/prefs') {
      sendJson(response, 200, { prefs: await savePrefs(parseBody(prefsBody, body)) })
      return
    }
    if (route === 'api/collection/order') {
      // 原样保存：不存在的款号在视图里忽略
      const { order } = parseBody(orderBody, body)
      const state = await updateCollection(root, (current) => { current.order = order })
      sendJson(response, 200, { order: state.order })
      return
    }
    if (route === 'api/collection/item-order') {
      // 原样保存：不存在的文件在视图里忽略
      const { sku, kind, order } = parseBody(itemOrderBody, body)
      const key = ({ garment: 'garments', model: 'models', crop: 'crops' } as const)[kind]
      const state = await updateCollection(root, (current) => {
        current.itemOrder[sku] = { ...current.itemOrder[sku], [key]: order.map((file) => file.normalize('NFC')) }
      })
      sendJson(response, 200, { order: state.itemOrder[sku]?.[key] ?? [] })
      return
    }
    if (route === 'api/item/delete') {
      const { sku, file } = parseBody(trashBody, body)
      sendJson(response, 200, await trashItem(root, sku, file))
      return
    }
    if (route === 'api/item/restore') {
      const { sku, id } = parseBody(restoreBody, body)
      sendJson(response, 200, await restoreItem(root, sku, id))
      return
    }
    if (route === 'api/redo') {
      sendJson(response, 200, { redo: await editRedo(parseBody(redoBody, body)) })
      return
    }
    if (route === 'api/redo/run') {
      const { engine } = parseBody(redoRunBody, body)
      const submitted = (await collectionView(root, engineDefault)).redo
      const items = submitted
        .map(({ runId, sku, model, item, note }) => ({ runId, sku, model, ...(item === undefined ? {} : { item }), ...(note === undefined ? {} : { note }) }))
      // 拉起失败时清单保留；成功后只移除本次提交的项，拉起期间新加入的留着
      const summary = await redoRunTool({ items, ...(engine === undefined ? {} : { engine }), sourceRoot: root, open: false }, { ...options.launch, openUrl: () => undefined })
      const done = new Set(submitted.map((entry) => entry.delivered))
      await updateCollection(root, (current) => { current.redo = current.redo.filter((entry) => !done.has(entry.delivered)) })
      sendJson(response, 200, { ...summary, url: editorPageUrl(origin, token, summary.runId) })
      return
    }
    if (route === 'api/crop') {
      const crop = parseBody(cropBody, body)
      const file = await cropOne(root, crop.sku, {
        from: crop.from,
        role: crop.role,
        ...(crop.box === undefined ? {} : { box: crop.box }),
      }, { replace: crop.replace === true })
      sendJson(response, 200, { file })
      return
    }
    if (route === 'api/sku') {
      // 只校验，不写文件：没放图的新款不进文件夹
      const sku = parseBody(skuBody, body).sku.trim().normalize('NFC')
      await validateNewSku(root, sku)
      sendJson(response, 200, { sku })
      return
    }
    // api/rerun 与 MCP rerun 同一入口，api/new-run 是页面新建出图；素材根目录以服务为准，不从请求里取
    const request_ = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
    const launch = route === 'api/new-run' ? newRunTool : rerunTool
    const summary = await launch({ ...request_, sourceRoot: root, open: false }, { ...options.launch, openUrl: () => undefined })
    sendJson(response, 200, { ...summary, url: editorPageUrl(origin, token, summary.runId) })
  }

  let idleTimer: NodeJS.Timeout | undefined
  const idleExitMs = options.idleExitMs
  let closing: Promise<void> | undefined
  const armIdle = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    if (closing !== undefined || idleExitMs === undefined) return
    idleTimer = setTimeout(() => {
      if (options.onIdle !== undefined) options.onIdle()
      else void close()
    }, idleExitMs)
  }

  // 还没处理完的请求：关闭时等它们收尾，免得关闭后还在往目录里写缩略图等文件
  const handling = new Set<Promise<void>>()

  const server = createServer((request, response) => {
    armIdle()
    const task = (async () => {
      const url = new URL(request.url ?? '/', origin || `http://${HOST}`)
      authorize(request, response, url, token, COOKIE)
      const segments = pathSegments(url)
      if (request.method === 'GET') await handleGet(request, response, segments, url)
      else if (request.method === 'POST') await handlePost(request, response, segments, url)
      else throw new HttpError(404, 'Not found')
    })().catch((error: unknown) => { sendError(response, error, scrub) })
    handling.add(task)
    void task.finally(() => handling.delete(task))
  })

  const port = await listen(server, options.port ?? 0)
  origin = `http://${HOST}:${String(port)}`
  try {
    await claimSession(sessionPath, { port, token, pid: process.pid }, '编辑服务')
  } catch (error) {
    server.close()
    throw error
  }
  armIdle()

  async function close(): Promise<void> {
    closing ??= (async () => {
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      const closed = new Promise<void>((resolve) => server.close(() => resolve()))
      server.closeAllConnections()
      await closed
      await Promise.allSettled([...handling])
      await settleThumbnails()
      await releaseSession(sessionPath)
    })()
    return closing
  }

  return { url: `${origin}/?token=${token}`, origin, token, close }
}
