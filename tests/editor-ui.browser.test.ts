import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { runCli, type CliIo } from '../src/cli.js'
import { editorPageUrl, startEditorServer, type EditorServer } from '../src/editor/server.js'
import { startRunTool, type LaunchConfig } from '../src/mcp/tools.js'
import { KEEP_FRAME_SENTENCE, updateCollection } from '../src/simple/collection.js'
import { applyCropPlan, parseCropPlan } from '../src/simple/crop.js'
import { readActiveLock } from '../src/simple/lock.js'
import { buildSimplePrompt } from '../src/simple/prompt.js'
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

const SOURCE = '20261015-090000'
const FILES = ['服装/EX1/g1.jpg', '服装/EX1/g2.jpg', '服装/EX1/g3.jpg', '模特/EX1/m1.jpg', '模特/EX1/m2.jpg', '服装/EF2/g1.jpg', '模特/EF2/m1.jpg']

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
  const root = await mkdtemp(path.join(tmpdir(), 'editor-ui-'))
  roots.push(root)
  for (const [index, file] of FILES.entries()) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await writeFile(path.join(root, file), await fixtureImageBytes(index + 1))
  }
  await applyCropPlan(root, parseCropPlan({ EX1: [
    { from: 'g1.jpg', role: '全身-正面' },
    { from: 'g2.jpg', role: '细节-领口' },
    { from: 'g3.jpg', role: '背面' },
  ] }))
  const io: CliIo = { stdout: () => undefined, stderr: () => undefined }
  await runCli(['run', root, '--json', '--no-open', '--engine', 'fake', '--run-id', SOURCE], io, { env: { FASHION_TRYON_FAKE_ENGINE: '{}' } })
  const config = launch(delayMs)
  const server = await startEditorServer({ sourceRoot: root, launch: config })
  servers.push(server)
  return { root, server, launch: config }
}

async function openRun(server: EditorServer, runId = SOURCE): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.goto(editorPageUrl(server.origin, server.token, runId))
  await page.waitForSelector('#ed-bar #ed-go')
  await page.waitForSelector('.pair .ed-tick')
  return page
}

async function openPanel(page: Page, sku: string): Promise<void> {
  await page.click(`.lane[data-sku="${sku}"] .ed-toggle`)
  await page.waitForSelector(`.ed-panel[data-sku="${sku}"] .ed-prompt`)
}

const panel = (sku: string): string => `.ed-panel[data-sku="${sku}"]`
/** 成图卡片 */
const pair = (sku: string, model: string): string => `.pair[data-sku="${sku}"][data-model="${model}"]`
const isPicked = (page: Page, selector: string): Promise<boolean> => page.locator(selector).evaluate((el) => el.classList.contains('is-picked'))
const picked = (page: Page): Promise<unknown> => page.evaluate('window.__EDITOR__.picked()')
/** 面板换装范围分段控件的某一项 */
const swapSeg = (sku: string, value: string): string => `${panel(sku)} .ui-seg[data-ed="swap"] [data-value="${value}"]`
const hash = async (file: string): Promise<string> => createHash('sha256').update(await readFile(file)).digest('hex')

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out')
    await sleep(100)
  }
}

describe('editor page', () => {
  it('shows fixedModel combos read-only with a link to the collection page', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'editor-ui-'))
    roots.push(root)
    for (const [index, file] of ['服装/EX1/g1.jpg', '服装/EX1/g2.jpg', '服装/EX1/g3.jpg', '模特/EX1/m1.jpg', '服装/EF2/g1.jpg', '模特/EF2/m1.jpg'].entries()) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true })
      await writeFile(path.join(root, file), await fixtureImageBytes(index + 1))
    }
    await updateCollection(root, (state) => { state.groups.EX1 = { pairing: 'fixedModel', keepFrame: false, halfModels: [] } })
    const io: CliIo = { stdout: () => undefined, stderr: () => undefined }
    await runCli(['run', root, '--json', '--no-open', '--engine', 'fake', '--run-id', SOURCE], io, { env: { FASHION_TRYON_FAKE_ENGINE: '{}' } })
    const server = await startEditorServer({ sourceRoot: root, launch: launch(100) })
    servers.push(server)
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    await page.goto(editorPageUrl(server.origin, server.token, SOURCE))
    await page.waitForSelector('.pair[data-sku="EF2"] .ed-tick')
    expect(await page.locator('.lane[data-sku="EX1"][data-item]').count()).toBe(3)
    expect(await page.locator('.lane[data-item] h2').allInnerTexts()).toEqual([
      expect.stringContaining('EX1 · g1.jpg'), expect.stringContaining('EX1 · g2.jpg'), expect.stringContaining('EX1 · g3.jpg'),
    ])
    expect(await page.locator('.lane[data-item] .ed-tick').count()).toBe(0)
    // 带 item 的组卡片点击不改变选中
    await page.click('.lane[data-item="服装/EX1/g2.jpg"] .pair .out')
    expect(await page.locator('.pair.is-picked').count()).toBe(0)
    expect(await picked(page)).toEqual([])
    expect(await page.locator('.lane[data-item] .ed-toggle').count()).toBe(0)
    const link = page.locator('.lane[data-item="服装/EX1/g2.jpg"] h2 a')
    expect(await link.innerText()).toBe('在合集里重出')
    expect(await link.getAttribute('href')).toBe('/materials/')
    // 固定服装的款照常可编辑、可勾选
    expect(await page.locator('.lane[data-sku="EF2"]:not([data-item]) .ed-toggle').count()).toBe(1)
    await page.close()
  })

  it('treats a keep-frame group as unedited and follows the default prompt', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'editor-ui-'))
    roots.push(root)
    for (const [index, file] of ['服装/EF2/g1.jpg', '服装/EF2/g2.jpg', '模特/EF2/m1.jpg'].entries()) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true })
      await writeFile(path.join(root, file), await fixtureImageBytes(index + 1))
    }
    await updateCollection(root, (state) => { state.groups.EF2 = { pairing: 'fixedGarment', keepFrame: true, halfModels: [] } })
    const io: CliIo = { stdout: () => undefined, stderr: () => undefined }
    await runCli(['run', root, '--json', '--no-open', '--engine', 'fake', '--run-id', SOURCE], io, { env: { FASHION_TRYON_FAKE_ENGINE: '{}' } })
    const server = await startEditorServer({ sourceRoot: root, launch: launch(100) })
    servers.push(server)
    const page = await openRun(server)
    const bodies: unknown[] = []
    page.on('request', (request) => { if (request.url().endsWith('/api/prompt')) bodies.push(request.postDataJSON()) })
    await openPanel(page, 'EF2')
    await sleep(500)
    expect(await page.locator(`${panel('EF2')} .ed-edited`).count()).toBe(0)
    // 换范围后没改过的提示词跟随，并保留那句
    await page.click(swapSeg('EF2', 'top'))
    const expected = `${defaultPrompt([{ file: '服装/EF2/g1.jpg' }, { file: '服装/EF2/g2.jpg' }], 'top')}\n${KEEP_FRAME_SENTENCE}`
    await waitUntil(async () => (await page.inputValue(`${panel('EF2')} .ed-prompt`)) === expected)
    expect(bodies).toContainEqual(expect.objectContaining({ swap: 'top', keepFrame: true }))
    expect(await page.locator(`${panel('EF2')} .ed-edited`).count()).toBe(0)
    await page.close()
  })

  it('reruns one picked shot and lands on the new run', async () => {
    const { root, server } = await setup()
    const page = await openRun(server)
    expect(await page.locator('#ed-go').isDisabled()).toBe(true)
    await page.click(pair('EX1', '模特/EX1/m2.jpg'))
    expect(await page.locator('#ed-count').innerText()).toBe('已选 1 张')
    await Promise.all([page.waitForURL((url) => url.pathname.startsWith('/runs/') && !url.pathname.includes(SOURCE)), page.click('#ed-go')])
    const runId = new URL(page.url()).pathname.split('/')[2]!
    expect(runId).not.toBe(SOURCE)
    await page.waitForSelector('#from a')
    expect(await page.locator('#from').innerText()).toBe(`来自 ${SOURCE}`)
    const record = await readRunRecord(path.join(runsDir(root), runId))
    if (record.pid !== null) pids.push(record.pid)
    expect(record.derivedFrom).toBe(SOURCE)
    expect(record.counts.planned).toBe(1)
    await page.close()
  })

  it('submits references in the order shown after remove, move and rename', async () => {
    const { root, server } = await setup()
    const page = await openRun(server)
    await openPanel(page, 'EX1')
    const items = `${panel('EX1')} .ed-ref`
    expect(await page.locator(items).count()).toBe(3)
    await page.click(`${items}[data-index="2"] button[data-act="remove"]`)
    await waitUntil(async () => (await page.locator(items).count()) === 2)
    await page.click(`${items}[data-index="1"] button[data-act="up"]`)
    await waitUntil(async () => (await page.locator(`${items}[data-index="0"] .ed-file`).innerText()) === '02-细节-领口.jpg')
    await page.fill(`${items}[data-index="1"] input.ed-role`, '全身')
    await page.press(`${items}[data-index="1"] input.ed-role`, 'Tab')
    await waitUntil(async () => (await page.inputValue(`${items}[data-index="1"] input.ed-role`)) === '全身')
    await page.click(pair('EX1', '模特/EX1/m1.jpg'))
    const [request] = await Promise.all([page.waitForRequest('**/api/rerun'), page.click('#ed-go')])
    const body = request.postDataJSON() as { groups: Record<string, { references: unknown[]; prompt?: string }> }
    expect(body.groups.EX1!.references).toEqual([
      { file: '裁图/EX1/02-细节-领口.jpg', role: '细节-领口' },
      { file: '裁图/EX1/01-全身-正面.jpg', role: '全身' },
    ])
    expect(body.groups.EX1!.prompt).toBeUndefined()
    await access(path.join(root, '裁图/EX1/03-背面.jpg'))
    await page.waitForURL((url) => !url.pathname.includes(SOURCE))
    const runId = new URL(page.url()).pathname.split('/')[2]!
    const record = await readRunRecord(path.join(runsDir(root), runId))
    if (record.pid !== null) pids.push(record.pid)
    await page.close()
  })

  it('asks before replacing a crop with the same role', async () => {
    const { root, server } = await setup()
    const page = await openRun(server)
    await openPanel(page, 'EX1')
    await page.click(`${panel('EX1')} button[data-crop="服装/EX1/g2.jpg"]`)
    const img = page.locator('#ed-crop-img')
    await img.waitFor()
    await waitUntil(async () => ((await img.boundingBox())?.width ?? 0) > 0)
    const box = (await img.boundingBox())!
    await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.1)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 4 })
    await page.mouse.up()
    await page.fill('#ed-crop-role', '全身-正面')
    const target = path.join(root, '裁图/EX1/01-全身-正面.jpg')
    const before = await hash(target)

    const dialogs: string[] = []
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.message())
      void dialog.dismiss()
    })
    const bodies: unknown[] = []
    page.on('request', (request) => { if (request.method() === 'POST' && request.url().endsWith('/api/crop')) bodies.push(request.postDataJSON()) })
    // 工作表确认：Esc 取消，不发替换请求
    await page.click('#ed-crop-save')
    await page.waitForSelector('.ui-sheet.on')
    expect(await page.locator('.ui-sheet h3').innerText()).toBe('裁图/EX1/ 里已有「全身-正面」，替换吗？')
    expect(await page.locator('.ui-sheet [data-answer="1"]').innerText()).toBe('替换')
    await page.keyboard.press('Escape')
    await page.waitForSelector('.ui-sheet', { state: 'detached' })
    await sleep(200)
    expect(bodies.some((body) => (body as { replace?: boolean }).replace === true)).toBe(false)
    expect(await hash(target)).toBe(before)
    expect(await page.locator('#ed-crop').isVisible()).toBe(true)

    // 回车确认：带 replace 重发
    await page.click('#ed-crop-save')
    await page.waitForSelector('.ui-sheet.on')
    await page.keyboard.press('Enter')
    await page.waitForSelector('#ed-crop', { state: 'hidden' })
    expect(bodies.filter((body) => (body as { replace?: boolean }).replace === true)).toHaveLength(1)
    expect(dialogs).toEqual([])
    expect(await hash(target)).not.toBe(before)
    expect(await page.locator(`${panel('EX1')} .ed-ref .ed-file`).allInnerTexts()).toContain('01-全身-正面.jpg')
    await page.close()
  })

  it('keeps an edited prompt when references change and restores the default', async () => {
    const { server } = await setup()
    const page = await openRun(server)
    await openPanel(page, 'EX1')
    const area = `${panel('EX1')} .ed-prompt`
    const original = await page.inputValue(area)
    await page.click(area)
    // 在开头连续输入：第一个字让「已改」出现，后面的字不能跑到别处
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home')
    await page.keyboard.type('前缀')
    // 光标移到全文末尾
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End')
    await page.keyboard.type('\n额外要求')
    await page.waitForSelector(`${panel('EX1')} .ed-edited`)
    expect(await page.locator(`${panel('EX1')} .ed-edited`).innerText()).toBe('已改')
    const edited = await page.inputValue(area)
    expect(edited).toBe(`前缀${original}\n额外要求`)

    await page.click(`${panel('EX1')} .ed-ref[data-index="2"] button[data-act="remove"]`)
    await page.waitForSelector(`${panel('EX1')} .ed-warn`)
    expect(await page.locator(`${panel('EX1')} .ed-warn`).innerText()).toBe('参考图已变，提示词里的图号可能对不上')
    expect(await page.inputValue(area)).toBe(edited)

    await page.click(`${panel('EX1')} .ed-restore`)
    await waitUntil(async () => (await page.locator(`${panel('EX1')} .ed-warn`).count()) === 0)
    expect(await page.inputValue(area)).toBe(defaultPrompt([
      { file: '裁图/EX1/01-全身-正面.jpg', role: '全身-正面' },
      { file: '裁图/EX1/02-细节-领口.jpg', role: '细节-领口' },
    ], 'outfit'))
    expect(await page.locator(`${panel('EX1')} .ed-edited`).count()).toBe(0)
    await page.close()
  })

  it('follows the top prompt when switching swap without edits', async () => {
    const { server } = await setup()
    const page = await openRun(server)
    await openPanel(page, 'EF2')
    const bodies: unknown[] = []
    page.on('request', (request) => { if (request.url().endsWith('/api/prompt')) bodies.push(request.postDataJSON()) })
    await page.click(swapSeg('EF2', 'top'))
    expect(await page.getAttribute(swapSeg('EF2', 'top'), 'aria-checked')).toBe('true')
    const expected = buildSimplePrompt(['g1.jpg'], 'top')
    await waitUntil(async () => (await page.inputValue(`${panel('EF2')} .ed-prompt`)) === expected)
    expect(bodies).toContainEqual(expect.objectContaining({ swap: 'top' }))
    expect(await page.locator(`${panel('EF2')} input[type="radio"]`).count()).toBe(0)
    expect(await page.locator(`${panel('EF2')} .ed-edited`).count()).toBe(0)
    await page.close()
  })

  it('warns about apimart cost and does not submit when the sheet is dismissed', async () => {
    const { server } = await setup()
    const page = await openRun(server)
    expect(await page.locator('#ed-cost').isHidden()).toBe(true)
    await page.click('#ed-engine [data-value="apimart"]')
    expect(await page.getAttribute('#ed-engine [data-value="apimart"]', 'aria-checked')).toBe('true')
    expect(await page.locator('#ed-cost').innerText()).toBe('会产生真实费用')
    await page.click(pair('EF2', '模特/EF2/m1.jpg'))
    const requests: string[] = []
    page.on('request', (request) => requests.push(new URL(request.url()).pathname))
    const dialogs: string[] = []
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.message())
      void dialog.dismiss()
    })
    await page.click('#ed-go')
    await page.waitForSelector('.ui-sheet.on')
    expect(await page.locator('.ui-sheet h3').innerText()).toBe('用 apimart 重出？')
    expect(await page.locator('.ui-sheet p').innerText()).toBe('apimart 会产生真实费用，确定用它重出吗？')
    expect(await page.locator('.ui-sheet [data-answer="1"]').innerText()).toBe('确定重出')
    await page.keyboard.press('Escape')
    await page.waitForSelector('.ui-sheet', { state: 'detached' })
    await sleep(300)
    expect(requests).not.toContain('/api/rerun')
    expect(dialogs).toEqual([])
    await page.close()
  })

  it('picks shots by clicking cards and previews the sku results with space', async () => {
    const { server } = await setup()
    const page = await openRun(server)
    expect(await page.locator('input.ed-pick').count()).toBe(0)
    expect(await page.locator('select').count()).toBe(0)
    expect(await page.locator('.ui-seg#ed-engine').count()).toBe(1)
    await page.click(pair('EX1', '模特/EX1/m1.jpg'))
    await page.click(pair('EX1', '模特/EX1/m2.jpg'))
    expect(await picked(page)).toEqual([
      { sku: 'EX1', model: '模特/EX1/m1.jpg' },
      { sku: 'EX1', model: '模特/EX1/m2.jpg' },
    ])
    expect(await isPicked(page, pair('EX1', '模特/EX1/m2.jpg'))).toBe(true)
    expect(await page.locator('#lb').isHidden()).toBe(true)
    await page.click(pair('EX1', '模特/EX1/m1.jpg'))
    expect(await picked(page)).toEqual([{ sku: 'EX1', model: '模特/EX1/m2.jpg' }])
    expect(await isPicked(page, pair('EX1', '模特/EX1/m1.jpg'))).toBe(false)
    expect(await page.locator('#ed-count').innerText()).toBe('已选 1 张')
    // 空格从最后点的那张预览同一款的成图，Esc 关闭
    await page.keyboard.press('Space')
    await page.waitForSelector('.ui-ql.on')
    expect(await page.locator('.ui-ql-name').innerText()).toBe('m1.jpg')
    await page.keyboard.press('ArrowRight')
    expect(await page.locator('.ui-ql-name').innerText()).toBe('m2.jpg')
    await page.keyboard.press('Escape')
    await page.waitForSelector('.ui-ql', { state: 'detached' })
    await page.close()
  })

  it('reaches result cards with Tab, toggles them with Enter and previews with space', async () => {
    const { server } = await setup()
    const page = await openRun(server)
    const card = pair('EX1', '模特/EX1/m1.jpg')
    expect(await page.locator(card).getAttribute('tabindex')).toBe('0')
    expect(await page.locator(card).getAttribute('role')).toBe('button')
    expect(await page.locator(card).getAttribute('aria-pressed')).toBe('false')
    // 只用 Tab 走到第一张成图卡片
    const onCard = (): Promise<boolean> => page.locator(card).evaluate((el) => el === el.ownerDocument.activeElement)
    for (let step = 0; step < 60 && !(await onCard()); step++) await page.keyboard.press('Tab')
    expect(await onCard()).toBe(true)
    await page.keyboard.press('Enter')
    expect(await picked(page)).toEqual([{ sku: 'EX1', model: '模特/EX1/m1.jpg' }])
    expect(await page.locator(card).getAttribute('aria-pressed')).toBe('true')
    expect(await page.locator('#ed-count').innerText()).toBe('已选 1 张')
    // 空格从聚焦的卡片预览同一款的成图，不改变选中
    await page.keyboard.press('Space')
    await page.waitForSelector('.ui-ql.on')
    expect(await page.locator('.ui-ql-name').innerText()).toBe('m1.jpg')
    await page.keyboard.press('Escape')
    await page.waitForSelector('.ui-ql', { state: 'detached' })
    expect(await picked(page)).toEqual([{ sku: 'EX1', model: '模特/EX1/m1.jpg' }])
    // 再按回车取消
    await page.focus(card)
    await page.keyboard.press('Enter')
    expect(await picked(page)).toEqual([])
    expect(await page.locator(card).getAttribute('aria-pressed')).toBe('false')
    await page.close()
  })

  it('shows the rerun error as an error toast', async () => {
    const { server } = await setup()
    const page = await openRun(server)
    await page.route('**/api/rerun', (route) => route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'RUN_IN_PROGRESS', message: '已有出图在进行' } }),
    }))
    await page.click(pair('EF2', '模特/EF2/m1.jpg'))
    await page.click('#ed-go')
    await page.waitForSelector('.ui-toast.is-error')
    expect(await page.locator('.ui-toast.is-error .ui-toast-msg').innerText()).toBe('已有出图在进行')
    expect(new URL(page.url()).pathname).toContain(SOURCE)
    await page.close()
  })

  it('blocks rerun while another run is going and cancels the running one', async () => {
    const { root, server, launch: config } = await setup()
    const running = await startRunTool({ sourceRoot: root, open: false }, { ...config, env: { ...config.env, FASHION_TRYON_FAKE_ENGINE: JSON.stringify({ delayMs: 3000 }) } })
    pids.push((await readRunRecord(running.runDir)).pid!)
    const page = await openRun(server)
    await page.click(pair('EF2', '模特/EF2/m1.jpg'))
    expect(await page.locator('#ed-go').isDisabled()).toBe(true)
    expect(await page.locator('#ed-msg').innerText()).toContain(`正在出图：${running.runId}`)
    expect(await page.locator('#ed-cancel').isHidden()).toBe(true)
    await page.close()

    const own = await openRun(server, running.runId)
    expect(await own.locator('#ed-cancel').isVisible()).toBe(true)
    // 取消先出工作表，回车确认后调取消接口
    await own.click('#ed-cancel')
    await own.waitForSelector('.ui-sheet.on')
    expect(await own.locator('.ui-sheet h3').innerText()).toBe('停止出图？')
    expect(await own.locator('.ui-sheet p').innerText()).toBe('已交付的图会保留，排队中的不再生成。')
    await Promise.all([own.waitForEvent('load'), own.keyboard.press('Enter')])
    await own.waitForSelector('#meta .status')
    await waitUntil(async () => (await own.locator('#meta .status').innerText()) === '已取消')
    await waitUntil(async () => (await readActiveLock(root)) === null)
    await own.close()
  })

  it('drag reorder matches pressing ↑ twice, and the default prompt follows', async () => {
    const { server } = await setup()
    const page = await openRun(server)
    await openPanel(page, 'EX1')
    const items = `${panel('EX1')} .ed-ref`
    const files = () => page.locator(`${items} .ed-file`).allInnerTexts()
    await page.locator(`${items}[data-index="2"]`).dragTo(page.locator(`${items}[data-index="0"]`), { targetPosition: { x: 4, y: 40 } })
    await waitUntil(async () => (await files())[0] === '03-背面.jpg')
    expect(await files()).toEqual(['03-背面.jpg', '01-全身-正面.jpg', '02-细节-领口.jpg'])
    const dragged = await page.inputValue(`${panel('EX1')} .ed-prompt`)
    expect(dragged).toBe(buildSimplePrompt(['03-背面.jpg', '01-全身-正面.jpg', '02-细节-领口.jpg']))

    const other = await openRun(server)
    await openPanel(other, 'EX1')
    // 键盘：聚焦图标按钮后回车，焦点跟着那张图走
    await other.locator(`${items}[data-index="2"] button[data-act="up"]`).focus()
    await waitUntil(async () => (await other.locator(`${items}[data-index="2"] .ed-icons`).evaluate((el) => (globalThis as unknown as { getComputedStyle(node: unknown): { opacity: string } }).getComputedStyle(el).opacity)) === '1')
    await other.keyboard.press('Enter')
    await waitUntil(async () => (await other.locator(`${items}[data-index="1"] .ed-file`).innerText()) === '03-背面.jpg')
    await waitUntil(async () => other.locator(`${items}[data-index="1"] button[data-act="up"]`).evaluate((el) => el === (el as unknown as { ownerDocument: { activeElement: unknown } }).ownerDocument.activeElement))
    await other.keyboard.press('Enter')
    await waitUntil(async () => (await other.locator(`${items}[data-index="0"] .ed-file`).innerText()) === '03-背面.jpg')
    await waitUntil(async () => (await other.inputValue(`${panel('EX1')} .ed-prompt`)) === dragged)
    expect(await other.locator(`${items} .ed-file`).allInnerTexts()).toEqual(await files())
    await other.close()
    await page.close()
  })

  it('adds from the pool by drag or +, removes by × or dragging out, and blocks over the limit', async () => {
    const { root, server } = await setup()
    const page = await openRun(server)
    await openPanel(page, 'EX1')
    const items = `${panel('EX1')} .ed-ref`
    const files = () => page.locator(`${items} .ed-file`).allInnerTexts()
    const pool = (file: string) => page.locator(`${panel('EX1')} .ed-pool-item[data-file="${file}"]`)
    await pool('服装/EX1/g1.jpg').dragTo(page.locator(`${items}[data-index="1"]`), { targetPosition: { x: 4, y: 40 } })
    await waitUntil(async () => (await files()).length === 4)
    expect((await files())[1]).toBe('g1.jpg')
    await pool('服装/EX1/g2.jpg').hover()
    await page.click(`${panel('EX1')} button[data-add="服装/EX1/g2.jpg"]`)
    await waitUntil(async () => (await files()).length === 5)
    expect((await files())[4]).toBe('g2.jpg')

    await page.click(pair('EX1', '模特/EX1/m1.jpg'))
    await page.click(`${panel('EX1')} button[data-add="服装/EX1/g3.jpg"]`)
    await page.click(`${panel('EX1')} button[data-add="服装/EX1/g3.jpg"]`)
    await waitUntil(async () => (await files()).length === 7)
    expect(await page.locator('#ed-go').isDisabled()).toBe(true)
    expect(await page.locator('#ed-msg').innerText()).toContain('EX1：参考图 7 张，超过上限 6 张')

    await page.locator(`${items}[data-index="6"]`).hover()
    await page.click(`${items}[data-index="6"] button[data-act="remove"]`)
    await waitUntil(async () => (await files()).length === 6)
    await waitUntil(async () => !(await page.locator('#ed-go').isDisabled()))
    // 拖到列表外松手 = 移除
    await page.locator(`${items}[data-index="0"]`).dragTo(page.locator(`${panel('EX1')} .ed-sec-models h3`))
    await waitUntil(async () => (await files()).length === 5)
    expect(await files()).toEqual(['g1.jpg', '02-细节-领口.jpg', '03-背面.jpg', 'g2.jpg', 'g3.jpg'])
    await access(path.join(root, '裁图/EX1/01-全身-正面.jpg'))
    expect(await page.locator('#lb').isHidden()).toBe(true)
    await page.close()
  })

  it('keeps references on a cancelled drag or a drop on another panel, and ignores stale prompts', async () => {
    const { server } = await setup()
    const page = await openRun(server)
    await openPanel(page, 'EX1')
    await openPanel(page, 'EF2')
    const items = `${panel('EX1')} .ed-ref`
    const files = () => page.locator(`${items} .ed-file`).allInnerTexts()
    const before = await files()
    const otherBefore = await page.locator(`${panel('EF2')} .ed-ref .ed-file`).allInnerTexts()
    // Esc 取消或拖到窗口外：只有 dragstart / dragend，没有 drop
    const dataTransfer = await page.evaluateHandle('new DataTransfer()')
    await page.dispatchEvent(`${items}[data-index="0"]`, 'dragstart', { dataTransfer })
    await page.dispatchEvent(`${items}[data-index="0"]`, 'dragend', { dataTransfer })
    await sleep(300)
    expect(await files()).toEqual(before)
    // 拖到别的款的面板里松手：两边都不变
    await page.locator(`${items}[data-index="0"]`).dragTo(page.locator(`${panel('EF2')} .ed-sec-models h3`))
    await sleep(300)
    expect(await files()).toEqual(before)
    expect(await page.locator(`${panel('EF2')} .ed-ref .ed-file`).allInnerTexts()).toEqual(otherBefore)

    // 先发的默认提示词请求晚到：不能覆盖后一次的结果
    let calls = 0
    await page.route('**/api/prompt', async (route) => {
      if (calls++ === 0) await sleep(800)
      await route.continue()
    })
    await page.click(`${items}[data-index="2"] button[data-act="remove"]`)
    await waitUntil(async () => (await files()).length === 2)
    await page.click(`${items}[data-index="1"] button[data-act="remove"]`)
    await waitUntil(async () => (await files()).length === 1)
    await sleep(1200)
    expect(calls).toBe(2)
    expect(await page.inputValue(`${panel('EX1')} .ed-prompt`)).toBe(buildSimplePrompt([before[0]!]))
    await page.close()
  })

  it('toggles models by clicking thumbnails, in sync with the shot checkboxes', async () => {
    const { server } = await setup()
    const page = await openRun(server)
    await openPanel(page, 'EX1')
    const model = `${panel('EX1')} .ed-model[data-model="模特/EX1/m1.jpg"]`
    await page.click(model)
    expect(await page.locator('#ed-count').innerText()).toBe('已选 1 张')
    expect(await page.getAttribute(model, 'aria-pressed')).toBe('true')
    expect(await isPicked(page, pair('EX1', '模特/EX1/m1.jpg'))).toBe(true)
    expect(await page.locator('#lb').isHidden()).toBe(true)
    await page.click(`${panel('EX1')} .ed-all`)
    expect(await page.locator('#ed-count').innerText()).toBe('已选 2 张')
    await page.click(pair('EX1', '模特/EX1/m2.jpg'))
    await waitUntil(async () => (await page.getAttribute(`${panel('EX1')} .ed-model[data-model="模特/EX1/m2.jpg"]`, 'aria-pressed')) === 'false')
    expect(await page.locator('#ed-count').innerText()).toBe('已选 1 张')
    await page.close()
  })

  it('adds the keep frame sentence through the panel option and setKeepFrame', async () => {
    const { server } = await setup()
    const page = await openRun(server)
    const bodies: unknown[] = []
    page.on('request', (request) => { if (request.url().endsWith('/api/prompt')) bodies.push(request.postDataJSON()) })
    // run 页面的面板不带 keepFrame
    await openPanel(page, 'EF2')
    await page.click(swapSeg('EF2', 'top'))
    await waitUntil(async () => bodies.length > 0)
    expect(bodies[0]).toMatchObject({ swap: 'top' })
    expect(bodies[0]).not.toHaveProperty('keepFrame')
    bodies.length = 0
    await page.evaluate(`(() => {
      const el = document.createElement('div')
      el.id = 'kf'
      document.body.append(el)
      window.__kf = window.__EDITOR_PANEL__.create(el, {
        sku: 'EF2',
        settings: { swap: 'outfit', references: [{ file: '服装/EF2/g1.jpg' }], prompt: '旧提示词', promptEdited: false },
        garments: [], crops: [], models: [], maxReferences: 6, keepFrame: true,
      })
    })()`)
    const plain = defaultPrompt([{ file: '服装/EF2/g1.jpg' }], 'outfit')
    await waitUntil(async () => (await page.inputValue('#kf .ed-prompt')) === `${plain}\n${KEEP_FRAME_SENTENCE}`)
    expect(bodies).toContainEqual({ references: [{ file: '服装/EF2/g1.jpg' }], swap: 'outfit', keepFrame: true })
    expect(await page.locator('#kf .ed-edited').count()).toBe(0)
    await page.evaluate('window.__kf.setKeepFrame(false)')
    await waitUntil(async () => (await page.inputValue('#kf .ed-prompt')) === plain)
    expect(await page.evaluate('window.__kf.getState().promptEdited')).toBe(false)
    await page.close()
  })

  it('warns before leaving with unsubmitted edits', async () => {
    const { server } = await setup()
    const page = await openRun(server)
    await openPanel(page, 'EF2')
    await page.click(swapSeg('EF2', 'top'))
    await page.waitForSelector('#ed-msg .ed-dirty')
    expect(await page.locator('#ed-msg .ed-dirty').innerText()).toBe('有未重出的修改，离开会丢失')
    // 刷新时拦截；取消后留在页面上，修改还在
    const waiting = page.waitForEvent('dialog')
    const reloading = page.reload({ timeout: 2000 }).catch(() => undefined)
    const dialog = await waiting
    expect(dialog.type()).toBe('beforeunload')
    await dialog.dismiss()
    await reloading
    expect(await page.getAttribute(swapSeg('EF2', 'top'), 'aria-checked')).toBe('true')
    await page.close()
  })
})
