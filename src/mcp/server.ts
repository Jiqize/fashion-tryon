import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { RunnerError, redactSecrets } from '../errors.js'
import {
  cancelRunTool,
  cropTool,
  listRunsTool,
  openGraphTool,
  rerunTool,
  runStatusTool,
  scanTool,
  startRunTool,
  type LaunchConfig,
} from './tools.js'

// 本机 stdio MCP 服务：注册各工具；stdout 只给协议用，日志一律写 stderr

const HUMAN_GATE = '人是唯一的质量关口：不要替用户判断成图好坏，把图或节点图交给用户看。'

const sourceRoot = z.string().describe('素材根目录绝对路径')
const runId = z.string().describe('出图编号 runId（YYYYMMDD-HHMMSS）')

const DESCRIPTIONS = {
  scan: `扫描素材根目录（只读，不写任何文件）。返回每款的款号、服装图、模特图、裁图/<款号>/ 里已有的裁图，缺服装图或模特图的款带 note。所有路径都是绝对路径，可以直接打开图片看。${HUMAN_GATE}`,
  crop: [
    '按裁切方案从服装原图裁出参考图，写到 <素材根目录>/裁图/<款号>/；start_run 会优先用裁图。',
    '先逐张打开服装图看清楚再写方案。方案格式：{ "<款号>": [{ "from": "<服装图文件名>", "role": "<用途名>", "box"?: [x0,y0,x1,y1] }] }，box 是千分比，不写 box 表示用整张图。',
    '每款 4–5 张：`全身-正面`、`半身-正面` 各一张（不写 box）；2–3 张 `细节-<部位>`（领口/印花/面料/下摆/袖口/口袋）；有背面或侧面图时加 `背面`/`侧面`。',
    '裁完逐张打开返回的路径检查；不对就改 box，用 replace: true 重裁（不加 replace 时已有裁图保留并报错）。',
    HUMAN_GATE,
  ].join('\n'),
  start_run: [
    '开始后台出图并立即返回 runId、run 目录、节点图 graph 路径和计划张数；出图在独立进程进行，会话结束也不会中断。',
    '每张模特图出一张成图，交付到 成图/<款号>/，从不覆盖已有文件（同名加 -v2、-v3）。Codex 出一张约 2–3 分钟。',
    '换装范围 swap：默认 "outfit"（换整套和鞋）；单件上衣或模特多为半身时用 "top"（只换上衣，保留模特下装和鞋）。不同范围的款分开跑，用 skus 指定款号。',
    '引擎 engine 默认 codex；"apimart" 会产生真实费用，只有用户明确要求时才用。',
    '同一素材目录同时只能跑一个出图，已有出图在跑时会被拒绝并返回正在跑的 runId。',
    '开始后把 editorUrl（可编辑节点图，拉起失败时为 graph 节点图路径）告诉用户（默认已在浏览器打开），之后用 run_status 查进度。',
    '按合集页保存的搭配规则出图；用户想放图、挑图、看成图时用 open_graph 打开合集页。',
    HUMAN_GATE,
  ].join('\n'),
  rerun: [
    '只重出有问题的那几张：从一次已有的出图（fromRunId）里挑图（款号 + 模特图），新建一个 run 在后台出，其余图不动。返回与 start_run 相同，另给来源 derivedFrom。',
    '固定模特、一对一的出图组合在 shots 里再给 item（这个组合的衣服图），只重出该组合。',
    '可以先用 run_status 读每款当前的参考图、提示词和换装范围，再在 groups 里按款改：references（按顺序，文件 + 用途名）、prompt（提示词全文）、swap；没给的沿用来源 run。',
    '参考图带模特脸会把成图带偏：先用 crop 把脸裁掉（裁出不含脸的 全身-正面 等），再把新裁图放进 references 重出。',
    '交付规则同 start_run：写入 成图/<款号>/，同名加 -v2、-v3，从不覆盖。同一素材目录同时只能跑一个出图。',
    '引擎 engine 默认 codex；"apimart" 会产生真实费用，只有用户明确要求时才用。人工改的提示词只用于这一次。',
    HUMAN_GATE,
  ].join('\n'),
  run_status: `查一次出图的进度（只读，进行中也能查）：整体状态、计数、当前正在出的那张、每张的状态，已完成的给成图与交付路径，失败的给原因；每款还给出本次使用的参考图、提示词（promptEdited 表示人工改过）和换装范围，供 rerun 前读取。不给 runId 时取最近一次。${HUMAN_GATE}`,
  cancel_run: `取消正在进行的出图：立即停止，正在出的那张放弃（不写入 成图/），已交付的图保留，未开始的标为已取消。对已结束的出图调用时只返回当前状态。${HUMAN_GATE}`,
  open_graph: `打开一次出图的可编辑节点图（必要时在本机拉起编辑服务，只监听 127.0.0.1），返回页面地址。用户可以在页面里改每款的参考图、提示词、换装范围和模特图，勾选要重出的图直接重出。不给 runId 时打开合集页。用户想自己放图、挑图时，用 open_graph 打开页面，不必在对话里一张张传。按合集页保存的搭配规则出图；用户想放图、挑图、看成图时用 open_graph 打开合集页。${HUMAN_GATE}`,
  list_runs: `列出这个素材目录的历史出图（只读），按时间倒序，含参数、整体状态、计数、节点图与报告页路径。${HUMAN_GATE}`,
} as const

function ok(value: object): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  }
}

function failure(error: unknown): CallToolResult {
  const normalized = error instanceof RunnerError
    ? error
    : new RunnerError('IO_ERROR', error instanceof Error ? error.message : String(error))
  const message = redactSecrets(normalized.message)
  return {
    isError: true,
    content: [{ type: 'text', text: `${normalized.code}: ${message}` }],
    structuredContent: { error: { code: normalized.code, message, retryable: normalized.retryable } },
  }
}

async function handle(run: () => Promise<object>): Promise<CallToolResult> {
  try {
    return ok(await run())
  } catch (error) {
    return failure(error)
  }
}

export function createMcpServer(config: LaunchConfig): McpServer {
  const server = new McpServer({ name: 'fashion-tryon', version: '0.1.0' })

  server.registerTool('scan', {
    description: DESCRIPTIONS.scan,
    inputSchema: { sourceRoot },
    annotations: { readOnlyHint: true },
  }, (input) => handle(() => scanTool(input)))

  server.registerTool('crop', {
    description: DESCRIPTIONS.crop,
    inputSchema: {
      sourceRoot,
      plan: z.record(z.string(), z.array(z.object({
        from: z.string(),
        role: z.string(),
        box: z.array(z.number()).length(4).optional(),
      }))).describe('裁切方案：{ "<款号>": [{ from, role, box? }] }'),
      replace: z.boolean().optional().describe('替换这些款已有的裁图'),
    },
  }, (input) => handle(() => cropTool(input)))

  server.registerTool('start_run', {
    description: DESCRIPTIONS.start_run,
    inputSchema: {
      sourceRoot,
      swap: z.enum(['outfit', 'top']).optional().describe('换装范围，默认 outfit'),
      skus: z.array(z.string()).optional().describe('只跑这些款号；不给则跑全部'),
      maxReferences: z.number().int().min(1).max(10).optional().describe('每款最多参考图数，默认 6'),
      engine: z.enum(['codex', 'apimart']).optional().describe('默认 codex；apimart 产生真实费用'),
      open: z.boolean().optional().describe('是否在浏览器打开节点图，默认打开'),
    },
  }, (input) => handle(() => startRunTool(input, config)))

  server.registerTool('rerun', {
    description: DESCRIPTIONS.rerun,
    inputSchema: {
      sourceRoot,
      fromRunId: runId.describe('来源出图编号'),
      shots: z.array(z.object({
        sku: z.string(),
        model: z.string().describe('模特图路径（绝对或相对素材根目录）'),
        item: z.string().optional().describe('衣服图路径（绝对或相对素材根目录）；只有固定模特、一对一的出图组合才给'),
      })).describe('要重出的图'),
      groups: z.record(z.string(), z.object({
        references: z.array(z.object({
          file: z.string().describe('服装原图或 裁图/<款号>/ 下的图（绝对或相对素材根目录）'),
          role: z.string().optional().describe('用途名，如 全身-正面、细节-领口'),
        })).optional(),
        prompt: z.string().optional().describe('提示词全文'),
        swap: z.enum(['outfit', 'top']).optional(),
      })).optional().describe('按款号的修改；没给的沿用来源 run'),
      engine: z.enum(['codex', 'apimart']).optional().describe('默认 codex；apimart 产生真实费用'),
      maxReferences: z.number().int().min(1).max(10).optional().describe('参考图上限，默认沿用来源 run'),
      open: z.boolean().optional().describe('是否在浏览器打开节点图，默认打开'),
    },
  }, (input) => handle(() => rerunTool(input, config)))

  server.registerTool('run_status', {
    description: DESCRIPTIONS.run_status,
    inputSchema: { sourceRoot, runId: runId.optional() },
    annotations: { readOnlyHint: true },
  }, (input) => handle(() => runStatusTool(input)))

  server.registerTool('cancel_run', {
    description: DESCRIPTIONS.cancel_run,
    inputSchema: { sourceRoot, runId },
    annotations: { destructiveHint: false },
  }, (input) => handle(() => cancelRunTool(input)))

  server.registerTool('open_graph', {
    description: DESCRIPTIONS.open_graph,
    inputSchema: {
      sourceRoot,
      runId: runId.optional(),
      open: z.boolean().optional().describe('是否在浏览器打开，默认打开'),
    },
  }, (input) => handle(() => openGraphTool(input, config)))

  server.registerTool('list_runs', {
    description: DESCRIPTIONS.list_runs,
    inputSchema: { sourceRoot },
    annotations: { readOnlyHint: true },
  }, (input) => handle(() => listRunsTool(input)))

  return server
}

/** 连接 stdio，直到宿主关闭 stdin。 */
export async function serveStdio(config: LaunchConfig): Promise<void> {
  const server = createMcpServer(config)
  const transport = new StdioServerTransport()
  const closed = new Promise<void>((resolve) => {
    transport.onclose = () => resolve()
    process.stdin.once('end', () => { void server.close().finally(resolve) })
  })
  await server.connect(transport)
  process.stderr.write('fashion-tryon MCP 已就绪（stdio）\n')
  await closed
}
