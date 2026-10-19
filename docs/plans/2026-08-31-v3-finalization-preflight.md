# Fashion Try-on Runner v3 Implementation Plan

**Goal:** 交付“正式生图前可视计划确认 + 生图后人工采用、历史基线返工与可追溯定稿交付”的完整本地闭环。
**Architecture:** CLI 继续作为唯一外部 Interface；新增 `generation-plan`、`review-decisions` 与 `finalize` 三个深模块，分别隐藏计划指纹与 prepared 复用、人工版本事实与原子应用、交付阻塞检查与派生物生成。现有 `VisionPort` / `ImageGenerationPort` seams 保持不变，预检、人工决定和定稿都不新增 adapter 或远程调用。
**Tech Stack:** Node.js 20+、TypeScript、Commander、Zod、Sharp、Vitest、Playwright、原生文件系统与 `crypto`。

- Spec：`docs/specs/2026-08-31-v3-finalization-preflight.md`
- 状态：待执行
- 日期：2026-08-31

## Global Constraints

- v3 新 run 必须先生成离线 `preflight.html`，用户授权必须绑定当前 64 位 SHA-256 计划指纹；缺少、错误或过期指纹在构造生图 adapter 前退出 `2`。
- 计划指纹绑定输入内容、任务/配对、scope、prepared 文件 hash、比例、模型、review mode、自动重出上限和最高生成次数；任一变化都使旧授权失效。
- `preflight.html`、`report.html`、浏览器草稿与 `deliveries/` 都是可重建派生物；运行事实仍只来自 manifest/state/review/events。
- 输入素材只读；prepared、版本、预检和 delivery 只写 run 目录。
- 安全预设严格只允许 `scope`、`pairing`、`size`、`reviewMode`，必须显式选择；不保存路径、密钥、模型、自由文本或 `maxRetries`。
- `state.selectedVersionId` 继续表示当前候选；`review.acceptedVersionId` 独立表示人工采用版本。生成新候选不得自动改写采用版本。
- v3 返工基线绑定历史版本的 prompt lineage 与本地漂移比较；provider 仍只接收既有 garment/model prepared 输入，不把历史成图作为编辑底图。
- v1/v2 retry selection 继续按原语义可读；v3 artifact 的旧版本引用只要归属和 hash 有效即可作为采用或返工基线，不要求是最新候选。
- 默认定稿要求每个可运行任务已采用或显式不交付；每次成功定稿创建新的不可覆盖 delivery。
- Seedream 5 Pro、Wan、蒙版/框选编辑、OCR 与任何新 provider seam 均不在本计划内。
- 普通测试只使用 fake adapters 和本地合成图；本计划不运行真实 provider、不设置 `RUN_PAID_E2E=1`。
- 报告与预检页面以 `file://` 打开，零网络请求，不含密钥、完整远程响应或不必要的绝对私人路径。
- 每个 Task 完成真实 focused verification 后，才勾选本 plan、追加一行进展、按需更新 `PROJECT.md` 并创建该 Task 的 coherent commit。

## Planned File Structure

### Create

- `src/preflight/preset.ts`：严格读取安全预设并收敛显式值优先级。
- `src/preflight/generation-plan.ts`：生成 prepared 资产索引、风险、计划指纹并校验当前计划。
- `src/preflight/preview.ts`：从 generation plan 构建预检展示模型并原子写 `preflight.html`。
- `src/preflight/preview-template.ts`：离线配对矩阵、工作副本和风险页面。
- `src/run/approval.ts`：验证并持久化首次生成授权，不接触 provider。
- `src/review/decisions.ts`：整体验证和原子应用 v3 人工决定。
- `src/delivery/finalize.ts`：计算定稿阻塞、创建不可覆盖 delivery 与映射。
- `src/delivery/template.ts`：渲染离线最终 contact sheet。
- `examples/presets/elle-full-3x4-manual.json`：只包含四个白名单选择的安全预设示例。
- `tests/preset.test.ts`、`tests/generation-plan.test.ts`、`tests/preflight-preview.test.ts`、`tests/preflight-preview-browser.test.ts`、`tests/approval.test.ts`、`tests/review-decisions.test.ts`、`tests/finalize.test.ts`、`tests/finalize-browser.test.ts`：v3 focused verification。

### Modify

- `src/contracts.ts`：canonical manifest/state/review v3 facts 与历史只读规范化。
- `src/preflight/preflight.ts`：预设来源、v3 manifest 与待确认状态。
- `src/prepare/images.ts`：复用已获批 prepared 资产，不重复编码。
- `src/run/store.ts`：计划、授权、采用/排除/返工基线与 delivery 前的完整性检查。
- `src/run/runner.ts`：首次授权门禁、候选/采用分离和显式历史基线恢复。
- `src/review/manual-selection.ts`、`src/review/retry.ts`：selection v3 与基线 prompt lineage。
- `src/report/render.ts`、`src/report/template.ts`：版本比较、采用/不交付/基线交互与 v3 artifact。
- `src/cli.ts`：新增 `plan`、`review`、`finalize`，并给 `run` 增加计划授权。
- `scripts/scan-secrets.mjs`：覆盖 preflight 与 deliveries。
- `skills/fashion-tryon/SKILL.md`、`skills/fashion-tryon/references/workflow.md`：更新 Agent 主路径。
- `README.md`、`docs/USAGE.md`、`docs/INPUT_OUTPUT.md`、`docs/ARCHITECTURE.md`、`docs/SECURITY.md`、`docs/fashion-tryon-usage-guide.html`、`HANDOFF.md`：同步 v3 合同与教程。
- `tests/contracts.test.ts`、`tests/preflight.test.ts`、`tests/prepare-images.test.ts`、`tests/run-store.test.ts`、`tests/runner.test.ts`、`tests/resume.test.ts`、`tests/manual-selection.test.ts`、`tests/retry.test.ts`、`tests/report.test.ts`、`tests/report-browser.test.ts`、`tests/cli.test.ts`、`tests/e2e-fake.test.ts`、`tests/skill-contract.test.ts`、`tests/helpers/run-fixture.ts`、`tests/helpers/report-fixture.ts`：兼容与端到端覆盖。

### Task 1: Canonical v3 Facts and Safe Presets

**Files:**

- Modify: `src/contracts.ts`
- Create: `src/preflight/preset.ts`
- Create: `examples/presets/elle-full-3x4-manual.json`
- Modify: `tests/contracts.test.ts`
- Create: `tests/preset.test.ts`
- Modify: `tests/helpers/run-fixture.ts`

**Interfaces:**

- Produces: `SafePresetValues` with optional `scope`、`pairing`、`size`、`reviewMode` only.
- Produces: strict `SafePreset` `{ schemaVersion: 1, kind: 'fashion-tryon-safe-preset', name, values }`; `name` is trimmed, non-empty and at most 80 characters; `values` contains at least one allowed field.
- Produces: `loadSafePreset(filePath: string): Promise<SafePreset>` and `resolveSafePreset(preset: SafePreset | undefined, explicit: SafePresetValues): { values: SafePresetValues; sources: Partial<Record<keyof SafePresetValues, 'explicit' | 'preset'>> }`; explicit values win.
- Produces: canonical `RunManifest` schemaVersion `3`, adding optional preset snapshot, per-choice source, `generationPlan`, and status `needs_input | awaiting_approval | ready`.
- Produces: `GenerationPlan` `{ schemaVersion: 1, digest, createdAt, imageModel, visionModel?, size, reviewMode, maxRetries, firstPassTasks, maximumGenerationCalls, preparedAssets, tasks, warnings }`.
- Produces: exported `GenerationApproval` `{ planDigest, approvedAt }` and canonical `RunState` schemaVersion `2`, adding optional `generationApproval` plus task-level `pendingBaselineVersionId`.
- Produces: canonical `RunReview` schemaVersion `2`; each task exposes `candidateVersionId?`、`acceptedVersionId?`、`excluded?: { decidedAt, reason? }`、`pendingRedo?: { baselineVersionId, control, decidedAt }` and `versions: VersionReview[]`.
- Consumes: persisted manifest v1/v2、state v1 and review v1; parsers normalize them in memory without writing files or inferring an accepted version.

**Requirements:**

- `GenerationPlan.digest` and all stored image hashes are exactly 64 hexadecimal SHA-256 characters.
- A planned asset records `assetId`、`preparedRelativePath`、`sha256`、`width`、`height`、`bytes`、`cropped`、optional `cropBox` and warnings.
- A planned task records `taskId`、`groupId`、`garmentAssetId`、`modelAssetId`、`scope` and `pairing`.
- Plan warning codes are limited to `duplicate_content`、`crop_fallback`、`answered_question`、`skipped_input` and `uncertainty`; each has a safe message and optional asset/group/task ID.
- `acceptedVersionId` and `excluded` are mutually exclusive; `pendingRedo` may coexist with an accepted version but not with exclusion.
- `pendingBaselineVersionId` and every review version reference must belong to the same task.
- Presets reject unknown fields, blank names, empty values, paths, model IDs, `maxRetries`, secrets and free text.
- The example preset is named `ELLE 全身 3:4 人工验收` and resolves exactly to `full`、`pair`、`3:4`、`manual`.

**Test cases:**

- Valid manifest/state/review v3 facts → strict round-trip with plan, approval, accepted version and pending redo preserved.
- Persisted manifest v1/v2、state v1、review v1 → canonical v3/v2 objects in memory; source bytes before/after parsing remain identical and acceptedVersionId stays absent.
- Review with accepted + excluded, excluded + pendingRedo, or a version from another task → validation failure.
- Valid preset and the checked-in ELLE example → exact four values and preset sources.
- Explicit `size: 1:1` over preset `size: 3:4` → final `1:1` with source `explicit`; other preset values remain.
- Preset containing `model`、`maxRetries`、`inputPath`、unknown field or empty values → `VALIDATION_ERROR` before manifest mutation.

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：`pnpm exec vitest run tests/contracts.test.ts tests/preset.test.ts`，如预期因 v3 schemas/preset module 不存在和旧 schema 不接受新字段而失败。
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**：focused 合同/预设命令 34 项通过；canonical consumers 合并验证 65 项通过；`pnpm exec tsc --noEmit` 退出 `0`。
- [x] **Step 5: Commit**：更新本 plan 进展后提交 `feat: establish v3 planning and review contracts`。

### Task 2: Approval-bound Generation Plan

**Files:**

- Create: `src/preflight/generation-plan.ts`
- Modify: `src/preflight/preflight.ts`
- Modify: `src/prepare/images.ts`
- Modify: `src/run/store.ts`
- Create: `tests/generation-plan.test.ts`
- Modify: `tests/preflight.test.ts`
- Modify: `tests/prepare-images.test.ts`
- Modify: `tests/run-store.test.ts`

**Interfaces:**

- Consumes: ready canonical `RunManifest`、`SafePreset` snapshot、`prepareAsset(asset: ManifestAsset, options: PrepareImageOptions): Promise<PreparedAsset>` and `openRunStore(runDir): Promise<RunStore>`.
- Produces: `buildGenerationPlan(runDir: string, deps?: { clock?: () => Date }): Promise<GenerationPlan>`; prepares each referenced asset once, persists the plan in manifest, sets status `awaiting_approval`, and appends safe events.
- Produces: `loadGenerationPlan(runDir: string): Promise<GenerationPlan>`; rejects a missing plan with `NEEDS_APPROVAL`.
- Produces: `assertGenerationPlan(runDir: string, expectedDigest: string): Promise<GenerationPlan>`; verifies current inputs, canonical digest and every prepared file hash.
- Extends: `PrepareDeps.generationPlan?: GenerationPlan`; `prepareTask` uses approved planned assets when present and retains the historical prepare fallback only for old manifests.
- Extends: `RunStore.verifyInputs()` to verify planned prepared paths remain under `<run>/prepared/`, exist, and match stored SHA-256.

**Requirements:**

- Plan creation requires all required questions answered and at least one runnable task; otherwise it throws `NEEDS_INPUT` with unresolved question IDs or `NO_RUNNABLE_TASKS` without partial plan persistence.
- Assets are prepared in stable manifest order, deduplicated by asset ID, and written as `prepared/<asset-id>.jpg` using the existing `1_000_000` byte、`1600` edge、quality `85` contract.
- Digest input includes run/input fingerprint、resolved task order and pairings、scope、planned prepared hashes/crop data、size、image/vision model IDs、review mode、maxRetries、first-pass count、maximum calls、preset snapshot and choice sources; it excludes `createdAt` and the digest field itself.
- Rebuilding unchanged inputs/config produces the same prepared hashes and digest. A changed input byte, pair, scope, crop, model, size, review mode, maxRetries or preset value produces a different digest.
- Exact duplicate source content is reported once per duplicate set without removing tasks. Missing/invalid garment bbox produces `crop_fallback` and uses the full prepared image.
- Answered preflight questions, skipped inputs and uncertainties remain visible as structured warnings.
- Plan creation and assertion accept no `VisionPort` or `ImageGenerationPort` dependency and create zero provider calls.
- A v3 task may not silently re-encode a different prepared image after approval; missing/changed planned bytes yield `INTEGRITY_ERROR` or `NEEDS_APPROVAL` before generation.

**Test cases:**

- Ready two-task manifest with one shared model → three unique prepared assets, two planned tasks, one 64-char digest and zero fake provider calls.
- Two assets with the same content hash → both tasks remain while one deterministic `duplicate_content` warning identifies the duplicate set.
- Garment with bbox vs garment without bbox → cropped record vs `crop_fallback`/full-image record, with hashes matching disk.
- Two unchanged builds with different clocks → identical digest and prepared hashes; only `createdAt` differs.
- Mutate each bound field independently → digest changes; restoring it restores the prior digest.
- Delete or edit a prepared file after planning → `assertGenerationPlan` fails before any provider construction.
- `prepareTask` given a plan → reads the exact planned garment/model hashes and calls `getGarmentBrief`; historical manifest without plan still calls `prepareAsset` before `getGarmentBrief`.

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：focused 命令如预期因 generation-plan Interface 不存在与预设尚未接入而失败。
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**：同一 focused 命令 28 项全部通过；`pnpm exec tsc --noEmit` 退出 `0`。
- [x] **Step 5: Commit**：更新本 plan 进展后提交 `feat: build approval-bound generation plans`。

### Task 3: Offline Visual Preflight Report

**Files:**

- Create: `src/preflight/preview.ts`
- Create: `src/preflight/preview-template.ts`
- Create: `tests/preflight-preview.test.ts`
- Create: `tests/preflight-preview-browser.test.ts`
- Modify: `tests/helpers/run-fixture.ts`

**Interfaces:**

- Consumes: `GenerationPlan` and canonical manifest from Tasks 1–2.
- Produces: `PreflightReportModel` containing run identity、plan digest、preset/final choices、model/review/cost summary、groups、pairing rows、prepared images and warnings; it exposes only run-relative image URLs.
- Produces: `buildPreflightReportModel(runDir: string): Promise<PreflightReportModel>`.
- Produces: `renderPreflightHtml(model: PreflightReportModel): string`.
- Produces: `writePreflightReport(runDir: string): Promise<{ preflightPath: string; planDigest: string }>`; writes `<run>/preflight.html` atomically.

**Requirements:**

- The report displays `planDigest` in full, run ID, input form, preset name, resolved scope/pairing/size/review mode/model IDs, run-relative output layout, first-pass tasks and maximum generation calls；绝对 output/source/prepared 路径只由 CLI 返回，不进入 HTML。
- The main ledger renders one stable row per task with group/task identity, garment thumbnail, model thumbnail, scope, pairing and crop/full-image status.
- Task detail shows the exact prepared garment/model working copies referenced by the plan, their dimensions/bytes/hash prefix, and garment crop box when present.
- Warnings are grouped by duplicate、crop fallback、answered question、skipped input and uncertainty; suspected mismatch language always says “需要人工确认” rather than “错误”.
- Dynamic names/messages are escaped; absolute source/prepared paths、keys、Authorization and base64 user images never enter HTML.
- HTML uses inline CSS/JS only, relative asset URLs, visible keyboard focus, printable plan digest/cost, and no action that can approve or start generation.
- Unchanged manifest/plan bytes regenerate byte-identical HTML; a missing/mismatched planned asset refuses rendering rather than presenting stale evidence.

**Test cases:**

- Synthetic mixed plan → HTML contains all task IDs、resolved choices、full digest、cost ceiling、crop/full fallback and every warning code; no absolute fixture root appears.
- Script-like group names/warnings → escaped text and no executable injection.
- Delete `preflight.html`, rebuild unchanged plan → byte-identical output.
- Corrupt a planned image → report build fails with integrity error and does not replace the previous valid HTML.
- Playwright opens a 40-task `file://` preview at `1440×900` and `390×844` → pairing ledger and details remain usable, body has no horizontal overflow, focus is visible and network request count is `0`.
- Print media → digest、task/cost summary and warning text remain visible; interactive-only affordances are absent.

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：focused 命令如预期因 preview modules 不存在而失败。
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**：同一 focused 命令 4 项全部通过；`pnpm exec tsc --noEmit` 退出 `0`；Playwright 覆盖 40 任务桌面、窄屏、打印、焦点与零网络。
- [x] **Step 5: Commit**：更新本 plan 进展后提交 `feat: render offline generation previews`。

### Task 4: CLI Plan Approval and Resume Gate

**Files:**

- Create: `src/run/approval.ts`
- Modify: `src/preflight/generation-plan.ts`
- Modify: `src/run/runner.ts`
- Modify: `src/run/store.ts`
- Modify: `src/cli.ts`
- Create: `tests/approval.test.ts`
- Modify: `tests/cli.test.ts`
- Modify: `tests/runner.test.ts`
- Modify: `tests/resume.test.ts`

**Interfaces:**

- Produces: `approveGenerationPlan(runDir: string, planDigest: string, deps?: { clock?: () => Date }): Promise<GenerationApproval>`; validates current plan, saves approval and appends `generation_plan_approved` before provider construction.
- Produces: `assertGenerationApproved(runDir: string): Promise<GenerationPlan>` for runner/resume; current plan digest must equal persisted approval.
- Adds CLI: `fashion-tryon plan <manifest-path> [--answers <answers.json>] [--json]`.
- Adds CLI option: `preflight ... --preset <preset.json>`.
- Adds CLI option: `run <manifest-path> --approve-plan <64-char-sha256> [--json]`.
- Retains: `run --answers <answers.json>` as a compatibility planning alias; it applies answers, builds plan/preview and returns `awaiting_approval` without generation. Combining `--answers` with `--approve-plan` is rejected.
- Plan JSON result: `{ command: 'plan', status: 'awaiting_approval', runId, runDir, manifestPath, preflightPath, planDigest, reviewMode, firstPassTasks, maximumGenerationCalls }`.

**Requirements:**

- `plan` applies answers atomically, returns unresolved questions with exit `2`, or builds generation plan + preflight report and exits `0` with `awaiting_approval`.
- New v3 first generation without `--approve-plan`, with malformed digest, or with a digest different from the current plan returns stable code `NEEDS_APPROVAL`/exit `2` before lazy production adapters are created.
- Valid approval is persisted before the first remote call, changes manifest status to `ready`, and is idempotent for the same digest.
- Rebuilding a different plan before execution clears the old approval and appends `generation_plan_invalidated`; rebuilding the same plan preserves it.
- Once v3 execution starts, answers/preset/plan mutation is rejected. Resume verifies current inputs, plan and approval but does not ask for a second authorization.
- An unstarted v3 run cannot use `resume` to bypass approval. A historical v1/v2 run that already started keeps existing resume behavior and is not rewritten to v3 on disk.
- The first-run approval authorizes only the manifest maximum; retry continues to require selection dry-run and separate authorization.
- JSON stdout remains one value; diagnostics remain stderr; no secret or approval token is written into report HTML.

**Test cases:**

- Guided preflight + answers through `plan` → `awaiting_approval`, valid preview path/digest and fake image provider count `0`.
- `run --answers` on unresolved legacy flow → same safe preview result and no generation; `--answers` + `--approve-plan` → exit `2`.
- Missing/bad/stale digest → `NEEDS_APPROVAL`, no state approval/event and production adapter factory count `0`.
- Valid digest for a three-task manual plan → approval persisted before exactly three generation calls.
- Change input、scope、size、model or prepared hash after approval → run/resume rejects before provider call.
- Abort after one written version then resume unchanged approved plan → completes remaining tasks without new approval or regenerating the written version.
- Unstarted v3 `resume` → rejected; started historical v2 `resume` → existing behavior and identical historical manifest bytes.
- Explicit preset at preflight → guided questions omit its four fields, manifest/preview retain values and source; invalid preset stops before run allocation/provider calls.

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：focused 命令如预期因 approval Interface、plan command 与 CLI options 不存在而失败。
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**：主 focused 命令 32 项通过，相邻 generation-plan/preview 回归 15 项通过；`pnpm exec tsc --noEmit` 退出 `0`。
- [x] **Step 5: Commit**：更新本 plan 进展后提交 `feat: gate generation on approved plans`。

### Task 5: Persisted Human Decisions and Historical Retry Baselines

**Files:**

- Modify: `src/review/manual-selection.ts`
- Create: `src/review/decisions.ts`
- Modify: `src/review/retry.ts`
- Modify: `src/run/runner.ts`
- Modify: `src/run/store.ts`
- Modify: `src/cli.ts`
- Modify: `tests/manual-selection.test.ts`
- Create: `tests/review-decisions.test.ts`
- Modify: `tests/retry.test.ts`
- Modify: `tests/run-store.test.ts`
- Modify: `tests/resume.test.ts`

**Interfaces:**

- Extends: `HumanReviewSelection` with schemaVersion `3`, kind `fashion-tryon-review-selection`, run ID/export time and unique task decisions.
- Produces v3 decisions:
  - `{ decision: 'accept', taskId, versionId }`.
  - `{ decision: 'unaccept', taskId, versionId }`, where versionId must equal the currently accepted version.
  - `{ decision: 'redo', taskId, baselineVersionId, repair?, preserve, preserveNote? }`.
  - `{ decision: 'exclude', taskId, reason? }`.
- Produces: `ReviewDecisionPlan` `{ runId, acceptedTaskIds, unacceptedTaskIds, redoTaskIds, excludedTaskIds, maximumGenerationCalls }`.
- Produces: `planHumanReviewDecisions(runDir: string, selection: HumanReviewSelection): Promise<ReviewDecisionPlan>` and `applyHumanReviewDecisions(runDir: string, selection: HumanReviewSelection, deps?: { clock?: () => Date }): Promise<ReviewDecisionPlan>`.
- Adds CLI: `fashion-tryon review <run-dir> --selection <file> [--dry-run] [--json]`.
- Extends: v3 `retry --selection` consumes applied `pendingRedo`, writes `pendingBaselineVersionId` before generation and uses the exact historical version for prompt lineage/local drift evidence.

**Requirements:**

- v3 selection is strict, rejects duplicate task IDs and caps optional reason/repair/preserveNote at 500 characters; redo requires at least one unique preservation dimension.
- Planning validates the entire artifact、run/task/version ownership、every referenced version hash and current accepted version for unaccept; any failure changes no files/events.
- Applying decisions is one atomic review mutation followed by safe events:
  - accept sets `acceptedVersionId`, clears exclusion, and does not change candidate.
  - unaccept clears only the matching accepted version.
  - exclude clears accepted/pending redo and records explicit exclusion.
  - redo records baseline/control, clears exclusion, and preserves any accepted version.
- Events record decision enum、task/version IDs、preserve list and text-presence booleans only; free text bodies never enter events.
- Pure review planning/application constructs no provider and reports redo cost without starting it.
- v3 retry requires the artifact's redo to match applied review facts; it may target any intact historical version and does not require current candidate equality.
- v3 retry prompt begins from `baselineVersion.prompt`, appends the normalized untrusted control, and local drift compares the same baseline image. Provider garment/model inputs remain those in the approved task preparation.
- `pendingBaselineVersionId`、prompt and control are persisted before provider invocation and inherited by orphan recovery. Success clears pending fields, sets only the new candidate, clears applied pending redo, and leaves acceptedVersionId unchanged.
- v1/v2 selection continues current-only stale checking and existing prompt compatibility; old `pass` does not become accepted.

**Test cases:**

- Valid v3 accept/unaccept/redo/exclude selection → strict parse/serialize round-trip; each illegal/mixed/extra field case fails.
- Dry-run mixed artifact → exact four task lists and manual/auto maximum, with byte-identical state/review/events and provider count `0`.
- Accept historical v01 while candidate is v02 → candidate remains v02, accepted becomes v01; a later v03 candidate does not change v01.
- Unaccept stale v01 after v02 was accepted、cross-run version、changed hash、duplicate task or one invalid decision among valid ones → entire application rejected.
- Exclude a generation-failed task → explicit exclusion persisted; no version is invented.
- Apply redo from v01 while v02 is candidate and v01 accepted → accepted v01 remains, pending baseline/control point to v01.
- Execute that redo → exactly one v03, prompt lineage starts from v01 prompt, localDrift baseline is v01, candidate becomes v03 and accepted remains v01.
- Crash after image write before state update → resume recovers v03 with the same baseline/control and no duplicate provider call.
- Audit search for repair/preserveNote/exclude reason bodies → none appear in events; version/run review retain only spec-authorized facts.

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：focused 命令如预期因 selection v3/decision Interface、review 引用校验和历史 baseline persistence 不存在而失败。
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**：同一 focused 命令 54 项全部通过；CLI review 定向测试 1 项通过；`pnpm exec tsc --noEmit` 退出 `0`。
- [x] **Step 5: Commit**：更新本 plan 进展后提交 `feat: persist human version decisions`。

### Task 6: Version Comparison and v3 Review Artifact

**Files:**

- Modify: `src/report/render.ts`
- Modify: `src/report/template.ts`
- Modify: `tests/report.test.ts`
- Modify: `tests/report-browser.test.ts`
- Modify: `tests/helpers/report-fixture.ts`

**Interfaces:**

- Consumes: canonical candidate/accepted/excluded/pendingRedo review facts and selection v3 from Tasks 1/5.
- Extends: `ReportTask` with separate candidate/accepted images and IDs、delivery disposition、pending baseline/control、finalization blocker and all historical versions.
- Produces: report browser draft key `fashion-tryon:human-review:v3:<runId>`; it can atomically migrate compatible v2 draft state without deleting the v2 key.
- Produces: strict report export of `fashion-tryon-review-selection` schemaVersion `3`; import validates the whole file before changing draft state.

**Requirements:**

- Task row and detail use distinct labels “当前候选” and “人工采用”; absence of accepted version is explicit.
- Every intact history version exposes “设为采用版本”“作为返工基线”“参与比较”; the accepted version exposes “取消采用”; task detail exposes explicit “不交付”.
- Actions change only browser draft. Persisted facts change only after exported artifact passes CLI `review`.
- Compare mode selects any two task versions, defaults to accepted vs candidate when both exist, and provides synchronized zoom/pan plus a keyboard-operable drag divider.
- Compare mode labels each version ID and decision role; local drift remains evidence text and never claims pixel editing or automatic quality approval.
- Candidate changes invalidate only draft actions bound to the prior candidate. Persisted accepted/excluded facts remain visible and are never cleared by localStorage migration.
- Report filters/counts include 未检查、已采用、待返工、不交付、漂移越界、生成异常 and a “距离可交付” blocker count.
- v3 export keeps manifest task order and includes only explicit draft decisions. v1/v2 import remains compatible; old pass/redo becomes a draft suggestion only, never a persisted adoption.
- Dynamic text is escaped; compare controls have visible focus/labels; print output shows candidate/accepted IDs and decisions but hides manipulators.

**Test cases:**

- Model with v01 accepted and v02 candidate → separate images/labels/IDs and finalization state; neither aliases the other.
- Four different tasks分别选择 v01 accept、对当前 accepted v02 执行 unaccept、从历史 v01 redo、exclude → exported JSON exactly matches v3 schemas and stable task order.
- Invalid import with one cross-run/unknown/changed version among valid decisions → existing draft remains byte-equivalent.
- Existing v2 localStorage pass/redo → v3 draft migration, v2 key retained, no accepted run fact synthesized.
- Generate a new candidate after an accepted version → only candidate-bound draft expires; accepted label and comparisons persist.
- Playwright compare v01/v02 → divider keyboard/mouse changes clipping, zoom/pan stays synchronized, version labels remain correct.
- Search/filter/next-unreviewed with 40 tasks at `1440×900`、`1280×800`、`390×844` → correct counts, no body overflow, visible focus, zero network.
- Print media → candidate/accepted/blocked text visible and interactive controls hidden.

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：focused 命令如预期因 candidate/accepted model、compare UI 和 v3 artifact 不存在而失败。
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**：同一 focused 命令 17 项全部通过；`pnpm exec tsc --noEmit` 退出 `0`；桌面/390px 只做一次阶段视觉检查，四联证据、比较面板与单列布局正常。
- [x] **Step 5: Commit**：更新本 plan 进展后提交 `feat: compare and choose report versions`。

### Task 7: Append-only Final Delivery

**Files:**

- Create: `src/delivery/finalize.ts`
- Create: `src/delivery/template.ts`
- Modify: `src/cli.ts`
- Modify: `src/run/store.ts`
- Create: `tests/finalize.test.ts`
- Create: `tests/finalize-browser.test.ts`
- Modify: `tests/cli.test.ts`

**Interfaces:**

- Produces: `DeliveryBlocker` with task ID and code `unreviewed | accepted_missing | accepted_changed | generation_failed_unresolved`.
- Produces: `DeliveryPlan` `{ runId, ready, acceptedTaskIds, excludedTaskIds, blockers }` via `planDelivery(runDir: string): Promise<DeliveryPlan>`.
- Produces: `DeliveryResult` `{ runId, deliveryId, deliveryDir, contactSheetPath, acceptedCount, excludedCount }` via `finalizeRun(runDir: string, deps?: { clock?: () => Date }): Promise<DeliveryResult>`.
- Adds CLI: `fashion-tryon finalize <run-dir> [--dry-run] [--json]`.
- Produces each delivery at `<run>/deliveries/<delivery-id>/` with `images/`、`delivery.json`、`mapping.csv` and `contact-sheet.html`.

**Requirements:**

- `planDelivery` verifies current inputs、version hashes and review references, constructs no provider, writes nothing and reports every blocker in manifest task order.
- A task is resolved only by one intact accepted version or explicit exclusion. Generation failure alone is not exclusion.
- `finalizeRun` rejects non-ready plans with `NEEDS_INPUT` and the full blocker list; it never silently omits tasks.
- Delivery ID uses UTC `YYYYMMDD-HHmmss` plus the first 8 characters of an accepted/excluded decision digest; a collision receives a stable `-2`、`-3` suffix and never overwrites.
- Final image filename format is `<3-digit-index>-<sanitized-group-name>-<task-id>.<ext>`; sanitization removes path separators/control characters and collision handling remains deterministic.
- `delivery.json` schemaVersion `1` records run/delivery/time、relative final file、task/group/garment/model IDs and display names、accepted version ID/hash, plus explicit excluded tasks. It contains no source absolute paths.
- `mapping.csv` columns are exactly `status,taskId,groupName,garmentName,modelName,versionId,fileName,sha256`; excluded rows have blank version/file/hash.
- Delivery creation occurs in a sibling temporary directory and becomes visible only after all images、JSON、CSV and HTML are durable; failure leaves no partial final delivery.
- Contact sheet is offline, references `images/` relatively, lists accepted and excluded counts and escapes all names.
- Deleting a delivery does not affect run facts. Re-finalizing unchanged facts creates another valid package with identical accepted image hashes/mapping semantics and preserves other deliveries.

**Test cases:**

- Mix of accepted、unreviewed、generation-failed and excluded tasks → deterministic complete blocker list; dry-run writes nothing/provider count `0`.
- All tasks accepted/excluded → ready plan and successful package with exact counts/files/schema/CSV header.
- Accepted version missing or hash changed → blocker before copy; no delivery directory.
- Two finalizations at the same fake second → distinct base and `-2` directories; first bytes remain unchanged.
- Inject failure before final rename → no visible partial delivery and run facts unchanged.
- Delete one completed delivery then finalize again → new complete delivery; remaining old delivery and source versions unchanged.
- JSON/CSV/HTML scan → no fixture absolute root、secret、Authorization or unescaped formula-leading CSV cells.
- Playwright opens final contact sheet at `1440×900` and `390×844` → all accepted images/excluded rows visible, no overflow and zero network requests.
- CLI `finalize --dry-run --json` and real finalize → one JSON value with blocker/result fields and no provider construction.

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：focused 命令如预期因 delivery modules/finalize command 不存在而失败。
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**：focused gate 24 项全部通过；额外 `run-store` 回归 6 项通过；`pnpm exec tsc --noEmit` 退出 `0`。
- [x] **Step 5: Commit**：更新本 plan 进展后提交 `feat: finalize append-only deliveries`。

### Task 8: Agent Workflow, Documentation, and v3 Milestone Gate

**Files:**

- Modify: `skills/fashion-tryon/SKILL.md`
- Modify: `skills/fashion-tryon/references/workflow.md`
- Modify: `README.md`
- Modify: `docs/USAGE.md`
- Modify: `docs/INPUT_OUTPUT.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/SECURITY.md`
- Modify: `docs/fashion-tryon-usage-guide.html`
- Modify: `HANDOFF.md`
- Modify: `scripts/scan-secrets.mjs`
- Modify: `tests/e2e-fake.test.ts`
- Modify: `tests/skill-contract.test.ts`
- Modify: `PROJECT.md`
- Modify: `docs/plans/2026-08-31-v3-finalization-preflight.md`

**Interfaces:**

- Consumes: complete CLI Interface `preflight → plan → run → report → review → retry → finalize` from Tasks 1–7.
- Produces: Agent workflow that transfers CLI-returned paths/digests/IDs without reimplementing planning or decisions.
- Produces: fake E2E for the exact v3 acceptance journey and updated secret scan covering `preflight.html`、review artifacts and every delivery file.

**Requirements:**

- Skill asks only CLI questions, accepts “按推荐” or an explicit safe preset, then runs `plan` and returns clickable `preflightPath` plus plan digest/tasks/cost.
- Skill obtains explicit current-turn authorization for that exact digest before `run --approve-plan`; it never treats preview generation as approval.
- After report export, Skill passes v3 artifact unchanged to `review --dry-run`/`review`; a redo then separately uses `retry --selection --dry-run`, reports cost and obtains a new authorization.
- Skill runs `finalize --dry-run` first, reports blockers or exact accepted/excluded counts, then finalizes without provider and returns delivery/contact-sheet paths.
- README、USAGE and visual tutorial lead with the short Agent path; raw CLI commands remain troubleshooting/reference material.
- Architecture/Input-Output/Security document manifest/state/review schema compatibility、plan digest/approval、candidate vs accepted、v3 artifact、delivery layout and derived-state rules.
- Documentation says explicitly that v3 historical baseline controls prompt lineage/local drift only; it is not Seedream/Wan image editing and does not keep pixels outside a mask.
- Paid e2e remains skipped by default and is not run in this milestone. No real provider、publish、deploy or remote repository action occurs.

**Test cases:**

- Fake E2E: dual guided → answers → plan/preview → approve → three manual candidates → accept v01 → create v02 retry candidate → reject v02/use v01 baseline → create v03 → accept v03 → explicitly exclude one failed task → finalize.
- E2E provider assertions: preview/review/finalize each add `0` calls; first manual run calls exactly firstPassTasks; each authorized redo adds exactly one call per redo; AI verify remains `0` in manual mode.
- E2E ledger assertions: accepted v01 survives v02/v03 candidates until explicit v03 accept; v03 prompt/drift baseline is v01; all versions remain; delivery contains only final accepted versions plus explicit exclusion mapping.
- Skill contract contains every v3 CLI step and required authorization fields, contains no provider URL/key and never reads report localStorage.
- Secret scan over tracked files and generated fake run/preflight/report/deliveries → exits `0` without printing secret values or private absolute paths.
- Usage-guide Playwright stage check at desktop/mobile → new preflight/定稿流程可读、无横向溢出和页面错误；只在本 Task 做一次阶段视觉验收。

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：`pnpm exec vitest run tests/e2e-fake.test.ts tests/skill-contract.test.ts`，预期因 Skill/docs/完整 v3 流程尚未同步而失败。
- [x] **Step 3: 同步 Skill、文档、secret scan、fake E2E 与里程碑证据**
- [x] **Step 4: 运行 focused 与完整门禁**：先运行 `pnpm exec vitest run tests/e2e-fake.test.ts tests/skill-contract.test.ts`；随后运行 `pnpm test`、`pnpm exec tsc --noEmit`、`pnpm build`、`node scripts/scan-secrets.mjs`，全部退出 `0`，paid test 保持 skipped。
- [x] **Step 5: Commit**：补全本 plan Final Acceptance、更新 `PROJECT.md`/`HANDOFF.md` 后提交 `docs: close v3 preflight and finalization`。

## Plan Self-check

- Spec B1 → Tasks 1–8；CLI/run facts/derived artifact 与无新 provider seam 在 Global Constraints 固定。
- Spec B2 → Tasks 2–3；prepared 字节一致、配对/裁切/成本/风险和零新增远程调用均有 focused tests。
- Spec B3 → Tasks 2、4；计划指纹字段、失效规则、首次授权与 resume 语义已覆盖。
- Spec B4 → Tasks 1、4、8；四字段白名单、显式选择、manifest 来源和示例均有合同。
- Spec B5 → Tasks 1、5；candidate/accepted/baseline 三者分离、历史读取和 prompt/drift lineage 已覆盖。
- Spec B6 → Task 6；任意双版本比较、草稿迁移、筛选/阻塞、键盘/打印/窄屏已覆盖。
- Spec B7 → Tasks 5–6；v3 artifact、整体验证、原子应用、旧 selection 兼容和独立 retry 授权已覆盖。
- Spec B8 → Task 7；默认阻塞、显式不交付、append-only delivery、JSON/CSV/contact sheet 和可重建性已覆盖。
- Spec B9 → Tasks 4、5、7、8；Agent 从短输入到预览授权、人工决定、独立返工授权和定稿返回完整覆盖。
- 验收 1–7 → Tasks 2–4；验收 8–12 → Tasks 5–6；验收 13–15 → Tasks 1、5、7；验收 16–17 → Task 8。
- 所有后续任务使用的 `SafePreset`、`GenerationPlan`、canonical facts、review selection 和 delivery Interfaces 都在首次消费前定义，没有未定义类型或假想 adapter。
- Plan 不包含完整实现/测试代码，也没有占位符、模糊错误要求或未命名验证；任务数为 8，均以 focused tests 和 coherent commit 收口。

## Progress

- [x] Task 1 — Canonical v3 Facts and Safe Presets
- [x] Task 2 — Approval-bound Generation Plan
- [x] Task 3 — Offline Visual Preflight Report
- [x] Task 4 — CLI Plan Approval and Resume Gate
- [x] Task 5 — Persisted Human Decisions and Historical Retry Baselines
- [x] Task 6 — Version Comparison and v3 Review Artifact
- [x] Task 7 — Append-only Final Delivery
- [x] Task 8 — Agent Workflow, Documentation, and v3 Milestone Gate

- 2026-08-31：Task 1 完成；canonical manifest/state/review 升级、历史只读规范化和四字段安全预设通过 focused tests 与类型检查。
- 2026-08-31：Task 2 完成；prepared 资产、风险和成本被稳定计划摘要绑定，runner 可只读复用获批字节，完整性断言覆盖输入与工作副本。
- 2026-08-31：Task 3 完成；离线预检以同一 prepared 字节展示配对/裁切/风险，40 任务桌面、窄屏、打印和零网络 Playwright 验证通过。
- 2026-08-31：Task 4 完成；CLI plan/preview、摘要批准、首次生成与 resume 门禁在 adapter 读取前生效，历史已启动 run 继续兼容。
- 2026-08-31：Task 5 完成；v3 人工决定可整体验证并原子落账，采用版本独立保留，受控返工和 orphan 恢复均绑定任意完整历史基线。
- 2026-08-31：Task 6 完成；离线报告分开展示候选/采用，支持任意历史版本同步比较、v2 草稿迁移和严格 v3 决定导出，损坏采用版会阻塞定稿。
- 2026-08-31：Task 7 完成；定稿先只读返回完整阻塞清单，再以同级临时目录原子发布不可覆盖 delivery，离线 contact sheet、JSON/CSV 映射、碰撞与故障恢复通过 focused tests。
- 2026-08-31：Task 8 完成；Agent Skill、文档、视觉教程、secret scan 与完整 v3 fake E2E 已同步，focused、全套测试、类型、构建、秘密扫描和 Skill validator 门禁全部通过。

## Final Acceptance

- 精确 v3 fake E2E 覆盖 guided → plan/preview → digest approval → manual candidates → accept/redo/historical baseline → exclude → finalize；`tests/e2e-fake.test.ts` 与 `tests/skill-contract.test.ts` 共 7 项通过。
- 全套 Vitest 共 33 个测试文件通过，245 项通过，1 项真实付费 e2e 按默认策略 skipped；没有调用真实 provider。
- `pnpm exec tsc --noEmit`、`pnpm build` 与 `node scripts/scan-secrets.mjs` 均退出 0；扫描覆盖 tracked files 与 fake run 的 preflight/report/review/delivery 派生物，不回显秘密或私有绝对路径。
- Usage guide 的 desktop/mobile Playwright stage check 已由 Skill contract gate 覆盖，无横向溢出或页面错误。
- `skills/fashion-tryon` 通过 skill-creator quick validator；Skill 只编排 CLI，不复制业务逻辑、不读取 report localStorage、不包含 provider URL 或 key。
- 以 `788d9f0` 为 v3 plan 基线完成本地差异审查，未发现阻断问题；未执行 publish、deploy、远程仓库或其他外部可见操作。
