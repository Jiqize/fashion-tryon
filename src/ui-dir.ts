import { stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 从模块所在目录向上找包根目录下的 ui/（src/、src/studio/ 与 dist/ 深度不同）。 */
export async function findUiDir(): Promise<string | undefined> {
  let current = path.dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 4; depth += 1) {
    const candidate = path.join(current, 'ui')
    if (await stat(path.join(candidate, 'index.html')).then((info) => info.isFile(), () => false)) {
      return candidate
    }
    current = path.dirname(current)
  }
  return undefined
}
