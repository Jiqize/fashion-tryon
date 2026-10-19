# Fashion Try-on Runner v5 Canonical Crop and Local Review Implementation Plan

**Goal:** 让新计划强制产出全链路唯一的裁后服装素材，并让报告把严格人工决定直接原子保存到当前 run 目录。
**Architecture:** 服装定位作为 `VisionPort` 的窄内部 seam，在 generation plan 中对唯一内容执行并绑定最终 prepared；模特继续保留全构图。本机审核由一次性 loopback adapter 承担，只保存可移动 selection artifact，不修改 run facts，报告根据 `file:` 或审核会话自适应保存方式。
**Tech Stack:** TypeScript、Node.js 20 `http`/filesystem、Sharp、Zod、Commander、Vitest、Playwright。

## Global Constraints

- 输入素材只读；临时定位副本、最终 prepared、selection 和生成物只写 run 目录。
- 新计划的服装素材不得静默全图回退；定位或裁切失败必须在生图调用前失败。
- 模特图不得做目标裁切。
- `report.html`、localStorage 与 `review-selection.json` 都不是 run facts；只有显式 CLI review 能改变 review facts。
- 审核会话只监听 `127.0.0.1`、使用随机 token、只服务报告/图片和固定 selection 写入口，第一次成功保存后关闭。
- 保存不调用 provider；真实首次生成和 regeneration 继续遵守既有授权边界。
- 历史 manifest/plan/run/selection 保持可读且读取不改写。

## File Structure

- `src/ports.ts`：定义服装定位 request/result 与 `VisionPort.locateGarment`。
- `src/providers/dashscope.ts`：实现严格单图 garment bbox 定位。
- `src/preflight/garment-framing.ts`：建立临时完整工作副本、按内容缓存定位、清理临时文件并产出带 bbox 的服装资产。
- `src/preflight/generation-plan.ts`：在最终 prepare 前强制完成 framing，并把 vision/signal 依赖纳入计划构建。
- `src/prepare/images.ts`：复用既有压缩/裁切编码并支持只用于定位的完整副本。
- `src/review/selection-file.ts`：验证并原子保存固定 v4 selection artifact。
- `src/review/session.ts`：一次性 loopback HTTP adapter、静态白名单与 POST 保存边界。
- `src/report/template.ts`：同一“保存人工决定”动作在 HTTP 会话保存、在 file 协议下载。
- `src/cli.ts`：接通 plan vision 依赖与 `review-session` 命令/早期结构化输出。
- `skills/fashion-tryon/` 与项目文档：同步固定 selection 路径和新主路径。

### Task 1: Garment Framing Port and Adapters

**Files:**

- Modify: `src/ports.ts`
- Modify: `src/providers/dashscope.ts`
- Modify: `src/cli.ts`
- Modify: `tests/helpers/fake-vision.ts`
- Modify: `tests/dashscope-provider.test.ts`

**Interfaces:**

- Produces: `LocateGarmentRequest { imagePath, contentHash, model? }`。
- Produces: `GarmentFrame { bbox: Bbox }`。
- Extends: `VisionPort.locateGarment(request, signal): Promise<GarmentFrame>`。

**Requirements:**

- DashScope 指令只定位目标服装整体边界，bbox 单位固定 0–1000，成套/多层覆盖全部目标层。
- parser 严格拒绝缺失、越界、非数值、非正面积 bbox。
- lazy production adapter 不得因为构造 port 提前读取或回显 credential。
- FakeVision 独立记录 locate calls，并允许测试注入成功或失败 handler；既有 classify/brief/revise/verify 语义不变。

**Test cases:**

- 合法 `{"bbox":[100,120,900,940]}` → `GarmentFrame`。
- bbox 缺失、反向、越界或 malformed JSON → `PROVIDER_RESPONSE`。
- request 只含一张图片，使用显式 vision model，指令包含多层整体定位和千分比边界。
- fake locate handler 按 call index 返回或抛错，其他调用计数不受影响。

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：focused provider 测试出现 5 个预期失败，均因 `locateGarment` 尚不存在。
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**：`tests/dashscope-provider.test.ts` 15 项通过，`pnpm exec tsc --noEmit` 退出 `0`。
- [x] **Step 5: Commit**：`feat: add garment framing vision port`

### Task 2: Mandatory Canonical Garment Crop

**Files:**

- Create: `src/preflight/garment-framing.ts`
- Modify: `src/preflight/generation-plan.ts`
- Modify: `src/prepare/images.ts`
- Modify: `src/cli.ts`
- Modify: `tests/generation-plan.test.ts`
- Modify: `tests/preflight-preview.test.ts`
- Modify: `tests/approval.test.ts`
- Modify: `tests/e2e-fake.test.ts`

**Interfaces:**

- Produces: `frameReferencedGarments(manifest, assets, deps): Promise<Map<assetId, Bbox>>`，按内容 hash 缓存 locator。
- Produces: `prepareFramingCopy(asset, options): Promise<PreparedAsset>`，只生成完整、方向归一、少于 1 MiB、最长边不超过 1600 px 的临时副本。
- Extends: `BuildGenerationPlanDeps` with required `vision: VisionPort` and optional `signal`。
- Consumes: Task 1 `VisionPort.locateGarment`。

**Requirements:**

- 所有实际引用且缺少可信 bbox 的 garment 在最终 prepare 前完成定位；model 不定位。
- 相同 content hash 一次计划只调用一次，临时副本位于 run 目录且无论成功/失败都清理。
- locator 或裁切失败时不保存新的 generation plan；不得产生 `crop_fallback` 新计划。
- 最终 prepared 仍由原始素材加安全余量裁切压缩，digest 绑定准确 hash/crop facts。
- preflight、run、regeneration 与 report 继续消费同一 planned prepared；历史 generation plan 保持兼容。

**Test cases:**

- 结构化/双目录缺 bbox garment → classify 0、唯一内容 locate 1、cropped true；model locate 0/cropped false。
- 重复内容、多任务 → locate 1，所有对应 asset 产生确定性 crop。
- 已有视觉 bbox → locate 0，直接裁切。
- locator invalid/error → plan 拒绝、无 generation plan、临时副本清理、image provider 0。
- 相同 locator 结果跨 clock 重建 → prepared hash/digest 相同。
- preflight URL、fake generation request、fake regeneration request、report garment URL → 同一 prepared 相对路径/hash。

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：generation plan 出现 4 个预期失败，证明目录服装未定位、重复内容未去重且仍存在全图回退。
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**：generation-plan/preflight/approval/prepare/report/e2e focused 39 项通过，额外 Playwright preflight 与 fake E2E 5 项通过，typecheck 退出 `0`。
- [x] **Step 5: Commit**：`feat: require canonical garment crops before approval`

### Task 3: Validated Atomic Selection File and One-shot Session

**Files:**

- Create: `src/review/selection-file.ts`
- Create: `src/review/session.ts`
- Create: `tests/review-selection-file.test.ts`
- Create: `tests/review-session.test.ts`

**Interfaces:**

- Produces: `saveCurrentReviewSelection(runDir, input): Promise<{ selectionPath, decisionCount, sha256 }>`。
- Produces: `startReviewSession(runDir, deps?): Promise<ReviewSession>`，其中 `ReviewSession` 暴露 `reviewUrl`、`selectionPath`、`done` 与 `close()`。
- Consumes: `parseHumanReviewSelection` 与 `planHumanReviewDecisions` 的既有整体验证。

**Requirements:**

- 只保存 schema v4，按 manifest 顺序规范化，mode `0600`，临时文件 + rename 原子替换。
- 无效 selection 不创建或覆盖最后有效文件；保存不修改 manifest/state/review/events。
- HTTP 只监听 `127.0.0.1:0`，token 至少 128 bit，只允许 GET report/prepared/images 与 POST 固定 selection endpoint。
- POST 只接受同源 `application/json` 且最多 1 MiB；路径穿越、run facts、其他方法与其他写路径拒绝。
- 第一次有效保存响应后关闭；无效保存保持监听；abort/close 不创建 artifact。

**Test cases:**

- 有效 v4 → 固定路径、0600、canonical JSON、review dry-run 可读、run facts/event bytes 不变。
- 第二次有效保存原子替换；中途失败或 invalid/cross-run/stale hash/duplicate/blank feedback 保留旧字节。
- token URL GET report/image 成功；manifest、state、父目录、无 token 与 traversal 返回 404/403。
- 错 content type、超 1 MiB、非 POST 返回 4xx 且不写文件；之后有效 POST 仍成功。
- 成功 POST 后 `done` 完成且端口关闭；显式 close 前无 artifact。

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：两个新测试文件因 selection-file/session 模块不存在而按预期失败。
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**：selection file 与 loopback session 6 项全部通过，`pnpm exec tsc --noEmit` 退出 `0`。
- [x] **Step 5: Commit**：`feat: save review selections through a local session`

### Task 4: Adaptive Report Save and CLI Review Session

**Files:**

- Modify: `src/report/template.ts`
- Modify: `src/cli.ts`
- Modify: `tests/report-browser.test.ts`
- Modify: `tests/cli.test.ts`
- Modify: `tests/review-session.test.ts`

**Interfaces:**

- Produces: 报告 `[data-save-selection]` 自适应动作；HTTP POST `./review-selection`，file 协议使用 download。
- Produces: `fashion-tryon review-session <run-dir> [--json]` 结构化初始结果 `{ status: 'awaiting_review_save', reviewUrl, selectionPath, reportPath, runDir, runId }`。
- Consumes: Task 3 `startReviewSession`。

**Requirements:**

- HTTP 与 file 两条路径共享 v4 build/validation；无效反馈不 POST、不下载。
- HTTP 成功显示保存条数和 selectionPath，不触发 download；失败保留草稿并显示错误，不静默 fallback。
- file 报告保持零网络和既有下载文件名，文案明确离线下载。
- CLI 启动后立即输出且保持前台等待一次保存或中断；`--json` stdout 只有一个 JSON 值。
- 会话启动前重建最新 report；CLI 不直接应用决定。

**Test cases:**

- Playwright 通过 session URL 选择 accept/regenerate/exclude 并保存 → 无 download、固定文件内容准确、页面显示成功。
- HTTP 空 feedback/服务端 stale hash → 无有效写入、内联/全局错误可见、草稿仍在。
- file URL 同一按钮仍下载严格 v4，并产生零外部请求。
- CLI JSON 包含 loopback token URL 与固定 selectionPath；中断关闭，无第二个 stdout JSON。

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：CLI 按预期拒绝未知 `review-session`，报告仍显示“导出”且浏览器中不存在保存入口。
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**：report/CLI/review-session focused 44 项全部通过，`pnpm exec tsc --noEmit` 退出 `0`。
- [x] **Step 5: Commit**：`feat: connect report saves to the run directory`

### Task 5: Skill, Documentation and Release Gates

**Files:**

- Modify: `tests/skill-contract.test.ts`
- Modify: `tests/e2e-fake.test.ts`
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

- Produces: Agent 主路径 `review-session → 用户保存 → <run>/review-selection.json → review dry-run/apply → authorized retry`。
- Produces: 当前 v5 架构、I/O、安全和接手事实。

**Requirements:**

- Skill 不扫描 Downloads、不猜最新 run、不读 localStorage、不复制 selection 校验或裁图逻辑。
- 用户只说“审核”时，仅在对话已有明确 runDir 时读取固定 selection；缺少上下文时要求 run 路径，不能全盘搜索。
- regeneration 继续原样传同一 selection，分别报告 revision/generation ceilings 并等待授权。
- fake E2E 覆盖 canonical crop、HTTP save、review apply 和无 provider 保存边界。
- Repo Skill 通过 validator 后同步到 `~/.codex/skills/fashion-tryon` 并逐字节比较。
- tracked files、HTML、selection fixtures 和 docs 不含秘密、用户素材/run 或私人绝对路径。

**Test cases:**

- Skill contract 包含 review-session、固定 selectionPath 与保存/审核分离，拒绝 Downloads 搜索和自动 apply 文案。
- fake E2E 的 locate/brief/generation/revision 次数精确，报告保存不会增加 provider 调用。
- 历史 v1–v4 focused compatibility cases 保持通过。
- secret/path scan、全量 Vitest、typecheck、build、Skill validator 与安装字节比对全部通过。

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：Skill、README/USAGE 与视觉指南按预期暴露旧下载主路径和服装原图口径；新增 fake E2E 已先证明实现纵向链路成立。
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**：focused E2E/Skill 8 项通过；全量首轮 298 项通过、1 项 paid skipped，唯一 5 秒 generation-plan 超时隔离重跑 513 ms 通过；typecheck、build、secret scan、Skill validator 与安装字节比对通过。
- [x] **Step 5: Commit**：更新本 plan、HANDOFF、PROJECT 后提交 `docs: close v5 crop and review handoff workflow`。

## Progress

- 2026-08-31：用户确认新计划必须展示并复用裁后服装图；人工决定保存到 run 目录，随后由 Agent 显式审核。spec 与接口计划落盘。
- 2026-08-31：完成独立 garment framing port、DashScope 严格 bbox 解析与指令、lazy adapter 和可观察 fake；缺失、反向、越界与非数值 bbox 均在 provider 层拒绝。
- 2026-08-31：generation plan 现对结构化和双目录服装按内容去重定位，临时完整副本始终清理，最终 crop 从原始素材生成；新计划不再接受服装全图回退，预检、生成、重生与报告继续绑定同一 prepared 证据。
- 2026-08-31：新增固定 `review-selection.json` 的 v4 整体验证、manifest 顺序规范化和 mode 0600 原子替换；一次性 loopback 会话只服务 report/prepared/images，限制同源 JSON 与 1 MiB，首个有效保存后关闭且不触碰 run facts。
- 2026-08-31：报告按 file/loopback 自适应下载或保存，CLI `review-session` 先输出 URL/固定 selectionPath 再等待首次有效保存；保存与审核保持分离。
- 2026-08-31：Skill、README、使用说明、架构/I-O/安全文档与视觉指南统一为 v5 主路径；fake E2E 证明保存不增加 locator/brief/verify/generation 调用，仓库 Skill 已验证并逐字节安装。
