# 页面放图与新建出图 Implementation Plan

**Goal:** 在可编辑节点图里新增「素材」视图：把电脑里的图拖进页面写入素材文件夹、新建款、出图前编辑并直接出图；同时把编辑面板改成拖拽和点图操作。
**Architecture:** 文件夹仍是唯一事实来源。上传由编辑服务按现有目录结构写入素材根目录；页面出图复用重出的「计划 → `rerun` 子进程」通路，计划由与 `runSimple` 共用的默认设置函数生成，保证与 `start_run` 等价。页面脚本拆成共用面板模块 + run 页面 / 素材页面两个入口。
**Tech Stack:** TypeScript / Node 20、node:http、sharp、zod、Vitest、Playwright、tsdown；前端为无构建的原生 JS（`ui/*.js`）。
**Spec:** `docs/specs/2026-10-15-page-upload-new-run.md`（已确认）

## Global Constraints

- 文件夹是唯一事实来源；页面不删除、不改名、不移动任何素材文件；已有文件从不覆盖。
- 只收 `.jpg` `.jpeg` `.png` `.webp`（扩展名不区分大小写）；单个文件超过 50 MB（52_428_800 字节）不写入；heic、gif、pdf 等不写入，不自动转换。
- 同名文件加后缀：`<名> (2).<扩展名>`、`(3)`…，与 Finder 习惯一致。
- 新根目录默认按款分目录：`<款号>/服装/`、`<款号>/模特/`。
- 页面出图默认引擎 `codex`，可选 `apimart`（显示「会产生真实费用」并二次确认），与重出一致；缺密钥开始前报错。
- 同一素材根目录同一时间只允许一个出图在跑。
- 编辑服务只监听 `127.0.0.1`；所有 POST 要求 token/Cookie 鉴权与 `Origin` 等于服务 origin；CSP 不放宽（不加 `unsafe-inline` / `unsafe-eval`）。
- 错误文案里不带出素材根目录的上级路径；任何响应、记录、日志不含密钥。
- 不做自动质检、打分、自动重出。
- studio 看板、`start_run` / `run` / `crop` / `status` 现有行为不变。
- UI 文案用中文；代码英文、注释中文。

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/simple/defaults.ts`（新） | 一款的默认出图设置（参考图选取、referenceSource、默认提示词、跳过/截断说明），`runSimple` 与新建出图计划共用 |
| `src/simple/run.ts`（改） | 扫描分支改用 `defaultGroupSettings`；计划分支按 `PlannedGroup.referenceSource` 记录 |
| `src/simple/rerun.ts`（改） | `RerunPlan.fromRunId` 可选；`PlannedGroup.referenceSource` 可选；新增 `parseNewRunRequest`、`buildNewRunPlan` |
| `src/simple/upload.ts`（新） | 放图：款号校验、目录定位（沿用现有结构）、格式/大小校验、同名加后缀、原子写入 |
| `src/cli.ts`（改） | `rerun` 命令接受无 `fromRunId` 的计划（新 run 无 `derivedFrom`） |
| `src/mcp/tools.ts`（改） | 新增 `newRunTool`；`openGraphTool` 无 run 时返回素材页地址 |
| `src/mcp/server.ts`（改） | `open_graph` 说明补充「自己放图、挑图用 open_graph」 |
| `src/editor/server.ts`（改） | 新路由：`GET /materials/`、`GET /api/materials`、`POST /api/upload`、`POST /api/new-run`；`GET /` 无 run 时跳素材页；`editorMaterialsUrl` |
| `src/editor/materials-page.ts`（新） | 渲染素材页 HTML 外壳（内联样式与配色变量同节点图，脚本从 `/ui/` 加载） |
| `src/simple/graph.ts`（改） | http 模式页头加「素材」入口链接 |
| `ui/editor-panel.js`（新） | 共用编辑面板：参考图拖拽排序/加入/移除、图标按钮、可添加区、点图选模特、裁图弹窗、提示词跟随规则；暴露 `window.__EDITOR_PANEL__` |
| `ui/editor.js`（改） | run 页面胶水：勾选、底部条、重出、取消、占用轮询，面板改用 `editor-panel.js` |
| `ui/materials.js`（新） | 素材页：款卡片、放置区与上传、新建款、勾选、底部条、出图 |
| `ui/editor.css`（改） | 面板新布局、拖拽态、图标按钮、放置区、款卡片 |
| 测试 | `tests/simple-defaults.test.ts`、`tests/simple-upload.test.ts`（新）；`tests/simple-rerun.test.ts`、`tests/editor-server.test.ts`、`tests/mcp-tools.test.ts`、`tests/mcp-server.test.ts`、`tests/editor-ui.browser.test.ts`、`tests/simple-graph.browser.test.ts`（改）；`tests/materials-ui.browser.test.ts`（新） |
| 文档 | `README.md`、`docs/USAGE.md`、`docs/COLLEAGUE_INSTALL_AND_REAL_TEST.md`、`skills/fashion-tryon/SKILL.md`、`tests/colleague-package*`（打包清单含 `ui/editor-panel.js`、`ui/materials.js`） |

---

### Task 1: 共用默认设置与新建出图计划

**Files:**
- Create: `src/simple/defaults.ts`
- Modify: `src/simple/run.ts`（扫描分支与计划分支）、`src/simple/rerun.ts`、`src/cli.ts`（`rerun` 命令）
- Test: `tests/simple-defaults.test.ts`（新）、`tests/simple-rerun.test.ts`

**Interfaces:**
- Consumes: `scanSimple`、`listCrops`、`buildSimplePrompt`、`referenceRole`、`buildPromptFromRoles`、现有 `RerunPlan` / `PlannedGroup` / `runSimple({ planned, derivedFrom })`
- Produces:
  - `defaultGroupSettings(root: string, group: SimpleGroup, maxReferences: number, swap: SwapMode): Promise<GroupDefaults>`
  - `interface GroupDefaults { referenceSource: 'crops' | 'originals'; references: { file: string; role?: string }[]; prompt: string; note?: string }`（`references` 路径相对素材根目录、`/` 分隔）
  - `PlannedGroup.referenceSource?: 'crops' | 'originals' | 'custom'`；`RerunPlan.fromRunId?: string`
  - `interface NewRunRequest { shots: { sku: string; model: string }[]; groups?: Record<string, RerunGroupEdit>; engine?: 'codex' | 'apimart'; maxReferences?: number; swap?: SwapMode }`
  - `parseNewRunRequest(value: unknown): NewRunRequest`
  - `buildNewRunPlan(sourceRoot: string, request: NewRunRequest, env?: NodeJS.ProcessEnv): Promise<RerunPlan>`（返回无 `fromRunId` 的计划）

**Requirements:**
- `defaultGroupSettings` 的结果与现有 `runSimple` 扫描分支逐字一致：`裁图/<款号>/` 有图用裁图否则用服装原图，取前 `maxReferences` 张；note 文案沿用 `缺少服装图，跳过`、`缺少模特图，跳过`、`<裁图|服装图> N 张，只用了前 M 张`。
- `runSimple` 扫描分支改为调用它，现有 `run` 产物（run.json、提示词、交付）字节级不变。
- `buildNewRunPlan`：每款未给编辑时用 `defaultGroupSettings`（swap 取 `request.swap ?? 'outfit'`，maxReferences 取 `request.maxReferences ?? 6`），`referenceSource` 记 `crops`/`originals`；给了 references/prompt/swap 编辑时校验规则、报错文案与 `buildRerunPlan` 相同，`referenceSource` 记 `custom`；`promptEdited` 规则同 `buildRerunPlan`。
- 款号不存在：`找不到款号：<款号>`；模特图不在该款：`<款号> 没有这张模特图：<路径>`；没勾选：`没有勾选要出图的图`；款没有服装图：`<款号> 缺少服装图，不能出图`。
- 款内模特按扫描顺序、款按扫描顺序。
- `runSimple` 计划分支：`referenceSource` 用 `group.referenceSource ?? 'custom'`；`derivedFrom` 只在计划有 `fromRunId` 时写入。
- CLI `rerun --plan` 接受无 `fromRunId` 的计划；`parseRerunPlan` 的 schema 中 `fromRunId` 改为可选。

**Test cases:**
- 有裁图的款 → `defaultGroupSettings` 返回裁图、`referenceSource: 'crops'`；无裁图 → 原图、`'originals'`；8 张原图、上限 6 → 前 6 张且 note `服装图 8 张，只用了前 6 张`。
- 同一素材、全选模特、无编辑：`buildNewRunPlan` 的每款（款、模特、参考图、提示词、swap）与 `runSimple`（假引擎）生成的 run.json 对应字段完全一致；`swap: 'top'` 时同样一致。
- 改了参考图顺序 → `referenceSource: 'custom'`，默认提示词随新顺序生成；给了与默认不同的 prompt → `promptEdited: true`。
- 勾选不存在的款 → 抛 `找不到款号：X`；空 shots → `没有勾选要出图的图`。
- CLI `rerun` 跑无 `fromRunId` 的计划（假引擎）→ run.json 无 `derivedFrom`，交付到 `成图/<款号>/`。
- 现有 `simple-run`、`simple-rerun` 测试全部仍通过。

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：`npx vitest run tests/simple-defaults.test.ts tests/simple-rerun.test.ts` → 新用例失败（找不到导出）
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**：`npx vitest run tests/simple-defaults.test.ts tests/simple-rerun.test.ts tests/simple-run.test.ts` → 全部通过；`npm run typecheck` 通过
- [x] **Step 5: Commit**

> 进展（2026-10-15）：`defaults.ts` 抽出，`runSimple` 扫描分支改用它（原有 run 测试全过）；`buildNewRunPlan` 与重出共用参考图校验；CLI rerun 接受无 fromRunId 计划。全量 307 测试通过。

---

### Task 2: 放图模块

**Files:**
- Create: `src/simple/upload.ts`
- Modify: `src/errors.ts`（如需新增错误码）
- Test: `tests/simple-upload.test.ts`（新）

**Interfaces:**
- Consumes: `scanSimple`、`roleOfSegment`
- Produces:
  - `UPLOAD_MAX_BYTES = 52_428_800`
  - `type UploadKind = 'garment' | 'model'`
  - `validateNewSku(root: string, sku: string): Promise<void>`
  - `placeUpload(root: string, input: { sku: string; kind: UploadKind; fileName: string; bytes: Buffer }): Promise<{ file: string }>`（`file` 相对素材根目录、`/` 分隔、NFC）

**Requirements:**
- 款号校验（`validateNewSku`，新建款时调用；`placeUpload` 对未存在的款也调用）：去首尾空格后不能为空；不能含 `/` `\`、`_`、空格（扫描时款号取目录名第一个 `_` 或空格之前的部分）；不能是 `.`、`..`，不能以 `.` 开头；不能是 `成图`、`裁图`、`_runs` 或任一角色目录名（`服装`、`模特` 等 `roleOfSegment` 能识别的名字）；长度不超过 64；与已有款号重复报 `款号已存在：<款号>`。其余报 `款号不能用：<原因>`。
- 文件名：只取 `path.basename`，含 `/`、`\`、`..` 片段、空字符或以 `.` 开头时报 `文件名不能用：<名>`；扩展名不在白名单报 `<名>：只支持 jpg、png、webp`；超过 50 MB 报 `<名>：超过 50 MB`；文件头与扩展名声明的类型不符（JPEG `FF D8 FF`、PNG `89 50 4E 47`、WebP `RIFF....WEBP`）报 `<名>：不是有效的图片`。
- 目录定位：
  - 已有款且已有同类图：写到该类图现有所在目录（取扫描结果中第一张同类图的目录）。
  - 已有款但没有同类图：按根目录结构推断——该款已有另一类图位于 `<款目录>/<角色目录>/` 时写 `<款目录>/<默认角色目录>/`；位于 `<角色目录>/<款目录>/` 时写 `<该结构下同类角色目录>/<款目录>/`（根目录下已存在同类角色目录名时沿用该名，否则用默认名）。
  - 新款：根目录现有款全部按角色分目录时用 `<服装|已存在的同类角色目录名>/<款号>/`，否则用 `<款号>/服装/`、`<款号>/模特/`。
  - 默认角色目录名：garment → `服装`，model → `模特`。
- 同名：目录里已有 `<名>.<ext>` 时依次试 `<名> (2).<ext>`、`(3)`…；用独占创建写入（`wx`），并发写同名也不覆盖。
- 写入后的路径必须在素材根目录内（realpath 校验），否则报错且不留文件。
- 写入后 `scanSimple` 能在该款对应类别里看到这个文件。

**Test cases:**
- 按款分目录根（`A/服装/x.jpg`、`A/模特/m.jpg`）往 A 放服装图 `y.png` → `A/服装/y.png`，字节一致，scan 可见。
- 按角色分目录根（`衣服/A/…`、`人物/A/…`）往 A 放模特图 → `人物/A/<名>`；新建款 B 放服装图 → `衣服/B/<名>`。
- 空根目录新建款 C 放服装图和模特图 → `C/服装/…`、`C/模特/…`。
- 已有款只有服装图（按款分目录）放模特图 → `<款目录>/模特/…`。
- 已存在 `x.jpg` 再放 `x.jpg` → 写 `x (2).jpg`，旧文件字节不变；再放一次 → `x (3).jpg`；并发放 5 个同名 → 5 个不同文件。
- `a.heic`、`a.gif`、`a.pdf` → 拒绝；51 MB 的 jpg → 拒绝；扩展名 `.jpg` 内容是 PNG 头 → 拒绝；`.JPG` 大写 → 接受。
- 文件名 `../x.jpg`、`.hidden.jpg` → 拒绝且根目录外无新文件。
- 款号 `a/b`、`a_b`、`a b`、`..`、`成图`、`服装`、空串、重复款号 → 各自报错文案。

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：`npx vitest run tests/simple-upload.test.ts` → 失败（模块不存在）
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**：`npx vitest run tests/simple-upload.test.ts` 通过；`npm run typecheck` 通过
- [x] **Step 5: Commit**

> 进展（2026-10-15）：`upload.ts` 完成；写入用「临时文件 + link」保证不覆盖且不露半个文件；新款号重复按不区分大小写判断（macOS 文件名不区分大小写）；`detectMediaType` 从 fs-scan 导出复用。

---

### Task 3: 编辑服务新路由与 MCP 对接

**Files:**
- Create: `src/editor/materials-page.ts`
- Modify: `src/editor/server.ts`、`src/mcp/tools.ts`、`src/mcp/server.ts`（`open_graph` 说明）
- Test: `tests/editor-server.test.ts`、`tests/mcp-tools.test.ts`、`tests/mcp-server.test.ts`

**Interfaces:**
- Consumes: Task 1 `parseNewRunRequest`、`buildNewRunPlan`、`defaultGroupSettings`；Task 2 `placeUpload`、`validateNewSku`、`UPLOAD_MAX_BYTES`；现有 `launchRerun`、`checkStartable`、`readActiveLock`、`listCrops`、`scanSimple`
- Produces:
  - `editorMaterialsUrl(origin: string, token: string): string` → `${origin}/materials/?token=${token}`
  - `newRunTool(input: { sourceRoot: string; open?: boolean } & Record<string, unknown>, config: LaunchConfig): Promise<RunSummary>`
  - `openGraphTool` 返回类型改为 `{ runId: string | null; url: string }`
  - `renderMaterialsPage(): string`
  - HTTP：
    - `GET /materials/` → 素材页 HTML（`/materials` 302 到 `/materials/`）
    - `GET /api/materials` → `{ activeRunId: string | null; latestRunId: string | null; maxReferences: 6; engineDefault: 'codex' | 'fake'; groups: { sku: string; garments: string[]; crops: string[]; models: string[]; defaults: { swap: 'outfit'; references: {file, role?}[]; prompt: string; referenceSource: 'crops' | 'originals'; note?: string } }[] }`
    - `POST /api/sku` body `{ sku }` → `{ sku }`（只校验，不写文件）
    - `POST /api/upload?sku=<款号>&kind=garment|model&name=<文件名>` 原始字节，`content-type` 为 `image/jpeg|image/png|image/webp|application/octet-stream` → `{ file }`
    - `POST /api/new-run` body 为 `NewRunRequest` → `RunSummary & { url }`（`url` 为新 run 的编辑页地址）

**Requirements:**
- `GET /`：有 run 时行为不变；没有 run 时 302 到 `/materials/`（不再 404）。
- 素材页与 run 页同样鉴权、同样 CSP 生成方式；素材页加载 `/ui/editor-panel.js`、`/ui/materials.js`、`/ui/editor.css`；`/ui/` 静态路由放行 `editor-panel.js`、`materials.js`（白名单，其它文件 404）。
- `/api/upload`：鉴权与 `Origin` 校验同其它 POST；先看 `content-length`，超过 `UPLOAD_MAX_BYTES` 直接 413 `超过 50 MB` 且不读完整个请求体；流式累计超过上限同样 413；其余错误按 `placeUpload` 文案返回 400；成功 200。上传接口不受 1 MiB JSON 上限影响，其它 POST 仍为 1 MiB。
- `/api/new-run`：素材根目录以服务为准，不从请求取；先 `checkStartable`（占用返回 409 + 正在跑的 runId，apimart 缺密钥报错），计划出错不建 run；用 `launchRerun` 启动，返回新 run 编辑页地址。
- `newRunTool`：供 `/api/new-run` 调用，逻辑同上；不注册为 MCP 工具。
- `openGraphTool`：给了 runId 行为不变；没给 runId 且有 run → 最近一次；没有任何 run → 拉起服务并返回素材页地址，`runId: null`。
- `open_graph` 说明补一句：`用户想自己放图、挑图时，用 open_graph 打开页面，不必在对话里一张张传；素材目录还没出过图时会打开素材页。`
- `/api/materials` 中 `defaults` 由 `defaultGroupSettings(root, group, 6, 'outfit')` 得到，与 `start_run` 默认一致。
- 错误文案经 `scrub`，不含素材根目录上级路径。

**Test cases:**
- 无 run 的根目录：`GET /` → 302 `/materials/`；`GET /materials/` → 200 HTML，CSP 头存在且无 `unsafe-inline`；`GET /api/materials` 款与图数量与 `scanSimple` 一致。
- 无 token 请求 `/api/upload` → 401；`Origin` 不符 → 403；`content-length` 52_428_801 → 413 且根目录无新文件；正常 jpg → 200，文件在 `scan` 中出现。
- 上传 heic → 400 文案 `a.heic：只支持 jpg、png、webp`；`name=../x.jpg` → 400 且根目录外无文件。
- `POST /api/sku` 重复款号 → 400 `款号已存在：A`。
- `POST /api/new-run`（假引擎）勾选 1 款 1 张 → 200，新 run 完成后无 `derivedFrom`，`成图/<款号>/` 多 1 张；出图进行中再提交 → 409 且返回正在跑的 runId。
- `openGraphTool` 对无 run 根目录 → `{ runId: null, url }` 且 url 以 `/materials/?token=` 结尾；有 run 时行为与原来一致。
- `mcp-server` 工具清单仍为 8 个，`open_graph` 说明含 `自己放图、挑图`。

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：`npx vitest run tests/editor-server.test.ts tests/mcp-tools.test.ts tests/mcp-server.test.ts` → 新用例失败
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**：同上命令全部通过；`npm run typecheck` 通过
- [x] **Step 5: Commit**

> 进展（2026-10-15）：新路由 `/materials/`、`/api/materials`、`/api/sku`、`/api/upload`、`/api/new-run` 与 `newRunTool` 完成；`/api/materials` 额外返回 `rootName`（素材页页头用，只给最后一级目录名）；graph.ts 抽出 `THEME_CSS` 供素材页共用，节点图样式字节不变。全量 320 测试通过。

---

### Task 4: 共用编辑面板与拖拽改进（run 页面）

**Files:**
- Create: `ui/editor-panel.js`
- Modify: `ui/editor.js`、`ui/editor.css`、`src/simple/graph.ts`（http 模式加载 `editor-panel.js` 早于 `editor.js`）
- Test: `tests/editor-ui.browser.test.ts`

**Interfaces:**
- Consumes: 现有 `/api/prompt`、`/api/crop`、`/source/...`
- Produces: `window.__EDITOR_PANEL__ = { create(container: HTMLElement, opts: { sku: string; settings: { swap, references, prompt, promptEdited }; garments: string[]; crops: string[]; models: { file: string; selected: boolean }[]; maxReferences: number; onChange: (state) => void }): { getState(): { swap, references, prompt, promptEdited, models: string[] /* 选中的 */, dirty: boolean, blockers: string[] }; reset(): void; refreshPool(garments, crops): void } }`

**Requirements:**
- 面板可改项、校验、提示词跟随规则与现状完全一致（节点编辑器 spec 3.1–3.3），只改操作方式与布局：
  - 参考图缩略图可拖动排序（HTML5 drag），拖到列表外或点缩略图右上角 `×` 移除；保留 `↑` `↓` 按键操作（键盘可聚焦），不只能用鼠标。
  - 「拖框」「移除」改为鼠标悬停或键盘聚焦缩略图时出现的小图标按钮，带 `title` 与 `aria-label`（`拖框裁图`、`移除`）；用途名输入框保留。
  - 可添加区（服装原图、裁图）默认展开为一行可横向滚动的缩略图，不再有「添加参考图」折叠；从可添加区拖进参考图列表即加入到落点位置，点缩略图上的 `+` 也可加入（加到末尾）。
  - 模特图区放在面板第一行；点缩略图切换选中，选中有勾和描边；「全选」保留。
- run 页面上每张图左侧勾选框、底部条、重出、取消、占用轮询、离开提醒行为不变。
- 拖拽松手不触发灯箱（沿用现有阻止冒泡做法）。
- 不新增内联脚本或样式属性（CSP）。

**Test cases:**
- 拖动第 3 张参考图到第 1 位 → 图号与默认提示词随之变化，与用 `↑` 两次得到的状态一致。
- 从可添加区拖一张原图到第 2 位 → 列表 2 号为该图；点 `+` → 加到末尾；超过上限 → 重出不可用并显示原因。
- 点 `×` 移除、拖出列表移除 → 与原「移除」结果一致；裁图文件仍在。
- 键盘：Tab 聚焦参考图后按 `↑` 按钮 → 顺序变化。
- 点模特缩略图 → 选中切换，底部条张数变化；「全选」全部选中。
- 现有用例（裁图弹窗、提示词光标不跳、离开提醒、只重出一张）全部仍通过。

- [x] **Step 1: 按上述 cases 写失败测试**（改造现有用例的选择器到新结构，新增拖拽用例）
- [x] **Step 2: 运行确认失败**：`npm run build && npx vitest run tests/editor-ui.browser.test.ts` → 新用例失败
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**：同上命令全部通过；`npx vitest run tests/simple-graph.browser.test.ts` 通过
- [x] **Step 5: Commit**

> 进展（2026-10-15）：`editor-panel.js` 承担面板与拖框裁图对话框，`editor.js` 只剩勾选、底部条、重出与占用；面板接口在计划之外加了 `setSelected(files)`（run 页左侧勾选框与面板模特图同步）与模特 `tag`（「新」标记）。节点图用 `async=false` 保证面板脚本先执行。浏览器测试 11 个通过，含拖拽排序、拖入加入、拖出移除、键盘排序、点图选模特。

---

### Task 5: 素材页（放图、新建款、出图）

**Files:**
- Create: `ui/materials.js`、`tests/materials-ui.browser.test.ts`
- Modify: `ui/editor.css`、`src/simple/graph.ts`（http 模式页头加「素材」链接 `/materials/`；file:// 下不显示）
- Test: `tests/materials-ui.browser.test.ts`、`tests/simple-graph.browser.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `GET /api/materials`、`POST /api/sku`、`POST /api/upload`、`POST /api/new-run`、`POST /api/runs/<id>/cancel`；Task 4 的 `window.__EDITOR_PANEL__`
- Produces: 素材页 DOM 约定（测试依赖）：款卡片 `.mt-card[data-sku]`、放置区 `.mt-drop[data-kind=garment|model]`（内含 `input[type=file][multiple][accept=".jpg,.jpeg,.png,.webp"]`）、款勾选 `input.mt-pick`、新建款 `#mt-new`、刷新 `#mt-refresh`、上传结果 `.mt-result`、底部条复用 `#ed-bar`（`#ed-count` `#ed-engine` `#ed-cost` `#ed-go` `#ed-msg`），出图按钮文案 `出图`

**Requirements:**
- 页头：标题「素材」、素材根目录名（只显示最后一级）、「刷新」、「新建款」；有 run 时显示「最近一次出图」链接到 `/runs/<latestRunId>/`。
- 每款一张卡片：款号、服装图 N 张、模特图 N 张、缩略图；「服装图」「模特图」两个放置区。拖文件进放置区或点放置区选文件；拖入时放置区高亮。
- 上传逐张串行调用 `/api/upload`，单张失败不影响其它张；全部结束后在该卡片 `.mt-result` 列出成功数与每个失败文件名 + 原因；随后重新拉 `/api/materials` 刷新这张卡片。
- 前端预检：扩展名不在白名单或大于 50 MB 的文件不上传，直接列为失败（文案与服务端一致）；服务端仍做同样校验。
- 「新建款」：输入款号 → `POST /api/sku` 校验通过后出现空白卡片（只在页面里，不写文件）；没放任何图的新款刷新后消失；校验失败显示服务端文案。
- 出图：每款可勾选参与（有服装图且至少 1 张模特图才可勾选，否则勾选框不可用并显示 `缺少服装图` / `缺少模特图`）；勾选后可展开编辑面板（Task 4 面板，默认全选模特，初始设置取 `defaults`）。底部条显示 `出图 N 张`、引擎选择（codex / apimart，选 apimart 显示 `会产生真实费用` 并在提交前 `confirm`）；有阻塞原因时按钮不可用并列出原因。
- 点「出图」→ `POST /api/new-run`，提交内容：勾选款的选中模特 `shots`；只为编辑过的款带 `groups[sku]`；成功后跳到返回的 `url`。
- 已有出图在跑：「出图」不可用并显示 `正在出图：<runId>` 与跳转链接；每 5 秒轮询 `/api/materials` 的 `activeRunId`。
- 有未提交的编辑或勾选时离开页面提示（beforeunload），与 run 页一致；每 60 秒 `GET /api/ping` 保活。
- 节点图 http 模式页头出现「素材」链接，file:// 下不出现。

**Test cases:**
- 无 run 根目录打开 `/` → 落到素材页，款数与图数与 `scanSimple` 一致。
- 用 Playwright `setInputFiles` 向某款服装放置区放入 jpg、png、webp、heic、gif 各一 → 卡片显示成功 3、失败 2 且列出 `a.heic`、`a.gif` 及原因；磁盘上出现 3 个文件。
- 用 `DataTransfer` 派发 drop 事件放入 1 张 jpg → 同样写入并刷新卡片。
- 同名再放 → 磁盘出现 `(2)` 文件。
- 新建款 `NEW1` → 出现空卡片；放 1 张服装图和 1 张模特图 → 刷新后仍在；新建款 `a_b` → 显示 `款号不能用` 文案。
- 勾选 1 款、点出图（假引擎）→ 跳到新 run 页面，页面无「来自」；完成后 `成图/<款号>/` 多出对应张数。
- 展开面板调换参考图顺序后出图 → 新 run.json 参考图顺序与页面一致、`referenceSource: 'custom'`。
- 出图进行中打开素材页 → 「出图」不可用并有跳转链接。
- 节点图 http 页有「素材」链接，file:// 下无。

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：`npm run build && npx vitest run tests/materials-ui.browser.test.ts` → 失败
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**：`npx vitest run tests/materials-ui.browser.test.ts tests/simple-graph.browser.test.ts tests/editor-ui.browser.test.ts` 全部通过
- [x] **Step 5: Commit**

> 进展（2026-10-15）：`materials.js` 完成；新款号改为页头内联输入框 `#mt-new-sku` + `#mt-new`；「刷新」按钮保留页面内未放图的新款（重新打开页面才消失），页头工具区只建一次，刷新不冲掉正在输入的款号；展开某款「编辑」时自动勾选该款。素材页浏览器测试 7 个通过，全量 330 通过。

---

### Task 6: 文档、打包与验收清单

**Files:**
- Modify: `README.md`、`docs/USAGE.md`、`docs/COLLEAGUE_INSTALL_AND_REAL_TEST.md`、`skills/fashion-tryon/SKILL.md`、`tests/colleague-package*.test.ts`、`tests/skill-contract*.test.ts`（如需）、`package.json`（`files` 含新 ui 文件，如需）
- Test: 全量

**Interfaces:**
- Consumes: Task 1–5 全部产物
- Produces: 无新接口

**Requirements:**
- 文档写明：用 `open_graph` 或 `fashion-tryon editor <素材根目录>` 打开页面；素材页拖图规则（格式、50 MB、同名加后缀、沿用目录结构、页面不删图）；页面出图与 `start_run` 等价。
- SKILL.md：用户想自己放图、挑图时引导用 `open_graph`。
- 同事安装包包含 `ui/editor-panel.js`、`ui/materials.js`。
- 按 spec 第 8 节逐条核对 1–12，每条指到对应测试；缺的补测试。重点：验收 11（除新放入文件、`成图/`、`裁图/` 外其它文件字节不变）在 `materials-ui` 用例前后对根目录做哈希快照比对；验收 12 的路径穿越已在 Task 2/3 覆盖。
- 全量测试、typecheck、`npm run scan:secrets` 通过。

**Test cases:**
- 打包清单测试包含两个新 ui 文件。
- 素材页全流程用例前后快照：仅新增上传文件与 `成图/`、`_runs/` 变化。
- 全量 `npm test` 通过。

- [x] **Step 1: 补文档与打包清单，按 cases 补测试**
- [x] **Step 2: 运行**：`npm run build && npm test && npm run typecheck && npm run scan:secrets` → 全部通过
- [x] **Step 3: Commit**

> 进展（2026-10-15）：文档与 SKILL 已补；`ui/` 整目录打包，清单测试加两个新文件。spec §8 对照：1 → editor-server「opens the materials page」、materials-ui「opens from /」；2 → simple-upload 三种根目录、editor-server 上传；3 → simple-upload「never overwrites」、materials-ui `(2)`；4 → simple-upload 格式/50 MB/文件头、materials-ui heic/gif；5、11 → materials-ui「shows images added in Finder…」（快照只多上传文件与 `成图/` 交付）；6 → simple-rerun「matches runSimple defaults」；7 → materials-ui「submits edited references」；8 → editor-ui 拖拽/键盘/移除用例；9 → editor-ui、materials-ui 点图选模特；10 → materials-ui「blocks starting」；12 → editor-server 鉴权/来源/路径穿越与 simple-upload 文件名用例。全量 331 通过，typecheck、scan:secrets 通过。

---

### Task 7: 真实冒烟（需用户在场或授权）

**Files:**
- Modify: 本 plan（进展备注）、`PROJECT.md`

**Requirements:**
- 新建空素材根目录 `~/Documents/AI/页面放图冒烟`；`fashion-tryon editor <该目录>` 打开页面，落在素材页。
- 页面新建 1 款，拖入真实服装图（来自 `~/Documents/AI/MCP冒烟` 的 001 款服装图）与 1 张模特图，用 Codex 出 1 张。
- 记录 runId 与交付路径，成图交用户目测；不做任何自动评价。

- [x] **Step 1: 执行冒烟并记录**
- [x] **Step 2: Commit**

> 进展（2026-10-15）：空根目录 `~/Documents/AI/页面放图冒烟` 用 `fashion-tryon editor` 打开落在 `/materials/`；页面新建款 `001-SANDRO拉链卫衣`，放入 6 张服装图与模特图 `0 (1).jpg`（写入 `<款>/服装/`、`<款>/模特/`），选 codex 出 1 张。runId `20261015-212445`，status completed，交付 `成图/001-SANDRO拉链卫衣/0 (1).png`，待用户目测。

---

## 自查记录

- Spec 覆盖：§2 → Task 3、5；§3 / §3.1 → Task 2、3、5；§4 → Task 1、3、5；§5 → Task 4；§6 → Task 3、6；§8 验收 1–12 → Task 1–6，13 → Task 7。
- 类型一致：`defaultGroupSettings` / `GroupDefaults`（T1 定义，T3 使用）；`NewRunRequest` / `buildNewRunPlan`（T1 → T3）；`placeUpload` / `validateNewSku` / `UPLOAD_MAX_BYTES`（T2 → T3）；`window.__EDITOR_PANEL__.create`（T4 → T5）。
