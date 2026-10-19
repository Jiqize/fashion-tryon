import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterEach, describe, expect, it } from 'vitest'

import { scanTool } from '../src/mcp/tools.js'
import { isProcessAlive } from '../src/simple/lock.js'
import { readRunRecord } from '../src/simple/record.js'
import { fixtureImageBytes } from './helpers/image-bytes.js'

const roots: string[] = []
const clients: Client[] = []

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeRoot(files: string[]): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mcp-server-'))
  roots.push(root)
  for (const [index, file] of files.entries()) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await writeFile(path.join(root, file), await fixtureImageBytes(index + 1))
  }
  return root
}

async function connect(env: Record<string, string> = {}): Promise<Client> {
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
    entry[1] !== undefined && !entry[0].startsWith('APIMART_')))
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', path.resolve('src/cli.ts'), 'mcp'],
    env: { ...baseEnv, ...env },
    stderr: 'ignore',
  })
  const client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(transport)
  clients.push(client)
  return client
}

describe('mcp server', () => {
  it('lists exactly the eight tools with the key guidance', async () => {
    const client = await connect()
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual(['cancel_run', 'crop', 'list_runs', 'open_graph', 'rerun', 'run_status', 'scan', 'start_run'])
    expect(tools.find((tool) => tool.name === 'open_graph')!.description).toContain('自己放图、挑图')
    const crop = tools.find((tool) => tool.name === 'crop')!
    expect(crop.description).toContain('全身-正面')
    expect(crop.description).toContain('replace')
    const start = tools.find((tool) => tool.name === 'start_run')!
    expect(start.description).toContain('apimart')
    expect(start.description).toContain('费用')
    const rerun = tools.find((tool) => tool.name === 'rerun')!
    for (const text of ['只重出', 'run_status', '脸', 'crop', '费用', '质量关口']) expect(rerun.description).toContain(text)
    const shotItem = (rerun.inputSchema.properties!.shots as { items: { properties: Record<string, unknown> } }).items.properties
    expect(Object.keys(shotItem)).toContain('item')
    const collection = '按合集页保存的搭配规则出图；用户想放图、挑图、看成图时用 open_graph 打开合集页'
    expect(start.description).toContain(collection)
    expect(tools.find((tool) => tool.name === 'open_graph')!.description).toContain(collection)
  })

  it('returns structured scan results and readable errors', async () => {
    const root = await makeRoot(['服装/EX1/g1.jpg', '模特/EX1/m1.jpg'])
    const client = await connect()
    const scan = await client.callTool({ name: 'scan', arguments: { sourceRoot: root } })
    expect(scan.structuredContent).toEqual(JSON.parse(JSON.stringify(await scanTool({ sourceRoot: root }))))
    const status = await client.callTool({ name: 'run_status', arguments: { sourceRoot: root } })
    expect(status.isError).toBe(true)
    expect((status.content as { text: string }[])[0]!.text).toMatch(/^NOT_FOUND:/)
  })

  it('keeps the background run going after the server exits', async () => {
    const root = await makeRoot(['服装/EX1/g1.jpg', '模特/EX1/m1.jpg', '模特/EX1/m2.jpg'])
    const client = await connect({ FASHION_TRYON_FAKE_ENGINE: JSON.stringify({ delayMs: 600 }) })
    const result = await client.callTool({ name: 'start_run', arguments: { sourceRoot: root, open: false } })
    expect(result.isError).toBeFalsy()
    const { runDir, runId } = result.structuredContent as { runDir: string; runId: string }
    expect(runId).toMatch(/^\d{8}-\d{6}$/)
    await client.close()
    const deadline = Date.now() + 15_000
    const { pid } = await readRunRecord(runDir)
    let status = (await readRunRecord(runDir)).status
    while (status === 'running' && Date.now() < deadline) {
      await sleep(200)
      status = (await readRunRecord(runDir)).status
    }
    expect(status).toBe('completed')
    expect((await readdir(path.join(root, '成图', 'EX1'))).sort()).toEqual(['m1.png', 'm2.png'])
    // 状态写成 completed 后子进程还会收尾（日志、锁）；等它退出再清理临时目录
    while (pid !== null && isProcessAlive(pid) && Date.now() < deadline + 5000) await sleep(100)
  })

  it('keeps the MCP SDK out of core modules', async () => {
    const offenders: string[] = []
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) await walk(full)
        else if ((await readFile(full, 'utf8')).includes('@modelcontextprotocol')) offenders.push(full)
      }
    }
    for (const dir of ['src/simple', 'src/studio', 'src/prepare', 'src/providers']) await walk(path.resolve(dir))
    expect(offenders).toEqual([])
    const cli = await readFile(path.resolve('src/cli.ts'), 'utf8')
    expect(cli).not.toMatch(/^import .*\.\/mcp\//m)
  })
})
