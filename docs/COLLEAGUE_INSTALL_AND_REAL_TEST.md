# Fashion Try-on 同事安装与真实测试说明

> 给执行安装的 Agent：必须完整读完本文件，再开始操作。不要只摘取命令片段。

这个未压缩目录包含 Fashion Try-on CLI、看板页面、`fashion-tryon` Skill、使用说明、源码和测试。目标是让使用者在自己的电脑上用真实 provider 走通一批：`fashion-tryon studio <素材根目录>` → 浏览器看板 → 边生成边判断 → `成图/<款号>/`，并留下可反馈的日志。

## 完成标准

只有同时满足以下条件，才能报告“同步测试完成”：

1. CLI 已安装并可直接运行 `fashion-tryon --help`。
2. 当前 Agent 的 Skill 目录已安装 `fashion-tryon`，新会话能识别它。
3. 使用者自己的 API 凭据已在本机配置；凭据没有出现在对话、命令参数或日志中。
4. 用真实 provider 至少跑通 1–2 套（每套 1 张服装 + 2–3 张模特图）：看板打开 → 点“开始” → 生成 → 判断 → 自动交付。
5. 至少一套由使用者在看板上整套通过，`成图/<款号>/` 出现对应文件；如果使用者真实觉得某张不好，再用重出或不交付，不要为覆盖分支虚构问题。
6. 安装、命令结果、耗时、生成次数、异常和人工体验已写入 `TEST_LOGS/<测试批次>/`。

Fake provider、离线测试和单元测试只能作为安装补充检查，**不能替代第 4–6 项，也不能作为最终验收结论**。真实调用费用不是跳过测试的理由。

## 目录识别

把包含本文件的目录记为 `TRYON_PACKAGE_ROOT`。不要从 Downloads、最近文件或相似目录名猜路径；使用者应提供准确的绝对路径。

```text
fashion-tryon-colleague-kit/
├── 00-请Agent先读-安装与真实测试.md
├── README.md
├── TEST-FEEDBACK-TEMPLATE.md
├── PACKAGE_INFO.json
├── SHA256SUMS.txt
├── package.json
├── pnpm-lock.yaml
├── dist/            # 已构建的 CLI
├── ui/              # 看板页面；合集页为 ui/collection.js、ui/collection-drawer.js，共享控件为 ui/controls.js
├── skills/fashion-tryon/
├── docs/            # USAGE.md 为使用说明
├── src/  tests/  scripts/
└── TEST_LOGS/
```

## 1. 建立测试日志

任何安装命令之前，先创建日志目录。目录名可以附加同事姓名或机器名，但不要放 API Key。

```bash
TRYON_PACKAGE_ROOT="/同事提供的/未压缩包绝对路径"
TRYON_TEST_ID="$(date +%Y%m%d-%H%M%S)-real-e2e"
TRYON_LOG_ROOT="$TRYON_PACKAGE_ROOT/TEST_LOGS/$TRYON_TEST_ID"
mkdir -p "$TRYON_LOG_ROOT/raw" "$TRYON_LOG_ROOT/screenshots"
{ date; uname -a; node --version; pnpm --version; } 2>&1 | tee "$TRYON_LOG_ROOT/00-environment.txt"
```

在 `$TRYON_LOG_ROOT/COMMANDS.md` 里为每个命令记录开始/结束时间、目的、完整命令（凭据写成 `<REDACTED>`）、exit code 与输出文件。

禁止执行或记录 `env`、`printenv`、`cat .env.local`，禁止把任何 API Key、token 或 `.env.local` 内容写入日志。

## 2. 校验并安装 CLI

```bash
cd "$TRYON_PACKAGE_ROOT"
shasum -a 256 -c SHA256SUMS.txt 2>&1 | tee "$TRYON_LOG_ROOT/01-checksums.txt"
pnpm install --frozen-lockfile 2>&1 | tee "$TRYON_LOG_ROOT/02-pnpm-install.txt"
pnpm build 2>&1 | tee "$TRYON_LOG_ROOT/03-build.txt"
pnpm link --global 2>&1 | tee "$TRYON_LOG_ROOT/04-cli-link.txt"
fashion-tryon --help 2>&1 | tee "$TRYON_LOG_ROOT/05-cli-help.txt"
```

- 校验失败时停止，记录失败文件，让使用者重新复制目录；不要修改文件后继续。
- 要求 Node.js 20+ 和 pnpm 10。不要用 `sudo` 覆盖系统 Node 或系统级目录。
- pnpm 报告没有全局 bin 目录时，先记录原始错误，再按 pnpm 官方提示为当前用户配置，然后重新 `pnpm link --global`。

## 3. 安装 Skill

优先使用当前 Agent 已声明的 Skill 根目录（Codex 默认 `${CODEX_HOME:-$HOME/.codex}/skills`，共享根目录可能是 `$HOME/.agents/skills`）。不要向多个未知目录盲目复制。

源目录固定为 `<TRYON_PACKAGE_ROOT>/skills/fashion-tryon`，需含 `SKILL.md` 与 `references/workflow.md`。

- 目标不存在：复制整个目录。
- 目标已存在且逐字节相同：不重复安装。
- 目标已存在但内容不同：先把旧目录移为带时间戳的同级备份，再复制新版；禁止直接删除旧 Skill。
- 安装后开新会话，确认 Skill 被识别。结果记录到 `$TRYON_LOG_ROOT/06-skill-install.txt`。

### 3.1 注册 MCP（可选，推荐）

CLI 安装好后，在使用者用的宿主里注册一次：

```bash
claude mcp add -s user fashion-tryon -- fashion-tryon mcp   # Claude Code
codex mcp add fashion-tryon -- fashion-tryon mcp            # Codex CLI
```

用 `claude mcp list` 或 `codex mcp list` 确认出现 `fashion-tryon`，新会话中能看到 `scan`、`crop`、`start_run`、`rerun`、`run_status`、`cancel_run`、`list_runs`、`open_graph` 八个工具。结果追加到 `$TRYON_LOG_ROOT/06-skill-install.txt`。

使用者想自己放图、挑图、看成图时，让 Agent 调 `open_graph`（不给 runId）打开合集页：一款一组，左衣服、右模特，有「放图」「节点」两种模式；可把图拖进放置区写入素材文件夹（只收 jpg/png/webp、单张 ≤50 MB，同名加 `(2)` 不覆盖），新建款，每款用分段控件选搭配规则（固定服装 / 固定模特 / 一对一），勾选后直接出图，并用待重出清单重出不满意的图；规则见 `docs/USAGE.md`「在合集页放图并出图」。

## 4. 配置真实 provider

包中只有空值 `.env.example`，没有任何真实凭据。

| 环境变量 | 官方入口 | 用途与注意事项 |
| --- | --- | --- |
| `APIMART_API_KEY` | [APIMart 注册/控制台入口](https://apimart.ai/) · [官方 Quick Start](https://docs.apimart.ai/en/quickstart) | 在控制台 API Key Management 创建 Key，确认账号有余额。用于换装生图。 |
| `DASHSCOPE_API_KEY` | [阿里云百炼控制台（华北 2 / 北京）](https://bailian.console.aliyun.com/cn-beijing/) · [官方获取与配置 API Key 说明](https://help.aliyun.com/zh/model-studio/get-api-key/) | 开通百炼后在“API Key”创建。默认连接中国大陆 `dashscope.aliyuncs.com`，应创建华北 2（北京）地域的 Key；不同地域的 Key 和 Base URL 不能混用。用于服装定位裁切与服装描述。 |

只从以上官方域名申请。Key 只在使用者本机保存：不要发给 Agent、粘贴进对话、写进命令参数、截图或日志。

```bash
cd "$TRYON_PACKAGE_ROOT"
test -e .env.local || cp .env.example .env.local
chmod 600 .env.local
```

让使用者在本机编辑器中填写 `.env.local`。Agent 只能检查变量是否存在且非空，不能回显或复制。凭据未配置时，状态报告为“真实测试等待本机凭据”，不能改用 Fake 生成并宣布完成。

## 5. 真实端到端测试

使用者提供一个小的素材根目录（1–2 套），按 [docs/USAGE.md](docs/USAGE.md) 的结构准备：每套一个子目录（目录名即款号），内含 `服装/` 与 `模特/`。Agent 不扫描其他目录猜素材。

1. 让已安装的 Skill 处理这个目录。它会在**后台**运行 `fashion-tryon studio <素材根目录> --json`，首行输出 `{ "url": ..., "batchDir": ... }`，保存到 `raw/10-studio.json`，把 `url` 交给使用者。
2. 使用者在浏览器看板的素材表核对每行服装裁后图与模特图的配对、搭配模式和换装范围；顶部“共 X 套、Y 张任务、Z 次生成、预计约 ¥W”截图。
3. 使用者点“开始”。这是整批唯一一次确认，Agent 不代替点击。
4. 生成过程中可以让 Agent 运行 `fashion-tryon status <素材根目录> --json`，结果保存到 `raw/11-status-running.json`。
5. 一套全部出图后进入“待判断”，使用者在页面上判断：`Enter` 整套通过；`R` 重出（选问题标签）；`X` 不交付；`Space` 三栏对照。判断和其他套的生成同时进行。
6. 通过的套自动发布到 `<素材根目录>/成图/<款号>/`。全部判完后再运行一次 `status`，保存到 `raw/12-status-final.json`。
7. 核对：`成图/<款号>/` 只包含通过的图；不交付的图和未采用的历史版本不在 `成图/`；已有同名文件没有被覆盖；批次目录里有 `总览.html` 与 `mapping.csv`。

不得为追求日志完整而虚构重出，也不得在结果正常时制造额外调用。真实发生了什么，就记录什么。

截图保存到 `screenshots/`：素材表、生成中、判断（含对照，如使用）、重出（如发生）、`成图/` 目录、`总览.html`。

批次目录 `<素材根目录名>-tryon-studio/` 里的 `studio.json` 是运行事实，不要移动或修改；反馈中记录它的路径，除非负责人明确要求，不复制含用户图片的目录。

## 6. 写反馈

把包内 `TEST-FEEDBACK-TEMPLATE.md` 复制为 `$TRYON_LOG_ROOT/FEEDBACK.md` 并填写。交给原团队前，遮挡本机用户名、无关绝对路径、客户/商品敏感名称和人物隐私；API Key、token、`.env.local` 与整份用户图片目录永远不能进入反馈。

## Agent 最终回复格式

```text
安装结果：CLI / Skill
真实测试结果：通过 / 部分通过 / 阻塞
套数与张数：N 套、N 张任务，生成调用 N 次（generationCalls）
看板地址与批次目录：url / batchDir
素材侧成图：<素材根目录>/成图/<款号>/ 下的文件
完整日志目录：...
主要问题：...
下一步需要谁处理：使用者 / 工具维护者 / provider
```

不要只回复“安装完成”或“测试通过”。没有真实 provider 结果和日志目录时，测试仍未完成。
