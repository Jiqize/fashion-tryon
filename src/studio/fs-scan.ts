import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, open, readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'

import { RunnerError } from '../errors.js'

// 扫描素材目录：只读遍历、魔数校验、内容哈希；角色目录名与稳定 ID 也在这里

export const MAX_INPUT_FILE_BYTES = 64 * 1024 * 1024

const MEDIA_TYPES = new Map<string, ScannedFile['mediaType']>([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
])

const IGNORED_DIRECTORY_NAMES = new Set(['.git', 'node_modules', '成图'])

/** 交换介质（U 盘 / SMB / zip）常见的系统伴生文件，必须整体跳过。 */
const SYSTEM_FILE_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])

function isSystemFileName(name: string): boolean {
  return name.startsWith('._') || SYSTEM_FILE_NAMES.has(name)
}

/** 按文件头魔数确认扩展名没有说谎；只看首 12 字节。 */
export function detectMediaType(bytes: Uint8Array): ScannedFile['mediaType'] | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length >= 8 && png.every((byte, index) => bytes[index] === byte)) {
    return 'image/png'
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp'
  }
  return undefined
}

export interface ScannedFile {
  sourcePath: string
  relativePath: string
  contentHash: string
  sizeBytes: number
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp'
}

export interface SkippedAsset {
  relativePath: string
  reason: 'reserved_directory' | 'system_file' | 'empty' | 'too_large' | 'unsupported_format' | 'unreadable'
  sizeBytes?: number
  message?: string
}

export interface ScanResult {
  inputRoot: string
  files: ScannedFile[]
  skipped: SkippedAsset[]
}

/** 逻辑路径统一 NFC；sourcePath 保留磁盘原始字节，用于真正打开文件。 */
function normalizeRelative(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join('/').normalize('NFC')
}

/** 码位全序比较：localeCompare 对 NFC/NFD 与零宽字符会返回 0。 */
export function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function byRelativePath(
  left: { relativePath: string },
  right: { relativePath: string },
): number {
  return compareCodePoints(left.relativePath, right.relativePath)
}

function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** 只读文件头（魔数校验够用），不读全文件。 */
async function readHead(filePath: string): Promise<Uint8Array> {
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(12)
    const { bytesRead } = await handle.read(buffer, 0, 12, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/**
 * hashContent 为 false 时只读文件头做魔数校验、contentHash 为空串：
 * 给不用内容哈希的精简流程用，避免每次扫描都把全部素材读一遍。
 */
export async function scanInput(inputRoot: string, options: { hashContent?: boolean } = {}): Promise<ScanResult> {
  const hashContent = options.hashContent ?? true
  const root = path.resolve(inputRoot)
  let rootStat
  try {
    rootStat = await stat(root)
    await access(root, constants.R_OK)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      throw new RunnerError('NOT_FOUND', `Input directory does not exist: ${root}`, { cause: error })
    }
    throw new RunnerError('IO_ERROR', `Input directory is not readable: ${root}`, { cause: error })
  }
  if (!rootStat.isDirectory()) {
    throw new RunnerError('VALIDATION_ERROR', `Input path is not a directory: ${root}`)
  }

  const files: ScannedFile[] = []
  const skipped: SkippedAsset[] = []

  const walk = async (directory: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      throw new RunnerError('IO_ERROR', `Cannot read input directory: ${directory}`, { cause: error })
    }
    entries.sort((left, right) =>
      compareCodePoints(left.name.normalize('NFC'), right.name.normalize('NFC')),
    )

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name)
      const relativePath = normalizeRelative(root, absolutePath)

      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORY_NAMES.has(entry.name) || entry.name.startsWith('.tryon-')) {
          skipped.push({
            relativePath,
            reason: 'reserved_directory',
            message: `保留目录整棵未扫描：${entry.name}`,
          })
          continue
        }
        await walk(absolutePath)
        continue
      }

      if (!entry.isFile()) {
        skipped.push({ relativePath, reason: 'unreadable', message: 'not a regular file' })
        continue
      }

      if (isSystemFileName(entry.name)) {
        skipped.push({
          relativePath,
          reason: 'system_file',
          message: `系统伴生文件已跳过：${entry.name}`,
        })
        continue
      }

      let fileStat
      try {
        fileStat = await stat(absolutePath)
      } catch (error) {
        skipped.push({ relativePath, reason: 'unreadable', message: 'cannot stat file' })
        continue
      }

      if (fileStat.size === 0) {
        skipped.push({ relativePath, reason: 'empty', sizeBytes: 0 })
        continue
      }
      if (fileStat.size > MAX_INPUT_FILE_BYTES) {
        skipped.push({ relativePath, reason: 'too_large', sizeBytes: fileStat.size })
        continue
      }

      const extension = path.extname(entry.name).toLocaleLowerCase('en-US')
      const mediaType = MEDIA_TYPES.get(extension)
      if (mediaType === undefined) {
        skipped.push({ relativePath, reason: 'unsupported_format', sizeBytes: fileStat.size })
        continue
      }

      let bytes: Uint8Array
      try {
        bytes = hashContent ? await readFile(absolutePath) : await readHead(absolutePath)
      } catch (error) {
        skipped.push({ relativePath, reason: 'unreadable', sizeBytes: fileStat.size })
        continue
      }
      // 复用哈希用的同一份字节做魔数校验，不二次读盘。
      const detected = detectMediaType(bytes)
      if (detected === undefined || detected !== mediaType) {
        skipped.push({
          relativePath,
          reason: 'unsupported_format',
          sizeBytes: fileStat.size,
          message: `文件头与扩展名不符：期望 ${mediaType}，实际 ${detected ?? '未知格式'}`,
        })
        continue
      }
      files.push({
        sourcePath: absolutePath,
        relativePath,
        contentHash: hashContent ? hashBytes(bytes) : '',
        sizeBytes: fileStat.size,
        mediaType,
      })
    }
  }

  await walk(root)
  files.sort(byRelativePath)
  skipped.sort(byRelativePath)
  return { inputRoot: root, files, skipped }
}

const GARMENT_DIRECTORIES = new Set([
  '服装',
  '衣服',
  '单品',
  '产品图',
  '平铺',
  'garment',
  'garments',
  'clothes',
  'clothing',
  'product',
])
const MODEL_DIRECTORIES = new Set(['模特', '人物', '人像', '模特图', 'model', 'models', 'person'])

/** 由各部分内容派生的稳定 ID：同样的输入总得到同样的 ID。 */
export function stableId(prefix: string, ...parts: string[]): string {
  const digest = createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 20)
  return `${prefix}_${digest}`
}

/** 目录名 → 素材角色（服装 / 模特）；不是角色目录返回 null。 */
export function roleOfSegment(segment: string): 'garment' | 'model' | null {
  const normalized = segment.trim().toLocaleLowerCase('en-US')
  if (GARMENT_DIRECTORIES.has(normalized)) return 'garment'
  if (MODEL_DIRECTORIES.has(normalized)) return 'model'
  return null
}
