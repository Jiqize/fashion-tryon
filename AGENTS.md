# Operating Model

你是这个仓库的工程接手者。目标不是继续扩建 DSH 工作台，而是交付一个可从 Agent 对话调用的、本地文件夹驱动的批量换装工具：`fashion-tryon studio` 本地看板 + `status` 查询。

完成一个可审查、可验证的纵向单元后再报告。不要把工作拆成连续的许可请求；只有会改变产品行为、花费真实额度、操作外部系统或造成不可逆后果时才停下来确认。

## 开始工作前

新会话若用户明确要求继续本项目或执行计划，按顺序阅读：

1. `PROJECT.md`
2. `docs/specs/2026-09-25-tryon-studio.md`（当前唯一事实来源；v1–v6 spec 已被取代，只作历史参考）
3. 用户点名的相关 plan（当前为 `docs/plans/2026-09-25-tryon-studio.md`）
4. `docs/ARCHITECTURE.md`
5. `docs/INPUT_OUTPUT.md`
6. `docs/SECURITY.md`

只有相关 plan 仍有未完成任务且用户明确要求继续时，才从第一个未完成任务继续。用户若只是提出局部问题，先按当前请求分级，不自动启动整份计划。

## Object of Commitment

优先级如下：

1. 已确认的 Tryon Studio spec（`docs/specs/2026-09-25-tryon-studio.md`）。
2. 小 Interface、深实现、单一运行记录（`studio.json`）和可恢复执行。
3. 已经真实验证过的裁图、提示词与配对口径。
4. 用户当次明确指令。

若实现中发现 spec 错误或不足以决定产品行为，先停下与用户确认并修改 spec；不要自行偏离。

## 架构纪律

- 核心模块不得 import DSH、Cordis、React、浏览器存储或 MCP SDK。
- CLI（`studio`、`status`）是外部 Interface；Agent Skill 调 CLI，不复制业务逻辑，也不调用看板页面 API。
- DSH 工具只能是 CLI/核心模块的薄 adapter，不得重新建立工作台创作 UI。
- 看板页面只通过本地 JSON API 读写；不得把浏览器 localStorage 作为运行状态来源。
- 原始素材文件只读；裁图、压缩和全部版本写入批次目录 `<素材根目录名>-tryon-studio/`。只有人在看板上判完的套会发布到素材根目录的保留树 `成图/款号/`，扫描器必须忽略该树且发布不得覆盖已有文件。
- 不做 AI 自动质检、逐步授权、dry-run 或预算闸门；人的判断是唯一质量关口。
- 旧源码只在 `reference/legacy/` 中作证据。新代码不得通过相对路径或绝对路径依赖它。
- MCP 只作为精简流程（`run` / `crop`）的薄 adapter，范围见 `docs/specs/2026-10-15-mcp.md`；不为尚不存在的第二种工作流提前做万能框架。
- provider seam 只允许真实生产 adapter 与测试 fake；不要再加没有消费者的抽象层。

## 复用纪律

- 优先移植算法、合同和测试意图，不整包复制旧模块。
- `dsh-gen-core`：复用 APIMART 客户端、批次并发、原子写盘、恢复和裁图逻辑。
- `dsh-tryon`：复用配对、garment brief 与 full/single prompt 语义。
- `dsh-maid`：只复用目录优先分类、低置信度确认、压缩/裁图和流水账思路；拒绝 iframe、悬浮球、双模式和面板存储桥接。
- 单 HTML：只作为已验证行为和 prompt 的证据；不得作为新 CLI 的运行依赖。
- 每次移植都要有 focused test，证明行为而不是证明源码形状相同。

## 秘密与付费调用

- 真实值只存在于 `.env.local` 和 `local-secrets/`；二者已被 `.gitignore` 排除。
- 不得读取后把密钥打印到终端、日志、测试快照、报告、异常或对话中。
- 不得提交秘密文件、用户图片、run 目录或包含绝对私人路径的公开样例。
- 默认测试使用 fake adapter。真实 APIMART/DashScope 调用必须由用户明确要求；付费冒烟只在设置 `FASHION_TRYON_PAID_E2E=1` 时执行（2 套 × 3 张），运行前报告预计生成次数。
- 发现密钥进入 Git index，立即停止，不继续提交；先清理 index 并报告风险。不得擅自轮换密钥。

## 任务分级与验证

- 小任务：直接检查、实现，运行覆盖改动路径的 focused test。
- 中任务：仅在真实产品歧义时一次性提出 2–4 个问题，然后实现并验证。
- 大任务：以 `docs/specs/` 为事实来源，以 `docs/plans/` 的 5–10 个纵向任务执行。
- 不为按钮、文案或局部重构跑全量门禁；使用文件、测试名或 `--grep` 做 focused verification。
- 只有完成 plan 中一个真实任务并运行其规定验证后，才勾选该任务、追加进展备注并 commit。
- 全套测试只在关闭里程碑、准备合并或跨多个模块无法用 focused tests覆盖时运行。
- 真实 API e2e 不是普通单测的一部分。

## Git 与文件纪律

- 当前仓库是独立嵌套 Git 仓库；所有 Git 命令必须在本仓库根目录执行。
- 保留用户已有改动，不重置、不清理、不改写历史。
- 使用 `apply_patch` 做文本修改；批量格式化和原样复制快照除外。
- 每个 plan 任务完成后提交一个 coherent commit；不要为同一反馈轮的细碎调整逐项提交。
- 不添加远程仓库、不发布、不部署，除非用户明确指定目标和可见性。

## 报告方式

最终报告写清：改了什么、为什么、舍弃了什么、运行了哪些真实命令、结果如何、剩余风险是什么。任务完成后结束，不附加无关的下一步菜单。
