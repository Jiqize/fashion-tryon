import { createHash } from 'node:crypto'

import type { Scope } from '../contracts.js'
import type { GarmentBrief, VisionPort } from '../ports.js'
import type { PreparedAsset } from './images.js'

export const BRIEF_PROMPT_CONTRACT_VERSION = 'v3'

export interface BriefCache {
  readonly values: Map<string, Promise<GarmentBrief>>
}

export function createBriefCache(): BriefCache {
  return { values: new Map() }
}

export function briefCacheKey(asset: PreparedAsset, scope: Scope): string {
  // 送进视觉端口的是 prepared 副本，按它的哈希做键；裁切或压缩变了就必须重新读 brief
  return createHash('sha256')
    .update(`${asset.preparedHash}\0${scope}\0${BRIEF_PROMPT_CONTRACT_VERSION}`)
    .digest('hex')
}

export async function getGarmentBrief(
  asset: PreparedAsset,
  scope: Scope,
  vision: VisionPort,
  cache: BriefCache,
  signal: AbortSignal,
): Promise<GarmentBrief> {
  const key = briefCacheKey(asset, scope)
  const hit = cache.values.get(key)
  if (hit !== undefined) return hit

  const pending = vision.brief(
    { imagePath: asset.path, contentHash: asset.contentHash, scope },
    signal,
  )
  cache.values.set(key, pending)
  try {
    return await pending
  } catch (error) {
    cache.values.delete(key)
    throw error
  }
}
