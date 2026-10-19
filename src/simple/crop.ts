import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import sharp from 'sharp'
import { z } from 'zod'

import { RunnerError } from '../errors.js'
import { orderFiles, readCollection, updateCollection } from './collection.js'
import { scanSimple } from './layout.js'

// 裁图：Agent 看过服装图后写裁切方案，这里按方案从原图裁出参考图，写到 <根>/裁图/<款号>/
// run 发现某款的 裁图/ 里有图时，用裁图代替 服装/ 原图作参考
// 2026-10-14 第二轮测试：全身 + 半身 + 细节裁图并标明用途，服装细节还原最好

export const CROP_DIR = '裁图'
const CROP_EDGE = 1024

const boxSchema = z
  .tuple([z.number(), z.number(), z.number(), z.number()])
  .refine(([x0, y0, x1, y1]) => x0 >= 0 && y0 >= 0 && x1 <= 1000 && y1 <= 1000 && x1 > x0 && y1 > y0, {
    message: 'box 是千分比 [x0,y0,x1,y1]，0–1000 且 x1>x0、y1>y0',
  })

const itemSchema = z.object({
  /** 服装图文件名（同款 服装/ 目录里的） */
  from: z.string().min(1),
  /** 这张参考图的用途，同时作文件名，如 全身-正面、细节-领口 */
  role: z.string().min(1).max(40).regex(/^[^/\\:*?"<>|]+$/),
  /** 千分比裁切框；不写则用整张图 */
  box: boxSchema.optional(),
})

const planSchema = z.record(z.string().min(1), z.array(itemSchema).min(1))

export type CropPlan = z.infer<typeof planSchema>

export interface CropOutcome {
  sku: string
  files: string[]
}

export function parseCropPlan(value: unknown): CropPlan {
  const parsed = planSchema.safeParse(value)
  if (!parsed.success) {
    throw new RunnerError('VALIDATION_ERROR', `裁切方案格式不对：${parsed.error.issues[0]?.message ?? ''}`)
  }
  return parsed.data
}

/** 某款 裁图/ 目录里已有的图片（按文件名自然排序）；目录不存在时返回空数组。 */
export async function listCrops(root: string, sku: string): Promise<string[]> {
  const dir = path.join(root, CROP_DIR, sku)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const sorted = names
    .filter((name) => /\.(jpe?g|png|webp)$/i.test(name) && !name.startsWith('.'))
    .sort((left, right) => left.localeCompare(right, 'zh', { numeric: true }))
  // 页面上拖过裁图顺序的按拖的顺序；设置文件读不了时按文件名
  const order = await readCollection(root).then((state) => state.itemOrder[sku]?.crops, () => undefined)
  return orderFiles(sorted, order, (name) => `${CROP_DIR}/${sku}/${name}`.normalize('NFC'))
    .map((name) => path.join(dir, name))
}

/** 裁切管线：按千分比框裁出（不给框用整张），缩到长边 1024 内，转白底 JPEG。 */
export async function renderCrop(sourcePath: string, box?: [number, number, number, number]): Promise<Buffer> {
  const image = sharp(sourcePath).rotate()
  let pipeline = image
  if (box !== undefined) {
    // rotate() 之后的尺寸要先落成 buffer 再取，EXIF 旋转过的图才不会裁错位置
    const oriented = await image.toBuffer({ resolveWithObject: true })
    const { width, height } = oriented.info
    // 先把两角换算成像素再相减，框贴边（1000）时不会因四舍五入越界
    const [left, top, right, bottom] = box.map((value, index) =>
      Math.min(Math.round(((index % 2 === 0 ? width : height) * value) / 1000), index % 2 === 0 ? width : height))
    pipeline = sharp(oriented.data).extract({
      left: left!,
      top: top!,
      width: Math.max(1, right! - left!),
      height: Math.max(1, bottom! - top!),
    })
  }
  return pipeline
    .resize(CROP_EDGE, CROP_EDGE, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 88 })
    .toBuffer()
}

export async function applyCropPlan(
  sourceRoot: string,
  plan: CropPlan,
  options: { replace?: boolean } = {},
): Promise<CropOutcome[]> {
  const root = path.resolve(sourceRoot)
  const groups = new Map((await scanSimple(root)).map((group) => [group.sku, group]))

  // 先整体校验，任何一款有问题都不写文件
  const jobs = Object.entries(plan).map(([sku, items]) => {
    const group = groups.get(sku)
    if (group === undefined) throw new RunnerError('VALIDATION_ERROR', `没有这个款号：${sku}`)
    return {
      sku,
      items: items.map((item) => {
        const file = group.garments.find((candidate) =>
          path.basename(candidate.relativePath) === item.from.normalize('NFC') ||
          candidate.relativePath === item.from.normalize('NFC'))
        if (file === undefined) throw new RunnerError('VALIDATION_ERROR', `${sku} 的服装图里没有 ${item.from}`)
        return { ...item, sourcePath: file.sourcePath, sourceRelative: file.relativePath }
      }),
    }
  })
  for (const job of jobs) {
    const existing = await listCrops(root, job.sku)
    if (existing.length > 0 && options.replace !== true) {
      throw new RunnerError('VALIDATION_ERROR', `${CROP_DIR}/${job.sku}/ 里已有 ${String(existing.length)} 张图；要重裁请加 --replace`)
    }
  }

  // 先确认合集设置可读：损坏时一张裁图都不写
  await readCollection(root)
  const outcomes: CropOutcome[] = []
  for (const job of jobs) {
    const dir = path.join(root, CROP_DIR, job.sku)
    // --replace：只删这一款裁图目录里的图片，不碰别的文件
    for (const file of await listCrops(root, job.sku)) await rm(file)
    await mkdir(dir, { recursive: true })
    const files: string[] = []
    const sources: Record<string, string> = {}
    for (const [index, item] of job.items.entries()) {
      const name = `${String(index + 1).padStart(2, '0')}-${item.role}.jpg`
      await writeFile(path.join(dir, name), await renderCrop(item.sourcePath, item.box))
      files.push(`${CROP_DIR}/${job.sku}/${name}`)
      sources[`${CROP_DIR}/${job.sku}/${name}`] = item.sourceRelative
    }
    // 记录每张裁图来自哪张服装原图
    await updateCollection(root, (state) => {
      Object.assign(state.cropFrom, sources)
    })
    outcomes.push({ sku: job.sku, files })
  }
  return outcomes
}

/**
 * 单张裁图（节点图页面拖框用）：从该款服装原图或已有裁图裁一张，写到 裁图/<款号>/，返回相对素材根目录的路径。
 * 同用途已有裁图时，未给 replace 抛 CROP_EXISTS；给了则写回原文件名。其它裁图不动。
 */
export async function cropOne(
  sourceRoot: string,
  sku: string,
  item: { from: string; role: string; box?: [number, number, number, number] },
  options: { replace?: boolean } = {},
): Promise<string> {
  const parsed = itemSchema.safeParse(item)
  if (!parsed.success) {
    throw new RunnerError('VALIDATION_ERROR', `裁图参数不对：${parsed.error.issues[0]?.message ?? ''}`)
  }
  const { role, box } = parsed.data
  const root = path.resolve(sourceRoot)
  const group = (await scanSimple(root)).find((candidate) => candidate.sku === sku)
  if (group === undefined) throw new RunnerError('VALIDATION_ERROR', `没有这个款号：${sku}`)

  const from = item.from.normalize('NFC')
  const crops = await listCrops(root, sku)
  const garment = group.garments.find((candidate) =>
    path.basename(candidate.relativePath) === from || candidate.relativePath === from)
  const crop = crops.find((cropPath) => `${CROP_DIR}/${sku}/${path.basename(cropPath)}` === from)
  const sourcePath = garment?.sourcePath ?? crop
  if (sourcePath === undefined) throw new RunnerError('VALIDATION_ERROR', `${sku} 没有这张图：${item.from}`)

  // 同用途：去掉开头序号后的文件名等于 role
  const sameRole = crops.find((cropPath) => path.parse(cropPath).name.normalize('NFC').replace(/^\d+-/, '') === role)
  if (sameRole !== undefined && options.replace !== true) {
    throw new RunnerError('CROP_EXISTS', `${CROP_DIR}/${sku}/ 里已有「${role}」，替换吗？`)
  }
  const numbers = crops.map((cropPath) => Number(/^(\d+)-/.exec(path.basename(cropPath))?.[1] ?? 0))
  const name = sameRole !== undefined
    ? path.basename(sameRole)
    : `${String(Math.max(0, ...numbers) + 1).padStart(2, '0')}-${role}.jpg`

  // 先确认合集设置可读：损坏时不写裁图
  await readCollection(root)
  // 先裁成 buffer 再写：对同一张裁图重新拖框并替换时不会读到写了一半的文件
  const bytes = await renderCrop(sourcePath, box)
  await mkdir(path.join(root, CROP_DIR, sku), { recursive: true })
  await writeFile(path.join(root, CROP_DIR, sku, name), bytes)
  const target = `${CROP_DIR}/${sku}/${name}`
  // 记录裁图来源：来源是裁图时继承它的来源；替换同用途裁图时覆盖原记录
  await updateCollection(root, (state) => {
    state.cropFrom[target] = garment !== undefined ? garment.relativePath : state.cropFrom[from] ?? from
  })
  return target
}
