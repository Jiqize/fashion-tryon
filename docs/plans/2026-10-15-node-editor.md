# 可编辑节点编辑器 Implementation Plan

**Goal:** 节点图可在本机服务下编辑每款的参考图、提示词、换装范围与模特图，并只重出勾选的图；MCP 提供同样的 `rerun` 与 `open_graph`。
**Architecture:** 重出的校验与计划生成集中在 `src/simple/rerun.ts`，页面（经本机编辑服务）与 MCP 都调它，再由新 CLI 命令 `rerun` 在 detached 子进程里执行（复用 `runSimple` 的执行段）。编辑服务 `src/editor/server.ts` 只监听 127.0.0.1，按素材根目录一个进程，闲置 30 分钟退出；节点图页面在 http 下加载 `ui/editor.js` 获得编辑能力，file:// 下保持只读。
**Tech Stack:** Node 20+、TypeScript、node:http、sharp、zod、@modelcontextprotocol/sdk、Vitest、Playwright。

## Global Constraints

- spec：`docs/specs/2026-10-15-node-editor.md`（已确认）；与 spec 冲突时先停下问用户。
- 默认测试全部用假引擎（`FASHION_TRYON_FAKE_ENGINE`），不产生费用；真实引擎只在 Task 10 冒烟。
- 不新增依赖。代码注释中文，标识符英文。
- 每次重出新建一个 run（新 runId），不追加到来源 run；来源 run 的 `run.json` 不改。
- 人工修改的提示词只用于这一次重出；`start_run` 默认提示词不变。
- 页面「移除参考图」不删 `裁图/` 里的文件。不删除任何服装原图、裁图或成图文件。
- 编辑服务只监听 `127.0.0.1`；闲置 30 分钟（`IDLE_EXIT_MS = 1_800_000`）自动退出；进行中的出图不受影响。
- 交付规则不变：写入 `成图/<款号>/`，同名加 `-v2`、`-v3`，从不覆盖。同一素材根目录同时只跑一个出图（沿用 `.lock`）。
- `start_run` 默认的提示词、参考图选取、交付行为与 MCP 阶段字节级一致（现有测试全部保持通过）。
- 页面与接口返回、`run.json`、日志不含密钥；错误文案不带出素材根目录以外的绝对路径。
- 文案：只读提示 `只读页面：要编辑请让 Agent 调用 open_graph，或运行 fashion-tryon editor <素材根目录>`；提示词标记 `已改`、按钮 `恢复默认`；图号提示 `参考图已变，提示词里的图号可能对不上`；占用提示 `正在出图：<runId>`；费用提示 `会产生真实费用`，确认框 `apimart 会产生真实费用，确定用它重出吗？`；来源 `来自 <runId>`；未提交提示 `有未重出的修改，离开会丢失`；裁图同名确认 `裁图/<款号>/ 里已有「<用途>」，替换吗？`；超限 `参考图 <N> 张，超过上限 <M> 张`。

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/simple/prompt.ts`（改） | 新增按用途列表生成提示词 `buildPromptFromRoles`；`buildSimplePrompt` 改为调用它（输出不变） |
| `src/simple/record.ts`（改） | `RunGroup` 增 `swap`、`promptEdited`；`referenceSource` 增 `'custom'`；`RunRecord` 增 `derivedFrom`；读取时补默认值 |
| `src/simple/crop.ts`（改） | 抽出 `renderCrop` 共用裁切管线；新增单张裁图 `cropOne` |
| `src/simple/rerun.ts`（新） | 重出请求 schema、校验与计划生成 `buildRerunPlan`、默认提示词预览 |
| `src/simple/run.ts`（改） | `runSimple` 接受显式计划 `planned` 与 `derivedFrom`，执行段不变 |
| `src/cli.ts`（改） | 新增 `rerun`、`editor` 命令 |
| `src/mcp/launch.ts`（改） | `launchRerun`（写计划文件、拉起 `rerun` 子进程） |
| `src/mcp/tools.ts`、`src/mcp/server.ts`（改） | 新工具 `rerun`、`open_graph`；`run_status` / `list_runs` 增字段；`start_run` 打开可编辑页 |
| `src/editor/server.ts`（新） | 编辑服务：鉴权、静态与原图、编辑 API、闲置退出、会话文件 |
| `src/editor/launch.ts`（新） | 确保某素材根目录的编辑服务在运行（复用或拉起），返回页面地址 |
| `src/ui-dir.ts`（新） | 从 `src/studio/server.ts` 移出的 `findUiDir`，两个服务共用 |
| `src/simple/graph.ts`（改） | 只读提示、来源链接、每款换装范围、`custom` 标签、http 下加载编辑脚本 |
| `ui/editor.js`、`ui/editor.css`（新） | 编辑交互 |
| `tests/simple-prompt.test.ts`、`tests/simple-record.test.ts`、`tests/simple-crop.test.ts`、`tests/simple-rerun.test.ts`、`tests/editor-server.test.ts`、`tests/editor-launch.test.ts`、`tests/mcp-tools.test.ts`、`tests/mcp-server.test.ts`、`tests/simple-graph.browser.test.ts`、`tests/editor-ui.browser.test.ts` | 测试（已有文件追加用例） |
| `README.md`、`docs/USAGE.md`、`skills/fashion-tryon/SKILL.md`、`docs/COLLEAGUE_INSTALL_AND_REAL_TEST.md`、`tests/skill-contract.test.ts`、`scripts/create-colleague-package.mjs`（改） | 说明与打包 |

---

### Task 1: 提示词按用途生成与运行记录扩展

**Files:**
- Modify: `src/simple/prompt.ts`、`src/simple/record.ts`、`src/simple/run.ts`（写入新字段）
- Test: `tests/simple-prompt.test.ts`（无则新建）、`tests/simple-record.test.ts`

**Interfaces:**
- Produces（`prompt.ts`）：`buildPromptFromRoles(roles: (string | undefined)[], swap?: SwapMode): string`；`buildSimplePrompt(referenceFiles, swap)` 等价于 `buildPromptFromRoles(referenceFiles.map(f => referenceRole(path.basename(f))), swap)`。
- Produces（`record.ts`）：
  - `RunGroup` 增 `swap: SwapMode`、`promptEdited: boolean`；`referenceSource: 'crops' | 'originals' | 'custom'`
  - `RunRecord` 增 `derivedFrom: string | null`
  - `readRunRecord` 对缺字段的 v2 记录补：`derivedFrom = null`、`group.swap = params?.swap ?? 'outfit'`、`group.promptEdited = false`；旧格式归一同样补齐。

**Requirements:**
- `buildSimplePrompt` 对所有现有输入的输出与改动前逐字相同。
- `runSimple` 新写的记录里每款 `swap` 为本次 swap、`promptEdited: false`、`derivedFrom: null`。

**Test cases:**
- 现有提示词快照/断言全部不改即通过。
- `buildPromptFromRoles(['全身-正面', undefined], 'top')` 与 `buildSimplePrompt(['01-全身-正面.jpg', 'img1.webp'], 'top')` 相同。
- 读取一份无 `derivedFrom`、无 `group.swap` 的 v2 记录（params.swap = top）→ `derivedFrom: null`、每款 `swap: 'top'`、`promptEdited: false`。
- 旧格式记录 → 每款 `swap: 'outfit'`。

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：`npx vitest run tests/simple-prompt.test.ts tests/simple-record.test.ts`，新增用例失败
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**：同上命令全部通过，`npx tsc --noEmit` 无输出
- [x] **Step 5: Commit**
- 进展：2026-10-15 完成；`buildSimplePrompt` 改为调 `buildPromptFromRoles`，早期 v2 与旧格式记录读取时补 swap/promptEdited/derivedFrom；全量 253 通过、tsc 无输出

### Task 2: 单张裁图

**Files:**
- Modify: `src/simple/crop.ts`、`src/errors.ts`
- Test: `tests/simple-crop.test.ts`（无则新建；已有裁图测试所在文件则追加）

**Interfaces:**
- Produces：
  - `renderCrop(sourcePath: string, box?: [number, number, number, number]): Promise<Buffer>`（`applyCropPlan` 改用它，输出字节不变）
  - `cropOne(sourceRoot: string, sku: string, item: { from: string; role: string; box?: [number, number, number, number] }, options?: { replace?: boolean }): Promise<string>`，返回相对素材根目录的裁图路径
  - 错误码 `'CROP_EXISTS'`（加入 `runnerErrorCodes`）

**Requirements:**
- `from` 可为该款服装原图的文件名或相对路径，或 `裁图/<款号>/` 下已有裁图的相对路径（对已有裁图重新拖框时，框相对那张裁图）；其它路径抛 `VALIDATION_ERROR`，message `<款号> 没有这张图：<from>`。
- `role` 校验与裁切方案相同（1–40 字，不含 `/\:*?"<>|`），`box` 校验与裁切方案相同。
- 同用途判定：已有裁图文件名去掉开头序号后（`NN-`）等于 `role`。已有同用途且未给 `replace: true` → 抛 `CROP_EXISTS`，message `裁图/<款号>/ 里已有「<role>」，替换吗？`，不写文件；给了 `replace` → 写回原文件名。
- 无同用途时文件名为 `<NN>-<role>.jpg`，`NN` = 现有最大序号 + 1，两位补零；目录不存在时从 `01` 开始。
- 不删除、不改动该款其它裁图。

**Test cases:**
- 同一原图同一 box，`cropOne` 与 `applyCropPlan` 产出的文件字节相同。
- 已有 `01-全身-正面.jpg`、`02-细节-领口.jpg`，`cropOne(role: '背面')` → `裁图/<款号>/03-背面.jpg`，原两张字节不变。
- `cropOne(role: '细节-领口')` 不带 replace → `CROP_EXISTS` 且目录不变；带 replace → 写入 `02-细节-领口.jpg`，`01` 不变。
- `from: '裁图/<款号>/01-全身-正面.jpg'` 带 box → 成功。
- `from: '../外部.jpg'` → `VALIDATION_ERROR`。

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：`npx vitest run tests/simple-crop.test.ts`
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**：同上；`npx vitest run` 中现有 crop 相关用例仍通过
- [x] **Step 5: Commit**
- 进展：2026-10-15 完成；抽出 `renderCrop`（与改动前 `applyCropPlan` 输出逐字节一致，已临时对照验证），`cropOne` 先裁成 buffer 再写；全量通过

### Task 3: 重出计划与 `rerun` 命令

**Files:**
- Create: `src/simple/rerun.ts`
- Modify: `src/simple/run.ts`、`src/cli.ts`
- Test: `tests/simple-rerun.test.ts`

**Interfaces:**
- Consumes：Task 1 的 `buildPromptFromRoles`、`RunGroup.swap/promptEdited`、`RunRecord.derivedFrom`；`readRunRecord`、`scanSimple`、`listCrops`。
- Produces（`rerun.ts`）：
  - `interface RerunReference { file: string; role?: string }`（`file` 可为绝对路径或相对素材根目录）
  - `interface RerunGroupEdit { references?: RerunReference[]; prompt?: string; swap?: SwapMode }`
  - `interface RerunRequest { fromRunId: string; shots: { sku: string; model: string }[]; groups?: Record<string, RerunGroupEdit>; engine?: 'codex' | 'apimart'; maxReferences?: number }`
  - `parseRerunRequest(value: unknown): RerunRequest`（zod；格式错抛 `VALIDATION_ERROR`）
  - `interface PlannedGroup { sku: string; swap: SwapMode; references: { file: string; role?: string }[]; prompt: string; promptEdited: boolean; models: string[] }`（路径相对素材根目录，`/` 分隔）
  - `interface RerunPlan { fromRunId: string; engine: 'codex' | 'apimart' | 'fake'; maxReferences: number; groups: PlannedGroup[] }`
  - `buildRerunPlan(sourceRoot: string, request: RerunRequest, env?: NodeJS.ProcessEnv): Promise<RerunPlan>`
  - `defaultPrompt(references: { file: string; role?: string }[], swap: SwapMode): string`（= `buildPromptFromRoles(references.map(r => r.role ?? referenceRole(basename(r.file))), swap)`）
  - `currentSettings(record: RunRecord, group: RunGroup): { swap: SwapMode; references: { file: string; role?: string }[]; prompt: string; promptEdited: boolean }`
- Produces（`run.ts`）：`SimpleRunOptions` 增 `planned?: PlannedGroup[]`、`derivedFrom?: string`；给了 `planned` 时不扫描、按计划建组（`referenceSource: 'custom'`，`swap`/`prompt`/`promptEdited` 取计划），其余执行流程不变；`params` 记 `{ swap: 计划首款 swap, skus: 计划款号, maxReferences, engine }`。
- Produces（CLI）：`fashion-tryon rerun <source-root> --plan <file> --run-id <id> [--engine codex|apimart|fake] [--no-open] [--json]`，输出结果行与 `run` 相同。

**Requirements:**
- `fromRunId` 不匹配 `RUN_ID_PATTERN` → `VALIDATION_ERROR`；来源 run 不存在 → `NOT_FOUND`。
- `shots` 至少 1 张，否则 `VALIDATION_ERROR` `没有勾选要重出的图`；重复的 (sku, model) 去重。
- `sku` 必须是来源 run 里的款，否则 `VALIDATION_ERROR` `来源 run 里没有这个款号：<sku>`；`model` 必须是该款当前扫描到的模特图（允许来源 run 里没有的新模特图），否则 `VALIDATION_ERROR` `<款号> 没有这张模特图：<文件名>`。
- 每款设置：`swap = edit.swap ?? 来源款 swap`；`references = edit.references ?? 来源款 references（file、role）`；参考图必须是该款服装原图或 `裁图/<款号>/` 下现存文件，否则 `VALIDATION_ERROR` `<款号> 的参考图不可用：<文件名>`；至少 1 张。
- 上限 `maxReferences = request.maxReferences ?? 来源 params.maxReferences ?? 6`，取值 1–10；超过 → `VALIDATION_ERROR` `参考图 <N> 张，超过上限 <M> 张`。
- 提示词：给了 `edit.prompt` → 用它，`promptEdited = (edit.prompt !== defaultPrompt(references, swap))`；没给且未改参考图和 swap 且来源款 `promptEdited` → 沿用来源提示词，`promptEdited: true`；否则 `defaultPrompt`，`promptEdited: false`。
- 引擎：`request.engine ?? (env.FASHION_TRYON_FAKE_ENGINE !== undefined ? 'fake' : 'codex')`。
- 计划里款的顺序按来源 run 的款序，款内模特按扫描顺序。
- `rerun` 命令读计划文件（JSON 的 `RerunPlan`），以 `planned` 与 `derivedFrom = plan.fromRunId` 调 `runSimple`；锁、心跳、取消、交付与 `run` 相同。

**Test cases:**
- 来源 2 款 4 张，只请求 1 张 → 计划 1 款 1 个 model；执行后新 run `derivedFrom` 为来源 runId、`counts.planned = 1`，`成图/<款号>/` 多一个 `-v2`，其它文件字节不变。
- 无任何编辑时计划的 references、swap、prompt 与来源款相同，`promptEdited: false`，提示词与 `start_run` 默认一致。
- references 换序并改 role → `defaultPrompt` 的图号与用途随之变化。
- 给出与默认相同的 prompt → `promptEdited: false`；不同 → `true`，执行时假引擎收到的 prompt 与之逐字相同。
- swap 改为 top 且无 prompt → 提示词等于 `buildSimplePrompt(同参考图, 'top')`。
- 新模特图（来源 run 里没有）→ 计划包含它。
- 参考图 `../x.jpg` 或 `成图/...` → `VALIDATION_ERROR`；7 张、上限 6 → `参考图 7 张，超过上限 6 张`；未知款号、空 shots 各报对应错误。
- 执行 `rerun` 时同目录已有 run 在跑 → `RUN_IN_PROGRESS`。

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：`npx vitest run tests/simple-rerun.test.ts`
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**：同上；`npx vitest run tests/simple-run.test.ts tests/simple-record.test.ts` 仍通过
- [x] **Step 5: Commit**
- 进展：2026-10-15 完成；另加 `parseRerunPlan` 供 `rerun` 命令校验计划文件，`run`/`rerun` 共用 CLI 内的引擎选择；CLI 命令清单测试加入 `rerun`；全量 268 通过

### Task 4: MCP `rerun` 与查询字段

**Files:**
- Modify: `src/mcp/launch.ts`、`src/mcp/tools.ts`、`src/mcp/server.ts`
- Test: `tests/mcp-tools.test.ts`、`tests/mcp-server.test.ts`

**Interfaces:**
- Consumes：Task 3 的 `parseRerunRequest`、`buildRerunPlan`、`currentSettings`、CLI `rerun`。
- Produces：
  - `launchRerun(sourceRoot: string, plan: RerunPlan, config: LaunchConfig & { open?: boolean }): Promise<RunRecord>`：取新 runId，把计划写到 `<runDir>/rerun-plan.json`，拉起 `rerun <root> --plan <该文件> --run-id <id> --engine <plan.engine> --json --no-open`，等 `run.json` 出现（与 `launchRun` 相同的等待与报错）。
  - `rerunTool(input: { sourceRoot: string } & RerunRequest & { open?: boolean }, config: LaunchConfig): Promise<RunSummary>`
  - `RunSummary` 增 `derivedFrom: string | null`
  - `RunDetail.groups[]` 增 `swap`、`references: { file: string; role?: string }[]`（绝对路径）、`referenceSource`、`prompt`、`promptEdited`
- MCP 工具 `rerun` 输入：`sourceRoot`、`fromRunId`、`shots: { sku, model }[]`、`groups?: Record<sku, { references?: { file, role? }[]; prompt?: string; swap?: 'outfit'|'top' }>`、`engine?`、`maxReferences?`、`open?`。

**Requirements:**
- `rerunTool` 先做与 `startRunTool` 相同的根目录校验、占用检查（`RUN_IN_PROGRESS`，message `这个素材目录正在出图：<runId>`）、apimart 缺密钥检查，再 `buildRerunPlan`，出错时不创建 run。
- 返回在 2 秒内（与 `start_run` 相同的后台模式）。
- 工具说明包含：只重出有问题的那几张；可先 `run_status` 读每款当前参考图与提示词再改；参考图带模特脸会把成图带偏，先用 `crop` 把脸裁掉再重出；apimart 会产生真实费用；以及 `HUMAN_GATE`。
- `list_runs` 每条带 `derivedFrom`。

**Test cases:**
- 假引擎：`rerunTool` 只重出 1 张 → 返回 `derivedFrom`、`counts.planned = 1`；完成后 `run_status` 计数正确。
- `run_status` 每款返回 swap、参考图绝对路径、prompt、promptEdited。
- 进行中再调 `rerun` → `RUN_IN_PROGRESS` 并含正在跑的 runId。
- 同一份编辑分别经 `buildRerunPlan` 直接生成与经 `rerunTool` 落盘的 `rerun-plan.json` 完全相同。
- MCP 客户端 `listTools` 含 `rerun`（共 7 个，`open_graph` 在 Task 6 加入后为 8 个）。

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：`npx vitest run tests/mcp-tools.test.ts tests/mcp-server.test.ts`
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**：同上
- [x] **Step 5: Commit**
- 进展：2026-10-15 完成；`launchRun`/`launchRerun` 共用 `spawnAndWait`，占用与缺密钥检查抽成 `checkStartable`；`rerunTool` 输入类型放宽为由 `parseRerunRequest` 校验；全量 272 通过（曾有 1 次测试时序失败：完成后锁稍后才释放，测试改为等锁释放）

### Task 5: 编辑服务

**Files:**
- Create: `src/editor/server.ts`、`src/ui-dir.ts`
- Modify: `src/studio/server.ts`（改为从 `src/ui-dir.ts` 引入 `findUiDir`，行为不变）、`src/cli.ts`（`editor` 命令）
- Test: `tests/editor-server.test.ts`

**Interfaces:**
- Consumes：Task 2 `cropOne`；Task 3 `parseRerunRequest`、`defaultPrompt`、`currentSettings`；Task 4 `rerunTool`、`RunSummary`；`stopRun`、`readActiveLock`、`listRunRecords`、`scanSimple`、`listCrops`；Task 7 的 `renderGraphPage`（本任务先用现有版本）。
- Produces：
  - `startEditorServer(options: { sourceRoot: string; port?: number; launch: LaunchConfig; idleExitMs?: number; onIdle?: () => void }): Promise<{ url: string; origin: string; token: string; close(): Promise<void> }>`
  - 会话文件 `<root>/成图/_runs/.editor.json`：`{ port, token, pid }`，权限 0600；关闭时删除（仅当 pid 是自己）。
  - `editorPageUrl(origin: string, token: string, runId: string): string` = `<origin>/runs/<runId>/?token=<token>`
  - CLI：`fashion-tryon editor <source-root> [--port <n>] [--run-id <id>] [--no-open] [--json]`，stdout 首行 `{"url": "...", "origin": "..."}`，前台运行直到闲置退出或收到 SIGTERM。
- HTTP 接口（全部要求鉴权；POST 还要求 `Origin` 等于服务 origin、`content-type: application/json`）：
  - `GET /runs/<runId>/` → 现渲染的节点图页（`renderGraphPage(record)`）
  - `GET /runs/<runId>/<path>` → run 目录内文件（`run-data.js`、`ref/…`、`out/…`）
  - `GET /source/<相对路径>` → 素材根目录内的服装原图、模特图、`裁图/` 与 `成图/` 下的图片
  - `GET /api/ping` → `{ ok: true }`
  - `GET /api/runs/<runId>/editor` → `{ runId, derivedFrom, activeRunId, maxReferences, engineDefault, groups: [{ sku, note?, settings: currentSettings, garments: string[], crops: string[], models: { file: string; inRun: boolean }[] }] }`（路径相对素材根目录）
  - `POST /api/prompt` `{ references, swap }` → `{ prompt: defaultPrompt(...) }`
  - `POST /api/crop` `{ sku, from, role, box?, replace? }` → `{ file }`；`CROP_EXISTS` 时 HTTP 409
  - `POST /api/rerun` `RerunRequest` → `RunSummary` 加 `url`（新 run 的页面地址）；`RUN_IN_PROGRESS` 时 HTTP 409
  - `POST /api/runs/<runId>/cancel` → `RunDetail`（与 `cancel_run` 相同）
  - 错误响应：`{ error: { code, message } }`，message 经 `redactSecrets`

**Requirements:**
- 只监听 `127.0.0.1`；`port` 缺省时随机可用端口。
- 鉴权：URL 带 `?token=` 正确时设置 Cookie `ft_editor=<token>; HttpOnly; SameSite=Strict; Path=/`；之后请求凭 Cookie 或 query token；否则 401。token 用 `timingSafeEqual` 比较。
- 路径片段含 `.`、`..`、`\`、`/` 或解码失败 → 404；`/source/` 只放行图片扩展名（jpg/jpeg/png/webp）且位于上述目录之一；`_runs/` 下的 `run.json`、`.lock`、`.editor.json`、日志不经 `/source/` 暴露。
- HTML 响应带 CSP，只允许同源脚本、样式与图片。
- 闲置：最近一次请求超过 `idleExitMs`（默认 `IDLE_EXIT_MS`）→ 调 `onIdle`（CLI 下关闭服务并退出进程）；后台出图子进程不受影响。
- `/api/rerun` 直接调用 Task 4 的 `rerunTool`（`open: false`），占用检查、apimart 缺密钥检查、计划生成与 MCP `rerun` 完全相同；engine 未给时同 Task 3 规则。

**Test cases:**
- 无 token → 401；带 token 首次访问后凭 Cookie 可取 `run-data.js` 与缩略图。
- POST 缺 Origin 或 Origin 不同 → 403；非 JSON → 415。
- `/source/../x`、`/source/成图/_runs/<id>/run.json` → 404；服装原图 → 200 image/*。
- `/api/runs/<id>/editor` 返回来源设置、可选原图与裁图、模特（含 `inRun`）、`activeRunId`。
- `/api/crop` 同用途未确认 → 409 `CROP_EXISTS`。
- `/api/rerun` 假引擎只重出 1 张 → 返回新 runId 与 url；进行中再提交 → 409 `RUN_IN_PROGRESS`。
- `/api/runs/<id>/cancel` 与 `cancelRunTool` 结果一致。
- `idleExitMs: 200` 且无请求 → `onIdle` 被调用；期间后台假引擎 run 仍完成。
- 服务地址主机为 `127.0.0.1`；会话文件权限 0600。

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：`npx vitest run tests/editor-server.test.ts`
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**：同上；`npx vitest run tests/studio` 仍通过
- [x] **Step 5: Commit**
- 进展：2026-10-15 完成；CSP 对页面内联脚本与样式用 sha256 放行（不开 unsafe-inline），节点图成图缩略图的行内 style 移进样式表；`GET /` 跳到最近一次出图；CLI `editor` 实测首行地址、会话文件 0600、SIGTERM 后删除；Playwright 打开页面无 CSP 报错；全量 280 通过

### Task 6: 服务拉起与 `open_graph`

**Files:**
- Create: `src/editor/launch.ts`
- Modify: `src/mcp/tools.ts`、`src/mcp/server.ts`、`src/cli.ts`（`mcp` 命令把编辑服务启动参数传入）
- Test: `tests/editor-launch.test.ts`、`tests/mcp-tools.test.ts`、`tests/mcp-server.test.ts`

**Interfaces:**
- Consumes：Task 5 会话文件格式、`editorPageUrl`、CLI `editor`。
- Produces：
  - `ensureEditor(sourceRoot: string, config: LaunchConfig): Promise<{ origin: string; token: string }>`：会话文件存在、pid 存活且 `GET /api/ping`（带 token）返回 ok → 复用；否则 detached 拉起 `editor <root> --no-open --json`（日志写 `成图/_runs/editor.log`），等会话文件出现（最长 10 秒），超时抛 `IO_ERROR` `编辑服务未能启动，见 <日志路径>`。
  - `openGraphTool(input: { sourceRoot: string; runId?: string; open?: boolean }, config: LaunchConfig): Promise<{ runId: string; url: string }>`（不给 runId 时取最近一次）
  - `RunSummary` 增 `editorUrl?: string`
- MCP 工具 `open_graph`（输入 `sourceRoot`、`runId?`、`open?`）。

**Requirements:**
- `start_run` 与 `rerun` 开始后：`ensureEditor` 成功则打开并返回 `editorUrl`；失败则退回打开 `graph.html` 文件，不让出图失败。
- `open_graph` 在 `open !== false` 时用 `config.openUrl` 打开 url。
- 并发调用 `ensureEditor` 只留下一个服务进程（以会话文件为准，后来者检测到存活即复用）。

**Test cases:**
- 无服务时 `ensureEditor` 拉起服务，再次调用复用同一 pid 与端口。
- 会话文件指向已死 pid → 重新拉起。
- `open_graph` 返回 `http://127.0.0.1:<port>/runs/<runId>/?token=…`，GET 该地址 200。
- `start_run`（假引擎）返回 `editorUrl`，且 `openUrl` 收到它；编辑服务启动失败（模拟错误命令）时 `openUrl` 收到 `graph.html` 路径。
- MCP `listTools` 共 8 个工具。

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：`npx vitest run tests/editor-launch.test.ts tests/mcp-tools.test.ts tests/mcp-server.test.ts`
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**：同上
- [x] **Step 5: Commit**
- 进展：2026-10-15 完成；编辑服务启动时用临时文件 + link 原子占用会话文件，已有存活服务则退出（修掉并发拉起时读到空会话文件导致的孤儿进程）；`open: false` 时不拉起编辑服务；start_run/rerun 仍 2 秒内返回；全量 285 通过且无残留进程

### Task 7: 节点图页面改造

**Files:**
- Modify: `src/simple/graph.ts`
- Test: `tests/simple-graph.browser.test.ts`

**Interfaces:**
- Consumes：Task 1 的 `group.swap`、`referenceSource: 'custom'`、`derivedFrom`。
- Produces：页面在 http(s) 下加载 `/ui/editor.css` 与 `/ui/editor.js`，并向其暴露 `window.__GRAPH__ = { getRun(): RunRecord | null; onRender(cb: (run) => void): void; rebuild(): void }`；各款区域带 `data-sku`，各单张带 `data-sku`、`data-model`。编辑服务 Task 5 的 `GET /ui/editor.js|editor.css` 从 `findUiDir()` 返回（本任务一并补上该路由）。

**Requirements:**
- file:// 下显示只读提示（Global Constraints 原文），不加载编辑脚本。
- 有 `derivedFrom` 时页头显示 `来自 <runId>`，链接在 file:// 下为 `../<runId>/graph.html`，http 下为 `/runs/<runId>/`。
- 每款提示词节点显示该款 `swap`（旧记录回退 `params.swap`）；`referenceSource` 为 `custom` 时标签为 `自选`；`promptEdited` 为真时提示词节点标 `已改`。
- 现有行为（3 秒刷新、只更新变化节点、结束后停止、灯箱、8 款 33 张首屏 1 秒内）保持。

**Test cases:**
- file:// 打开 → 有只读提示，无 `/ui/editor.js` 请求。
- 带 `derivedFrom` 的记录 → 页头 `来自 20261015-123035`，链接正确。
- 一款 `swap: 'top'`、另一款 `outfit` → 两款分别显示 `只换上衣`、`换整套`。
- `referenceSource: 'custom'` → `服装参考图 · 自选`；`promptEdited` → `已改`。
- 现有浏览器用例全部通过。

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：`npx vitest run tests/simple-graph.browser.test.ts`
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**：同上
- [x] **Step 5: Commit**
- 进展：2026-10-15 完成；`rebuild` 同时清空节点缓存；编辑服务补 `/ui/editor.js|css` 路由（文件在 Task 8 新建，之前返回 404）；全量通过

### Task 8: 编辑交互页面

**Files:**
- Create: `ui/editor.js`、`ui/editor.css`
- Test: `tests/editor-ui.browser.test.ts`（Playwright 连 Task 5 编辑服务 + 假引擎）

**Interfaces:**
- Consumes：Task 5 HTTP 接口；Task 7 `window.__GRAPH__`、`data-sku`、`data-model`。

**Requirements:**
- 进入页面时取 `/api/runs/<runId>/editor`；每款区域加「编辑」入口，展开后为该款编辑面板；编辑状态只在页面内存，提交前不写文件（裁图除外）。
- 参考图（spec 3.1）：列表显示当前参考图缩略图与用途名；可移除、上移/下移、改用途名；从「原图」「裁图」两组中添加；在原图或已有裁图上拖框（框以千分比计），填用途名后保存调 `/api/crop`，409 时用确认框显示服务端 message，确认后带 `replace: true` 重试；保存成功的裁图自动加入参考图列表。超过上限时重出按钮禁用并显示 `参考图 <N> 张，超过上限 <M> 张`。
- 提示词（spec 3.2）：显示全文可编辑（textarea）；参考图或换装范围变化时调 `/api/prompt` 取默认；未改过 → 跟随默认；改过 → 不覆盖并显示 `参考图已变，提示词里的图号可能对不上`；改过时显示 `已改` 与 `恢复默认`。
- 换装范围与模特（spec 3.3）：每款 `outfit`/`top` 切换；模特列表显示该款全部模特图，来源 run 里没有的也列出（可勾选出图）。
- 选择（spec 3.4）：每张图勾选框，每款「全选」；可跨款；未勾选时重出按钮禁用。
- 重出（spec 4）：底部固定条显示已选张数、引擎选择（默认 codex）、「重出」按钮；选 apimart 时显示 `会产生真实费用`，点重出前 `confirm('apimart 会产生真实费用，确定用它重出吗？')`；成功后跳到返回的 `url`。只提交有改动的款的 `groups` 项。
- 占用：`activeRunId` 非空（含本 run 进行中）时重出按钮禁用，显示 `正在出图：<runId>` 并链接到 `/runs/<runId>/`；本 run 进行中时显示「取消」按钮，调 cancel 接口后刷新。
- 未提交修改时 `beforeunload` 拦截，并在固定条显示 `有未重出的修改，离开会丢失`。
- 每 60 秒 `GET /api/ping` 保活（页面可见时）。
- 页面宽度 ≥ 360px 可用，深色模式沿用节点图配色变量。

**Test cases:**
- 勾选 1 张 → 重出 → 跳到新 run 页，新 run 计划 1 张、页头 `来自 <来源 runId>`。
- 移除一张参考图、上移另一张、改用途名 → 提交请求的 `groups[sku].references` 顺序与页面一致；被移除的裁图文件仍在。
- 拖框保存裁图（同用途）→ 出现确认框；取消则无文件变化；确认后文件被替换并出现在参考图列表。
- 修改提示词 → 显示 `已改`；再改参考图 → 出现图号提示且文本未被覆盖；点 `恢复默认` → 文本等于 `/api/prompt` 结果、提示消失。
- 切换 top 且未改提示词 → 提示词随之变化。
- 选 apimart → 出现 `会产生真实费用`；确认框取消则不提交。
- 另一个 run 正在跑 → 重出按钮禁用并显示 `正在出图：<runId>`；本 run 进行中点取消 → 状态变为 `已取消`。
- 有未提交修改时刷新 → 触发 beforeunload。

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：`npx vitest run tests/editor-ui.browser.test.ts`
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**：同上
- [x] **Step 5: Commit**
- 进展：2026-10-15 完成；修了 3 个实测问题：`use strict` 缺分号导致脚本不执行、输入提示词时重画面板把光标挪到文末（改为只局部更新标记）、拖框松手的 click 冒泡打开节点图灯箱挡住对话框；Playwright 的 `close({runBeforeUnload})` 不触发对话框，测试改用刷新；360px 与深色模式截图检查无横向滚动；全量 297 通过

### Task 9: 文档、skill、打包与整体验收

**Files:**
- Modify: `README.md`、`docs/USAGE.md`、`skills/fashion-tryon/SKILL.md`、`docs/COLLEAGUE_INSTALL_AND_REAL_TEST.md`、`tests/skill-contract.test.ts`、`scripts/create-colleague-package.mjs`（确认包含 `ui/editor.*`）、`PROJECT.md`、本 plan

**Requirements:**
- 文档写明：节点图可编辑的打开方式（`open_graph` / `fashion-tryon editor <根目录>`）、只重出勾选的图、改参考图/提示词/换装范围/模特、重出新建 run 且 `-vN` 交付、人工提示词只用于本次、参考图带脸先裁掉、apimart 产生费用。
- skill 补：重出一张用 `rerun` 而不是整款 `start_run`；`run_status` 可读当前设置。
- 对照 spec §7 第 1–13 条逐条用假引擎核验，结果写进本 plan 进展备注；第 12 条（只读输入、不覆盖）与第 13 条（apimart 假配置无密钥泄漏）补自动化用例到 `tests/simple-rerun.test.ts` / `tests/editor-server.test.ts`。
- `npm test`、`npm run typecheck`、`npm run scan:secrets` 全部通过；`npm run package:colleague` 生成的包含 `ui/editor.js`。

**Test cases:**
- skill-contract：SKILL.md 提到 `rerun`、`open_graph`。
- 同事包含 `ui/editor.js`、`ui/editor.css`，泄漏自检通过。
- 重出前后素材根目录中除 `成图/`、`裁图/` 外文件字节不变；`成图/` 已有文件字节不变。
- apimart 假配置重出一次，页面响应、`run.json`、`rerun-plan.json`、日志不含密钥。

- [x] **Step 1: 补验收用例并确认失败或缺失**
- [x] **Step 2: 更新文档与 skill**
- [x] **Step 3: 运行 `npm test && npm run typecheck && npm run scan:secrets`，全部通过**
- [x] **Step 4: 逐条对照 spec §7 第 1–13 条，记录结果**
- [x] **Step 5: 更新 PROJECT.md，Commit**
- 进展：2026-10-15 完成；`npm test`（298 通过）、`npm run typecheck`、`npm run scan:secrets` 全部通过；同事包含 `ui/editor.js|css`，dist 版 `editor` 实测能取到编辑脚本。spec §7 对照（均为假引擎自动化用例）：
  1 只重出一张 — `simple-rerun` 2 款 4 张只计划 1 张、多 1 个 `-v2`、其余字节不变；`editor-ui` 页面勾 1 张重出
  2 参考图编辑 — `editor-ui` 移除/上移/改名后提交顺序一致、被移除裁图仍在；`simple-rerun` 换序改名后默认提示词随之变
  3 拖框裁图 — `simple-crop` 与 `crop` 同框字节一致；`editor-ui` 同名未确认不写、确认后替换
  4 提示词 — `simple-rerun` 假引擎收到的提示词逐字相同且标人工修改、未改时等于默认；`editor-ui` 改后再动参考图出现图号提示且不覆盖
  5 换装范围与模特 — `editor-ui`/`simple-rerun` 切 top 后等于 `--swap top` 提示词；新模特图可出
  6 单占用 — `editor-ui` 按钮禁用并显示正在跑的 run；`editor-server` 409、`mcp-tools` `RUN_IN_PROGRESS`
  7 取消 — `editor-server` 页面取消与 `cancel_run` 结果相同；`editor-ui` 取消后显示已取消
  8 来源追溯 — `editor-ui` 新 run 页头「来自」；`simple-graph` 链接；`mcp-tools` `list_runs` 带 `derivedFrom`
  9 MCP 对齐 — `mcp-tools` `rerun-plan.json` 与 `buildRerunPlan` 完全相同，页面经同一 `rerunTool`；`run_status` 返回每款设置
  10 只读回退 — `simple-graph` file:// 只读提示且不加载编辑脚本；`editor-launch` `open_graph` 拉起服务并 200
  11 服务生命周期 — `editor-server` 只听 127.0.0.1、闲置回调触发时后台出图仍完成
  12 只读输入与不覆盖 — `simple-rerun` 重出前后除新 `-v2` 外逐文件哈希不变
  13 无密钥泄漏 — `editor-server` 新增 apimart 假配置用例：接口、页面、run 文件、`rerun-plan.json`、日志、会话文件均不含密钥

### Task 10: 真实冒烟（需用户当场同意）

**Files:**
- Modify: `PROJECT.md`、本 plan（记录结果）

**Requirements:**
- 运行前告诉用户：素材目录、款号与张数（页面 1 张 + `rerun` 1 张，共 2 次 Codex 出图约 5 分钟）；用户同意后开始。
- 页面：打开可编辑节点图，对一款裁掉参考图上的人脸，只重出 1 张。
- Claude Code：只用 MCP 工具，`run_status` 读当前设置后用 `rerun` 只重出 1 张。
- 结果交用户目测；人是唯一质量关口，Agent 不评价成图好坏。

**Test cases:**
- spec §7 第 14 条：两次重出各交付 1 张 `-vN`，其余文件不变，节点图显示来源 run。

- [x] **Step 1: 报告计划并取得用户同意**
- 进展：2026-10-15 用户同意（开会中，由 Agent 代操作页面）；素材 ~/Documents/AI/MCP冒烟，款 001-SANDRO拉链卫衣，页面 1 张 + MCP rerun 1 张，Codex
- [x] **Step 2: 按上述流程跑一遍并记录**
- 进展：2026-10-15 页面（Agent 用 Playwright 代操作）把 001 的 02/03/05 三张裁图顶部的下巴与头部拖框裁掉（同名替换经确认），只勾 `0 (2).jpg` 用 Codex 重出 → run `20261015-155108`（来自 `20261015-135732`）交付 `0 (2)-v3.png`；MCP 客户端连新版 `fashion-tryon mcp`（本会话内置 MCP 仍是旧进程），8 个工具在，`run_status` 读到 top/裁图/未改提示词后 `rerun` 只重出 `0 (1).jpg` → run `20261015-155455` 交付 `0 (1)-v3.png`；旧成图与素材原图未变动；成图待用户目测
- [x] **Step 3: 更新 PROJECT.md 与本 plan，Commit**
