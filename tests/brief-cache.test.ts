import { describe, expect, it } from 'vitest'

import { createBriefCache, getGarmentBrief } from '../src/prepare/brief.js'
import type { PreparedAsset } from '../src/prepare/images.js'
import { FakeVision } from './helpers/fake-vision.js'

function prepared(id: string, path: string, preparedHash = 'b'.repeat(64)): PreparedAsset {
  return {
    assetId: id,
    sourcePath: `/input/${id}.jpg`,
    path,
    relativePath: `prepared/${id}.jpg`,
    contentHash: 'a'.repeat(64),
    preparedHash,
    width: 800,
    height: 1200,
    bytes: 100,
    cropped: false,
    warnings: [],
  }
}

describe('garment brief cache', () => {
  it('keys by prepared content, scope and prompt-contract version', async () => {
    const cache = createBriefCache()
    const vision = new FakeVision()
    const signal = new AbortController().signal

    await Promise.all([
      getGarmentBrief(prepared('one', '/run/prepared/one.jpg'), 'full', vision, cache, signal),
      getGarmentBrief(prepared('two', '/run/prepared/two.jpg'), 'full', vision, cache, signal),
    ])
    await getGarmentBrief(prepared('three', '/run/prepared/three.jpg'), 'top', vision, cache, signal)

    expect(vision.briefCalls).toHaveLength(2)
    expect(vision.briefCalls.map((call) => call.scope)).toEqual(['full', 'top'])
  })

  it('re-reads the brief when the prepared bytes change even if the source is identical', async () => {
    const cache = createBriefCache()
    const vision = new FakeVision()
    const signal = new AbortController().signal

    // 同一张源图，裁切或压缩变了就是另一张送检图，必须重新读 brief
    await getGarmentBrief(prepared('one', '/run/prepared/one.jpg'), 'full', vision, cache, signal)
    await getGarmentBrief(
      prepared('one', '/run/prepared/one.jpg', 'c'.repeat(64)),
      'full',
      vision,
      cache,
      signal,
    )

    expect(vision.briefCalls).toHaveLength(2)
  })
})
