#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

function parseArgs(argv) {
  const options = { root: process.cwd(), paths: [], secretFiles: [], privatePaths: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const value = argv[index + 1]
    if (
      (argument === '--root' || argument === '--path' || argument === '--secret-file' ||
        argument === '--private-path') && value === undefined
    ) {
      throw new Error(`${argument} requires a path`)
    }
    if (argument === '--root') {
      options.root = path.resolve(value)
      index += 1
    } else if (argument === '--path') {
      options.paths.push(path.resolve(value))
      index += 1
    } else if (argument === '--secret-file') {
      options.secretFiles.push(path.resolve(value))
      index += 1
    } else if (argument === '--private-path') {
      options.privatePaths.push(path.resolve(value))
      index += 1
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }
  return options
}

function unquote(value) {
  const trimmed = value.trim()
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) return trimmed.slice(1, -1)
  return trimmed.replace(/\s+#.*$/, '').trim()
}

async function secretValues(secretFiles) {
  const byValue = new Map()
  const seenFiles = new Set()
  for (const secretFile of secretFiles) {
    let canonical
    try {
      canonical = await realpath(secretFile)
    } catch {
      continue
    }
    if (seenFiles.has(canonical)) continue
    seenFiles.add(canonical)
    const text = await readFile(canonical, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
      if (match === null || !/(?:KEY|TOKEN|SECRET|PASSWORD)$/i.test(match[1])) continue
      const value = unquote(match[2])
      if (value === '') continue
      const names = byValue.get(value) ?? []
      names.push(match[1])
      byValue.set(value, names)
    }
  }
  return [...byValue.entries()].map(([value, names]) => ({ value, names }))
}

function trackedFiles(root) {
  const result = spawnSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0) return undefined
  return result.stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((relativePath) => path.resolve(root, relativePath))
}

async function filesUnder(target) {
  let info
  try {
    info = await lstat(target)
  } catch {
    return []
  }
  if (!info.isDirectory()) return [target]
  const files = []
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (
        entry.name === '.git' ||
        entry.name === 'node_modules' ||
        entry.name === 'local-secrets'
      ) continue
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(absolute)
      else if (entry.isFile() || entry.isSymbolicLink()) files.push(absolute)
    }
  }
  await visit(target)
  return files
}

async function defaultGeneratedPaths(root) {
  const paths = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (entry.name === 'runs' || entry.name.endsWith('-tryon-output')) {
      paths.push(path.join(root, entry.name))
    }
  }
  return paths
}

function displayPath(root, filePath) {
  const relative = path.relative(root, filePath)
  if (relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..') return relative
  return `[external]/${path.basename(filePath)}`
}

export async function scanSecrets(options) {
  const root = path.resolve(options.root)
  const configuredSecretFiles = options.secretFiles.length > 0
    ? options.secretFiles
    : [
        path.join(root, '.env'),
        path.join(root, '.env.local'),
        path.join(root, 'local-secrets/.env.local'),
      ]
  const secrets = await secretValues(configuredSecretFiles)
  const privatePaths = (options.privatePaths ?? []).map((value) => ({
    value: path.resolve(value),
    names: ['PRIVATE_PATH'],
  }))
  const forbiddenValues = [...secrets, ...privatePaths]
  const generatedPaths = [
    ...(await defaultGeneratedPaths(root)),
    ...options.paths,
  ]
  const generatedFiles = (await Promise.all(generatedPaths.map(filesUnder))).flat()
  const tracked = trackedFiles(root)
  const unpacked = tracked === undefined ? await filesUnder(root) : []
  const secretSourceFiles = new Set()
  for (const secretFile of configuredSecretFiles) {
    try {
      secretSourceFiles.add(await realpath(secretFile))
    } catch {
      // A missing secret file is valid for an unconfigured package.
    }
  }
  const files = []
  for (const filePath of new Set([...(tracked ?? []), ...unpacked, ...generatedFiles])) {
    let canonical
    try {
      canonical = await realpath(filePath)
    } catch {
      canonical = path.resolve(filePath)
    }
    if (!secretSourceFiles.has(canonical)) files.push(filePath)
  }
  const matches = []
  for (const filePath of files) {
    let contents
    try {
      contents = await readFile(filePath)
    } catch {
      continue
    }
    for (const forbidden of forbiddenValues) {
      if (contents.indexOf(Buffer.from(forbidden.value)) !== -1) {
        matches.push({ filePath, names: forbidden.names })
      }
    }
  }
  return {
    root,
    trackedCount: tracked?.length ?? 0,
    unpackedCount: unpacked.length,
    generatedCount: generatedFiles.length,
    secretCount: secrets.length,
    privatePathCount: privatePaths.length,
    matches,
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const result = await scanSecrets(options)
  if (result.matches.length > 0) {
    process.stderr.write(`Secret scan failed: ${String(result.matches.length)} match(es).\n`)
    for (const match of result.matches) {
      process.stderr.write(`- ${displayPath(result.root, match.filePath)} (${match.names.join(', ')})\n`)
    }
    process.exitCode = 1
    return
  }
  process.stdout.write(
    `Secret scan passed: ${String(result.trackedCount)} tracked, ${String(result.unpackedCount)} unpacked, ${String(result.generatedCount)} generated, ${String(result.secretCount)} configured secret value(s), ${String(result.privatePathCount)} private path value(s).\n`,
  )
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href) {
  main().catch((error) => {
    process.stderr.write(`Secret scan error: ${error instanceof Error ? error.message : 'unknown error'}\n`)
    process.exitCode = 1
  })
}
