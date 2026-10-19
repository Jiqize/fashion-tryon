import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
const repositoryRoot = process.cwd()

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function packageFiles(root: string): Promise<string[]> {
  const files: string[] = []
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(absolute)
      else files.push(absolute)
    }
  }
  await visit(root)
  return files
}

describe('uncompressed colleague package', () => {
  it('contains the CLI, studio UI, Skill, real-test instructions, logs, and no local-only directories', async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'fashion-tryon-colleague-package-'))
    roots.push(temporaryRoot)
    const outputRoot = path.join(temporaryRoot, 'kit')
    const result = spawnSync(process.execPath, ['scripts/create-colleague-package.mjs', '--', outputRoot], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Created uncompressed colleague package')

    const relativeFiles = (await packageFiles(outputRoot))
      .map((filePath) => path.relative(outputRoot, filePath).split(path.sep).join('/'))
      .sort()
    for (const required of [
      '00-请Agent先读-安装与真实测试.md',
      'TEST-FEEDBACK-TEMPLATE.md',
      'TEST_LOGS/README.md',
      'PACKAGE_INFO.json',
      'SHA256SUMS.txt',
      'dist/cli.mjs',
      'docs/USAGE.md',
      'package.json',
      'pnpm-lock.yaml',
      'skills/fashion-tryon/SKILL.md',
      'skills/fashion-tryon/references/workflow.md',
      'ui/index.html',
      'ui/app.js',
      'ui/app.css',
      'ui/editor.js',
      'ui/editor.css',
      'ui/editor-panel.js',
      'ui/collection.js',
      'ui/collection-drawer.js',
      'ui/controls.js',
    ]) {
      expect(relativeFiles).toContain(required)
    }
    expect(relativeFiles).not.toContain('ui/materials.js')
    for (const forbidden of [
      '.env.local',
      '.git/',
      'local-secrets/',
      'node_modules/',
      'reference/',
    ]) {
      expect(relativeFiles.some((filePath) => filePath === forbidden || filePath.startsWith(forbidden))).toBe(false)
    }
    expect(relativeFiles.some((filePath) => filePath.includes('fashion-tryon-usage-guide'))).toBe(false)

    const [instructions, template, sourceSkill, packagedSkill, packageInfoText] = await Promise.all([
      readFile(path.join(outputRoot, '00-请Agent先读-安装与真实测试.md'), 'utf8'),
      readFile(path.join(outputRoot, 'TEST-FEEDBACK-TEMPLATE.md'), 'utf8'),
      readFile(path.join(repositoryRoot, 'skills/fashion-tryon/SKILL.md'), 'utf8'),
      readFile(path.join(outputRoot, 'skills/fashion-tryon/SKILL.md'), 'utf8'),
      readFile(path.join(outputRoot, 'PACKAGE_INFO.json'), 'utf8'),
    ])
    for (const expected of [
      '真实 provider',
      '不能替代',
      '真实调用费用不是跳过测试的理由',
      'TEST_LOGS',
      'fashion-tryon studio <素材根目录> --json',
      'fashion-tryon status <素材根目录> --json',
      '开始',
      '成图/<款号>/',
      '总览.html',
      'API Key',
      'https://apimart.ai/',
      'https://docs.apimart.ai/en/quickstart',
      'https://bailian.console.aliyun.com/cn-beijing/',
      'https://help.aliyun.com/zh/model-studio/get-api-key/',
      '不同地域的 Key 和 Base URL 不能混用',
      'ui/collection.js',
      'ui/collection-drawer.js',
      'ui/controls.js',
      '合集页',
    ]) {
      expect(instructions).toContain(expected)
    }
    expect(instructions).not.toContain('ui/materials.js')
    for (const expected of ['真实调用与耗时', '分享前脱敏检查', 'generationCalls', '成图/<款号>/', '同名文件未被覆盖']) {
      expect(template).toContain(expected)
    }
    // 同事文档只描述看板流程，不再出现旧流水线命令
    for (const legacy of ['preflight', '--approve-plan', 'review-session', 'review-selection', 'finalize', 'planDigest']) {
      expect(instructions).not.toContain(legacy)
      expect(template).not.toContain(legacy)
    }
    expect(packagedSkill).toBe(sourceSkill)
    const packageInfo = JSON.parse(packageInfoText) as Record<string, unknown>
    expect(packageInfo.realProviderTestRequired).toBe(true)
    expect(packageInfo.containsCredentials).toBe(false)
    expect(packageInfoText).not.toContain(repositoryRoot)

    const manifest = await readFile(path.join(outputRoot, 'SHA256SUMS.txt'), 'utf8')
    const manifestEntries = manifest.trim().split('\n').map((line) => {
      const match = /^([a-f0-9]{64})  (.+)$/.exec(line)
      expect(match).not.toBeNull()
      return { digest: match![1]!, relativePath: match![2]! }
    })
    expect(manifestEntries.some((entry) => entry.relativePath === 'skills/fashion-tryon/SKILL.md')).toBe(true)
    for (const entry of manifestEntries) {
      const contents = await readFile(path.join(outputRoot, ...entry.relativePath.split('/')))
      expect(createHash('sha256').update(contents).digest('hex')).toBe(entry.digest)
    }

    const secondResult = spawnSync(
      process.execPath,
      ['scripts/create-colleague-package.mjs', outputRoot],
      { cwd: repositoryRoot, encoding: 'utf8' },
    )
    expect(secondResult.status).not.toBe(0)
    expect(secondResult.stderr).toContain('Refusing to overwrite existing path')
  }, 30_000)
})
