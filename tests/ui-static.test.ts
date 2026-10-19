import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

const repositoryRoot = process.cwd()
const PAGE_SCRIPTS = ['ui/collection.js', 'ui/collection-drawer.js', 'ui/editor-panel.js', 'ui/editor.js', 'ui/projects.js']
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** 逐个脚本找禁用写法：原生下拉、alert、confirm（UI.confirm 除外）、单选框；返回「文件名: 写法」 */
async function findBannedPatterns(root: string, files: string[]): Promise<string[]> {
  const problems: string[] = []
  for (const file of files) {
    const text = await readFile(path.join(root, file), 'utf8')
    const checks: Array<[string, RegExp]> = [
      ['<select', /<select/i],
      ['alert(', /\balert\(/],
      ['confirm(', /(?<!UI\.)\bconfirm\(/],
      ['type="radio"', /type=["']radio["']/i],
    ]
    for (const [label, pattern] of checks) {
      if (pattern.test(text)) problems.push(file + ': ' + label)
    }
  }
  return problems
}

describe('page scripts static check', () => {
  it('has no native select, alert, confirm or radio in the page scripts', async () => {
    expect(await findBannedPatterns(repositoryRoot, PAGE_SCRIPTS)).toEqual([])
  })

  it('reports the file name when a copy gains a <select', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fashion-tryon-ui-static-'))
    roots.push(root)
    for (const file of PAGE_SCRIPTS) {
      await copyFile(path.join(repositoryRoot, file), path.join(root, path.basename(file)))
    }
    const names = PAGE_SCRIPTS.map((file) => path.basename(file))
    const target = path.join(root, 'collection-drawer.js')
    await writeFile(target, (await readFile(target, 'utf8')) + "\nconst bad = '<select id=\"x\"></select>'\n")
    expect(await findBannedPatterns(root, names)).toEqual(['collection-drawer.js: <select'])
  })

  it('ships ui/controls.js and loads it on both pages', async () => {
    const [controls, server, collectionPage, graph] = await Promise.all([
      readFile(path.join(repositoryRoot, 'ui/controls.js'), 'utf8'),
      readFile(path.join(repositoryRoot, 'src/editor/server.ts'), 'utf8'),
      readFile(path.join(repositoryRoot, 'src/editor/collection-page.ts'), 'utf8'),
      readFile(path.join(repositoryRoot, 'src/simple/graph.ts'), 'utf8'),
    ])
    expect(controls).toContain('window.__UI__')
    expect(server).toMatch(/UI_FILES = new Set\(\[[^\]]*'controls\.js'/)
    expect(collectionPage).toContain('<script src="/ui/controls.js"')
    expect(graph).toMatch(/\['controls\.js',\s*'editor-panel\.js',\s*'editor\.js'\]/)
  })
})
