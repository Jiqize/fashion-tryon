import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

export async function makeFixtureRoot(prefix = 'fashion-tryon-fixture-'): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix))
}

export async function writeFixtureImage(
  root: string,
  relativePath: string,
  bytes: number[] | Uint8Array,
): Promise<string> {
  const filePath = path.join(root, ...relativePath.split('/'))
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
  return filePath
}

export async function removeFixtureRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true })
}
