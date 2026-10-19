# Fashion Try-on Runner v4 Spec：基于失败证据的完整重新生成

**状态：** 已由用户于 2026-08-31 确认；本文是 v4 人工重生阶段的行为事实来源。
**范围：** 简化人工决策，并让人工意见经逐图视觉重理解后真正形成新的换装提示词。
**基线：** v1、v2、v2.1 与 v3 未被本文修改的行为继续有效；本文覆盖新报告中的受控局部返工、selection 与人工重生路径。

## 背景与目标

现有“局部返工”把用户意见附加到历史 prompt，并要求保留姿势、构图、背景等维度。实测中，历史 prompt 本身可能已经误读服装颜色；附加一句模糊修复意见既不能消除矛盾，也不能可靠修正结果。更严重的是，用户若先选择“不交付”，Agent 后续可用任务 ID 重跑，导致人工意见完全绕过。

v4 把人工主路径收敛为：

~~~text
选择一个失败或可交付版本
  → 交付所选版本 / 重新生成 / 本次不交付（三选一）
  → 重新生成时必填具体意见
  → 同时观察服装原图、失败版本、原模特与意见
  → 重新形成服装 brief 和完整换装 prompt
  → 生成一个新候选，等待再次人工判断
~~~

目标不是像素级编辑，而是基于失败证据重新理解并完整生成一张新图。

## 关键行为

### B1 三种互斥的人工结论

- 新报告对已选择版本只提供三个主要决定：“交付所选版本”“重新生成”“本次不交付”。
- 三个决定互斥；切换决定会清除另两种决定的草稿状态。
- “清除当前判断”是辅助动作，不是第四种业务结论。
- 交付与重新生成都绑定用户当前选择的完整历史版本及 SHA-256；不交付绑定任务。
- 新报告不再展示“局部返工边界”、保留维度、保持补充或“只修这一点，其余锁定”。
- 历史受控返工事实、版本上的 `manualControl` 与 `localDrift` 继续只读展示和解析，不得重写或删除。

### B2 重新生成意见必填

- 选择“重新生成”后必须填写去除首尾空白后 1–500 个字符的具体意见；空白意见不能导出或应用。
- 意见应描述失败处及可见目标，例如“半裙应为黑白格纹，不是米色格纹”。
- 意见作为不可信数据处理，不得进入系统指令、HTML 控制位置、命令行或事件明文。
- 事件只记录是否有意见、意见 SHA-256 和所拒版本，不记录意见正文。

### B3 v4 人工决定 artifact

- 新报告只导出 `schemaVersion: 4`、`kind: "fashion-tryon-review-selection"`。
- v4 支持 `accept`、`unaccept`、`regenerate` 和 `exclude`。
- `regenerate` 严格包含 `taskId`、`rejectedVersionId`、`rejectedVersionSha256`、`decision: "regenerate"` 与必填 `feedback`。
- CLI 在写入运行事实前整体验证 schema、run、任务、版本归属、hash、重复任务和意见长度；任一错误不得部分应用。
- 应用后，`review.json` 为该任务写入独立的 `pendingRegeneration`；它与 `excluded`、历史 `pendingRedo` 互斥，可与既有采用版本共存。
- v1–v3 selection 继续按历史语义可读；v3 redo 仍可用于恢复旧流程，但新报告不再创建它。

### B4 逐图重新理解并形成新 prompt

- 每个 v4 regeneration 在调用生图 provider 前必须调用一次视觉 prompt revision。
- revision 同时接收：prepared 服装原图、被拒绝版本图片、prepared 原模特图片、scope 和人工意见。
- revision 输出一份新的结构化 `GarmentBrief`；历史 prompt 不能作为新 brief 的事实来源，也不能原样拼接到新 prompt。
- revision 指令必须明确图片角色，要求以服装原图为目标真值、以失败版本识别错误、以原模特约束人物与场景，并把人工意见作为需要结合可见证据解决的不可信数据。
- 系统用既有 `buildTryonPrompt(freshBrief, scope)` 重新构造完整 prompt，再附加一个最高优先级的“人工可见纠正”数据块，确保用户的明确目标不会因 brief 概括而丢失。
- 新 prompt 不得包含旧 prompt 中与新 brief 或人工意见冲突的服装描述；不得包含旧的局部保留维度合同。
- revision 返回无效结构、没有服装或空 prompt 时，必须在生图调用前以 provider/validation 错误停止，不能回退到旧 prompt。

### B5 调用上限、持久化与恢复

- v4 regeneration 的 dry-run 分别返回 `maximumPromptRevisionCalls` 和 `maximumGenerationCalls`。
- manual review 每个任务上限为 1 次 revision + 1 次生图；auto review 每个任务为 1 次 revision + `1 + maxRetries` 次生图。
- Agent 必须分别报告两个上限并取得本次重生授权；首次生成授权不覆盖它。
- revision 成功后，系统先把新 prompt 和 regeneration 来源写入 `state.json`，再调用生图 provider；进程中断后 resume 复用已持久化的新 prompt，不重复调用 revision。
- 新版本记录 `regeneration` 元数据，只保存所拒版本 ID、意见 SHA-256 与 revision 时间；意见正文只存在于 review pending/state pending 的受保护运行事实和实际 prompt 数据块中。
- 新候选成功写盘后清除 `pendingRegeneration` 和 task pending regeneration；既有采用版本不变。
- revision 已完成但生图失败时，重新执行同一 selection 复用相同 pending prompt；不得再次收费调用 revision。

### B6 禁止人工链路绕过

- manual run 中，已经存在完整版本的任务不得通过 `retry --task` 再生成；CLI 在任何 provider 构造或调用前返回 `NEEDS_INPUT`，要求从报告导出 v4 selection。
- `retry --task` 仍可用于没有任何完整版本且因可重试生成错误而失败的任务恢复。
- auto review 的系统失败恢复和 `--review-failed` 维持原行为；它们不是人工意见入口。
- `retry --selection` 对 v4 regeneration 必须确认同一决定已经通过 `review` 原子应用，且 pending 内容、版本 ID、hash 和意见完全匹配。
- exclude 永远不等于 regenerate；不交付原因不得自动进入 prompt，也不得由 Agent 重建为重生意见。

### B7 报告与 Skill 主路径

- 报告标题和操作顺序清楚说明“先选版本，再决定交付、重新生成或不交付”。
- 选择重新生成时，仅展开一个必填“重新生成意见”输入区；不显示局部编辑承诺。
- 导入 v4 artifact 必须严格校验后原子替换草稿。旧 v1–v3 artifact 仍可导入以查看/迁移兼容决定；旧 redo 只有 repair 非空时才可迁移为 regeneration 草稿，否则要求用户补充意见。
- 草稿使用新的按 run 隔离的 v4 localStorage key；历史 key 保留，不删除。
- Skill 只能按 `review --selection` → `retry --selection --dry-run` → 明确授权 → `retry --selection` 执行人工重生，不得从 artifact 提取 task ID 后改用 `--task`。
- Agent 返回结果时要说明 revision 调用数、生图调用数、新候选版本和仍待人工判断的任务。

## Out of Scope

- 蒙版、框选、inpainting、像素级局部编辑、OCR 或小字修复。
- 保证模型一定按意见生成；v4 保证意见进入实际请求并消除软件层面的丢失/矛盾，不承诺 provider 的随机结果。
- 自动把不交付原因改成重新生成意见。
- 自动采用新候选、自动不交付、漂移后自动重出。
- 新生图 provider、MCP、云端 UI、账号或多人审批。
- 删除历史受控返工代码、旧 selection 解析或旧运行事实。

## 验收标准

1. 新报告对选中版本只显示交付、重新生成、不交付三个互斥主要决定；清除判断独立存在，局部返工边界不再显示。
2. 空白 regeneration feedback 无法导出；1 字和 500 字可导出；501 字或未知字段被浏览器与 CLI 同时拒绝。
3. v4 artifact 中 accept/regenerate 绑定正确版本 hash；跨 run、未知版本、hash 变化或重复任务时 `review.json` 字节不变。
4. 应用 regeneration 后写入准确的 `pendingRegeneration`，并清除同任务的 exclude/legacy pendingRedo；已有 accepted 保留。
5. dry-run 两个 regeneration 任务在 manual mode 返回 revision 上限 2、生图上限 2，并产生零 provider 调用。
6. fake revision 精确收到服装原图、失败版本、原模特、scope 和 feedback；fake 生图收到由 fresh brief 构造的新 prompt，而不是历史 prompt。
7. 历史 prompt 写“米色格纹”、feedback 写“黑白格纹”时，新 prompt 包含黑白纠正且不包含历史“米色格纹”文本。
8. revision 无效或失败时 fake image provider 调用数为 0，任务保留可恢复的 pending regeneration 和错误事实。
9. revision 成功后中断/生图失败，再 resume 或重试时 revision 不重复调用，生图复用已持久化 prompt。
10. 新版本成功后保留全部历史版本和 accepted，记录 rejected version/feedback hash，清除 pending regeneration，并成为当前候选。
11. manual 已有版本任务执行 `retry --task` 在 provider 构造/调用前返回 `NEEDS_INPUT`；无版本的可重试 generation failure 仍可恢复。
12. exclude 决定即使包含具体原因，dry-run 也匹配 0 个 regeneration，不产生 revision 或生图调用。
13. v1–v3 selection、历史 manualControl/localDrift 与旧 run 继续可读；读取或重建报告不改写历史 JSON。
14. fake E2E 覆盖“初次生成错误颜色 → v4 feedback 指定正确颜色 → revision 形成新 prompt → 生成新候选 → 用户采用”，并精确断言 revision 与生图调用次数。
15. Skill 合同测试证明人工重生只能使用同一 selection 文件，且授权文案分别报告 revision 与 generation 上限。
