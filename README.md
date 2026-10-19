# Fashion Try-on Runner

本地文件夹驱动的批量换装工具。一个素材根目录就是一批：`fashion-tryon studio <素材根目录>` 启动本地看板，在页面上看素材表、确认开始一次，之后边生成边按套判断，判完的套自动交付到 `<素材根目录>/成图/<款号>/`。

人的判断是唯一的质量关口：不做 AI 自动质检、不做逐步授权，默认整套通过，只标记例外。

## 快速上手（macOS）

需要 Node.js 20+、pnpm 10，以及一种出图引擎：默认 [Codex CLI](https://github.com/openai/codex)（装好并 `codex login` 登录），或 APIMart（见下文「安装与配置」）。

~~~bash
git clone https://github.com/Jiqize/fashion-tryon.git
cd fashion-tryon
pnpm install
pnpm build
pnpm link --global          # 之后可直接用 fashion-tryon 命令
pnpm install:launcher       # 安装「Tryon 合集」到 ~/Applications，桌面放替身
~~~

双击桌面「Tryon 合集」打开项目页 →「＋ 新建项目」选一个素材文件夹 → 在合集页放图、勾选款、点「出图」→ 成图写到 `<素材文件夹>/成图/<款号>/`。素材文件夹结构：`<款号>/服装/` 放衣服图，`<款号>/模特/` 放模特图。详见 [docs/USAGE.md](docs/USAGE.md)。

更新：`git pull && pnpm install && pnpm build`；换了 node 或仓库位置后重跑一次 `pnpm install:launcher`。

## 精简流程（默认）：`fashion-tryon run`

~~~bash
fashion-tryon run <素材根目录> [--engine codex|apimart] [--max-refs <n>] [--no-open] [--json]
~~~

不做配对确认、不调用视觉模型、不做质检。可选先裁图（Agent 默认会做）：

~~~bash
fashion-tryon crop <素材根目录> --plan crops.json [--replace]   # 按方案从服装原图裁出参考图，写到 裁图/<款号>/
~~~

方案格式：`{ "<款号>": [{ "from": "0 (5).jpg", "role": "细节-领口", "box": [300, 250, 950, 550] }] }`，`box` 是千分比，不写就用整张图。某款 `裁图/<款号>/` 里有图时，`run` 用裁图代替 `服装/` 原图作参考；自己裁好的图也可以直接放进去。


1. **素材**：支持 `<款号>/服装/` + `<款号>/模特/`，也支持 `服装/<款号>/` + `模特/<款号>/`。
2. **出图**：每张模特照出一张图；同款全部服装图（默认最多 6 张）一起作参考。服装图文件名含 `全身` / `半身` / `侧面` / `背面` / `细节` 时，作为这张图的用途写进提示词，例如 `细节-领口.jpg`。
3. **规则**：只换服装和鞋。模特身上戴的项链、系在脖子上的围巾去掉，手里拿的包和围巾保留；人物、姿势、背景、构图不变。提示词见 `src/simple/prompt.ts`。
4. **交付**：成图写到 `<素材根目录>/成图/<款号>/<模特图名>.png`，同名不覆盖、自动加 `-v2`。本次运行的缩图、提示词、`run.json` 和 `report.html` 在 `成图/_runs/<时间>/`，报告跑完自动打开。
5. **引擎**：默认 Codex CLI 内置出图（串行，每张约 2–3 分钟，`CODEX_IMAGE_MODEL` 可换模型）；`--engine apimart` 走 APIMart，需要 `.env.local` 里的 `APIMART_API_KEY` 与 `IMAGE_MODEL`。

## MCP（Claude Code / Codex CLI）

把精简流程包成本机 stdio MCP 服务，装上后 Agent 不读 skill 也能完成“扫描 → 裁图 → 出图 → 查进度”。注册一次（不监听任何端口，由宿主按需启动）：

~~~bash
claude mcp add -s user fashion-tryon -- fashion-tryon mcp   # Claude Code（-s user：所有目录可用）
codex mcp add fashion-tryon -- fashion-tryon mcp            # Codex CLI
~~~

| 工具 | 作用 |
| --- | --- |
| `scan` | 只读扫描素材根目录：每款的服装图、模特图、已有裁图，缺图的款带提示 |
| `crop` | 按裁切方案裁参考图到 `裁图/<款号>/`，与 `fashion-tryon crop` 相同 |
| `start_run` | 后台出图，立即返回 runId、节点图路径与可编辑节点图地址 `editorUrl`；按合集页保存的搭配规则出图，会话结束不影响出图 |
| `rerun` | 只重出选中的几张：从已有出图挑图，按款改参考图、提示词、换装范围后新建一次出图；固定模特、一对一的组合在 shot 里带 `item`（衣服图） |
| `open_graph` | 打开某次出图的可编辑节点图（必要时拉起本机编辑服务），返回页面地址；不给 runId 时打开合集页 |
| `run_status` | 查进度：整体状态、计数、当前正在出的那张、每张状态与路径 |
| `cancel_run` | 取消：正在出的那张放弃，已交付的图保留，其余标为已取消 |
| `list_runs` | 历史出图，按时间倒序 |

- 每次出图在 `成图/_runs/<runId>/graph.html` 生成节点图，进行中每 3 秒刷新；`report.html` 照旧保留。
- 开始出图后自动打开**可编辑节点图**（本机编辑服务，只监听 `127.0.0.1`，页面闲置 30 分钟自动退出，不影响进行中的出图）。直接双击 `graph.html` 是只读页面；要编辑让 Agent 调 `open_graph`，或运行 `fashion-tryon editor <素材根目录>`。
- 在可编辑节点图里按款修改参考图（移除、调整顺序、改用途名、从原图或裁图添加、在图上拖框裁一张新的）、提示词（改过标「已改」，可恢复默认）、换装范围和模特图，勾选要重出的图点「重出」：只出勾选的图，新建一次出图并标明「来自 <runId>」，交付照旧写入 `成图/<款号>/` 并加 `-v2`、`-v3`，从不覆盖。人工改的提示词只用于这一次；页面里移除参考图不删文件。选 apimart 会产生真实费用，需二次确认。
- 参考图上带模特的脸会把成图带偏：先把脸裁掉（页面拖框或 `crop`），再只重出有问题的那张。
- **项目页**：一个素材根目录一个项目，双击「Tryon 合集」或 `fashion-tryon open` 打开；卡片显示封面、款数 · 成图数、最近出图、待重出，点进去是该目录的合集页。详见 `docs/USAGE.md`「项目页」。
- 页面顶部的「合集」进入**合集页**（`open_graph` 不给 runId、`fashion-tryon editor <素材根目录>` 直接打开）：一款一组，左边衣服、右边模特。顶栏用分段控件切换两种模式（浏览器记住上次的选择），旁边的滑块调缩略图大小：
  - **放图**：把电脑里的图拖进衣服、模特放置区（或点击选择）就写进对应目录，显示「正在放入 x / y」；可以「新建款」。只收 jpg / png / webp、单张不超过 50 MB；沿用素材目录现有的目录结构（新目录用 `<款号>/服装/`、`<款号>/模特/`），同名加 `(2)`、`(3)`，从不覆盖；页面不删图，放错了在 Finder 里删。
  - **节点**：每款一条流程：衣服 → 设置 → 每个出图组合一行（模特或「衣服 + 模特」→ 历次成图 v1、v2…）。
- 每款选一种搭配规则（默认固定服装）：
  - **固定服装**：左边是同一套衣服的多张参考图，每个选中的模特穿上整套各出 1 张。例：左 ABCD、右 EFG → 3 张，成图 `成图/<款号>/<模特图名>.png`。
  - **固定模特**：左边每张图是一件单品，每张选中的衣服图配唯一选中的模特各出 1 张；右边必须正好选 1 个模特，否则提示「固定模特只能选 1 个模特」不出图。例：左 A–G、右 X → 7 张，成图 `成图/<款号>/<衣服图名>-<模特图名>.png`。
  - **一对一**：第 n 张衣服图配第 n 张选中的模特图，多出的标「未配对」不出图。例：左 ABC、右 EFG → AE、BF、CG 3 张，命名同固定模特。
  - 固定模特、一对一下每件衣服只用一张参考图（裁过的默认用裁图，可在编辑里改选）。重出加 `-v2`、`-v3`，一律不覆盖。
- **保持画幅**：提示词末尾追加「保持图1的取景范围，被截掉、没拍到的身体部位不要补画。」；模特图标「半身」的出图时总是加这句。不做任何自动检测。搭配规则、保持画幅、半身标记保存在 `成图/_runs/collection.json`，不写进素材文件夹。
- 组头的搭配规则、换装范围是分段控件，保持画幅是开关；拖动组头序号调整顺序，「…」菜单可移到最前 / 最后、折叠。⌘F 搜索、⌘↩ 出图；选中缩略图按空格快速预览；所有弹层按 Esc 关闭。出图中底栏显示「出图中 N/M」，可「停止」（确认后取消，已交付的图保留）。apimart 出图、替换裁图、停止出图、恢复默认都弹出工作表确认；结果用 toast 提示。
- **待重出**：点成图打开对照，「加入待重出」跨款收集，每项可填一行备注，移除后可在 toast 上「撤销」；「重出这 N 张」按产出它的那次出图的参考图、范围、提示词重出，备注追加到提示词末尾，合成一次新出图。固定模特、一对一的组合在 run 节点图里只读显示，重出在合集页完成。
- 页面出图与 `start_run` 走同一套逻辑；从未在合集页设置过的款按固定服装，与原来完全一致。
- 同一素材目录同时只跑一个出图，第二个直接被拒绝并返回正在跑的 runId。
- 出图进程被强杀或关机后显示“已中断”，不自动续跑；需要补出的款用 `start_run` 指定 `skus` 重新开始，已交付的图不会被覆盖。

下面的 `studio` 看板仍可用，适合需要逐张判断、调整裁切的场景。

## Studio 看板

- [文字版使用说明](docs/USAGE.md)
- [架构](docs/ARCHITECTURE.md) · [输入输出约定](docs/INPUT_OUTPUT.md) · [安全与密钥](docs/SECURITY.md)

## 一句话开始

~~~text
请用 fashion-tryon 处理 /绝对路径/本次素材
~~~

Agent 在后台运行 `fashion-tryon studio /绝对路径/本次素材`，把返回的页面地址给你；之后全部在页面里完成。

## 流程

1. **拖入/指定目录**：把素材根目录路径交给 Agent（浏览器拿不到本地文件夹的绝对路径，因此不在页面拖入）。每个子目录是一套，目录名即款号，套内分 `服装/` 与 `模特/`。
2. **看素材表确认开始**：每行一套，左侧是服装裁后图，右侧是这套的模特图。可手动调整裁切框、展开查看提示词，在顶部选搭配模式、换装范围、每张候选数（1–4）和并发数（默认 5，上限 10），看"共 X 套、Y 张任务、Z 次生成、预计约 ¥W"后点"开始"。这是整批唯一一次确认；也可以只勾选部分套，之后再追加。
3. **边生成边按套判断**：按套优先生成，一套出齐即进入"待判断"，其余套继续生成。一套没问题就按 `Enter` 整套通过；有问题的图按 `R` 重出（选问题标签）或按 `X` 不交付。
4. **自动交付**：一套判完立即写到 `<素材根目录>/成图/<款号>/`，同名不覆盖、自动加后缀，内容相同不重复写。批次目录里同时更新 `总览.html` 与 `mapping.csv`，可直接发给同事。

关掉页面或进程崩溃后，再次运行同一条 `studio` 命令即恢复全部状态；已提交给服务商的任务只续取结果，不会重复提交、重复计费。

## 搭配模式

| 模式 | 一套内的素材 | 产出 |
| --- | --- | --- |
| 固定服装（默认） | 1 张服装 + N 张模特姿势 | N 张，每个姿势一张 |
| 一对一 | N 张服装 + N 张模特 | N 张，按顺序配对 |
| 固定模特 | N 张服装 + 1 张模特 | N 张，每件衣服一张 |

整批一个默认值，单套可以覆盖。数量不符合模式的套标为"素材不全"，不影响其他套。

## 快捷键

| 按键 | 作用 |
| --- | --- |
| `↑` / `↓` | 切换套 |
| `←` / `→` | 切换同套内的图 |
| `Enter` | 整套通过（未标记的图全部采用并交付）；在设置条里等于"开始" |
| `R` | 重出：`1`–`8` 多选问题标签，`Tab` 写一句说明，`Enter` 确认，`Esc` 取消 |
| `X` | 标记 / 取消不交付 |
| `1`–`4` | 在同一张图的候选或历史版本之间切换 |
| `Space` | 放大对照：服装裁后图、模特原图、成图三栏同步放大；`Space` / `Esc` 关闭 |
| `E` | 展开提示词 |
| `C` | 调整服装裁切框（`Enter` 保存，`Backspace` 恢复自动裁切，`Esc` 取消） |
| `⌘Z` / `Ctrl+Z` | 撤销最近一次判断 |

已交付的套可以"撤回交付"后重新判断；撤回只改本批记录，`成图/` 里已写出的文件保留。

## 命令

~~~bash
fashion-tryon run <素材根目录> [--engine codex|apimart] [--max-refs <n>] [--no-open] [--json]   # 精简流程，跑完输出 { report, counts }
fashion-tryon mcp                                                                         # 本机 stdio MCP 服务（由宿主启动）
fashion-tryon editor <素材根目录> [--run-id <id>] [--port <n>] [--no-open] [--json]           # 可编辑节点图的本机服务，首行输出 { url, origin }
fashion-tryon hub [--port <n>] [--no-open] [--json]                                           # 项目页服务（全局一个），首行输出 { url, origin }
fashion-tryon open [素材根目录] [--no-open] [--json]                                          # 不给目录打开项目页，给目录打开它的合集页
fashion-tryon rerun <素材根目录> --plan <file> --run-id <id> [--json]                          # 按重出计划只出选中的图（MCP 与页面在后台调用）
fashion-tryon crop <素材根目录> --plan <file> [--replace] [--json]                           # 裁图，写到 裁图/<款号>/
fashion-tryon studio <素材根目录> [--port <n>] [--no-open] [--json]   # 常驻本地服务，首行输出 { url, batchDir }
fashion-tryon status <素材根目录> --json                               # 只读查询进度
~~~

服务只监听 `127.0.0.1`，URL 带随机 token。批次数据全部写在 `<素材根目录的父目录>/<素材根目录名>-tryon-studio/`，素材目录本身只读（`成图/` 除外）。

## 安装与配置

需要 Node.js 20+ 与 pnpm 10。

~~~bash
pnpm install
pnpm build
pnpm link --global
fashion-tryon --help
~~~

配置按顺序读取：shell 环境变量、当前工作目录的 `.env.local` / `.env`、安装包根目录的 `.env.local` / `.env`；先出现的值优先。需要 `APIMART_API_KEY`、`DASHSCOPE_API_KEY`、`IMAGE_MODEL`，可选 `VISION_MODEL`、`IMAGE_PRICE_CNY`（单张单价，用于页面显示预计费用）。provider 端点必须是 https；改用非默认主机时需另设 `FASHION_TRYON_ALLOW_CUSTOM_PROVIDER_HOST=1`。

API Key 只从官方入口创建：

- `APIMART_API_KEY`：[APIMart 注册/控制台](https://apimart.ai/)；操作步骤见 [APIMart Quick Start](https://docs.apimart.ai/en/quickstart)。
- `DASHSCOPE_API_KEY`：[阿里云百炼控制台（华北 2 / 北京）](https://bailian.console.aliyun.com/cn-beijing/)；操作步骤见 [阿里云百炼获取与配置 API Key](https://help.aliyun.com/zh/model-studio/get-api-key/)。仓库默认使用中国大陆 DashScope Base URL，不能混用其他地域的 Key。

密钥只填在本机 `.env.local`，不要发到对话、命令参数、截图或日志中；页面、日志、`studio.json` 与交付物都不包含密钥。

## 验证

默认测试全部使用假服务商，不产生网络或额度消耗：

~~~bash
pnpm test
pnpm typecheck
pnpm build
pnpm scan:secrets
~~~

真实服务商冒烟（2 套 × 3 张，会产生费用）默认跳过，只有明确授权后才运行：

~~~bash
FASHION_TRYON_PAID_E2E=1 PAID_E2E_SOURCE_ROOT=/绝对路径/冒烟素材 pnpm test:paid
~~~

## Agent Skill

[skills/fashion-tryon/SKILL.md](skills/fashion-tryon/SKILL.md)：装了 MCP 时 Agent 优先用 MCP 工具，否则走 CLI。studio 场景下 Agent 只负责后台启动 `studio` 并返回 `url`、用 `status` 查询进度；不代替用户判断，不复制或移动文件。完整说明见 [workflow reference](skills/fashion-tryon/references/workflow.md)。
