import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import path from 'node:path'

import { z } from 'zod'

import { RunnerError, redactSecrets } from '../errors.js'
import type { LaunchConfig } from '../mcp/launch.js'
import { findUiDir } from '../ui-dir.js'
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
import { configDir } from './last-root.js'
import { ensureEditor } from './launch.js'
import { projectCard, sortCards, type ProjectCard } from './project-stats.js'
import {
  addProject,
  listProjects,
  projectId,
  removeProject,
  renameProject,
  restoreProject,
  type ProjectEntry,
} from './projects.js'
import { renderProjectsPage } from './projects-page.js'
import { editorMaterialsUrl } from './server.js'
import { imageTag, settleThumbnails, thumbnail } from './thumbs.js'

// 项目服务：全局一个进程，只监听 127.0.0.1；列出本机项目列表里的素材根目录，点进去由 ensureEditor 拉起该目录的编辑服务
// 不重命名、移动、删除任何文件夹或文件；除封面缩略图缓存（成图/_runs/.thumbs/）外不写素材目录

const COOKIE = 'ft_hub'
const UI_FILES = new Set(['controls.js', 'editor.css', 'projects.js'])
const POST_ROUTES = new Set(['api/projects/pick', 'api/projects/open', 'api/projects/rename', 'api/projects/remove', 'api/projects/restore', 'api/projects/reveal'])

export interface HubServerOptions {
  port?: number
  launch: LaunchConfig
  /** 弹系统选文件夹窗口；取消返回 null。测试注入 */
  pickFolder?: () => Promise<string | null>
  /** 在 Finder 里打开。测试注入 */
  revealFolder?: (root: string) => void
}

export interface HubServer {
  url: string
  origin: string
  token: string
  close(): Promise<void>
}

export function hubSessionPath(env: NodeJS.ProcessEnv): string {
  return path.join(configDir(env), 'hub.json')
}

export function readHubSession(env: NodeJS.ProcessEnv): Promise<ServiceSession | undefined> {
  return readSessionFile(hubSessionPath(env))
}

export function pingHub(session: ServiceSession): Promise<boolean> {
  return pingSession(session)
}

export function hubPageUrl(origin: string, token: string): string {
  return `${origin}/?token=${token}`
}

/** macOS 选文件夹窗口（窗口里可新建文件夹）；取消（-128）返回 null。 */
function defaultPickFolder(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', 'POSIX path of (choose folder with prompt "选择素材文件夹")'], (error, stdout, stderr) => {
      if (error === null) {
        resolve(stdout.trim())
        return
      }
      if (String(stderr).includes('-128')) resolve(null)
      else reject(new RunnerError('IO_ERROR', `打不开选文件夹窗口：${String(stderr).trim() || error.message}`))
    })
  })
}

function defaultRevealFolder(root: string): void {
  try {
    const child = spawn('open', [root], { detached: true, stdio: 'ignore' })
    child.on('error', () => undefined)
    child.unref()
  } catch {
    // 打不开 Finder 不影响服务
  }
}

const idBody = z.object({ id: z.string().min(1) })
const renameBody = z.object({ id: z.string().min(1), name: z.string() })
const restoreBody = z.object({
  entry: z.object({ id: z.string(), root: z.string(), name: z.string().optional(), addedAt: z.string() }),
})

async function isDirectory(dir: string): Promise<boolean> {
  return stat(dir).then((info) => info.isDirectory(), () => false)
}

export async function startHubServer(options: HubServerOptions): Promise<HubServer> {
  const env = options.launch.env ?? process.env
  const token = randomBytes(24).toString('hex')
  const sessionPath = hubSessionPath(env)
  const pickFolder = options.pickFolder ?? defaultPickFolder
  const revealFolder = options.revealFolder ?? defaultRevealFolder
  const scrub = (message: string): string => redactSecrets(message).slice(0, 500)
  let origin = ''

  async function findEntry(id: string): Promise<ProjectEntry> {
    const entry = (await listProjects(env)).find((item) => item.id === id)
    if (entry === undefined) throw new RunnerError('VALIDATION_ERROR', '找不到这个项目')
    return entry
  }

  async function existingEntry(id: string): Promise<ProjectEntry> {
    const entry = await findEntry(id)
    if (!(await isDirectory(entry.root))) throw new RunnerError('VALIDATION_ERROR', `找不到文件夹：${entry.root}`)
    return entry
  }

  async function materialsUrl(root: string): Promise<string> {
    const editor = await ensureEditor(root, options.launch)
    return editorMaterialsUrl(editor.origin, editor.token)
  }

  async function cards(): Promise<ProjectCard[]> {
    return sortCards(await Promise.all((await listProjects(env)).map((entry) => projectCard(entry))))
  }

  async function serveCover(request: IncomingMessage, response: ServerResponse, id: string): Promise<void> {
    const entry = await findEntry(id).catch(() => undefined)
    const card = entry === undefined ? undefined : await projectCard(entry)
    if (entry === undefined || card === undefined || card.missing || card.cover === null) throw new HttpError(404, 'Not found')
    // 符号链接指到根目录外的不给
    const realRoot = await realpath(entry.root)
    const real = await realpath(path.join(entry.root, ...card.cover.split('/'))).catch(() => undefined)
    if (real === undefined || !real.startsWith(`${realRoot}${path.sep}`)) throw new HttpError(404, 'Not found')
    const info = await stat(real)
    const tag = imageTag(card.cover, info.size, info.mtimeMs)
    const headers = { 'cache-control': 'no-cache', etag: `"c-${tag}"` }
    if (request.headers['if-none-match'] === headers.etag) {
      response.writeHead(304, headers)
      response.end()
      return
    }
    send(response, 200, await thumbnail(entry.root, real, tag), 'image/jpeg', headers)
  }

  async function handleGet(request: IncomingMessage, response: ServerResponse, segments: string[]): Promise<void> {
    const route = segments.join('/')
    if (route === '') {
      sendHtml(response, renderProjectsPage())
      return
    }
    if (route === 'api/ping') {
      sendJson(response, 200, { ok: true })
      return
    }
    if (route === 'api/projects') {
      sendJson(response, 200, { projects: await cards() })
      return
    }
    if (segments.length === 2 && segments[0] === 'cover') {
      await serveCover(request, response, segments[1]!)
      return
    }
    if (segments.length === 2 && segments[0] === 'ui' && UI_FILES.has(segments[1]!)) {
      const uiDir = await findUiDir()
      const bytes = uiDir === undefined ? undefined : await readFile(path.join(uiDir, segments[1]!)).catch(() => undefined)
      if (bytes === undefined) throw new HttpError(404, 'Not found')
      send(response, 200, bytes, route.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8')
      return
    }
    throw new HttpError(404, 'Not found')
  }

  async function handlePost(request: IncomingMessage, response: ServerResponse, segments: string[]): Promise<void> {
    const route = segments.join('/')
    if (!POST_ROUTES.has(route)) throw new HttpError(404, 'Not found')
    if (request.headers.origin !== origin) throw new HttpError(403, 'Cross-origin request is not allowed')
    const requestType = String(request.headers['content-type'] ?? '').split(';', 1)[0]!.trim().toLocaleLowerCase('en-US')
    if (requestType !== 'application/json') throw new HttpError(415, 'Request body must use application/json')
    const body = await readJsonBody(request)

    if (route === 'api/projects/pick') {
      const picked = await pickFolder()
      if (picked === null) {
        sendJson(response, 200, { cancelled: true })
        return
      }
      const root = path.resolve(picked)
      if (root === path.parse(root).root || root === path.resolve(homedir())) {
        throw new RunnerError('VALIDATION_ERROR', '请选一个具体的素材文件夹')
      }
      if (!(await isDirectory(root))) throw new RunnerError('VALIDATION_ERROR', `不是文件夹：${root}`)
      const { entry, added } = await addProject(env, root)
      sendJson(response, 200, { id: entry.id, added, url: await materialsUrl(entry.root) })
      return
    }
    if (route === 'api/projects/open') {
      const entry = await existingEntry(parseBody(idBody, body).id)
      sendJson(response, 200, { url: await materialsUrl(entry.root) })
      return
    }
    if (route === 'api/projects/rename') {
      const { id, name } = parseBody(renameBody, body)
      sendJson(response, 200, { project: await projectCard(await renameProject(env, id, name)) })
      return
    }
    if (route === 'api/projects/remove') {
      sendJson(response, 200, { removed: await removeProject(env, parseBody(idBody, body).id) })
      return
    }
    if (route === 'api/projects/restore') {
      const { entry } = parseBody(restoreBody, body)
      // 只放回自己移除的那条：路径必须是绝对路径且 id 对得上
      if (!path.isAbsolute(entry.root) || projectId(path.resolve(entry.root)) !== entry.id) {
        throw new RunnerError('VALIDATION_ERROR', '请求参数不对：entry')
      }
      const { name, ...rest } = entry
      const restored = await restoreProject(env, { ...rest, root: path.resolve(entry.root), ...(name === undefined ? {} : { name }) })
      sendJson(response, 200, { project: await projectCard(restored) })
      return
    }
    // api/projects/reveal
    const entry = await existingEntry(parseBody(idBody, body).id)
    revealFolder(entry.root)
    sendJson(response, 200, { ok: true })
  }

  // 还没处理完的请求：关闭时等它们收尾
  const handling = new Set<Promise<void>>()

  const server = createServer((request, response) => {
    const task = (async () => {
      const url = new URL(request.url ?? '/', origin || `http://${HOST}`)
      authorize(request, response, url, token, COOKIE)
      const segments = pathSegments(url)
      if (request.method === 'GET') await handleGet(request, response, segments)
      else if (request.method === 'POST') await handlePost(request, response, segments)
      else throw new HttpError(404, 'Not found')
    })().catch((error: unknown) => { sendError(response, error, scrub) })
    handling.add(task)
    void task.finally(() => handling.delete(task))
  })

  const port = await listen(server, options.port ?? 0)
  origin = `http://${HOST}:${String(port)}`
  try {
    await claimSession(sessionPath, { port, token, pid: process.pid }, '项目服务')
  } catch (error) {
    server.close()
    throw error
  }

  let closing: Promise<void> | undefined
  async function close(): Promise<void> {
    closing ??= (async () => {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()))
      server.closeAllConnections()
      await closed
      await Promise.allSettled([...handling])
      await settleThumbnails()
      await releaseSession(sessionPath)
    })()
    return closing
  }

  return { url: hubPageUrl(origin, token), origin, token, close }
}
