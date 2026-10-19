import { mkdir, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { config as loadDotenv } from 'dotenv'
import { describe, expect, it, vi } from 'vitest'

import { loadRunnerConfig, requireApimartConfig, requireDashscopeConfig } from '../src/config.js'
import { RunnerError } from '../src/errors.js'
import { createApimartAdapter } from '../src/providers/apimart.js'
import { createDashscopeAdapter } from '../src/providers/dashscope.js'
import { scanSource } from '../src/studio/scan.js'
import { startStudioServer } from '../src/studio/server.js'

// 真实服务商冒烟（spec 第 7 节第 11 条）：2 套 × 3 张，默认跳过，会产生真实费用
const PAID_GROUPS = 2
const PAID_MODELS_PER_GROUP = 3

export function paidSourceFrom(env: NodeJS.ProcessEnv): string {
  if (env.FASHION_TRYON_PAID_E2E !== '1') {
    throw new RunnerError('CONFIG_ERROR', 'FASHION_TRYON_PAID_E2E=1 is required')
  }
  const sourceRoot = env.PAID_E2E_SOURCE_ROOT?.trim()
  if (sourceRoot === undefined || sourceRoot === '') {
    throw new RunnerError('CONFIG_ERROR', 'PAID_E2E_SOURCE_ROOT is required before any network call')
  }
  return path.resolve(sourceRoot)
}

if (process.env.FASHION_TRYON_PAID_E2E === '1') {
  loadDotenv({ path: path.resolve('.env.local'), override: false, quiet: true })
}

const paidReady = process.env.FASHION_TRYON_PAID_E2E === '1' && Boolean(process.env.PAID_E2E_SOURCE_ROOT?.trim())

describe('paid e2e gate', () => {
  it('refuses to run without the explicit flag and a source root before adapters are constructed', () => {
    expect(() => paidSourceFrom({})).toThrow(expect.objectContaining({ code: 'CONFIG_ERROR' }))
    expect(() => paidSourceFrom({ FASHION_TRYON_PAID_E2E: '1' })).toThrow(
      expect.objectContaining({ code: 'CONFIG_ERROR' }),
    )
  })
})

describe.skipIf(!paidReady)('authorized APIMART + DashScope studio smoke', () => {
  it('generates, passes and delivers 2 groups × 3 images through the studio API', async () => {
    const sourceRoot = paidSourceFrom(process.env)
    // 素材必须恰好 2 套、每套 1 张服装 + 3 张模特，超出即在联网前拒绝
    const scanned = await scanSource(sourceRoot)
    expect(scanned).toHaveLength(PAID_GROUPS)
    for (const group of scanned) {
      expect(group.garments).toHaveLength(1)
      expect(group.models).toHaveLength(PAID_MODELS_PER_GROUP)
    }

    const config = loadRunnerConfig(process.env, {})
    if (config.imageModel === undefined) throw new RunnerError('CONFIG_ERROR', 'IMAGE_MODEL')
    const server = await startStudioServer({
      sourceRoot,
      deps: {
        vision: createDashscopeAdapter(requireDashscopeConfig(config)),
        images: createApimartAdapter(requireApimartConfig(config)),
      },
    })
    const base = new URL(server.url)
    const api = (pathname: string): string => {
      const target = new URL(pathname, base.origin)
      target.searchParams.set('token', base.searchParams.get('token')!)
      return target.toString()
    }
    const post = async (pathname: string, body: unknown): Promise<void> => {
      const response = await fetch(api(pathname), {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base.origin },
        body: JSON.stringify(body),
      })
      expect(response.status, await response.text()).toBe(200)
    }
    type Group = { id: string; sku: string; status: string }
    const groups = async (): Promise<Group[]> =>
      ((await (await fetch(api('/api/batch'))).json()) as { state: { groups: Group[] } }).state.groups

    try {
      await post('/api/settings', { mode: 'fixedClothing', candidates: 1, concurrency: 3 })
      await post('/api/start', {})
      await vi.waitFor(async () => {
        const current = await groups()
        expect(current.every((group) => group.status === 'review')).toBe(true)
      }, { timeout: 900_000, interval: 5_000 })
      for (const group of await groups()) {
        await post('/api/decisions', { op: 'pass', groupId: group.id })
        const delivered = await readdir(path.join(sourceRoot, '成图', group.sku))
        expect(delivered.length).toBeGreaterThanOrEqual(PAID_MODELS_PER_GROUP)
      }

      const acceptanceDir = path.resolve('local-secrets/paid-e2e-acceptance')
      await mkdir(acceptanceDir, { recursive: true })
      await writeFile(path.join(acceptanceDir, `studio-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), `${JSON.stringify({
        schemaVersion: 2,
        recordedAt: new Date().toISOString(),
        groups: PAID_GROUPS,
        imagesPerGroup: PAID_MODELS_PER_GROUP,
        batchDir: server.batchDir,
        imageModel: config.imageModel,
        visionModel: config.visionModel,
      }, null, 2)}\n`, { mode: 0o600 })
    } finally {
      await server.close()
    }
  }, 1_000_000)
})
