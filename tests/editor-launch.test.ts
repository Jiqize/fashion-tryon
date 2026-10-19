import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { runCli, type CliIo } from '../src/cli.js'
import { ensureEditor } from '../src/editor/launch.js'
import { editorSessionPath, readEditorSession } from '../src/editor/server.js'
import { openGraphTool, startRunTool, type LaunchConfig } from '../src/mcp/tools.js'
import { readRunRecord } from '../src/simple/record.js'
import { fixtureImageBytes } from './helpers/image-bytes.js'

const roots: string[] = []
const pids: number[] = []

afterEach(async () => {
  for (const root of roots) {
    const session = await readEditorSession(root)
    if (session !== undefined) pids.push(session.pid)
  }
  for (const pid of pids.splice(0)) {
    try { process.kill(pid, 'SIGKILL') } catch { /* 已退出 */ }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function config(): LaunchConfig {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('APIMART_') || key === 'IMAGE_MODEL') delete env[key]
  }
  return {
    cliCommand: [process.execPath, '--import', 'tsx', path.resolve('src/cli.ts')],
    env: { ...env, FASHION_TRYON_FAKE_ENGINE: JSON.stringify({ delayMs: 100 }) },
  }
}

async function sourceRoot(withRun = true): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'editor-launch-'))
  roots.push(root)
  for (const [index, file] of ['服装/EX1/g1.jpg', '模特/EX1/m1.jpg'].entries()) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await writeFile(path.join(root, file), await fixtureImageBytes(index + 1))
  }
  if (withRun) {
    const io: CliIo = { stdout: () => undefined, stderr: () => undefined }
    await runCli(['run', root, '--json', '--no-open', '--engine', 'fake', '--run-id', '20261015-090000'], io, { env: { FASHION_TRYON_FAKE_ENGINE: '{}' } })
  }
  return root
}

describe('ensureEditor', () => {
  it('starts the service once and reuses it', async () => {
    const root = await sourceRoot()
    const first = await ensureEditor(root, config())
    const session = await readEditorSession(root)
    expect(first.origin).toBe(`http://127.0.0.1:${String(session!.port)}`)
    expect(session!.pid).not.toBe(process.pid)
    const second = await ensureEditor(root, config())
    expect(second).toEqual(first)
    expect((await readEditorSession(root))!.pid).toBe(session!.pid)
  })

  it('restarts when the session points to a dead process', async () => {
    const root = await sourceRoot()
    await mkdir(path.dirname(editorSessionPath(root)), { recursive: true })
    await writeFile(editorSessionPath(root), JSON.stringify({ port: 1, token: 'x'.repeat(48), pid: 999_999 }))
    const started = await ensureEditor(root, config())
    const session = await readEditorSession(root)
    expect(session!.pid).not.toBe(999_999)
    expect(started.token).toBe(session!.token)
  })

  it('keeps a single service when started concurrently', async () => {
    const root = await sourceRoot()
    const [left, right] = await Promise.all([ensureEditor(root, config()), ensureEditor(root, config())])
    expect(left).toEqual(right)
  })
})

describe('open_graph and start_run', () => {
  it('returns an editable page url that loads', async () => {
    const root = await sourceRoot()
    const opened: string[] = []
    const result = await openGraphTool({ sourceRoot: root, runId: '20261015-090000' }, { ...config(), openUrl: (url) => opened.push(url) })
    expect(result.runId).toBe('20261015-090000')
    expect(result.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/runs\/20261015-090000\/\?token=[0-9a-f]{48}$/)
    expect(opened).toEqual([result.url])
    expect((await fetch(result.url)).status).toBe(200)
    expect((await openGraphTool({ sourceRoot: root, runId: '20261015-090000', open: false }, { ...config(), openUrl: (url) => opened.push(url) })).url).toBe(result.url)
    expect(opened).toHaveLength(1)
    // 不带 runId：有 run 也打开合集页
    const home = await openGraphTool({ sourceRoot: root, open: false }, config())
    expect(home.runId).toBeNull()
    expect(new URL(home.url).pathname).toBe('/materials/')
  })

  it('opens the materials page when the root has no runs', async () => {
    const root = await sourceRoot(false)
    const opened: string[] = []
    const result = await openGraphTool({ sourceRoot: root }, { ...config(), openUrl: (url) => opened.push(url) })
    expect(result.runId).toBeNull()
    expect(result.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/materials\/\?token=[0-9a-f]{48}$/)
    expect(opened).toEqual([result.url])
    expect((await fetch(result.url)).status).toBe(200)
  })

  it('opens the editable page after start_run, falling back to graph.html', async () => {
    const root = await sourceRoot(false)
    const opened: string[] = []
    const run = await startRunTool({ sourceRoot: root }, { ...config(), openUrl: (url) => opened.push(url) })
    pids.push((await readRunRecord(run.runDir)).pid!)
    expect(run.editorUrl).toMatch(new RegExp(`/runs/${run.runId}/\\?token=`))
    expect(opened).toEqual([run.editorUrl])

    // 会话文件位置被目录占住：编辑服务起不来
    const broken = await sourceRoot(false)
    await mkdir(editorSessionPath(broken), { recursive: true })
    const fallback: string[] = []
    const second = await startRunTool({ sourceRoot: broken }, { ...config(), openUrl: (url) => fallback.push(url) })
    pids.push((await readRunRecord(second.runDir)).pid!)
    expect(second.editorUrl).toBeUndefined()
    expect(fallback).toEqual([second.graph])
    expect(await readFile(path.join(path.dirname(editorSessionPath(broken)), 'editor.log'), 'utf8')).not.toBe('')
  })
})
