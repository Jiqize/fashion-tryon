import { chromium, type Browser, type Page } from 'playwright'
import sharp from 'sharp'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

// 共享控件单测：页面只放控件脚本与样式，不连服务；tsconfig 不含 DOM，页面内代码一律写成字符串
let browser: Browser
const pages: Page[] = []

beforeAll(async () => {
  browser = await chromium.launch()
})

afterAll(async () => {
  await browser.close()
})

afterEach(async () => {
  for (const page of pages.splice(0)) await page.close()
})

async function open(body = '', options: { clock?: boolean } = {}): Promise<Page> {
  const page = await browser.newPage()
  pages.push(page)
  if (options.clock === true) await page.clock.install()
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`)
  await page.addStyleTag({ path: 'ui/editor.css' })
  await page.addScriptTag({ path: 'ui/controls.js' })
  return page
}

/** 在页面里执行一段代码；`arg` 以 JSON 形式注入为变量 arg。 */
function run(page: Page, code: string, arg: unknown = null): Promise<unknown> {
  return page.evaluate(`(() => { const ui = window.__UI__; const arg = ${JSON.stringify(arg)}; ${code} })()`)
}

/** 记录冒泡到 document 的 ui-change。 */
async function recordChanges(page: Page): Promise<void> {
  await run(page, "window.__changes = []; document.addEventListener('ui-change', (event) => { window.__changes.push(event.detail.value) })")
}

const changes = (page: Page): Promise<unknown> => page.evaluate('window.__changes')

const OPTIONS = [
  { value: 'outfit', label: '换整套' },
  { value: 'top', label: '只换上衣' },
  { value: 'each', label: '按各款设置' },
]

async function pngDataUrl(color: string): Promise<string> {
  const png = await sharp({ create: { width: 6, height: 8, channels: 3, background: color } }).png().toBuffer()
  return `data:image/png;base64,${png.toString('base64')}`
}

describe('ui controls', () => {
  it('renders a segmented control and fires ui-change only when the value changes', async () => {
    const page = await open('<div id="host"></div>')
    await run(page, "document.getElementById('host').innerHTML = ui.segHtml('data-cl=\"swap\"', arg, 'outfit', '换装范围')", OPTIONS)
    await recordChanges(page)
    const root = page.locator('.ui-seg')
    expect(await root.getAttribute('role')).toBe('radiogroup')
    expect(await root.getAttribute('aria-label')).toBe('换装范围')
    expect(await root.getAttribute('data-cl')).toBe('swap')
    const items = root.locator('button[role="radio"]')
    expect(await items.count()).toBe(3)
    expect(await run(page, "return [...document.querySelectorAll('.ui-seg [role=radio]')].map((item) => [item.getAttribute('data-value'), item.getAttribute('aria-checked'), item.getAttribute('tabindex')])"))
      .toEqual([['outfit', 'true', '0'], ['top', 'false', '-1'], ['each', 'false', '-1']])
    expect(await items.allTextContents()).toEqual(['换整套', '只换上衣', '按各款设置'])

    await items.nth(1).click()
    expect(await changes(page)).toEqual(['top'])
    expect(await items.nth(1).getAttribute('aria-checked')).toBe('true')
    expect(await items.nth(0).getAttribute('aria-checked')).toBe('false')
    await items.nth(1).click()
    expect(await changes(page)).toEqual(['top'])
  })

  it('moves the segmented selection with the arrow keys and wraps around', async () => {
    const page = await open('<div id="host"></div>')
    await run(page, "document.getElementById('host').innerHTML = ui.segHtml('', arg.map((option) => ({ ...option, icon: ui.RULE_ICONS.fixedGarment })), 'outfit', '换装范围')", OPTIONS)
    expect(await page.locator('.ui-seg button svg').count()).toBe(3)
    await recordChanges(page)
    await page.locator('.ui-seg [aria-checked="true"]').focus()
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowLeft')
    expect(await changes(page)).toEqual(['top', 'each', 'outfit', 'each'])
    expect(await page.evaluate("document.activeElement.getAttribute('data-value')")).toBe('each')
    expect(await page.locator('.ui-seg [aria-checked="true"]').getAttribute('data-value')).toBe('each')
  })

  it('toggles a switch by click and by space', async () => {
    const page = await open('<div id="host"></div>')
    await run(page, "document.getElementById('host').innerHTML = ui.switchHtml('data-cl=\"keep\"', false, '保持画幅')")
    await recordChanges(page)
    const sw = page.locator('.ui-switch')
    expect(await sw.getAttribute('role')).toBe('switch')
    expect(await sw.getAttribute('aria-checked')).toBe('false')
    expect(await sw.getAttribute('data-cl')).toBe('keep')
    expect(await sw.textContent()).toBe('保持画幅')
    expect(await sw.locator('i').count()).toBe(1)
    await sw.click()
    expect(await sw.getAttribute('aria-checked')).toBe('true')
    await sw.focus()
    await page.keyboard.press('Space')
    expect(await sw.getAttribute('aria-checked')).toBe('false')
    expect(await changes(page)).toEqual([true, false])
  })

  it('opens a menu, picks with the keyboard and returns focus to the anchor', async () => {
    const page = await open('<button id="anchor">参考图</button>')
    const image = await pngDataUrl('#888888')
    const openMenu = (): Promise<unknown> => run(page, `
      window.__picked = window.__picked || []
      ui.menu(document.getElementById('anchor'), [
        { value: 'orig', label: '原图', image: arg, checked: true },
        { value: 'crop1', label: '裁图 1', image: arg, separatorBefore: true },
        { value: 'crop2', label: '裁图 2' },
      ], (value) => { window.__picked.push(value) })`, image)
    const picked = (): Promise<unknown> => page.evaluate('window.__picked')

    await openMenu()
    const menu = page.locator('.ui-menu.on[role="menu"]')
    await menu.waitFor()
    expect(await run(page, "return [...document.querySelectorAll('.ui-menu [role=menuitem]')].map((item) => item.getAttribute('data-value'))")).toEqual(['orig', 'crop1', 'crop2'])
    expect(await menu.locator('img').count()).toBe(2)
    expect(await menu.locator('hr').count()).toBe(1)
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    expect(await picked()).toEqual(['crop1'])
    expect(await page.locator('.ui-menu.on').count()).toBe(0)
    expect(await page.evaluate('document.activeElement.id')).toBe('anchor')

    await openMenu()
    await page.locator('.ui-menu.on').waitFor()
    await page.keyboard.press('Escape')
    expect(await page.locator('.ui-menu.on').count()).toBe(0)
    expect(await picked()).toEqual(['crop1'])

    await openMenu()
    await page.locator('.ui-menu.on').waitFor()
    await page.mouse.click(5, 300)
    expect(await page.locator('.ui-menu.on').count()).toBe(0)
    expect(await picked()).toEqual(['crop1'])
  })

  it('resolves the confirm sheet with enter, escape and the scrim', async () => {
    const page = await open()
    const ask = (): Promise<unknown> => run(page, "window.__answer = ui.confirm({ title: '用 apimart 出图？', text: 'apimart 会产生真实费用，确定用它出图吗？', ok: '确定', danger: true })")
    const answer = (): Promise<unknown> => page.evaluate('window.__answer')

    await ask()
    const sheet = page.locator('.ui-sheet.on[role="alertdialog"]')
    await sheet.waitFor()
    expect(await sheet.textContent()).toContain('apimart 会产生真实费用，确定用它出图吗？')
    expect(await page.locator('.ui-scrim.on').count()).toBe(1)
    await page.keyboard.press('Enter')
    expect(await answer()).toBe(true)
    await page.locator('.ui-sheet').waitFor({ state: 'detached' })

    await ask()
    await page.locator('.ui-sheet.on').waitFor()
    await page.keyboard.press('Escape')
    expect(await answer()).toBe(false)

    await ask()
    await page.locator('.ui-sheet.on').waitFor()
    await page.locator('.ui-scrim.on').click({ position: { x: 5, y: 400 } })
    expect(await answer()).toBe(false)
    await page.waitForFunction("!document.querySelector('.ui-sheet')")

    // 焦点移到「取消」再回车 → false
    await ask()
    await page.locator('.ui-sheet.on').waitFor()
    await page.keyboard.press('Shift+Tab')
    expect(await page.evaluate("document.activeElement.dataset.answer")).toBe('0')
    await page.keyboard.press('Enter')
    expect(await answer()).toBe(false)
  })

  it('dismisses plain toasts after 3 seconds, keeps errors and runs actions', async () => {
    const page = await open('', { clock: true })
    await run(page, "window.__ran = 0; ui.toast('放图成功 2 张'); ui.toast('保存失败', { error: true })")
    expect(await page.locator('#ui-toasts > .ui-toast').count()).toBe(2)
    expect(await page.locator('.ui-toast .ui-toast-close').count()).toBe(2)
    await page.clock.runFor(3400)
    expect(await page.locator('#ui-toasts > .ui-toast').allTextContents()).toEqual([expect.stringContaining('保存失败')])
    await page.clock.runFor(2000)
    expect(await page.locator('#ui-toasts > .ui-toast').count()).toBe(1)
    await page.locator('.ui-toast .ui-toast-close').click()
    await page.clock.runFor(400)
    expect(await page.locator('#ui-toasts > .ui-toast').count()).toBe(0)

    await run(page, "ui.toast('已移除', { action: { label: '撤销', run: () => { window.__ran += 1 } } })")
    await page.locator('.ui-toast button', { hasText: '撤销' }).click()
    await page.clock.runFor(400)
    expect(await page.evaluate('window.__ran')).toBe(1)
    expect(await page.locator('#ui-toasts > .ui-toast').count()).toBe(0)
  })

  it('cycles quick look with the arrow keys and closes on space', async () => {
    const page = await open()
    const images = await Promise.all(['#aa0000', '#00aa00', '#0000aa'].map(pngDataUrl))
    await run(page, 'ui.quickLook(arg.map((src, index) => ({ src, name: `m${index + 1}.jpg` })), 0)', images)
    const ql = page.locator('.ui-ql.on')
    await ql.waitFor()
    const name = (): Promise<string | null> => ql.locator('.ui-ql-name').textContent()
    expect(await name()).toBe('m1.jpg')
    await page.keyboard.press('ArrowRight')
    expect(await name()).toBe('m2.jpg')
    expect(await ql.locator('img').getAttribute('src')).toBe(images[1])
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    expect(await name()).toBe('m1.jpg')
    await page.keyboard.press('ArrowLeft')
    expect(await name()).toBe('m3.jpg')
    await page.keyboard.press('Space')
    expect(await page.locator('.ui-ql.on').count()).toBe(0)
  })

  it('closes only the top layer on escape', async () => {
    const page = await open('<button id="anchor">更多</button>')
    const image = await pngDataUrl('#888888')
    await run(page, `
      ui.menu(document.getElementById('anchor'), [{ value: 'first', label: '移到最前' }, { value: 'last', label: '移到最后' }], () => undefined)
      ui.quickLook([{ src: arg, name: 'a.jpg' }], 0)`, image)
    await page.locator('.ui-ql.on').waitFor()
    expect(await page.locator('.ui-menu.on').count()).toBe(1)
    await page.keyboard.press('Escape')
    expect(await page.locator('.ui-ql.on').count()).toBe(0)
    expect(await page.locator('.ui-menu.on').count()).toBe(1)
    await page.keyboard.press('Escape')
    expect(await page.locator('.ui-menu.on').count()).toBe(0)

    // 自定义层：Esc 调用一次；已出栈的层不再被调用
    await run(page, 'window.__closed = 0; ui.pushLayer(() => { window.__closed += 1 })')
    await page.keyboard.press('Escape')
    await run(page, 'ui.pushLayer(() => { window.__closed += 10 })()')
    await page.keyboard.press('Escape')
    expect(await page.evaluate('window.__closed')).toBe(1)
  })

  it('does not bind events twice when loaded twice', async () => {
    const page = await open('<div id="host"></div>')
    await page.addScriptTag({ path: 'ui/controls.js' })
    await run(page, "document.getElementById('host').innerHTML = ui.switchHtml('', false, '全部保持画幅')")
    await recordChanges(page)
    await page.locator('.ui-switch').click()
    expect(await changes(page)).toEqual([true])
    expect(await page.locator('.ui-switch').getAttribute('aria-checked')).toBe('true')
  })

  it('turns transitions off under reduced motion', async () => {
    const page = await open('<div id="host"></div>')
    await run(page, "document.getElementById('host').innerHTML = ui.switchHtml('', true, '保持画幅')")
    const duration = (): Promise<unknown> => page.evaluate("getComputedStyle(document.querySelector('.ui-switch i')).transitionDuration")
    expect(await duration()).not.toBe('0s')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    expect(await duration()).toBe('0s')
  })
})
