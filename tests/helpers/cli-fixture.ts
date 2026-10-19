import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import sharp from 'sharp'

export interface CliFixture {
  workspace: string
  inputRoot: string
  outputRoot: string
  cleanup(): Promise<void>
}

export async function createCliFixture(
  groups: Array<{ name: string; garments: number; models: number }>,
): Promise<CliFixture> {
  const workspace = await mkdtemp(path.join(tmpdir(), 'fashion-tryon-cli-'))
  const inputRoot = path.join(workspace, 'input')
  const outputRoot = path.join(workspace, 'output')
  for (const [groupIndex, group] of groups.entries()) {
    for (let index = 0; index < group.garments; index += 1) {
      const target = path.join(
        inputRoot,
        group.name,
        '服装',
        `garment-${String(index + 1).padStart(2, '0')}.jpg`,
      )
      await mkdir(path.dirname(target), { recursive: true })
      await sharp({
        create: {
          width: 96,
          height: 128,
          channels: 3,
          background: {
            r: 40 + groupIndex * 25 + index,
            g: 70 + groupIndex * 20 + index,
            b: 110 + index,
          },
        },
      }).jpeg().toFile(target)
    }
    for (let index = 0; index < group.models; index += 1) {
      const target = path.join(
        inputRoot,
        group.name,
        '模特',
        `model-${String(index + 1).padStart(2, '0')}.jpg`,
      )
      await mkdir(path.dirname(target), { recursive: true })
      await sharp({
        create: {
          width: 96,
          height: 128,
          channels: 3,
          background: {
            r: 170 + groupIndex * 10,
            g: 150 + index,
            b: 130 + groupIndex * 10,
          },
        },
      }).jpeg().toFile(target)
    }
  }
  await mkdir(outputRoot, { recursive: true })
  return {
    workspace,
    inputRoot,
    outputRoot,
    cleanup: () => rm(workspace, { recursive: true, force: true }),
  }
}

async function filesUnder(root: string): Promise<string[]> {
  const result: string[] = []
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory() && entry.name !== '成图') await visit(absolute)
      else if (entry.isFile()) result.push(absolute)
    }
  }
  await visit(root)
  return result.sort()
}

export async function inputHashes(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const filePath of await filesUnder(root)) {
    result[path.relative(root, filePath)] = createHash('sha256')
      .update(await readFile(filePath))
      .digest('hex')
  }
  return result
}
