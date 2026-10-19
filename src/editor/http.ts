import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, link, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import path from 'node:path'

import { z } from 'zod'

import { RunnerError } from '../errors.js'
import { isProcessAlive } from '../simple/lock.js'

// 编辑服务与项目服务共用的本机 HTTP 规则：只监听 127.0.0.1、token 换 Cookie、CSP、会话文件

export const HOST = '127.0.0.1'
const MAX_BODY_BYTES = 1024 * 1024

export interface ServiceSession {
  port: number
  token: string
  pid: number
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

export function parseBody<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new RunnerError('VALIDATION_ERROR', `请求参数不对：${issue?.path.join('.') || 'body'} ${issue?.message ?? ''}`.trim())
  }
  return parsed.data
}

export function sameToken(given: string | undefined | null, expected: string): boolean {
  if (given === undefined || given === null) return false
  const left = Buffer.from(given)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

export function cookieToken(request: IncomingMessage, cookie: string): string | undefined {
  for (const part of String(request.headers.cookie ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === cookie) return rest.join('=')
  }
  return undefined
}

/** query token 或 Cookie 二选一；query 对了就换成 HttpOnly Cookie。 */
export function authorize(request: IncomingMessage, response: ServerResponse, url: URL, token: string, cookie: string): void {
  const viaQuery = sameToken(url.searchParams.get('token'), token)
  if (!viaQuery && !sameToken(cookieToken(request, cookie), token)) throw new HttpError(401, 'Unauthorized')
  if (viaQuery) response.setHeader('set-cookie', `${cookie}=${token}; HttpOnly; SameSite=Strict; Path=/`)
}

/** 路径片段：解码失败或含路径字符的一律视为不存在。 */
export function pathSegments(url: URL): string[] {
  let segments: string[]
  try {
    segments = url.pathname.split('/').filter((segment) => segment !== '').map(decodeURIComponent)
  } catch {
    throw new HttpError(404, 'Not found')
  }
  if (segments.some((segment) => segment === '.' || segment === '..' || /[\\/]/.test(segment))) {
    throw new HttpError(404, 'Not found')
  }
  return segments
}

/** 页面里的内联脚本与样式按 sha256 放行，其余只许同源。 */
export function cspFor(html: string): string {
  const hashes = (tag: string): string[] =>
    [...html.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))]
      .map((match) => `'sha256-${createHash('sha256').update(match[1]!).digest('base64')}'`)
  return [
    "default-src 'none'",
    "img-src 'self' data:",
    `style-src 'self' ${hashes('style').join(' ')}`.trim(),
    `script-src 'self' ${hashes('script').join(' ')}`.trim(),
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ')
}

export function send(response: ServerResponse, status: number, body: Buffer | string, contentType: string, extra: Record<string, string> = {}): void {
  const bytes = typeof body === 'string' ? Buffer.from(body) : body
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': bytes.byteLength,
    'content-type': contentType,
    'x-content-type-options': 'nosniff',
    ...extra,
  })
  response.end(bytes)
}

export function sendJson(response: ServerResponse, status: number, value: unknown): void {
  send(response, status, `${JSON.stringify(value)}\n`, 'application/json; charset=utf-8')
}

export function sendHtml(response: ServerResponse, html: string): void {
  send(response, 200, html, 'text/html; charset=utf-8', { 'content-security-policy': cspFor(html) })
}

/** 出错时的统一响应：HttpError 原样状态码，RunnerError 按错误码，其余 500。 */
export function sendError(response: ServerResponse, error: unknown, scrub: (message: string) => string): void {
  if (response.headersSent) {
    response.end()
    return
  }
  if (error instanceof HttpError) {
    sendJson(response, error.status, { error: { code: 'HTTP_ERROR', message: error.message } })
    return
  }
  if (error instanceof RunnerError) {
    sendJson(response, statusOf(error), { error: { code: error.code, message: scrub(error.message) } })
    return
  }
  sendJson(response, 500, { error: { code: 'IO_ERROR', message: scrub(error instanceof Error ? error.message : String(error)) } })
}

export async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    bytes += buffer.byteLength
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

export function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, HOST, () => {
      server.removeListener('error', reject)
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : port)
    })
  })
}

export function statusOf(error: RunnerError): number {
  if (error.code === 'CROP_EXISTS' || error.code === 'RUN_IN_PROGRESS') return 409
  if (error.code === 'NOT_FOUND') return 404
  return 400
}

export async function readSessionFile(sessionPath: string): Promise<ServiceSession | undefined> {
  try {
    const raw = JSON.parse(await readFile(sessionPath, 'utf8')) as Partial<ServiceSession>
    if (typeof raw.port !== 'number' || typeof raw.token !== 'string' || typeof raw.pid !== 'number') return undefined
    return { port: raw.port, token: raw.token, pid: raw.pid }
  } catch {
    return undefined
  }
}

/** 会话指向的服务是否在运行：进程在且 /api/ping 回 ok。 */
export async function pingSession(session: ServiceSession): Promise<boolean> {
  if (!isProcessAlive(session.pid)) return false
  try {
    const response = await fetch(`http://${HOST}:${String(session.port)}/api/ping?token=${session.token}`, { signal: AbortSignal.timeout(1000) })
    return response.ok && ((await response.json()) as { ok?: boolean }).ok === true
  } catch {
    return false
  }
}

/** 原子占用会话文件：已有存活的服务时报错；旧会话指向的服务已不在则接手。label 用于报错文案。 */
export async function claimSession(sessionPath: string, session: ServiceSession, label: string): Promise<void> {
  await mkdir(path.dirname(sessionPath), { recursive: true })
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // 先写完整的临时文件再 link 到位：别的进程看到会话文件时内容一定完整
    const temporary = `${sessionPath}.tmp-${String(process.pid)}-${randomBytes(4).toString('hex')}`
    await writeFile(temporary, `${JSON.stringify(session)}\n`, { mode: 0o600 })
    // umask 可能去掉位，这里补一次
    await chmod(temporary, 0o600)
    try {
      await link(temporary, sessionPath)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    } finally {
      await rm(temporary, { force: true })
    }
    const existing = await readSessionFile(sessionPath)
    if (existing !== undefined && await pingSession(existing)) {
      throw new RunnerError('IO_ERROR', `${label}已在运行：http://${HOST}:${String(existing.port)}`)
    }
    await rm(sessionPath, { force: true })
  }
  throw new RunnerError('IO_ERROR', `${label}会话文件被占用`)
}

/** 关闭时只删自己的会话文件：另一个服务可能已经接手。 */
export async function releaseSession(sessionPath: string): Promise<void> {
  const current = await readFile(sessionPath, 'utf8').then((text) => JSON.parse(text) as { pid?: number }, () => undefined)
  if (current?.pid === process.pid) await rm(sessionPath, { force: true })
}
