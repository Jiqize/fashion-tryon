# Fashion Try-on Runner v5 Spec：裁后素材确认与本地审核交接

**状态：** 已由用户于 2026-08-31 确认；本文是 v5 裁图与审核交接阶段的行为事实来源。
**范围：** 在现有本地 CLI + Agent Skill + 报告架构内，让付费生图前确认、实际生成、重新生成和报告始终使用同一份裁后服装素材，并把人工决定直接保存到 run 目录。
**基线：** v1–v4 未被本文修改的行为继续有效；本文覆盖 v1/v3 的服装全图回退、新计划不得额外视觉调用，以及 v2/v3 的报告只能下载 artifact、不得通过本机会话写入 run 目录的限制。

## 背景与目标

真实素材验收暴露出两个连续断点：

1. 目录或双目录输入已经能确定图片角色，因此会跳过视觉分类；没有 bbox 的服装素材随后只是压缩整图。用户在预检与报告中看到的并不总是正式换装最需要的目标服装区域。
2. 静态报告只能把人工决定下载到浏览器默认下载目录。用户还要把文件路径复制给 Agent，打断了本地审核链路。

v5 把两者收敛为：

~~~text
服装素材 → 视觉定位 → 唯一裁后 prepared → 预检 / 首次生成 / 重生 / 报告
报告决定 → 保存人工决定 → <run>/review-selection.json → Agent 审核
~~~

目标是消除“确认图与实际输入不同”和“人工搬运 JSON”两种隐性状态，不引入自动审核、自动付费重生或通用本地工作台。

## 关键行为

### B1 新计划必须先完成服装视觉定位

- `plan` 对所有实际被任务引用的服装素材建立可信 framing；目录角色和双目录角色只决定 `garment` 身份，不能替代服装边界定位。
- 已有可信视觉 bbox 的服装素材直接复用；缺少 bbox 时，通过 `VisionPort.locateGarment` 对完整、方向归一、最长边不超过 1600 px、少于 1 MiB 的临时工作副本定位。
- locator 只返回目标服装整体 bbox，单位为 0–1000 千分比；成套或多层目标服装的 bbox 必须覆盖所有目标层，不能把背景或展示人物当作目标真值。
- 同一内容 hash 的服装在一次计划中最多调用一次 locator；不同任务引用同一素材不能放大调用数。
- 模特图不做目标裁切，只做既有方向修正与压缩；它继续是人物、姿势、构图、裁切范围、背景和光线的真值。
- locator 缺失、返回非法 bbox 或最终裁切失败时，新计划整体失败，不写入可批准的 `generationPlan`，也不调用生图 provider；新计划不再静默使用服装全图回退。
- 视觉定位允许发生在计划阶段，不需要额外的生图授权；它不能调用 `ImageGenerationPort`，也不能改变首轮任务数与最高生图调用数。

### B2 唯一裁后 prepared 是全链路证据

- locator 使用的临时完整副本只能写在 run 目录内，计划成功或失败后都应清理；输入素材始终只读。
- 最终服装 prepared 继续使用已验证的左右 20、上 22、下 34（1024 基准等比换算）安全余量，并从原始素材生成裁后压缩副本。
- 计划 digest 继续绑定最终 prepared 的相对路径、SHA-256、尺寸、字节数与 crop box；裁切变化必须使旧批准失效。
- `preflight.html` 展示的服装图、首次生成传给 provider 的服装图、v4 重新生成观察的服装图和 `report.html` 的服装证据图必须是同一份 planned prepared 字节。
- 报告和预检不得再把新计划的服装状态描述为“全图回退”；历史 run 仍按既有事实只读展示，不迁移或重写。
- 相同输入和相同 locator 结果重建计划时，prepared 字节与 digest 保持稳定。

### B3 人工决定的确定性本地路径

- 每个 run 的当前人工 artifact 固定为 `<run-dir>/review-selection.json`。
- 有效保存始终写 schema v4、kind `fashion-tryon-review-selection`；内容按 manifest 任务顺序，字段与 v4 selection 合同一致。
- 保存前必须使用现有 selection parser 和 review dry-run 语义整体验证 schema、run、task、version 所有权、hash、重复项和 feedback；任一错误不得改动已有文件。
- 有效保存使用 mode `0600` 的临时文件加原子 rename；再次保存原子替换同一路径，不能留下半截 JSON。
- `review-selection.json` 是显式人工 artifact，不是 manifest/state/review/events 运行事实；保存不追加事件、不应用决定、不调用 vision 或生图 provider。
- Agent 只有在用户随后表达“审核”或同义意图后，才把该文件原样交给 `review --dry-run` 与 `review`；包含 regeneration 时继续遵守 v4 双调用上限授权。

### B4 一次性本机审核会话

- CLI 新增 `fashion-tryon review-session <run-dir> [--json]`。
- 命令先从最新 run facts 重建 `report.html`，再只监听 `127.0.0.1` 的随机端口，返回 `reviewUrl`、`reportPath` 与固定 `selectionPath`。
- URL 使用至少 128 bit 的随机 session token；服务器只允许读取当前 run 的 `report.html`、`prepared/` 和 `images/`，不提供目录列表，不暴露 manifest/state/review/events。
- 唯一写接口只接受同源 `application/json` POST，body 上限 1 MiB，并且只能原子写固定的 `review-selection.json`。
- 第一次成功保存后，响应成功消息并关闭审核会话；无效请求返回可理解错误且会话继续可用。进程收到中断时关闭监听，不写 artifact。
- 审核会话不是常驻服务、远程服务或运行状态桥；它不能调用 CLI review、retry、finalize 或 provider。

### B5 报告保存交互与离线兼容

- 报告主动作统一为“保存人工决定”。在审核会话中，它 POST 当前严格 v4 selection，并显示已保存条数与 `selectionPath`；成功后不再触发浏览器下载。
- 直接通过 `file://` 打开报告时，同一动作退化为现有 JSON 下载，文件名继续包含 run ID；页面明确提示这是离线下载方式。
- 保存和下载共享同一个 `buildSelection` 与浏览器端严格校验；空 regeneration feedback 等错误继续在任务内联提示，不能发送或下载无效 artifact。
- localStorage 草稿、导入兼容、三选一决定、版本绑定和离线零网络能力保持不变。
- 本机保存失败时保留浏览器草稿并显示错误，不自动退回下载，也不把失败误报为成功。

### B6 Agent Skill 主路径

- Skill 在返回人工报告时优先启动 `review-session` 并把可点击 `reviewUrl` 交给用户，不要求用户复制 Downloads 路径。
- 用户点击保存并说“审核”后，Skill 从已知 run 目录读取固定的 `review-selection.json`；不得扫描其他下载文件、猜测最新 run 或从 localStorage 重建选择。
- 用户显式提供其他 selection 路径时，历史 CLI 路径仍可使用。
- Skill 继续只调用 CLI；裁切、保存校验和原子写盘逻辑不得复制进 Skill。

## Out of Scope

- 裁切编辑器、手动画框、自动裁切模特图或改变模特构图。
- 把 locator 变成角色分类替代品，或让它改变目录/输入已经确定的素材角色。
- 保存时自动应用 review、自动生成、自动定稿或自动发布。
- 常驻后台服务、远程 Web UI、账号、多用户审批、MCP 或通用文件写入 API。
- 删除静态 `file://` 报告、JSON 下载兼容、历史 selection 或历史全图回退事实。

## 验收标准

1. 结构化单目录和双目录各自无需视觉角色分类，但每个唯一缺 bbox 的服装内容恰好调用一次 locator；模特不调用 locator。
2. 两个任务引用相同服装内容时只定位一次，两份最终 planned garment 都有可信 crop box；所有临时定位副本被清理。
3. locator 返回缺失/非法 bbox 或裁图失败时，plan 在生图 provider 调用数为 0 时失败，manifest 没有新的可批准 plan。
4. 新计划中每个服装 prepared 均为裁后副本；模特 prepared 保留完整构图；相同事实重建得到相同 prepared hash 与 digest。
5. preflight、首次 fake generation、v4 fake regeneration 和 report 的服装路径/hash 全部对应同一 planned prepared 文件。
6. 直接 `file://` 打开报告仍零网络并下载严格 v4 JSON；现有导入、草稿和三选一浏览器测试继续通过。
7. `review-session --json` 返回 loopback token URL 与 `<run>/review-selection.json`；页面保存有效决定后文件 mode 为 `0600`、内容可被 CLI parser 与 review dry-run 接受，且不产生 review/event/provider 写入。
8. 跨 run、未知版本、错误 hash、重复 task、空 feedback、错误 content type 和超过 1 MiB 的请求都不会覆盖最后一个有效 selection。
9. 审核服务器不能读取 run facts JSON、父目录或任意路径；第一次成功保存后停止监听，中断前未保存则不创建 artifact。
10. Skill 合同证明普通审核从已知 run 的固定 selection 路径继续，regeneration 仍先报告 prompt revision 与生图两个上限并取得授权。
11. 全部普通测试使用 fake vision/image adapters 和本地合成图片；不执行真实 DashScope/APIMART 调用，不提交用户 run、图片、selection 或私人绝对路径。
