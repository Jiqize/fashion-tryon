import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { startHubServer, type HubServerOptions } from '../src/editor/hub-server.js'
import { addProject } from '../src/editor/projects.js'
import { readEditorSession } from '../src/editor/server.js'
import type { LaunchConfig } from '../src/mcp/tools.js'
import { countShots, runsDir, writeRunRecord, type RunGroup } from '../src/simple/record.js'
import { fixtureImageBytes } from './helpers/image-bytes.js'

let browser: Browser
const dirs: string[] = []
const closers: (() => Promise<void>)[] = []
const editorRoots: string[] = []

beforeAll(async () => {
  browser = await chromium.launch()
})

afterAll(async () => {
  await browser.close()
})

afterEach(async () => {
  for (const close of closers.splice(0)) await close()
  for (const root of editorRoots.splice(0)) {
    const session = await readEditorSession(root)
    if (session !== undefined) {
      try { process.kill(session.pid, 'SIGKILL') } catch { /* 已退出 */ }
    }
  }
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function launchFor(home: string): LaunchConfig {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('APIMART_') || key === 'IMAGE_MODEL') delete env[key]
  }
  return {
    cliCommand: [process.execPath, '--import', 'tsx', path.resolve('src/cli.ts')],
    env: { ...env, FASHION_TRYON_HOME: home, FASHION_TRYON_FAKE_ENGINE: '{}' },
  }
}

async function write(root: string, files: string[]): Promise<void> {
  for (const [index, file] of files.entries()) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await writeFile(path.join(root, file), await fixtureImageBytes(index + 1))
  }
}

/** 「AI春夏」：2 款、3 张成图、一次出图；「空项目」：空文件夹 */
async function setup(options: Partial<HubServerOptions> = {}): Promise<{ parent: string; home: string; full: string; empty: string; page: Page }> {
  const parent = await mkdtemp(path.join(tmpdir(), 'projects-ui-'))
  dirs.push(parent)
  const home = path.join(parent, 'home')
  const full = path.join(parent, 'AI春夏')
  const empty = path.join(parent, '空项目')
  await mkdir(empty, { recursive: true })
  await write(full, ['服装/EX1/g1.jpg', '模特/EX1/m1.jpg', '服装/EX2/g1.jpg', '成图/EX1/a.jpg', '成图/EX1/a-v2.jpg', '成图/EX2/b.jpg'])
  const runDir = path.join(runsDir(full), '20261016-143200')
  await mkdir(runDir, { recursive: true })
  const groups: RunGroup[] = [{
    sku: 'EX1', referenceSource: 'originals', swap: 'outfit', promptEdited: false, references: [], prompt: 'p',
    shots: [{ model: 'EX1/模特/m1.jpg', modelThumb: 'ref/m.jpg', state: 'done', delivered: '成图/EX1/a.jpg' }],
  }]
  await writeRunRecord({
    schemaVersion: 2, runId: '20261016-143200', sourceRoot: full, runDir,
    reportPath: path.join(runDir, 'report.html'), graphPath: path.join(runDir, 'graph.html'), engine: 'fake', params: null,
    status: 'completed', pid: null, startedAt: '2026-10-16T06:32:00.000Z', finishedAt: null, heartbeatAt: null,
    current: null, derivedFrom: null, groups, counts: countShots(groups),
  })
  const env = { FASHION_TRYON_HOME: home }
  // 空项目后加入：按加入时间它更新，但没出过图，排在后面
  await addProject(env, full, new Date('2026-10-01T00:00:00.000Z'))
  await addProject(env, empty, new Date('2026-10-18T00:00:00.000Z'))
  const hub = await startHubServer({ launch: launchFor(home), ...options })
  closers.push(() => hub.close())
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
  await page.goto(hub.url)
  await page.waitForSelector('.pj-card[data-id]')
  return { parent, home, full, empty, page }
}

const names = (page: Page): Promise<string[]> => page.$$eval('.pj-card[data-id] .pj-name', (nodes) => nodes.map((node) => node.textContent ?? ''))

describe('project page', () => {
  it('shows cards newest run first with counts, time and a new-project card', async () => {
    const { page } = await setup()
    expect(await page.title()).toBe('项目')
    expect(await page.textContent('#pj-info')).toBe('2 个项目')
    expect(await names(page)).toEqual(['AI春夏', '空项目'])
    const first = page.locator('.pj-card[data-id]').first()
    await expect.poll(() => first.textContent()).toContain('2 款 · 3 张成图')
    const time = await page.evaluate(() => {
      const date = new Date('2026-10-16T06:32:00.000Z')
      const pad = (value: number): string => String(value).padStart(2, '0')
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    })
    expect(await first.textContent()).toContain(`最近出图 ${time}`)
    expect(await first.locator('.pj-cover img').count()).toBe(1)
    expect(await page.locator('.pj-card[data-id]').nth(1).textContent()).toContain('还没出图')
    expect(await page.locator('.pj-card[data-id]').nth(1).locator('.pj-cover.is-empty').count()).toBe(1)
    expect(await page.locator('#pj-grid > :last-child').getAttribute('id')).toBe('pj-new')
  })

  it('filters by display name or folder name and focuses search with ⌘F', async () => {
    const { page } = await setup()
    await page.keyboard.press('Meta+f')
    expect(await page.evaluate('document.activeElement.id')).toBe('pj-search')
    await page.keyboard.type('ai')
    expect(await names(page)).toEqual(['AI春夏'])
    await page.fill('#pj-search', '空')
    expect(await names(page)).toEqual(['空项目'])
  })

  it('creates a project from the folder picker and goes to its collection page', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'projects-ui-new-'))
    dirs.push(parent)
    const fresh = path.join(parent, '新批次')
    await mkdir(fresh)
    editorRoots.push(fresh)
    const { page } = await setup({ pickFolder: async () => fresh })
    await page.click('#pj-new')
    await page.waitForURL(/\/materials\/\?token=[0-9a-f]+$/, { timeout: 15_000 })
    await page.waitForSelector('#cl-list')
  })

  it('renames a project and keeps the new name after reload', async () => {
    const { page } = await setup()
    await page.locator('.pj-card[data-id]').first().locator('.pj-more').click()
    await page.click('.ui-menu.on [data-value="rename"]')
    const input = page.locator('.ui-sheet.on .ui-sheet-input')
    expect(await input.inputValue()).toBe('AI春夏')
    await input.fill('26冬毛绒')
    await page.keyboard.press('Enter')
    await expect.poll(() => names(page)).toEqual(['26冬毛绒', '空项目'])
    await page.reload()
    await page.waitForSelector('.pj-card[data-id]')
    expect(await names(page)).toEqual(['26冬毛绒', '空项目'])
  })

  it('removes after confirmation and undoes from the toast', async () => {
    const { page } = await setup()
    await page.locator('.pj-card[data-id]').nth(1).locator('.pj-more').click()
    await page.click('.ui-menu.on [data-value="remove"]')
    expect(await page.textContent('.ui-sheet.on')).toContain('只从项目页移除，不删除文件夹里的任何文件')
    await page.keyboard.press('Enter')
    await expect.poll(() => names(page)).toEqual(['AI春夏'])
    await page.click('.ui-toast .ui-toast-act')
    await expect.poll(() => names(page)).toEqual(['AI春夏', '空项目'])
  })

  it('greys out a missing folder after refresh and does not open it', async () => {
    const { page, full } = await setup()
    await rm(full, { recursive: true, force: true })
    await page.click('#pj-refresh')
    const missing = page.locator('.pj-card.is-missing')
    await expect.poll(() => missing.count()).toBe(1)
    expect(await missing.textContent()).toContain('找不到文件夹')
    expect(await missing.textContent()).toContain(full)
    const before = page.url()
    await missing.locator('.pj-name').click()
    await page.waitForTimeout(300)
    expect(page.url()).toBe(before)
    await missing.locator('.pj-more').click()
    expect(await page.$$eval('.ui-menu.on [role="menuitem"]', (nodes) => nodes.map((node) => node.textContent))).toEqual(['从列表移除'])
  })
})
