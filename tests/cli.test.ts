import { spawnSync } from 'node:child_process'
import { access, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { runCli, type CliDeps, type CliIo } from '../src/cli.js'
import { FakeImageGeneration } from './helpers/fake-image-generation.js'
import { FakeVision } from './helpers/fake-vision.js'
import { createCliFixture, type CliFixture } from './helpers/cli-fixture.js'

const fixtures: CliFixture[] = []
const env = { IMAGE_MODEL: 'fake-image-model', VISION_MODEL: 'fake-vision-model' }

interface Invocation {
  code: number
  stdout: string
  stderr: string
  json: Record<string, unknown>
}

async function invoke(args: string[], deps: CliDeps): Promise<Invocation> {
  let stdout = ''
  let stderr = ''
  const io: CliIo = {
    stdout: (text) => { stdout += text },
    stderr: (text) => { stderr += text },
  }
  const code = await runCli(args, io, deps)
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean)
  expect(lines).toHaveLength(1)
  return { code, stdout, stderr, json: JSON.parse(lines[0]!) as Record<string, unknown> }
}

describe('runCli entry', () => {
  it('prints help through Commander and exits zero', async () => {
    let stdout = ''
    let stderr = ''
    const code = await runCli(['--help'], {
      stdout: (text) => { stdout += text },
      stderr: (text) => { stderr += text },
    })

    expect(code).toBe(0)
    expect(stdout).toContain('Usage: fashion-tryon')
    expect(stderr).toBe('')
  })

  it('runs when the executable path is a symbolic link', async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), 'fashion-tryon-cli-entry-'))
    const executable = path.join(workspace, 'fashion-tryon.ts')
    try {
      await symlink(path.resolve('src/cli.ts'), executable)

      const result = spawnSync(process.execPath, [
        '--import', 'tsx', executable, '--help',
      ], {
        cwd: path.resolve('.'),
        encoding: 'utf8',
      })

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('Usage: fashion-tryon')
      expect(result.stderr).toBe('')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('rejects missing production keys before any network call or batch directory', async () => {
    const fixture = await createCliFixture([{ name: '款A', garments: 1, models: 1 }])
    fixtures.push(fixture)
    let fetchCalls = 0

    const result = await invoke(['studio', fixture.inputRoot, '--no-open', '--json'], {
      env,
      fetchImpl: async () => {
        fetchCalls += 1
        throw new Error('configuration validation must run before fetch')
      },
    })

    expect(result.code).toBe(1)
    expect(result.json).toMatchObject({ status: 'error', error: { code: 'CONFIG_ERROR', message: 'APIMART_API_KEY' } })
    expect(fetchCalls).toBe(0)
    await expect(access(path.join(fixture.workspace, 'input-tryon-studio'))).rejects.toThrow()
  })
})

describe('studio and status commands', () => {
  it('starts one resident studio, rejects a second one and reports status while running', async () => {
    const fixture = await createCliFixture([{ name: 'EK52338_灰', garments: 1, models: 2 }])
    fixtures.push(fixture)
    const deps: CliDeps = {
      env,
      vision: new FakeVision(),
      imageGeneration: new FakeImageGeneration(),
    }
    const controller = new AbortController()
    let stdout = ''
    let stderr = ''
    const running = runCli(['studio', fixture.inputRoot, '--no-open', '--json'], {
      stdout: (text) => { stdout += text },
      stderr: (text) => { stderr += text },
    }, { ...deps, signal: controller.signal })

    await vi.waitFor(() => expect(stdout.trim()).not.toBe(''))
    const first = JSON.parse(stdout.trim().split(/\r?\n/)[0]!) as { url: string; batchDir: string }
    expect(first.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]{32,}$/)
    expect(first.batchDir).toBe(path.join(fixture.workspace, 'input-tryon-studio'))

    let secondErr = ''
    const second = await runCli(['studio', fixture.inputRoot, '--no-open', '--json'], {
      stdout: () => undefined,
      stderr: (text) => { secondErr += text },
    }, deps)
    expect(second).toBe(1)
    expect(secondErr).toContain('already')

    const status = await invoke(['status', fixture.inputRoot, '--json'], {})
    expect(status.code).toBe(0)
    expect(status.json).toMatchObject({
      batchDir: first.batchDir,
      counts: { tasks: 2 },
      groups: [{ sku: 'EK52338', status: 'idle' }],
    })

    controller.abort()
    await expect(running).resolves.toBe(0)
    expect(stdout.trim().split(/\r?\n/).filter(Boolean)).toHaveLength(1)
    expect(stderr).toBe('')
  })

  it('reports a missing batch through status without creating it', async () => {
    const fixture = await createCliFixture([{ name: 'EK52338', garments: 1, models: 1 }])
    fixtures.push(fixture)
    const status = await invoke(['status', fixture.inputRoot, '--json'], {})
    expect(status.code).toBe(1)
    expect(status.json).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
    await expect(access(path.join(fixture.workspace, 'input-tryon-studio'))).rejects.toThrow()
  })
})

describe('open command', () => {
  it('reuses the running editor, remembers the folder and adds it to the project list', async () => {
    const { mkdir: mkdirp, readFile } = await import('node:fs/promises')
    const { startEditorServer } = await import('../src/editor/server.js')
    const { listProjects } = await import('../src/editor/projects.js')
    const workspace = await mkdtemp(path.join(tmpdir(), 'fashion-tryon-open-'))
    const root = path.join(workspace, '素材')
    await mkdirp(path.join(root, '服装'), { recursive: true })
    const home = path.join(workspace, 'home')
    const server = await startEditorServer({ sourceRoot: root, launch: { cliCommand: ['false'], env: {} } })
    try {
      const opened: string[] = []
      const deps: CliDeps = { env: { FASHION_TRYON_HOME: home }, openUrl: (url) => { opened.push(url) } }
      const first = await invoke(['open', root, '--json'], deps)
      expect(first.code).toBe(0)
      expect(first.json.url).toBe(`${server.origin}/materials/?token=${server.token}`)
      expect(await readFile(path.join(home, 'last-root'), 'utf8')).toBe(`${root}\n`)
      expect((await listProjects({ FASHION_TRYON_HOME: home })).map((entry) => entry.root)).toEqual([root])
      expect(opened).toEqual([first.json.url])
    } finally {
      await server.close()
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('opens the project page without an argument, reusing the running hub', async () => {
    const { startHubServer, hubPageUrl } = await import('../src/editor/hub-server.js')
    const home = await mkdtemp(path.join(tmpdir(), 'fashion-tryon-open-hub-'))
    const hub = await startHubServer({ launch: { cliCommand: ['false'], env: { FASHION_TRYON_HOME: home } } })
    try {
      const opened: string[] = []
      const result = await invoke(['open', '--no-open', '--json'], { env: { FASHION_TRYON_HOME: home }, openUrl: (url) => { opened.push(url) } })
      expect(result.code).toBe(0)
      expect(result.json).toMatchObject({ ok: true, command: 'open', status: 'completed', url: hubPageUrl(hub.origin, hub.token) })
      expect(opened).toEqual([])
      const shown = await invoke(['open', '--json'], { env: { FASHION_TRYON_HOME: home }, openUrl: (url) => { opened.push(url) } })
      expect(opened).toEqual([shown.json.url])
    } finally {
      await hub.close()
      await rm(home, { recursive: true, force: true })
    }
  })
})

describe('editor command', () => {
  it('adds the folder to the project list, and still starts when the list is corrupt', async () => {
    const { mkdir: mkdirp, writeFile } = await import('node:fs/promises')
    const { listProjects, projectsPath } = await import('../src/editor/projects.js')
    const workspace = await mkdtemp(path.join(tmpdir(), 'fashion-tryon-editor-'))
    const root = path.join(workspace, '素材')
    await mkdirp(path.join(root, '服装'), { recursive: true })
    const run = async (home: string): Promise<{ stdout: string; stderr: string }> => {
      const controller = new AbortController()
      let stdout = ''
      let stderr = ''
      const running = runCli(['editor', root, '--no-open', '--json'], {
        stdout: (text) => { stdout += text },
        stderr: (text) => { stderr += text },
      }, { env: { FASHION_TRYON_HOME: home }, signal: controller.signal })
      await vi.waitFor(() => expect(stdout.trim()).not.toBe(''))
      controller.abort()
      expect(await running).toBe(0)
      return { stdout, stderr }
    }
    try {
      const home = path.join(workspace, 'home')
      await run(home)
      expect((await listProjects({ FASHION_TRYON_HOME: home })).map((entry) => entry.root)).toEqual([root])

      const broken = path.join(workspace, 'broken')
      await mkdirp(broken)
      await writeFile(projectsPath({ FASHION_TRYON_HOME: broken }), '{ broken')
      const { stderr } = await run(broken)
      expect(stderr).toContain('项目列表文件损坏')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})

describe('hub command', () => {
  it('prints { url, origin } as the first line and runs until aborted', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'fashion-tryon-hub-cli-'))
    const controller = new AbortController()
    let stdout = ''
    const opened: string[] = []
    const running = runCli(['hub', '--no-open', '--json'], {
      stdout: (text) => { stdout += text },
      stderr: () => undefined,
    }, { env: { FASHION_TRYON_HOME: home }, signal: controller.signal, openUrl: (url) => { opened.push(url) } })
    try {
      await vi.waitFor(() => expect(stdout.trim()).not.toBe(''))
      const first = JSON.parse(stdout.trim().split(/\r?\n/)[0]!) as { url: string; origin: string }
      expect(first.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      expect(first.url).toMatch(new RegExp(`^${first.origin}/\\?token=[0-9a-f]+$`))
      expect((await fetch(first.url)).status).toBe(200)
      expect(opened).toEqual([])
    } finally {
      controller.abort()
      expect(await running).toBe(0)
      await rm(home, { recursive: true, force: true })
    }
  })
})
