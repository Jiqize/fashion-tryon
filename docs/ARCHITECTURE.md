# Architecture

## 核心判断

一个本地常驻看板替代原来的"命令流水线 + 指纹授权 + selection artifact"。调用者只给素材根目录；扫描、配对、裁切、提示词、并发调度、限流、恢复、判断与交付都隐藏在 `studio` 进程内。人的判断是唯一质量关口。

~~~text
Agent Skill / Human shell
          │  fashion-tryon studio <root> · status <root>
          ▼
┌─────────────────────────────────────────────┐
│ CLI (src/cli.ts)                            │
├─────────────────────────────────────────────┤
│ Studio server (127.0.0.1 + token)           │
│ JSON API · SSE · 静态页面 ui/ · 图片文件    │
├──────────────────────┬──────────────────────┤
│ Engine               │ Decisions            │
│ 准备 · 按套调度 ·    │ 整套通过 · 不交付 ·  │
│ 候选 · 限流 · 恢复   │ 选版本 · 重出 · 撤回 │
│                      │ · 撤销 → Publish     │
├──────────────────────┴──────────────────────┤
│ BatchStore：studio.json 原子整体替换 + 运行锁│
├─────────────────────────────────────────────┤
│ Ports：VisionPort · ImageGenerationPort      │
├─────────────────────────────────────────────┤
│ Production adapters (DashScope · APIMART) · test fakes │
└─────────────────────────────────────────────┘
~~~

页面直接调用 JSON API 写判断，没有"保存"与"应用"两步；引擎事件通过 SSE 推给页面。Agent 不调用页面 API，只启动 studio 与查询 status。

## 模块职责（src/）

| 模块 | 职责 |
| --- | --- |
| `studio/fs-scan.ts` | 只读遍历素材目录：跳过 `成图/`、`.git`、系统伴生文件；魔数校验；内容 sha256；NFC 路径与码位排序；角色目录名与稳定 ID |
| `studio/scan.ts` | 素材根目录 → 组与素材；按搭配模式生成任务；素材不全标记；重扫合并（保留已有任务、版本与判断，内容变化的任务标 `INPUT_CHANGED`） |
| `studio/prepare.ts` | 服装定位裁切（`VisionPort.locateGarment`）、手动裁切覆盖、模特图压缩、服装描述缓存与六段式首轮 prompt |
| `studio/model.ts` | `studio.json` 的 zod schema、组状态与整批计数的派生函数 |
| `studio/store.ts` | 批次目录、运行锁（死进程锁可回收）、原子保存、版本图片不覆盖写入、缩略图缓存 |
| `studio/limiter.ts` | 可调并发闸门：限流减半并退避，连续成功回升，运行中改上限 |
| `studio/engine.ts` | 生成队列、按套优先、候选数、暂停/继续、失败重试、重出、崩溃恢复、事件 |
| `studio/regen-prompt.ts` | 问题标签 → 固定 prompt 补丁，拼装重出 prompt |
| `studio/decisions.ts` | 判断操作串行执行与撤销栈 |
| `studio/publish.ts` | 交付到 `成图/<款号>/`、同内容去重、撞名加后缀、`总览.html` 与 `mapping.csv` |
| `studio/server.ts` | node:http 服务：token 与同源校验、1 MiB 请求体上限、CSP、路径不外泄 |
| `prepare/` | 已验证的裁切压缩（`images.ts`）、服装描述缓存（`brief.ts`）、六段式 prompt（`prompt.ts`） |
| `providers/` | APIMART 生图（提交后立即回调 task ID）与 DashScope 视觉（定位、描述） |
| `config.ts` · `errors.ts` · `contracts.ts` · `ports.ts` | 配置、`RunnerError` 错误码、共用取值、provider 接口 |

`ui/index.html`、`ui/app.css`、`ui/app.js` 是原生 JS/CSS 页面，由 server 直接下发，不引入前端框架与构建。

## 精简流程与 MCP（src/simple/、src/mcp/）

~~~text
Claude Code / Codex CLI ──stdio──▶ fashion-tryon mcp（src/mcp/server.ts，6 个工具）
                                     │ scan · crop：直接调用 src/simple/
                                     │ start_run：detached 子进程 `fashion-tryon run --run-id`
                                     ▼
                     成图/_runs/<runId>/ run.json · run-data.js · graph.html · report.html · run.log
                                     ▲ run_status · list_runs 只读；cancel_run 发 SIGTERM
~~~

| 模块 | 职责 |
| --- | --- |
| `simple/run.ts` | 扫描校验 → 取锁 → 一次写出完整计划 → 准备缩略图 → 逐张出图并交付；每次状态变化原子保存；取消时放弃当前张 |
| `simple/record.ts` | 运行记录 v2（参数、整体状态、心跳、每张状态）、旧格式归一、“已中断”派生、历史列表 |
| `simple/lock.ts` | 同一素材根目录一个出图：`成图/_runs/.lock`，死进程锁可回收 |
| `simple/graph.ts` | 只读节点图静态页 + `run-data.js`，file:// 下轮询刷新、只更新变化的节点 |
| `mcp/tools.ts` · `mcp/launch.ts` | 工具业务逻辑（不依赖 SDK）、拉起与停止后台出图进程 |
| `mcp/server.ts` | 用 `@modelcontextprotocol/sdk` 注册工具；只有 `src/mcp/` 引用 SDK，`cli.ts` 仅在 `mcp` 命令里动态 import |

## 状态与恢复不变量

- `studio.json` 是唯一运行记录，每次修改整体原子替换；只含相对路径，不含密钥。
- 同一批同一时间只允许一个 studio 进程（`<batchDir>/.run.lock`）；持锁时清理上次遗留的版本临时文件。
- 首轮 prompt 在提交前落盘；服务商受理后立即保存 `providerRequestId` 与 `submittedAt`。重开后有 task ID 的作业只续取结果；已提交但没有 task ID 的作业标为"提交结果未知"，只能由人手动重试，不自动重提。
- 限流发生在受理前，作业放回队首；同一波并发返回的多次限流只降速一次。
- `generationCallsUsed` 只在拿到结果后递增。
- 所有版本追加保存，不覆盖；采用哪个版本只由人的判断改变（首个到达的候选默认采用，重出结果回到同一格并被采用）。
- 交付只写 `成图/<款号>/`：同内容跳过，撞名加 `_2`、`_3`，从不覆盖；撤回交付不删除已写出的文件。
- 素材目录除 `成图/` 外只读。

## 明确拒绝

- AI 自动质检、打分或排序；逐步授权、dry-run、review-selection 文件、一次性审核会话；预算闸门。
- 页面拖入目录（浏览器拿不到绝对路径）；远程访问、多人协作、手机端。
- 遮罩或局部编辑；重出是整图重新生成。
- 旧运行目录（manifest/state/review）的迁移或兼容读取。
