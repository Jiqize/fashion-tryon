import { homedir } from 'node:os'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

// 一键启动记住上次打开的素材根目录：存在 ~/.config/fashion-tryon/last-root（FASHION_TRYON_HOME 可改目录，测试用）

export function configDir(env: NodeJS.ProcessEnv): string {
  return env.FASHION_TRYON_HOME ?? path.join(env.HOME ?? homedir(), '.config', 'fashion-tryon')
}

function lastRootFile(env: NodeJS.ProcessEnv): string {
  return path.join(configDir(env), 'last-root')
}

export async function readLastRoot(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const text = await readFile(lastRootFile(env), 'utf8').catch(() => '')
  const root = text.trim()
  return root === '' ? undefined : root
}

export async function writeLastRoot(env: NodeJS.ProcessEnv, root: string): Promise<void> {
  const file = lastRootFile(env)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${root}\n`, 'utf8')
}
