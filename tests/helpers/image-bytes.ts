import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import sharp from 'sharp'

export type FixtureImageFormat = 'jpeg' | 'png' | 'webp'

function formatFor(relativePath: string): FixtureImageFormat {
  const extension = path.extname(relativePath).toLowerCase()
  if (extension === '.png') return 'png'
  if (extension === '.webp') return 'webp'
  return 'jpeg'
}

/** 真实可解码的小图；seed 决定颜色，因此每个 seed 的 contentHash 都不同。 */
export async function fixtureImageBytes(
  seed: number,
  format: FixtureImageFormat = 'jpeg',
): Promise<Uint8Array> {
  const pipeline = sharp({
    create: {
      width: 24,
      height: 32,
      channels: 3,
      background: { r: seed % 251, g: (seed * 7) % 251, b: (seed * 13) % 251 },
    },
  })
  const encoded = format === 'png'
    ? await pipeline.png().toBuffer()
    : format === 'webp'
      ? await pipeline.webp().toBuffer()
      : await pipeline.jpeg().toBuffer()
  return new Uint8Array(encoded)
}

export async function writeFixtureRealImage(
  root: string,
  relativePath: string,
  seed: number,
): Promise<string> {
  const filePath = path.join(root, ...relativePath.split('/'))
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, await fixtureImageBytes(seed, formatFor(relativePath)))
  return filePath
}
