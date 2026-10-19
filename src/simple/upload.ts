import { randomBytes } from 'node:crypto'
import { link, mkdir, readdir, realpath, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { RunnerError } from '../errors.js'
import { detectMediaType, roleOfSegment } from '../studio/fs-scan.js'
import { CROP_DIR } from './crop.js'
import { scanSimple, type SimpleGroup } from './layout.js'

// 页面放图：把拖进来的图写进素材根目录里这款对应的目录
// 沿用根目录现有的目录结构；文件名保留原名，同名加 (2)、(3)…，从不覆盖

export const UPLOAD_MAX_BYTES = 52_428_800

export type UploadKind = 'garment' | 'model'

const MEDIA_TYPES = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
])
const DEFAULT_ROLE_DIR: Record<UploadKind, string> = { garment: '服装', model: '模特' }
const RESERVED_SKUS = new Set(['成图', CROP_DIR, '_runs'])

function invalidSku(reason: string): RunnerError {
  return new RunnerError('VALIDATION_ERROR', `款号不能用：${reason}`)
}

/** 款号规则；扫描时款号取目录名第一个 `_` 或空格之前的部分，所以这两个字符不能出现。 */
function checkSkuShape(sku: string): void {
  if (sku === '') throw invalidSku('不能为空')
  if (/[/\\]/.test(sku)) throw invalidSku('不能含 / 或 \\')
  if (/[_\s]/.test(sku)) throw invalidSku('不能含下划线或空格')
  if (sku.startsWith('.')) throw invalidSku('不能以 . 开头')
  if (RESERVED_SKUS.has(sku) || roleOfSegment(sku) !== null) throw invalidSku(`${sku} 是保留目录名`)
  if (sku.length > 64) throw invalidSku('不能超过 64 个字符')
}

function findGroup(groups: SimpleGroup[], sku: string): SimpleGroup | undefined {
  return groups.find((group) => group.sku === sku)
}

async function checkNewSku(groups: SimpleGroup[], sku: string): Promise<void> {
  checkSkuShape(sku)
  // macOS 文件名不区分大小写，ex1 会写进 EX1 的目录
  if (groups.some((group) => group.sku.toLocaleLowerCase('en-US') === sku.toLocaleLowerCase('en-US'))) {
    throw new RunnerError('VALIDATION_ERROR', `款号已存在：${sku}`)
  }
}

export async function validateNewSku(root: string, sku: string): Promise<void> {
  await checkNewSku(await scanSimple(path.resolve(root)), sku.trim().normalize('NFC'))
}

/** 一个素材文件属于哪种结构：<款目录>/<角色目录>/… 或 <角色目录>/<款目录>/…（与 scanSimple 判断顺序一致）。 */
function layoutOf(relativePath: string): { perSku: boolean; skuDir: string; roleDir: string } {
  const [first, second] = relativePath.split('/') as [string, string]
  return roleOfSegment(second) !== null
    ? { perSku: true, skuDir: first, roleDir: second }
    : { perSku: false, skuDir: second, roleDir: first }
}

/** 根目录下已有的同类角色目录名（如 衣服、人物），没有就用默认名。 */
async function rootRoleDir(root: string, kind: UploadKind): Promise<string> {
  const entries = await readdir(root, { withFileTypes: true })
  const found = entries
    .filter((entry) => entry.isDirectory() && roleOfSegment(entry.name) === kind)
    .map((entry) => entry.name)
    .sort()
  return found[0] ?? DEFAULT_ROLE_DIR[kind]
}

/** 这款这一类图该写到哪个目录（相对素材根目录、`/` 分隔）。 */
async function targetDir(root: string, groups: SimpleGroup[], sku: string, kind: UploadKind): Promise<string> {
  const group = findGroup(groups, sku)
  if (group !== undefined) {
    const same = kind === 'garment' ? group.garments : group.models
    if (same.length > 0) return path.posix.dirname(same[0]!.relativePath)
    const other = layoutOf((kind === 'garment' ? group.models : group.garments)[0]!.relativePath)
    return other.perSku
      ? `${other.skuDir}/${DEFAULT_ROLE_DIR[kind]}`
      : `${await rootRoleDir(root, kind)}/${other.skuDir}`
  }
  // 新款：现有款全部按角色分目录时跟着用，否则按款分目录
  const files = groups.flatMap((candidate) => [...candidate.garments, ...candidate.models])
  const perRole = files.length > 0 && files.every((file) => !layoutOf(file.relativePath).perSku)
  return perRole ? `${await rootRoleDir(root, kind)}/${sku}` : `${sku}/${DEFAULT_ROLE_DIR[kind]}`
}

function checkFile(fileName: string, bytes: Buffer): void {
  if (
    fileName === '' ||
    /[/\\\0]/.test(fileName) ||
    fileName.startsWith('.') ||
    fileName !== path.basename(fileName)
  ) {
    throw new RunnerError('VALIDATION_ERROR', `文件名不能用：${fileName}`)
  }
  const expected = MEDIA_TYPES.get(path.extname(fileName).toLocaleLowerCase('en-US'))
  if (expected === undefined) throw new RunnerError('VALIDATION_ERROR', `${fileName}：只支持 jpg、png、webp`)
  if (bytes.length > UPLOAD_MAX_BYTES) throw new RunnerError('VALIDATION_ERROR', `${fileName}：超过 50 MB`)
  if (detectMediaType(bytes) !== expected) throw new RunnerError('VALIDATION_ERROR', `${fileName}：不是有效的图片`)
}

/** 目录（或它最近的已存在上级）解析符号链接后仍在素材根目录内。 */
async function assertInside(realRoot: string, dir: string): Promise<void> {
  let current = dir
  for (;;) {
    try {
      const real = await realpath(current)
      if (real === realRoot || real.startsWith(realRoot + path.sep)) return
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = path.dirname(current)
      if (parent === current) break
      current = parent
    }
  }
  throw new RunnerError('VALIDATION_ERROR', '写入位置不在素材根目录内')
}

export async function placeUpload(
  root: string,
  input: { sku: string; kind: UploadKind; fileName: string; bytes: Buffer },
): Promise<{ file: string }> {
  const resolvedRoot = path.resolve(root)
  const fileName = input.fileName.normalize('NFC')
  const sku = input.sku.trim().normalize('NFC')
  checkFile(fileName, input.bytes)
  const groups = await scanSimple(resolvedRoot)
  if (findGroup(groups, sku) === undefined) await checkNewSku(groups, sku)

  const dirRelative = await targetDir(resolvedRoot, groups, sku, input.kind)
  const dir = path.join(resolvedRoot, dirRelative)
  const realRoot = await realpath(resolvedRoot)
  await assertInside(realRoot, dir)
  await mkdir(dir, { recursive: true })
  await assertInside(realRoot, dir)

  // 先写临时文件，再 link 到目标名：目标已存在时 link 失败（EEXIST），从不覆盖，也不会露出半个文件
  const temporary = path.join(dir, `.upload-${randomBytes(6).toString('hex')}.tmp`)
  await writeFile(temporary, input.bytes, { flag: 'wx' })
  try {
    const { name: stem, ext } = path.parse(fileName)
    for (let index = 1; ; index += 1) {
      const name = index === 1 ? fileName : `${stem} (${String(index)})${ext}`
      try {
        await link(temporary, path.join(dir, name))
        return { file: `${dirRelative}/${name}`.normalize('NFC') }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}
