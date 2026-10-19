import { readdir } from 'node:fs/promises'
import path from 'node:path'

import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { startStudioServer, type StudioServer } from '../../src/studio/server.js'
import { FakeImageGeneration, fakePng, Gate } from '../helpers/fake-image-generation.js'
import { FakeVision } from '../helpers/fake-vision.js'
import { cleanupSourceTrees, makeReviewBatch, makeSourceTree } from './helpers.js'

let browser: Browser
const servers: StudioServer[] = []
const pages: Page[] = []

beforeAll(async () => {
  browser = await chromium.launch()
})
afterEach(async () => {
  await Promise.all(pages.splice(0).map((page) => page.close()))
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await cleanupSourceTrees()
})
afterAll(async () => {
  await browser.close()
})

interface ViewLike {
  groups: Array<{ id: string; sku: string; status: string; order: number }>
  tasks: Array<{
    id: string
    groupId: string
    excluded: boolean
    chosenVersionId?: string
    versions: Array<{ id: string }>
  }>
}

/** 关闭 gate 时生成停在闸门处，测试可确定地观察"生成中/重出中"的中间状态。 */
async function start(root: string, latencyMs = 5, gate?: Gate): Promise<StudioServer> {
  const images = gate === undefined
    ? new FakeImageGeneration(undefined, latencyMs)
    : new FakeImageGeneration(async (_request, callIndex, signal) => {
      await gate.wait(signal)
      return fakePng(`fake-${String(callIndex + 1)}`)
    }, latencyMs)
  const server = await startStudioServer({ sourceRoot: root, deps: { vision: new FakeVision(), images } })
  servers.push(server)
  return server
}

function apiUrl(server: StudioServer, pathname: string): string {
  const url = new URL(pathname, new URL(server.url).origin)
  url.searchParams.set('token', new URL(server.url).searchParams.get('token')!)
  return url.toString()
}

async function view(server: StudioServer): Promise<ViewLike> {
  const state = ((await (await fetch(apiUrl(server, '/api/batch'))).json()) as { state: ViewLike }).state
  // 页面按组 order 排列
  state.groups.sort((left, right) => left.order - right.order)
  return state
}

async function post(server: StudioServer, pathname: string, body: unknown): Promise<void> {
  const response = await fetch(apiUrl(server, pathname), {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: new URL(server.url).origin },
    body: JSON.stringify(body),
  })
  expect(response.status).toBe(200)
}

async function waitAll(server: StudioServer, status: string): Promise<ViewLike> {
  let current: ViewLike | undefined
  await vi.waitFor(async () => {
    current = await view(server)
    expect(current.groups.every((group) => group.status === status)).toBe(true)
  }, { timeout: 20_000, interval: 50 })
  return current!
}

/** 打开看板页；记录页面错误与所有鼠标类事件。 */
async function open(server: StudioServer): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  pages.push(page)
  // 测试环境不依赖外网字体
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort())
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript(() => {
    const win = globalThis as unknown as {
      __mouse: number
      addEventListener(type: string, listener: () => void, capture: boolean): void
    }
    win.__mouse = 0
    for (const type of ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown']) {
      win.addEventListener(type, () => { win.__mouse += 1 }, true)
    }
  })
  await page.goto(server.url)
  return { page, errors }
}

/** 页面异步刷新：统一放宽轮询时限（expect.poll 默认只有 1 秒）。 */
function poll<T>(fn: () => T | Promise<T>) {
  return expect.poll(fn, { timeout: 10_000, interval: 30 })
}

function row(page: Page, groupId: string) {
  return page.locator(`.set[data-group-id="${groupId}"]`)
}

function tile(page: Page, taskId: string) {
  return page.locator(`.tile[data-task-id="${taskId}"]`)
}

async function activeGroup(page: Page): Promise<string | null> {
  return page.locator('.set.is-active').getAttribute('data-group-id')
}

async function outputs(root: string, sku: string): Promise<string[]> {
  return (await readdir(path.join(root, '成图', sku)).catch(() => [] as string[])).filter((name) => !name.startsWith('.'))
}

function tasksOf(state: ViewLike, groupId: string): ViewLike['tasks'] {
  return state.tasks.filter((task) => task.groupId === groupId)
}

describe('studio review view', () => {
  it('passes, excludes, regenerates and switches versions with the keyboard', async () => {
    const root = await makeSourceTree({
      EK52001: { garments: 1, models: 2 },
      EK52002: { garments: 1, models: 2 },
      EK52003: { garments: 1, models: 2 },
      EK52004: { garments: 1, models: 2 },
    })
    const gate = new Gate()
    const server = await start(root, 5, gate)
    await post(server, '/api/start', {})
    const state = await waitAll(server, 'review')
    const [g1, g2, g3] = state.groups
    const { page, errors } = await open(server)

    await poll(() => page.locator('.set[data-status="review"]').count()).toBe(4)
    expect(await activeGroup(page)).toBe(g1!.id)

    // Enter：整套通过，收起并跳到下一套
    await page.keyboard.press('Enter')
    await poll(() => row(page, g1!.id).getAttribute('data-status')).toBe('delivered')
    await poll(() => row(page, g1!.id).textContent()).toContain(`→ 成图/${g1!.sku}/`)
    expect(await row(page, g1!.id).getAttribute('class')).toContain('st-done')
    await poll(() => activeGroup(page)).toBe(g2!.id)
    expect(await outputs(root, g1!.sku)).toHaveLength(2)
    await poll(() => page.locator('#toast').textContent()).toContain(`${g1!.sku} 已交付 2 张`)
    expect(await page.locator('#toast').textContent()).toContain(`→ 成图/${g1!.sku}/`)

    // X：不交付样式，交付时少这一张
    const second = tasksOf(state, g2!.id)[1]!
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('x')
    await poll(() => tile(page, second.id).getAttribute('class')).toContain('is-excl')
    await page.keyboard.press('Enter')
    await poll(() => row(page, g2!.id).getAttribute('data-status')).toBe('delivered')
    expect(await outputs(root, g2!.sku)).toHaveLength(1)
    await poll(() => activeGroup(page)).toBe(g3!.id)

    // R → 1 → Enter：重出中 · 颜色偏，完成后 v2/2，按 1 切回 v1
    const target = tasksOf(state, g3!.id)[0]!
    // 闸门关住重出，"重出中"一定能被看到
    gate.close()
    await page.keyboard.press('r')
    await poll(() => page.locator('#pop.open').count()).toBe(1)
    await page.keyboard.press('1')
    await page.keyboard.press('Enter')
    await poll(() => tile(page, target.id).textContent()).toContain('重出中 · 颜色偏')
    gate.open()
    await poll(() => tile(page, target.id).textContent()).toContain('v2/2')
    await page.keyboard.press('1')
    const firstVersion = target.versions[0]!.id
    await poll(async () => (await view(server)).tasks.find((task) => task.id === target.id)!.chosenVersionId)
      .toBe(firstVersion)
    await poll(() => tile(page, target.id).textContent()).toContain('v1/2')
    await poll(() => page.locator('#insp .big img').getAttribute('src')).toContain(firstVersion)

    expect(errors).toEqual([])
  }, 60_000)

  it('undoes a pass with the keyboard and expands the group again', async () => {
    const root = await makeSourceTree({ EK52001: { garments: 1, models: 2 }, EK52002: { garments: 1, models: 1 } })
    const server = await start(root)
    await post(server, '/api/start', {})
    const state = await waitAll(server, 'review')
    const g1 = state.groups[0]!
    const { page, errors } = await open(server)
    await poll(() => page.locator('.set[data-status="review"]').count()).toBe(2)

    await page.keyboard.press('Enter')
    await poll(() => row(page, g1.id).getAttribute('data-status')).toBe('delivered')
    await page.keyboard.press('ControlOrMeta+z')
    await poll(() => row(page, g1.id).getAttribute('data-status')).toBe('review')
    expect(await row(page, g1.id).getAttribute('class')).not.toContain('st-done')
    expect((await view(server)).groups[0]!.status).toBe('review')
    // 成图 中已写出的文件保留
    expect(await outputs(root, g1.sku)).toHaveLength(2)
    expect(errors).toEqual([])
  }, 30_000)

  it('shows ghost placeholders while generating and announces review', async () => {
    const root = await makeSourceTree({ EK52001: { garments: 1, models: 3 } })
    const gate = new Gate()
    gate.close()
    const server = await start(root, 5, gate)
    const { page, errors } = await open(server)
    const groupId = (await view(server)).groups[0]!.id
    await poll(() => row(page, groupId).count()).toBe(1)

    await post(server, '/api/start', {})
    await poll(() => row(page, groupId).getAttribute('data-status')).toMatch(/queued|generating/)
    await poll(() => row(page, groupId).locator('.tile.is-ghost').count()).toBe(3)
    expect(await row(page, groupId).locator('.tile .prog').count()).toBe(3)
    gate.open()

    await poll(() => row(page, groupId).getAttribute('data-status')).toBe('review')
    expect(await row(page, groupId).locator('.tile.is-ghost').count()).toBe(0)
    await poll(() => page.locator('#toast.show').textContent()).toContain('可以判断了')
    expect(errors).toEqual([])
  }, 30_000)
})

describe('studio review at batch scale', () => {
  const spec = Object.fromEntries(
    Array.from({ length: 40 }, (_, index) => [`EK${String(53000 + index)}`, { garments: 1, models: 7 }]),
  )

  async function reviewServer(): Promise<{ root: string; server: StudioServer }> {
    const { root, store } = await makeReviewBatch(spec)
    await store.close()
    return { root, server: await start(root, 30) }
  }

  it('renders 40 × 7 within one second and keeps rows on keyboard moves', async () => {
    const { server } = await reviewServer()
    const { page, errors } = await open(server)
    // 从 DOMContentLoaded 到首行缩略图全部 load（页面打点 studio-first-thumb）
    await page.waitForFunction(() => performance.getEntriesByName('studio-first-thumb').length > 0, undefined, {
      timeout: 10_000,
    })
    const elapsed = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation' as never)[0] as unknown as { domContentLoadedEventStart: number }
      return performance.getEntriesByName('studio-first-thumb')[0]!.startTime - nav.domContentLoadedEventStart
    })
    expect(elapsed).toBeLessThanOrEqual(1000)
    expect(await page.locator('.set').count()).toBe(40)
    expect(await page.locator('.tile').count()).toBe(280)

    // 键盘切换不整表重绘：行元素保持同一 DOM 节点
    await page.evaluate(() => {
      const doc = (globalThis as unknown as { document: { querySelectorAll(selector: string): Iterable<{ __mark?: boolean }> } }).document
      for (const element of doc.querySelectorAll('.set')) element.__mark = true
    })
    for (const key of ['ArrowDown', 'ArrowDown', 'ArrowRight', 'ArrowUp']) await page.keyboard.press(key)
    const kept = await page.evaluate(() => {
      const doc = (globalThis as unknown as { document: { querySelectorAll(selector: string): Iterable<{ __mark?: boolean }> } }).document
      return [...doc.querySelectorAll('.set')].every((element) => element.__mark === true)
    })
    expect(kept).toBe(true)
    expect(errors).toEqual([])
  }, 60_000)

  it('judges a whole batch of 40 groups using only the keyboard', async () => {
    const { root, server } = await reviewServer()
    const state = await view(server)
    const { page, errors } = await open(server)
    await poll(() => page.locator('.set[data-status="review"]').count()).toBe(40)

    const regenAt = new Set([3, 10, 20])
    const excludeAt = new Set([5, 15])
    for (const [index, group] of state.groups.entries()) {
      await poll(() => activeGroup(page)).toBe(group.id)
      const tasks = tasksOf(state, group.id)
      if (regenAt.has(index)) {
        await page.keyboard.press('ArrowRight')
        await page.keyboard.press('r')
        await page.keyboard.press(String((index % 8) + 1))
        await page.keyboard.press('Enter')
        await poll(() => tile(page, tasks[1]!.id).textContent()).toContain('v2/2')
      }
      if (excludeAt.has(index)) {
        await page.keyboard.press('ArrowRight')
        await page.keyboard.press('ArrowRight')
        await page.keyboard.press('x')
        await poll(() => tile(page, tasks[2]!.id).getAttribute('class')).toContain('is-excl')
      }
      await page.keyboard.press('Enter')
      await poll(() => row(page, group.id).getAttribute('data-status')).toBe('delivered')
    }

    const final = await view(server)
    expect(final.groups.every((group) => group.status === 'delivered')).toBe(true)
    expect(await outputs(root, state.groups[5]!.sku)).toHaveLength(6)
    expect(await outputs(root, state.groups[3]!.sku)).toHaveLength(7)
    expect(await page.evaluate(() => (globalThis as unknown as { __mouse: number }).__mouse)).toBe(0)
    expect(errors).toEqual([])
  }, 180_000)
})
