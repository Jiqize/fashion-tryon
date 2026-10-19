import { access, readdir, stat } from 'node:fs/promises'
import path from 'node:path'

import { readCollection } from '../simple/collection.js'
import { scanSimple } from '../simple/layout.js'
import { listRunRecords } from '../simple/record.js'
import { displayName, type ProjectEntry } from './projects.js'

// 项目卡片数据：只读统计，不往素材目录写任何文件

export interface ProjectCard {
  id: string
  name: string
  root: string
  missing: boolean
  skuCount: number
  outputCount: number
  lastRunAt: string | null
  redoCount: number
  /** 相对素材根目录 */
  cover: string | null
  addedAt: string
}

const OUTPUT_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp'])

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory()
  } catch {
    return false
  }
}

async function exists(filePath: string): Promise<boolean> {
  return access(filePath).then(() => true, () => false)
}

async function countOutputs(root: string, skus: string[]): Promise<number> {
  let total = 0
  for (const sku of new Set(skus)) {
    const names = await readdir(path.join(root, '成图', sku)).catch(() => [] as string[])
    total += names.filter((name) => !name.startsWith('.') && OUTPUT_EXTENSIONS.has(path.extname(name).toLowerCase())).length
  }
  return total
}

/** runId 是本地时间 YYYYMMDD-HHMMSS，转成 ISO */
function runIdTime(runId: string): string {
  const part = (start: number, length: number): number => Number(runId.slice(start, start + length))
  return new Date(part(0, 4), part(4, 2) - 1, part(6, 2), part(9, 2), part(11, 2), part(13, 2)).toISOString()
}

export async function projectCard(entry: ProjectEntry): Promise<ProjectCard> {
  const card: ProjectCard = {
    id: entry.id,
    name: displayName(entry),
    root: entry.root,
    missing: false,
    skuCount: 0,
    outputCount: 0,
    lastRunAt: null,
    redoCount: 0,
    cover: null,
    addedAt: entry.addedAt,
  }
  if (!(await isDirectory(entry.root))) return { ...card, missing: true }

  const groups = await scanSimple(entry.root)
  card.skuCount = groups.length
  card.outputCount = await countOutputs(entry.root, groups.map((group) => group.sku))

  // listRunRecords 已按 runId 从新到旧
  const records = await listRunRecords(entry.root)
  for (const record of records) {
    // 旧格式记录（10 月中旬以前）没有 startedAt，用 runId 里的时间
    const startedAt = record.startedAt ?? runIdTime(record.runId)
    if (card.lastRunAt === null || startedAt > card.lastRunAt) card.lastRunAt = startedAt
  }
  outer: for (const record of records) {
    for (const group of record.groups) {
      for (const shot of group.shots) {
        if (shot.delivered !== undefined && await exists(path.join(entry.root, shot.delivered))) {
          card.cover = shot.delivered
          break outer
        }
      }
    }
  }
  card.cover ??= groups[0]?.garments[0]?.relativePath ?? null

  // 合集设置损坏时不影响卡片
  card.redoCount = await readCollection(entry.root).then((state) => state.redo.length, () => 0)
  return card
}

export function sortCards(cards: ProjectCard[]): ProjectCard[] {
  return [...cards].sort((left, right) => {
    if (left.lastRunAt !== null && right.lastRunAt !== null) return right.lastRunAt.localeCompare(left.lastRunAt)
    if (left.lastRunAt !== null) return -1
    if (right.lastRunAt !== null) return 1
    return right.addedAt.localeCompare(left.addedAt)
  })
}
