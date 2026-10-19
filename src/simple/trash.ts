import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { RunnerError } from '../errors.js'
import { readCollection, updateCollection } from './collection.js'
import { CROP_DIR } from './crop.js'
import { scanSimple } from './layout.js'
import { readActiveLock } from './lock.js'
import { runsDir } from './record.js'

// 删除衣服图、模特图或成图：移到 成图/_runs/已删除/<款号>/<编号>/，保留原相对路径，可撤销
// 衣服图连同由它裁出的裁图一起移走；成图同时移出待重出清单（撤销不加回）
// 放在 成图/ 下是因为扫描跳过 成图/，放在 服装/ 里会被当成新款

export const TRASH_DIR = '已删除'
const ID_PATTERN = /^[0-9a-f-]{36}$/

export interface TrashResult {
  sku: string
  id: string
  /** 移走的文件，相对素材根目录 */
  files: string[]
}

const toPosix = (file: string): string => file.split(path.sep).join('/')

function trashDir(root: string, sku: string, id: string): string {
  return path.join(runsDir(root), TRASH_DIR, sku, id)
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(() => true, () => false)
}

async function assertIdle(root: string): Promise<void> {
  const active = await readActiveLock(root)
  if (active !== null) throw new RunnerError('RUN_IN_PROGRESS', `这个素材目录正在出图：${active.runId}，出完再删`)
}

const OUTPUT_IMAGE = /\.(jpe?g|png|webp)$/i

/** 这款的成图：只认 成图/<款号>/ 下一层的图片 */
async function outputOf(root: string, sku: string, wanted: string): Promise<string | undefined> {
  const prefix = `成图/${sku}/`
  const name = wanted.startsWith(prefix) ? wanted.slice(prefix.length) : ''
  if (name === '' || name.includes('/') || name.includes('\\') || name.startsWith('.') || !OUTPUT_IMAGE.test(name)) return undefined
  return await exists(path.join(root, wanted)) ? wanted : undefined
}

export async function trashItem(root: string, sku: string, file: string): Promise<TrashResult> {
  await assertIdle(root)
  const wanted = file.normalize('NFC')
  const group = (await scanSimple(root)).find((candidate) => candidate.sku === sku)
  // 只认这款扫描到的衣服图、模特图和这款的成图，路径不会越出素材目录
  const garment = group?.garments.find((entry) => entry.relativePath.normalize('NFC') === wanted)
  const model = group?.models.find((entry) => entry.relativePath.normalize('NFC') === wanted)
  const output = garment === undefined && model === undefined && group !== undefined ? await outputOf(root, sku, wanted) : undefined
  const own = garment?.relativePath ?? model?.relativePath ?? output
  if (own === undefined) throw new RunnerError('VALIDATION_ERROR', `${sku} 没有这张图：${file}`)
  const crops: string[] = []
  if (garment !== undefined) {
    const state = await readCollection(root)
    for (const [crop, from] of Object.entries(state.cropFrom)) {
      if (from.normalize('NFC') === wanted && crop.startsWith(`${CROP_DIR}/${sku}/`) && await exists(path.join(root, crop))) crops.push(crop)
    }
  }
  const files = [own, ...crops]
  const id = randomUUID()
  const dir = trashDir(root, sku, id)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'manifest.json'), `${JSON.stringify({ files }, null, 2)}\n`, 'utf8')
  for (const relative of files) {
    const target = path.join(dir, 'files', relative)
    await mkdir(path.dirname(target), { recursive: true })
    await rename(path.join(root, relative), target)
  }
  if (output !== undefined) {
    await updateCollection(root, (state) => { state.redo = state.redo.filter((entry) => entry.delivered.normalize('NFC') !== output) })
  }
  return { sku, id, files }
}

export async function restoreItem(root: string, sku: string, id: string): Promise<TrashResult> {
  if (!ID_PATTERN.test(id) || sku.includes('/') || sku.includes('\\') || sku.startsWith('.')) throw new RunnerError('VALIDATION_ERROR', '找不到要撤销的删除')
  await assertIdle(root)
  const dir = trashDir(root, sku, id)
  let files: string[]
  try {
    files = (JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')) as { files: string[] }).files
  } catch {
    throw new RunnerError('VALIDATION_ERROR', '找不到要撤销的删除')
  }
  if (!Array.isArray(files) || files.some((relative) => typeof relative !== 'string' || path.isAbsolute(relative) || relative.split('/').includes('..'))) {
    throw new RunnerError('VALIDATION_ERROR', '找不到要撤销的删除')
  }
  // 原位置已有同名文件时不覆盖
  for (const relative of files) {
    if (await exists(path.join(root, relative))) throw new RunnerError('VALIDATION_ERROR', `原位置已有同名文件：${toPosix(relative)}`)
  }
  for (const relative of files) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true })
    await rename(path.join(dir, 'files', relative), path.join(root, relative))
  }
  await rm(dir, { recursive: true, force: true })
  return { sku, id, files }
}
