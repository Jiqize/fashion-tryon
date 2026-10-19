import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Command, CommanderError, InvalidArgumentError } from 'commander'
import { config as loadDotenv } from 'dotenv'

import {
  loadRunnerConfig,
  requireApimartConfig,
  requireDashscopeConfig,
  type RunnerConfig,
} from './config.js'
import { RunnerError, exitCodeFor, redactSecrets } from './errors.js'
import type { ImageGenerationPort, VisionPort } from './ports.js'
import { createApimartAdapter } from './providers/apimart.js'
import { createDashscopeAdapter } from './providers/dashscope.js'
import { writeLastRoot } from './editor/last-root.js'
import { addProject } from './editor/projects.js'
import { editorPageUrl, startEditorServer } from './editor/server.js'
import { applyCropPlan, parseCropPlan } from './simple/crop.js'
import { createApimartGenerator, createCodexGenerator, createFakeGenerator, type SimpleGenerator } from './simple/generators.js'
import { RUN_ID_PATTERN } from './simple/record.js'
import { parseRerunPlan } from './simple/rerun.js'
import { DEFAULT_MAX_REFERENCES, runSimple } from './simple/run.js'
import { batchCounts, groupStatus } from './studio/model.js'
import { startStudioServer } from './studio/server.js'
import { readBatchState } from './studio/store.js'

export interface CliIo {
  stdout(text: string): void
  stderr(text: string): void
}

export interface CliDeps {
  env?: NodeJS.ProcessEnv
  vision?: VisionPort
  imageGeneration?: ImageGenerationPort
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  /** 打开浏览器；测试注入以免真的打开 */
  openUrl?: (url: string) => void
  /** run 命令的出图引擎；测试注入假引擎 */
  simpleGenerator?: SimpleGenerator
}

interface CommandOutcome {
  code: 0 | 1 | 2
  result: Record<string, unknown>
}

interface ErrorContext {
  command?: string
}

function integerOption(min: number, max: number): (value: string) => number {
  return (value) => {
    const parsed = Number(value)
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      throw new InvalidArgumentError(`expected an integer from ${String(min)} to ${String(max)}`)
    }
    return parsed
  }
}

function normalizedError(error: unknown): RunnerError {
  if (error instanceof RunnerError) {
    return new RunnerError(error.code, redactSecrets(error.message), {
      retryable: error.retryable,
      cause: error,
    })
  }
  if (error instanceof CommanderError) {
    return new RunnerError('VALIDATION_ERROR', redactSecrets(error.message), { cause: error })
  }
  const message = error instanceof Error ? error.message : String(error)
  return new RunnerError('IO_ERROR', redactSecrets(message), { cause: error })
}

function lazyVision(config: RunnerConfig, deps: CliDeps): VisionPort {
  if (deps.vision !== undefined) return deps.vision
  let adapter: VisionPort | undefined
  const get = (): VisionPort => {
    adapter ??= createDashscopeAdapter(
      requireDashscopeConfig(config),
      deps.fetchImpl ?? fetch,
    )
    return adapter
  }
  return {
    locateGarment: (request, signal) => get().locateGarment(request, signal),
    brief: (request, signal) => get().brief(request, signal),
  }
}

function lazyImageGeneration(config: RunnerConfig, deps: CliDeps): ImageGenerationPort {
  if (deps.imageGeneration !== undefined) return deps.imageGeneration
  let adapter: ImageGenerationPort | undefined
  return {
    generate(request, signal, checkpoint) {
      adapter ??= createApimartAdapter(
        requireApimartConfig(config),
        deps.fetchImpl ?? fetch,
      )
      return adapter.generate(request, signal, checkpoint)
    },
  }
}

/** 用系统浏览器打开页面；失败只忽略（URL 已输出在 stdout）。 */
function openInBrowser(url: string): void {
  const [command, args] = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]]
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.on('error', () => undefined)
    child.unref()
  } catch {
    // 打不开浏览器不影响服务
  }
}

/** 等到中止信号（SIGINT/SIGTERM）；没有信号时一直常驻。 */
function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal === undefined) return
    if (signal.aborted) {
      resolve()
      return
    }
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

function emit(io: CliIo, outcome: CommandOutcome, json: boolean): void {
  if (json) {
    io.stdout(`${JSON.stringify(outcome.result)}\n`)
    return
  }
  const status = String(outcome.result.status ?? (outcome.code === 0 ? 'completed' : 'error'))
  io.stdout(`${String(outcome.result.command ?? 'fashion-tryon')}: ${status}\n`)
  for (const key of ['url', 'batchDir', 'report']) {
    const value = outcome.result[key]
    if (typeof value === 'string') io.stdout(`${key}: ${value}\n`)
  }
}

function errorOutcome(error: unknown, context: ErrorContext): CommandOutcome {
  const normalized = normalizedError(error)
  const code = exitCodeFor(normalized)
  return {
    code,
    result: {
      ok: false,
      command: context.command ?? 'unknown',
      status: code === 2
        ? normalized.code === 'NEEDS_APPROVAL' ? 'needs_approval' : 'needs_input'
        : normalized.code === 'ABORTED' ? 'interrupted' : 'error',
      error: normalized.toJSON(),
    },
  }
}

export async function runCli(
  argv: string[],
  io: CliIo,
  deps: CliDeps = {},
): Promise<number> {
  const jsonRequested = argv.includes('--json')
  const context: ErrorContext = {}
  let outcome: CommandOutcome | undefined
  let outcomeEmitted = false
  const program = new Command()
    .name('fashion-tryon')
    .description('Local folder-driven batch fashion try-on runner')
    .version('0.1.0')
    .exitOverride()
    .showHelpAfterError(false)
    .configureOutput({
      writeOut: (text) => (jsonRequested ? io.stderr(text) : io.stdout(text)),
      writeErr: (text) => io.stderr(text),
    })

  // run 与 rerun 共用的引擎选择
  const simpleGeneratorFor = (engine: string): SimpleGenerator => {
    if (deps.simpleGenerator !== undefined) return deps.simpleGenerator
    const env = deps.env ?? process.env
    if (engine === 'codex') {
      const codexModel = env.CODEX_IMAGE_MODEL
      return createCodexGenerator(codexModel === undefined ? {} : { model: codexModel })
    }
    if (engine === 'apimart') {
      const config = loadRunnerConfig(env, {})
      if (config.imageModel === undefined) throw new RunnerError('CONFIG_ERROR', 'IMAGE_MODEL')
      return createApimartGenerator(lazyImageGeneration(config, deps), {
        model: config.imageModel,
        size: config.size,
      })
    }
    if (engine === 'fake' && env.FASHION_TRYON_FAKE_ENGINE !== undefined) {
      // 仅测试用：环境变量里给 { delayMs?, failOn? }
      return createFakeGenerator(JSON.parse(env.FASHION_TRYON_FAKE_ENGINE) as { delayMs?: number; failOn?: string })
    }
    throw new RunnerError('VALIDATION_ERROR', `Unknown engine: ${engine}`)
  }

  program
    .command('studio')
    .argument('<source-root>')
    .option('--port <n>', 'local port', integerOption(1, 65_535))
    .option('--no-open', 'do not open the browser')
    .option('--json')
    .action(async (sourceArgument: string, options: { port?: number; open: boolean; json?: boolean }) => {
      context.command = 'studio'
      const config = loadRunnerConfig(deps.env ?? process.env, {})
      // 生产 provider 缺配置时启动前就报错，避免页面里每套都准备失败
      if (deps.imageGeneration === undefined) {
        requireApimartConfig(config)
        if (config.imageModel === undefined) throw new RunnerError('CONFIG_ERROR', 'IMAGE_MODEL')
      }
      if (deps.vision === undefined) requireDashscopeConfig(config)
      if (deps.signal?.aborted === true) throw new RunnerError('ABORTED', 'Studio was aborted before start')
      const server = await startStudioServer({
        sourceRoot: sourceArgument,
        ...(options.port === undefined ? {} : { port: options.port }),
        deps: { vision: lazyVision(config, deps), images: lazyImageGeneration(config, deps) },
        ...(config.imagePriceCny === undefined ? {} : { imagePriceCny: config.imagePriceCny }),
      })
      // stdout 首行固定为 { url, batchDir }，Agent 读这一行即可
      io.stdout(`${JSON.stringify({ url: server.url, batchDir: server.batchDir })}\n`)
      outcomeEmitted = true
      outcome = { code: 0, result: { ok: true, command: 'studio', url: server.url, batchDir: server.batchDir } }
      if (options.open) (deps.openUrl ?? openInBrowser)(server.url)
      await waitForAbort(deps.signal)
      await server.close()
    })

  program
    .command('run')
    .description('每张模特照出一张图（同款全部服装图作参考），写进 成图/ 并生成报告')
    .argument('<source-root>')
    .option('--engine <engine>', 'codex | apimart', 'codex')
    .option('--max-refs <n>', 'max garment references per group', integerOption(1, 10), DEFAULT_MAX_REFERENCES)
    .option('--swap <mode>', 'outfit: 换整套和鞋 | top: 只换上衣，下装和鞋保留模特原样', 'outfit')
    .option('--sku <skus...>', 'only run these 款号')
    .option('--run-id <id>', 'run id (YYYYMMDD-HHMMSS); default: current time')
    .option('--no-open', 'do not open the report')
    .option('--json')
    .action(async (
      sourceArgument: string,
      options: { engine: string; maxRefs: number; swap: string; sku?: string[]; runId?: string; open: boolean; json?: boolean },
    ) => {
      context.command = 'run'
      if (options.swap !== 'outfit' && options.swap !== 'top') {
        throw new RunnerError('VALIDATION_ERROR', `Unknown swap mode: ${options.swap}`)
      }
      if (options.runId !== undefined && !RUN_ID_PATTERN.test(options.runId)) {
        throw new RunnerError('VALIDATION_ERROR', `--run-id 格式应为 YYYYMMDD-HHMMSS：${options.runId}`)
      }
      const swap = options.swap
      const generator = simpleGeneratorFor(options.engine)
      const result = await runSimple({
        sourceRoot: sourceArgument,
        generator,
        maxReferences: options.maxRefs,
        swap,
        ...(options.sku === undefined ? {} : { skus: options.sku }),
        ...(options.runId === undefined ? {} : { runId: options.runId }),
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
        // 进度写 stderr，stdout 只留最后一行结果
        onProgress: (line) => io.stderr(`${line}\n`),
      })
      outcome = {
        code: result.status === 'completed' ? 0 : 1,
        result: {
          ok: result.status === 'completed',
          command: 'run',
          status: result.status,
          runId: result.runId,
          engine: result.engine,
          report: result.reportPath,
          graph: result.graphPath,
          runDir: result.runDir,
          counts: result.counts,
        },
      }
      if (options.open) (deps.openUrl ?? openInBrowser)(result.reportPath)
    })

  program
    .command('rerun')
    .description('按重出计划只重出选中的图，新建一个 run；MCP 与节点图页面在后台调用')
    .argument('<source-root>')
    .requiredOption('--plan <file>', 'rerun plan JSON (RerunPlan)')
    .requiredOption('--run-id <id>', 'run id (YYYYMMDD-HHMMSS)')
    .option('--engine <engine>', 'codex | apimart; default: the plan engine')
    .option('--no-open', 'do not open the report')
    .option('--json')
    .action(async (sourceArgument: string, options: { plan: string; runId: string; engine?: string; open: boolean }) => {
      context.command = 'rerun'
      if (!RUN_ID_PATTERN.test(options.runId)) {
        throw new RunnerError('VALIDATION_ERROR', `--run-id 格式应为 YYYYMMDD-HHMMSS：${options.runId}`)
      }
      let raw: unknown
      try {
        raw = JSON.parse(await readFile(options.plan, 'utf8'))
      } catch (error) {
        throw new RunnerError('VALIDATION_ERROR', `读不了重出计划：${options.plan}`, { cause: error })
      }
      const plan = parseRerunPlan(raw)
      const result = await runSimple({
        sourceRoot: sourceArgument,
        generator: simpleGeneratorFor(options.engine ?? plan.engine),
        maxReferences: plan.maxReferences,
        planned: plan.groups,
        ...(plan.fromRunId === undefined ? {} : { derivedFrom: plan.fromRunId }),
        runId: options.runId,
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
        onProgress: (line) => io.stderr(`${line}\n`),
      })
      outcome = {
        code: result.status === 'completed' ? 0 : 1,
        result: {
          ok: result.status === 'completed',
          command: 'rerun',
          status: result.status,
          runId: result.runId,
          derivedFrom: result.derivedFrom,
          engine: result.engine,
          report: result.reportPath,
          graph: result.graphPath,
          runDir: result.runDir,
          counts: result.counts,
        },
      }
      if (options.open) (deps.openUrl ?? openInBrowser)(result.reportPath)
    })

  program
    .command('editor')
    .description('运行可编辑节点图的本机服务（只监听 127.0.0.1，Ctrl+C 退出）')
    .argument('<source-root>')
    .option('--port <n>', 'local port', integerOption(1, 65_535))
    .option('--run-id <id>', 'open this run; default: the latest run')
    .option('--no-open', 'do not open the browser')
    .option('--json')
    .action(async (sourceArgument: string, options: { port?: number; runId?: string; open: boolean }) => {
      context.command = 'editor'
      if (options.runId !== undefined && !RUN_ID_PATTERN.test(options.runId)) {
        throw new RunnerError('VALIDATION_ERROR', `--run-id 格式应为 YYYYMMDD-HHMMSS：${options.runId}`)
      }
      const entry = process.argv[1]
      if (entry === undefined) throw new RunnerError('CONFIG_ERROR', '找不到 fashion-tryon 入口')
      const server = await startEditorServer({
        sourceRoot: sourceArgument,
        ...(options.port === undefined ? {} : { port: options.port }),
        // 重出的后台进程与 mcp 相同：带上 execArgv，用 tsx 运行时也能加载 TypeScript
        launch: { cliCommand: [process.execPath, ...process.execArgv, realpathSync(entry)], env: deps.env ?? process.env },
      })
      // 加入项目列表（open、open_graph、start_run 拉起的目录都经这里）；列表写不了只警告，不影响编辑服务
      await addProject(deps.env ?? process.env, sourceArgument).catch((error: unknown) => {
        io.stderr(`警告：没能加入项目列表：${redactSecrets(error instanceof Error ? error.message : String(error))}\n`)
      })
      const url = options.runId === undefined ? server.url : editorPageUrl(server.origin, server.token, options.runId)
      // stdout 首行固定为 { url, origin }
      io.stdout(`${JSON.stringify({ url, origin: server.origin })}\n`)
      outcomeEmitted = true
      outcome = { code: 0, result: { ok: true, command: 'editor', status: 'completed' } }
      if (options.open) (deps.openUrl ?? openInBrowser)(url)
      await waitForAbort(deps.signal)
      await server.close()
    })

  program
    .command('hub')
    .description('运行项目页服务（只监听 127.0.0.1，Ctrl+C 退出）')
    .option('--port <n>', 'local port', integerOption(1, 65_535))
    .option('--no-open', 'do not open the browser')
    .option('--json')
    .action(async (options: { port?: number; open: boolean }) => {
      context.command = 'hub'
      const entry = process.argv[1]
      if (entry === undefined) throw new RunnerError('CONFIG_ERROR', '找不到 fashion-tryon 入口')
      const { startHubServer } = await import('./editor/hub-server.js')
      const server = await startHubServer({
        ...(options.port === undefined ? {} : { port: options.port }),
        launch: { cliCommand: [process.execPath, ...process.execArgv, realpathSync(entry)], env: deps.env ?? process.env },
      })
      // stdout 首行固定为 { url, origin }
      io.stdout(`${JSON.stringify({ url: server.url, origin: server.origin })}\n`)
      outcomeEmitted = true
      outcome = { code: 0, result: { ok: true, command: 'hub', status: 'completed' } }
      if (options.open) (deps.openUrl ?? openInBrowser)(server.url)
      await waitForAbort(deps.signal)
      await server.close()
    })

  program
    .command('open')
    .description('不给目录时打开项目页；给目录时打开它的合集页并加入项目列表。服务在跑就复用，否则在后台拉起')
    .argument('[source-root]')
    .option('--no-open', 'do not open the browser')
    .option('--json')
    .action(async (sourceArgument: string | undefined, options: { open: boolean }) => {
      context.command = 'open'
      const env = deps.env ?? process.env
      const entry = process.argv[1]
      if (entry === undefined) throw new RunnerError('CONFIG_ERROR', '找不到 fashion-tryon 入口')
      const launch = { cliCommand: [process.execPath, ...process.execArgv, realpathSync(entry)], env }
      const openUrl = deps.openUrl ?? openInBrowser
      if (sourceArgument === undefined) {
        const { ensureHub } = await import('./editor/hub-launch.js')
        const { hubPageUrl } = await import('./editor/hub-server.js')
        const hub = await ensureHub(launch)
        const url = hubPageUrl(hub.origin, hub.token)
        if (options.open) openUrl(url)
        outcome = { code: 0, result: { ok: true, command: 'open', status: 'completed', url } }
        return
      }
      const sourceRoot = path.resolve(sourceArgument)
      const { openGraphTool } = await import('./mcp/tools.js')
      const { url } = await openGraphTool({ sourceRoot, open: options.open }, { ...launch, openUrl })
      await addProject(env, sourceRoot).catch((error: unknown) => {
        io.stderr(`警告：没能加入项目列表：${redactSecrets(error instanceof Error ? error.message : String(error))}\n`)
      })
      await writeLastRoot(env, sourceRoot)
      outcome = { code: 0, result: { ok: true, command: 'open', status: 'completed', sourceRoot, url } }
    })

  program
    .command('crop')
    .description('按裁切方案从服装原图裁出参考图，写到 裁图/<款号>/；run 会优先用这些裁图')
    .argument('<source-root>')
    .requiredOption('--plan <file>', 'crop plan JSON: { "<款号>": [{ "from", "role", "box"? }] }')
    .option('--replace', 'replace existing crops of the planned groups')
    .option('--json')
    .action(async (sourceArgument: string, options: { plan: string; replace?: boolean }) => {
      context.command = 'crop'
      let raw: unknown
      try {
        raw = JSON.parse(await readFile(options.plan, 'utf8'))
      } catch (error) {
        throw new RunnerError('VALIDATION_ERROR', `读不了裁切方案：${options.plan}`, { cause: error })
      }
      const groups = await applyCropPlan(sourceArgument, parseCropPlan(raw), { replace: options.replace === true })
      outcome = { code: 0, result: { ok: true, command: 'crop', status: 'completed', groups } }
    })

  program
    .command('mcp')
    .description('运行本机 stdio MCP 服务')
    .action(async () => {
      context.command = 'mcp'
      // stdout 归 MCP 协议，结束时不再输出结果行
      outcomeEmitted = true
      const entry = process.argv[1]
      if (entry === undefined) throw new RunnerError('CONFIG_ERROR', '找不到 fashion-tryon 入口')
      const { serveStdio } = await import('./mcp/server.js')
      await serveStdio({
        // 带上 execArgv：用 tsx 运行时后台子进程同样能加载 TypeScript
        cliCommand: [process.execPath, ...process.execArgv, realpathSync(entry)],
        env: deps.env ?? process.env,
        openUrl: deps.openUrl ?? openInBrowser,
      })
      outcome = { code: 0, result: { ok: true, command: 'mcp', status: 'completed' } }
    })

  program
    .command('status')
    .argument('<source-root>')
    .option('--json')
    .action(async (sourceArgument: string) => {
      context.command = 'status'
      // 不加锁，只读 studio.json：服务运行中也能查询
      const { dir, state } = await readBatchState(sourceArgument)
      outcome = {
        code: 0,
        result: {
          ok: true,
          command: 'status',
          batchDir: dir,
          counts: batchCounts(state),
          groups: [...state.groups]
            .sort((left, right) => left.order - right.order)
            .map((group) => ({ sku: group.sku, status: groupStatus(state, group.id) })),
        },
      }
    })

  try {
    await program.parseAsync(['node', 'fashion-tryon', ...argv])
    if (outcome === undefined) {
      outcome = errorOutcome(
        new RunnerError('VALIDATION_ERROR', 'A command is required'),
        context,
      )
    }
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) {
      if (!jsonRequested) return 0
      outcome = {
        code: 0,
        result: { ok: true, command: 'help', status: 'completed' },
      }
      emit(io, outcome, true)
      return 0
    }
    outcome = errorOutcome(error, context)
    const serialized = outcome.result.error as { code?: string; message?: string } | undefined
    if (serialized !== undefined) {
      io.stderr(`${serialized.code ?? 'ERROR'}: ${serialized.message ?? 'Command failed'}\n`)
    }
  }
  if (!outcomeEmitted) emit(io, outcome, jsonRequested)
  return outcome.code
}

/** 包根目录：dist/cli.mjs 或 src/cli.ts 的上一级。 */
function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
}

/** 先按当前目录、再按包根目录加载 .env.local / .env；shell 环境始终优先。 */
export function loadEnvironmentFiles(): void {
  const roots = [process.cwd(), packageRoot()]
  for (const root of [...new Set(roots)]) {
    for (const name of ['.env.local', '.env']) {
      loadDotenv({ path: path.join(root, name), override: false, quiet: true })
    }
  }
}

async function main(): Promise<void> {
  loadEnvironmentFiles()
  const controller = new AbortController()
  const requestAbort = (): void => {
    if (!controller.signal.aborted) {
      process.stderr.write('Abort requested; settling run state...\n')
      controller.abort()
    }
  }
  process.once('SIGINT', requestAbort)
  process.once('SIGTERM', requestAbort)
  try {
    process.exitCode = await runCli(process.argv.slice(2), {
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
    }, { signal: controller.signal, env: process.env })
  } finally {
    process.removeListener('SIGINT', requestAbort)
    process.removeListener('SIGTERM', requestAbort)
  }
}

const invokedPath = process.argv[1]
if (
  invokedPath !== undefined &&
  realpathSync(fileURLToPath(import.meta.url)) === realpathSync(invokedPath)
) {
  void main()
}
