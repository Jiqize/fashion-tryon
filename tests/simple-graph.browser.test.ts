import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { chromium, type Browser, type Page } from 'playwright'
import sharp from 'sharp'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { startEditorServer } from '../src/editor/server.js'
import { createFakeGenerator } from '../src/simple/generators.js'
import { KEEP_FRAME_SENTENCE } from '../src/simple/collection.js'
import { renderRunData, writeGraphFiles } from '../src/simple/graph.js'
import { renderSimpleReport } from '../src/simple/report.js'
import { countShots, readRunRecord, runsDir, writeRunRecord, type RunGroup, type RunRecord } from '../src/simple/record.js'
import { runSimple } from '../src/simple/run.js'
import { fixtureImageBytes } from './helpers/image-bytes.js'

let browser: Browser
const roots: string[] = []

beforeAll(async () => {
  browser = await chromium.launch()
})

afterAll(async () => {
  await browser.close()
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tinyJpeg(file: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  await sharp({ create: { width: 8, height: 12, channels: 3, background: '#999999' } }).jpeg().toFile(file)
}

/** skus 中每项为 [款号, 张数]；张数 0 表示缺模特图被跳过。 */
async function makeRecord(skus: [string, number][], extra: Partial<RunRecord> = {}): Promise<RunRecord> {
  const root = await mkdtemp(path.join(tmpdir(), 'simple-graph-'))
  roots.push(root)
  const runId = '20261015-090000'
  const runDir = path.join(runsDir(root), runId)
  const groups: RunGroup[] = []
  for (const [sku, count] of skus) {
    if (count === 0) {
      groups.push({ sku, referenceSource: 'originals', swap: 'outfit', promptEdited: false, references: [], prompt: 'p', shots: [], note: '缺少模特图，跳过' })
      continue
    }
    const references = [{ file: `裁图/${sku}/01-全身-正面.jpg`, thumb: `ref/${sku}/g1.jpg`, role: '全身-正面' }]
    await tinyJpeg(path.join(runDir, references[0]!.thumb))
    const shots = []
    for (let index = 1; index <= count; index += 1) {
      const modelThumb = `ref/${sku}/m${String(index)}.jpg`
      await tinyJpeg(path.join(runDir, modelThumb))
      shots.push({ model: `模特/${sku}/m${String(index)}.jpg`, modelThumb, state: 'queued' as const })
    }
    groups.push({ sku, referenceSource: 'crops', swap: 'outfit', promptEdited: false, references, prompt: `prompt for ${sku}`, shots })
  }
  const now = new Date().toISOString()
  const record: RunRecord = {
    schemaVersion: 2,
    runId,
    sourceRoot: root,
    runDir,
    reportPath: path.join(runDir, 'report.html'),
    graphPath: path.join(runDir, 'graph.html'),
    engine: 'fake',
    params: { swap: 'outfit', skus: null, maxReferences: 6, engine: 'fake' },
    status: 'running',
    pid: process.pid,
    startedAt: now,
    finishedAt: null,
    heartbeatAt: now,
    current: null,
    derivedFrom: null,
    groups,
    counts: countShots(groups),
    ...extra,
  }
  await mkdir(runDir, { recursive: true })
  await writeGraphFiles(record)
  return record
}

async function open(record: RunRecord): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 600 } })
  await page.goto(pathToFileURL(record.graphPath).href)
  await page.waitForSelector('.lane')
  return page
}

async function markDone(record: RunRecord, gi: number, si: number): Promise<void> {
  const shot = record.groups[gi]!.shots[si]!
  shot.state = 'done'
  shot.result = shot.modelThumb
  shot.delivered = `成图/${record.groups[gi]!.sku}/m${String(si + 1)}.png`
  record.counts = countShots(record.groups)
  await writeFile(path.join(record.runDir, 'run-data.js'), renderRunData(record))
}

describe('graph page', () => {
  it('shows the full plan as queued with skipped groups', async () => {
    const record = await makeRecord([['A1', 3], ['B2', 0]])
    const page = await open(record)
    expect(await page.locator('.lane').count()).toBe(2)
    expect(await page.locator('.lane', { hasText: 'B2' }).innerText()).toContain('缺少模特图，跳过')
    expect(await page.locator('.out .state').allInnerTexts()).toEqual(['排队', '排队', '排队'])
    expect(await page.locator('#meta').innerText()).toContain('已完成 0 / 计划 3')
    await page.close()
  })

  it('refreshes changed nodes without moving the scroll position', async () => {
    const record = await makeRecord([['A1', 6], ['A2', 6], ['A3', 6]])
    const page = await open(record)
    await page.evaluate('window.scrollTo(0, document.body.scrollHeight)')
    const scrollY = await page.evaluate<number>('window.scrollY')
    expect(scrollY).toBeGreaterThan(0)
    await markDone(record, 0, 0)
    await page.waitForFunction("document.querySelector('#s0-0 .state')?.textContent === '已完成'", null, { timeout: 4000 })
    expect(await page.locator('#s0-0 .file').innerText()).toBe('m1.png')
    expect(await page.evaluate<number>('window.scrollY')).toBe(scrollY)
    await page.close()
  })

  it('stops polling once the run has finished', async () => {
    const record = await makeRecord([['A1', 2]], { status: 'completed', finishedAt: new Date().toISOString() })
    const page = await open(record)
    await markDone(record, 0, 0)
    await page.waitForTimeout(7000)
    expect(await page.locator('#s0-0 .state').innerText()).toBe('排队')
    await page.close()
  })

  it('shows interrupted when the heartbeat is stale', async () => {
    const stale = new Date(Date.now() - 120_000).toISOString()
    const record = await makeRecord([['A1', 1]], { startedAt: stale, heartbeatAt: stale })
    const page = await open(record)
    expect(await page.locator('#meta .status').innerText()).toBe('已中断')
    await page.close()
  })

  it('opens model and result side by side and closes on Escape', async () => {
    const record = await makeRecord([['A1', 1]])
    await markDone(record, 0, 0)
    const page = await open(record)
    await page.click('#s0-0 img[data-role="result"]')
    expect(await page.locator('#lb img').count()).toBe(2)
    await page.keyboard.press('Escape')
    expect(await page.locator('#lb').isHidden()).toBe(true)
    await page.close()
  })

  it('renders 8 groups with 33 shots within a second', async () => {
    const counts = [5, 4, 4, 4, 4, 4, 4, 4]
    const record = await makeRecord(counts.map((count, index) => [`S${String(index)}`, count]))
    const page = await browser.newPage()
    // DOMContentLoaded 到第一条泳道出现的耗时
    await page.addInitScript(`document.addEventListener('DOMContentLoaded', () => {
      const start = performance.now()
      const observer = new MutationObserver(() => {
        if (document.querySelector('.lane') !== null) { window.__firstLane = performance.now() - start; observer.disconnect() }
      })
      observer.observe(document.body, { childList: true, subtree: true })
    })`)
    await page.goto(pathToFileURL(record.graphPath).href)
    await page.waitForSelector('.lane')
    expect(await page.locator('.out').count()).toBe(33)
    expect(await page.evaluate<number>('window.__firstLane')).toBeLessThan(1000)
    await page.close()
  })
})

async function rewrite(record: RunRecord): Promise<void> {
  record.counts = countShots(record.groups)
  await writeFile(path.join(record.runDir, 'run-data.js'), renderRunData(record))
}

describe('graph page for the editor', () => {
  it('is read-only under file:// and does not load the editor', async () => {
    const record = await makeRecord([['A1', 1]])
    const page = await browser.newPage()
    const requested: string[] = []
    page.on('request', (request) => requested.push(request.url()))
    await page.goto(pathToFileURL(record.graphPath).href)
    await page.waitForSelector('.lane')
    expect(await page.locator('#ro').innerText()).toBe('只读页面：要编辑请让 Agent 调用 open_graph，或运行 fashion-tryon editor <素材根目录>')
    expect(requested.some((url) => url.includes('editor.js') || url.includes('editor.css'))).toBe(false)
    // 只读页不加载任何 /ui/ 脚本或样式
    expect(requested.some((url) => url.includes('/ui/'))).toBe(false)
    expect(await page.locator('script[src]').count()).toBe(0)
    expect(await page.locator('.lane[data-sku="A1"] .pair[data-sku="A1"][data-model="模特/A1/m1.jpg"]').count()).toBe(1)
    await page.close()
  })

  it('links back to the source run', async () => {
    const record = await makeRecord([['A1', 1]], { derivedFrom: '20261015-123035' })
    const page = await open(record)
    const link = page.locator('#from a')
    expect(await page.locator('#from').innerText()).toBe('来自 20261015-123035')
    expect(await link.getAttribute('href')).toBe('../20261015-123035/graph.html')
    await page.close()
  })

  it('shows swap, custom references and edited prompts per group', async () => {
    const record = await makeRecord([['A1', 1], ['B2', 1]])
    record.groups[0]!.swap = 'top'
    record.groups[0]!.referenceSource = 'custom'
    record.groups[0]!.promptEdited = true
    await rewrite(record)
    const page = await open(record)
    expect(await page.locator('.lane[data-sku="A1"] .prompt .swap').innerText()).toBe('只换上衣')
    expect(await page.locator('.lane[data-sku="B2"] .prompt .swap').innerText()).toBe('换整套')
    expect(await page.locator('.lane[data-sku="A1"] .label').first().innerText()).toBe('服装参考图 · 自选')
    expect(await page.locator('.lane[data-sku="B2"] .label').first().innerText()).toBe('服装参考图 · 裁图')
    expect(await page.locator('.lane[data-sku="A1"] .prompt .edited').innerText()).toBe('已改')
    expect(await page.locator('.lane[data-sku="B2"] .prompt .edited').count()).toBe(0)
    await page.close()
  })

  it('loads the editor and exposes the graph API over http', async () => {
    const record = await makeRecord([['A1', 1]], { derivedFrom: '20261015-123035' })
    await writeRunRecord(record)
    const server = await startEditorServer({ sourceRoot: record.sourceRoot, launch: { cliCommand: [] } })
    try {
      const page = await browser.newPage()
      const requested: string[] = []
      page.on('request', (request) => requested.push(new URL(request.url()).pathname))
      // 记录 editor-panel.js 开始执行时共享控件是否已就绪
      await page.route('**/ui/editor-panel.js', async (route) => {
        const response = await route.fetch()
        await route.fulfill({ response, body: `window.__uiReadyAtPanel = typeof window.__UI__ === 'object';\n${await response.text()}` })
      })
      await page.goto(`${server.origin}/runs/${record.runId}/?token=${server.token}`)
      await page.waitForSelector('.lane')
      expect(requested).toEqual(expect.arrayContaining(['/ui/editor.css', '/ui/controls.js', '/ui/editor.js']))
      await page.waitForFunction('window.__uiReadyAtPanel !== undefined')
      expect(await page.evaluate('window.__uiReadyAtPanel')).toBe(true)
      expect(await page.locator('#ro').isHidden()).toBe(true)
      expect(await page.locator('#from a').getAttribute('href')).toBe('/runs/20261015-123035/')
      expect(await page.evaluate("window.__GRAPH__.getRun().runId")).toBe(record.runId)
      await page.evaluate("window.__seen = 0; window.__GRAPH__.onRender(() => { window.__seen += 1 }); window.__GRAPH__.rebuild()")
      expect(await page.evaluate('window.__seen')).toBeGreaterThan(0)
      expect(await page.locator('.lane').count()).toBe(1)
      await page.close()
    } finally {
      await server.close()
    }
  })
})

/** 固定模特：每件衣服一组（同款号、带 item），每组 1 张。 */
async function makeItemRecord(items: string[], extraPrompt?: string): Promise<RunRecord> {
  const record = await makeRecord([])
  const groups: RunGroup[] = []
  for (const [index, item] of items.entries()) {
    const thumb = `ref/A1/${String(index + 1)}/${item}`
    const modelThumb = `ref/A1/${String(index + 1)}/m1.jpg`
    await tinyJpeg(path.join(record.runDir, thumb))
    await tinyJpeg(path.join(record.runDir, modelThumb))
    groups.push({
      sku: 'A1', referenceSource: 'originals', swap: 'outfit', promptEdited: false, prompt: `prompt ${item}`,
      references: [{ file: `服装/A1/${item}`, thumb }],
      shots: [{ model: '模特/A1/m1.jpg', modelThumb, state: 'queued', ...(extraPrompt === undefined ? {} : { extraPrompt }) }],
      pairing: 'fixedModel', item: `服装/A1/${item}`,
    })
  }
  record.groups = groups
  await rewrite(record)
  return record
}

describe('graph page with pairing combos', () => {
  it('keeps the fixed garment lanes byte-identical', async () => {
    const record = await makeRecord([['A1', 2], ['B2', 0]])
    await markDone(record, 0, 0)
    const page = await open(record)
    await expect(await page.locator('#lanes').innerHTML()).toMatchFileSnapshot('__snapshots__/graph-fixed-garment.html')
    await page.close()
  })

  it('keeps one report section per combo of the same sku', async () => {
    const record = await makeItemRecord(['g1.jpg', 'g2.jpg', 'g3.jpg'])
    const html = renderSimpleReport(record, record.sourceRoot)
    expect([...html.matchAll(/<section id="([^"]+)">/g)].map((match) => match[1])).toEqual(['A1', 'A1-2', 'A1-3'])
    expect([...html.matchAll(/<h2>([^<]+)<\/h2>/g)].map((match) => match[1])).toEqual(['A1 · g1.jpg', 'A1 · g2.jpg', 'A1 · g3.jpg'])
    expect(html).toContain('<a href="#A1-3">A1 · g3.jpg</a>')
  })

  it('shows one read-only lane per garment with the garment name and the extra prompt', async () => {
    const record = await makeItemRecord(['g1.jpg', 'g2.jpg', 'g3.jpg'], KEEP_FRAME_SENTENCE)
    const page = await open(record)
    expect(await page.locator('.lane[data-sku="A1"][data-item]').count()).toBe(3)
    expect(await page.locator('.lane[data-item] h2').allInnerTexts()).toEqual(['A1 · g1.jpg', 'A1 · g2.jpg', 'A1 · g3.jpg'])
    expect(await page.locator('.pair[data-item="服装/A1/g2.jpg"][data-model="模特/A1/m1.jpg"]').count()).toBe(1)
    expect(await page.locator('.lane[data-item="服装/A1/g1.jpg"] .extra').innerText()).toBe(`追加：${[...KEEP_FRAME_SENTENCE].slice(0, 20).join('')}…`)
    await page.close()
  })
})

describe('runSimple writes graph files', () => {
  it('leaves graph.html, run-data.js, report.html and run.json in sync', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'simple-graph-run-'))
    roots.push(root)
    for (const [index, file] of ['服装/EX1/g1.jpg', '模特/EX1/m1.jpg'].entries()) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true })
      await writeFile(path.join(root, file), await fixtureImageBytes(index + 1))
    }
    const result = await runSimple({ sourceRoot: root, generator: createFakeGenerator() })
    const data = await readFile(path.join(result.runDir, 'run-data.js'), 'utf8')
    const parsed = JSON.parse(data.replace(/^window\.__RUN__ = /, '').replace(/;\s*$/, '')) as RunRecord
    expect(parsed).toEqual(await readRunRecord(result.runDir))
    await expect(readFile(result.graphPath, 'utf8')).resolves.toContain('出图节点图')
    await expect(readFile(result.reportPath, 'utf8')).resolves.toContain('试衣结果')
  })
})
