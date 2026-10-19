import { mkdir, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { chromium, type Browser, type Page } from 'playwright'
import sharp from 'sharp'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { RunnerError } from '../../src/errors.js'
import { startStudioServer, type StudioServer } from '../../src/studio/server.js'
import { FakeImageGeneration, fakePng, Gate } from '../helpers/fake-image-generation.js'
import { FakeVision } from '../helpers/fake-vision.js'
import { cleanupSourceTrees, makeJpeg, makeSourceTree } from './helpers.js'

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
  paused: boolean
  settings: { candidates: number; concurrency: number }
  generationCallsUsed: number
  groups: Array<{ id: string; sku: string; status: string; order: number; started: boolean }>
  assets: Array<{ id: string; role: string; preparedHash?: string; cropOverride?: unknown }>
  tasks: Array<{ id: string; groupId: string; status: string; garmentAssetId: string }>
}

async function start(
  root: string,
  options: { images?: FakeImageGeneration; vision?: FakeVision; imagePriceCny?: number } = {},
): Promise<StudioServer> {
  const server = await startStudioServer({
    sourceRoot: root,
    deps: { vision: options.vision ?? new FakeVision(), images: options.images ?? new FakeImageGeneration(undefined, 5) },
    ...(options.imagePriceCny === undefined ? {} : { imagePriceCny: options.imagePriceCny }),
  })
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
  state.groups.sort((left, right) => left.order - right.order)
  return state
}

async function preparedSize(server: StudioServer, assetId: string): Promise<{ width: number; height: number }> {
  const response = await fetch(apiUrl(server, `/files/asset/${assetId}?variant=prepared`))
  expect(response.status).toBe(200)
  const meta = await sharp(Buffer.from(await response.arrayBuffer())).metadata()
  return { width: meta.width!, height: meta.height! }
}

async function open(server: StudioServer): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  pages.push(page)
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort())
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(server.url)
  return { page, errors }
}

function poll<T>(fn: () => T | Promise<T>, timeout = 10_000) {
  return expect.poll(fn, { timeout, interval: 30 })
}

function row(page: Page, groupId: string) {
  return page.locator(`.set[data-group-id="${groupId}"]`)
}

async function waitStatuses(server: StudioServer, statuses: string[]): Promise<ViewLike> {
  let current: ViewLike | undefined
  await vi.waitFor(async () => {
    current = await view(server)
    expect(current.groups.map((group) => group.status)).toEqual(statuses)
  }, { timeout: 20_000, interval: 50 })
  return current!
}

/** 所有未开始组的服装都已准备好（裁后图可用）。 */
async function waitPrepared(server: StudioServer): Promise<ViewLike> {
  let current: ViewLike | undefined
  await vi.waitFor(async () => {
    current = await view(server)
    const garments = new Set(current.tasks.map((task) => task.garmentAssetId))
    expect(current.assets.filter((asset) => garments.has(asset.id)).every((asset) => asset.preparedHash !== undefined))
      .toBe(true)
  }, { timeout: 20_000, interval: 50 })
  return current!
}

describe('studio setup view', () => {
  it('summarises checked groups, shows the estimate and starts only the checked groups', async () => {
    const root = await makeSourceTree({
      EK61001: { garments: 1, models: 4 },
      EK61002: { garments: 1, models: 4 },
      EK61003: { garments: 1, models: 4 },
      EK61004: { garments: 1, models: 4 },
    })
    const server = await start(root, { imagePriceCny: 0.2 })
    const { page, errors } = await open(server)
    const groups = (await view(server)).groups

    await poll(() => page.locator('.set[data-status="idle"]').count()).toBe(4)
    await poll(() => page.locator('#setup').textContent()).toContain('共 4 套、16 张任务、16 次生成')
    expect(await page.locator('#setup').textContent()).toContain('预计约 ¥3.2')
    // 每行都有勾选框，默认全选；模特图全部可见
    expect(await page.locator('.set input.pick:checked').count()).toBe(4)
    expect(await row(page, groups[0]!.id).locator('.tile').count()).toBe(4)

    await row(page, groups[3]!.id).locator('input.pick').click()
    await page.selectOption('#setup select[name="candidates"]', '2')
    await poll(() => page.locator('#setup').textContent()).toContain('共 3 套、12 张任务、24 次生成')
    expect(await page.locator('#setup').textContent()).toContain('预计约 ¥4.8')
    expect((await view(server)).settings.candidates).toBe(2)

    await page.locator('#setup .start').click()
    const done = await waitStatuses(server, ['review', 'review', 'review', 'idle'])
    expect(done.groups.map((group) => group.started)).toEqual([true, true, true, false])
    expect(done.generationCallsUsed).toBe(24)
    // 剩下的一套仍在素材表里（保持未勾选），设置条继续显示；重新勾选后计入
    await poll(() => page.locator('#setup').textContent()).toContain('共 0 套、0 张任务、0 次生成')
    await row(page, groups[3]!.id).locator('input.pick').click()
    await poll(() => page.locator('#setup').textContent()).toContain('共 1 套、4 张任务、8 次生成')
    expect(errors).toEqual([])
  }, 60_000)

  it('starts with Enter from the setup bar, pauses, resumes and applies a new concurrency', async () => {
    const root = await makeSourceTree({ EK62001: { garments: 1, models: 6 }, EK62002: { garments: 1, models: 6 } })
    // 闸门关住首批调用：默认并发 5 一定能打满，再改并发
    const gate = new Gate()
    gate.close()
    const images = new FakeImageGeneration(async (_request, callIndex, signal) => {
      await gate.wait(signal)
      return fakePng(`fake-${String(callIndex + 1)}`)
    }, 400)
    const server = await start(root, { images })
    const { page, errors } = await open(server)
    await poll(() => page.locator('.set[data-status="idle"]').count()).toBe(2)

    await page.locator('#setup .start').focus()
    await page.keyboard.press('Enter')
    await vi.waitFor(() => expect(images.active).toBe(5), { timeout: 10_000, interval: 20 })
    await poll(() => page.locator('#run').isVisible()).toBe(true)

    await page.selectOption('#run select[name="concurrency"]', '2')
    await poll(async () => (await view(server)).settings.concurrency).toBe(2)
    gate.open()
    await vi.waitFor(() => expect(images.active).toBeLessThanOrEqual(2), { timeout: 10_000, interval: 10 })
    images.maxActive = 0

    await page.locator('#run [data-run="pause"]').click()
    await poll(async () => (await view(server)).paused).toBe(true)
    await poll(() => page.locator('#run [data-run="pause"]').textContent()).toContain('继续')
    await page.locator('#run [data-run="pause"]').click()
    await poll(async () => (await view(server)).paused).toBe(false)

    await waitStatuses(server, ['review', 'review'])
    expect(images.maxActive).toBeGreaterThan(0)
    expect(images.maxActive).toBeLessThanOrEqual(2)
    expect(errors).toEqual([])
  }, 60_000)

  it('shows the failure summary and retries all failed tasks', async () => {
    const root = await makeSourceTree({ EK63001: { garments: 1, models: 3 } })
    const images = new FakeImageGeneration((_request, callIndex) => {
      if (callIndex === 0) throw new RunnerError('PROVIDER_ERROR', 'fake provider failure')
      return fakePng(`fake-${String(callIndex + 1)}`)
    }, 5)
    const server = await start(root, { images })
    const { page, errors } = await open(server)
    await poll(() => page.locator('.set[data-status="idle"]').count()).toBe(1)

    await page.locator('#setup .start').click()
    await waitStatuses(server, ['failed'])
    const retry = page.locator('#run [data-run="retry"]')
    await poll(() => retry.textContent()).toContain('重试所有失败（1）')
    await poll(() => page.locator('.tile .cap').allTextContents()).toContainEqual(expect.stringContaining('fake provider failure'))

    await retry.click()
    await waitStatuses(server, ['review'])
    await poll(() => retry.count()).toBe(0)
    expect(errors).toEqual([])
  }, 60_000)

  it('marks a failed image as not delivered with X and passes the rest of the group', async () => {
    const root = await makeSourceTree({ EK63101: { garments: 1, models: 3 } })
    const images = new FakeImageGeneration((_request, callIndex) => {
      if (callIndex === 0) throw new RunnerError('PROVIDER_ERROR', 'fake provider failure')
      return fakePng(`fake-${String(callIndex + 1)}`)
    }, 5)
    const server = await start(root, { images })
    const { page, errors } = await open(server)
    await poll(() => page.locator('.set[data-status="idle"]').count()).toBe(1)

    await page.locator('#setup .start').click()
    const state = await waitStatuses(server, ['failed'])
    const failed = state.tasks.find((task) => task.status === 'failed')!
    const tile = page.locator(`.tile[data-task-id="${failed.id}"]`)
    await tile.click()
    await poll(() => page.locator('#insp').textContent()).toContain('生成失败')

    await page.keyboard.press('x')
    await poll(() => tile.getAttribute('class')).toContain('is-excl')
    await waitStatuses(server, ['review'])
    await poll(() => page.locator('#run [data-run="retry"]').count()).toBe(0)

    await page.keyboard.press('Enter')
    await waitStatuses(server, ['delivered'])
    expect(await readdir(path.join(root, '成图', 'EK63101'))).toHaveLength(2)
    expect(errors).toEqual([])
  }, 60_000)

  it('saves a manual crop from the crop layer and restores the automatic crop', async () => {
    const root = await makeSourceTree({ EK64001: { garments: 1, models: 3 } })
    // 足够大的服装图，裁切框才能满足最小短边
    const big = await sharp({ create: { width: 1000, height: 1400, channels: 3, background: { r: 180, g: 120, b: 90 } } })
      .jpeg()
      .toBuffer()
    await writeFile(path.join(root, 'EK64001', '服装', '01.jpg'), big)
    const server = await start(root)
    const state = await waitPrepared(server)
    const group = state.groups[0]!
    const garmentId = state.tasks[0]!.garmentAssetId
    const before = await preparedSize(server, garmentId)
    const hashBefore = state.assets.find((asset) => asset.id === garmentId)!.preparedHash!

    const { page, errors } = await open(server)
    await poll(() => row(page, group.id).locator('.garment img').getAttribute('src')).toContain(hashBefore.slice(0, 12))
    await page.keyboard.press('c')
    await poll(() => page.locator('#crop.open').count()).toBe(1)
    // 原图加载完成后裁切框才有尺寸
    await poll(async () => (await page.locator('#crop .box').boundingBox())?.width ?? 0).toBeGreaterThan(100)
    const handle = await page.locator('#crop .h[data-h="se"]').boundingBox()
    expect(handle).not.toBeNull()
    const x = handle!.x + handle!.width / 2
    const y = handle!.y + handle!.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x - 120, y - 60, { steps: 6 })
    await page.mouse.up()
    await page.keyboard.press('Enter')
    await poll(() => page.locator('#crop.open').count()).toBe(0)

    let after: ViewLike | undefined
    await vi.waitFor(async () => {
      after = await view(server)
      const asset = after.assets.find((candidate) => candidate.id === garmentId)!
      expect(asset.cropOverride).toBeDefined()
      expect(asset.preparedHash).toBeDefined()
      expect(asset.preparedHash).not.toBe(hashBefore)
    }, { timeout: 20_000, interval: 50 })
    const resized = await preparedSize(server, garmentId)
    expect(resized.width / resized.height).not.toBeCloseTo(before.width / before.height, 2)
    const hashAfter = after!.assets.find((asset) => asset.id === garmentId)!.preparedHash!
    await poll(() => row(page, group.id).locator('.garment img').getAttribute('src')).toContain(hashAfter.slice(0, 12))

    // Backspace 恢复自动裁切
    await page.keyboard.press('c')
    await poll(() => page.locator('#crop.open').count()).toBe(1)
    await page.keyboard.press('Backspace')
    await poll(() => page.locator('#crop.open').count()).toBe(0)
    await vi.waitFor(async () => {
      const asset = (await view(server)).assets.find((candidate) => candidate.id === garmentId)!
      expect(asset.cropOverride).toBeUndefined()
    }, { timeout: 10_000, interval: 50 })
    expect(errors).toEqual([])
  }, 60_000)

  it('lets a manual crop rescue a group whose automatic crop failed before starting', async () => {
    const root = await makeSourceTree({ EK67001: { garments: 1, models: 3 } })
    const big = await sharp({ create: { width: 1000, height: 1400, channels: 3, background: { r: 180, g: 120, b: 90 } } })
      .jpeg()
      .toBuffer()
    await writeFile(path.join(root, 'EK67001', '服装', '01.jpg'), big)
    // 定位结果覆盖整张图：自动裁切被拒，组准备失败
    const vision = new FakeVision(() => ({ bbox: [0, 0, 1000, 1000] }))
    const server = await start(root, { vision })
    const [group] = (await waitStatuses(server, ['failed'])).groups
    const { page, errors } = await open(server)
    await poll(() => row(page, group!.id).locator('.garment .cap').textContent()).toContain('准备失败')
    expect(await row(page, group!.id).locator('input.pick').count()).toBe(0)

    await page.keyboard.press('c')
    await poll(async () => (await page.locator('#crop .box').boundingBox())?.width ?? 0).toBeGreaterThan(100)
    const handle = (await page.locator('#crop .h[data-h="se"]').boundingBox())!
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
    await page.mouse.down()
    await page.mouse.move(handle.x - 120, handle.y - 60, { steps: 6 })
    await page.mouse.up()
    await page.keyboard.press('Enter')

    await waitStatuses(server, ['idle'])
    await waitPrepared(server)
    await poll(() => row(page, group!.id).locator('input.pick:checked').count()).toBe(1)
    await poll(() => page.locator('#setup').textContent()).toContain('共 1 套、3 张任务、3 次生成')
    expect(errors).toEqual([])
  }, 60_000)

  it('re-prepares an unstarted group whose preparation failed from its row', async () => {
    const root = await makeSourceTree({ EK67101: { garments: 1, models: 3 } })
    // 第一次定位失败（准备失败），之后正常
    const vision = new FakeVision((_request, callIndex) => {
      if (callIndex === 0) throw new RunnerError('PROVIDER_ERROR', 'fake locate failure')
      return { bbox: [100, 100, 900, 900] }
    })
    const server = await start(root, { vision })
    const [group] = (await waitStatuses(server, ['failed'])).groups
    const { page, errors } = await open(server)
    await poll(() => row(page, group!.id).locator('.garment .cap').textContent()).toContain('准备失败 · fake locate failure')
    const button = row(page, group!.id).locator('[data-prep]')
    await poll(() => button.textContent()).toContain('重新准备')

    await button.click()
    await waitStatuses(server, ['idle'])
    await waitPrepared(server)
    await poll(() => row(page, group!.id).locator('input.pick:checked').count()).toBe(1)
    expect(await button.count()).toBe(0)
    await poll(() => page.locator('#setup').textContent()).toContain('共 1 套、3 张任务、3 次生成')
    expect(errors).toEqual([])
  }, 60_000)

  it('counts tasks blocked by a failed preparation in a started group and retries them', async () => {
    const root = await makeSourceTree({ EK68001: { garments: 1, models: 3 } })
    // 第一次定位失败（组准备失败），之后正常
    const vision = new FakeVision((_request, callIndex) => {
      if (callIndex === 0) throw new RunnerError('PROVIDER_ERROR', 'fake locate failure')
      return { bbox: [100, 100, 900, 900] }
    })
    const server = await start(root, { vision })
    const [group] = (await waitStatuses(server, ['failed'])).groups
    const response = await fetch(apiUrl(server, '/api/start'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: new URL(server.url).origin },
      body: JSON.stringify({ groupIds: [group!.id] }),
    })
    expect(response.status).toBe(200)
    const { page, errors } = await open(server)
    const retry = page.locator('#run [data-run="retry"]')
    await poll(() => retry.textContent()).toContain('重试所有失败（3）')
    await poll(() => row(page, group!.id).locator('.garment .cap').textContent()).toContain('准备失败')

    await retry.click()
    await waitStatuses(server, ['review'])
    await poll(() => retry.count()).toBe(0)
    expect(errors).toEqual([])
  }, 60_000)

  it('reloads an expanded prompt after the group scope changes', async () => {
    const root = await makeSourceTree({ EK69001: { garments: 1, models: 3 } })
    const server = await start(root)
    await waitPrepared(server)
    const { page, errors } = await open(server)
    const [group] = (await view(server)).groups
    await poll(() => page.locator('.set').count()).toBe(1)

    await page.keyboard.press('e')
    await poll(() => page.locator('.set .prompt').textContent()).toContain('测试服装')
    const before = await page.locator('.set .prompt').textContent()
    const expected = await (async () => {
      await row(page, group!.id).locator('select[data-gset="scope"]').selectOption('top')
      let prompt = ''
      await vi.waitFor(async () => {
        const state = await view(server)
        const task = state.tasks.find((candidate) => candidate.groupId === group!.id)!
        const data = (await (await fetch(apiUrl(server, `/api/prompt/${task.id}`))).json()) as { prompt?: string }
        // 换装范围改为上装后提示词重新生成
        expect(data.prompt).toBeDefined()
        expect(data.prompt).not.toBe(before)
        prompt = data.prompt!
      }, { timeout: 20_000, interval: 50 })
      return prompt
    })()
    await poll(() => page.locator('.set .prompt').textContent()).toBe(expected)
    expect(errors).toEqual([])
  }, 60_000)

  it('rescans on focus and appends new groups at the end; expands the prompt with E', async () => {
    const root = await makeSourceTree({ EK65001: { garments: 1, models: 3 } })
    const server = await start(root)
    await waitPrepared(server)
    const { page, errors } = await open(server)
    await poll(() => page.locator('.set').count()).toBe(1)

    // E：展开本组提示词（只读）
    await page.keyboard.press('e')
    await poll(() => page.locator('.set .prompt').textContent()).toContain('测试服装')

    await mkdir(path.join(root, 'EK65002', '服装'), { recursive: true })
    await mkdir(path.join(root, 'EK65002', '模特'), { recursive: true })
    await writeFile(path.join(root, 'EK65002', '服装', '01.jpg'), await makeJpeg())
    await writeFile(path.join(root, 'EK65002', '模特', '01.jpg'), await makeJpeg())
    await page.evaluate(() => (globalThis as unknown as { dispatchEvent(event: Event): void }).dispatchEvent(new Event('focus')))

    await poll(() => page.locator('.set').count(), 15_000).toBe(2)
    expect(await page.locator('.set .sku').last().textContent()).toBe('EK65002')
    expect(errors).toEqual([])
  }, 60_000)

  it('marks a pair-mode group with mismatched counts as incomplete and not selectable', async () => {
    const root = await makeSourceTree({ EK66001: { garments: 1, models: 3 }, EK66002: { garments: 2, models: 3 } })
    const server = await start(root)
    const { page, errors } = await open(server)
    const [g1, g2] = (await view(server)).groups
    await poll(() => page.locator('.set[data-status="idle"]').count()).toBe(2)

    await row(page, g2!.id).locator('select[data-gset="mode"]').selectOption('pair')
    await poll(() => row(page, g2!.id).getAttribute('data-status')).toBe('incomplete')
    const text = await row(page, g2!.id).textContent()
    expect(text).toContain('一对一：服装 2 张 · 模特 3 张，数量不一致')
    expect(text).toContain('补齐后自动加入队列，其他套不受影响')
    expect(await row(page, g2!.id).locator('input.pick').count()).toBe(0)
    expect(await row(page, g1!.id).locator('input.pick').count()).toBe(1)
    await poll(() => page.locator('#setup').textContent()).toContain('共 1 套、3 张任务、3 次生成')
    expect(errors).toEqual([])
  }, 60_000)
})
