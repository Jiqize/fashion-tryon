import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
const repositoryRoot = process.cwd()

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('fashion-tryon Agent Skill contract', () => {
  it('routes the studio workflow through studio and status without judging or moving files', async () => {
    const skillPath = path.join(repositoryRoot, 'skills/fashion-tryon/SKILL.md')
    const workflowPath = path.join(repositoryRoot, 'skills/fashion-tryon/references/workflow.md')
    const [skill, workflow] = await Promise.all([
      readFile(skillPath, 'utf8'),
      readFile(workflowPath, 'utf8'),
    ])
    const combined = `${skill}\n${workflow}`

    expect(skill).toMatch(/^---\nname: fashion-tryon\ndescription: .+\n---/)
    expect(skill).toContain('references/workflow.md')
    expect(skill).toContain('fashion-tryon run <source-root> --json')
    // 装了 MCP 时优先用工具
    expect(skill).toContain('start_run')
    // 只重出几张用 rerun，可编辑节点图用 open_graph
    expect(skill).toContain('rerun')
    expect(skill).toContain('open_graph')
    // 用户自己放图、挑图时引导到页面
    expect(skill).toContain('place or pick images themselves')
    // 合集页的搭配规则与入口
    expect(skill).toContain('固定模特')
    expect(skill).toContain('一对一')
    expect(skill).toContain('collection page')
    expect(skill).toContain('fashion-tryon crop <source-root> --plan <plan.json> --json')
    expect(skill).toContain('fashion-tryon studio <source-root> --json')
    expect(skill).toContain('fashion-tryon status <source-root> --json')
    expect(skill).toMatch(/background/i)
    expect(skill).toContain('`url`')
    expect(combined).toContain('<source-root>/成图/<款号>/')
    expect(combined).toMatch(/never judge, pass, exclude, or regenerate/i)
    expect(combined).toMatch(/never copy, move, rename, or delete/i)
    expect(combined).toMatch(/never overwritten/i)
    expect(combined).toMatch(/submitted twice/i)
    for (const mode of ['fixedClothing', 'pair', 'fixedModel']) expect(combined).toContain(mode)
    expect(combined).not.toMatch(/https?:\/\//i)
    expect(combined).not.toMatch(
      /APIMART|DASHSCOPE|Authorization\s*:|Bearer\s+|API_KEY\s*=|fetch\s*\(/i,
    )
    for (const legacy of ['preflight', '--approve-plan', 'review-session', 'review-selection', 'finalize', 'planDigest']) {
      expect(combined).not.toContain(legacy)
    }
  })
})

describe('studio usage and architecture documentation', () => {
  it('describes the studio flow, every shortcut and the batch record without the legacy pipeline', async () => {
    const paths = [
      'README.md',
      'docs/USAGE.md',
      'docs/ARCHITECTURE.md',
      'docs/INPUT_OUTPUT.md',
    ].map((relativePath) => path.join(repositoryRoot, relativePath))
    const [readme, usage, architecture, inputOutput] = await Promise.all(
      paths.map((filePath) => readFile(filePath, 'utf8')),
    ) as [string, string, string, string]

    for (const entry of [readme, usage]) {
      expect(entry).toContain('fashion-tryon studio')
      expect(entry).toContain('素材表')
      expect(entry).toContain('开始')
      expect(entry).toContain('成图/<款号>/')
      expect(entry).toContain('总览.html')
      for (const key of ['`↑`', '`↓`', '`←`', '`→`', '`Enter`', '`R`', '`X`', '`1`–`4`', '`Space`', '`E`', '`C`', '`⌘Z`']) {
        expect(entry).toContain(key)
      }
    }
    expect(inputOutput).toContain('studio.json')
    expect(inputOutput).toContain('-tryon-studio/')
    expect(inputOutput).toContain('providerRequestId')
    expect(architecture).toContain('studio.json')
    expect(architecture).toContain('providerRequestId')
    for (const entry of [readme, usage, architecture, inputOutput]) {
      for (const legacy of ['preflight', '--approve-plan', 'review-session', 'review-selection.json', 'finalize']) {
        expect(entry).not.toContain(legacy)
      }
    }
  })
})

describe('secret scanner', () => {
  it('scans preflight, review, report, and delivery artifacts for secrets and private paths without echoing values', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fashion-tryon-secret-scan-'))
    roots.push(root)
    const secret = 'fake-secret-value-never-print-92741'
    const secretFile = path.join(root, '.env.local')
    const trackedFile = path.join(root, 'tracked.txt')
    const generatedDir = path.join(root, 'generated-run')
    const deliveryDir = path.join(generatedDir, 'deliveries', 'delivery-id')
    await mkdir(deliveryDir, { recursive: true })
    await writeFile(path.join(root, '.gitignore'), '.env.local\ngenerated-run/\n')
    await writeFile(secretFile, `TEST_API_KEY=${secret}\n`)
    await writeFile(trackedFile, 'safe tracked content\n')
    expect(spawnSync('git', ['init', '-q'], { cwd: root }).status).toBe(0)
    expect(spawnSync('git', ['add', '.gitignore', 'tracked.txt'], { cwd: root }).status).toBe(0)
    const scanner = path.join(repositoryRoot, 'scripts/scan-secrets.mjs')
    const runScan = (extraArgs: string[] = []) => spawnSync(process.execPath, [
      scanner,
      '--root', root,
      '--secret-file', secretFile,
      ...extraArgs,
    ], { cwd: repositoryRoot, encoding: 'utf8' })

    expect(runScan().status).toBe(0)

    await writeFile(trackedFile, `prefix ${secret} suffix\n`)
    const trackedFailure = runScan()
    expect(trackedFailure.status).not.toBe(0)
    expect(`${trackedFailure.stdout}${trackedFailure.stderr}`).not.toContain(secret)

    await writeFile(trackedFile, 'safe again\n')
    await Promise.all([
      writeFile(path.join(generatedDir, 'preflight.html'), '<p>safe preview</p>'),
      writeFile(path.join(generatedDir, 'report.html'), '<p>safe report</p>'),
      writeFile(path.join(generatedDir, 'review-selection.json'), '{"safe":true}\n'),
      writeFile(path.join(deliveryDir, 'delivery.json'), '{"safe":true}\n'),
      writeFile(path.join(deliveryDir, 'mapping.csv'), 'status,taskId\n'),
      writeFile(path.join(deliveryDir, 'contact-sheet.html'), '<p>safe delivery</p>'),
    ])
    expect(runScan(['--path', generatedDir, '--private-path', root]).status).toBe(0)

    await writeFile(path.join(deliveryDir, 'delivery.json'), `<p>${secret}</p>`)
    const generatedFailure = runScan(['--path', generatedDir])
    expect(generatedFailure.status).not.toBe(0)
    expect(`${generatedFailure.stdout}${generatedFailure.stderr}`).not.toContain(secret)

    await writeFile(path.join(deliveryDir, 'delivery.json'), `{"leak":${JSON.stringify(root)}}\n`)
    const pathFailure = runScan(['--path', generatedDir, '--private-path', root])
    expect(pathFailure.status).not.toBe(0)
    expect(`${pathFailure.stdout}${pathFailure.stderr}`).not.toContain(root)
  })

  it('scans an unpacked colleague directory without Git while excluding the credential source file', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fashion-tryon-unpacked-secret-scan-'))
    roots.push(root)
    const secret = 'fake-unpacked-secret-value-never-print-77193'
    const secretFile = path.join(root, '.env.local')
    const sourceFile = path.join(root, 'dist/cli.mjs')
    await mkdir(path.dirname(sourceFile), { recursive: true })
    await writeFile(secretFile, `TEST_API_KEY=${secret}\n`)
    await writeFile(sourceFile, 'safe bundle\n')
    const scanner = path.join(repositoryRoot, 'scripts/scan-secrets.mjs')
    const runScan = () => spawnSync(process.execPath, [
      scanner,
      '--root', root,
      '--secret-file', secretFile,
    ], { cwd: repositoryRoot, encoding: 'utf8' })

    const clean = runScan()
    expect(clean.status, `${clean.stdout}\n${clean.stderr}`).toBe(0)
    expect(clean.stdout).toContain('unpacked')

    await writeFile(sourceFile, `leak ${secret}\n`)
    const failure = runScan()
    expect(failure.status).not.toBe(0)
    expect(`${failure.stdout}${failure.stderr}`).not.toContain(secret)
  })
})
