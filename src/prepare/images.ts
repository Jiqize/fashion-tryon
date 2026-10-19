import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

import sharp from 'sharp'

import type { Bbox } from '../contracts.js'
import { RunnerError } from '../errors.js'

export const PREPARED_MAX_BYTES = 1_000_000
export const PREPARED_MAX_EDGE = 1600
export const PREPARED_JPEG_QUALITY = 85
export const PREPARED_MIN_QUALITY = 60

const BASELINE = 1024
const MARGINS = { left: 20, right: 20, top: 22, bottom: 34 } as const
// 解码上限，防止超大或恶意图片耗尽内存
const MAX_INPUT_PIXELS = 80_000_000
// 裁切框退化判定：面积占比下限/上限与短边像素下限
const MIN_CROP_AREA_RATIO = 0.01
const MAX_CROP_AREA_RATIO = 0.97
const MIN_CROP_SHORT_EDGE = 128
const MIN_CROP_SOURCE_SHORT_EDGE = 512
// 低于该质量说明压缩已经影响纹理，需要提示
const QUALITY_WARNING_THRESHOLD = 75

export interface CropBox {
  left: number
  top: number
  width: number
  height: number
}

export interface PreparedAsset {
  assetId: string
  sourcePath: string
  path: string
  relativePath: string
  contentHash: string
  preparedHash: string
  width: number
  height: number
  bytes: number
  cropped: boolean
  cropBox?: CropBox
  warnings: string[]
}

/** prepareAsset 需要的最小素材描述。 */
export interface PrepareSourceAsset {
  id: string
  role: 'garment' | 'model' | null
  sourcePath: string
  relativePath: string
  contentHash: string
  bbox?: Bbox | undefined
  /** 手动裁切框（原图像素，已按 EXIF 方向校正），优先于 bbox */
  cropOverride?: CropBox | undefined
}

export interface PrepareImageOptions {
  runDir: string
  maxBytes?: number
  maxEdge?: number
  quality?: number
  onWarning?: (warning: string) => void
}

export interface PrepareFramingCopyOptions extends PrepareImageOptions {
  framingId: string
}

function validBbox(value: unknown): value is Bbox {
  if (!Array.isArray(value) || value.length !== 4) return false
  if (!value.every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate))) {
    return false
  }
  const [x1, y1, x2, y2] = value as number[]
  return x1! >= 0 && y1! >= 0 && x2! <= 1000 && y2! <= 1000 && x2! > x1! && y2! > y1!
}

function computeCropBox(bbox: Bbox, width: number, height: number): CropBox {
  const [x1, y1, x2, y2] = bbox
  const px1 = Math.round((x1 / 1000) * width)
  const py1 = Math.round((y1 / 1000) * height)
  const px2 = Math.round((x2 / 1000) * width)
  const py2 = Math.round((y2 / 1000) * height)
  const left = Math.max(0, px1 - Math.round((MARGINS.left / BASELINE) * width))
  const top = Math.max(0, py1 - Math.round((MARGINS.top / BASELINE) * height))
  const right = Math.min(width, px2 + Math.round((MARGINS.right / BASELINE) * width))
  const bottom = Math.min(height, py2 + Math.round((MARGINS.bottom / BASELINE) * height))
  if (right <= left || bottom <= top) {
    throw new RunnerError('PROVIDER_RESPONSE', 'Garment bbox produces an empty crop')
  }
  const box = { left, top, width: right - left, height: bottom - top }
  // 退化 bbox 拒绝：过小的框会裁出无法辨认的碎片，过大的框等于服装全图回退
  const sourceArea = width * height
  const cropArea = box.width * box.height
  // 短边像素下限只对本身足够大的源图生效，小图按面积占比判定
  const shortEdgeFloor =
    Math.min(width, height) >= MIN_CROP_SOURCE_SHORT_EDGE ? MIN_CROP_SHORT_EDGE : 0
  if (cropArea < sourceArea * MIN_CROP_AREA_RATIO || Math.min(box.width, box.height) < shortEdgeFloor) {
    throw new RunnerError(
      'PROVIDER_RESPONSE',
      `Garment bbox is degenerate: crop ${String(box.width)}x${String(box.height)} is too small for a ${String(width)}x${String(height)} source`,
    )
  }
  if (cropArea > sourceArea * MAX_CROP_AREA_RATIO) {
    throw new RunnerError(
      'PROVIDER_RESPONSE',
      `Garment bbox covers the whole image: crop ${String(box.width)}x${String(box.height)} of a ${String(width)}x${String(height)} source`,
    )
  }
  return box
}

/** 校验手动裁切框：整数、在原图范围内、短边 ≥128px。 */
export function validateCropOverride(box: CropBox, width: number, height: number): CropBox {
  const values = [box.left, box.top, box.width, box.height]
  const valid =
    values.every((value) => Number.isInteger(value)) &&
    box.left >= 0 &&
    box.top >= 0 &&
    box.left + box.width <= width &&
    box.top + box.height <= height &&
    Math.min(box.width, box.height) >= MIN_CROP_SHORT_EDGE
  if (!valid) throw new RunnerError('VALIDATION_ERROR', '裁切框超出图片范围或过小')
  return { left: box.left, top: box.top, width: box.width, height: box.height }
}

/** 读取按 EXIF 方向校正后的图片尺寸。 */
export async function orientedImageSize(
  sourcePath: string,
  relativePath: string,
): Promise<{ width: number; height: number; metadata: sharp.Metadata }> {
  const metadata = await sharp(sourcePath, { limitInputPixels: MAX_INPUT_PIXELS })
    .metadata()
    .catch((error: unknown) => {
      throw new RunnerError('IO_ERROR', `Cannot read image metadata for ${relativePath}`, {
        cause: error,
      })
    })
  const width = metadata.autoOrient?.width ?? metadata.width
  const height = metadata.autoOrient?.height ?? metadata.height
  if (width === undefined || height === undefined) {
    throw new RunnerError('IO_ERROR', `Image dimensions are unavailable for ${relativePath}`)
  }
  return { width, height, metadata }
}

interface EncodedWorkingCopy {
  bytes: Uint8Array
  width: number
  height: number
  quality: number
}

async function encodeWorkingCopy(
  sourcePath: string,
  cropBox: CropBox | undefined,
  maxEdge: number,
  maxBytes: number,
  initialQuality: number,
): Promise<EncodedWorkingCopy> {
  // 质量下限 60：再低会把细条纹和提花压成色块，宁可继续降边长
  const qualitySchedule = [initialQuality, 80, 75, 70, 65, 60]
    .filter(
      (quality, index, list) =>
        quality >= PREPARED_MIN_QUALITY &&
        quality <= initialQuality &&
        list.indexOf(quality) === index,
    )
    .sort((left, right) => right - left)
  if (qualitySchedule.length === 0) qualitySchedule.push(initialQuality)
  const edgeSchedule: number[] = []
  let edge = maxEdge
  while (edge >= 192) {
    edgeSchedule.push(edge)
    const next = Math.floor(edge * 0.82)
    edge = next === edge ? edge - 1 : next
  }

  // 只解码一次：旋转、裁切、合成白底、转 sRGB 后缓存为原始像素，后续编码全在内存里做
  let pipeline = sharp(sourcePath, {
    failOn: 'error',
    limitInputPixels: MAX_INPUT_PIXELS,
    sequentialRead: true,
  }).rotate()
  if (cropBox !== undefined) pipeline = pipeline.extract(cropBox)
  const decoded = await pipeline
    .flatten({ background: '#ffffff' })
    .toColourspace('srgb')
    .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true })
  const raw = {
    width: decoded.info.width,
    height: decoded.info.height,
    channels: decoded.info.channels,
  }

  for (const currentEdge of edgeSchedule) {
    for (const quality of qualitySchedule) {
      const encoded = await sharp(decoded.data, { raw })
        .resize({
          width: currentEdge,
          height: currentEdge,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality, chromaSubsampling: '4:2:0' })
        .withIccProfile('srgb')
        .toBuffer({ resolveWithObject: true })
      if (encoded.data.byteLength < maxBytes) {
        return {
          bytes: new Uint8Array(encoded.data),
          width: encoded.info.width,
          height: encoded.info.height,
          quality,
        }
      }
    }
  }
  throw new RunnerError(
    'IO_ERROR',
    `Prepared image cannot be reduced below ${String(maxBytes)} bytes at quality ${String(PREPARED_MIN_QUALITY)}`,
  )
}

async function writePreparedBytes(targetPath: string, bytes: Uint8Array): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true })
  const temporaryPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`
  await writeFile(temporaryPath, bytes, { mode: 0o600 })
  await rename(temporaryPath, targetPath)
}

export async function prepareFramingCopy(
  asset: PrepareSourceAsset,
  options: PrepareFramingCopyOptions,
): Promise<PreparedAsset> {
  if (!/^[A-Za-z0-9_-]+$/.test(asset.id)) {
    throw new RunnerError('VALIDATION_ERROR', `Unsafe asset ID: ${asset.id}`)
  }
  if (!/^[A-Za-z0-9_-]+$/.test(options.framingId)) {
    throw new RunnerError('VALIDATION_ERROR', 'Unsafe garment framing ID')
  }
  const encoded = await encodeWorkingCopy(
    asset.sourcePath,
    undefined,
    options.maxEdge ?? PREPARED_MAX_EDGE,
    options.maxBytes ?? PREPARED_MAX_BYTES,
    options.quality ?? PREPARED_JPEG_QUALITY,
  )
  const relativePath = `prepared/.framing-${options.framingId}/${asset.id}.jpg`
  const targetPath = path.join(options.runDir, ...relativePath.split('/'))
  await writePreparedBytes(targetPath, encoded.bytes)
  return {
    assetId: asset.id,
    sourcePath: asset.sourcePath,
    path: targetPath,
    relativePath,
    contentHash: asset.contentHash,
    preparedHash: createHash('sha256').update(encoded.bytes).digest('hex'),
    width: encoded.width,
    height: encoded.height,
    bytes: encoded.bytes.byteLength,
    cropped: false,
    warnings: [],
  }
}

export async function prepareAsset(
  asset: PrepareSourceAsset,
  options: PrepareImageOptions,
): Promise<PreparedAsset> {
  if (!/^[A-Za-z0-9_-]+$/.test(asset.id)) {
    throw new RunnerError('VALIDATION_ERROR', `Unsafe asset ID: ${asset.id}`)
  }
  const warnings: string[] = []
  const warn = (message: string): void => {
    warnings.push(message)
    options.onWarning?.(message)
  }
  const {
    width: orientedWidth,
    height: orientedHeight,
    metadata,
  } = await orientedImageSize(asset.sourcePath, asset.relativePath)
  // 透明像素在 JPEG 里会变成纯黑，编码前统一合成白底并告知用户
  if (metadata.hasAlpha === true) {
    warn(`源图含透明通道，已合成白底：${asset.relativePath}`)
  }
  // P3 / Adobe RGB / CMYK 等宽色域输入会被转成 sRGB，颜色读数与原图不同
  // ICC 描述可能是 UTF-16，去掉 NUL 后再匹配 sRGB
  const iccText = metadata.icc === undefined
    ? ''
    : Buffer.from(metadata.icc).toString('latin1').replace(/\0/g, '')
  if (metadata.space === 'cmyk' || (metadata.icc !== undefined && !/srgb/i.test(iccText))) {
    warn(`源图色彩空间非 sRGB，已转换为 sRGB：${asset.relativePath}`)
  }

  // 服装图必须按手动裁切框或 bbox 裁切，任何情况下都不回退到全图
  let cropBox: CropBox | undefined
  if (asset.role === 'garment' && asset.cropOverride !== undefined) {
    cropBox = validateCropOverride(asset.cropOverride, orientedWidth, orientedHeight)
  } else if (asset.role === 'garment') {
    if (!validBbox(asset.bbox)) {
      throw new RunnerError(
        'PROVIDER_RESPONSE',
        `Garment bbox is missing or invalid for ${asset.relativePath}`,
      )
    }
    cropBox = computeCropBox(asset.bbox, orientedWidth, orientedHeight)
  }

  const encoded = await encodeWorkingCopy(
    asset.sourcePath,
    cropBox,
    options.maxEdge ?? PREPARED_MAX_EDGE,
    options.maxBytes ?? PREPARED_MAX_BYTES,
    options.quality ?? PREPARED_JPEG_QUALITY,
  )
  if (encoded.quality < QUALITY_WARNING_THRESHOLD) {
    warn(`为满足体积上限，压缩质量已降至 q${String(encoded.quality)}：${asset.relativePath}`)
  }

  const targetPath = path.join(options.runDir, 'prepared', `${asset.id}.jpg`)
  await writePreparedBytes(targetPath, encoded.bytes)

  return {
    assetId: asset.id,
    sourcePath: asset.sourcePath,
    path: targetPath,
    relativePath: `prepared/${asset.id}.jpg`,
    contentHash: asset.contentHash,
    preparedHash: createHash('sha256').update(encoded.bytes).digest('hex'),
    width: encoded.width,
    height: encoded.height,
    bytes: encoded.bytes.byteLength,
    cropped: cropBox !== undefined,
    ...(cropBox === undefined ? {} : { cropBox }),
    warnings,
  }
}
