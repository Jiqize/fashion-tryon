import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import sharp from 'sharp'

import type { PairingMode } from '../../src/studio/model.js'
import { mergeScan, scanSource } from '../../src/studio/scan.js'
import { openBatch, type BatchStore } from '../../src/studio/store.js'

const createdParents: string[] = []
let colorCounter = 0

/** 生成一张可解码的小 JPEG；每次调用颜色不同，保证内容 hash 各不相同。 */
export async function makeJpeg(): Promise<Buffer> {
  colorCounter += 1
  const n = colorCounter
  return sharp({
    create: {
      width: 16,
      height: 16,
      channels: 3,
      background: { r: (n * 37) % 256, g: (n * 91) % 256, b: (n * 53) % 256 },
    },
  })
    .jpeg({ quality: 90 })
    .toBuffer()
}

/** 在临时目录下造一个素材根目录：每个款号一组，组内 服装/ 与 模特/ 各若干张 JPEG。 */
export async function makeSourceTree(
  spec: Record<string, { garments: number; models: number }>,
): Promise<string> {
  const parent = await mkdtemp(path.join(tmpdir(), 'studio-source-'))
  createdParents.push(parent)
  const sourceRoot = path.join(parent, '本次素材')
  await mkdir(sourceRoot)
  for (const [sku, counts] of Object.entries(spec)) {
    await mkdir(path.join(sourceRoot, sku, '服装'), { recursive: true })
    await mkdir(path.join(sourceRoot, sku, '模特'), { recursive: true })
    for (let index = 1; index <= counts.garments; index += 1) {
      await writeFile(path.join(sourceRoot, sku, '服装', `${String(index).padStart(2, '0')}.jpg`), await makeJpeg())
    }
    for (let index = 1; index <= counts.models; index += 1) {
      await writeFile(path.join(sourceRoot, sku, '模特', `${String(index).padStart(2, '0')}.jpg`), await makeJpeg())
    }
  }
  return sourceRoot
}

export async function cleanupSourceTrees(): Promise<void> {
  // 服务关闭后仍可能有缩略图在写入，删除时遇到 ENOTEMPTY 重试
  await Promise.all(createdParents.splice(0).map((parent) => rm(parent, { recursive: true, force: true, maxRetries: 5 })))
}

/**
 * 造一个"已生成完、待判断"的批次：扫描合并素材，每个任务写入一个版本并采用它，组有 basePrompt。
 * 不经过引擎，便于测试判断与交付。调用方负责 close 返回的 store。
 */
export async function makeReviewBatch(
  spec: Record<string, { garments: number; models: number }>,
  options: { mode?: PairingMode; renameModels?: Record<string, string> } = {},
): Promise<{ root: string; store: BatchStore }> {
  const root = await makeSourceTree(spec)
  // 按需给模特图改名（键、值都是相对素材根目录的路径）
  for (const [from, to] of Object.entries(options.renameModels ?? {})) {
    await rename(path.join(root, from), path.join(root, to))
  }
  const store = await openBatch(root)
  const scanned = await scanSource(root)
  await store.update((draft) => {
    if (options.mode !== undefined) draft.settings.mode = options.mode
    const merged = mergeScan(draft, scanned)
    draft.groups = merged.groups
    draft.assets = merged.assets
    draft.tasks = merged.tasks
    for (const group of draft.groups) {
      group.started = true
      group.basePrompt = `BASE-${group.sku}`
    }
  })
  for (const task of store.state().tasks) {
    const written = await store.writeVersionImage(task.id, await makeJpeg(), 'image/jpeg')
    await store.update((draft) => {
      const target = draft.tasks.find((candidate) => candidate.id === task.id)!
      const versionId = `v-${task.id.slice(-8)}-${String(target.versions.length + 1)}`
      target.versions.push({
        id: versionId,
        relativePath: written.relativePath,
        sha256: written.sha256,
        mediaType: 'image/jpeg',
        createdAt: '2026-09-25T00:00:00.000Z',
        prompt: `FIRST-${task.id.slice(-8)}`,
      })
      target.chosenVersionId ??= versionId
      target.status = 'done'
      target.pending = []
    })
  }
  return { root, store }
}
