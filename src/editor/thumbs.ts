import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

import sharp from 'sharp'

import { runsDir } from '../simple/record.js'

// 页面缩略图：原图缩到长边 THUMB_EDGE 的 JPEG，缓存在 成图/_runs/.thumbs/
// 缓存名由路径、大小、修改时间算出：原图一改就换新名，不用清理也不会拿到旧图
// 同时生成的张数有上限：模特原图常有几十 MB，一次全解码会占满内存

export const THUMB_EDGE = 320
const MAX_CONCURRENT = 2

const inFlight = new Map<string, Promise<Buffer>>()
const waiting: (() => void)[] = []
let running = 0

async function limited<T>(task: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve))
  running += 1
  try {
    return await task()
  } finally {
    running -= 1
    waiting.shift()?.()
  }
}

/** 等正在生成的缩略图都写完（服务关闭时用，不留写了一半的缓存）。 */
export async function settleThumbnails(): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight.values()])
}

/** 同一张原图（路径、大小、修改时间不变）的标识，也用作 ETag。 */
export function imageTag(relative: string, size: number, mtimeMs: number): string {
  return createHash('sha256').update(`${relative}\0${String(size)}\0${String(Math.trunc(mtimeMs))}`).digest('hex').slice(0, 24)
}

/** 取缩略图字节：有缓存读缓存，没有就生成并写入缓存。 */
export async function thumbnail(sourceRoot: string, realPath: string, tag: string): Promise<Buffer> {
  const cachePath = path.join(runsDir(sourceRoot), '.thumbs', `${tag}.jpg`)
  const cached = await readFile(cachePath).catch(() => undefined)
  if (cached !== undefined) return cached
  let pending = inFlight.get(cachePath)
  if (pending === undefined) {
    pending = limited(async () => {
      const bytes = await sharp(realPath, { failOn: 'none' })
        .rotate()
        .resize(THUMB_EDGE, THUMB_EDGE, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer()
      await mkdir(path.dirname(cachePath), { recursive: true })
      // 先写临时文件再改名：并发读不会拿到写了一半的缓存
      const temporary = `${cachePath}.${String(process.pid)}.tmp`
      await writeFile(temporary, bytes)
      await rename(temporary, cachePath)
      return bytes
    }).finally(() => inFlight.delete(cachePath))
    inFlight.set(cachePath, pending)
  }
  return pending
}
