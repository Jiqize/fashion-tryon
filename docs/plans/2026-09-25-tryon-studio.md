# Tryon Studio Implementation Plan

**Goal:** 用一个本地常驻看板替换现有"命令流水线 + 指纹授权 + selection artifact"，实现按套批量生成、边生成边判断、默认通过只标例外、每套判完即交付。
**Architecture:** 新代码集中在 `src/studio/`：一个批次 = 一个 `studio.json` 状态文件（原子整体替换）+ 图片目录；引擎在同一进程内调度生成并通过事件推送给本地 HTTP 服务，服务以 SSE 推给浏览器页面；页面直接调用 JSON API 写判断。复用现有 provider 适配器、裁切压缩、六段式 prompt、服装描述缓存、目录扫描与运行锁；旧流水线在最后一个任务整体删除。
**Tech Stack:** Node ≥20、TypeScript、zod 4、sharp 0.34.5、node:http（不引入 Web 框架）、原生 JS/CSS 页面（不引入前端框架与构建）、Vitest 4、Playwright 1.58。

Spec：`docs/specs/2026-09-25-tryon-studio.md`（唯一事实来源）
视觉基准：`docs/design/2026-09-25-studio-mockup.html` 的主题 A「灯箱」（样图在本机 `output/mockups/studio/img/`，不入库）

## Global Constraints

- 输入素材目录只读；唯一允许写入的业务输出是 `<素材根目录>/成图/<款号>/`。
- 批次目录固定为 `<素材根目录的父目录>/<素材根目录名>-tryon-studio/`，所有运行数据只写在这里。
- 搭配模式：`fixedClothing`（固定服装，默认）、`pair`（一对一）、`fixedModel`（固定模特）；整批一个默认值，单组可覆盖。
- 换装范围沿用现有 `scope`：`full`（默认）、`top`、`bottom`、`full_acc`。
- 每张候选数 `candidates`：整数 1–4，默认 1。
- 并发 `concurrency`：整数 1–10，默认 5。
- 模特图张数超出 3–8 只提示，不阻止。
- 同一任务的一次生成只会被提交一次；崩溃恢复不重复提交、不重复计费。
- 所有生成版本都保留，不覆盖；采用哪个版本只能由人的判断改变。
- 不做 AI 自动质检、质检打分、排序；不做逐步授权、dry-run、review-selection 文件；不做预算闸门。
- 密钥不写入页面、日志、`studio.json` 或交付物。
- 本地服务只监听 `127.0.0.1`，URL 带随机 token；所有 API 校验 token 与同源。
- 页面：桌面宽度 ≥1280px，不做手机版；图片区域使用中性灰背景，图片上方不叠加半透明模糊或彩色渐变。
- 代码英文，注释中文；沿用现有 `RunnerError` 错误码体系。

## 文件结构

新建：

| 文件 | 职责 |
|---|---|
| `src/studio/model.ts` | `studio.json` 的 zod schema 与类型、状态派生函数（组状态、进度计数） |
| `src/studio/store.ts` | 打开/创建批次目录、加锁、原子保存、版本图片写入、缩略图缓存 |
| `src/studio/scan.ts` | 扫描素材根目录为组与素材，按模式生成任务，重扫合并 |
| `src/studio/prepare.ts` | 服装定位裁切、手动裁切覆盖、模特图预处理、服装描述与首轮 prompt |
| `src/studio/limiter.ts` | 可调并发闸门：限流降速、成功回升、运行中改上限 |
| `src/studio/engine.ts` | 生成队列、按套优先调度、候选数、暂停/继续、崩溃恢复、重出执行、事件发射 |
| `src/studio/regen-prompt.ts` | 问题标签 → 固定 prompt 补丁，拼装重出 prompt |
| `src/studio/decisions.ts` | 判断操作（整套通过、不交付、选版本、重出、撤回交付、撤销） |
| `src/studio/publish.ts` | 交付到 `成图/<款号>/`、同内容去重、撞名加后缀、总览页与映射表 |
| `src/studio/server.ts` | 本地 HTTP 服务：JSON API、SSE、静态页面、图片文件 |
| `ui/index.html` `ui/app.css` `ui/app.js` | 看板页面（主题 A），由 server 直接读取并下发 |
| `tests/studio/*.test.ts` | 各模块测试；`tests/studio/helpers.ts` 造素材目录与 fake provider |

修改：`src/cli.ts`（改为 `studio`、`status` 两个命令）、`src/config.ts`（并发默认与上限、单价）、`src/providers/apimart.ts`（提交阶段 429 语义）、`src/ports.ts`（精简）、`package.json`（`files` 加入 `ui`）、`skills/fashion-tryon/SKILL.md`、`README.md`、`docs/USAGE.md`。

删除（Task 10）：`src/preflight/`（`scanner.ts`、`classifier.ts` 中被复用的函数先迁入 `src/studio/scan.ts` 或保留原文件）、`src/review/`、`src/report/`、`src/run/runner.ts`、`src/run/approval.ts`、`src/delivery/`、`src/contracts.ts` 中只服务旧流水线的 schema，以及对应测试与旧文档。

---

### Task 1: 批次模型与存储

**Files:**
- Create: `src/studio/model.ts`
- Create: `src/studio/store.ts`
- Test: `tests/studio/store.test.ts`

**Interfaces:**
- Consumes: `acquireRunLock(runDirectory: string): Promise<RunLock>`（`src/run/store.ts`，本任务把它移到 `src/studio/store.ts` 并保持签名与行为）；`RunnerError`。
- Produces:
  - 类型 `PairingMode = 'fixedClothing' | 'pair' | 'fixedModel'`、`Scope`（沿用 `'top'|'bottom'|'full'|'full_acc'`）。
  - 类型 `RegenTag = 'color' | 'extra_item' | 'missing_item' | 'outside_changed' | 'pose_changed' | 'person_changed' | 'role_swap' | 'other'`（Task 6 使用）。
  - 类型 `BatchSettings { mode: PairingMode; scope: Scope; candidates: 1|2|3|4; concurrency: number; size: ImageSize; imageModel: string }`。
  - 类型 `Asset { id: string; role: 'garment'|'model'; relativePath: string; contentHash: string; mediaType: string; preparedRelativePath?: string; preparedHash?: string; bbox?: Bbox; cropOverride?: CropBox; warnings: string[] }`。
  - 类型 `Version { id: string; relativePath: string; sha256: string; mediaType: string; createdAt: string; prompt: string; regen?: { tags: RegenTag[]; note?: string; fromVersionId: string } }`。
  - 类型 `Task { id: string; groupId: string; garmentAssetId: string; modelAssetId: string; status: 'queued'|'running'|'done'|'failed'; versions: Version[]; chosenVersionId?: string; excluded: boolean; pending: PendingJob[]; error?: { code: string; message: string } }`；`PendingJob { jobId: string; kind: 'first'|'regen'; prompt?: string; regen?: {...}; providerRequestId?: string; submittedAt?: string }`。
  - 类型 `Group { id: string; sku: string; name: string; dir: string; mode?: PairingMode; scope?: Scope; order: number; incompleteReason?: string; started: boolean; delivered?: { at: string; files: string[] }; brief?: GarmentBrief; basePrompt?: string }`。
  - 类型 `BatchState { schemaVersion: 1; batchId: string; sourceRoot: string; createdAt: string; settings: BatchSettings; groups: Group[]; assets: Asset[]; tasks: Task[]; generationCallsUsed: number }`。
  - `groupStatus(state: BatchState, groupId: string): 'incomplete'|'idle'|'queued'|'generating'|'review'|'delivered'|'failed'`。
  - `batchCounts(state: BatchState): { delivered: number; review: number; generating: number; queued: number; incomplete: number; failed: number; tasks: number; generationCalls: number }`。
  - `batchDirFor(sourceRoot: string): string`。
  - `openBatch(sourceRoot: string): Promise<BatchStore>`；`BatchStore { dir: string; state(): BatchState; update(mutator: (draft: BatchState) => void): Promise<BatchState>; writeVersionImage(taskId: string, bytes: Uint8Array, mediaType: string): Promise<{ relativePath: string; sha256: string }>; thumbnail(relativePath: string, edge: 480): Promise<string>; resolve(relativePath: string): string; close(): Promise<void> }`。

**Requirements:**
- `batchDirFor('/a/本次素材')` 返回 `/a/本次素材-tryon-studio`。
- `openBatch` 不存在时创建批次目录与 `studio.json`（默认设置：`fixedClothing`、`full`、`candidates 1`、`concurrency 5`、`size '3:4'`、`imageModel` 取 `IMAGE_MODEL` 环境变量）；存在时读取并用 zod 校验，校验失败抛 `INTEGRITY_ERROR`。
- `openBatch` 持有批次目录的运行锁；同一批次第二次 `openBatch` 抛 `VALIDATION_ERROR`，消息包含持锁 pid；持锁进程已死时回收锁。
- `update` 串行执行（内部变更队列），每次把完整状态写临时文件后 `rename` 替换 `studio.json`，文件权限 0600。
- 状态中所有路径都是相对路径（相对批次目录或素材根目录），不写绝对路径。
- `writeVersionImage` 写入 `images/<taskId>/<序号两位>-<sha256前8位>.<ext>`，已存在同名文件时不覆盖而抛 `INTEGRITY_ERROR`。
- `thumbnail` 在 `thumbs/` 生成最长边 480 的 JPEG（质量 82）并缓存，源文件 hash 变化后重新生成。
- `groupStatus` 规则：有 `incompleteReason` → `incomplete`；有 `delivered` → `delivered`；未开始 → `idle`；任一任务 `running` 或有 `pending` → `generating`；全部任务 `queued` → `queued`；任一任务 `failed` 且其余非运行 → `failed`；全部任务 `done` → `review`。

**Test cases:**
- 新目录 `openBatch` → 创建 `studio.json`，默认设置如上。
- 两次 `openBatch` 同一目录 → 第二次抛 `VALIDATION_ERROR`。
- 锁文件 pid 为已结束进程 → `openBatch` 成功。
- 并发 20 次 `update` 递增计数 → 最终计数 20，文件可被 schema 解析。
- 手工写入非法 `studio.json` → 抛 `INTEGRITY_ERROR`。
- `writeVersionImage` 两次相同序号 → 第二次不覆盖且抛错。
- `thumbnail` 返回文件最长边 = 480；再次调用命中缓存（mtime 不变）。
- `groupStatus` 覆盖 7 种状态各一例；`batchCounts` 与之一致。

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败** `pnpm vitest run tests/studio/store.test.ts` → 模块不存在导致失败
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过** `pnpm vitest run tests/studio/store.test.ts` → 全部通过；`pnpm typecheck` 无错误
- [x] **Step 5: Commit**

进展：2026-09-25 完成，新增 src/studio/model.ts、src/studio/store.ts 与 tests/studio/store.test.ts（11 例通过）；运行锁迁入 studio/store.ts，src/run/store.ts 转出保持旧调用方不变；sourceRoot 以相对批次目录的路径记录；batchCounts.failed 按失败任务张数、generationCalls 取已用生成次数。

### Task 2: 素材扫描、分组与任务生成

**Files:**
- Create: `src/studio/scan.ts`
- Test: `tests/studio/scan.test.ts`
- Create: `tests/studio/helpers.ts`（造素材目录：`makeSourceTree(spec: Record<sku, { garments: number; models: number }>)`，写入可解码的小 JPEG）

**Interfaces:**
- Consumes: `scanInput(inputRoot, exclusions)`、`compareCodePoints`（`src/preflight/scanner.ts`）、`roleOfSegment`、`stableId`（`src/preflight/classifier.ts`）；Task 1 的 `BatchState`、`Group`、`Asset`、`Task`、`PairingMode`。
- Produces:
  - `scanSource(sourceRoot: string): Promise<ScannedGroup[]>`；`ScannedGroup { sku: string; name: string; dir: string; garments: ScannedFile[]; models: ScannedFile[]; stray: string[] }`。
  - `buildTasks(group: Group, garments: Asset[], models: Asset[], mode: PairingMode): { tasks: Pick<Task,'id'|'garmentAssetId'|'modelAssetId'>[]; incompleteReason?: string }`。
  - `mergeScan(state: BatchState, scanned: ScannedGroup[]): BatchState`（纯函数）。
  - `parseGroupDir(dirName: string): { sku: string; name: string }`。

**Requirements:**
- 一组 = 素材根目录下的一级子目录，且其中含角色子目录（`服装`/`衣服`/`单品`… 与 `模特`/`人物`… 沿用 `roleOfSegment`）；不含角色子目录的一级目录忽略并记入 `stray`。
- 款号与名称：目录名按第一个 `_` 或空格拆分，`EK52338_灰` → `{ sku: 'EK52338', name: '灰' }`；无分隔符时 `name` 为空串。
- 组内文件按 `compareCodePoints` 排序；`成图/`、`._*`、`.DS_Store` 沿用扫描器已有的忽略规则。
- 任务配对：`fixedClothing` = 第 1 张服装 × 每张模特；`pair` = 按序一一配对；`fixedModel` = 每张服装 × 第 1 张模特。
- 素材不全：任一边为 0 张 → `incompleteReason = '缺少服装图'` 或 `'缺少模特图'`；`pair` 两边张数不同 → `incompleteReason = '一对一：服装 {g} 张 · 模特 {m} 张，数量不一致'`。素材不全的组不生成任务，其他组不受影响。
- 任务 ID = `stableId('task', groupDir, garment.contentHash, model.contentHash, mode)`；素材 ID = `stableId('asset', relativePath, contentHash)`。
- `mergeScan`：新组追加（`order` 接在末尾）；已存在组新增的模特图追加任务；已有任务、版本、判断保持不变；源文件内容变化（hash 变化）视为新素材、旧任务保留但不再调度（记 `error.code = 'INPUT_CHANGED'`）；组的 `incompleteReason` 按最新扫描重算。
- 模特图张数不在 3–8 之间时，给该组素材追加 warning `模特图 {n} 张，超出常用的 3–8 张`（只提示）。

**Test cases:**
- 4 组（每组 1 服装 4 模特）→ 4 组、16 个任务，`fixedClothing` 配对正确。
- `pair` 模式 3 服装 × 4 模特 → 该组 `incompleteReason` 为一对一文案，0 任务；其他组正常。
- `fixedModel` 3 服装 × 1 模特 → 3 任务。
- 组内含 `._01.jpg`、`.DS_Store`、`成图/x.jpg` → 均不计入。
- 目录 `EK52338_灰` → sku `EK52338`、name `灰`；`EK52338` → name 空。
- 首次合并后判断某任务为 excluded，再追加一张模特图重扫 → 原任务 excluded 保持，新增 1 个 queued 任务。
- 同一素材两次扫描 → 任务 ID 相同。
- 9 张模特图 → 出现 3–8 提示 warning，任务照常 9 个。

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败** `pnpm vitest run tests/studio/scan.test.ts`
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过** `pnpm vitest run tests/studio/scan.test.ts`；`pnpm typecheck`
- [x] **Step 5: Commit**

进展：2026-09-25 完成，新增 src/studio/scan.ts、tests/studio/helpers.ts 与 tests/studio/scan.test.ts（13 例通过）；组由"一级目录 + 含角色子目录"判定（空角色目录也算组），stray 记组内不在角色子目录下的文件，不含角色子目录的一级目录直接忽略；INPUT_CHANGED 只写 error 不改 status（Task 4 调度需跳过），源文件恢复原内容后清除；3–8 张提示挂在该组模特图素材上并在重扫时重算；源目录中整组消失时不改动旧组。

### Task 3: 服装裁切、手动裁切覆盖与首轮 prompt

**Files:**
- Create: `src/studio/prepare.ts`
- Modify: `src/prepare/images.ts`（`prepareAsset` 改为接收最小素材描述 `{ id, role, sourcePath, relativePath, contentHash, bbox?, cropOverride? }`，其余行为不变）
- Test: `tests/studio/prepare.test.ts`

**Interfaces:**
- Consumes: `VisionPort.locateGarment`、`VisionPort.brief`（`src/ports.ts`）；`prepareAsset`、`prepareFramingCopy`（`src/prepare/images.ts`）；`getGarmentBrief`、`createBriefCache`（`src/prepare/brief.ts`）；`buildTryonPrompt(brief, scope)`（`src/prepare/prompt.ts`）；Task 1 `BatchStore`。
- Produces:
  - `prepareGroup(store: BatchStore, groupId: string, deps: { vision: VisionPort; signal: AbortSignal }): Promise<void>`：确保组内全部素材已有 prepared 副本、服装有 bbox、组有 `brief` 与 `basePrompt`。
  - `setCropOverride(store: BatchStore, assetId: string, box: CropBox | null): Promise<void>`。

**Requirements:**
- 服装图无 bbox 时调用 `locateGarment` 定位，结果写入 `Asset.bbox`；同一 `contentHash` 只定位一次。
- 裁切优先级：`cropOverride` > `bbox`；按现有规则加边距、压缩到 ≤1,000,000 字节、最长边 1600、JPEG 质量 85 起。服装定位失败时该组记 `error`，组状态为 `failed`，不回退到服装全图。
- 模特图只做压缩，不裁切。
- 组的 `brief` 用该组第一张服装（`fixedModel` 模式下每张服装各自一份）的 prepared 副本调用 `brief`；`basePrompt = buildTryonPrompt(brief, scope).prompt`。`fixedModel` 模式把 brief 与 prompt 存在对应任务的首个 `PendingJob.prompt` 上。
- `setCropOverride` 更新覆盖框后清除该素材的 `preparedHash`、组的 `brief`/`basePrompt`，下一次 `prepareGroup` 重新生成；已生成的版本不受影响。`box` 为 `null` 时恢复自动裁切。
- 覆盖框校验：整数、在原图范围内、短边 ≥128px，否则抛 `VALIDATION_ERROR`，消息 `裁切框超出图片范围或过小`。

**Test cases:**
- fake vision 返回 bbox → prepared 服装副本尺寸等于"bbox + 边距"，`locateGarment` 调用 1 次（同 hash 两组共用时仍 1 次）。
- 设置 `cropOverride` → 重新 prepare 后副本尺寸等于覆盖框，`brief` 重新调用。
- `setCropOverride(null)` → 回到 bbox 裁切。
- 覆盖框越界 → `VALIDATION_ERROR` 与上述文案。
- `locateGarment` 抛错 → 组 `failed`，没有生成全图副本。
- `fixedModel` 两件服装 → 两份不同 prompt 分别挂在各自任务上。

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败** `pnpm vitest run tests/studio/prepare.test.ts`
- [x] **Step 3: 最小实现使其通过**（同时让旧测试 `tests/prepare-images.test.ts` 继续通过）
- [x] **Step 4: 运行确认通过** `pnpm vitest run tests/studio/prepare.test.ts tests/prepare-images.test.ts`；`pnpm typecheck`
- [x] **Step 5: Commit**

进展：2026-09-25 完成，新增 src/studio/prepare.ts 与 tests/studio/prepare.test.ts（5 例通过），旧 tests/prepare-images.test.ts 保持通过；prepareAsset/prepareFramingCopy 改收 PrepareSourceAsset（含 cropOverride），新增 validateCropOverride、orientedImageSize；Group 增加可选 error，groupStatus 在 delivered 之后、idle 之前据此返回 failed；定位沿用临时全图副本（用完即删），prepared 副本从不回退全图；准备失败只记组 error 不抛出（中止照常抛出）；fixedModel 的组 brief/basePrompt 取第一件服装，每件服装的 prompt 另写到对应任务首个未提交的 first PendingJob（无则新建）。

### Task 4: 生成引擎（调度、候选数、暂停、事件）

**Files:**
- Create: `src/studio/engine.ts`
- Create: `src/studio/limiter.ts`（本任务只实现固定上限与运行中改上限；限流自适应在 Task 5）
- Test: `tests/studio/engine.test.ts`

**Interfaces:**
- Consumes: Task 1 `BatchStore`、`groupStatus`；Task 3 `prepareGroup`；`ImageGenerationPort.generate(request, signal, checkpoint)`（`src/ports.ts`）。
- Produces:
  - `createEngine(store: BatchStore, deps: { vision: VisionPort; images: ImageGenerationPort; now?: () => Date }): Engine`。
  - `Engine { prepareAll(): Promise<void>; start(groupIds?: string[]): Promise<void>; pause(): Promise<void>; resume(): void; setConcurrency(n: number): void; enqueueRegen(taskId: string, job: { prompt: string; regen: Version['regen'] }): Promise<void>; retryFailed(taskIds?: string[]): Promise<void>; idle(): Promise<void>; on(event: 'change', listener: (e: EngineEvent) => void): () => void; stop(): Promise<void> }`。
  - `EngineEvent = { type: 'task'; taskId: string } | { type: 'group'; groupId: string } | { type: 'batch' } | { type: 'notice'; level: 'info'|'warn'; message: string }`。
  - `Limiter { acquire(signal: AbortSignal): Promise<() => void>; setLimit(n: number): void; readonly limit: number; readonly active: number }`。

**Requirements:**
- `start()` 不带参数时开始全部 `idle` 组；带参数只开始指定组；组 `started = true`，其任务进入 `queued`，每个任务按 `settings.candidates` 生成对应数量的 `PendingJob(kind 'first')`。
- 调度顺序：先按组 `order`，同组内按任务顺序；一个组在调度器中开始后，优先把该组的剩余作业派发完，再开始下一个组（按套优先）。
- 引擎创建后以及每次重扫后，在后台对所有尚未准备的组调用 `prepareGroup`（只调用视觉接口，不生图），同时最多 2 个组处于准备中，按组 `order` 进行；这样开跑前的素材表就能看到服装裁后图与提示词。生成作业派发前再次确保所属组已准备。
- `Engine` 额外提供 `prepareAll(): Promise<void>`（测试与服务启动使用）；组准备中/准备完成都发 `group` 事件。
- 同时运行的生成调用数 ≤ 当前并发上限；`setConcurrency` 在运行中生效（1–10，越界抛 `VALIDATION_ERROR`），并写回 `settings.concurrency`。
- 作业提交前把 `PendingJob.prompt` 落盘；provider 返回 task ID 时（`checkpoint.onProviderRequestId`）立即写入 `PendingJob.providerRequestId` 与 `submittedAt`；成功后写版本图片、追加 `Version`、移除该 `PendingJob`、`generationCallsUsed + 1`；任务的所有作业结束且至少一个版本时状态 `done`。
- 首个版本到达时，若任务还没有 `chosenVersionId`，设为该版本；重出版本到达时把 `chosenVersionId` 设为新版本（spec：采用用户最后选择的版本——重出即表示要新版本）。
- 生成失败（非限流、非提交不确定）：作业移除，任务无任何版本时 `failed` 并记 `error`，已有版本时保持 `done` 并发 `notice`（`{sku} · {序号} 重出失败：{message}`）。
- `pause()`：不再派发新作业，已在运行的作业跑完；`resume()` 继续。
- 每次状态变更发出对应 `EngineEvent`；每个组的状态变为 `review` 时额外发 `notice`：`{sku} 生成完成，可以判断了`。
- `idle()` 在队列空且无运行作业时 resolve（测试用）。

**Test cases:**
- `prepareAll()` 后未 `start` → 所有组有 `basePrompt` 与服装裁后图，生图调用 0 次。
- 3 组 × 4 任务、fake 生图延迟 20ms、并发 2 → 全部 `done`，fake 观测到最大并发 = 2，调用次数 = 12。
- `candidates = 3` → 每任务 3 个版本、调用次数 = 任务数 × 3，`chosenVersionId` 为第 1 个到达的版本。
- 按套优先：并发 2、组 A 4 任务、组 B 4 任务 → A 的 4 个任务全部开始后，B 才开始第一个。
- 运行中 `setConcurrency(4)` → 之后最大并发升到 4；`setConcurrency(11)` → `VALIDATION_ERROR`。
- `pause()` 后已开始的作业完成、不再派发新作业；`resume()` 后全部完成。
- fake 对某任务抛 `PROVIDER_ERROR` → 该任务 `failed`，其余完成；`retryFailed()` 后成功。
- `enqueueRegen` → 新版本追加，旧版本保留，`chosenVersionId` 指向新版本，`version.regen` 记录标签与来源版本。
- 组全部完成 → 收到 `notice` "… 生成完成，可以判断了"。

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败** `pnpm vitest run tests/studio/engine.test.ts`
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过** `pnpm vitest run tests/studio/engine.test.ts`；`pnpm typecheck`
- [x] **Step 5: Commit**

进展：2026-09-25 完成，新增 src/studio/engine.ts、src/studio/limiter.ts 与 tests/studio/engine.test.ts（9 例通过）；调度器拿到并发名额后再按"已开始的组优先、其次组 order"挑作业；首轮 prompt 在派发时落盘，任务自己的 prompt（fixedModel）优先于组 basePrompt，并同步给同任务其余候选；同一任务的版本写入串行；已带 submittedAt/providerRequestId 的作业不派发（留给 Task 5 恢复）；准备失败的组作业留在队列，retryFailed 清除组错误后重新准备；限流与提交不确定暂按普通失败处理（Task 5 细化）；pause() 等已运行作业跑完才 resolve。

### Task 5: 限流自适应与崩溃恢复

**Files:**
- Modify: `src/studio/limiter.ts`、`src/studio/engine.ts`
- Modify: `src/providers/apimart.ts:118-124`（提交阶段 HTTP 429 的错误语义）
- Modify: `src/config.ts`（`APIMART_SAFE_CONCURRENCY` 改为默认 5、上限 10 的 `DEFAULT_CONCURRENCY` / `MAX_CONCURRENCY`；新增可选 `IMAGE_PRICE_CNY`）
- Test: `tests/studio/recovery.test.ts`、`tests/apimart-provider.test.ts`（补用例）

**Interfaces:**
- Consumes: Task 4 `Engine`、`Limiter`；`RunnerError` 码 `PROVIDER_RATE_LIMIT`、`PROVIDER_SUBMISSION_UNKNOWN`。
- Produces:
  - `Limiter.onRateLimited(): number`（返回退避毫秒数）、`Limiter.onSuccess(): void`、`Limiter.effectiveLimit: number`。
  - `RunnerConfig.imagePriceCny?: number`；常量 `DEFAULT_CONCURRENCY = 5`、`MAX_CONCURRENCY = 10`。

**Requirements:**
- apimart 提交阶段收到 HTTP 429：抛 `PROVIDER_RATE_LIMIT`（`retryable: true`），表示服务商未受理；5xx、408、网络错误仍抛 `PROVIDER_SUBMISSION_UNKNOWN`（不自动重提）。
- 引擎收到 `PROVIDER_RATE_LIMIT`：该作业放回队首（不计入 `generationCallsUsed`），`effectiveLimit = max(1, floor(effectiveLimit / 2))`，全局暂停派发 `min(60000, 5000 × 2^k)` 毫秒加 0–20% 随机抖动（k 为连续限流次数，从 0 开始）；连续 10 次成功后 `effectiveLimit + 1`，不超过用户设置的上限；发 `notice`：`服务商限流，并发临时降到 {n}`。
- 收到 `PROVIDER_SUBMISSION_UNKNOWN`：作业移除，任务记 `error = { code: 'PROVIDER_SUBMISSION_UNKNOWN', message: '提交结果未知，可能已计费；请确认后手动重试' }`，不自动重提；`retryFailed` 可以显式重试。
- 进程启动时恢复：对每个 `PendingJob` ——有 `providerRequestId` → 通过 `checkpoint.providerRequestId` 只继续轮询与下载，不重新上传或提交；无 `providerRequestId` 但有 `submittedAt` → 按提交结果未知处理（同上文案）；两者都没有 → 视为未提交，正常排队。
- 恢复后已完成的版本、判断、交付状态保持不变。

**Test cases:**
- apimart fake server 提交返回 429 → 抛 `PROVIDER_RATE_LIMIT`；返回 502 → 抛 `PROVIDER_SUBMISSION_UNKNOWN`。
- 引擎 fake 前 3 次调用返回限流 → `effectiveLimit` 从 5 降到 2、之后逐步回升；最终全部完成；没有任何任务的成功版本数超过 `candidates`；`generationCallsUsed` 等于成功调用数。
- 限流退避期间不派发新作业（fake 观察到调用时间间隔 ≥ 退避下限，测试里注入可控时钟）。
- 写入带 `providerRequestId` 的 `PendingJob` 后重开批次 → fake 收到的调用带 `checkpoint.providerRequestId`、上传次数 0，版本落盘。
- 写入只有 `submittedAt` 的 `PendingJob` 后重开 → 任务 `failed`，错误码 `PROVIDER_SUBMISSION_UNKNOWN`，fake 调用 0 次。
- 生成中 `stop()`（模拟崩溃）再重开 → 已完成版本不丢，未开始的作业继续完成。

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败** `pnpm vitest run tests/studio/recovery.test.ts tests/apimart-provider.test.ts`
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过** 同上命令；`pnpm typecheck`
- [x] **Step 5: Commit**

进展：2026-09-25 完成，limiter 增加 onRateLimited/onSuccess/effectiveLimit（降速后改上限保持降速值、连续 10 次成功 +1）；引擎限流时作业放回队首、不计调用，同一轮派发的并发限流合并为一次降速与一次退避，退避期间暂停派发（sleep/random 可注入）；提交结果未知记固定文案不重提；启动先恢复：有 task ID 的作业续取结果、仅有 submittedAt 的按提交未知失败、运行中任务回到排队；apimart 提交阶段 429 改抛 PROVIDER_RATE_LIMIT；config 新增 DEFAULT_CONCURRENCY=5/MAX_CONCURRENCY=10 与可选 IMAGE_PRICE_CNY，APIMART_SAFE_CONCURRENCY 暂留给旧流水线（Task 10 删除）；新增 tests/studio/recovery.test.ts（8 例）；整套 pnpm test 在高负载下 engine.test 的"运行中改并发"时序用例偶发失败（HEAD 上同样复现，单独运行通过）。

### Task 6: 判断操作、重出 prompt 与按套交付

**Files:**
- Create: `src/studio/regen-prompt.ts`、`src/studio/decisions.ts`、`src/studio/publish.ts`
- Test: `tests/studio/decisions.test.ts`、`tests/studio/publish.test.ts`

**Interfaces:**
- Consumes: Task 1 `BatchStore`、`groupStatus`、`RegenTag`；Task 4 `Engine.enqueueRegen`、`Engine.retryFailed`。
- Produces:
  - `REGEN_TAG_LABELS: Record<RegenTag, string>`。
  - `buildRegenPrompt(basePrompt: string, tags: RegenTag[], note?: string): string`。
  - `createDecisions(store: BatchStore, engine: Engine): Decisions`；`Decisions { apply(op: DecisionOp): Promise<DecisionResult>; undo(): Promise<DecisionResult> }`。
  - `DecisionOp = { op: 'pass'; groupId: string } | { op: 'exclude'; taskId: string; excluded: boolean } | { op: 'choose'; taskId: string; versionId: string } | { op: 'regenerate'; taskId: string; tags: RegenTag[]; note?: string } | { op: 'withdraw'; groupId: string }`。
  - `DecisionResult = { ok: true; message: string; published?: PublishResult } | { ok: false; code: string; message: string }`。
  - `publishGroup(store: BatchStore, groupId: string): Promise<PublishResult>`；`PublishResult { dir: string; files: string[]; skippedSame: string[] }`。
  - `writeOverview(store: BatchStore): Promise<{ htmlPath: string; csvPath: string }>`。

**Requirements:**
- 标签与界面文案固定：`color` 颜色偏、`extra_item` 多了配饰、`missing_item` 少了单品、`outside_changed` 下装被换、`pose_changed` 姿势变了、`person_changed` 人物变了、`role_swap` 角色互换、`other` 其他。
- `buildRegenPrompt` = `basePrompt` + 换行 + `【重出修正】` + 按标签顺序拼接以下固定句子（`other` 无句子）；有 `note` 时再追加 `【补充说明】{note}`，`note` 去掉 `【】` 与换行、截断到 200 字：
  - color：`上一版服装颜色与图1不一致。颜色、明度与饱和度必须严格以图1为准，不受图2光线与环境色影响。`
  - extra_item：`上一版出现了图1没有的配饰或单品。不得新增任何图1未列出的物品。`
  - missing_item：`上一版漏掉了图1中的部分单品。图1列出的每一件目标服装都必须完整呈现，包括层次与长度。`
  - outside_changed：`上一版改动了换装范围以外的衣物。范围以外的下装、鞋履与配饰必须与图2完全一致。`
  - pose_changed：`姿势、手部动作、身体朝向与取景必须与图2完全一致。`
  - person_changed：`人物的脸、发型、肤色与身材必须与图2完全一致。`
  - role_swap：`上一版把图1当成了人物底图。图2才是人物、姿势与场景的唯一来源；图1只提供服装。`
- `regenerate`：`tags` 为空且 `note` 为空 → `{ ok: false, code: 'VALIDATION_ERROR', message: '选一个问题标签，或写一句原因' }`；否则用任务所在组（或 `fixedModel` 任务自己）的基础 prompt 拼装并调用 `engine.enqueueRegen`，来源版本 = 当前 `chosenVersionId`；该任务 `excluded` 置 false。
- `exclude`：只允许 `done` 任务；`choose`：版本必须属于该任务。
- `pass`：组状态必须为 `review`，且没有 `pending` 作业、没有 `failed` 任务（否则 `ok: false`，文案分别为 `这套还在生成，完成后再判断`、`还有重出中的图，完成后再交付`、`有生成失败的图，请重试或标记不交付`）；通过后立即 `publishGroup`，写入 `group.delivered`，然后 `writeOverview`；返回 `message = '{sku} 已交付 {n} 张'`。
- `withdraw`：清除 `group.delivered`，组回到 `review`；不删除 `成图/` 中已写出的文件；返回 `message = '{sku} 已撤回，成图/{sku}/ 中已写出的文件保留'`。
- `undo`：撤销最近一次 `pass`/`exclude`/`choose`/`withdraw`（进程内栈，上限 50）；撤销 `pass` 等同 `withdraw`；`regenerate` 不可撤销（已提交的生成会计费），栈顶是 `regenerate` 时跳过它撤销前一个；栈空返回 `ok: false`，文案 `没有可撤销的操作`。
- 交付：每个未排除任务的 `chosenVersionId` 版本原始字节复制到 `<素材根>/成图/<sku>/<sku>_<模特图文件名去扩展名>.<版本扩展名>`；目标已存在且内容相同 → 跳过记入 `skippedSame`；已存在但内容不同 → 依次尝试 `_2`、`_3`… 后缀；先写临时文件再 rename，从不覆盖。`fixedModel` 模式文件名用服装图文件名。
- 总览：`<批次目录>/总览.html`（每个已交付组一行缩略图，引用相对路径的缩略图）与 `<批次目录>/mapping.csv`（列：`sku,task_id,garment,model,version_id,output_file`，UTF-8 BOM）；每次交付或撤回后重写。

**Test cases:**
- `buildRegenPrompt(base, ['color','role_swap'], '领子\n要【立】起来')` → 以 base 开头，含两句固定句子，按顺序，补充说明中无换行与【】。
- 组中 1 张 excluded、3 张通过 → `成图/EK52338/` 下 3 个文件，文件名符合规则。
- 再次交付同一组（撤回后重过）内容未变 → `skippedSame` 3 个，不新增文件。
- `成图/EK52338/EK52338_2.jpg` 已存在且内容不同 → 新文件为 `EK52338_2_2.jpg`。
- 组仍有生成中的任务时 `pass` → `ok: false` 与对应文案，未写任何文件。
- `regenerate` 空标签空说明 → 固定文案错误；带标签 → engine 收到的 prompt 等于 `buildRegenPrompt` 结果。
- `pass` 后 `undo` → 组回到 `review`、`成图` 文件仍在。
- 栈顶为 `regenerate` 时 `undo` → 撤销的是前一个操作。
- `mapping.csv` 以 BOM 开头，行数 = 已交付文件数 + 1。

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败** `pnpm vitest run tests/studio/decisions.test.ts tests/studio/publish.test.ts`
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过** 同上命令；`pnpm typecheck`
- [x] **Step 5: Commit**

进展：2026-09-25 完成，新增 src/studio/regen-prompt.ts、decisions.ts、publish.ts 与 tests/studio/decisions.test.ts（12 例）、publish.test.ts（5 例），tests/studio/helpers.ts 增加 makeReviewBatch；PublishResult 额外带 outputs（按任务顺序的全部交付文件，写入 group.delivered.files 供映射表对应）；判断操作串行执行，已交付的套须先撤回才能 exclude/choose/regenerate；pass 的拒绝顺序为首轮未出图→有重出→有失败；重出基础 prompt 取组 basePrompt（fixedModel 取任务首轮 prompt），缺失时退回首轮版本记录的 prompt；标签句按固定标签顺序拼接；整套 pnpm test 在高负载下仍有既有时序用例偶发超时（HEAD 同样复现，单独运行通过）。

### Task 7: 本地服务与 CLI 入口

**Files:**
- Create: `src/studio/server.ts`
- Modify: `src/cli.ts`（新增 `studio`、`status` 命令；旧命令在 Task 10 删除）
- Modify: `package.json`（`files` 加 `ui`）
- Create: `ui/index.html`（本任务只放占位页面：显示批次名与计数，供服务测试；正式界面在 Task 8）
- Test: `tests/studio/server.test.ts`、`tests/cli.test.ts`（补用例）

**Interfaces:**
- Consumes: Task 1 `openBatch`、`batchCounts`、`groupStatus`；Task 2 `scanSource`、`mergeScan`；Task 3 `setCropOverride`；Task 4/5 `createEngine`；Task 6 `createDecisions`。
- Produces:
  - `startStudioServer(options: { sourceRoot: string; port?: number; deps: { vision: VisionPort; images: ImageGenerationPort } }): Promise<StudioServer>`；`StudioServer { url: string; batchDir: string; close(): Promise<void> }`。
  - HTTP API（全部要求查询参数 `token`，POST 只接受同源、`application/json`、≤1 MiB）：
    - `GET /` → `ui/index.html`；`GET /ui/app.js`、`GET /ui/app.css` → 静态文件。
    - `GET /api/batch` → `{ state: BatchView }`（`BatchView` = `BatchState` 去掉 prompt 全文与绝对路径，附每组 `status` 与 `counts`）。
    - `GET /api/events` → SSE，事件名 `change`，数据为 `EngineEvent`；连接建立时先发一次 `{ type: 'batch' }`。
    - `POST /api/settings` `{ mode?, scope?, candidates?, concurrency? }`：`mode`/`scope`/`candidates` 只影响尚未开始的组；`concurrency` 立即生效。
    - `POST /api/groups/:groupId/settings` `{ mode?, scope? }`（组未开始时）。
    - `POST /api/groups/:groupId/crop` `{ assetId, box: CropBox | null }`。
    - `POST /api/start` `{ groupIds?: string[] }`；`POST /api/pause`；`POST /api/resume`；`POST /api/retry` `{ taskIds?: string[] }`；`POST /api/rescan`。
    - `POST /api/decisions` `DecisionOp`；`POST /api/undo`。
    - `GET /api/prompt/:taskId` → `{ prompt }`（行展开查看提示词用）。
    - `GET /files/asset/:assetId?variant=prepared|source|thumb`、`GET /files/version/:versionId?variant=full|thumb` → 图片字节；只按 ID 查找，不接受路径参数。
  - CLI：`fashion-tryon studio <sourceRoot> [--port <n>] [--no-open] [--json]`、`fashion-tryon status <sourceRoot> --json`。

**Requirements:**
- 服务只监听 `127.0.0.1`；端口默认随机，首次选定后写入 `<批次目录>/.studio-session.json`（0600，含端口与 token），再次启动优先复用同一端口与 token，使浏览器标签页可继续使用。
- token 错误 → 401；非同源 POST → 403；非 JSON → 415；超过 1 MiB → 413；未知路由 → 404；业务错误 → 400 且 body 为 `{ ok: false, code, message }`。
- 启动时：打开批次（加锁）→ 扫描并 `mergeScan` → 创建引擎并对上次未完成的作业执行恢复 → 开始监听。
- `studio` 命令 stdout 首行输出 JSON `{ url, batchDir }`，默认用系统浏览器打开 `url`（`--no-open` 不打开）；进程常驻，`SIGINT`/`SIGTERM` 时停止派发、等待运行中作业最多 30 秒后退出，释放锁。
- `status` 命令不加锁、只读 `studio.json`，输出 `{ batchDir, counts, groups: [{ sku, status }] }`。
- 生产环境 provider 由现有 `createApimartAdapter` / `createDashscopeAdapter` 构造；`.env.local` 加载沿用现有 `loadEnvironmentFiles`。
- 全部响应头 `Cache-Control: no-store`，图片 `Cache-Control: private, max-age=31536000, immutable`（版本文件不可变）。

**Test cases:**
- 无 token → 401；错误 token → 401；正确 token `GET /api/batch` → 200 且不含任何绝对路径（检查 JSON 中不含 `sourceRoot` 的父目录字符串）、不含 prompt 全文。
- POST 带 `Origin: http://evil.example` → 403；`text/plain` → 415；2 MiB body → 413。
- `GET /files/version/<id>?variant=thumb` → 200 JPEG；`GET /files/version/../../etc` → 404。
- `POST /api/start` 后订阅 SSE → 收到 `task` 与 `group` 事件，最终所有组 `review`（fake provider）。
- `POST /api/decisions` pass → `成图/<sku>/` 生成文件，响应 `ok: true`。
- 关闭后以同一素材根目录再次启动 → 端口与 token 相同。
- 服务运行中另起一个 `studio` 同一目录 → 退出码 1，stderr 含 "already"。
- `status --json` 在服务运行中也可执行并返回计数。

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败** `pnpm vitest run tests/studio/server.test.ts tests/cli.test.ts`
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过** 同上命令；`pnpm typecheck`；`pnpm build`
- [x] **Step 5: Commit**

进展：2026-09-25 完成，新增 src/studio/server.ts、ui/index.html（占位页）与 tests/studio/server.test.ts（5 例），tests/cli.test.ts 补 2 例；cli 新增 studio/status 命令（生产 provider 缺配置时启动前报 CONFIG_ERROR，studio 由中止信号结束并关闭服务）；store 新增只读的 readBatchState 供 status 使用；BatchView 去掉 sourceRoot、组 basePrompt/brief（只留 garments 清单）与所有 prompt，附组 status/counts、整批 counts、paused 与可选 imagePriceCny（startStudioServer 额外接收可选 imagePriceCny 供 Task 9 显示预计费用）；整批改 mode/scope 时已开始的组固定为原设置，未开始的组丢掉首轮任务与提示词后按新设置重扫、后台重新准备；版本图与素材原图 immutable 缓存，素材裁后图/缩略图随手动裁切变化改为 private, no-cache；pause 接口不等运行中作业即返回；整套 pnpm test 高负载下 engine.test 改并发用例与 generation-plan 用例偶发超时（单独运行与重跑整套均通过）。

### Task 8: 看板页面——判断视图

**Files:**
- Modify: `ui/index.html`；Create: `ui/app.js`、`ui/app.css`
- Reference: `docs/design/2026-09-25-studio-mockup.html`（视觉基准，已入库；样图引用本机 `output/mockups/studio/img/`）
- Test: `tests/studio/ui-review.browser.test.ts`（Playwright，fake provider 起真实 server）

**Interfaces:**
- Consumes: Task 7 全部 HTTP API 与 SSE。
- Produces: 页面模块内函数（供 Task 9 扩展）：`render(state)`、`selectGroup(groupId)`、`selectTask(taskId)`、`api(path, body?)`、`toast(message, sub?)`。

**Requirements:**
- 视觉：采用基准稿主题 A「灯箱」的变量与版式（背景 `#1b1b1b`、面板 `#212121`、图片底 `#282828`、文字 `#ecebe7`、次要 `#8f8c86`、标记 `#d4a553`、强调 `#c8453a`；款号 Instrument Serif，数字 JetBrains Mono，正文 Inter / PingFang SC）；去掉主题切换。
- 布局：顶栏（批次名、进度条与分状态计数、并发与已用/预计费用）；左侧"套 × 图"表；右侧 460px 检视区（大成图 + 右侧上下叠放服装裁后图与模特原图、版本切换、状态、三个操作按钮）；底部快捷键说明栏。
- 行：左侧款号/名称/状态，服装裁后图，按顺序排列本组全部任务的缩略图；已交付的组收起为一条（缩略图高 76px，显示 `→ 成图/{sku}/`）；素材不全的组显示 `incompleteReason` 与"补齐后自动加入队列，其他套不受影响"。
- 缩略图状态：生成中/排队用对应模特图灰度淡影占位（透明度 .16），底部 2px 进度线；重出中用当前版本变暗（透明度 .38）并在说明行显示 `重出中 · {标签}`；不交付为透明度 .18 加对角细线；多版本说明行显示 `v{当前}/{总数}`。图片上不叠加文字。
- 键盘：`↑`/`↓` 换组、`←`/`→` 换图、`Enter` 整套通过、`R` 打开重出标签层（`1`–`8` 多选、`Tab` 进入说明输入、`Enter` 确认、`Esc` 取消）、`X` 切换不交付、`1`–`4` 切换版本、`Space` 打开三图对照（点击同步放大 2.4 倍、移动鼠标同步平移、`Space`/`Esc` 关闭）、`⌘Z`/`Ctrl+Z` 撤销。鼠标：单击选中、双击打开对照、按钮等价。
- 整套通过后自动跳到下一个 `review` 组；提示条显示 `{sku} 已交付 {n} 张` 与 `→ 成图/{sku}/   ⌘Z 撤销`，2.6 秒后消失；服务端返回 `ok: false` 时提示条显示其 `message`。
- 页面通过 SSE 增量刷新，不整页重载；SSE 断开时每 2 秒重连，重连后重新拉取 `/api/batch`。
- 40 组 × 7 张：首屏渲染 ≤1 秒（从 `DOMContentLoaded` 到首行缩略图 `load`，用缩略图 variant），键盘切换无整表重绘（只更新变化的行与检视区）。

**Test cases:**
- fake provider 生成 4 组后：按 `Enter` → 第 1 组收起并显示 `→ 成图/…`，选中跳到第 2 组，`成图` 目录出现文件。
- 选中一张按 `X` → 缩略图出现不交付样式；`Enter` 交付后 `成图` 少这一张。
- `R` → `1` → `Enter` → 该图显示 `重出中 · 颜色偏`；fake 完成后显示 `v2/2`；按 `1` 切回 v1，检视区显示 v1。
- `⌘Z` 撤销通过 → 组恢复展开且状态为待判断。
- 生成中组显示淡影占位与进度线；完成后自动变为待判断，出现提示条。
- 纯键盘完成 40 组判断（含 3 次重出、2 次不交付）→ 全部组 `delivered`，全程未调用鼠标事件（验收 4、5）。
- 40 × 7 渲染耗时断言 ≤1000ms（验收 1）。

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败** `pnpm vitest run tests/studio/ui-review.browser.test.ts`
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过** 同上命令；另跑 `node output/mockups/shot.mjs` 式的截图脚本比对主题 A 观感（截图人工查看，记录路径）
- [x] **Step 5: Commit**

进展：2026-09-25 完成，ui/index.html 改为正式骨架（静态文件同样要 token，由内联引导拼 token 加载 app.css/app.js；Google 字体非阻塞加载），新增 ui/app.css（主题 A 变量与版式，去掉主题切换）、ui/app.js（render/selectGroup/selectTask/api/toast，按行签名增量重建，选中只切 class 与检视区；按键串行执行；SSE notice 显示为提示条，断开 2 秒重连）与 tests/studio/ui-review.browser.test.ts（5 例，含 40×7 首屏 ≤1s、行节点不重建、纯键盘 40 套含 3 次重出 2 次不交付且无鼠标事件）；tests/studio/helpers.ts 清理临时目录加 maxRetries（服务关闭后仍有缩略图写入）；首屏耗时由页面 performance.mark('studio-first-thumb') 打点；已交付组检视区提供"撤回交付"按钮；预计费用取 max(任务数×候选数, 已用次数)×单价；截图 output/mockups/task8-*.png 与主题 A 样稿一致；整套 pnpm test 高负载下 engine.test 改并发用例仍偶发超时（单独与重跑通过）。

### Task 9: 看板页面——开跑前素材表、设置与手动裁切

**Files:**
- Modify: `ui/app.js`、`ui/app.css`
- Test: `tests/studio/ui-setup.browser.test.ts`

**Interfaces:**
- Consumes: Task 7 的 `/api/settings`、`/api/groups/:id/settings`、`/api/groups/:id/crop`、`/api/start`、`/api/pause`、`/api/resume`、`/api/retry`、`/api/rescan`、`/api/prompt/:taskId`；Task 8 的 `render`、`api`、`toast`。
- Produces: 无（终端任务）。

**Requirements:**
- 未开始的组在同一张表中显示为素材行：服装裁后图（准备中时显示服装原图淡影与说明 `裁切中`）+ 全部模特图（配对关系可见）；每行可勾选（默认全选）、可改本组模式与范围。
- 顶部设置条（批次内有未开始的组时显示）：搭配模式、换装范围、每张候选数（1–4）、并发（1–10），以及 `共 {组数} 套、{任务数} 张任务、{任务数×候选数} 次生成` 和（配置了 `IMAGE_PRICE_CNY` 时）`预计约 ¥{金额，保留 1 位小数}`；主按钮"开始"（`Enter` 在设置条聚焦时等价），只开始勾选的组。
- 运行中顶部显示"暂停/继续"与并发调整；并发调整即时调用 `/api/settings`。
- 失败的图说明行显示错误摘要；失败存在时顶部出现"重试所有失败（n）"。
- 行展开（`E` 或点击款号）显示本组提示词全文（只读）。
- 手动裁切：在服装裁后图上按 `C` 或双击打开裁切层，显示原图与可拖动的矩形框（四角缩放、框内拖动），`Enter` 保存（调用 crop API）、`Backspace` 恢复自动裁切、`Esc` 取消；保存后该组服装图刷新。已开始的组不允许裁切（提示 `这套已开始生成，裁切只影响之后的重出`，并仍允许保存）。
- 页面获得焦点时调用 `/api/rescan`（最多每 10 秒一次），新增的组出现在表末尾。

**Test cases:**
- 4 个未开始组，取消勾选 1 组、候选数设 2 → 设置条显示 `共 3 套、12 张任务、24 次生成`；点"开始" → 只有 3 组进入生成。
- 配置 `IMAGE_PRICE_CNY=0.2` 时显示 `预计约 ¥4.8`（24 × 0.2）。
- 运行中把并发从 5 改为 2 → fake 观测到之后最大并发 2。
- fake 让 1 张失败 → 出现"重试所有失败（1）"，点击后成功。
- 打开裁切层，拖动右下角缩小 → `Enter` → 服装裁后图尺寸变化，`/api/batch` 中该素材有 `cropOverride`。
- 在素材根目录新增一组后切回页面 → 表末尾出现新组（验收 2 的补充）。
- 一对一数量不符的组显示素材不全文案，不可勾选。

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败** `pnpm vitest run tests/studio/ui-setup.browser.test.ts`
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过** 同上命令
- [x] **Step 5: Commit**

进展：2026-09-25 完成，ui/app.js 增加开跑前设置条（模式/范围/候选数/并发即时写 /api/settings，汇总"共 X 套、Y 张任务、Z 次生成"及配置单价时的"预计约 ¥"，只开始勾选的组，设置条内 Enter 等价开始；仅有素材不全的组时不显示）、顶栏运行控制（暂停/继续、并发、"重试所有失败（n）"）、素材行（勾选框默认全选、本组模式/范围、模特原图配对、准备中服装原图淡影与"裁切中"、素材不全不可勾选）、失败说明行错误摘要、E/点击款号展开只读提示词、C/双击服装图打开裁切层（四角缩放、框内平移，Enter 保存、Backspace 恢复自动、Esc 取消；已开始的组提示只影响之后的重出）、页面获得焦点重扫（10 秒内合并为一次）；未开始组的检视区改为"裁切服装/提示词"按钮；ui/index.html 增加 setup/run/crop 容器与 E、C 快捷键说明（计划未列出该文件，属必要改动）；新增 tests/studio/ui-setup.browser.test.ts（6 例）；截图 output/mockups/task9-*.png。
审查修复：2026-09-25 准备进行中保存裁切时引擎在本轮结束后补做准备（此前裁后图会一直停在"裁切中"）；未开始组手动裁切清除准备错误，自动裁切失败的组可靠手动裁切恢复；"重试所有失败（n）"计入已开始但准备失败的组中被卡住的任务，服装图说明显示准备失败摘要；展开的提示词在模式、范围、裁切或选中任务变化后重新读取；补 3 例页面测试与 1 例引擎测试。

### Task 10: 删除旧流水线、更新文档与整体验收

**Files:**
- Delete: `src/preflight/`（先把 `scanInput`、`compareCodePoints`、`roleOfSegment`、`stableId` 迁入 `src/studio/scan.ts` 或独立的 `src/studio/fs-scan.ts`）、`src/review/`、`src/report/`、`src/run/runner.ts`、`src/run/approval.ts`、`src/run/semaphore.ts`、`src/delivery/`、`src/contracts.ts` 中旧 schema（保留被新代码使用的 `Scope`、`ImageSize`、`Bbox` 等）、对应 `tests/*.test.ts` 与 `tests/helpers/*` 中不再使用的部分
- Modify: `src/ports.ts`（删除 `classify`、`verify`、`reviseBrief`，同步修改 `src/providers/dashscope.ts` 与 fake）、`src/cli.ts`（只保留 `studio`、`status`）、`skills/fashion-tryon/SKILL.md`、`skills/fashion-tryon/references/workflow.md`、`README.md`、`docs/USAGE.md`、`docs/ARCHITECTURE.md`、`docs/INPUT_OUTPUT.md`、`AGENTS.md`、`PROJECT.md`
- Test: `tests/studio/acceptance.test.ts`、`tests/paid-e2e.test.ts`（改为 studio 真实冒烟，默认跳过）

**Interfaces:**
- Consumes: 全部前序任务。
- Produces: 无。

**Requirements:**
- 删除后 `pnpm test`、`pnpm typecheck`、`pnpm build`、`pnpm scan:secrets` 全部通过；`dist/cli.mjs` 只有 `studio` 与 `status` 命令。
- Skill 改为：用户给素材根目录 → Agent 运行 `fashion-tryon studio <dir>`（后台常驻）并返回 `url`；进度查询用 `fashion-tryon status <dir> --json`；Agent 不代替用户做判断、不复制或移动文件。
- README 与 USAGE 描述新流程：拖入/指定目录 → 看素材表确认开始 → 边生成边按套判断 → 自动交付到 `成图/<款号>/`；列出全部快捷键。
- 验收测试（fake provider，可配置延迟与失败率）逐条覆盖 spec 第 7 节 1–10；第 11 条真实服务商冒烟由 `tests/paid-e2e.test.ts` 在设置 `FASHION_TRYON_PAID_E2E=1` 时执行（2 套 × 3 张）。
- spec 第 7 节第 10 条：运行前后对素材目录（除 `成图/`）逐文件计算 sha256，结果一致。

**Test cases:**
- 验收 2：三种模式各一组样例 → 任务数与配对符合 spec 第 2 节。
- 验收 3：第 1 组 `review` 时其余组仍在 `generating`，此时 `pass` 第 1 组成功并出现 `成图` 文件。
- 验收 7：并发 10、fake 注入限流 → 任意时刻运行数 ≤10，无重复提交（fake 记录的提交 ID 无重复）。
- 验收 8：生成中强制终止子进程（`studio` 命令）→ 重启后状态完整，fake 收到的恢复调用带原 `providerRequestId`。
- 验收 9：通过的组出现在 `成图/<sku>/`，重复交付不覆盖；不交付与未采用版本不在 `成图/`。
- 验收 10：素材目录 hash 前后一致。
- 旧命令 `fashion-tryon preflight` → 报未知命令。

- [x] **Step 1: 按上述 cases 写失败测试（acceptance）**
- [x] **Step 2: 运行确认失败** `pnpm vitest run tests/studio/acceptance.test.ts`
- [x] **Step 3: 删除旧代码、迁移复用函数、更新文档，使其通过**
- [x] **Step 4: 运行确认通过** `pnpm test`、`pnpm typecheck`、`pnpm build`、`pnpm scan:secrets` 全部通过并贴出输出；有 key 时执行 `FASHION_TRYON_PAID_E2E=1 pnpm test:paid`
- [x] **Step 5: Commit**

进展：2026-09-25 完成，删除 preflight/review/report/delivery/run 旧流水线与对应测试，扫描函数迁入 `src/studio/fs-scan.ts`，VisionPort 精简为 locateGarment/brief，CLI 只剩 studio/status；新增 `tests/studio/acceptance.test.ts`（验收 2/3/7/8/9/10 与旧命令拒绝，验收 8 用子进程 SIGKILL 重启），paid e2e 改为 studio 2 套×3 张冒烟且默认跳过（未运行）；Skill、README、USAGE、ARCHITECTURE、INPUT_OUTPUT、AGENTS 改为新流程；vitest 全局超时调到 20s 以消除全量并行时的既有超时误报。

---

## 自查记录

- Spec 覆盖：§2 模式与素材不全 → T2；§3.1 入口/恢复 → T7、T5（spec 已改：新一批用 CLI 另起，不在页面拖入）；§3.2 素材表、裁切、提示词、设置、单次确认、部分勾选与追加 → T3、T9；§3.3 并发/限流/按套优先/失败重试/暂停/恢复 → T4、T5、T9；§3.4 判断全部行为 → T6、T8；§3.5 交付与总览 → T6；§4 界面原则 → T8；§5 运行保障 → T1、T5；§6 删除项 → T10；§7 验收 1–11 → T8、T9、T10。
- 待决事项处理：并发上限按默认 5 / 上限 10 实现，真实冒烟时核对（T10）；`fixedModel` 下交付目录仍按组目录名作为款号，文件名用服装图文件名（T6），如需按服装拆款号另开变更。
- 名称一致性已核对：`BatchStore`、`Engine.enqueueRegen`、`DecisionOp`、`RegenTag`、`buildRegenPrompt`、`publishGroup`、`writeOverview`、`startStudioServer` 在各任务中签名一致。

---

## 后续修正（2026-09-25）

用户验收后提出的小修正，spec 已同步修订（§2、§3.2、§3.4、§7 第 12–13 条）。

- [x] **A. 失败图可标记不交付**：`exclude` 接受 `done` 与 `failed` 任务；失败图全部标记不交付后组状态为 `review`，可整套通过；失败计数与"重试所有失败"不含已标记不交付的失败图；撤销可恢复。
  进展：2026-09-25 完成，`groupStatus`/`batchCounts`/组视图计数/`pass` 校验忽略已排除的失败图，`retryFailed()` 全量重试跳过它们（点名重试照常）；页面 `X` 与按钮原本就会发请求，无需改交互；补 decisions 1 例、engine 1 例、ui-setup 1 例。
- [x] **B. 固定模特模式不提示模特图张数**：按组生效模式（单组覆盖优先）判断，`fixedModel` 不加"超出常用的 3–8 张"提示，其它模式照旧。
  进展：2026-09-25 完成，`mergeScan` 先取生效模式再重算提示（改模式时由既有的重扫合并刷新）；补 scan 1 例；USAGE 与 Skill workflow 同步一句。
- [x] **C. 准备失败的组可重试**：新增 `POST /api/groups/:id/prepare`（同样的 token、同源与 JSON 校验），清除组的准备错误并在后台重新准备；未开始且准备失败的素材行显示失败摘要与"重新准备"按钮，成功后经 SSE 刷新为可勾选。
  进展：2026-09-25 完成，未复用"重试所有失败"（它只统计已开始的组，未开始的组要单独入口）；没有准备失败的组调用时返回 `VALIDATION_ERROR`；补 server 1 例、ui-setup 1 例；USAGE 与 Skill workflow 同步 A、C 两句。
- [x] **D. 时序测试改为确定性断言**：`engine.test` 的"运行中调整并发"改用可控闸门（`tests/helpers/fake-image-generation.ts` 新增 `Gate`），按"同时停在闸门处的调用数"断言，不靠生成耗时；同类有真实竞态的用例一并改：engine"并发上限内生成"、recovery"限流退避"（成功调用等全部限流返回后再继续）与"中途停止后恢复"（等到有调用停在轮询阶段再停止）、acceptance 3（A01 之后的调用停在闸门处）与 7（凑齐 3 个并发再放行）、ui-review 的"重出中"与"生成中淡影"、ui-setup 的"运行中改并发"。
  进展：2026-09-25 完成，`pnpm test` 连续 4 次全绿（198 通过、1 跳过），`pnpm typecheck`、`pnpm build`、`pnpm scan:secrets` 通过；只有 40×7 首屏 ≤1 秒这类本身就是耗时验收的断言保留计时。
- [x] **E. 清理仍描述旧流水线的文档与脚本**：HANDOFF 改写为 Studio 接手说明；同事安装说明与反馈模板改为 `studio` → 看板 → 边生成边判断 → `成图/<款号>/`；删除旧版图解 HTML、截图资源与 PDF 导出脚本及其测试；同事包补上运行必需的 `ui/`。spec §6 同步一条。
  进展：2026-09-25 完成，`tests/colleague-package.test.ts` 改为校验新文档要点、`ui/` 入包且不含旧命令，`tests/skill-contract.test.ts` 删去图解页面用例；`pnpm test`、`pnpm scan:secrets` 通过。
