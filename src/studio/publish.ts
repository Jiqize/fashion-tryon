import { randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'

import { RunnerError } from '../errors.js'
import type { BatchState, Group, Task, Version } from './model.js'
import type { BatchStore } from './store.js'

export interface PublishResult {
  /** 交付目录（绝对路径，只用于展示，不写入状态） */
  dir: string
  /** 本次新写出的文件（相对素材根目录） */
  files: string[]
  /** 已存在且内容相同、跳过写入的文件（相对素材根目录） */
  skippedSame: string[]
  /** 这套交付的全部文件，按任务顺序（新写出 + 内容相同跳过），写入 group.delivered 与映射表 */
  outputs: string[]
}

const OUTPUT_ROOT = '成图'

function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join('/')
}

export function sourceRootOf(store: BatchStore): string {
  return path.resolve(store.dir, store.state().sourceRoot)
}

function findGroup(state: BatchState, groupId: string): Group {
  const group = state.groups.find((candidate) => candidate.id === groupId)
  if (group === undefined) throw new RunnerError('NOT_FOUND', `Unknown group: ${groupId}`)
  return group
}

function assetPath(state: BatchState, assetId: string): string {
  const asset = state.assets.find((candidate) => candidate.id === assetId)
  if (asset === undefined) throw new RunnerError('INTEGRITY_ERROR', `Unknown asset: ${assetId}`)
  return asset.relativePath
}

/** 一套里要交付的任务：未标记不交付、且有采用版本，按任务顺序。 */
export function deliverableTasks(state: BatchState, groupId: string): Array<{ task: Task; version: Version }> {
  const result: Array<{ task: Task; version: Version }> = []
  for (const task of state.tasks) {
    if (task.groupId !== groupId || task.excluded) continue
    const version = task.versions.find((candidate) => candidate.id === task.chosenVersionId)
    if (version !== undefined) result.push({ task, version })
  }
  return result
}

/** 款号用作目录名：不允许为空或含路径分隔符。 */
function safeSku(sku: string): string {
  if (sku === '' || sku === '.' || sku === '..' || /[\\/]/.test(sku)) {
    throw new RunnerError('VALIDATION_ERROR', `款号不能用作目录名：${sku}`)
  }
  return sku
}

function baseName(relativePath: string): string {
  const name = path.posix.basename(relativePath)
  return name.slice(0, name.length - path.posix.extname(name).length)
}

async function readIfExists(filePath: string): Promise<Buffer | undefined> {
  try {
    return await readFile(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * 写到 stem.ext；已存在且内容相同 → 跳过；内容不同 → 依次尝试 stem_2、stem_3…
 * 先写临时文件再 link 到目标（目标存在时 link 失败），从不覆盖。
 */
async function deliverFile(
  directory: string,
  stem: string,
  extension: string,
  bytes: Buffer,
): Promise<{ name: string; skipped: boolean }> {
  const temporary = path.join(directory, `.${stem}.tmp-${String(process.pid)}-${randomUUID()}`)
  const handle = await open(temporary, 'wx', 0o644)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    for (let attempt = 1; ; attempt += 1) {
      const name = attempt === 1 ? `${stem}${extension}` : `${stem}_${String(attempt)}${extension}`
      const target = path.join(directory, name)
      const existing = await readIfExists(target)
      if (existing !== undefined) {
        if (existing.equals(bytes)) return { name, skipped: true }
        continue
      }
      try {
        await link(temporary, target)
        return { name, skipped: false }
      } catch (error) {
        // 检查与写入之间被别人抢先写了同名文件：重新比较这个名字
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          attempt -= 1
          continue
        }
        throw error
      }
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

/** 把一套的采用版本复制到 <素材根>/成图/<款号>/，不写状态。 */
export async function publishGroup(store: BatchStore, groupId: string): Promise<PublishResult> {
  const state = store.state()
  const group = findGroup(state, groupId)
  const sku = safeSku(group.sku)
  const mode = group.mode ?? state.settings.mode
  const directory = path.join(sourceRootOf(store), OUTPUT_ROOT, sku)
  await mkdir(directory, { recursive: true })

  const result: PublishResult = { dir: directory, files: [], skippedSame: [], outputs: [] }
  for (const { task, version } of deliverableTasks(state, groupId)) {
    // fixedModel 模式按服装图命名，其余按模特图命名
    const named = mode === 'fixedModel' ? task.garmentAssetId : task.modelAssetId
    const stem = `${sku}_${baseName(assetPath(state, named))}`
    const extension = path.extname(version.relativePath)
    const bytes = await readFile(store.resolve(version.relativePath))
    const written = await deliverFile(directory, stem, extension, bytes)
    const relative = toPosix(path.join(OUTPUT_ROOT, sku, written.name))
    if (written.skipped) result.skippedSame.push(relative)
    else result.files.push(relative)
    result.outputs.push(relative)
  }
  return result
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

async function writeTextAtomic(filePath: string, text: string): Promise<void> {
  const temporary = `${filePath}.tmp-${String(process.pid)}-${randomUUID()}`
  const handle = await open(temporary, 'wx', 0o644)
  try {
    await handle.writeFile(text, 'utf8')
    await handle.sync()
    await handle.close()
    await rename(temporary, filePath)
  } catch (error) {
    await handle.close().catch(() => undefined)
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

interface OverviewRow {
  sku: string
  taskId: string
  garment: string
  model: string
  versionId: string
  outputFile: string
  thumb: string
}

/** 重写 <批次目录>/总览.html 与 mapping.csv：每个已交付组一行。 */
export async function writeOverview(store: BatchStore): Promise<{ htmlPath: string; csvPath: string }> {
  const state = store.state()
  const delivered = [...state.groups]
    .filter((group) => group.delivered !== undefined)
    .sort((left, right) => left.order - right.order)

  const sections: Array<{ group: Group; rows: OverviewRow[] }> = []
  for (const group of delivered) {
    const files = group.delivered!.files
    // 交付后该组不能再改判断，采用版本与交付时一致，按顺序与交付文件一一对应
    const entries = deliverableTasks(state, group.id)
    const rows: OverviewRow[] = []
    for (const [index, { task, version }] of entries.entries()) {
      const outputFile = files[index]
      if (outputFile === undefined) break
      rows.push({
        sku: group.sku,
        taskId: task.id,
        garment: assetPath(state, task.garmentAssetId),
        model: assetPath(state, task.modelAssetId),
        versionId: version.id,
        outputFile,
        thumb: await store.thumbnail(version.relativePath, 480),
      })
    }
    sections.push({ group, rows })
  }

  const header = 'sku,task_id,garment,model,version_id,output_file'
  const lines = sections.flatMap(({ rows }) => rows.map((row) => [
    row.sku, row.taskId, row.garment, row.model, row.versionId, row.outputFile,
  ].map(csvField).join(',')))
  const csv = `﻿${[header, ...lines].join('\n')}\n`

  const rowsHtml = sections.map(({ group, rows }) => {
    const title = group.name === '' ? group.sku : `${group.sku} · ${group.name}`
    const thumbs = rows.map((row) => `<figure><img src="${escapeHtml(row.thumb)}" alt="" loading="lazy"><figcaption>${escapeHtml(path.posix.basename(row.outputFile))}</figcaption></figure>`).join('')
    return `<section><h2>${escapeHtml(title)} <span>${String(rows.length)} 张</span></h2><div class="strip">${thumbs}</div></section>`
  }).join('\n')
  const tableRows = sections.flatMap(({ rows }) => rows.map((row) =>
    `<tr><td>${escapeHtml(row.sku)}</td><td>${escapeHtml(row.garment)}</td><td>${escapeHtml(row.model)}</td><td>${escapeHtml(row.outputFile)}</td></tr>`)).join('\n')
  const total = sections.reduce((sum, { rows }) => sum + rows.length, 0)
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>交付总览</title>
<style>
body{margin:0;padding:32px;background:#e6e6e6;color:#1a1a1a;font:14px/1.5 -apple-system,"PingFang SC",sans-serif}
h1{font-size:20px;margin:0 0 24px}
section{margin:0 0 28px}
h2{font-size:15px;margin:0 0 10px}h2 span{color:#666;font-weight:400;margin-left:8px}
.strip{display:flex;gap:10px;overflow-x:auto}
figure{margin:0;flex:none}figure img{display:block;height:240px;width:auto;background:#d0d0d0}
figcaption{font-size:12px;color:#555;margin-top:4px}
table{border-collapse:collapse;margin-top:12px;font-size:12px}td,th{border-bottom:1px solid #ccc;padding:4px 12px 4px 0;text-align:left}
</style>
</head>
<body>
<h1>交付总览 · ${String(sections.length)} 套 · ${String(total)} 张</h1>
${rowsHtml}
<h2>映射表</h2>
<table><thead><tr><th>款号</th><th>服装</th><th>模特</th><th>成图</th></tr></thead><tbody>
${tableRows}
</tbody></table>
</body>
</html>
`

  const htmlPath = path.join(store.dir, '总览.html')
  const csvPath = path.join(store.dir, 'mapping.csv')
  await writeTextAtomic(htmlPath, html)
  await writeTextAtomic(csvPath, csv)
  return { htmlPath, csvPath }
}
