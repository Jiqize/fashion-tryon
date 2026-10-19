import { request as httpRequest, type IncomingMessage } from 'node:http'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { RunnerError } from '../../src/errors.js'
import type { EngineEvent } from '../../src/studio/engine.js'
import { startStudioServer, type StudioServer } from '../../src/studio/server.js'
import { FakeImageGeneration } from '../helpers/fake-image-generation.js'
import { FakeVision } from '../helpers/fake-vision.js'
import { cleanupSourceTrees, makeSourceTree } from './helpers.js'

const servers: StudioServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await cleanupSourceTrees()
})

async function start(root: string, images = new FakeImageGeneration(undefined, 5)): Promise<StudioServer> {
  const server = await startStudioServer({ sourceRoot: root, deps: { vision: new FakeVision(), images } })
  servers.push(server)
  return server
}

function tokenOf(server: StudioServer): string {
  return new URL(server.url).searchParams.get('token')!
}

function originOf(server: StudioServer): string {
  return new URL(server.url).origin
}

function api(server: StudioServer, pathname: string, token = tokenOf(server)): string {
  const url = new URL(pathname, originOf(server))
  url.searchParams.set('token', token)
  return url.toString()
}

async function post(server: StudioServer, pathname: string, body: unknown): Promise<Response> {
  return fetch(api(server, pathname), {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: originOf(server) },
    body: JSON.stringify(body),
  })
}

interface BatchViewLike {
  groups: Array<{ id: string; sku: string; status: string }>
  tasks: Array<{ id: string; groupId: string; versions: Array<{ id: string }> }>
}

async function batchView(server: StudioServer): Promise<BatchViewLike> {
  const response = await fetch(api(server, '/api/batch'))
  expect(response.status).toBe(200)
  return ((await response.json()) as { state: BatchViewLike }).state
}

/** 订阅 SSE，收集 change 事件。 */
function subscribe(server: StudioServer): Promise<{ events: EngineEvent[]; close(): void }> {
  return new Promise((resolve, reject) => {
    const events: EngineEvent[] = []
    const request = httpRequest(api(server, '/api/events'), (response: IncomingMessage) => {
      expect(response.statusCode).toBe(200)
      expect(String(response.headers['content-type'])).toContain('text/event-stream')
      let buffer = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        buffer += chunk
        let index = buffer.indexOf('\n\n')
        while (index >= 0) {
          const block = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          const data = block.split('\n').find((line) => line.startsWith('data: '))
          if (block.includes('event: change') && data !== undefined) {
            events.push(JSON.parse(data.slice('data: '.length)) as EngineEvent)
          }
          index = buffer.indexOf('\n\n')
        }
      })
      response.on('error', () => undefined)
      resolve({ events, close: () => request.destroy() })
    })
    request.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error)
    })
    request.end()
  })
}

async function waitAllReview(server: StudioServer): Promise<BatchViewLike> {
  let view: BatchViewLike | undefined
  await vi.waitFor(async () => {
    view = await batchView(server)
    expect(view.groups.every((group) => group.status === 'review')).toBe(true)
  }, { timeout: 10_000, interval: 50 })
  return view!
}

describe('studio server security', () => {
  it('requires the token and hides absolute paths and prompts', async () => {
    const root = await makeSourceTree({ EK52338: { garments: 1, models: 2 } })
    const server = await start(root)
    expect(new URL(server.url).hostname).toBe('127.0.0.1')

    const missing = await fetch(`${originOf(server)}/api/batch`)
    expect(missing.status).toBe(401)
    const wrong = await fetch(api(server, '/api/batch', 'x'.repeat(48)))
    expect(wrong.status).toBe(401)

    // 等后台准备写出 basePrompt，再确认它不出现在视图里
    let basePrompt: string | undefined
    await vi.waitFor(async () => {
      const raw = JSON.parse(await readFile(path.join(server.batchDir, 'studio.json'), 'utf8')) as {
        groups: Array<{ basePrompt?: string }>
      }
      basePrompt = raw.groups[0]?.basePrompt
      expect(basePrompt).toBeDefined()
    }, { timeout: 5_000, interval: 20 })

    const response = await fetch(api(server, '/api/batch'))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const text = await response.text()
    expect(text).not.toContain(path.dirname(root))
    expect(text).not.toContain(basePrompt!)
    expect(text).not.toContain('basePrompt')
    const view = (JSON.parse(text) as { state: BatchViewLike & { counts: unknown } }).state
    expect(view.groups[0]).toMatchObject({ sku: 'EK52338', status: 'idle' })
    expect(view.counts).toBeDefined()

    const page = await fetch(server.url)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
  })

  it('scrubs absolute paths from error messages in the batch view', async () => {
    const root = await makeSourceTree({ EK52338: { garments: 1, models: 1 } })
    // 服装定位失败的错误文案带出素材的绝对路径
    const vision = new FakeVision(() => {
      throw new Error(`ENOENT: no such file or directory, open '${path.join(root, 'EK52338', 'x.jpg')}'`)
    })
    const server = await startStudioServer({
      sourceRoot: root,
      deps: { vision, images: new FakeImageGeneration(undefined, 5) },
    })
    servers.push(server)

    let text = ''
    await vi.waitFor(async () => {
      text = await (await fetch(api(server, '/api/batch'))).text()
      expect(text).toContain('ENOENT')
    }, { timeout: 5_000, interval: 20 })
    expect(text).not.toContain(path.dirname(root))
  })

  it('rejects cross-origin, non-JSON and oversized POST bodies', async () => {
    const root = await makeSourceTree({ EK52338: { garments: 1, models: 1 } })
    const server = await start(root)

    const evil = await fetch(api(server, '/api/pause'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body: '{}',
    })
    expect(evil.status).toBe(403)

    const plain = await fetch(api(server, '/api/pause'), {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: originOf(server) },
      body: '{}',
    })
    expect(plain.status).toBe(415)

    const huge = await fetch(api(server, '/api/settings'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: originOf(server) },
      body: JSON.stringify({ padding: 'x'.repeat(2 * 1024 * 1024) }),
    })
    expect(huge.status).toBe(413)

    const unknown = await fetch(api(server, '/api/nope'))
    expect(unknown.status).toBe(404)

    const invalid = await post(server, '/api/settings', { concurrency: 11 })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' })
  })
})

describe('studio server preparation retry', () => {
  it('re-prepares an unstarted group whose preparation failed', async () => {
    const root = await makeSourceTree({ EK70001: { garments: 1, models: 3 } })
    // 第一次定位失败（准备失败），之后正常
    const vision = new FakeVision((_request, callIndex) => {
      if (callIndex === 0) throw new RunnerError('PROVIDER_ERROR', 'fake locate failure')
      return { bbox: [100, 100, 900, 900] }
    })
    const server = await startStudioServer({ sourceRoot: root, deps: { vision, images: new FakeImageGeneration(undefined, 5) } })
    servers.push(server)
    let group: BatchViewLike['groups'][number] | undefined
    await vi.waitFor(async () => {
      group = (await batchView(server)).groups[0]
      expect(group?.status).toBe('failed')
    }, { timeout: 10_000, interval: 20 })
    const route = `/api/groups/${group!.id}/prepare`

    // 与其它写接口一样校验同源
    const evil = await fetch(api(server, route), {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body: '{}',
    })
    expect(evil.status).toBe(403)

    const retried = await post(server, route, {})
    expect(retried.status).toBe(200)
    await vi.waitFor(async () => {
      const state = (await batchView(server)) as BatchViewLike & { assets: Array<{ role: string; preparedHash?: string }> }
      expect(state.groups[0]!.status).toBe('idle')
      expect(state.assets.every((asset) => asset.preparedHash !== undefined)).toBe(true)
    }, { timeout: 10_000, interval: 20 })
    expect(vision.locateGarmentCalls).toHaveLength(2)
    expect(vision.briefCalls).toHaveLength(1)

    // 没有准备失败的组不需要重新准备
    const again = await post(server, route, {})
    expect(again.status).toBe(400)
    expect(await again.json()).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' })
  })
})

describe('studio server flow', () => {
  it('generates through SSE, serves images by id and delivers a passed group', async () => {
    const root = await makeSourceTree({
      EK52338: { garments: 1, models: 2 },
      EK52339: { garments: 1, models: 2 },
    })
    const server = await start(root)
    const stream = await subscribe(server)
    await vi.waitFor(() => expect(stream.events[0]).toEqual({ type: 'batch' }))

    const started = await post(server, '/api/start', {})
    expect(started.status).toBe(200)
    const view = await waitAllReview(server)
    await vi.waitFor(() => {
      expect(stream.events.some((event) => event.type === 'task')).toBe(true)
      expect(stream.events.some((event) => event.type === 'group')).toBe(true)
    })
    stream.close()

    const versionId = view.tasks[0]!.versions[0]!.id
    const thumb = await fetch(api(server, `/files/version/${versionId}?variant=thumb`))
    expect(thumb.status).toBe(200)
    expect(thumb.headers.get('content-type')).toBe('image/jpeg')
    expect(thumb.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
    const bytes = new Uint8Array(await thumb.arrayBuffer())
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8])

    const traversal = await fetch(api(server, '/files/version/../../etc'))
    expect(traversal.status).toBe(404)
    const encoded = await fetch(api(server, '/files/version/..%2F..%2Fetc'))
    expect(encoded.status).toBe(404)

    const group = view.groups.find((candidate) => candidate.sku === 'EK52338')!
    const passed = await post(server, '/api/decisions', { op: 'pass', groupId: group.id })
    expect(passed.status).toBe(200)
    expect(await passed.json()).toMatchObject({ ok: true, message: 'EK52338 已交付 2 张' })
    expect((await readdir(path.join(root, '成图', 'EK52338'))).sort()).toEqual(['EK52338_01.png', 'EK52338_02.png'])

    const again = await post(server, '/api/decisions', { op: 'pass', groupId: group.id })
    expect(again.status).toBe(400)
    expect(await again.json()).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' })
  })

  it('reuses the same port and token after a restart', async () => {
    const root = await makeSourceTree({ EK52338: { garments: 1, models: 1 } })
    const first = await start(root)
    const url = first.url
    await first.close()
    servers.splice(servers.indexOf(first), 1)

    const second = await start(root)
    expect(second.url).toBe(url)
    expect((await fetch(api(second, '/api/batch'))).status).toBe(200)
  })
})
