# Guided Intake and Human Review Implementation Plan

**Goal:** 让用户只提供一个结构化目录或“服装目录 + 模特目录”即可通过短问答启动换装，并在 Swiss Research 静态报告中完成可恢复的人工验收、导出清单和精确重做。
**Architecture:** CLI 继续拥有所有业务合同和执行逻辑：manifest v2 表达输入来源与质检模式，runner 在 `manual` 模式止于待人工检查，静态报告只保存浏览器草稿并导出显式 JSON，`retry --selection` 重新验证后才把选择写入运行流水并追加版本。旧 manifest v1 在读取时规范化为 `auto` 语义，报告重建不改写旧文件。
**Tech Stack:** Node.js ≥20、TypeScript 5.9、Zod 4、Commander 14、Vitest 4、Playwright 1.58、原生 HTML/CSS/JavaScript、Sharp 0.34。

## Global Constraints

- `docs/specs/2026-08-30-v2-guided-human-review.md` 是本阶段唯一行为事实来源；与 v1 冲突时以 v2 为准。
- CLI 是唯一业务执行 Interface；Skill 和报告不得复制扫描、配对、任务计数、生成、重做或运行状态逻辑。
- 新 run 默认 `reviewMode: "manual"`；自动质检仅在显式 `auto` 时运行。
- `report.html` 不直接调用 provider，不写 `manifest.json`、`state.json`、`review.json` 或 `events.jsonl`。
- 输入素材只读；生成与人工重做都只追加 run 内版本，不覆盖旧图。
- 报告必须直接以 `file://` 工作，使用 inline CSS/JS 和 run-relative 图片，不增加前端依赖或网络请求。
- 报告严格使用 Swiss Research 色板：`#ffffff`、`#000000`、灰阶、强调色 `#fde047`；无渐变、无阴影、无衬线标题、容器圆角不超过 `6px`。
- 报告必须有 1px 网格、语境侧栏、数据卡和任务表格层级，并在 20–40 个任务时可用。
- 人工验收草稿按 run 隔离保存在当前浏览器；它不是运行事实，只有显式导出的 JSON 经 CLI 验证后可以触发重做。
- 真实 APIMART/DashScope 调用不属于本计划的普通验证；所有实现测试使用 fake，付费测试保持默认 skipped。
- 不提交用户图片、run、selection 文件、密钥或包含绝对私人路径的样例。

## File Structure

### Create

- `src/preflight/input-source.ts`：规范化单／双目录输入、确定缺省输出位置、扫描并生成稳定逻辑路径；供 preflight 与输入完整性校验共同使用。
- `src/review/manual-selection.ts`：人工验收 JSON schema、解析和稳定序列化合同；不执行生成。
- `tests/manual-selection.test.ts`：人工验收 JSON 和过期选择的 focused contract tests。

### Modify

- `src/contracts.ts`：manifest v2、v1 内存兼容、`ReviewMode`、`ManifestInput`、引导问题种类和待人工检查统计。
- `src/preflight/scanner.ts`：继续负责单目录递归读取与 hash；接受 input-source 需要的稳定逻辑路径组合。
- `src/preflight/classifier.ts`：显式双目录角色不调用视觉分类，并进入同一稳定任务组。
- `src/preflight/preflight.ts`：引导问题、双目录、manual 成本计算和 answers 解析。
- `src/run/store.ts`：按 manifest input source 校验单／双目录内容不变。
- `src/run/runner.ts`：manual 终态、summary、resume 和选定任务执行。
- `src/review/retry.ts`：只读 retry plan、selection 验证、dry-run 所需成本和审计事件。
- `src/cli.ts`：双目录／guided／review-mode 参数、selection 与 dry-run retry 接口。
- `src/report/render.ts`：人工验收所需的候选版本、reviewable 和 AI 建议模型。
- `src/report/template.ts`：Swiss Research 报告、批量表格、浏览器草稿和 JSON 导入导出。
- `skills/fashion-tryon/SKILL.md`：路径优先的引导式启动和 selection retry 流程。
- `skills/fashion-tryon/references/workflow.md`：guided answers、付费确认、人工验收和 dry-run retry 细节。
- `docs/USAGE.md`、`docs/fashion-tryon-usage-guide.html`：短启动和人工验收主流程。
- `docs/ARCHITECTURE.md`、`docs/INPUT_OUTPUT.md`、`docs/SECURITY.md`：v2 边界、selection 合同和浏览器本地草稿安全口径。
- `README.md`：最短入口、命令变化和文档索引。
- `tests/contracts.test.ts`、`tests/scanner.test.ts`、`tests/preflight.test.ts`、`tests/run-store.test.ts`：输入和 schema 兼容。
- `tests/runner.test.ts`、`tests/resume.test.ts`、`tests/review-runner.test.ts`：manual/auto 状态机。
- `tests/retry.test.ts`、`tests/cli.test.ts`：selection dry-run 与执行。
- `tests/report.test.ts`、`tests/report-browser.test.ts`、`tests/helpers/report-fixture.ts`：Swiss 报告及持久人工选择。
- `tests/helpers/run-fixture.ts`、`tests/e2e-fake.test.ts`、`tests/skill-contract.test.ts`：新缺省、端到端和 Skill 合同。

## Report Design Lock

**Intent:** 把报告做成一张“换装研究账本”：先从 40 条任务中看清进度，再在同一位置展开三联证据并做人工判断。

**Token system:** 4/8/12/16/24/32/48/64/96/128 间距；内容最大宽度 `1400px`；顶部黑线 `6px`；结构边界 `1px`；表格顶底线 `2px`；圆角 `0–6px`；强调色只用 `#fde047`。

**Typography:** `"Helvetica Neue", "PingFang SC", Arial, sans-serif`；运行编号、task ID 和小标签使用系统等宽字体；标题不使用 serif。

**Layout:**

```text
┌──────────────────────────── 6px black rule ────────────────────────────┐
│ REF / RUN ID                人工换装验收                               │
├──────────────┬──────────┬──────────┬──────────┬──────────┬─────────────┤
│ total        │ unchecked│ pass     │ redo     │ errors   │ run context │
├──────────────┴──────────┴──────────┴──────────┴──────────┴─────────────┤
│ sticky context sidebar  │ search / filters / next unchecked            │
│ review progress         ├───────────────────────────────────────────────┤
│ import / export         │ #  task/style  status  versions  AI  decision│
│ run facts               │ 01 ...       ...     ...       ... [actions]│
│                         │    expanded: garment | candidate | identity   │
│                         │ 02 ...       ...     ...       ... [actions]│
└─────────────────────────┴───────────────────────────────────────────────┘
```

**Signature element:** 方形编号样本行与黄色“当前／下一条未检查”游标形成贯穿全页的研究索引；黄色只表示当前行动点，不作为装饰背景。

**Self-critique before build:** 禁止回到大卡片瀑布流；主路径不能被 prompt、AI issues 或历史版本撑高；“生成成功”“AI 建议”“人工通过”必须是三个不同字段；1280px 下不能依赖横向滚动完成主要验收。

### Task 1: Manifest v2 and Compatibility Contracts

**Files:**
- Modify: `src/contracts.ts`
- Modify: `tests/contracts.test.ts`

**Interfaces:**
- Produces: `reviewModes = ['manual', 'auto'] as const` and `ReviewMode`.
- Produces: `ManifestInput = { kind: 'single'; root: string } | { kind: 'dual'; garmentRoot: string; modelRoot: string }`.
- Produces: canonical `RunManifest` with `schemaVersion: 2`, `input: ManifestInput`, and `reviewMode: ReviewMode`.
- Produces: `parseManifest(input: unknown): RunManifest`, which accepts persisted manifest schema `1|2` and normalizes v1 to `{ schemaVersion: 2, input: { kind: 'single', root: inputRoot }, reviewMode: 'auto' }` in memory.
- Produces: `RunSummary.awaitingHumanReview: number` with `0` as the parse default for existing state files.
- Extends: `PreflightQuestion.kind` with `review_mode`; `ManifestAsset.roleSource` with `input`.

**Requirements:**
- New preflight output persists manifest `schemaVersion: 2`; state/review/event schemas remain `1`.
- A v1 manifest without review mode must retain v1 automatic review semantics after parsing.
- Parsing a v1 manifest or state is read-only and cannot rewrite source JSON.
- Manifest v2 rejects dual input with a missing/blank path and rejects unknown review modes.
- Existing v1 `maximumGenerationCalls` is preserved during normalization rather than recalculated.
- Existing task, review and event contracts remain source-compatible.

**Test cases:**
- Persisted v1 manifest with `inputRoot` and no review mode → canonical input is single, review mode is auto, task/cost fields unchanged.
- Valid v2 dual manifest with manual mode → parse/serialize/parse preserves both paths and manual mode.
- Manifest schema `3`, invalid review mode, or dual input missing `modelRoot` → `UNSUPPORTED_SCHEMA` or `VALIDATION_ERROR` before execution.
- Existing state JSON without `awaitingHumanReview` → parsed summary contains `0` without writing the file.

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：`pnpm exec vitest run tests/contracts.test.ts`，新增 v1 canonical 化与 dual blank path 用例分别按预期失败。
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**：`pnpm exec vitest run tests/contracts.test.ts && pnpm typecheck` 全部退出 `0`；额外回归 preflight/store/runner/resume 4 个文件共 20 个用例通过。
- [x] **Step 5: Commit**：`feat: add v2 manifest and review mode contracts`

**进展（2026-08-30）：** manifest 读取 seam 现统一返回 schema v2，持久化 v1 被只读规范化为 single input + auto 语义且保留原成本；新增 dual input、manual/auto、input role source、review-mode question 与 awaiting-human summary 合同。state/review/event schema 保持 v1。

### Task 2: Guided Single/Dual-source Preflight

**Files:**
- Create: `src/preflight/input-source.ts`
- Modify: `src/preflight/scanner.ts`
- Modify: `src/preflight/classifier.ts`
- Modify: `src/preflight/preflight.ts`
- Modify: `src/run/store.ts`
- Modify: `src/cli.ts`
- Modify: `tests/scanner.test.ts`
- Modify: `tests/preflight.test.ts`
- Modify: `tests/run-store.test.ts`
- Modify: `tests/cli.test.ts`
- Modify: `tests/helpers/run-fixture.ts`

**Interfaces:**
- Consumes: `ManifestInput`, `ReviewMode`, `RunManifest` from Task 1.
- Produces: `SourcedFile = ScannedFile & { explicitRole?: AssetRole; explicitGroupKey?: string; explicitGroupName?: string }`.
- Produces: `InputScanResult = { input: ManifestInput; files: SourcedFile[]; skipped: SkippedAsset[]; fingerprint: string }`.
- Produces: `defaultOutputRoot(input: ManifestInput): string`.
- Produces: `scanManifestInput(input: ManifestInput, exclusions: readonly string[]): Promise<InputScanResult>`.
- Changes: `PreflightOptions` to `{ input: ManifestInput; outputRoot?: string; config: RunnerConfig; guided?: boolean; scope?: Scope; pairing?: PairingMode; size?: ImageSize; reviewMode?: ReviewMode; model?: string; visionModel?: string }`.
- Keeps: `buildPreflight(options: PreflightOptions, deps: PreflightDeps): Promise<PreflightResult>` and `applyAnswers(manifest, answers): RunManifest`.
- Extends CLI: `fashion-tryon preflight [input-dir] [--garment-dir <dir> --model-dir <dir>] [--guided] [--review-mode <manual|auto>]` plus existing options.

**Requirements:**
- CLI accepts exactly one source form: positional `input-dir`, or both `--garment-dir` and `--model-dir`; mixed/incomplete forms return `NEEDS_INPUT` and exit `2` before any provider call.
- Dual roots must be distinct and neither may contain the other; violation returns `VALIDATION_ERROR`.
- Dual mode scans both roots recursively, gives logical paths `garment/<relative>` and `model/<relative>`, assigns roles from the input side with `roleSource: 'input'`, and places all assets in one stable group without `VisionPort.classify`.
- Dual default output root is `<garment-parent>/<garment-name>-<model-name>-tryon-output`; explicit `--output-root` still wins.
- Single-root scanning, directory vocabulary, low-confidence questions and output exclusion remain unchanged.
- `--guided` adds unanswered global questions only for omitted `scope`, `pairing`, `size`, and `review_mode`, with recommendations `full`, quantity-aware pairing, `3:4`, and `manual`.
- Pairing recommendation is exact: equal counts → `pair`; more garments than models → `fixedModel`; more models than garments → `fixedClothing`.
- Guided questions use stable IDs, supported answer lists, reasons and recommendations; `applyAnswers` applies global answers to manifest/groups and recomputes tasks/cost.
- Choosing guided `auto` without an explicit retry limit uses `maxRetries: 1`; manual mode has no max-retries question.
- Non-guided new preflight defaults to `full`, `pair`, `3:4`, `manual`.
- Explicit `--max-retries` without `--review-mode` selects `auto` for legacy CLI compatibility; `--review-mode manual --max-retries ...` exits `2` as an invalid combination.
- `manual` maximum generation calls equals first-pass tasks; `auto` uses `firstPassTasks × (1 + maxRetries)`.
- `RunStore.verifyInputs` re-scans the recorded manifest input source and detects added, removed or changed files on either side.

**Test cases:**
- Guided structured root with no choices → exactly four unresolved global questions in one JSON result; applying every recommended answer produces ready/manual manifest.
- Guided input with explicit scope and size → only pairing and review-mode questions remain.
- Two sibling directories with 2 garments and 1 model → zero classify calls, stable logical paths, one group, fixedModel recommended, and deterministic output root.
- Dual empty model directory, one missing flag, or positional plus dual flags → exit `2`; nested dual roots → `VALIDATION_ERROR`; every case has zero image generation calls.
- Same dual bytes/paths and run seed → stable asset/group/task/question IDs.
- Add/change/delete a file on either dual side after preflight → `INPUT_CHANGED` before resume/retry provider calls.
- Existing non-guided single-root CLI test with explicit choices → unchanged ready behavior.

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：input-source 模块缺失、explicit input role 被误判为 directory、guided 参数未生效等 tracer cases 均按预期失败。
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**：计划 focused 命令 4 个文件共 31 个用例与 `pnpm typecheck` 全部退出 `0`；额外 classifier/preflight/runner/resume 回归 4 个文件共 25 个用例通过。
- [x] **Step 5: Commit**：`feat: add guided dual-source preflight`

**进展（2026-08-30）：** 新增 single/dual input-source 归一、双目录侧别角色与稳定逻辑路径、四项 guided questions、quantity-aware pairing 推荐、manual 成本与 `--max-retries` 自动模式兼容。run store 现按 manifest input 统一重扫并检测双侧新增、改动和删除。

### Task 3: Manual-first Generation State Machine

**Files:**
- Modify: `src/run/runner.ts`
- Modify: `src/cli.ts`
- Modify: `tests/runner.test.ts`
- Modify: `tests/resume.test.ts`
- Modify: `tests/review-runner.test.ts`
- Modify: `tests/helpers/run-fixture.ts`

**Interfaces:**
- Consumes: `RunManifest.reviewMode` and `RunSummary.awaitingHumanReview` from Task 1.
- Keeps: `runManifest(manifestPath: string, deps: RunnerDeps): Promise<RunSummary>`.
- Keeps: `resumeRun(runDir: string, deps: RunnerDeps): Promise<RunSummary>`.
- Keeps: `runSelectedTasks(runDir: string, taskIds: ReadonlySet<string>, deps: RunnerDeps): Promise<RunSummary>`.

**Requirements:**
- In manual mode, successful generation sets the current version as `selectedVersionId`, leaves task status `generated`, increments `awaitingHumanReview`, and returns without calling `VisionPort.verify`.
- A run whose manual tasks are all `generated` or `generation_failed` ends with run status `completed`; `generated` is terminal only for manual mode.
- Manual summary excludes `generated` from `pending` and includes it in `awaitingHumanReview`.
- Resume skips valid `generated` tasks in manual mode; auto mode still reviews a recovered/existing `generated` task.
- Auto mode preserves the existing pass/retry/fix/maxRetries behavior and existing status meanings.
- V1 manifests normalized by Task 1 execute in auto mode.
- Manual mode still permits the vision calls required for garment brief preparation; only automatic output verification is disabled.
- Generation failure isolation, transport retries, atomic state writes and interruption behavior remain unchanged.

**Test cases:**
- Manual run with 3 tasks → 3 generated versions, 0 verify calls, 0 automatic retries, 3 awaitingHumanReview, run completed.
- Resume the completed manual run → 0 new generation calls and 0 verify calls.
- Abort one manual task after siblings generate → resume only unfinished work, preserving existing versions.
- Explicit auto run retry→pass and retry→limit fixtures → existing completed/review_failed behavior unchanged.
- Parsed v1 run with a generated task → resume invokes verify instead of treating it as manual terminal.

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：3-task manual tracer 首次观察到 3 次 verify，按预期证明旧 auto 路径仍在运行。
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**：runner/resume/review-runner 3 个 focused 文件共 19 个用例与 `pnpm typecheck` 全部退出 `0`；CLI 11 个回归用例另行通过。
- [x] **Step 5: Commit**：`feat: make human review the default run mode`

**进展（2026-08-30）：** manual run 在首图原子落盘后停于 `generated`，summary 单独统计 awaitingHumanReview，run 可正常 completed；resume 跳过有效候选并只继续未完成任务。auto retry/fix/上限语义与 persisted v1→auto 恢复均保留。

### Task 4: Validated Human Selection Retry

**Files:**
- Create: `src/review/manual-selection.ts`
- Create: `tests/manual-selection.test.ts`
- Modify: `src/review/retry.ts`
- Modify: `src/cli.ts`
- Modify: `tests/retry.test.ts`
- Modify: `tests/cli.test.ts`

**Interfaces:**
- Produces: `HumanDecision = 'pass' | 'redo'`.
- Produces: `HumanReviewSelection = { schemaVersion: 1; kind: 'fashion-tryon-retry-selection'; runId: string; exportedAt: string; decisions: HumanReviewDecision[] }`.
- Produces: `HumanReviewDecision = { taskId: string; versionId: string; decision: HumanDecision; reason?: string }`, with unique task IDs and reason length `0..500` characters.
- Produces: `parseHumanReviewSelection(input: unknown): HumanReviewSelection`.
- Extends: `RetrySelector = { taskIds: readonly string[] } | { reviewFailed: true } | { selection: HumanReviewSelection }`.
- Produces: `RetryPlan = { runId: string; reviewMode: ReviewMode; taskIds: string[]; maximumGenerationCalls: number }`.
- Produces: `planRetryTasks(runDir: string, selector: RetrySelector): Promise<RetryPlan>` with no mutation/provider calls.
- Keeps: `retryTasks(runDir: string, selector: RetrySelector, deps: RunnerDeps): Promise<RunSummary>`, revalidating immediately before mutation.
- Extends CLI: `fashion-tryon retry <run-dir> (--task <id...> | --review-failed | --selection <file>) [--dry-run] [--json]`.

**Requirements:**
- Exactly one retry selector is required; `--dry-run` validates and returns `selectedTasks` plus `maximumGenerationCalls` without loading providers or modifying files.
- Selection parsing rejects wrong kind/schema, invalid ISO timestamp, duplicate task IDs, invalid decision, missing version ID and reason over 500 characters.
- Direct selection parsing uses `VALIDATION_ERROR`; the CLI presents all user-correctable selection and staleness failures as `NEEDS_INPUT` with exit `2`.
- Selection retry rejects a wrong run ID, unknown task, version not owned by task, version no longer equal to `selectedVersionId`, and zero redo decisions before any provider call.
- Selection validation is all-or-nothing; a single invalid redo item prevents every mutation and generation.
- Pass decisions are retained in JSON but excluded from RetryPlan task IDs.
- Manual RetryPlan maximum calls equals redo task count; auto mode maximum calls equals redo task count × `(1 + maxRetries)`.
- A non-empty human reason appends exactly one repair section headed `【人工返工要求】只修复以下问题；未点名的一切必须保持不变。`; blank reason reuses the base prepared prompt.
- In manual mode, each selected task appends exactly one generated version and returns to `generated`; no verify or automatic retry follows.
- Retry events record selector source, checked version ID and whether a reason was supplied; they do not log the full reason separately from the version prompt.
- Existing `--task` and `--review-failed` behavior remains available; both also support `--dry-run`.

**Test cases:**
- Valid selection with 3 pass and 2 redo → plan contains only 2 stable task IDs and manual maximum calls 2.
- Same selection against auto run with maxRetries 1 → maximum calls 4.
- Wrong run, stale selected version, unknown task, duplicate decision, empty redo or 501-character reason → exit `2`, unchanged state/events, 0 provider calls.
- Dry-run valid selection → one JSON result, no provider construction, no state/report mtime change.
- Execute manual selection with one reason and one blank reason → exactly 2 new versions, 0 verify calls, old versions retained, only first new prompt has human repair section.
- Existing task-ID and review-failed selectors → previous focused tests remain green.

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：manual-selection 模块、RetryPlan 与 CLI selection/dry-run tracer cases 均按预期因接口不存在而失败。
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**：manual-selection/retry/CLI 3 个 focused 文件共 29 个用例与 `pnpm typecheck` 全部退出 `0`。
- [x] **Step 5: Commit**：`feat: retry validated human selections`

**进展（2026-08-30）：** 新增版本化 selection schema、只读 RetryPlan 与 CLI `--selection/--dry-run`。run/task/version/current-candidate/非空 redo 在 mutation/provider 前整体校验；manual 返工每任务只追加一版，非空原因进入独立人工返工段，事件只记来源、核对版本与是否有原因。

### Task 5: Swiss Research Batch Review Ledger

**Files:**
- Modify: `src/report/render.ts`
- Rewrite: `src/report/template.ts`
- Modify: `tests/helpers/report-fixture.ts`
- Modify: `tests/report.test.ts`
- Modify: `tests/report-browser.test.ts`

**Interfaces:**
- Consumes: normalized `RunManifest`, `RunState`, review ledger and events from Tasks 1–3.
- Extends: `ReportModel` with `reviewMode`, `summary.awaitingHumanReview`, and task-level `reviewable`, `candidateVersionId`, `candidateImage`, `aiAdvisory: 'pass' | 'redo' | 'not_run'`.
- Keeps: `buildReportModel(runDir: string): Promise<ReportModel>`.
- Keeps: `renderReportHtml(model: ReportModel): string` and `writeReport(runDir: string): Promise<{ reportPath: string }>`.
- Produces DOM hooks: `[data-review-task]`, `[data-task-id]`, `[data-version-id]`, `[data-human-decision]`, `[data-filter]`, `[data-search]`, and `[data-next-unchecked]` for Task 6.

**Requirements:**
- Implement the Report Design Lock above and the full Swiss Research constraints from the Spec.
- Top area shows black rule, run reference, title, review mode, dates and run status without a full-screen hero.
- Desktop uses a sticky context sidebar and main ledger; below 900px it becomes one column; print hides sidebar/actions and keeps evidence captions.
- Data cards expose total, unchecked, pass, redo and generation errors; human counts initially treat every reviewable task as unchecked until Task 6 restores draft state.
- Main task overview is a semantic table with 2px top/bottom rules, 1px row rules, zebra rows, yellow row hover/current state and emphasized first column.
- Search matches task ID, group name, garment name and model name; filters are all/unchecked/pass/redo/generation errors.
- Each row shows sequence, task/style, scope, generation status, version count, AI advisory and human decision controls.
- Expandable evidence uses garment → candidate → original model, bordered images and captions; history/prompt/AI issues/errors/uncertainties remain secondary details.
- Auto review is labeled `AI 建议`; manual decision has a separate column and cannot inherit an AI verdict.
- Missing images have explicit placeholders; every dynamic string remains escaped/redacted.
- A 40-task report at 1440px and 1280px has no document-level horizontal overflow and no external requests.

**Test cases:**
- Mixed manual/auto model → correct candidate, reviewable, AI advisory and awaiting-human fields.
- 40-task HTML → all task rows/IDs present, one semantic table, context sidebar, data cards and required DOM hooks.
- CSS output → contains exact palette/top rule/grid/table hierarchy and contains no `linear-gradient`, `radial-gradient`, `box-shadow`, serif family or radius over 6px.
- Search by group/filename and generation-error filter → exact visible row counts.
- Expand one row → three evidence figures and version details visible; no network/page errors.
- 1440×900、1280×800、390×844 → no document overflow; small viewport exposes one-column reading order.

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：manual candidate model 与 40-task semantic table/Swiss hooks 用例按预期失败。
- [x] **Step 3: 按 Report Design Lock 做最小完整实现，并在写 CSS 前再次核对禁止项；引用的 `swiss-research-system/DESIGN.md` 在仓库、workspace 与已安装 skills 中均不存在，已以 spec/plan 的完整 Design Lock 为准。**
- [x] **Step 4: 运行确认通过**：report/report-browser 2 个 focused 文件共 7 个用例与 `pnpm typecheck` 全部退出 `0`；Playwright 在 1440×900、1280×800、390×844 下零网络、无横向溢出。
- [x] **Step 5: Commit**：`feat: rebuild report as a Swiss review ledger`

**进展（2026-08-30）：** 报告改为黑色基准线、五项数据卡、sticky 语境侧栏与唯一语义任务表；生成状态、AI 建议和人工决定分列。40-task 搜索/筛选/下一条未检查、三联证据、历史与错误次级信息、窄屏单列及打印规则均已覆盖；色板仅黑白灰黄，无渐变、阴影、衬线标题或大圆角。

### Task 6: Persistent Decisions and JSON Round-trip

**Files:**
- Modify: `src/report/template.ts`
- Modify: `tests/report.test.ts`
- Modify: `tests/report-browser.test.ts`

**Interfaces:**
- Consumes: `HumanReviewSelection` contract from Task 4 and DOM hooks from Task 5.
- Produces browser draft key: `fashion-tryon:human-review:v1:<runId>`.
- Produces download filename: `retry-selection-<runId>.json`.
- Produces controls labeled `通过`, `重做`, `清除判断`, `下一条未检查`, `导入验收 JSON`, `导出验收 JSON`, and `清空本次人工记录`.

**Requirements:**
- Every reviewable task has mutually exclusive unchecked/pass/redo state; redo exposes an optional 500-character reason.
- Save decision, reason and checked candidate version after every change; restore them after reload/reopen for the same run.
- A stored decision whose version differs from the current candidate is removed for that task, returned to unchecked and reported as an expired choice.
- Storage keys isolate runs; unavailable/denied browser storage leaves current-page review usable and shows a warning rather than crashing.
- Clear-all requires explicit browser confirmation and never runs automatically.
- Next-unchecked moves focus and scroll to the next visible unchecked task, wrapping once to the first; when none remain it announces completion.
- Search/filter/expand state is not persisted; decisions and reasons are.
- Export includes only pass/redo decisions in report task order and emits the exact Task 4 schema with current version IDs and ISO `exportedAt`.
- Import validates the complete file before applying anything; schema/run/task/version/reason errors reject the entire import and preserve the existing draft.
- Import/export use local browser file APIs only, issue no network requests and never edit run JSON.
- Imported/user-entered reason text is rendered through text content, never HTML interpretation.
- Human count cards and filters update immediately after restore, decision, clear and import.

**Test cases:**
- Mark one pass and one redo with reason → cards/filters update; reload and regenerated same report path restore both.
- Open a different run → no decisions leak across run IDs.
- Replace one task candidate version then regenerate → only that decision expires and warning names one expired item.
- Export download → filename and parsed JSON exactly match Task 4 schema and omit unchecked tasks.
- Clear browser draft, import exported file → identical decisions/reasons/counts restored.
- Import wrong run, stale version, unknown task, duplicate task, malformed JSON or 501-character reason → zero draft changes and visible error summary.
- localStorage throws and reason contains `<img onerror=...>` → UI remains usable, no script execution/page error/network request.
- Keyboard tab/space/enter completes filter, expand, pass, redo, reason, import trigger and export actions with visible focus.

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：刷新恢复用例先因原因输入缺失失败；补齐完整矩阵后，版本账本同步与测试 matcher 接线按预期暴露失败。
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**：`pnpm exec vitest run tests/report.test.ts tests/report-browser.test.ts --reporter=dot && pnpm typecheck && git diff --check` 全部退出 `0`；2 个文件共 13 个用例通过，存储降级/XSS 用例与 viewport 用例均为零外部网络、零 page error。
- [x] **Step 5: Commit**：`feat: persist and export human review decisions`

**进展（2026-08-30）：** 报告以 `fashion-tryon:human-review:v1:<runId>` 按 run 保存通过/重做/原因/候选版本，刷新、重开和同 run 重建均恢复；候选变化只淘汰对应旧判断。人工清单按 Task 4 严格 schema 原子导入并稳定导出，支持确认清空、键盘操作和可见焦点；浏览器拒绝存储时保留当前页能力与持续警告，用户原因仅按文本处理。

### Task 7: Skill, Documentation, Fake E2E, and Milestone Closeout

**Files:**
- Modify: `skills/fashion-tryon/SKILL.md`
- Modify: `skills/fashion-tryon/references/workflow.md`
- Modify: `docs/USAGE.md`
- Modify: `docs/fashion-tryon-usage-guide.html`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/INPUT_OUTPUT.md`
- Modify: `docs/SECURITY.md`
- Modify: `README.md`
- Modify: `tests/e2e-fake.test.ts`
- Modify: `tests/skill-contract.test.ts`
- Modify: `docs/plans/2026-08-30-v2-guided-human-review.md`

**Interfaces:**
- Consumes: guided preflight from Task 2, manual runner from Task 3, retry dry-run/selection from Task 4, and report workflow from Tasks 5–6.
- Produces: Agent flow `preflight --guided → batch questions → run cost confirmation → run → report`.
- Produces: Agent retry flow `retry --selection ... --dry-run → retry cost confirmation → retry --selection ... → report`.
- Keeps: CLI JSON stdout as the only Skill execution Interface.

**Requirements:**
- Skill accepts one structured path or garment/model paths; it never asks users to compose the old full parameter sentence.
- Skill asks only unresolved CLI questions in one batch, puts recommendations first, supports the reply “按推荐”, and repeats only newly returned questions.
- When the host exposes structured question controls, Skill uses them for the batch; otherwise it renders one concise numbered list with the same allowed answers.
- Before first generation it reports `firstPassTasks`, selected review mode and `maximumGenerationCalls`; before selection retry it reports dry-run `selectedTasks` and `maximumGenerationCalls`.
- Skill never interprets report localStorage, hand-picks task IDs, constructs provider HTTP requests or asks for credential values.
- Completion returns clickable `runDir` and `reportPath` and explains `人工标记 → 导出 JSON → 把 JSON 交给 Agent 重做` in one sentence.
- Usage guide leads with short path examples and a simple five-step visual; the complete CLI syntax remains a secondary troubleshooting reference.
- Architecture/input-output/security docs explicitly separate run facts, browser draft and exported selection artifact.
- Fake e2e covers dual guided preflight, recommended manual answers, run with no verify calls, report generation, selection dry-run and one-task manual retry with preserved v1.
- Skill passes the official `quick_validate.py`; tracked/generated artifacts pass secret scan.
- Closeout performs one stage-level Playwright screenshot inspection at 1440×900 and 390×844 against a 40-task fixture; no repeated per-edit screenshots.
- Paid e2e remains skipped; no production provider call occurs in this milestone.

**Test cases:**
- Skill text orders guided preflight before questions/run/report, documents both path forms and selection dry-run, and contains no provider URL/key field/business implementation.
- Full fake journey → four guided questions, manual first-pass cost equals task count, zero verify calls, persisted report selection, dry-run cost one, one new version after retry.
- Usage HTML opens with zero network and visibly explains path → four short answers → cost confirmation → generation → human selection/JSON retry.
- Full regression retains all v1 auto, resume, report, security and CLI tests.

- [x] **Step 1: 按上述 cases 写失败测试并更新文档合同断言**
- [x] **Step 2: 运行 focused e2e/Skill 验证确认失败**：fake v2 纵向旅程先通过；旧 Skill、文字说明与可视化指南的 guided/manual/selection 合同共 3 个用例按预期失败。
- [x] **Step 3: 最小更新 Skill、使用说明和架构文档，并完成 fake e2e**
- [x] **Step 4: 运行 stage-closing gates**：`pnpm test && pnpm typecheck && pnpm build`、官方 quick validator 与 `node scripts/scan-secrets.mjs` 全部退出 `0`；24 个文件 154 passed、1 个付费用例 skipped。系统 Python 缺 PyYAML，官方脚本通过 uv 临时依赖运行且未改项目/全局依赖。40-task 报告在 1440×900 与 390×844 完成唯一一次阶段截图检查，无截断或横向溢出；bundled playwright wrapper 不可用，使用仓库锁定的 Playwright 1.58 CLI。
- [x] **Step 5: 更新本 plan 勾选与最终进展，确认 `git diff --check` 通过后 Commit**：`feat: deliver guided human review workflow`

**进展（2026-08-30）：** Skill 入口改为单目录/双目录 guided 短启动，按 CLI recommendation 批量回答，首次生成与 selection retry 均在 dry-run/成本字段之后取得授权；Skill 不读取 localStorage 或复制业务逻辑。README、文字/可视化指南和架构/输入输出/安全文档统一 manual 主线及“运行事实—浏览器草稿—导出清单”边界；fake v1 与 v2 全链路、离线页面、Skill 校验、构建和秘密扫描全部通过。

## Plan Self-check

- Spec B1 → Tasks 1、4、6；报告草稿与运行账本边界已覆盖。
- Spec B2 → Tasks 1–2；单／双目录和历史兼容已覆盖。
- Spec B3 → Tasks 2、7；四项集中提问、推荐答案和付费确认已覆盖。
- Spec B4 → Tasks 1、3、5；manual 默认、auto 可选和 v1 语义已覆盖。
- Spec B5 → Task 5；Swiss Research、40-task、table/sidebar/data-card、responsive/print/accessibility 已覆盖。
- Spec B6 → Task 6；三态、原因、按 run 保存、过期、清空已覆盖。
- Spec B7 → Tasks 4、6；selection schema、原子导入、显式导出已覆盖。
- Spec B8 → Tasks 3–4、7；dry-run 成本、严格验证、单次 manual 追加和审计已覆盖。
- Spec B9 → Task 7；最短 Skill 启动、selection retry 和使用说明已覆盖。
- 验收 1–2 → Task 2；验收 3–4 → Tasks 1、3；验收 5–7 → Task 5；验收 8–9 → Task 6；验收 10–11 → Task 4；验收 12 → Tasks 5–7。
- 新增跨任务类型只在前序 Task 1 或 Task 4 定义；后续签名使用 `ManifestInput`、`ReviewMode`、`HumanReviewSelection`、`RetryPlan` 的同一名称。
- 无未定义类型、未决占位、通用“错误处理”占位或预写实现代码。

## Final Acceptance (2026-08-30)

- 独立代码审查覆盖数据完整性、并发/恢复、LLM 信任边界和新增枚举消费者；唯一实质问题是人工原因可被模型误作命令，已改为不可信 JSON 数据并在其后重申不可覆盖约束，注入型回归测试通过。
- 验收 1–4 由 contracts/preflight/runner/resume/review-runner/CLI/fake E2E 覆盖：单/双目录、集中问题、manual 默认、auto 与 v1 兼容均通过。
- 验收 5–9 由 40-task report fixture 与 Playwright 覆盖：1440×900、1280×800、390×844 无横向溢出或外部网络，Swiss 账本、三联证据、键盘操作、草稿恢复/过期和 selection 往返均通过。
- 验收 10–12 由 manual-selection/retry/CLI/report-browser/Skill contract 覆盖：精确追加、付费前整体拒绝、原因文本与 prompt 信任边界、无绝对输入路径/密钥及可访问性均通过。
- 最终门禁：`pnpm test` 为 24 files、154 passed、1 paid gate skipped；`pnpm typecheck`、`pnpm build`、官方 Skill quick validator、tracked secret scan 与 `git diff --check` 全部退出 `0`。
- 用户授权的真实验证使用双目录 1×1、`manual`、transport retry 关闭：首轮实际 1 次生成后停在 1 条待人工检查；selection dry-run 选中 1 项、上限 1 且账本 hash 不变，真实 retry 只追加 v02 并保留 v01，两个 896×1200 PNG 的账本 hash 均有效，自动 verify 为 0；旧 v01 selection 随后以退出码 2 整体拒绝且账本不变。真实 run/selection secret scan 通过，报告与 selection 不含绝对输入路径，证据保存在 Git 忽略的本机 acceptance record。
- 剩余风险仅在 provider 输出质量：真实 v02 可读且产生新候选，但小字仍可能失真，模型也可能在被要求保持时改变裁切；runner 能约束次数、版本和账本，不能保证生成模型逐字服从审美修复要求。
