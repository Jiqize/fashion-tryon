import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { chromium, type Browser, type Page, type Request } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { editorMaterialsUrl, startEditorServer, type EditorServer } from '../src/editor/server.js'
import { startRunTool, type LaunchConfig } from '../src/mcp/tools.js'
import { KEEP_FRAME_SENTENCE, readCollection } from '../src/simple/collection.js'
import { applyCropPlan, parseCropPlan } from '../src/simple/crop.js'
import { scanSimple } from '../src/simple/layout.js'
import { readActiveLock } from '../src/simple/lock.js'
import { readRunRecord, runsDir } from '../src/simple/record.js'
import { defaultPrompt } from '../src/simple/rerun.js'
import { fixtureImageBytes } from './helpers/image-bytes.js'

let browser: Browser
const roots: string[] = []
const servers: EditorServer[] = []
const pids: number[] = []

beforeAll(async () => {
  browser = await chromium.launch()
})

afterAll(async () => {
  await browser.close()
})

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const pid of pids.splice(0)) {
    try { process.kill(pid, 'SIGKILL') } catch { /* 已退出 */ }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const FILES = ['服装/EX1/g1.jpg', '服装/EX1/g2.jpg', '服装/EX1/g3.jpg', '模特/EX1/m1.jpg', '模特/EX1/m2.jpg', '服装/EF2/g1.jpg', '模特/EF2/m1.jpg', '模特/EG3/m1.jpg']

function launch(delayMs: number): LaunchConfig {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('APIMART_') || key === 'IMAGE_MODEL') delete env[key]
  }
  return {
    cliCommand: [process.execPath, '--import', 'tsx', path.resolve('src/cli.ts')],
    env: { ...env, FASHION_TRYON_FAKE_ENGINE: JSON.stringify({ delayMs }) },
  }
}

async function setup(delayMs = 100): Promise<{ root: string; server: EditorServer; launch: LaunchConfig }> {
  const root = await mkdtemp(path.join(tmpdir(), 'collection-ui-'))
  roots.push(root)
  for (const [index, file] of FILES.entries()) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await writeFile(path.join(root, file), await fixtureImageBytes(index + 1))
  }
  await applyCropPlan(root, parseCropPlan({ EX1: [{ from: 'g1.jpg', role: '全身-正面' }, { from: 'g2.jpg', role: '细节-领口' }] }))
  const config = launch(delayMs)
  const server = await startEditorServer({ sourceRoot: root, launch: config })
  servers.push(server)
  return { root, server, launch: config }
}

async function openCollection(server: EditorServer, width = 1280): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 900 } })
  await page.goto(`${server.url}`)
  await page.waitForSelector('#ed-bar #ed-go')
  await page.waitForSelector('.cl-group')
  return page
}

const group = (sku: string): string => `section.cl-group[data-sku="${sku}"]`
const mode = (value: string): string => `.ui-seg[data-cl="mode"] [data-value="${value}"]`
/** 组头分段控件某一项 */
const seg = (sku: string, cl: string, value: string): string => `${group(sku)} .ui-seg[data-cl="${cl}"] [data-value="${value}"]`
const keepSwitch = (sku: string): string => `${group(sku)} .ui-switch[data-cl="keep"]`
/** 分段控件当前选中值 */
const segValue = (page: Page, root: string): Promise<string | null> => page.getAttribute(`${root} [aria-checked="true"]`, 'data-value')
/** 抽屉里的分段控件某一项、画幅开关、每件衣服的参考图按钮 */
const drawerSeg = (cl: string, value: string): string => `#cl-drawer .ui-seg[data-cl="${cl}"] [data-value="${value}"]`
const drawerKeep = '#cl-drawer .ui-switch[data-cl="keep"]'
const itemRef = (item: string): string => `#cl-drawer .cl-itemref[data-item="${item}"]`
const menuValues = (page: Page): Promise<(string | null)[]> =>
  page.locator('.ui-menu.on [role="menuitem"]').evaluateAll((els) => els.map((el) => el.getAttribute('data-value')))
const isOn = async (page: Page, selector: string): Promise<boolean> => (await page.getAttribute(selector, 'aria-checked')) === 'true'
const skus = (page: Page): Promise<string[]> =>
  page.locator('section.cl-group').evaluateAll((els) => els.map((el) => (el as unknown as { dataset: { sku: string } }).dataset.sku))

/** 记下发往某接口的请求体 */
function recordBodies(page: Page, pattern: string): unknown[] {
  const bodies: unknown[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === pattern) bodies.push(request.postDataJSON())
  })
  return bodies
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out')
    await sleep(100)
  }
}

async function snapshot(root: string): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (path.relative(root, full) !== path.join('成图', '_runs')) await walk(full)
      } else {
        result.set(path.relative(root, full).split(path.sep).join('/'), createHash('sha256').update(await readFile(full)).digest('hex'))
      }
    }
  }
  await walk(root)
  return result
}

async function file(name: string, seed: number, format: 'jpeg' | 'png' | 'webp' = 'jpeg'): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  return { name, mimeType: 'application/octet-stream', buffer: Buffer.from(await fixtureImageBytes(seed, format)) }
}

/** 在合集页发起出图（出图后留在本页）：返回 new-run 请求、runId 与 run 页地址 */
async function startFromPage(page: Page, action: () => Promise<unknown>): Promise<{ request: Request; runId: string; url: string }> {
  const [response] = await Promise.all([
    page.waitForResponse((res) => res.request().method() === 'POST' && new URL(res.url()).pathname === '/api/new-run'),
    action(),
  ])
  const { runId, url } = await response.json() as { runId: string; url: string }
  return { request: response.request(), runId, url }
}

async function waitRun(root: string, runId: string): Promise<string> {
  const record = await readRunRecord(path.join(runsDir(root), runId))
  if (record.pid !== null) pids.push(record.pid)
  await waitUntil(async () => (await readRunRecord(path.join(runsDir(root), runId))).status !== 'running')
  return runId
}

describe('collection page shell', () => {
  it('explains how to recover from a corrupt settings file', async () => {
    const { root, server } = await setup()
    await mkdir(path.join(root, '成图', '_runs'), { recursive: true })
    await writeFile(path.join(root, '成图', '_runs', 'collection.json'), '{not json', 'utf8')
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    await page.goto(`${server.url}`)
    await page.waitForSelector('.ed-err')
    expect(await page.locator('.ed-err').innerText()).toContain('合集设置文件损坏：成图/_runs/collection.json')
    expect(await page.locator('.ed-err').innerText()).toContain('删掉')
    expect(await page.locator('#ed-bar button.ed-reload').count()).toBe(1)
    await page.close()
  })

  it('links back to the project page and shows the project display name', async () => {
    const { addProject, renameProject } = await import('../src/editor/projects.js')
    const { root, server } = await setup()
    const { entry } = await addProject(process.env, root)
    await renameProject(process.env, entry.id, '26冬毛绒')
    const page = await openCollection(server)
    const link = page.locator('#cl-top a.cl-btn[href="/projects"]')
    expect(await link.innerText()).toBe('项目')
    expect(await page.locator('#cl-top h1').innerText()).toBe('26冬毛绒')
    expect(await page.locator('#cl-info').innerText()).toMatch(/^3 款/)
    expect(await page.title()).toBe('合集')
    await page.close()
  })

  it('opens from / without runs, matches scan and remembers the mode', async () => {
    const { root, server } = await setup()
    const page = await openCollection(server)
    expect(new URL(page.url()).pathname).toBe('/materials/')
    expect(await skus(page)).toEqual((await scanSimple(root)).map((entry) => entry.sku))
    expect(await page.locator(`${group('EX1')} .cl-cnt`).innerText()).toBe('衣服 3 · 模特 2/2 · 将出 2 张')
    expect(await page.locator(`${group('EG3')} input.cl-pick`).isDisabled()).toBe(true)
    // 裁图在衣服栏下面单独一排，带「裁」标
    expect(await page.locator(`${group('EX1')} .cl-crops .cl-crop[data-file="裁图/EX1/01-全身-正面.jpg"]`).innerText()).toContain('裁')
    expect(await page.getAttribute(mode('place'), 'aria-checked')).toBe('true')
    await page.click(mode('node'))
    expect(await page.getAttribute(mode('node'), 'aria-checked')).toBe('true')
    await page.reload()
    await page.waitForSelector('.cl-group')
    expect(await page.getAttribute(mode('node'), 'aria-checked')).toBe('true')
    expect(await page.locator('.cl-col').count()).toBe(0)
    await page.click(mode('place'))
    expect(await page.locator(`${group('EX1')} .cl-col`).count()).toBe(2)
    await page.close()
  })

  it('filters by sku and remembers folded groups', async () => {
    const { server } = await setup()
    const page = await openCollection(server)
    await page.fill('#cl-search', 'ef')
    expect(await skus(page)).toEqual(['EF2'])
    await page.fill('#cl-search', '')
    expect(await skus(page)).toEqual(['EF2', 'EG3', 'EX1'])
    await page.click(`${group('EX1')} button.cl-fold`)
    expect(await page.locator(`${group('EX1')} .cl-col`).count()).toBe(0)
    await page.reload()
    await page.waitForSelector('.cl-group')
    expect(await page.locator(`${group('EX1')} .cl-col`).count()).toBe(0)
    expect(await page.locator(`${group('EF2')} .cl-col`).count()).toBe(2)
    await page.close()
  })

  it('saves group order from the more menu and restores sku order', async () => {
    const { root, server } = await setup()
    const page = await openCollection(server)
    const bodies = recordBodies(page, '/api/collection/order')
    await page.click(`${group('EF2')} .cl-more[aria-haspopup=menu]`)
    await Promise.all([page.waitForResponse('**/api/collection/order'), page.click('.ui-menu [data-value="last"]')])
    expect(bodies).toEqual([{ order: ['EG3', 'EX1', 'EF2'] }])
    expect((await readCollection(root)).order).toEqual(['EG3', 'EX1', 'EF2'])
    expect(await skus(page)).toEqual(['EG3', 'EX1', 'EF2'])
    expect(await page.locator(`${group('EF2')} .cl-no`).innerText()).toBe('03')
    await page.waitForSelector('.ui-toast:has-text("已调整顺序")')
    await page.click(`${group('EX1')} .cl-more[aria-haspopup=menu]`)
    await Promise.all([page.waitForResponse('**/api/collection/order'), page.click('.ui-menu [data-value="first"]')])
    expect(await skus(page)).toEqual(['EX1', 'EG3', 'EF2'])
    await page.reload()
    await page.waitForSelector('.cl-group')
    expect(await skus(page)).toEqual(['EX1', 'EG3', 'EF2'])
    await Promise.all([page.waitForResponse('**/api/collection/order'), page.click('#cl-sort-sku')])
    expect((await readCollection(root)).order).toEqual([])
    expect(await skus(page)).toEqual(['EF2', 'EG3', 'EX1'])
    await page.close()
  })

  it('reorders by dragging the number onto the upper half of another group', async () => {
    const { root, server } = await setup()
    const page = await openCollection(server)
    const bodies = recordBodies(page, '/api/collection/order')
    expect(await page.getAttribute(`${group('EX1')} .cl-no`, 'draggable')).toBe('true')
    await Promise.all([
      page.waitForResponse('**/api/collection/order'),
      page.locator(`${group('EX1')} .cl-no`).dragTo(page.locator(group('EF2')), { targetPosition: { x: 40, y: 4 } }),
    ])
    expect(bodies).toEqual([{ order: ['EX1', 'EF2', 'EG3'] }])
    expect(await skus(page)).toEqual(['EX1', 'EF2', 'EG3'])
    expect(await page.locator('.cl-group.is-dragging, .cl-group.drop-before, .cl-group.drop-after').count()).toBe(0)
    await page.waitForSelector('.ui-toast:has-text("已调整顺序")')
    await page.reload()
    await page.waitForSelector('.cl-group')
    expect(await skus(page)).toEqual(['EX1', 'EF2', 'EG3'])
    expect((await readCollection(root)).order).toEqual(['EX1', 'EF2', 'EG3'])
    await page.close()
  })

  it('folds from the more menu with a summary matching the head count, kept after reload (order menu)', async () => {
    const { server } = await setup()
    const page = await openCollection(server)
    const count = await page.locator(`${group('EX1')} .cl-cnt`).innerText()
    await page.click(`${group('EX1')} .cl-more[aria-haspopup=menu]`)
    expect(await page.locator('.ui-menu [data-value="fold"]').innerText()).toBe('折叠')
    await page.click('.ui-menu [data-value="fold"]')
    expect(await page.locator(`${group('EX1')} .cl-col`).count()).toBe(0)
    const summary = await page.locator(`${group('EX1')} .cl-summary`).innerText()
    expect(summary).toMatch(/^衣服 \d+ · 模特 \d+\/\d+ · 将出 \d+ 张 · 成图 \d+ 版$/)
    expect(summary.startsWith(count + ' · 成图 ')).toBe(true)
    expect(await page.locator(`${group('EF2')} .cl-summary`).count()).toBe(0)
    await page.reload()
    await page.waitForSelector('.cl-group')
    expect(await page.locator(`${group('EX1')} .cl-summary`).innerText()).toBe(summary)
    await page.click(`${group('EX1')} .cl-more[aria-haspopup=menu]`)
    expect(await page.locator('.ui-menu [data-value="fold"]').innerText()).toBe('展开')
    await page.click('.ui-menu [data-value="fold"]')
    expect(await page.locator(`${group('EX1')} .cl-summary`).count()).toBe(0)
    expect(await page.locator(`${group('EX1')} .cl-col`).count()).toBe(2)
    await page.close()
  })

  it('has no move up / down buttons in the group head (order)', async () => {
    const { server } = await setup()
    const page = await openCollection(server)
    expect(await page.locator('.cl-up, .cl-down, [aria-label="上移"], [aria-label="下移"]').count()).toBe(0)
    expect(await page.locator('.cl-head[draggable]').count()).toBe(0)
    await page.close()
  })

  it('shows upload progress for dropped files without locking other groups', async () => {
    const { root, server } = await setup()
    const page = await openCollection(server)
    // 拖慢上传，看得到进度
    await page.route('**/api/upload?*', async (route) => {
      await sleep(600)
      await route.continue()
    })
    const one = [...await fixtureImageBytes(40)]
    const two = [...await fixtureImageBytes(41)]
    const dataTransfer = await page.evaluateHandle(`(() => {
      const transfer = new DataTransfer()
      transfer.items.add(new File([new Uint8Array(${JSON.stringify(one)})], 'd1.jpg', { type: 'image/jpeg' }))
      transfer.items.add(new File([new Uint8Array(${JSON.stringify(two)})], 'd2.jpg', { type: 'image/jpeg' }))
      return transfer
    })()`)
    const zone = `${group('EX1')} .cl-drop[data-kind="model"]`
    await page.dispatchEvent(zone, 'dragover', { dataTransfer })
    expect(await page.locator(`${group('EX1')} .cl-col[data-kind="model"]`).getAttribute('class')).toContain('is-over')
    await page.dispatchEvent(zone, 'drop', { dataTransfer })
    await waitUntil(async () => (await page.locator(`${group('EX1')} .cl-prog`).count()) > 0)
    expect(await page.locator(`${group('EX1')} .cl-prog`).innerText()).toMatch(/正在放入 [01] \/ 2/)
    // 上传中其它款照常勾选，只有「出图」等放完
    await page.check(`${group('EF2')} input.cl-pick`)
    expect(await page.locator('#ed-go').isDisabled()).toBe(true)
    await waitUntil(async () => (await page.locator(`${group('EX1')} .cl-cnt`).innerText()).startsWith('衣服 3 · 模特 4/4'))
    expect(await page.locator(`${group('EX1')} .cl-prog`).count()).toBe(0)
    await page.waitForSelector('.ui-toast:has-text("模特图放入成功 2 张")')
    expect(await page.isChecked(`${group('EF2')} input.cl-pick`)).toBe(true)
    expect(await page.locator('#ed-go').isDisabled()).toBe(false)
    expect(await readFile(path.join(root, '模特/EX1/d1.jpg'))).toEqual(Buffer.from(one))
    await page.close()
  })

  it('uploads through the file chooser and lists rejected files', async () => {
    const { root, server } = await setup()
    const page = await openCollection(server)
    await page.setInputFiles(`${group('EX1')} .cl-drop[data-kind="garment"] input[type="file"]`, [
      await file('a.jpg', 30), await file('b.png', 31, 'png'),
      { name: 'a.heic', mimeType: 'image/heic', buffer: Buffer.from('heic') },
    ])
    await page.waitForSelector('.ui-toast:has-text("服装图放入成功 2 张")')
    expect(await page.locator('.ui-toast.is-error').innerText()).toContain('a.heic：只支持 jpg、png、webp')
    expect((await readdir(path.join(root, '服装/EX1'))).sort()).toEqual(['a.jpg', 'b.png', 'g1.jpg', 'g2.jpg', 'g3.jpg'])
    await page.close()
  })

  it('checks fixed model and one-to-one counts and saves prefs', async () => {
    const { root, server } = await setup()
    const page = await openCollection(server)
    await Promise.all([page.waitForResponse('**/api/collection/prefs'), page.click(seg('EX1', 'pairing', 'fixedModel'))])
    expect((await readCollection(root)).groups.EX1?.pairing).toBe('fixedModel')
    const counts = page.locator(`${group('EX1')} .cl-cnt`)
    expect(await counts.innerText()).toContain('固定模特只能选 1 个模特')
    expect(await page.locator(`${group('EX1')} .cl-cnt .cl-err`).innerText()).toBe('固定模特只能选 1 个模特')
    expect(await page.locator(`${group('EX1')} input.cl-pick`).isDisabled()).toBe(true)
    await page.click(`${group('EX1')} .cl-tile[data-file="模特/EX1/m2.jpg"]`)
    expect(await page.getAttribute(`${group('EX1')} .cl-tile[data-file="模特/EX1/m2.jpg"]`, 'aria-pressed')).toBe('false')
    expect(await counts.innerText()).toBe('衣服 3 · 模特 1/2 · 将出 3 张')
    expect(await page.locator(`${group('EX1')} input.cl-pick`).isDisabled()).toBe(false)
    // 固定模特下衣服也能点选
    await page.click(`${group('EX1')} .cl-tile[data-file="服装/EX1/g3.jpg"]`)
    expect(await counts.innerText()).toBe('衣服 3 · 模特 1/2 · 将出 2 张')
    await page.click(`${group('EX1')} .cl-tile[data-file="服装/EX1/g3.jpg"]`)
    await page.click(`${group('EX1')} .cl-tile[data-file="模特/EX1/m2.jpg"]`)

    await Promise.all([page.waitForResponse('**/api/collection/prefs'), page.click(seg('EX1', 'pairing', 'oneToOne'))])
    expect(await counts.innerText()).toBe('衣服 3 · 模特 2/2 · 将出 2 张 · 未配对 1')
    // 固定服装下衣服不可点选
    await Promise.all([page.waitForResponse('**/api/collection/prefs'), page.click(seg('EX1', 'pairing', 'fixedGarment'))])
    expect(await page.getAttribute(`${group('EX1')} .cl-tile[data-file="服装/EX1/g1.jpg"]`, 'aria-pressed')).toBeNull()

    await Promise.all([page.waitForResponse('**/api/collection/prefs'), page.click(keepSwitch('EX1'))])
    await Promise.all([page.waitForResponse('**/api/collection/prefs'), page.click(`${group('EX1')} button.cl-half[data-file="模特/EX1/m2.jpg"]`)])
    expect((await readCollection(root)).groups.EX1).toEqual({ pairing: 'fixedGarment', keepFrame: true, halfModels: ['模特/EX1/m2.jpg'] })
    await page.reload()
    await page.waitForSelector('.cl-group')
    expect(await isOn(page, keepSwitch('EX1'))).toBe(true)
    expect(await page.getAttribute(`${group('EX1')} button.cl-half[data-file="模特/EX1/m2.jpg"]`, 'aria-pressed')).toBe('true')
    await page.close()
  })

  it('starts a fixed garment run like start_run and shows outputs with versions', async () => {
    const { root, server } = await setup()
    const page = await openCollection(server)
    expect(await page.locator('#ed-go').isDisabled()).toBe(true)
    await page.check(`${group('EX1')} input.cl-pick`)
    expect(await page.locator('#ed-count').innerText()).toBe('已选 1 款 · 出图 2 张')
    const { request, runId, url } = await startFromPage(page, () => page.click('#ed-go'))
    expect(request.postDataJSON()).toEqual({ groups: { EX1: { models: ['模特/EX1/m1.jpg', '模特/EX1/m2.jpg'] } } })
    // 出图后留在合集页，toast 带出图记录链接
    const started = page.locator('.ui-toast:has-text("开始出图 · 共 2 张")')
    await started.waitFor()
    expect(await started.locator('a.ui-toast-link').getAttribute('href')).toBe(url)
    expect(new URL(page.url()).pathname.startsWith('/runs/')).toBe(false)
    await waitRun(root, runId)
    const done = await readRunRecord(path.join(runsDir(root), runId))
    expect(done.status).toBe('completed')
    expect(done.groups).toHaveLength(1)
    expect(done.groups[0]).toMatchObject({ sku: 'EX1', referenceSource: 'crops', swap: 'outfit', promptEdited: false })
    expect(done.groups[0]!.references.map((ref) => ref.file)).toEqual(['裁图/EX1/01-全身-正面.jpg', '裁图/EX1/02-细节-领口.jpg'])
    expect(done.groups[0]).not.toHaveProperty('pairing')
    expect((await readdir(path.join(root, '成图/EX1'))).sort()).toEqual(['m1.png', 'm2.png'])
    // run 页面入口改名「合集」
    await page.goto(url)
    await page.waitForSelector('h1 a.cl-nav')
    expect(await page.locator('h1 a.cl-nav').innerText()).toBe('合集')
    expect(await page.locator('h1 a.cl-nav').getAttribute('href')).toBe('/materials/')

    await page.goto(editorMaterialsUrl(server.origin, server.token))
    await page.waitForSelector(`${group('EX1')} .cl-outs .cl-out`)
    expect(await page.locator(`${group('EX1')} .cl-outs .cl-out`).evaluateAll((els) => els.map((el) => el.getAttribute('data-file'))))
      .toEqual(['成图/EX1/m1.png', '成图/EX1/m2.png'])
    expect(await page.locator(`${group('EX1')} .cl-outs .cl-out`).first().innerText()).toContain('v1')
    // 只出这款：只提交该款
    await page.check(`${group('EF2')} input.cl-pick`)
    const { request: only, runId: onlyId } = await startFromPage(page, () => page.click(`${group('EX1')} button.cl-only`))
    expect(Object.keys((only.postDataJSON() as { groups: Record<string, unknown> }).groups)).toEqual(['EX1'])
    await waitRun(root, onlyId)
    expect((await readdir(path.join(root, '成图/EX1'))).sort()).toEqual(['m1-v2.png', 'm1.png', 'm2-v2.png', 'm2.png'])
    await page.goto(editorMaterialsUrl(server.origin, server.token))
    await page.waitForSelector(`${group('EX1')} .cl-outs .cl-out`)
    expect(await page.locator(`${group('EX1')} .cl-outs .cl-out`).evaluateAll((els) => els.map((el) => el.getAttribute('data-file'))))
      .toEqual(['成图/EX1/m1-v2.png', '成图/EX1/m2-v2.png'])
    expect(await page.locator(`${group('EX1')} .cl-outs .cl-out`).first().innerText()).toContain('v2')
    await page.close()
  })

  it('sends top-level swap and keep frame from the bar', async () => {
    const { root, server } = await setup()
    const page = await openCollection(server)
    // 没勾选款时底栏灰字提示，不是报错
    expect(await page.locator('#ed-msg .ed-dirty').innerText()).toBe('勾选要出图的款')
    expect(await page.locator('.ui-toast').count()).toBe(0)
    await page.check(`${group('EF2')} input.cl-pick`)
    expect(await page.locator('#ed-msg .ed-dirty').count()).toBe(0)
    await page.click('#cl-swap-all [data-value="top"]')
    await page.click('#cl-keep-all')
    const { request, runId } = await startFromPage(page, () => page.click('#ed-go'))
    expect(request.postDataJSON()).toEqual({ groups: { EF2: { models: ['模特/EF2/m1.jpg'] } }, swap: 'top', keepFrame: true })
    await waitRun(root, runId)
    await page.close()
  })

  it('creates a new sku that stays only after images are placed', async () => {
    const { root, server } = await setup()
    const page = await openCollection(server)
    await page.fill('#cl-new-sku', 'EX1')
    await page.click('#cl-new')
    await page.waitForSelector('.ui-toast.is-error')
    expect(await page.locator('.ui-toast.is-error').innerText()).toContain('款号已存在：EX1')
    await page.fill('#cl-new-sku', 'NEW1')
    await page.click('#cl-new')
    await page.waitForSelector(group('NEW1'))
    expect(await page.locator(`${group('NEW1')} .cl-cnt`).innerText()).toBe('新款，放图后写入文件夹')
    expect(await page.locator(`${group('NEW1')} .cl-drop.is-big`).count()).toBe(2)
    await Promise.all([page.waitForResponse('**/api/collection'), page.click('#cl-refresh')])
    expect(await page.locator(group('NEW1')).count()).toBe(1)

    await page.fill('#cl-new-sku', 'NEW2')
    await page.click('#cl-new')
    await page.waitForSelector(group('NEW2'))
    await page.setInputFiles(`${group('NEW2')} .cl-drop[data-kind="garment"] input[type="file"]`, [await file('g.jpg', 50)])
    await page.waitForSelector('.ui-toast:has-text("服装图放入成功 1 张")')
    await page.setInputFiles(`${group('NEW2')} .cl-drop[data-kind="model"] input[type="file"]`, [await file('m.jpg', 51)])
    await waitUntil(async () => (await page.locator(`${group('NEW2')} .cl-cnt`).innerText()).startsWith('衣服 1 · 模特 1/1'))
    expect(await readdir(path.join(root, '服装/NEW2'))).toEqual(['g.jpg'])
    expect(await page.locator(`${group('NEW2')} input.cl-pick`).isDisabled()).toBe(false)
    await page.close()

    const again = await openCollection(server)
    expect(await again.locator(group('NEW2')).count()).toBe(1)
    expect(await again.locator(group('NEW1')).count()).toBe(0)
    await again.close()
  })

  it('only writes uploads and deliveries into the material folder', async () => {
    const { root, server } = await setup()
    const page = await openCollection(server)
    await writeFile(path.join(root, '模特/EF2/finder.jpg'), await fixtureImageBytes(70))
    const before = await snapshot(root)
    await Promise.all([page.waitForResponse('**/api/collection'), page.click('#cl-refresh')])
    await waitUntil(async () => (await page.locator(`${group('EF2')} .cl-cnt`).innerText()).includes('模特 2/2'))
    await page.setInputFiles(`${group('EX1')} .cl-drop[data-kind="model"] input[type="file"]`, [await file('up.jpg', 71)])
    await page.waitForSelector('.ui-toast:has-text("模特图放入成功 1 张")')
    await Promise.all([page.waitForResponse('**/api/collection/prefs'), page.click(seg('EX1', 'pairing', 'oneToOne'))])
    await page.check(`${group('EF2')} input.cl-pick`)
    await page.click(`${group('EF2')} .cl-tile[data-file="模特/EF2/m1.jpg"]`)
    expect(await page.locator('#ed-count').innerText()).toBe('已选 1 款 · 出图 1 张')
    const { runId } = await startFromPage(page, () => page.click('#ed-go'))
    await waitRun(root, runId)
    expect((await readRunRecord(path.join(runsDir(root), runId))).groups[0]!.shots.map((shot) => shot.model)).toEqual(['模特/EF2/finder.jpg'])
    const after = await snapshot(root)
    expect([...after.keys()].filter((key) => !before.has(key)).sort()).toEqual(['成图/EF2/finder.png', '模特/EX1/up.jpg'])
    for (const [key, hash] of before) expect(after.get(key)).toBe(hash)
    await page.close()
  })

  it('shows run progress in the top bar and blocks starting', async () => {
    const { root, server, launch: config } = await setup()
    const running = await startRunTool({ sourceRoot: root, open: false, skus: ['EF2'] }, { ...config, env: { ...config.env, FASHION_TRYON_FAKE_ENGINE: JSON.stringify({ delayMs: 2500 }) } })
    pids.push((await readRunRecord(running.runDir)).pid!)
    const page = await openCollection(server)
    await page.check(`${group('EX1')} input.cl-pick`)
    expect(await page.locator('#ed-go').isDisabled()).toBe(true)
    expect(await page.locator('#cl-progress').innerText()).toMatch(/^正在出图 [01] \/ 1/)
    expect(await page.locator('#cl-progress a').getAttribute('href')).toBe(`/runs/${running.runId}/`)
    await waitUntil(async () => (await readActiveLock(root)) === null, 20_000)
    // 结束后自动刷新：进度消失、成图出现
    await waitUntil(async () => (await page.locator(`${group('EF2')} .cl-outs .cl-out`).count()) === 1, 15_000)
    expect(await page.locator('#cl-progress').isHidden()).toBe(true)
    expect(await page.locator('#ed-go').isDisabled()).toBe(false)
    await page.close()
  })

  it('has no horizontal scroll at phone width', async () => {
    const { server } = await setup()
    const page = await openCollection(server, 390)
    expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true)
    await page.click(mode('node'))
    expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true)
    await page.close()
  })
})

describe('collection top bar, group head and bar controls', () => {
  it('saves the rule from the segmented control and keeps it after reload', async () => {
    const { root, server } = await setup()
    const page = await openCollection(server)
    const bodies = recordBodies(page, '/api/collection/prefs')
    expect(await segValue(page, `${group('EX1')} .ui-seg[data-cl="pairing"]`)).toBe('fixedGarment')
    await Promise.all([page.waitForResponse('**/api/collection/prefs'), page.click(seg('EX1', 'pairing', 'fixedModel'))])
    expect(bodies).toEqual([{ sku: 'EX1', pairing: 'fixedModel' }])
    expect((await readCollection(root)).groups.EX1?.pairing).toBe('fixedModel')
    await page.reload()
    await page.waitForSelector('.cl-group')
    expect(await segValue(page, `${group('EX1')} .ui-seg[data-cl="pairing"]`)).toBe('fixedModel')
    // 不再有原生下拉
    expect(await page.locator('select').count()).toBe(0)
    await page.close()
  })

  it('turns keep frame on with the switch and appends the sentence to the run prompt', async () => {
    const { root, server } = await setup()
    const page = await openCollection(server)
    const bodies = recordBodies(page, '/api/collection/prefs')
    expect(await isOn(page, keepSwitch('EF2'))).toBe(false)
    await Promise.all([page.waitForResponse('**/api/collection/prefs'), page.click(keepSwitch('EF2'))])
    expect(bodies).toEqual([{ sku: 'EF2', keepFrame: true }])
    expect(await isOn(page, keepSwitch('EF2'))).toBe(true)
    await page.check(`${group('EF2')} input.cl-pick`)
    const { runId } = await startFromPage(page, () => page.click('#ed-go'))
    await waitRun(root, runId)
    const record = await readRunRecord(path.join(runsDir(root), runId))
    expect(record.groups[0]!.prompt.split('\n').pop()).toBe(KEEP_FRAME_SENTENCE)
    await page.close()
  })

  it('asks before starting with apimart and sends nothing when cancelled', async () => {
    const { server } = await setup()
    const page = await openCollection(server)
    const bodies = recordBodies(page, '/api/new-run')
    // 不发真实出图：new-run 一律拦下返回错误
    await page.route('**/api/new-run', (route) => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'STUBBED', message: '测试拦截' } }) }))
    await page.check(`${group('EF2')} input.cl-pick`)
    await page.click('#ed-engine [data-value="apimart"]')
    expect(await page.locator('#ed-cost').isHidden()).toBe(false)
    await page.click('#ed-go')
    await page.waitForSelector('.ui-sheet.on')
    expect(await page.locator('.ui-sheet').innerText()).toContain('apimart 会产生真实费用，确定用它出图吗？')
    await page.keyboard.press('Escape')
    await waitUntil(async () => (await page.locator('.ui-sheet').count()) === 0)
    await sleep(200)
    expect(bodies).toEqual([])
    await page.click('#ed-go')
    await page.waitForSelector('.ui-sheet.on')
    await Promise.all([page.waitForResponse('**/api/new-run'), page.keyboard.press('Enter')])
    expect(bodies).toEqual([{ groups: { EF2: { models: ['模特/EF2/m1.jpg'] } }, engine: 'apimart' }])
    // 出错改为 toast
    await page.waitForSelector('.ui-toast.is-error')
    expect(await page.locator('.ui-toast.is-error').innerText()).toContain('测试拦截')
    await page.close()
  })

  it('saves quick rule changes one after another and keeps the last one', async () => {
    const { root, server } = await setup()
    const page = await openCollection(server)
    let inFlight = 0
    let maxInFlight = 0
    const bodies: unknown[] = []
    await page.route('**/api/collection/prefs', async (route) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      bodies.push(route.request().postDataJSON())
      await sleep(300)
      await route.continue()
      inFlight -= 1
    })
    const pairing = `${group('EX1')} .ui-seg[data-cl="pairing"]`
    await page.click(seg('EX1', 'pairing', 'fixedModel'))
    await page.click(seg('EX1', 'pairing', 'oneToOne'))
    await page.click(seg('EX1', 'pairing', 'fixedGarment'))
    expect(await segValue(page, pairing)).toBe('fixedGarment')
    // 期间界面不回跳
    for (let index = 0; index < 12; index += 1) {
      await sleep(100)
      expect(await segValue(page, pairing)).toBe('fixedGarment')
    }
    await waitUntil(async () => bodies.length === 3 && inFlight === 0)
    await sleep(100)
    expect(maxInFlight).toBe(1)
    expect(bodies).toEqual([{ sku: 'EX1', pairing: 'fixedModel' }, { sku: 'EX1', pairing: 'oneToOne' }, { sku: 'EX1', pairing: 'fixedGarment' }])
    expect(await segValue(page, pairing)).toBe('fixedGarment')
    expect((await readCollection(root)).groups.EX1?.pairing).toBe('fixedGarment')
    await page.reload()
    await page.waitForSelector('.cl-group')
    expect(await segValue(page, pairing)).toBe('fixedGarment')
    await page.close()
  })

  it('treats two quick half clicks as on then off', async () => {
    const { root, server } = await setup()
    const page = await openCollection(server)
    const bodies: unknown[] = []
    await page.route('**/api/collection/prefs', async (route) => {
      bodies.push(route.request().postDataJSON())
      await sleep(300)
      await route.continue()
    })
    const half = `${group('EX1')} button.cl-half[data-file="模特/EX1/m2.jpg"]`
    await page.click(half)
    await page.click(half)
    await waitUntil(async () => bodies.length === 2)
    await waitUntil(async () => ((await readCollection(root)).groups.EX1?.halfModels ?? ['x']).length === 0)
    expect(bodies).toEqual([{ sku: 'EX1', halfModels: ['模特/EX1/m2.jpg'] }, { sku: 'EX1', halfModels: [] }])
    expect(await page.getAttribute(half, 'aria-pressed')).toBe('false')
    await page.close()
  })

  it('rolls the rule back and shows an error toast when saving fails', async () => {
    const { server } = await setup()
    const page = await openCollection(server)
    await page.route('**/api/collection/prefs', (route) => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { code: 'BAD_REQUEST', message: '保存失败了' } }) }))
    await Promise.all([page.waitForResponse('**/api/collection/prefs'), page.click(seg('EX1', 'pairing', 'fixedModel'))])
    await page.waitForSelector('.ui-toast.is-error')
    expect(await page.locator('.ui-toast.is-error').innerText()).toContain('保存失败了')
    expect(await segValue(page, `${group('EX1')} .ui-seg[data-cl="pairing"]`)).toBe('fixedGarment')
    await page.close()
  })

  it('ends on the saved rule when two quick saves both fail, without jumping back in between', async () => {
    const { root, server } = await setup()
    const page = await openCollection(server)
    let responded = 0
    await page.route('**/api/collection/prefs', async (route) => {
      await sleep(300)
      await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { code: 'BAD_REQUEST', message: '保存失败了' } }) })
      responded += 1
    })
    const pairing = `${group('EX1')} .ui-seg[data-cl="pairing"]`
    await page.click(seg('EX1', 'pairing', 'fixedModel'))
    await page.click(seg('EX1', 'pairing', 'oneToOne'))
    // 第一次失败后、第二次还没回来时，界面仍是最后一次操作
    await waitUntil(async () => responded === 1)
    await sleep(50)
    expect(await segValue(page, pairing)).toBe('oneToOne')
    await page.evaluate('window.__COLLECTION__.prefsQueue("EX1")')
    expect(responded).toBe(2)
    expect(await segValue(page, pairing)).toBe('fixedGarment')
    expect((await readCollection(root)).groups.EX1?.pairing ?? 'fixedGarment').toBe('fixedGarment')
    await page.close()
  })

  it('focuses search with the shortcut, clears it on Esc and starts a run with the shortcut', async () => {
    const { root, server } = await setup()
    const page = await openCollection(server)
    await page.keyboard.press('Control+f')
    expect(await page.evaluate('document.activeElement.id')).toBe('cl-search')
    await page.keyboard.type('ef')
    expect(await skus(page)).toEqual(['EF2'])
    await page.keyboard.press('Escape')
    expect(await page.inputValue('#cl-search')).toBe('')
    expect(await page.evaluate('document.activeElement.id')).not.toBe('cl-search')
    expect(await skus(page)).toEqual(['EF2', 'EG3', 'EX1'])
    await page.check(`${group('EF2')} input.cl-pick`)
    const { request, runId } = await startFromPage(page, () => page.keyboard.press('Control+Enter'))
    expect(request.postDataJSON()).toEqual({ groups: { EF2: { models: ['模特/EF2/m1.jpg'] } } })
    await waitRun(root, runId)
    await page.close()
  })

  it('resizes thumbnails with the slider and remembers the size', async () => {
    const { server } = await setup()
    const page = await openCollection(server)
    const tile = (): Promise<string> => page.evaluate('getComputedStyle(document.documentElement).getPropertyValue("--cl-tile").trim()')
    expect(await page.inputValue('#cl-size')).toBe('84')
    await page.locator('#cl-size').fill('120')
    expect(await tile()).toBe('120px')
    const width = await page.locator(`${group('EX1')} .cl-tile img`).first().evaluate((el) => (el as unknown as { getBoundingClientRect(): { width: number } }).getBoundingClientRect().width)
    expect(width).toBe(120)
    await page.reload()
    await page.waitForSelector('.cl-group')
    expect(await page.inputValue('#cl-size')).toBe('120')
    expect(await tile()).toBe('120px')
    await page.close()
  })
})

describe('collection place mode: drop columns, upload queue, hover actions, quick look', () => {
  const col = (sku: string, kind: string): string => `${group(sku)} .cl-col[data-kind="${kind}"]`

  /** 页面里造一个带文件的 DataTransfer */
  async function transfer(page: Page, files: Array<{ name: string; bytes: number[] }>): Promise<Awaited<ReturnType<Page['evaluateHandle']>>> {
    return page.evaluateHandle(`(() => {
      const transfer = new DataTransfer()
      for (const entry of ${JSON.stringify(files)}) transfer.items.add(new File([new Uint8Array(entry.bytes)], entry.name, { type: 'image/jpeg' }))
      return transfer
    })()`)
  }

  it('highlights the whole model column while files are dragged over it (place)', async () => {
    const { server } = await setup()
    const page = await openCollection(server)
    const dataTransfer = await transfer(page, [{ name: 'x.jpg', bytes: [...await fixtureImageBytes(60)] }])
    await page.dispatchEvent(`${col('EX1', 'model')} h3`, 'dragenter', { dataTransfer })
    await page.dispatchEvent(`${col('EX1', 'model')} h3`, 'dragover', { dataTransfer })
    expect(await page.getAttribute(col('EX1', 'model'), 'class')).toContain('is-over')
    expect(await page.getAttribute(col('EX1', 'garment'), 'class')).not.toContain('is-over')
    await page.dispatchEvent(col('EX1', 'model'), 'dragleave', { dataTransfer })
    expect(await page.getAttribute(col('EX1', 'model'), 'class')).not.toContain('is-over')
    await page.close()
  })

  it('queues a drop into the other column while uploading and places both batches (place)', async () => {
    const { root, server } = await setup()
    const page = await openCollection(server)
    const before = await snapshot(root)
    await page.route('**/api/upload?*', async (route) => {
      await sleep(500)
      await route.continue()
    })
    const models = await Promise.all([61, 62, 63].map(async (seed, index) => ({ name: `q${index + 1}.jpg`, bytes: [...await fixtureImageBytes(seed)] })))
    await page.dispatchEvent(col('EX1', 'model'), 'drop', { dataTransfer: await transfer(page, models) })
    await waitUntil(async () => (await page.locator(`${group('EX1')} .cl-prog`).count()) > 0)
    // 同名 g1.jpg：沿用重名规则，不覆盖原图
    const garment = { name: 'g1.jpg', bytes: [...await fixtureImageBytes(64)] }
    await page.dispatchEvent(col('EX1', 'garment'), 'drop', { dataTransfer: await transfer(page, [garment]) })
    expect(await page.locator(`${col('EX1', 'garment')} h3`).innerText()).toContain('排队中…')
    await waitUntil(async () => (await page.locator(`${group('EX1')} .cl-cnt`).innerText()).startsWith('衣服 4 · 模特 5/5'), 20_000)
    expect(await page.locator(`${col('EX1', 'garment')} h3`).innerText()).not.toContain('排队中')
    await page.waitForSelector('.ui-toast:has-text("模特图放入成功 3 张")')
    await page.waitForSelector('.ui-toast:has-text("服装图放入成功 1 张")')
    const after = await snapshot(root)
    for (const [key, hash] of before) expect(after.get(key)).toBe(hash)
    expect([...after.keys()].filter((key) => !before.has(key)).sort()).toEqual(['服装/EX1/g1 (2).jpg', '模特/EX1/q1.jpg', '模特/EX1/q2.jpg', '模特/EX1/q3.jpg'])
    expect(await readFile(path.join(root, '服装/EX1/g1 (2).jpg'))).toEqual(Buffer.from(garment.bytes))
    await page.close()
  })

  it('shows an error toast with the server message when a placed file is rejected (place)', async () => {
    const { server } = await setup()
    const page = await openCollection(server)
    await page.setInputFiles(`${group('EX1')} .cl-drop[data-kind="garment"] input[type="file"]`, [
      await file('a.jpg', 30), { name: 'a.heic', mimeType: 'image/heic', buffer: Buffer.from('heic') },
    ])
    await page.waitForSelector('.ui-toast:has-text("服装图放入成功 1 张")')
    await page.waitForSelector('.ui-toast.is-error:has-text("a.heic：只支持 jpg、png、webp")')
    await page.close()
  })

  it('marks a model as half from the hover actions (place)', async () => {
    const { root, server } = await setup()
    const page = await openCollection(server)
    const tile = `${col('EX1', 'model')} .cl-tile[data-file="模特/EX1/m2.jpg"]`
    expect(await page.getAttribute(tile, 'data-ql')).toBe('models-EX1')
    await page.hover(tile)
    expect(await page.locator(`${tile} .cl-acts .cl-half`).innerText()).toBe('标半身')
    await Promise.all([page.waitForResponse('**/api/collection/prefs'), page.click(`${tile} .cl-acts .cl-half`)])
    expect((await readCollection(root)).groups.EX1?.halfModels).toEqual(['模特/EX1/m2.jpg'])
    expect(await page.locator(`${tile} .cl-halfmark`).innerText()).toBe('半身')
    // 点「标半身」不改选中
    expect(await page.getAttribute(tile, 'aria-pressed')).toBe('true')
    await page.hover(tile)
    expect(await page.locator(`${tile} .cl-acts .cl-half`).innerText()).toBe('取消半身')
    await page.close()
  })

  it('opens quick look on space from the focused garment and steps with arrows (place)', async () => {
    const { server } = await setup()
    const page = await openCollection(server)
    const tiles = `${col('EX1', 'garment')} .cl-tile[data-ql="garments-EX1"]`
    expect(await page.locator(tiles).count()).toBe(3)
    await page.locator(tiles).nth(1).click()
    expect(await page.getAttribute(`${tiles} >> nth=1`, 'class')).toContain('is-focus')
    expect(await page.locator('.cl-tile.is-focus').count()).toBe(1)
    await page.keyboard.press(' ')
    await page.waitForSelector('.ui-ql.on')
    expect(await page.locator('.ui-ql .ui-ql-name').innerText()).toBe('g2.jpg')
    await page.keyboard.press('ArrowRight')
    expect(await page.locator('.ui-ql .ui-ql-name').innerText()).toBe('g3.jpg')
    await page.keyboard.press('Escape')
    await waitUntil(async () => (await page.locator('.ui-ql').count()) === 0)
    // Tab 聚焦到下一张也设为 is-focus，悬停操作条随键盘聚焦出现
    await page.locator(`${col('EX1', 'model')} .cl-tile`).first().focus()
    expect(await page.getAttribute(`${col('EX1', 'model')} .cl-tile >> nth=0`, 'class')).toContain('is-focus')
    expect(await page.locator('.cl-tile.is-focus').count()).toBe(1)
    const actsOpacity = `getComputedStyle(document.querySelector(${JSON.stringify(`${col('EX1', 'model')} .cl-tile .cl-acts`)})).opacity`
    await waitUntil(async () => (await page.evaluate(actsOpacity)) === '1')
    await page.close()
  })

  it('adds the latest output to redo from its hover actions (place)', async () => {
    const { root, server, launch: config } = await setup()
    const run = await startRunTool({ sourceRoot: root, open: false, skus: ['EF2'] }, config)
    pids.push((await readRunRecord(run.runDir)).pid!)
    await waitUntil(async () => (await readActiveLock(root)) === null, 20_000)
    const page = await openCollection(server)
    const out = `${group('EF2')} .cl-outs .cl-tile.cl-out[data-file="成图/EF2/m1.png"]`
    expect(await page.getAttribute(out, 'data-ql')).toBe('outs-EF2')
    expect(await page.locator('#cl-redo-open .cl-redo-n').innerText()).toBe('0')
    await page.hover(out)
    expect(await page.locator(`${out} .cl-acts .cl-cmp`).innerText()).toBe('对照')
    await Promise.all([page.waitForResponse('**/api/redo'), page.click(`${out} .cl-acts .cl-addredo`)])
    expect(await page.locator('#cl-redo-open .cl-redo-n').innerText()).toBe('1')
    expect(await page.locator(`${out} .cl-addredo`).innerText()).toBe('移出待重出')
    // 已在清单里再点 = 移出
    await page.hover(out)
    await Promise.all([page.waitForResponse('**/api/redo'), page.click(`${out} .cl-acts .cl-addredo`)])
    expect(await page.locator('#cl-redo-open .cl-redo-n').innerText()).toBe('0')
    expect(await page.locator(`${out} .cl-addredo`).innerText()).toBe('待重出')
    await page.hover(out)
    await page.click(`${out} .cl-acts .cl-cmp`)
    expect(await page.locator('#cl-cmp').isHidden()).toBe(false)
    await page.close()
  })

  it('deletes a model and an output from the corner button and brings them back with undo (place)', async () => {
    const { root, server, launch: config } = await setup()
    const run = await startRunTool({ sourceRoot: root, open: false, skus: ['EF2'] }, config)
    pids.push((await readRunRecord(run.runDir)).pid!)
    await waitUntil(async () => (await readActiveLock(root)) === null, 20_000)
    const page = await openCollection(server)
    const present = (file: string): Promise<boolean> => readFile(path.join(root, file)).then(() => true, () => false)
    const out = `${group('EF2')} .cl-outs .cl-tile.cl-out[data-file="成图/EF2/m1.png"]`
    await page.hover(out)
    await Promise.all([page.waitForResponse('**/api/item/delete'), page.click(`${out} .cl-del`)])
    await page.waitForSelector(`${out}`, { state: 'detached' })
    expect(await present('成图/EF2/m1.png')).toBe(false)
    const toast = page.locator('.ui-toast', { hasText: '已删除 m1.png' })
    await Promise.all([page.waitForResponse('**/api/item/restore'), toast.locator('button:has-text("撤销")').click()])
    await page.waitForSelector(out)
    expect(await present('成图/EF2/m1.png')).toBe(true)

    const model = `${group('EF2')} .cl-col[data-kind="model"] .cl-tile[data-file="模特/EF2/m1.jpg"]`
    await page.hover(model)
    await Promise.all([page.waitForResponse('**/api/item/delete'), page.click(`${model} .cl-del`)])
    await page.waitForSelector(model, { state: 'detached' })
    expect(await present('模特/EF2/m1.jpg')).toBe(false)
    expect(await readdir(path.join(root, '成图/_runs/已删除/EF2'))).toHaveLength(1)
    await page.close()
  })

  it('shows outputs larger than garments, with readable action buttons, and opens compare on double click (place)', async () => {
    const { root, server, launch: config } = await setup()
    const run = await startRunTool({ sourceRoot: root, open: false, skus: ['EF2'] }, config)
    pids.push((await readRunRecord(run.runDir)).pid!)
    await waitUntil(async () => (await readActiveLock(root)) === null, 20_000)
    const page = await openCollection(server)
    const out = `${group('EF2')} .cl-outs .cl-tile.cl-out[data-file="成图/EF2/m1.png"]`
    const outBox = await page.locator(`${out} img`).boundingBox()
    const garmentBox = await page.locator(`${group('EF2')} .cl-col[data-kind="garment"] .cl-tile img`).first().boundingBox()
    expect(outBox!.width).toBeGreaterThan(garmentBox!.width * 1.2)
    // 图框不能比图小（否则只露出左上角）
    const frameBox = await page.locator(`${out} .cl-ph`).boundingBox()
    expect(Math.round(frameBox!.width)).toBe(Math.round(outBox!.width))
    expect(Math.round(frameBox!.height)).toBe(Math.round(outBox!.height))
    await page.hover(out)
    const fontSize = `parseFloat(getComputedStyle(document.querySelector(${JSON.stringify(`${out} .cl-acts .cl-cmp`)})).fontSize)`
    expect(await page.evaluate(fontSize)).toBeGreaterThanOrEqual(12)
    // 双击按钮不打开对照，双击图片打开
    await page.dblclick(`${out} .cl-acts .cl-cmp`)
    await page.keyboard.press('Escape')
    await page.waitForSelector('#cl-cmp', { state: 'hidden' })
    await Promise.all([page.waitForResponse('**/api/redo'), page.click(`${out} .cl-acts .cl-addredo`)])
    await page.dblclick(`${out} .cl-acts .cl-addredo`)
    await waitUntil(async () => (await page.locator('#cl-redo-open .cl-redo-n').innerText()) === '1')
    expect(await page.locator('#cl-cmp').isHidden()).toBe(true)
    // 点图片上半部分中间，避开左上角的删除和底部的悬停按钮
    await page.dblclick(`${out} img`, { position: { x: outBox!.width / 2, y: 30 } })
    await page.waitForSelector('#cl-cmp:not([hidden])')
    expect(await page.locator('#cl-cmp-title').innerText()).toContain('EF2')
    await page.close()
  })
})

describe('collection drawer and node mode', () => {
  const drawerOpen = (page: Page): Promise<string | null> => page.getAttribute('#cl-drawer', 'aria-hidden')
  const lane = (sku: string): string => `section.cl-lane[data-sku="${sku}"]`
  const CROP1 = { file: '裁图/EX1/01-全身-正面.jpg', role: '全身-正面' }
  const CROP2 = { file: '裁图/EX1/02-细节-领口.jpg', role: '细节-领口' }

  async function openDrawer(page: Page, sku: string): Promise<void> {
    await page.click(`${group(sku)} button.cl-edit`)
    await page.waitForSelector('#cl-drawer[aria-hidden="false"]')
    // 等滑出动画结束再拖图
    await waitUntil(async () => (await page.evaluate('getComputedStyle(document.getElementById("cl-drawer")).transform')) === 'none')
  }

  it('opens the drawer from the nodes, focuses the title and closes on Esc', async () => {
    const { server } = await setup()
    const page = await openCollection(server)
    expect(await drawerOpen(page)).toBe('true')
    await page.click(mode('node'))
    await page.click(`${lane('EX1')} .cl-setnode .cl-node-edit`)
    await page.waitForSelector('#cl-drawer[aria-hidden="false"]')
    expect(await page.evaluate('document.activeElement.tagName + "|" + (document.activeElement.closest("#cl-drawer") !== null)')).toBe('H2|true')
    expect(await page.locator('#cl-drawer h2').innerText()).toContain('EX1')
    await page.keyboard.press('Escape')
    expect(await drawerOpen(page)).toBe('true')
    await page.click(`${lane('EX1')} .cl-node-garments`)
    await page.waitForSelector('#cl-drawer[aria-hidden="false"]')
    await page.click('#cl-drawer button.cl-close')
    expect(await drawerOpen(page)).toBe('true')
    await page.close()
  })

  it('drops a reference in the fixed garment drawer and submits the shorter list', async () => {
    const { root, server } = await setup()
    const page = await openCollection(server)
    await openDrawer(page, 'EX1')
    const refs = '#cl-drawer .ed-panel .ed-ref'
    await waitUntil(async () => (await page.locator(refs).count()) === 2)
    // 拖到参考图列表外松手 = 移除
    await page.locator(`${refs}[data-index="0"]`).dragTo(page.locator('#cl-drawer h2'))
    await waitUntil(async () => (await page.locator(refs).count()) === 1)
    await waitUntil(async () => (await page.locator(`${group('EX1')} button.cl-edit .cl-flag`).count()) === 1)
    await page.click('#cl-drawer button.cl-close')
    await page.check(`${group('EX1')} input.cl-pick`)
    const { request, runId } = await startFromPage(page, () => page.click('#ed-go'))
    expect(request.postDataJSON()).toEqual({ groups: { EX1: { models: ['模特/EX1/m1.jpg', '模特/EX1/m2.jpg'], references: [CROP2] } } })
    await waitRun(root, runId)
    const record = await readRunRecord(path.join(runsDir(root), runId))
    expect(record.groups[0]!.references.map((ref) => ref.file)).toEqual([CROP2.file])
    expect(record.groups[0]!.promptEdited).toBe(false)
    await page.close()
  })

  it('picks one reference per garment under fixed model, defaulting to its crop', async () => {
    const { root, server } = await setup()
    const page = await openCollection(server)
    await page.click(`${group('EX1')} .cl-tile[data-file="模特/EX1/m2.jpg"]`)
    await openDrawer(page, 'EX1')
    await Promise.all([page.waitForResponse('**/api/collection/prefs'), page.click(drawerSeg('pairing', 'fixedModel'))])
    await page.evaluate(`window.__COLLECTION__.prefsQueue('EX1')`)
    expect((await readCollection(root)).groups.EX1?.pairing).toBe('fixedModel')
    expect(await segValue(page, `${group('EX1')} .ui-seg[data-cl="pairing"]`)).toBe('fixedModel')
    await page.waitForSelector(itemRef('服装/EX1/g1.jpg'))
    expect(await page.locator('#cl-drawer .ed-ref').count()).toBe(0)
    expect(await page.getAttribute(itemRef('服装/EX1/g1.jpg'), 'data-value')).toBe(CROP1.file)
    expect(await page.getAttribute(itemRef('服装/EX1/g2.jpg'), 'data-value')).toBe(CROP2.file)
    expect(await page.getAttribute(itemRef('服装/EX1/g3.jpg'), 'data-value')).toBe('服装/EX1/g3.jpg')
    await page.click(itemRef('服装/EX1/g1.jpg'))
    await page.waitForSelector('.ui-menu.on')
    expect(await menuValues(page)).toEqual(['服装/EX1/g1.jpg', CROP1.file, CROP2.file])
    await page.click('.ui-menu.on [role="menuitem"][data-value="服装/EX1/g1.jpg"]')
    await waitUntil(async () => (await page.locator(`${group('EX1')} button.cl-edit .cl-flag`).count()) === 1)
    await page.click('#cl-drawer button.cl-close')
    expect(await page.locator(`${group('EX1')} .cl-cnt`).innerText()).toBe('衣服 3 · 模特 1/2 · 将出 3 张')
    await page.check(`${group('EX1')} input.cl-pick`)
    const { request, runId } = await startFromPage(page, () => page.click('#ed-go'))
    expect(request.postDataJSON()).toEqual({ groups: { EX1: {
      models: ['模特/EX1/m1.jpg'],
      garments: ['服装/EX1/g1.jpg', '服装/EX1/g2.jpg', '服装/EX1/g3.jpg'],
      itemRefs: { '服装/EX1/g1.jpg': '服装/EX1/g1.jpg' },
    } } })
    await waitRun(root, runId)
    const record = await readRunRecord(path.join(runsDir(root), runId))
    const refsOf = (item: string) => record.groups.find((entry) => entry.item === item)!.references.map((ref) => ref.file)
    expect(refsOf('服装/EX1/g1.jpg')).toEqual(['服装/EX1/g1.jpg'])
    expect(refsOf('服装/EX1/g2.jpg')).toEqual([CROP2.file])
    expect((await readdir(path.join(root, '成图/EX1'))).sort()).toEqual(['g1-m1.png', 'g2-m1.png', 'g3-m1.png'])
    await page.close()
  })

  it('picks a garment reference from the popup menu in the drawer', async () => {
    const { server } = await setup()
    const page = await openCollection(server)
    await page.click(`${group('EX1')} .cl-tile[data-file="模特/EX1/m2.jpg"]`)
    await openDrawer(page, 'EX1')
    await Promise.all([page.waitForResponse('**/api/collection/prefs'), page.click(drawerSeg('pairing', 'fixedModel'))])
    const ref = itemRef('服装/EX1/g2.jpg')
    await page.waitForSelector(ref)
    expect(await page.getAttribute(ref, 'aria-haspopup')).toBe('menu')
    expect(await page.locator(ref).innerText()).toContain('02-细节-领口.jpg')
    await page.click(ref)
    await page.waitForSelector('.ui-menu.on')
    // 原图与 2 张裁图，都带缩略图；当前项打勾
    expect(await menuValues(page)).toEqual(['服装/EX1/g2.jpg', CROP2.file, CROP1.file])
    expect(await page.locator('.ui-menu.on [role="menuitem"]').first().innerText()).toContain('g2.jpg（原图）')
    expect(await page.locator('.ui-menu.on [role="menuitem"] img').count()).toBe(3)
    expect(await page.locator(`.ui-menu.on [role="menuitem"][data-value="${CROP2.file}"] .ui-ck`).count()).toBe(1)
    // 选第 2 张裁图
    await page.locator('.ui-menu.on [role="menuitem"]').nth(2).click()
    await page.waitForSelector('.ui-menu', { state: 'detached' })
    expect(await drawerOpen(page)).toBe('false')
    await waitUntil(async () => (await page.getAttribute(ref, 'data-value')) === CROP1.file)
    expect(await page.locator(ref).innerText()).toContain('01-全身-正面.jpg')
    expect(await page.getAttribute(`${ref} img`, 'src')).toContain(encodeURIComponent('01-全身-正面.jpg'))
    expect(await page.evaluate(`window.__COLLECTION_DRAWER__.selection('EX1').itemRefs['服装/EX1/g2.jpg']`)).toBe(CROP1.file)
    await page.close()
  })

  it('closes the drawer on Esc and on a click outside it', async () => {
    const { server } = await setup()
    const page = await openCollection(server)
    await openDrawer(page, 'EX1')
    // 抽屉里点击不关
    await page.click('#cl-drawer h2')
    expect(await drawerOpen(page)).toBe('false')
    await page.keyboard.press('Escape')
    expect(await drawerOpen(page)).toBe('true')
    await openDrawer(page, 'EX1')
    // 打开时页面其余部分可滚动
    await page.mouse.wheel(0, 200)
    expect(await drawerOpen(page)).toBe('false')
    await page.mouse.click(40, 450)
    expect(await drawerOpen(page)).toBe('true')
    await page.close()
  })

  it('changes rule, scope and frame right on the settings node in sync with the head and drawer', async () => {
    const { root, server } = await setup()
    const page = await openCollection(server)
    const bodies = recordBodies(page, '/api/collection/prefs')
    await page.click(mode('node'))
    const node = `${lane('EX1')} .cl-setnode`
    const head = `${group('EX1')} .cl-head`
    await page.waitForSelector(node)
    await Promise.all([page.waitForResponse('**/api/collection/prefs'), page.click(`${node} .ui-seg[data-cl="pairing"] [data-value="oneToOne"]`)])
    expect(bodies).toEqual([{ sku: 'EX1', pairing: 'oneToOne' }])
    expect(await segValue(page, `${head} .ui-seg[data-cl="pairing"]`)).toBe('oneToOne')
    // 在节点上改不打开抽屉
    expect(await drawerOpen(page)).toBe('true')
    await page.click(`${node} .ui-seg[data-cl="swap"] [data-value="top"]`)
    expect(await segValue(page, `${head} .ui-seg[data-cl="swap"]`)).toBe('top')
    await Promise.all([page.waitForResponse('**/api/collection/prefs'), page.click(`${node} .ui-switch[data-cl="keep"]`)])
    expect(bodies).toEqual([{ sku: 'EX1', pairing: 'oneToOne' }, { sku: 'EX1', keepFrame: true }])
    expect(await isOn(page, `${head} .ui-switch[data-cl="keep"]`)).toBe(true)
    // 抽屉显示同样的设置；组头再改，抽屉与节点跟着变
    await page.click(`${node} .cl-node-edit`)
    await page.waitForSelector('#cl-drawer[aria-hidden="false"]')
    expect(await segValue(page, '#cl-drawer .ui-seg[data-cl="pairing"]')).toBe('oneToOne')
    expect(await segValue(page, '#cl-drawer .ui-seg[data-cl="swap"]')).toBe('top')
    expect(await isOn(page, drawerKeep)).toBe(true)
    // 抽屉开着时组头可能被抽屉盖住，直接派发点击
    await Promise.all([
      page.waitForResponse('**/api/collection/prefs'),
      page.evaluate(`document.querySelector('${head} .ui-seg[data-cl="pairing"] [data-value="fixedModel"]').click()`),
    ])
    await waitUntil(async () => (await segValue(page, '#cl-drawer .ui-seg[data-cl="pairing"]')) === 'fixedModel')
    expect(await segValue(page, `${node} .ui-seg[data-cl="pairing"]`)).toBe('fixedModel')
    // 抽屉里改也走同一保存逻辑
    await Promise.all([page.waitForResponse('**/api/collection/prefs'), page.click(drawerKeep)])
    await page.evaluate(`window.__COLLECTION__.prefsQueue('EX1')`)
    expect(bodies.at(-1)).toEqual({ sku: 'EX1', keepFrame: false })
    expect(await isOn(page, `${node} .ui-switch[data-cl="keep"]`)).toBe(false)
    expect(await isOn(page, `${head} .ui-switch[data-cl="keep"]`)).toBe(false)
    expect((await readCollection(root)).groups.EX1).toMatchObject({ pairing: 'fixedModel', keepFrame: false })
    await page.close()
  })

  it('appends the keep frame sentence from the drawer and saves it', async () => {
    const { root, server } = await setup()
    const page = await openCollection(server)
    await openDrawer(page, 'EX1')
    const area = '#cl-drawer .ed-prompt'
    await page.waitForSelector(area)
    const plain = defaultPrompt([CROP1, CROP2], 'outfit')
    await waitUntil(async () => (await page.inputValue(area)) === plain)
    await Promise.all([page.waitForResponse('**/api/collection/prefs'), page.click(drawerKeep)])
    await waitUntil(async () => (await page.inputValue(area)).split('\n').pop() === KEEP_FRAME_SENTENCE)
    expect(await page.inputValue(area)).toBe(`${plain}\n${KEEP_FRAME_SENTENCE}`)
    expect(await page.locator('#cl-drawer .ed-edited').count()).toBe(0)
    expect((await readCollection(root)).groups.EX1?.keepFrame).toBe(true)
    expect(await isOn(page, keepSwitch('EX1'))).toBe(true)
    // 只改保持画幅不算编辑
    expect(await page.locator(`${group('EX1')} button.cl-edit .cl-flag`).count()).toBe(0)
    expect(await isOn(page, drawerKeep)).toBe(true)
    await Promise.all([page.waitForResponse('**/api/collection/prefs'), page.click(drawerKeep)])
    await waitUntil(async () => (await page.inputValue(area)) === plain)
    await page.close()
  })

  it('restores references and prompt but keeps the rule and scope', async () => {
    const { root, server } = await setup()
    const page = await openCollection(server)
    await openDrawer(page, 'EX1')
    const refs = '#cl-drawer .ed-panel .ed-ref'
    const area = '#cl-drawer .ed-prompt'
    await waitUntil(async () => (await page.locator(refs).count()) === 2)
    await page.click(drawerSeg('swap', 'top'))
    expect(await segValue(page, `${group('EX1')} .ui-seg[data-cl="swap"]`)).toBe('top')
    const top = defaultPrompt([CROP1, CROP2], 'top')
    await waitUntil(async () => (await page.inputValue(area)) === top)
    await page.click(`${refs}[data-index="1"] button[data-act="remove"]`)
    await waitUntil(async () => (await page.locator(refs).count()) === 1)
    // 等移除触发的默认提示词回来再输入，否则会被默认值盖掉
    await waitUntil(async () => (await page.inputValue(area)) === defaultPrompt([CROP1], 'top'))
    await page.fill(area, '自定义提示词')
    await page.waitForSelector('#cl-drawer .ed-edited')
    expect(await page.locator(`${group('EX1')} button.cl-edit .cl-flag`).count()).toBe(1)
    // 工作表确认：Esc 取消，什么都不变
    await page.click('#cl-drawer button.cl-restore')
    await page.waitForSelector('.ui-sheet.on')
    expect(await page.locator('.ui-sheet h3').innerText()).toBe('恢复默认？')
    expect(await page.locator('.ui-sheet p').innerText()).toBe('参考图和提示词回到默认，搭配规则与换装范围不变。')
    expect(await page.locator('.ui-sheet [data-answer="1"]').innerText()).toBe('恢复默认')
    await page.keyboard.press('Escape')
    await page.waitForSelector('.ui-sheet', { state: 'detached' })
    expect(await drawerOpen(page)).toBe('false')
    expect(await page.inputValue(area)).toBe('自定义提示词')
    expect(await page.locator(refs).count()).toBe(1)
    // 回车确认：恢复默认
    await page.click('#cl-drawer button.cl-restore')
    await page.waitForSelector('.ui-sheet.on')
    await page.keyboard.press('Enter')
    await waitUntil(async () => (await page.locator(refs).count()) === 2)
    await waitUntil(async () => (await page.inputValue(area)) === top)
    expect(await page.locator(`${group('EX1')} button.cl-edit .cl-flag`).count()).toBe(0)
    expect(await segValue(page, '#cl-drawer .ui-seg[data-cl="swap"]')).toBe('top')
    expect(await segValue(page, '#cl-drawer .ui-seg[data-cl="pairing"]')).toBe('fixedGarment')
    expect((await readCollection(root)).groups.EX1).toBeUndefined()
    await page.close()
  })

  it('marks the edit button when an edited prompt may not match the references', async () => {
    const { server } = await setup()
    const page = await openCollection(server)
    await openDrawer(page, 'EX1')
    const refs = '#cl-drawer .ed-panel .ed-ref'
    const area = '#cl-drawer .ed-prompt'
    const edit = `${group('EX1')} button.cl-edit`
    await waitUntil(async () => (await page.inputValue(area)) === defaultPrompt([CROP1, CROP2], 'outfit'))
    await page.fill(area, '自定义提示词')
    await waitUntil(async () => (await page.locator(`${edit} .cl-flag`).count()) === 1)
    expect(await page.locator(`${edit}.is-stale`).count()).toBe(0)
    expect(await page.locator(edit).innerText()).toBe('编辑 · 已改')
    // 改过提示词后参考图又变了
    await page.click(`${refs}[data-index="1"] button[data-act="remove"]`)
    await page.waitForSelector(`${edit}.is-stale`)
    expect(await page.locator(edit).innerText()).toBe('编辑 · 提示词可能对不上')
    // 提示词恢复默认后不再提示
    await page.click('#cl-drawer .ed-panel .ed-restore')
    await waitUntil(async () => (await page.locator(`${edit}.is-stale`).count()) === 0)
    expect(await page.locator(edit).innerText()).toBe('编辑 · 已改')
    await page.close()
  })

  it('shows one row per combo with versions, toggles models and adds to redo', async () => {
    const { root, server, launch: config } = await setup()
    // Finder 里手放的成图：没有出图记录
    await mkdir(path.join(root, '成图/EX1'), { recursive: true })
    await writeFile(path.join(root, '成图/EX1/m1.png'), await fixtureImageBytes(80, 'png'))
    await writeFile(path.join(root, '成图/EX1/m1-v2.png'), await fixtureImageBytes(81, 'png'))
    const run = await startRunTool({ sourceRoot: root, open: false, skus: ['EF2'] }, config)
    pids.push((await readRunRecord(run.runDir)).pid!)
    await waitUntil(async () => (await readActiveLock(root)) === null, 20_000)
    const page = await openCollection(server)
    await page.click(mode('node'))
    await page.waitForSelector(lane('EX1'))
    const row = (sku: string, model: string): string => `${lane(sku)} .cl-row[data-model="${model}"]`
    const versions = page.locator(`${row('EX1', '模特/EX1/m1.jpg')} button.cl-ver`)
    expect(await versions.evaluateAll((els) => els.map((el) => el.getAttribute('data-file')))).toEqual(['成图/EX1/m1.png', '成图/EX1/m1-v2.png'])
    const first = await versions.first().boundingBox()
    const last = await versions.last().boundingBox()
    expect(last!.width).toBeGreaterThan(first!.width)
    expect(await page.locator(`${lane('EX1')} .cl-row`).count()).toBe(2)
    expect(await page.locator(`${row('EX1', '模特/EX1/m2.jpg')} .cl-node-outs`).innerText()).toContain('未出图')
    // 手放的成图没有出图记录，不能加入待重出
    expect(await page.locator(`${row('EX1', '模特/EX1/m1.jpg')} button.cl-add-redo`).isDisabled()).toBe(true)
    expect(await segValue(page, `${lane('EX1')} .cl-setnode .ui-seg[data-cl="swap"]`)).toBe('outfit')
    expect(await segValue(page, `${lane('EX1')} .cl-setnode .ui-seg[data-cl="pairing"]`)).toBe('fixedGarment')
    expect(await isOn(page, `${lane('EX1')} .cl-setnode .ui-switch[data-cl="keep"]`)).toBe(false)
    expect(await page.locator(`${lane('EX1')} .cl-setnode dl`).innerText()).toMatch(/2 张（含裁图）[\s\S]*默认/)
    expect(await page.locator(`${lane('EX1')} .cl-node-garments`).innerText()).toContain('衣服 3')
    expect(await page.locator(`${lane('EX1')} .cl-node-garments img`).count()).toBe(3)

    await page.click(`${row('EX1', '模特/EX1/m2.jpg')} .cl-node-model`)
    expect(await page.getAttribute(row('EX1', '模特/EX1/m2.jpg'), 'class')).toContain('is-off')
    expect(await page.getAttribute(row('EX1', '模特/EX1/m1.jpg'), 'class')).not.toContain('is-off')
    expect(await page.locator(`${group('EX1')} .cl-cnt`).innerText()).toBe('衣服 3 · 模特 1/2 · 将出 1 张')

    await Promise.all([page.waitForResponse('**/api/redo'), page.click(`${row('EF2', '模特/EF2/m1.jpg')} button.cl-add-redo`)])
    expect(await page.locator('#cl-redo-open .cl-redo-n').innerText()).toBe('1')
    expect((await readCollection(root)).redo.map((entry) => entry.delivered)).toEqual(['成图/EF2/m1.png'])
    // 已在待重出的可以点「移出待重出」取消，再点加回
    const nodeRedo = `${row('EF2', '模特/EF2/m1.jpg')} button.cl-add-redo`
    expect(await page.locator(nodeRedo).innerText()).toBe('移出待重出')
    await Promise.all([page.waitForResponse('**/api/redo'), page.click(nodeRedo)])
    expect((await readCollection(root)).redo).toEqual([])
    await Promise.all([page.waitForResponse('**/api/redo'), page.click(nodeRedo)])
    expect((await readCollection(root)).redo.map((entry) => entry.delivered)).toEqual(['成图/EF2/m1.png'])

    // 往衣服节点上拖图 = 放入衣服图
    const bytes = [...await fixtureImageBytes(82)]
    const dataTransfer = await page.evaluateHandle(`(() => {
      const transfer = new DataTransfer()
      transfer.items.add(new File([new Uint8Array(${JSON.stringify(bytes)})], 'n1.jpg', { type: 'image/jpeg' }))
      return transfer
    })()`)
    await page.dispatchEvent(`${lane('EX1')} .cl-node-garments`, 'drop', { dataTransfer })
    await waitUntil(async () => (await page.locator(`${lane('EX1')} .cl-node-garments`).innerText()).includes('衣服 4'))
    expect(await readFile(path.join(root, '服装/EX1/n1.jpg'))).toEqual(Buffer.from(bytes))
    await page.close()
  })

  it('warns before leaving with drawer edits but not with only picks', async () => {
    const { server } = await setup()
    const page = await openCollection(server)
    await openDrawer(page, 'EX1')
    await page.waitForSelector('#cl-drawer .ed-prompt')
    await page.fill('#cl-drawer .ed-prompt', '改过的提示词')
    await page.click('#cl-drawer button.cl-close')
    const waiting = page.waitForEvent('dialog')
    const reloading = page.reload({ timeout: 2000 }).catch(() => undefined)
    const dialog = await waiting
    expect(dialog.type()).toBe('beforeunload')
    await dialog.dismiss()
    await reloading
    await page.close()

    const picked = await openCollection(server)
    const dialogs: string[] = []
    picked.on('dialog', (shown) => { dialogs.push(shown.type()); void shown.accept() })
    await picked.check(`${group('EX1')} input.cl-pick`)
    await picked.reload()
    await picked.waitForSelector('.cl-group')
    expect(dialogs).toEqual([])
    await picked.close()
  })
})

describe('collection compare and redo list', () => {
  const cmpImgs = (page: Page): Promise<string[]> =>
    page.locator('#cl-cmp-body img').evaluateAll((els) => els.map((el) => decodeURIComponent(new URL((el as unknown as { src: string }).src).pathname)))

  /** 在页面里经编辑服务新建一次出图并等它跑完 */
  async function runViaApi(page: Page, root: string, body: unknown): Promise<string> {
    const { runId } = await page.evaluate(`window.__EDITOR_PANEL__.api('POST', '/api/new-run', ${JSON.stringify(body)})`) as { runId: string }
    const record = await readRunRecord(path.join(runsDir(root), runId))
    if (record.pid !== null) pids.push(record.pid)
    await waitUntil(async () => (await readRunRecord(path.join(runsDir(root), runId))).status !== 'running', 20_000)
    return runId
  }

  it('compares a hand placed output with the model image and switches versions', async () => {
    const { root, server } = await setup()
    await mkdir(path.join(root, '成图/EX1'), { recursive: true })
    await writeFile(path.join(root, '成图/EX1/m1.png'), await fixtureImageBytes(80, 'png'))
    await writeFile(path.join(root, '成图/EX1/m1-v2.png'), await fixtureImageBytes(81, 'png'))
    const page = await openCollection(server)
    expect(await page.locator('#cl-cmp').isHidden()).toBe(true)
    await page.click(`${group('EX1')} .cl-outs .cl-out[data-file="成图/EX1/m1-v2.png"] .cl-cmp`)
    await page.waitForSelector('#cl-cmp:not([hidden])')
    expect(await page.getAttribute('#cl-cmp', 'role')).toBe('dialog')
    expect(await page.locator('#cl-cmp-title').innerText()).toContain('EX1')
    expect(await cmpImgs(page)).toEqual(['/source/裁图/EX1/01-全身-正面.jpg', '/source/裁图/EX1/02-细节-领口.jpg', '/source/成图/EX1/m1-v2.png', '/source/模特/EX1/m1.jpg'])
    const tabs = page.locator('#cl-cmp.cl-compare .ui-seg[data-cl="version"] [role="radio"]')
    expect(await tabs.evaluateAll((els) => els.map((el) => el.getAttribute('data-value')))).toEqual(['成图/EX1/m1.png', '成图/EX1/m1-v2.png'])
    expect(await tabs.last().getAttribute('aria-checked')).toBe('true')
    await tabs.first().click()
    expect(await cmpImgs(page)).toEqual(['/source/裁图/EX1/01-全身-正面.jpg', '/source/裁图/EX1/02-细节-领口.jpg', '/source/成图/EX1/m1.png', '/source/模特/EX1/m1.jpg'])
    // 手放成图没有出图记录：不能加入待重出，也没有出图记录链接
    expect(await page.locator('#cl-cmp-add').isHidden()).toBe(true)
    expect(await page.locator('a#cl-cmp-run').isHidden()).toBe(true)
    await page.keyboard.press('Escape')
    expect(await page.locator('#cl-cmp').isHidden()).toBe(true)
    // 节点模式的版本也能打开；点遮罩关闭
    await page.click(mode('node'))
    await page.click(`section.cl-lane[data-sku="EX1"] button.cl-ver[data-file="成图/EX1/m1.png"]`)
    await page.waitForSelector('#cl-cmp:not([hidden])')
    expect(await tabs.first().getAttribute('aria-checked')).toBe('true')
    await page.mouse.click(5, 5)
    expect(await page.locator('#cl-cmp').isHidden()).toBe(true)
    await page.close()
  })

  it('shows the garment reference on the left for fixed model outputs', async () => {
    const { root, server } = await setup()
    const page = await openCollection(server)
    await page.evaluate(`window.__EDITOR_PANEL__.api('POST', '/api/collection/prefs', { sku: 'EX1', pairing: 'fixedModel' })`)
    await runViaApi(page, root, { groups: { EX1: { models: ['模特/EX1/m1.jpg'], garments: ['服装/EX1/g1.jpg', '服装/EX1/g3.jpg'] } } })
    await page.reload()
    await page.waitForSelector(`${group('EX1')} .cl-outs .cl-out[data-file="成图/EX1/g1-m1.png"]`)
    await page.click(`${group('EX1')} .cl-outs .cl-out[data-file="成图/EX1/g1-m1.png"] .cl-cmp`)
    await page.waitForSelector('#cl-cmp:not([hidden])')
    expect(await cmpImgs(page)).toEqual(['/source/裁图/EX1/01-全身-正面.jpg', '/source/成图/EX1/g1-m1.png', '/source/模特/EX1/m1.jpg'])
    await page.click('#cl-cmp-close')
    await page.click(`${group('EX1')} .cl-outs .cl-out[data-file="成图/EX1/g3-m1.png"] .cl-cmp`)
    expect(await cmpImgs(page)).toEqual(['/source/服装/EX1/g3.jpg', '/source/成图/EX1/g3-m1.png', '/source/模特/EX1/m1.jpg'])
    expect(await page.locator('#cl-cmp-add').isVisible()).toBe(true)
    await page.close()
  })

  it('keeps showing the reference the output was made with after the drawer changes it', async () => {
    const { root, server } = await setup()
    const page = await openCollection(server)
    await page.evaluate(`window.__EDITOR_PANEL__.api('POST', '/api/collection/prefs', { sku: 'EX1', pairing: 'fixedModel' })`)
    await runViaApi(page, root, { groups: { EX1: { models: ['模特/EX1/m1.jpg'], garments: ['服装/EX1/g1.jpg'] } } })
    await page.reload()
    await page.waitForSelector(`${group('EX1')} .cl-outs .cl-out[data-file="成图/EX1/g1-m1.png"]`)
    // 出图后在抽屉里把 g1 的参考图从裁图改回原图
    await page.click(`${group('EX1')} button.cl-edit`)
    await page.waitForSelector('#cl-drawer[aria-hidden="false"]')
    await page.waitForSelector(itemRef('服装/EX1/g1.jpg'))
    await page.click(itemRef('服装/EX1/g1.jpg'))
    await page.click('.ui-menu.on [role="menuitem"][data-value="服装/EX1/g1.jpg"]')
    await waitUntil(async () => (await page.locator(`${group('EX1')} button.cl-edit .cl-flag`).count()) === 1)
    await page.click('#cl-drawer button.cl-close')
    await page.click(`${group('EX1')} .cl-outs .cl-out[data-file="成图/EX1/g1-m1.png"] .cl-cmp`)
    await page.waitForSelector('#cl-cmp:not([hidden])')
    expect(await cmpImgs(page)).toEqual(['/source/裁图/EX1/01-全身-正面.jpg', '/source/成图/EX1/g1-m1.png', '/source/模特/EX1/m1.jpg'])
    expect(await page.locator('#cl-cmp-body figcaption').nth(0).innerText()).toBe('服装图 · 01-全身-正面.jpg')
    await page.close()
  })

  it('adds to the redo list from the compare, keeps notes and reruns with them', async () => {
    const { root, server, launch: config } = await setup()
    const first = await startRunTool({ sourceRoot: root, open: false, skus: ['EF2'] }, config)
    pids.push((await readRunRecord(first.runDir)).pid!)
    await waitUntil(async () => (await readActiveLock(root)) === null, 20_000)
    const page = await openCollection(server)
    expect(await page.locator('#cl-redo-open .cl-redo-n').innerText()).toBe('0')
    await page.click(`${group('EF2')} .cl-outs .cl-out[data-file="成图/EF2/m1.png"] .cl-cmp`)
    await page.waitForSelector('#cl-cmp:not([hidden])')
    expect(await page.getAttribute('a#cl-cmp-run', 'href')).toBe(`/runs/${first.runId}/`)
    await Promise.all([page.waitForResponse('**/api/redo'), page.click('#cl-cmp-add')])
    expect(await page.locator('#cl-redo-open .cl-redo-n').innerText()).toBe('1')
    expect((await readCollection(root)).redo.map((entry) => entry.delivered)).toEqual(['成图/EF2/m1.png'])
    await page.keyboard.press('Escape')
    // 节点模式该版本标「待重出」
    await page.click(mode('node'))
    expect(await page.locator(`section.cl-lane[data-sku="EF2"] button.cl-ver[data-file="成图/EF2/m1.png"]`).innerText()).toContain('待重出')
    await page.reload()
    await page.waitForSelector('.cl-group')
    expect(await page.locator('#cl-redo-open .cl-redo-n').innerText()).toBe('1')

    await page.click('#cl-redo-open')
    await page.waitForSelector('#cl-redo:not([hidden])')
    const item = page.locator('#cl-redo li.cl-redo-item[data-delivered="成图/EF2/m1.png"]')
    expect(await item.count()).toBe(1)
    expect(await item.innerText()).toMatch(/EF2[\s\S]*m1\.jpg[\s\S]*v1/)
    expect(await page.locator('#cl-redo-go').innerText()).toBe('重出这 1 张')
    await page.fill('#cl-redo input.cl-redo-note', '腿部站姿')
    await Promise.all([page.waitForResponse('**/api/redo'), page.locator('#cl-redo-title').click()])
    expect((await readCollection(root)).redo[0]?.note).toBe('腿部站姿')
    await page.reload()
    await page.waitForSelector('.cl-group')
    await page.click('#cl-redo-open')
    expect(await page.inputValue('#cl-redo input.cl-redo-note')).toBe('腿部站姿')

    // 重出后留在合集页并关闭待重出面板：toast 带出图记录链接
    await page.click('#cl-redo-go')
    await page.waitForSelector('.ui-toast:has-text("已开始重出 1 张")')
    expect(await page.locator('#cl-redo').isHidden()).toBe(true)
    const href = await page.locator('.ui-toast:has-text("已开始重出 1 张") a.ui-toast-link').getAttribute('href')
    expect(await page.locator('.ui-toast:has-text("已开始重出 1 张") a.ui-toast-link').innerText()).toBe('查看出图记录')
    const runId = new URL(href!, server.origin).pathname.split('/')[2]!
    const started = await readRunRecord(path.join(runsDir(root), runId))
    if (started.pid !== null) pids.push(started.pid)
    await waitUntil(async () => (await readRunRecord(path.join(runsDir(root), runId))).status !== 'running', 20_000)
    expect(runId).not.toBe(first.runId)
    const record = await readRunRecord(path.join(runsDir(root), runId))
    expect(record.groups[0]!.shots[0]!.extraPrompt).toContain('腿部站姿')
    expect((await readCollection(root)).redo).toEqual([])
    await page.goto(editorMaterialsUrl(server.origin, server.token))
    await page.waitForSelector('.cl-group')
    expect(await page.locator('#cl-redo-open .cl-redo-n').innerText()).toBe('0')
    await page.close()
  })

  it('removes redo items and disables rerun while a run is going', async () => {
    const { root, server, launch: config } = await setup()
    const first = await startRunTool({ sourceRoot: root, open: false, skus: ['EF2'] }, config)
    pids.push((await readRunRecord(first.runDir)).pid!)
    await waitUntil(async () => (await readActiveLock(root)) === null, 20_000)
    const page = await openCollection(server)
    await page.click(`${group('EF2')} .cl-outs .cl-out[data-file="成图/EF2/m1.png"] .cl-cmp`)
    await Promise.all([page.waitForResponse('**/api/redo'), page.click('#cl-cmp-add')])
    await page.click('#cl-cmp-close')
    expect(await page.locator('#cl-cmp').isHidden()).toBe(true)
    const running = await startRunTool({ sourceRoot: root, open: false, skus: ['EX1'] }, { ...config, env: { ...config.env, FASHION_TRYON_FAKE_ENGINE: JSON.stringify({ delayMs: 2500 }) } })
    pids.push((await readRunRecord(running.runDir)).pid!)
    await Promise.all([page.waitForResponse('**/api/collection'), page.click('#cl-refresh')])
    await page.click('#cl-redo-open')
    await page.waitForSelector('#cl-redo:not([hidden])')
    expect(await page.locator('#cl-redo-go').isDisabled()).toBe(true)
    await Promise.all([page.waitForResponse('**/api/redo'), page.click('#cl-redo button.cl-redo-del')])
    expect(await page.locator('#cl-redo li.cl-redo-item').count()).toBe(0)
    expect(await page.locator('#cl-redo-open .cl-redo-n').innerText()).toBe('0')
    expect((await readCollection(root)).redo).toEqual([])
    await page.click('#cl-redo button.cl-close-x')
    expect(await page.locator('#cl-redo').isHidden()).toBe(true)
    await waitUntil(async () => (await readActiveLock(root)) === null, 20_000)
    await page.close()
  })
  it('keeps a redo item in the list when removing it fails', async () => {
    const { root, server, launch: config } = await setup()
    const first = await startRunTool({ sourceRoot: root, open: false, skus: ['EF2'] }, config)
    pids.push((await readRunRecord(first.runDir)).pid!)
    await waitUntil(async () => (await readActiveLock(root)) === null, 20_000)
    const page = await openCollection(server)
    await page.click(`${group('EF2')} .cl-outs .cl-out[data-file="成图/EF2/m1.png"] .cl-cmp`)
    await Promise.all([page.waitForResponse('**/api/redo'), page.click('#cl-cmp-add')])
    await page.click('#cl-cmp-close')
    await page.click('#cl-redo-open')
    await page.waitForSelector('#cl-redo:not([hidden])')
    // 让移除请求失败
    await page.route('**/api/redo', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INTERNAL', message: '移除失败' } }) }))
    await Promise.all([page.waitForResponse('**/api/redo'), page.click('#cl-redo button.cl-redo-del')])
    await page.waitForSelector('#cl-redo-msg .ed-err')
    expect(await page.locator('#cl-redo-msg').innerText()).toContain('移除失败')
    expect(await page.locator('#cl-redo li.cl-redo-item[data-delivered="成图/EF2/m1.png"]').count()).toBe(1)
    expect(await page.locator('#cl-redo button.cl-redo-del').isDisabled()).toBe(false)
    expect(await page.locator('#cl-redo-open .cl-redo-n').innerText()).toBe('1')
    expect((await readCollection(root)).redo.map((entry) => entry.delivered)).toEqual(['成图/EF2/m1.png'])
    await page.close()
  })
})

describe('collection compare, redo panel and progress', () => {
  const cmpImgs = (page: Page): Promise<string[]> =>
    page.locator('#cl-cmp-body img').evaluateAll((els) => els.map((el) => decodeURIComponent(new URL((el as unknown as { src: string }).src).pathname)))
  const version = '#cl-cmp.cl-compare .ui-seg[data-cl="version"]'

  /** 跑完一次 EF2，返回它的 runId（成图/EF2/m1.png 有出图记录） */
  async function deliverEF2(root: string, config: LaunchConfig): Promise<string> {
    const first = await startRunTool({ sourceRoot: root, open: false, skus: ['EF2'] }, config)
    pids.push((await readRunRecord(first.runDir)).pid!)
    await waitUntil(async () => (await readActiveLock(root)) === null, 20_000)
    return first.runId
  }

  it('compare switches versions with the arrow keys and closes with Esc', async () => {
    const { root, server } = await setup()
    await mkdir(path.join(root, '成图/EX1'), { recursive: true })
    await writeFile(path.join(root, '成图/EX1/m1.png'), await fixtureImageBytes(80, 'png'))
    await writeFile(path.join(root, '成图/EX1/m1-v2.png'), await fixtureImageBytes(81, 'png'))
    const page = await openCollection(server)
    await page.click(`${group('EX1')} .cl-outs .cl-out[data-file="成图/EX1/m1-v2.png"] .cl-cmp`)
    await page.waitForSelector('#cl-cmp:not([hidden])')
    expect(await segValue(page, version)).toBe('成图/EX1/m1-v2.png')
    await page.keyboard.press('ArrowLeft')
    expect(await segValue(page, version)).toBe('成图/EX1/m1.png')
    expect(await cmpImgs(page)).toEqual(['/source/裁图/EX1/01-全身-正面.jpg', '/source/裁图/EX1/02-细节-领口.jpg', '/source/成图/EX1/m1.png', '/source/模特/EX1/m1.jpg'])
    // → 切到下一版本，分段选中同步
    await page.keyboard.press('ArrowRight')
    expect(await segValue(page, version)).toBe('成图/EX1/m1-v2.png')
    expect(await cmpImgs(page)).toEqual(['/source/裁图/EX1/01-全身-正面.jpg', '/source/裁图/EX1/02-细节-领口.jpg', '/source/成图/EX1/m1-v2.png', '/source/模特/EX1/m1.jpg'])
    await page.keyboard.press('ArrowRight')
    expect(await segValue(page, version)).toBe('成图/EX1/m1.png')
    // 点分段控件同样切换
    await page.click(`${version} [data-value="成图/EX1/m1-v2.png"]`)
    expect(await cmpImgs(page)).toEqual(['/source/裁图/EX1/01-全身-正面.jpg', '/source/裁图/EX1/02-细节-领口.jpg', '/source/成图/EX1/m1-v2.png', '/source/模特/EX1/m1.jpg'])
    await page.keyboard.press('Escape')
    expect(await page.locator('#cl-cmp').isHidden()).toBe(true)
    await page.close()
  })

  it('redo panel and drawer are never open together', async () => {
    const { server } = await setup()
    const page = await openCollection(server)
    await page.click(`${group('EX1')} button.cl-edit`)
    await page.waitForSelector('#cl-drawer[aria-hidden="false"]')
    await page.click('#cl-redo-open')
    await page.waitForSelector('#cl-redo.cl-side:not([hidden])')
    expect(await page.getAttribute('#cl-drawer', 'aria-hidden')).toBe('true')
    // 反过来：待重出开着时打开抽屉，待重出关闭
    await page.locator(`${group('EX1')} button.cl-edit`).evaluate((el) => (el as unknown as { click: () => void }).click())
    await page.waitForSelector('#cl-drawer[aria-hidden="false"]')
    expect(await page.locator('#cl-redo').isHidden()).toBe(true)
    await page.keyboard.press('Escape')
    expect(await page.getAttribute('#cl-drawer', 'aria-hidden')).toBe('true')
    await page.click('#cl-redo-open')
    await page.waitForSelector('#cl-redo:not([hidden])')
    await page.keyboard.press('Escape')
    expect(await page.locator('#cl-redo').isHidden()).toBe(true)
    await page.close()
  })

  it('redo remove offers undo that restores the item with its note', async () => {
    const { root, server, launch: config } = await setup()
    await deliverEF2(root, config)
    const page = await openCollection(server)
    await page.evaluate(`window.__EDITOR_PANEL__.api('POST', '/api/redo', { action: 'add', delivered: '成图/EF2/m1.png', note: '腿部站姿' })`)
    await Promise.all([page.waitForResponse('**/api/collection'), page.click('#cl-refresh')])
    await page.click('#cl-redo-open')
    await page.waitForSelector('#cl-redo:not([hidden])')
    expect(await page.locator('#cl-redo li.cl-redo-item').count()).toBe(1)
    await Promise.all([page.waitForResponse('**/api/redo'), page.click('#cl-redo button.cl-redo-del')])
    expect(await page.locator('#cl-redo li.cl-redo-item').count()).toBe(0)
    const toast = page.locator('.ui-toast:has-text("已移除 m1.jpg")')
    await toast.waitFor()
    const bodies = recordBodies(page, '/api/redo')
    await Promise.all([page.waitForResponse('**/api/redo'), toast.locator('.ui-toast-act').click()])
    expect(bodies).toEqual([{ action: 'add', delivered: '成图/EF2/m1.png', note: '腿部站姿' }])
    await page.waitForSelector('#cl-redo li.cl-redo-item[data-delivered="成图/EF2/m1.png"]')
    expect(await page.inputValue('#cl-redo input.cl-redo-note')).toBe('腿部站姿')
    expect((await readCollection(root)).redo.map((entry) => entry.note)).toEqual(['腿部站姿'])
    // apimart 重出先出工作表；Esc 不发请求
    const runs = recordBodies(page, '/api/redo/run')
    // 面板盖住底栏右侧：直接点引擎分段
    await page.locator('#ed-engine [data-value="apimart"]').evaluate((el) => (el as unknown as { click: () => void }).click())
    await page.click('#cl-redo-go')
    await page.waitForSelector('.ui-sheet.on')
    expect(await page.locator('.ui-sheet').innerText()).toContain('apimart 会产生真实费用，确定用它出图吗？')
    await page.keyboard.press('Escape')
    await waitUntil(async () => (await page.locator('.ui-sheet').count()) === 0)
    await sleep(200)
    expect(runs).toEqual([])
    expect(await page.locator('#cl-redo').isHidden()).toBe(false)
    await page.close()
  })

  it('progress shows in the bar and stop cancels the run', async () => {
    const { root, server, launch: config } = await setup()
    const running = await startRunTool({ sourceRoot: root, open: false, skus: ['EX1'] }, { ...config, env: { ...config.env, FASHION_TRYON_FAKE_ENGINE: JSON.stringify({ delayMs: 2500 }) } })
    pids.push((await readRunRecord(running.runDir)).pid!)
    const page = await openCollection(server)
    expect(await page.locator('#ed-go').innerText()).toMatch(/^出图中 \d\/2$/)
    expect(await page.locator('#ed-go .cl-pbar').count()).toBe(1)
    expect(await page.locator('#ed-go').isDisabled()).toBe(true)
    expect(await page.locator('#cl-stop').isVisible()).toBe(true)
    const cancels: string[] = []
    page.on('request', (request) => { if (request.method() === 'POST' && request.url().endsWith('/cancel')) cancels.push(new URL(request.url()).pathname) })
    await page.click('#cl-stop')
    await page.waitForSelector('.ui-sheet.on')
    expect(await page.locator('.ui-sheet').innerText()).toContain('已交付的图会保留，排队中的不再生成。')
    await page.keyboard.press('Enter')
    await page.waitForSelector('.ui-toast:has-text("已停止 · 已交付")')
    expect(cancels).toEqual([`/api/runs/${running.runId}/cancel`])
    const record = await readRunRecord(running.runDir)
    expect(record.status).toBe('cancelled')
    // 已交付的图保留
    const delivered = record.groups.flatMap((entry) => entry.shots).filter((shot) => shot.state === 'done').map((shot) => shot.delivered!)
    const files = await readdir(path.join(root, '成图/EX1')).catch(() => [] as string[])
    for (const output of delivered) expect(files).toContain(path.basename(output))
    await waitUntil(async () => await page.locator('#cl-stop').isHidden())
    expect(await page.locator('#ed-go').innerText()).toBe('出图')
    await page.close()
  })

  it('starting a run from the page shows progress in the bar and a summary toast', async () => {
    const { root, server } = await setup(1500)
    const page = await openCollection(server)
    await page.check(`${group('EX1')} input.cl-pick`)
    const { runId } = await startFromPage(page, () => page.click('#ed-go'))
    pids.push((await readRunRecord(path.join(runsDir(root), runId))).pid!)
    await waitUntil(async () => /^出图中 \d\/2$/.test(await page.locator('#ed-go').innerText()))
    expect(await page.locator('#ed-go').isDisabled()).toBe(true)
    expect(await page.locator('#cl-stop').isVisible()).toBe(true)
    const toast = page.locator('.ui-toast:has-text("出图完成 · 交付 2 张 · 失败 0 张")')
    await toast.waitFor({ timeout: 15_000 })
    expect(await page.locator('#ed-go').innerText()).toBe('出图')
    await page.close()
  })

  it('progress ends with a summary toast when the run finishes', async () => {
    const { root, server, launch: config } = await setup(600)
    const running = await startRunTool({ sourceRoot: root, open: false, skus: ['EX1'] }, config)
    pids.push((await readRunRecord(running.runDir)).pid!)
    const page = await openCollection(server)
    expect(await page.locator('#ed-go').innerText()).toMatch(/^出图中 \d\/2$/)
    const toast = page.locator('.ui-toast:has-text("出图完成 · 交付 2 张 · 失败 0 张")')
    await toast.waitFor({ timeout: 15_000 })
    expect(await toast.locator('a.ui-toast-link').innerText()).toBe('查看出图记录')
    expect(await toast.locator('a.ui-toast-link').getAttribute('href')).toBe(`/runs/${running.runId}/`)
    expect(await page.locator('#cl-stop').isHidden()).toBe(true)
    await page.close()
  })
})

describe('collection garment column: crop row, delete and drag order', () => {
  it('shows the selected item of bar segmented controls apart from the others', async () => {
    const { server } = await setup()
    const page = await openCollection(server)
    const look = (selector: string): Promise<string> => page.evaluate(`(() => { const s = getComputedStyle(document.querySelector(${JSON.stringify(selector)})); return s.backgroundColor + '|' + s.boxShadow + '|' + s.borderTopWidth })()`)
    const on = await look('#cl-swap-all [aria-checked="true"]')
    const off = await look('#cl-swap-all [aria-checked="false"]')
    expect(on).not.toBe(off)
    expect(off.split('|')[0]).toBe('rgba(0, 0, 0, 0)')
    expect(off.split('|')[2]).toBe('0px')
    await page.close()
  })

  const tile = (file: string): string => `${group('EX1')} .cl-col .cl-tile[data-file="${file}"]`
  const crop = (file: string): string => `${group('EX1')} .cl-crops .cl-crop[data-file="${file}"]`
  const present = async (root: string, file: string): Promise<boolean> => readFile(path.join(root, file)).then(() => true, () => false)

  it('lists crops in their own row and outlines the reference the run uses', async () => {
    const { server } = await setup()
    const page = await openCollection(server)
    expect(await page.locator(`${group('EX1')} .cl-col[data-kind="garment"] .cl-crop`).count()).toBe(0)
    const crops = await page.locator(`${group('EX1')} .cl-crops .cl-tile`).evaluateAll((els) => els.map((el) => el.getAttribute('data-file')))
    expect(crops).toEqual(['裁图/EX1/01-全身-正面.jpg', '裁图/EX1/02-细节-领口.jpg'])
    expect(await page.locator(`${group('EX1')} .cl-crops .cl-lab`).innerText()).toBe('裁图')
    // 没有裁图的款不出这一排
    expect(await page.locator(`${group('EF2')} .cl-crops`).count()).toBe(0)
    // 固定服装默认用裁图：裁图描边，原图不描
    expect(await page.getAttribute(crop('裁图/EX1/01-全身-正面.jpg'), 'class')).toContain('is-used')
    expect(await page.getAttribute(tile('服装/EX1/g1.jpg'), 'class')).not.toContain('is-used')
    // 固定模特下在抽屉里把 g1 改回原图 → 原图描边，它的裁图不描
    await Promise.all([page.waitForResponse('**/api/collection/prefs'), page.click(seg('EX1', 'pairing', 'fixedModel'))])
    await page.click(`${group('EX1')} .cl-edit`)
    await page.click(itemRef('服装/EX1/g1.jpg'))
    await page.click('.ui-menu.on [role="menuitem"][data-value="服装/EX1/g1.jpg"]')
    await page.keyboard.press('Escape')
    expect(await page.getAttribute(tile('服装/EX1/g1.jpg'), 'class')).toContain('is-used')
    expect(await page.getAttribute(crop('裁图/EX1/01-全身-正面.jpg'), 'class')).not.toContain('is-used')
    expect(await page.getAttribute(crop('裁图/EX1/02-细节-领口.jpg'), 'class')).toContain('is-used')
    await page.close()
  })

  it('deletes a garment with its crops into the trash and undoes it from the toast', async () => {
    const { root, server } = await setup()
    const page = await openCollection(server)
    await page.hover(tile('服装/EX1/g1.jpg'))
    await Promise.all([page.waitForResponse('**/api/item/delete'), page.click(`${tile('服装/EX1/g1.jpg')} .cl-del`)])
    const toast = page.locator('.ui-toast:has-text("已删除 g1.jpg（含裁图 1 张）")')
    await toast.waitFor()
    await waitUntil(async () => (await page.locator(tile('服装/EX1/g1.jpg')).count()) === 0)
    expect(await page.locator(crop('裁图/EX1/01-全身-正面.jpg')).count()).toBe(0)
    expect(await page.locator(`${group('EX1')} .cl-cnt`).innerText()).toContain('衣服 2')
    expect(await present(root, '服装/EX1/g1.jpg')).toBe(false)
    expect(await present(root, '裁图/EX1/01-全身-正面.jpg')).toBe(false)
    const [id] = await readdir(path.join(runsDir(root), '已删除', 'EX1'))
    expect(await present(root, `成图/_runs/已删除/EX1/${id}/files/服装/EX1/g1.jpg`)).toBe(true)
    expect(await present(root, `成图/_runs/已删除/EX1/${id}/files/裁图/EX1/01-全身-正面.jpg`)).toBe(true)
    // 扫描不把回收目录当成新款
    expect((await scanSimple(root)).map((entry) => entry.sku)).toEqual(['EF2', 'EG3', 'EX1'])

    await Promise.all([page.waitForResponse('**/api/item/restore'), toast.locator('button:has-text("撤销")').click()])
    await waitUntil(async () => (await page.locator(tile('服装/EX1/g1.jpg')).count()) === 1)
    expect(await present(root, '服装/EX1/g1.jpg')).toBe(true)
    expect(await present(root, '裁图/EX1/01-全身-正面.jpg')).toBe(true)
    expect(await page.locator(crop('裁图/EX1/01-全身-正面.jpg')).count()).toBe(1)
    await page.close()
  })

  it('drags garments and models into a new order that one-to-one pairs by', async () => {
    const { root, server } = await setup()
    const page = await openCollection(server)
    const bodies = recordBodies(page, '/api/collection/item-order')
    await Promise.all([page.waitForResponse('**/api/collection/prefs'), page.click(seg('EX1', 'pairing', 'oneToOne'))])
    // g3 拖到 g1 左半边 → g3、g1、g2；m2 拖到 m1 左半边 → m2、m1
    await Promise.all([
      page.waitForResponse('**/api/collection/item-order'),
      page.locator(tile('服装/EX1/g3.jpg')).dragTo(page.locator(tile('服装/EX1/g1.jpg')), { targetPosition: { x: 4, y: 40 } }),
    ])
    await Promise.all([
      page.waitForResponse('**/api/collection/item-order'),
      page.locator(`${group('EX1')} .cl-tile[data-file="模特/EX1/m2.jpg"]`).dragTo(page.locator(`${group('EX1')} .cl-tile[data-file="模特/EX1/m1.jpg"]`), { targetPosition: { x: 4, y: 40 } }),
    ])
    expect(bodies).toEqual([
      { sku: 'EX1', kind: 'garment', order: ['服装/EX1/g3.jpg', '服装/EX1/g1.jpg', '服装/EX1/g2.jpg'] },
      { sku: 'EX1', kind: 'model', order: ['模特/EX1/m2.jpg', '模特/EX1/m1.jpg'] },
    ])
    await page.waitForSelector('.ui-toast:has-text("已调整顺序")')
    await page.reload()
    await page.waitForSelector('.cl-group')
    const garments = await page.locator(`${group('EX1')} .cl-col .cl-tile[data-drag="garment"]`).evaluateAll((els) => els.map((el) => el.getAttribute('data-file')))
    expect(garments).toEqual(['服装/EX1/g3.jpg', '服装/EX1/g1.jpg', '服装/EX1/g2.jpg'])

    await page.check(`${group('EX1')} input.cl-pick`)
    const { runId } = await startFromPage(page, () => page.click('#ed-go'))
    await waitRun(root, runId)
    const done = await readRunRecord(path.join(runsDir(root), runId))
    expect(done.groups.map((entry) => [entry.item, entry.shots.map((shot) => shot.model)])).toEqual([
      ['服装/EX1/g3.jpg', ['模特/EX1/m2.jpg']],
      ['服装/EX1/g1.jpg', ['模特/EX1/m1.jpg']],
    ])
    await page.close()
  })

  it('drags crops into a new order that becomes the fixed garment references', async () => {
    const { root, server } = await setup()
    const page = await openCollection(server)
    // 02 拖到 01 左半边 → 02、01
    await Promise.all([
      page.waitForResponse('**/api/collection/item-order'),
      page.locator(crop('裁图/EX1/02-细节-领口.jpg')).dragTo(page.locator(crop('裁图/EX1/01-全身-正面.jpg')), { targetPosition: { x: 4, y: 40 } }),
    ])
    await page.waitForSelector('.ui-toast:has-text("已调整顺序")')
    expect((await readCollection(root)).itemOrder.EX1?.crops).toEqual(['裁图/EX1/02-细节-领口.jpg', '裁图/EX1/01-全身-正面.jpg'])
    await page.reload()
    await page.waitForSelector('.cl-group')
    const crops = await page.locator(`${group('EX1')} .cl-crops .cl-tile`).evaluateAll((els) => els.map((el) => el.getAttribute('data-file')))
    expect(crops).toEqual(['裁图/EX1/02-细节-领口.jpg', '裁图/EX1/01-全身-正面.jpg'])

    await page.check(`${group('EX1')} input.cl-pick`)
    const { runId } = await startFromPage(page, () => page.click('#ed-go'))
    await waitRun(root, runId)
    const done = await readRunRecord(path.join(runsDir(root), runId))
    expect(done.groups[0]!.references.map((ref) => ref.file)).toEqual(['裁图/EX1/02-细节-领口.jpg', '裁图/EX1/01-全身-正面.jpg'])
    await page.close()
  })
})
