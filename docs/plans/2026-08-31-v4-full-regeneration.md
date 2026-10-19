# Fashion Try-on Runner v4 Full Regeneration Implementation Plan

**Goal:** 以三个互斥人工决定替换新报告的局部返工入口，并让每次“重新生成”基于服装原图、失败版本、原模特和人工意见重新形成实际生图 prompt。
**Architecture:** CLI 继续是唯一执行 Interface。`review` 负责严格应用 v4 决定，`retry` 负责调用新的 `VisionPort.reviseBrief` 并持久化新 prompt，再交给既有 runner 生图；旧 v1–v3 返工合同只保留兼容读取。报告只创建 v4 决定，Skill 不再允许用 task ID 绕过 selection。
**Tech Stack:** Node.js 20+、TypeScript、Zod、Commander、Sharp、Vitest、Playwright、DashScope OpenAI-compatible multimodal adapter。

- Spec：`docs/specs/2026-08-31-v4-full-regeneration.md`
- 状态：已完成
- 日期：2026-08-31

## Global Constraints

- 新报告的主要决定只有“交付所选版本”“重新生成”“本次不交付”，三者互斥；重新生成意见去除首尾空白后必须为 1–500 个字符。
- v4 selection 严格绑定 run、task、被拒版本和 SHA-256；任一无效决定不得部分写入运行事实。
- 每个 v4 regeneration 在没有已持久化新 prompt 时最多调用一次视觉 revision；manual mode 每任务最多再调用一次生图。
- revision 必须同时观察 prepared 服装原图、失败版本、prepared 原模特、scope 和人工意见；旧 prompt 不能作为新 brief 的事实来源。
- 新 prompt 由 fresh `GarmentBrief` 经 `buildTryonPrompt` 生成，并保留一个不可信的人工可见纠正数据块；不得拼接旧 prompt 或局部保留合同。
- revision 结果先原子持久化再调用生图；恢复必须复用该 prompt，不重复 revision。
- manual run 已有完整版本的任务禁止 `retry --task` 绕过 selection；没有版本的可重试生成失败仍允许恢复。
- v1–v3 selection、旧 `pendingRedo`、`manualControl` 和 `localDrift` 继续可读，不删除、不迁移写盘。
- 普通测试只用 fake adapters；本计划不构造真实付费 adapter、不调用真实 provider、不设置 `RUN_PAID_E2E=1`。
- 人工意见正文不得写入 events；事件只记录存在性和 SHA-256。

## Planned File Structure

### Create

- `src/review/regeneration.ts`：fresh brief 请求、完整 prompt 构造与人工纠正数据块。
- `tests/regeneration.test.ts`：逐图 revision 和冲突旧 prompt 的 focused tests。

### Modify

- `src/review/manual-selection.ts`：v4 artifact 与 regeneration decision。
- `src/contracts.ts`：pending/version regeneration 运行事实与严格互斥关系。
- `src/review/decisions.ts`：v3/v4 原子应用与无明文事件。
- `src/ports.ts`、`src/providers/dashscope.ts`：`reviseBrief` 生产 seam 与三图请求。
- `src/review/retry.ts`、`src/run/runner.ts`、`src/run/store.ts`：调用上限、task-ID 门禁、prompt 持久化、恢复和成功清理。
- `src/report/render.ts`、`src/report/template.ts`：简化三选一 UI、v4 草稿/导入/导出。
- `src/cli.ts`：分别输出 revision 与 generation 上限。
- `tests/helpers/fake-vision.ts`、`tests/helpers/report-fixture.ts`：可观察 fake revision 和 v4 报告事实。
- `tests/manual-selection.test.ts`、`tests/contracts.test.ts`、`tests/review-decisions.test.ts`、`tests/retry.test.ts`、`tests/resume.test.ts`、`tests/run-store.test.ts`：合同与恢复覆盖。
- `tests/report.test.ts`、`tests/report-browser.test.ts`、`tests/cli.test.ts`、`tests/e2e-fake.test.ts`：UI、CLI 与纵向闭环。
- `skills/fashion-tryon/SKILL.md`、`skills/fashion-tryon/references/workflow.md`：唯一 selection 重生路径和双调用授权。
- `README.md`、`docs/USAGE.md`、`docs/INPUT_OUTPUT.md`、`docs/ARCHITECTURE.md`、`docs/SECURITY.md`、`HANDOFF.md`、`PROJECT.md`：同步事实、操作和接手状态。

### Task 1: v4 Selection and Canonical Regeneration Facts

**Files:**

- Modify: `src/review/manual-selection.ts`
- Modify: `src/contracts.ts`
- Modify: `src/review/decisions.ts`
- Modify: `src/run/store.ts`
- Modify: `tests/manual-selection.test.ts`
- Modify: `tests/contracts.test.ts`
- Modify: `tests/review-decisions.test.ts`
- Modify: `tests/run-store.test.ts`

**Interfaces:**

- Produces: `HumanReviewDecisionV4 = accept | unaccept | regenerate | exclude` and `HumanReviewSelectionV4` with `schemaVersion: 4` and kind `fashion-tryon-review-selection`.
- Produces: regenerate decision `{ taskId, rejectedVersionId, rejectedVersionSha256, decision: 'regenerate', feedback }`, where normalized feedback length is 1–500.
- Produces: `PendingRegeneration { rejectedVersionId, rejectedVersionSha256, feedback, decidedAt }` on `TaskReview`.
- Produces: `RegenerationControl { rejectedVersionId, feedbackSha256, revisedAt }` on `TaskVersion`, plus matching pending fields on `TaskState` for recovery.
- Extends: `ReviewDecisionPlan` with `regenerateTaskIds` and `maximumPromptRevisionCalls`; legacy `redoTaskIds` remains for v3.

**Requirements:**

- v4 unknown fields, blank/501-character feedback, duplicate task IDs, stale hash, wrong run and cross-task version fail before writes.
- `pendingRegeneration` is mutually exclusive with `excluded` and `pendingRedo`, but may coexist with `acceptedVersionId`.
- Applying regenerate keeps accepted, removes excluded/pendingRedo and writes exact normalized feedback; applying exclude removes both pending kinds.
- Regenerate event data contains rejected version ID, `hasFeedback: true` and feedback SHA-256 only.
- v1–v3 parsing and historical review/state parsing retain existing behavior.

**Test cases:**

- Valid v4 accept/unaccept/regenerate/exclude → strict parse and round-trip.
- Feedback `"  黑白格纹  "` → stored/exported as `"黑白格纹"`; empty and 501 characters → `VALIDATION_ERROR`.
- v4 regenerate with valid version/hash → accepted preserved, pending regeneration written, legacy pending redo/exclude cleared.
- Mixed selection with one stale hash → review bytes unchanged and no events appended.
- Review/state with valid regeneration facts → round-trip; invalid mutual exclusions/reference → validation error.

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：focused 命令如预期出现 8 个 v4 schema/facts 失败，既有 67 项通过。
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**：focused 命令 75 项全部通过，`pnpm exec tsc --noEmit` 退出 `0`。
- [x] **Step 5: Commit**：`feat: add v4 regeneration review facts`

### Task 2: Fresh Multimodal Prompt Revision

**Files:**

- Modify: `src/ports.ts`
- Create: `src/review/regeneration.ts`
- Modify: `src/providers/dashscope.ts`
- Modify: `tests/helpers/fake-vision.ts`
- Create: `tests/regeneration.test.ts`
- Modify: `tests/dashscope.test.ts`

**Interfaces:**

- Produces: `ReviseBriefRequest { garmentPath, rejectedVersionPath, modelPath, scope, feedback, model? }`.
- Extends: `VisionPort.reviseBrief(request: ReviseBriefRequest, signal: AbortSignal): Promise<GarmentBrief>`.
- Produces: `buildRegenerationPrompt(request, vision, signal): Promise<{ prompt, reviewExpectation, uncertainty }>` in `src/review/regeneration.ts`.
- Extends: DashScope adapter with one three-image structured brief request ordered as garment, rejected version, model.

**Requirements:**

- Revision instruction labels all three image roles and treats garment source as target truth, rejected image as failure evidence and model source as identity/pose/scene truth.
- Human feedback is serialized as untrusted JSON data, never interpolated as instruction syntax.
- `buildRegenerationPrompt` calls `reviseBrief` exactly once, calls `buildTryonPrompt(freshBrief, scope)`, then appends an untrusted highest-priority correction block containing exact normalized feedback.
- The API does not accept the historical prompt; failed revision never falls back to it.
- DashScope invalid/missing garment brief fails before image generation can be reached.

**Test cases:**

- Fake revision receives exact three paths/scope/feedback and returns black plaid brief → new prompt contains black plaid and feedback.
- An unrelated historical beige prompt is not an input and does not occur in the new prompt.
- Feedback containing instruction-like text appears only JSON-escaped inside the correction data block.
- DashScope request contains exactly three image URLs in documented order and a structured-output instruction; valid response parses to `GarmentBrief`.
- Invalid revision response → `PROVIDER_RESPONSE`; no fallback prompt returned.

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：`tests/regeneration.test.ts` 因模块不存在失败，DashScope 两项因 `reviseBrief` 不存在失败；既有 8 项通过。
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**：`pnpm exec vitest run tests/regeneration.test.ts tests/dashscope-provider.test.ts` 12 项通过，`pnpm exec tsc --noEmit` 退出 `0`。
- [x] **Step 5: Commit**：`feat: revise regeneration prompts from visual evidence`

### Task 3: Authorized Retry, Persistence, Recovery and Bypass Guard

**Files:**

- Modify: `src/review/retry.ts`
- Modify: `src/run/runner.ts`
- Modify: `src/run/store.ts`
- Modify: `src/cli.ts`
- Modify: `tests/retry.test.ts`
- Modify: `tests/resume.test.ts`
- Modify: `tests/cli.test.ts`

**Interfaces:**

- Extends: `RetryPlan` with `maximumPromptRevisionCalls: number`.
- Extends: `planRetryTasks` and `retryTasks` to consume applied v4 `pendingRegeneration` and call `buildRegenerationPrompt` only when no matching pending prompt is persisted.
- Extends: runner version writes with optional `RegenerationControl`; successful generation clears matching task/review pending regeneration.
- Produces: manual task-ID guard returning `RunnerError('NEEDS_INPUT', ...)` for tasks with at least one complete version.

**Requirements:**

- v4 selection must exactly match applied pending rejected version/hash/feedback before any revision or generation.
- Dry-run produces no revision/generation calls; manual count is one of each per regenerate task, auto revision count remains one per task while generation count uses `1 + maxRetries`.
- Retry persists pending regeneration and new prompt before image provider invocation; events store feedback hash, never body.
- A stored matching prompt is reused after interruption or retry, so revision count remains one.
- New version records rejected version ID/feedback hash/revision time, becomes candidate, preserves accepted and all old versions, then clears pending regeneration facts.
- Manual `--task` with any complete version fails before provider construction; retryable generation failure with zero versions remains allowed.
- Legacy v1–v3 selectors and auto review failure retry keep current behavior and report revision count zero.

**Test cases:**

- Two applied manual v4 regenerations → plan revision 2/generation 2, dry-run provider calls zero.
- One regeneration → fake revision one, fake generation one, prompt persisted/sent, metadata correct and pending cleared.
- Revision failure → generation zero; pending decision remains.
- Generation fails after revision, rerun same selection → revision remains one and generation retries stored prompt.
- Manual generated task + task ID → `NEEDS_INPUT`; no-version retryable failure + task ID → generation allowed.
- v3 redo and `--review-failed` → old controls/results unchanged, revision count zero.

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：focused 命令出现 5 个预期失败：v4 execution、双调用上限和 manual task-ID 门禁均未实现；既有 35 项通过。
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**：`pnpm exec vitest run tests/retry.test.ts tests/resume.test.ts tests/cli.test.ts` 40 项通过，`pnpm exec tsc --noEmit` 退出 `0`。
- [x] **Step 5: Commit**：`feat: execute authorized full regeneration safely`

### Task 4: Simplified v4 Offline Review UI

**Files:**

- Modify: `src/report/render.ts`
- Modify: `src/report/template.ts`
- Modify: `tests/helpers/report-fixture.ts`
- Modify: `tests/report.test.ts`
- Modify: `tests/report-browser.test.ts`

**Interfaces:**

- Produces: report export/draft schema v4 with accept/unaccept/regenerate/exclude decisions.
- Produces: three mutually exclusive primary actions and one required `重新生成意见` field for regenerate.
- Consumes: canonical pending regeneration and historical pending redo/manual control facts for read-only presentation.

**Requirements:**

- New report contains no actionable preservation checkbox, local-redo editor or “局部返工边界”; historical controls may appear only inside version technical history.
- Switching primary action leaves exactly one selected state; selecting another version updates the accept/regenerate binding without silently changing exclude.
- Regenerate export is blocked with inline error until feedback is 1–500 characters.
- Exported JSON is strict v4 and uses the selected version ID/hash; import is atomic.
- Draft key and draft schema are v4/run-scoped; compatible v3 redo with non-empty repair can migrate to regenerate, blank repair requires new input, and old key remains.
- Page remains offline and makes zero network requests at desktop and narrow viewport.

**Test cases:**

- Browser selects V01 then regenerate → only regenerate active, required editor visible; switch to accept/exclude → regenerate inactive.
- Blank/501-character feedback → no download and inline validation; valid feedback → exact v4 download.
- Select V02 → exported rejected version ID/hash changes to V02.
- Import one invalid decision among valid decisions → draft and storage unchanged.
- v3 redo repair migrates to v4 regeneration draft; v3 exclude stays exclude; old storage key remains.
- DOM has three primary action labels and no local redo controls; page issues zero requests.

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：`tests/report.test.ts` 出现 2 个预期失败：报告模型尚未暴露 pending regeneration，HTML 仍使用旧 redo UI/v3 export。
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**：`tests/report.test.ts` 与 `tests/report-browser.test.ts` 各 10 项全部通过，`pnpm exec tsc --noEmit` 退出 `0`。
- [x] **Step 5: Commit**：`feat: simplify review to full regeneration decisions`

### Task 5: Fake E2E, Skill Contract and Release Documentation

**Files:**

- Modify: `tests/e2e-fake.test.ts`
- Modify: `tests/skill-contract.test.ts`
- Modify: `skills/fashion-tryon/SKILL.md`
- Modify: `skills/fashion-tryon/references/workflow.md`
- Modify: `README.md`
- Modify: `docs/USAGE.md`
- Modify: `docs/INPUT_OUTPUT.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/SECURITY.md`
- Modify: `docs/fashion-tryon-usage-guide.html`
- Modify: `HANDOFF.md`
- Modify: `PROJECT.md`

**Interfaces:**

- Produces: fake E2E “错误颜色 → v4 regenerate → fresh prompt → 新候选 → accept” with exact revision/generation counts.
- Produces: installed Skill contract requiring one unchanged selection path through review/dry-run/authorized retry and separate call ceilings.
- Produces: current user/architecture/security/handoff docs for v4 behavior and historical compatibility.

**Requirements:**

- Fake E2E proves a stale beige prompt is not reused, explicit black/white feedback reaches actual generation prompt, old/new versions remain and accepted changes only after a second decision.
- Skill never reconstructs `--task` from a human artifact and never treats exclude reason as regeneration feedback.
- Skill reports `maximumPromptRevisionCalls` and `maximumGenerationCalls` before requesting authorization.
- Repo Skill is validated, installed to the Codex skills directory and byte-compared after build/tests.
- No tracked fixture contains secrets, user images, run directories or private absolute paths.

**Test cases:**

- Named fake E2E completes with revision 1 and first-pass/regeneration generation counts exact.
- Skill contract rejects missing double ceilings or any selection-to-task-ID shortcut wording.
- Historical v3 E2E remains green.
- Secret/path scan reports no leak.

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：首次 focused E2E/Skill 合同出现 4 个预期失败，覆盖旧 prompt 冲突、v4 Skill 双调用上限与新文档合同。
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**：focused E2E/Skill 8 项通过；全量 34 文件、280 项通过，1 项 paid e2e skipped；typecheck、build、secret scan、Skill validator 与安装字节比对通过。
- [x] **Step 5: Commit**：更新本 plan/HANDOFF/PROJECT 后提交 `docs: close v4 full regeneration workflow`。

## Progress

- 2026-08-31：用户确认取消新路径的局部返工，改为基于原始三图证据与必填意见的完整重新生成；spec 与本接口计划落盘。
- 2026-08-31：完成 v4 selection、反馈规范化、版本/hash 原子校验、pending regeneration 事实和无明文事件；历史 v1–v3 合同保持可读。
- 2026-08-31：完成 `VisionPort.reviseBrief`、DashScope 三图角色指令、fresh brief prompt 重建和不可信反馈纠正块；不再接受旧 prompt 输入。
- 2026-08-31：完成 v4 retry 双调用上限、selection/pending 精确匹配、revision 先持久化与失败恢复、新版本 lineage、成功清理及 manual task-ID 绕过保护。
- 2026-08-31：报告新路径已简化为交付、重新生成、不交付三选一；重新生成意见必填，v4 草稿/导入/导出与旧版迁移已经浏览器验证。
- 2026-08-31：fake 纵向 E2E 证明冲突旧 prompt 不会复用，三图 revision 与黑白格纹 feedback 进入真实生成 prompt，新 candidate 需二次人工接受；Skill、用户文档、全量本地门禁和 Codex 安装同步全部关闭。未运行 paid E2E。
