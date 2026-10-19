#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { scanSecrets } from './scan-secrets.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const repositoryRoot = path.resolve(path.dirname(scriptPath), '..')

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

async function pathExists(target) {
  try {
    await lstat(target)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function gitOutput(args) {
  const result = spawnSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  })
  if (result.status !== 0) return undefined
  return result.stdout.trim()
}

async function filesUnder(root) {
  const found = []
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const entry of entries) {
      if (entry.name === '.DS_Store' || entry.name === 'SHA256SUMS.txt') continue
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(absolute)
      else if (entry.isFile()) found.push(absolute)
      else throw new Error(`Unsupported package entry: ${path.relative(root, absolute)}`)
    }
  }
  await visit(root)
  return found
}

async function sha256Manifest(root) {
  const lines = []
  for (const filePath of await filesUnder(root)) {
    const contents = await readFile(filePath)
    const digest = createHash('sha256').update(contents).digest('hex')
    lines.push(`${digest}  ${path.relative(root, filePath).split(path.sep).join('/')}`)
  }
  return `${lines.join('\n')}\n`
}

async function main() {
  const positionalArguments = process.argv.slice(2).filter((argument) => argument !== '--')
  const outputArgument = positionalArguments[0]
  if (
    positionalArguments.length !== 1 ||
    outputArgument === undefined ||
    outputArgument.startsWith('-')
  ) {
    fail('Usage: node scripts/create-colleague-package.mjs <new-output-directory>')
    return
  }

  const outputRoot = path.resolve(outputArgument)
  if (isInside(repositoryRoot, outputRoot)) {
    fail('Refusing to create a colleague package inside the source repository')
    return
  }
  if (await pathExists(outputRoot)) {
    fail(`Refusing to overwrite existing path: ${outputRoot}`)
    return
  }

  const requiredFiles = [
    '.env.example',
    '.gitignore',
    'README.md',
    'package.json',
    'pnpm-lock.yaml',
    'tsconfig.build.json',
    'tsconfig.json',
    'tsdown.config.ts',
    'vitest.config.ts',
  ]
  const requiredDirectories = [
    'dist',
    'docs',
    'examples',
    'scripts',
    'skills',
    'src',
    'tests',
    'ui',
  ]

  for (const relativePath of [...requiredFiles, ...requiredDirectories]) {
    if (!(await pathExists(path.join(repositoryRoot, relativePath)))) {
      fail(`Required package source is missing: ${relativePath}`)
      return
    }
  }

  await mkdir(outputRoot, { recursive: false, mode: 0o755 })
  for (const relativePath of requiredFiles) {
    await copyFile(path.join(repositoryRoot, relativePath), path.join(outputRoot, relativePath))
  }
  for (const relativePath of requiredDirectories) {
    await cp(path.join(repositoryRoot, relativePath), path.join(outputRoot, relativePath), {
      recursive: true,
      preserveTimestamps: true,
      filter: (source) => path.basename(source) !== '.DS_Store',
    })
  }

  await copyFile(
    path.join(repositoryRoot, 'docs/COLLEAGUE_INSTALL_AND_REAL_TEST.md'),
    path.join(outputRoot, '00-请Agent先读-安装与真实测试.md'),
  )
  await copyFile(
    path.join(repositoryRoot, 'docs/COLLEAGUE_TEST_FEEDBACK_TEMPLATE.md'),
    path.join(outputRoot, 'TEST-FEEDBACK-TEMPLATE.md'),
  )
  await mkdir(path.join(outputRoot, 'TEST_LOGS'), { mode: 0o755 })
  await writeFile(
    path.join(outputRoot, 'TEST_LOGS/README.md'),
    '# TEST_LOGS\n\n同事 Agent 按 `00-请Agent先读-安装与真实测试.md` 为每次真实测试创建独立子目录。不要在这里保存 API Key 或 `.env.local`。\n',
    { encoding: 'utf8', mode: 0o644 },
  )

  const status = gitOutput(['status', '--porcelain'])
  const packageInfo = {
    kind: 'fashion-tryon-colleague-package',
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    sourceRevision: gitOutput(['rev-parse', 'HEAD']) ?? 'unknown',
    sourceWorkingTreeIncluded: status !== undefined && status !== '',
    packageVersion: JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8')).version,
    node: '>=20',
    pnpm: '10.33.4',
    realProviderTestRequired: true,
    containsCredentials: false,
  }
  await writeFile(
    path.join(outputRoot, 'PACKAGE_INFO.json'),
    `${JSON.stringify(packageInfo, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o644 },
  )
  await writeFile(
    path.join(outputRoot, 'SHA256SUMS.txt'),
    await sha256Manifest(outputRoot),
    { encoding: 'utf8', mode: 0o644 },
  )

  // 自检：包内不得含本机密钥值或私人绝对路径；命中即删除整个包。
  const scan = await scanSecrets({
    root: outputRoot,
    paths: [outputRoot],
    secretFiles: [
      path.join(repositoryRoot, '.env'),
      path.join(repositoryRoot, '.env.local'),
      path.join(repositoryRoot, 'local-secrets/.env.local'),
    ],
    privatePaths: [homedir(), repositoryRoot],
  })
  if (scan.matches.length > 0) {
    await rm(outputRoot, { recursive: true, force: true })
    fail(`Refusing to keep a colleague package that leaks secrets or private paths (${String(scan.matches.length)} match(es)):`)
    for (const match of scan.matches) {
      fail(`- ${path.relative(outputRoot, match.filePath)} (${match.names.join(', ')})`)
    }
    return
  }

  const fileCount = (await filesUnder(outputRoot)).length + 1
  process.stdout.write(`Created uncompressed colleague package with ${String(fileCount)} files:\n${outputRoot}\n`)
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : 'Unknown package creation error')
})
