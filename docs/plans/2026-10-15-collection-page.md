# 合集页 Implementation Plan

**Goal:** 把素材页改成合集页：一款一组（左衣服、右模特），放图 / 节点两种模式，每款可选固定服装 / 固定模特 / 一对一三种搭配规则，并加入待重出清单、保持画幅、半身标记、出图进度、搜索折叠与组排序。
**Architecture:** 新增合集设置文件 `成图/_runs/collection.json` 与搭配展开函数；固定模特、一对一的每个出图组合在计划与运行记录里是一个独立的组（同款号、带 `item`），固定服装保持现有格式与路径不变；单张图的追加提示词（半身、待重出备注）放在 shot 上。编辑服务提供合集视图与设置、待重出接口；前端 `ui/collection.js` 取代 `ui/materials.js`，编辑抽屉复用 `editor-panel.js`。
**Tech Stack:** TypeScript/Node、node:http、zod、sharp、Vitest、Playwright、tsdown；前端无构建原生 JS。

Spec：`docs/specs/2026-10-15-collection-page.md`（已确认）。原型：`docs/prototypes/2026-10-15-collection-page.html`。

## Global Constraints

- 文件夹是唯一事实来源；页面只往素材目录放图，不删、不改名、不覆盖任何已有文件。
- 合集设置只写 `成图/_runs/collection.json`，不写进素材文件夹。
- 搭配规则取值与显示名：`fixedGarment`「固定服装」（默认）、`fixedModel`「固定模特」、`oneToOne`「一对一」。
- 保持画幅追加的句子原样：`保持图1的取景范围，被截掉、没拍到的身体部位不要补画。`
- 固定模特多选报错文案原样：`<款号>：固定模特只能选 1 个模特`。
- 成图命名：固定服装 `成图/<款号>/<模特图名>.png`；固定模特、一对一 `成图/<款号>/<衣服图名>-<模特图名>.png`；重出加 `-v2`、`-v3`，一律不覆盖。
- 从未在页面设置过的款，`start_run` 与页面出图的计划、运行记录、交付文件与现在完全相同。
- 编辑服务只监听 127.0.0.1，token/Cookie 鉴权，POST 校验 Origin，CSP 不放宽；响应、日志、文件不含密钥。
- 同一时间只允许一次出图（现有锁）；apimart 需确认费用。
- 不做任何自动质检、自动评分、自动识别半身。studio（`src/studio/`）不改。
- 代码英文，注释中文；每个任务结束跑 `npm run build && npm test && npm run typecheck && npm run scan:secrets`。

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/simple/collection.ts`（新） | 合集设置的类型、读写、默认值、固定句子 |
| `src/simple/pairing.ts`（新） | 按搭配规则把一款的选择展开成计划组 |
| `src/simple/crop.ts` | 裁图时记录裁图来源 |
| `src/simple/record.ts` | `RunGroup` / `RunShot` 新增可选字段 |
| `src/simple/rerun.ts` | 计划格式、新建出图请求新格式、重出按 `item` 定位、待重出计划 |
| `src/simple/run.ts` | 执行带 `item` 的组、追加提示词、交付命名；扫描分支读合集设置 |
| `src/editor/server.ts` | 合集视图、设置、排序、待重出接口；新建出图新格式 |
| `src/editor/collection-page.ts`（新，取代 `materials-page.ts`） | 合集页外壳 |
| `ui/collection.js`（新，取代 `ui/materials.js`） | 合集页：顶栏、底栏、放图模式、节点模式、对照、待重出 |
| `ui/collection-drawer.js`（新） | 编辑抽屉：搭配规则、范围、保持画幅、参考图、每件衣服的参考图选择、提示词 |
| `ui/editor-panel.js` | 提示词请求带 `keepFrame`；面板 `setKeepFrame` |
| `ui/editor.css` | 合集页样式（`.cl-*`），删除 `.mt-*` |
| `src/simple/graph.ts`、`ui/editor.js` | run 节点图显示带 `item` 的组；入口改名「合集」 |
| `src/mcp/tools.ts`、`src/mcp/server.ts` | `rerun` 的 shot 支持 `item`；说明文字 |
| 文档 | README、`docs/USAGE.md`、`docs/COLLEAGUE_INSTALL_AND_REAL_TEST.md`、`skills/fashion-tryon/SKILL.md` |

---

### Task 1: 合集设置存储与裁图来源

**Files:**
- Create: `src/simple/collection.ts`
- Modify: `src/simple/crop.ts`（`cropOne`、`applyCropPlan`）
- Test: `tests/simple-collection.test.ts`（新）、`tests/simple-crop.test.ts`（若无则并入新文件）

**Interfaces:**
- Produces:
  - `type PairingRule = 'fixedGarment' | 'fixedModel' | 'oneToOne'`
  - `interface GroupPrefs { pairing: PairingRule; keepFrame: boolean; halfModels: string[] }`（`halfModels` 为相对素材根目录的模特图路径）
  - `interface RedoItem { delivered: string; runId: string; sku: string; model: string; item?: string; note?: string }`
  - `interface CollectionState { version: 1; order: string[]; groups: Record<string, GroupPrefs>; cropFrom: Record<string, string>; redo: RedoItem[] }`
  - `const KEEP_FRAME_SENTENCE = '保持图1的取景范围，被截掉、没拍到的身体部位不要补画。'`
  - `const PAIRING_LABELS: Record<PairingRule, string>`（固定服装 / 固定模特 / 一对一）
  - `collectionPath(root: string): string` → `<root>/成图/_runs/collection.json`
  - `readCollection(root: string): Promise<CollectionState>`
  - `updateCollection(root: string, mutate: (state: CollectionState) => void): Promise<CollectionState>`
  - `groupPrefs(state: CollectionState, sku: string): GroupPrefs`

**Requirements:**
- 文件不存在时返回 `{ version: 1, order: [], groups: {}, cropFrom: {}, redo: [] }`，不创建文件。
- 内容不是合法 JSON 或不符合 schema 时抛 `RunnerError('VALIDATION_ERROR', '合集设置文件损坏：<相对素材根目录的路径>')`，不覆盖原文件。
- 写入先写同目录临时文件再 rename；同进程内 `updateCollection` 串行执行（后一个读到前一个的结果）。
- `groupPrefs` 对未设置的款返回 `{ pairing: 'fixedGarment', keepFrame: false, halfModels: [] }`。
- `cropOne` / `applyCropPlan` 写出裁图后记录 `cropFrom['裁图/<款号>/<文件名>'] = <来源衣服图相对路径>`；来源本身是裁图时继承它的来源；替换同用途裁图时覆盖该条记录。

**Test cases:**
- 无文件 → 默认状态，目录里没有新文件。
- `updateCollection` 设置 `groups.EX1.pairing = 'fixedModel'` → 再读得到同值；文件位于 `成图/_runs/collection.json`。
- 并发两次 `updateCollection`（各加一条 redo）→ 两条都在。
- 写入损坏 JSON → `readCollection` 抛「合集设置文件损坏：成图/_runs/collection.json」，文件内容不变。
- `cropOne(root, 'EX1', { from: 'g1.jpg', role: '全身-正面' })` → `cropFrom['裁图/EX1/01-全身-正面.jpg'] === '服装/EX1/g1.jpg'`；再从该裁图裁 → 新裁图来源仍是 `服装/EX1/g1.jpg`。

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：`npx vitest run tests/simple-collection.test.ts` → 找不到模块
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**：同上命令全部通过；再跑全量四件套
- [x] **Step 5: Commit**

进展：新增 collection.ts（合集设置读写、串行更新、损坏报错）并让 cropOne/applyCropPlan 记录裁图来源；相关 13 个测试通过，全量 344 passed / 1 skipped，build、typecheck、scan:secrets 通过。

---

### Task 2: 搭配展开与追加提示词

**Files:**
- Create: `src/simple/pairing.ts`
- Test: `tests/simple-pairing.test.ts`（新）

**Interfaces:**
- Consumes: `PairingRule`、`KEEP_FRAME_SENTENCE`（Task 1）；`buildSimplePrompt`、`referenceRole`、`SwapMode`（`prompt.ts`）
- Produces:
  - `interface PairingInput { sku: string; pairing: PairingRule; garments: string[]; models: string[]; references: { file: string; role?: string }[]; itemRefs: Record<string, string>; swap: SwapMode; keepFrame: boolean; halfModels: string[]; prompt?: string }`
    - `garments`、`models`：选中的图，按页面顺序；`references`：固定服装的参考图；`itemRefs`：固定模特 / 一对一下每件衣服实际用的参考图（缺省用衣服原图）；`prompt`：人工改过的提示词
  - `interface PairingLane { item?: string; references: { file: string; role?: string }[]; models: string[]; prompt: string; promptEdited: boolean; keepFrame: boolean; extraPrompts: Record<string, string> }`
  - `interface PairingResult { lanes: PairingLane[]; unpaired: string[] }`
  - `expandPairing(input: PairingInput): PairingResult`
  - `defaultItemRef(garment: string, crops: string[], cropFrom: Record<string, string>): string`
  - `promptFor(references: { file: string }[], swap: SwapMode, keepFrame: boolean): string`

**Requirements:**
- `fixedGarment`：一条 lane，无 `item`，`references` 原样，`models` 为全部选中模特。
- `fixedModel`：`models.length !== 1` 时抛 `RunnerError('VALIDATION_ERROR', '<款号>：固定模特只能选 1 个模特')`；每张选中衣服一条 lane：`item` = 衣服图，`references = [{ file: itemRefs[item] ?? item, role? }]`，`models = [唯一模特]`。
- `oneToOne`：第 n 张衣服配第 n 张模特，取两者较短长度；多出的衣服和模特图按原顺序放进 `unpaired`；每对一条 lane（`item` + 单个模特）。
- 每条 lane 至少 1 个模特、1 张参考图；`garments` 为空时抛 `'<款号> 缺少服装图，不能出图'`，`models` 为空时抛 `'没有勾选要出图的图'`。
- 默认提示词 `promptFor(refs, swap, keepFrame)` = `buildSimplePrompt(参考图文件名, swap)`，`keepFrame` 为真时末尾另起一行加 `KEEP_FRAME_SENTENCE`。
- 给了 `prompt`（人工改过）时用它，`promptEdited = true`；`keepFrame` 为真且其中不含该句时末尾另起一行补上。
- `halfModels` 中的模特图，在 `keepFrame` 为假的 lane 里得到 `extraPrompts[model] = KEEP_FRAME_SENTENCE`；`keepFrame` 为真时不重复加。
- `defaultItemRef`：`crops` 中按文件名排序第一张 `cropFrom[crop] === garment` 的裁图；没有则返回 `garment`。

**Test cases:**
- fixedGarment，garments [g1,g2]、models [m1,m2] → 1 条 lane、models [m1,m2]、无 item，提示词与 `buildSimplePrompt` 相同。
- fixedModel，garments [A,B,C]、models [X] → 3 条 lane，item 依次 A、B、C，每条 1 张参考图。
- fixedModel，models [X,Y] → 抛「EX1：固定模特只能选 1 个模特」；models [] → 同样报错。
- oneToOne，garments [A,B,C]、models [E,F] → 2 条 lane（A+E、B+F），unpaired [C]。
- keepFrame 为真 → 每条 lane 提示词末行是保持画幅句；人工 prompt 已含该句 → 不重复。
- halfModels [m2]、keepFrame 假 → `extraPrompts` 只有 m2；keepFrame 真 → `extraPrompts` 为空。
- itemRefs `{ A: '裁图/EX1/01-全身.jpg' }` → A 的 lane 参考图是该裁图，role 为「全身」。
- `defaultItemRef('服装/EX1/A.jpg', ['裁图/EX1/02-x.jpg','裁图/EX1/01-y.jpg'], { '裁图/EX1/02-x.jpg': '服装/EX1/A.jpg' })` → `'裁图/EX1/02-x.jpg'`；无来源记录 → 原图。

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：`npx vitest run tests/simple-pairing.test.ts`
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**；全量四件套
- [x] **Step 5: Commit**

进展：新增 pairing.ts（三种搭配规则展开、保持画幅与半身追加句、默认裁图参考）；相关 10 个测试通过，全量 354 passed / 1 skipped，build、typecheck、scan:secrets 通过。

---

### Task 3: 计划与执行支持出图组合

**Files:**
- Modify: `src/simple/record.ts`、`src/simple/rerun.ts`、`src/simple/run.ts`、`src/cli.ts`（如 rerun 命令需透传）
- Test: `tests/simple-rerun.test.ts`、`tests/simple-run.test.ts`、`tests/simple-defaults.test.ts`

**Interfaces:**
- Consumes: Task 1 全部；`expandPairing`、`defaultItemRef`、`PairingLane`（Task 2）
- Produces:
  - `RunGroup` 新增可选：`pairing?: PairingRule; item?: string; keepFrame?: boolean`；`RunShot` 新增可选：`extraPrompt?: string`
  - `PlannedGroup` 新增可选：`pairing?: PairingRule; item?: string; keepFrame?: boolean; extraPrompts?: Record<string, string>`（planSchema 同步）
  - `interface GroupSelection { models: string[]; garments?: string[]; pairing?: PairingRule; references?: RerunReference[]; itemRefs?: Record<string, string>; prompt?: string; swap?: SwapMode; keepFrame?: boolean }`
  - `NewRunRequest` 改为 `{ groups: Record<string, GroupSelection>; engine?: 'codex' | 'apimart'; maxReferences?: number; swap?: SwapMode; keepFrame?: boolean }`（`parseNewRunRequest` 同步；顶层 `swap` / `keepFrame` 覆盖所有款）
  - `RerunRequest.shots[]` 新增可选 `item?: string`
  - `interface RedoRequest { items: { runId: string; sku: string; model: string; item?: string; note?: string }[]; engine?: 'codex' | 'apimart' }`
  - `parseRedoRequest(value: unknown): RedoRequest`
  - `buildNewRunPlan(root: string, request: NewRunRequest, engineDefault: ...)`（签名沿用现有，只换请求类型）
  - `buildRedoPlan(root: string, request: RedoRequest, engineDefault: 'codex' | 'fake'): Promise<RerunPlan>`
  - `deliveryStem(model: string, item?: string): string`

**Requirements:**
- 运行记录与计划文件对没有这些字段的旧数据照常读取；固定服装组不写出新字段（JSON 与现在逐字节一致）。
- 同一计划里同款号的带 `item` 组按出现顺序编号 n（从 1 起）：参考图缩略图 `ref/<款号>/<n>/g<k>.jpg`、模特缩略图 `ref/<款号>/<n>/m<k>.jpg`、生成文件 `out/<款号>-<n>-m<k>.png`、提示词文件 `prompt-<款号>-<n>.txt`；同款第一个无 `item` 的组路径不变，第二个起的无 `item` 组（待重出跨 run 收集时出现）与带 `item` 组一起按出现顺序编号。
- 交付文件名：`deliveryStem` = 有 `item` 时 `<item 去扩展名>-<模特图去扩展名>`，否则 `<模特图去扩展名>`；版本后缀与不覆盖规则不变。
- 生成时提示词 = `shot.extraPrompt` 存在时 `<组提示词>\n<extraPrompt>`，否则组提示词；`prompt-*.txt` 只写组提示词。
- `runSimple` 扫描分支（`start_run`）：读 `readCollection`；款的 prefs 为默认值时走现有逻辑不变；否则用 `expandPairing`（全部衣服、全部模特、默认参考图、`defaultItemRef`、保存的 keepFrame 与 halfModels）展开成多组；`fixedModel` 报错的款记为跳过组，`note` 为错误文案，不影响其它款。
- `buildNewRunPlan`：按 `GroupSelection` 与该款 prefs（请求未给的字段用 prefs）调 `expandPairing`；`itemRefs` 的值必须是该衣服原图或该款裁图，否则抛 `'<款号> 的参考图不可用：<文件>'`；没有任何款 → `'没有勾选要出图的图'`；未知款号 → `'找不到款号：<款号>'`。
- `buildRerunPlan`：shot 带 `item` 时只匹配来源 run 里同款号且 `item` 相同的组；不带 `item` 时匹配无 `item` 的组；找不到 → `'来源 run 里没有这张：<款号> <模特图>'`。
- `buildRedoPlan`：每项从对应 run 的组复制参考图、提示词、范围、keepFrame、item、pairing；模特为该项模特；`extraPrompts[model]` = 来源 shot 的 `extraPrompt` 与 `note` 依次用换行连接（都没有则不写）；同一来源组的多项合并为一组；`items` 为空 → `'待重出是空的'`；run 不存在 → `'找不到出图记录：<runId>'`；组或模特不在 → `'<runId> 里没有这张：<款号> <模特图>'`；计划不带 `fromRunId`。

**Test cases:**
- 默认 prefs：`runSimple` 扫描分支产出的 run.json（去掉时间、pid）与改动前的快照相同；交付 `成图/EX1/m1.png`。
- prefs `fixedModel`、1 个模特、3 张衣服 → 3 组带 item，交付 `成图/EX1/g1-m1.png`、`g2-m1.png`、`g3-m1.png`；fake 生成器收到的参考图各 1 张。
- prefs `fixedModel`、2 个模特 → 该款跳过，note 为「EX1：固定模特只能选 1 个模特」，其它款照出。
- `oneToOne` 3 衣 2 模 → 2 组；第三张衣服不出图。
- 已存在 `成图/EX1/g1-m1.png` → 新交付为 `g1-m1-v2.png`。
- shot `extraPrompt` 为保持画幅句 → 生成器收到的 prompt 以该句结尾；`prompt-EX1.txt` 不含。
- `buildNewRunPlan` 固定服装请求与改动前同输入的计划逐字相同。
- `buildNewRunPlan` `itemRefs` 指向别款裁图 → 抛「EX1 的参考图不可用：…」。
- `buildRerunPlan` 带 item → 只取对应组；不存在 → 抛「来源 run 里没有这张：…」。
- `buildRedoPlan` 两项来自同一 run 同一组 → 1 组 2 个模特；备注出现在 `extraPrompts`；空 items → 「待重出是空的」。

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：`npx vitest run tests/simple-rerun.test.ts tests/simple-run.test.ts`
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**；全量四件套
- [x] **Step 5: Commit**

进展：计划/运行记录支持带 item 的出图组合（编号路径、组合命名交付、单张追加提示词）、NewRunRequest 改为按款选择、新增 buildRedoPlan，start_run 按合集设置展开；相关 48 个测试通过，全量 367 passed / 1 skipped，build、typecheck、scan:secrets 通过（为保持全绿，ui/materials.js 与 editor-server 测试的 new-run 请求体同步改成新格式）。
修复：待重出跨 run 收集同款号的多个无 item 组时临时路径撞车（交付错图），改为第二个起的无 item 组也编号；编号规则 2026-10-16 用户已确认。

---

### Task 4: 编辑服务合集接口

**Files:**
- Modify: `src/editor/server.ts`、`src/mcp/tools.ts`（`openGraphTool`）
- Create: `src/editor/collection-view.ts`（合集视图的数据整理：成图版本、进行中状态）
- Test: `tests/editor-server.test.ts`

**Interfaces:**
- Consumes: Task 1、3 全部；`listRunRecords`、`readActiveLock`、`placeUpload`、`launchRerun`（经 `newRunTool` 同一路径）
- Produces（HTTP，全部需鉴权；POST 校验 Origin 与 `application/json`）：
  - `GET /api/collection` → `CollectionView`：
    `{ rootName, latestRunId, activeRun: { runId, done, total } | null, maxReferences: 6, engineDefault, order: string[], redo: RedoItem[], groups: GroupView[] }`
    `GroupView = { sku, garments: string[], crops: string[], cropFrom: Record<string,string>, models: string[], prefs: GroupPrefs, defaults: { swap: 'outfit', references, prompt, referenceSource }, outputs: OutputView[], inFlight: InFlightView[] }`
    `OutputView = { file: string, item: string | null, model: string | null, version: number, runId: string | null }`
    `InFlightView = { runId, item: string | null, model, state: 'queued' | 'generating' | 'failed' }`
  - `POST /api/collection/prefs` body `{ sku, pairing?, keepFrame?, halfModels? }` → `{ prefs }`
  - `POST /api/collection/order` body `{ order: string[] }` → `{ order }`（空数组表示按款号）
  - `POST /api/redo` body `{ action: 'add' | 'remove' | 'note', delivered: string, note?: string }` → `{ redo: RedoItem[] }`
  - `POST /api/redo/run` body `{ engine?: 'codex' | 'apimart' }` → `{ runId, url }`
  - `POST /api/new-run` body 改为 `NewRunRequest`（Task 3）→ `{ runId, url }`
  - `POST /api/prompt` body 新增可选 `keepFrame: boolean`
  - `/materials/` 改为返回合集页（Task 5 的 `renderCollectionPage()`）；删除 `GET /api/materials`
  - `GET /` 不论有没有 run 都 302 到 `/materials/`；`openGraphTool` 不带 runId 时返回合集页地址（`editorMaterialsUrl`）

**Requirements:**
- `outputs`：列出 `成图/<款号>/` 下图片；文件名 `<stem>(-v<N>)?.<ext>` 解析出 `version`（无后缀为 1）；`item`、`model`、`runId` 取自所有运行记录里 `delivered` 等于该文件的 shot（新的记录优先）；Finder 手放、无记录的文件三者为 null。按 stem 分组后版本升序。
- `inFlight`：只看 `activeRun` 与最近一次 run 中状态为 queued / generating / failed 的 shot。
- `activeRun.done` = 该 run 中 done + failed + cancelled 的张数，`total` = 计划张数。
- prefs 校验：`pairing` 取三值之一；`halfModels` 每项必须是该款模特图，否则 400 `'<款号> 没有这张模特图：<文件>'`；款号不存在 400 `'找不到款号：<款号>'`。
- order 校验：只接受字符串数组，长度 ≤ 1000；保存原样（不存在的款号在视图里忽略）。
- redo `add`：`delivered` 必须在 `outputs` 里且有出图记录，否则 400 `'这张成图没有出图记录，不能加入待重出'`；重复加入不重复；`note` 最长 200 字，超过 400 `'备注不能超过 200 字'`。
- redo/run：有出图在跑时 409（沿用 RUN_IN_PROGRESS 文案）；成功拉起后清空 redo 并保存；失败时 redo 保留。
- 所有新 POST 路由加入 POST 白名单；跨源 403、错误类型 415 行为与现有路由一致；响应不含密钥。

**Test cases:**
- GET /api/collection：fixture 有 `成图/EX1/m1.png`（有记录）、`成图/EX1/m1-v2.png`（有记录）、`成图/EF2/手放.png`（无记录）→ EX1 两个版本 1、2 且 runId 正确；手放文件 item/model/runId 为 null。
- prefs 设置 fixedModel 后 GET 返回新值；halfModels 含不存在的图 → 400 文案正确。
- order 保存后 GET 的 `order` 相同。
- redo add 已记录成图 → 列表 1 条；add 手放成图 → 400；note 超 200 字 → 400；remove 后为空。
- redo/run 用 fake 引擎 → 返回 runId，redo 清空，新 run 的 shot `extraPrompt` 含备注。
- new-run 新格式固定模特 2 个模特 → 400「EX1：固定模特只能选 1 个模特」。
- 新 POST 路由无 Origin → 403；无 token → 401。
- `/api/materials` → 404；`/materials/` 返回合集页 HTML 且带 CSP。
- 已有 run 时 `GET /` → 302 `/materials/`；`openGraphTool({ sourceRoot })` 返回的 url 路径为 `/materials/`。

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：`npx vitest run tests/editor-server.test.ts`
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**；全量四件套
- [x] **Step 5: Commit**

进展：新增 collection-view.ts 与合集/设置/排序/待重出/重出接口，根地址与 open_graph 默认到 /materials/，删除 /api/materials；相关 29 个测试通过，全量 377 passed / 1 skipped，build、typecheck、scan:secrets 通过（renderCollectionPage 属 Task 5，/materials/ 暂仍返回旧外壳，ui/materials.js 改读 /api/collection 以保持全绿；openGraphTool 用例放在 editor-launch 测试）。

---

### Task 5: 合集页外壳与放图模式

**Files:**
- Create: `src/editor/collection-page.ts`、`ui/collection.js`
- Delete: `src/editor/materials-page.ts`、`ui/materials.js`
- Modify: `src/editor/server.ts`（`UI_FILES` 换成 `collection.js`、`collection-drawer.js`）、`ui/editor.css`（新增 `.cl-*`，删除 `.mt-*`）、`src/simple/graph.ts`（http 模式入口文字「素材」→「合集」）
- Test: `tests/collection-ui.browser.test.ts`（新，取代 `tests/materials-ui.browser.test.ts` 中已迁移的用例）

**Interfaces:**
- Consumes: `GET /api/collection`、`POST /api/upload`、`POST /api/sku`、`POST /api/collection/prefs`、`POST /api/collection/order`（Task 4）；`window.__EDITOR_PANEL__ = { api, esc, base, sourceUrl, thumbUrl }`
- Produces:
  - `renderCollectionPage(): string`
  - 页面结构：`#cl-top`（`.cl-seg button[data-mode=place|node]`、`#cl-search`、`#cl-progress`、`#cl-refresh`、`#cl-new-sku` + `#cl-new`、`#cl-sort-sku`）、`#cl-list`、`#ed-bar`（`#ed-count`、`#cl-swap-all`、`#cl-keep-all`、`#ed-engine`、`#cl-redo-open`（含 `.cl-redo-n`）、`#ed-go`）
  - 每款 `section.cl-group[data-sku]`：头部 `input.cl-pick`、`.cl-no`、`.cl-sku`、`.cl-cnt`、`select.cl-pairing`、`select.cl-swap`、`input.cl-keep`、`button.cl-edit`、`button.cl-only`、`button.cl-up` / `button.cl-down`、`button.cl-fold`
  - 放图模式：`.cl-col[data-kind=garment|model]`，缩略图 `.cl-tile[data-file]`（模特与可选衣服带 `aria-pressed`），半身切换 `button.cl-half[data-file]`，放置区 `.cl-drop[data-kind]`（内含文件输入），进度 `.cl-prog`，成图行 `.cl-outs button.cl-out[data-file]`
  - `window.__COLLECTION__ = { view(), state(), render(), openCompare(file), refresh() }` 供 Task 6、7 的脚本使用

**Requirements:**
- 模式按钮切换 `place` / `node`，写入 `localStorage['ft.collection.mode']`（读写包 try/catch），默认 `place`。
- 搜索按款号包含匹配，不区分大小写；折叠状态存 `localStorage['ft.collection.folded']`（款号数组）。
- 组顺序：`order` 非空时按 order，未出现在 order 里的款按款号排在最后；上移 / 下移与拖动组头调整后 POST order；`#cl-sort-sku` POST 空数组。
- 头部规则、范围（「换整套」/「只换上衣」）、保持画幅改动立即 POST prefs；半身切换 POST halfModels。
- 放图：拖放或选文件，串行上传；`.cl-prog` 显示 `正在放入 x / y` 与进度条；上传中只有 `#ed-go` 与「重出这 N 张」不可用，其它照常操作；结果显示成功张数与失败原因（沿用上一版文案）。
- 选中：模特图默认全选，点缩略图切换；`fixedModel` / `oneToOne` 下衣服图也可点选（默认全选）；`fixedGarment` 下衣服图不可点选。
- `.cl-cnt` 显示 `衣服 N · 模特 x/y · 将出 K 张`；`oneToOne` 有未配对时追加 `· 未配对 M`；`fixedModel` 选中模特 ≠ 1 时显示 `固定模特只能选 1 个模特`（红色）且该款勾选框禁用。
- 成图行：每个出图组合（item + model）显示最新版本缩略图与 `v<N>`；有 inFlight 的显示「生成中」/「排队」/「失败」。
- 新款（页面新建未放图）显示两个大放置区与「新款，放图后写入文件夹」；规则沿用上一版（刷新按钮保留，重新打开消失）。
- 顶栏 `#cl-progress`：有 activeRun 时 `正在出图 done / total`，链接到 `/runs/<runId>/`，每 5 秒轮询，结束后自动刷新合集。
- 底栏「出图」：按勾选款与选择组装 `NewRunRequest` POST `/api/new-run`，成功跳到返回的 url；`#cl-swap-all` 选「按各款设置」以外的值时作为请求顶层 `swap`；`#cl-keep-all` 勾选时顶层 `keepFrame: true`；apimart 需 confirm。
- 只出这款：只提交该款。
- 手机宽度（390px）无横向滚动，左右两栏变单栏。

**Test cases:**
- 打开 `/` 无 run → 302 到 `/materials/`，`.cl-group` 数量与扫描一致；切到节点模式后 reload 仍是节点模式。
- 搜索「ef」→ 只剩 EF2；折叠 EX1 后 reload 仍折叠。
- 下移 EX1 → collection.json 的 order 改变，reload 顺序保持；「按款号排序」恢复。
- 拖放 2 张模特图到 EX1 → 显示进度，放完卡片更新；上传中能勾选其它款。
- 规则切到固定模特、选中 2 个模特 → 显示报错文案且勾选框禁用；只选 1 个 → `将出 3 张`。
- 一对一 3 衣 2 模 → `将出 2 张 · 未配对 1`。
- 勾选 EX1（固定服装，2 模特）出图 → 跳到 run 页，交付 2 张，计划与改动前一致。
- 页面不改素材目录里已有文件：操作前后哈希快照只多上传文件、`成图/`、`裁图/`（沿用上一版快照用例）。
- 390px 宽 `documentElement.scrollWidth <= innerWidth`。

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：`npx vitest run tests/collection-ui.browser.test.ts`
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**；全量四件套
- [x] **Step 5: Commit**

进展：新增合集页外壳与 collection.js 放图模式（顶栏/底栏、模式与折叠记忆、搜索、组排序、规则/画幅/半身保存、上传进度、按规则计数与出图、成图行），删除旧素材页与其浏览器测试；collection-ui 12 个测试通过，全量 380 passed / 1 skipped，build、typecheck、scan:secrets 通过（换装范围 prefs 接口不支持，只存页面内存；节点模式内容、抽屉、对照弹层留给 Task 6/7）。

---

### Task 6: 编辑抽屉与节点模式

**Files:**
- Create: `ui/collection-drawer.js`
- Modify: `ui/collection.js`（节点模式渲染）、`ui/editor-panel.js`、`src/editor/server.ts`（`/api/prompt` 的 keepFrame，若 Task 4 未覆盖）、`ui/editor.css`
- Test: `tests/collection-ui.browser.test.ts`、`tests/editor-ui.browser.test.ts`

**Interfaces:**
- Consumes: `window.__COLLECTION__`（Task 5）、`window.__EDITOR_PANEL__.create`、`POST /api/prompt { references, swap, keepFrame? }`
- Produces:
  - `window.__COLLECTION_DRAWER__ = { open(sku), close(), selection(sku): GroupSelection | null }`（`selection` 返回该款当前编辑结果，未编辑返回 null；Task 5 的出图组装请求时调用）
  - 抽屉 `#cl-drawer`（`[aria-hidden]`），内含 `input[name=cl-pairing]`、`input[name=cl-swap]`、`input.cl-keep-d`、面板容器 `.ed-panel`（固定服装）、每件衣服参考图选择 `select.cl-itemref[data-item]`（固定模特 / 一对一）、`button.cl-restore`、`button.cl-close`
  - 面板新增方法 `setKeepFrame(on: boolean)`；面板 opts 新增 `keepFrame: boolean`
  - 节点模式结构：`section.cl-lane[data-sku]` 内 `.cl-node-garments`、`.cl-node-set`、每个出图组合一行 `.cl-row[data-item][data-model]`（模特节点 `.cl-node-model`、成图节点 `.cl-node-outs` 内版本按钮 `button.cl-ver[data-file]`、`button.cl-add-redo`）

**Requirements:**
- 抽屉在两种模式都能打开（头部「编辑」、节点模式点衣服节点或设置节点）；Esc、关闭按钮关闭；打开时焦点移到抽屉标题。
- 固定服装：面板沿用拖动排序、拖出移除、可添加区、拖框裁图、提示词跟随规则。
- 固定模特 / 一对一：每件衣服一行，`select.cl-itemref` 选项为「原图」与该衣服来源的裁图（`cropFrom` 指向它的）及其余本款裁图，默认 `defaultItemRef` 的结果；不显示参考图排序。
- 保持画幅勾选：默认提示词末尾加保持画幅句（经 `/api/prompt` 的 keepFrame）；改过的提示词不改写，只提示「图号可能对不上」时沿用现有提示样式。
- 抽屉里改搭配规则、范围、保持画幅同步 POST prefs 并更新头部；参考图、提示词、itemRefs 只存在页面内存，`dirty` 计入离开提示。
- 恢复默认：参考图、提示词、itemRefs 回到默认，规则与范围不变。
- 节点模式每款：衣服节点（前 5 张缩略图 + 总数，可拖图放入）→ 设置节点（范围、规则、参考图张数、含裁图时注明、提示词 默认/已改、画幅 保持/默认）→ 每个出图组合一行；行由「当前规则下会出的组合」与「已有成图的组合」合并而成；不在当前选择里的行加 `.is-off` 变淡；点模特节点切换选中。
- 成图节点：版本按 v 升序横排，最新一张大图；inFlight 显示「生成中」/「排队」/「失败」；`button.cl-add-redo` 把该组合最新版本加入待重出（Task 7 接口）。

**Test cases:**
- 节点模式点设置节点 → 抽屉打开、焦点在标题；Esc 关闭。
- 固定服装抽屉里拖出一张参考图 → 出图请求 references 少一张（复用面板）。
- 固定模特抽屉：A 有来源裁图 → 默认选中该裁图；改为原图后出图，计划里 A 的参考图是原图。
- 勾选保持画幅 → 提示词末行为保持画幅句；collection.json 中 keepFrame 为 true。
- 恢复默认 → 提示词与参考图回到默认，规则不变。
- 节点模式 EX1 有 m1 的 v1、v2 成图 → `.cl-row[data-model="模特/EX1/m1.jpg"] .cl-ver` 两个，最后一个最大；未选中的模特行有 `.is-off`。
- 有未出图编辑时 reload 弹 beforeunload；只勾选不弹。

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：`npx vitest run tests/collection-ui.browser.test.ts tests/editor-ui.browser.test.ts`
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**；全量四件套
- [x] **Step 5: Commit**

进展：新增 collection-drawer.js 编辑抽屉（规则/范围/保持画幅、固定服装复用面板、固定模特/一对一每件衣服选参考图、恢复默认）与节点模式（衣服→设置→每组合一行、版本、＋待重出），面板加 keepFrame / setKeepFrame；collection-ui 19 个、editor-ui 13 个测试通过，全量 388 passed / 1 skipped，build、typecheck、scan:secrets 通过（范围仍只存页面内存；固定模特/一对一抽屉不提供提示词编辑；恢复默认按 plan 不改范围）。2026-10-16 用户确认：以上三点保留现状，spec §5、§11.11 已同步；另补 run 节点图重出与待重出按当前半身标记追加保持画幅句。

---

### Task 7: 成图对照与待重出

**Files:**
- Modify: `ui/collection.js`、`ui/editor.css`
- Test: `tests/collection-ui.browser.test.ts`

**Interfaces:**
- Consumes: `POST /api/redo`、`POST /api/redo/run`（Task 4）；`OutputView`、`RedoItem`
- Produces:
  - 对照弹层 `#cl-cmp`（`role=dialog`）：`#cl-cmp-title`、版本切换 `.cl-vtabs button[data-file]`、`#cl-cmp-add`、`a#cl-cmp-run`、`button#cl-cmp-close`、图 `#cl-cmp-body img`
  - 待重出弹层 `#cl-redo`：`li.cl-redo-item[data-delivered]`（`input.cl-redo-note`、`button.cl-redo-del`）、`#cl-redo-go`（文案 `重出这 N 张`）

**Requirements:**
- 点任一成图（放图模式成图行或节点模式版本）打开对照：左原模特图；固定模特 / 一对一时中间加该衣服实际用的参考图；右成图；全部用原图（`/source/`）。
- 版本切换在同一组合的版本间切换；无记录（runId null）的成图隐藏 `#cl-cmp-add` 与 `#cl-cmp-run`。
- `#cl-cmp-run` 链接 `/runs/<runId>/`。
- 加入待重出 → POST add，底栏数量更新，节点模式该版本显示「待重出」标记。
- 待重出弹层：每项缩略图、款号、模特（及衣服）、版本；备注输入失焦时 POST note；× 移除。
- `#cl-redo-go`：有出图在跑或上传中时不可用；点后 POST /api/redo/run，成功跳到返回 url；失败显示错误文案，清单不变。
- Esc、关闭按钮、点遮罩关闭弹层。

**Test cases:**
- 点 EX1 成图 → 两张图（原模特、成图），版本按钮 2 个，切到 v1 成图 src 变化。
- 固定模特成图对照 → 三张图，中间为该衣服参考图。
- 手放成图对照 → 没有加入按钮与出图记录链接。
- 加入待重出 → 底栏 1；reload 后仍为 1；写备注后 reload 备注仍在。
- 重出这 1 张（fake 引擎）→ 跳到新 run 页，新 run 的 shot extraPrompt 含备注，底栏数量回到 0。
- 有出图在跑时 `#cl-redo-go` 禁用。

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：`npx vitest run tests/collection-ui.browser.test.ts`
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**；全量四件套
- [x] **Step 5: Commit**

进展：collection.js 新增成图对照弹层（原模特图 / 衣服参考图 / 成图、版本切换、加入待重出、出图记录链接）与待重出弹层（备注失焦保存、移除、重出这 N 张），节点模式版本标「待重出」；collection-ui 23 个测试通过，全量 392 passed / 1 skipped，build、typecheck、scan:secrets 通过（对照中间的衣服参考图按抽屉当前选择或默认裁图推断，接口未返回该成图实际用的参考图）。
修复：OutputView 加 `ref`（取自运行记录该组参考图），对照中间优先用它，手放或无记录才推断；待重出移除改为服务端确认后重画，失败时该项留在列表；collection-ui 25 个测试通过，全量 394 passed / 1 skipped，build、typecheck、scan:secrets 通过。

---

### Task 8: run 节点图兼容、MCP 与文档

**Files:**
- Modify: `src/simple/graph.ts`、`ui/editor.js`、`src/simple/report.ts`（如按 sku 拼路径）、`src/mcp/tools.ts`、`src/mcp/server.ts`、`README.md`、`docs/USAGE.md`、`docs/COLLEAGUE_INSTALL_AND_REAL_TEST.md`、`skills/fashion-tryon/SKILL.md`
- Test: `tests/simple-graph.test.ts`（或现有节点图测试文件）、`tests/editor-ui.browser.test.ts`、`tests/mcp-tools.test.ts`、`tests/skill-contract.test.ts`、`tests/colleague-package.test.ts`

**Interfaces:**
- Consumes: `RunGroup.item`、`RunShot.extraPrompt`（Task 3）
- Produces:
  - 节点图带 item 的组：`section.lane[data-sku][data-item]`，标题 `<款号> · <衣服图名>`；shot 元素加 `data-item`
  - `editor.js` 的 shot 键为 `sku + item + model`
  - MCP `rerun` 输入 `shots[].item?: string`

**Requirements:**
- run 节点图对带 item 的组只读显示（参考图、提示词、模特、成图），不挂编辑面板，勾选框不出现；无 item 的组编辑与重出不变。这些组的修改与重出在合集页完成，页面在该组标题旁显示「在合集里重出」链接到 `/materials/`。
- shot 有 `extraPrompt` 时在成图节点下以小字显示「追加：<前 20 字>…」。
- 报告页（report.html）同样按 item 区分组，不因同款号多组而覆盖。
- run 页面入口文字「素材」改为「合集」。
- MCP `rerun` 的 shot 可带 `item`，行为同 Task 3；`start_run`、`open_graph` 说明补一句「按合集页保存的搭配规则出图；用户想放图、挑图、看成图时用 open_graph 打开合集页」。
- 文档：README 与 USAGE 把「素材页」改为「合集页」，写明两种模式、三种搭配规则（含例子与成图命名）、保持画幅与半身、待重出；SKILL.md 补规则说明；同事包清单换成 `ui/collection.js`、`ui/collection-drawer.js`。

**Test cases:**
- 渲染含 fixedModel 3 组的 run → 3 个 `.lane[data-item]`，标题含衣服图名，没有 `.ed-pick`。
- 固定服装 run 的节点图 HTML 与改动前相同（快照）。
- run 页面重出固定服装 shot 仍可用（沿用现有用例）。
- MCP rerun 带 item → 新 run 只含该组合。
- skill-contract：SKILL.md 含「固定模特」「一对一」与 open_graph 合集页说明。
- colleague-package：清单含两个新 ui 文件、不含 `ui/materials.js`。

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：相关测试文件
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**；全量四件套
- [x] **Step 5: Commit**

进展：run 节点图与报告页按 item 区分组合（只读、带「在合集里重出」与追加提示词），MCP rerun 支持 item，文档改为合集页；全量 400 个用例 399 通过 1 跳过（相关 6 个测试文件 55 个用例全过），build/typecheck/scan:secrets 通过。

---

### Task 9: 真实冒烟（需用户在场或授权）

**Files:**
- Modify: 本 plan（进展备注）、`PROJECT.md`

**Requirements:**
- 在 `~/Documents/AI/页面放图冒烟` 用 `fashion-tryon editor` 打开合集页，两种模式都能看到已有两款与成图版本。
- 固定服装：004-Maje开衫 换模特图 `0 (1).jpg` 出 1 张（Codex）。
- 固定模特：新建一款，放 3 张单品衣服图（取自 `~/Documents/AI/MCP冒烟` 的服装图）与 1 张模特图，只勾选 1 张衣服出 1 张（Codex），确认成图名为 `<衣服图名>-<模特图名>.png`。
- 记录 runId 与交付路径，成图交用户目测；不做任何自动评价。

- [x] **Step 1: 执行冒烟并记录**
- [x] **Step 2: Commit**

进展（2026-10-16）：`~/Documents/AI/页面放图冒烟` 打开合集页，放图/节点两模式都显示已有两款与 v1 成图；页面给 004-Maje开衫 放入模特图 `0 (1).jpg`（固定服装、换整套），新建 `005-单品固定模特` 放 3 张单品衣服图与模特图 `0 (2).jpg`（固定模特、只换上衣，只勾 SANDRO卫衣平铺），一次出图 runId `20261016-052339`（codex，completed），交付 `成图/004-Maje开衫/0 (1).png`、`成图/005-单品固定模特/SANDRO卫衣平铺-0 (2).png`，待用户目测。

---

## 自查记录

- Spec 覆盖：§2 → Task 4、5、8；§3 → Task 5；§3.1 → Task 1、2、3、5、6；§3.2 → Task 3；§4 → Task 5；§5 → Task 6；§6 → Task 2、6；§7 → Task 4、7；§8 → Task 3、5；§9 → Task 3、8；§10 由 Global Constraints 约束；§11 验收 1、2、10 → Task 5，3–6 → Task 3、5，7 → Task 2、6，8 → Task 6，9 → Task 4、7，11 → Task 6，12 → Task 5、7，13 → Task 4、5，14 → Task 9。
- 类型一致：`PairingRule` / `GroupPrefs` / `RedoItem` / `CollectionState` / `KEEP_FRAME_SENTENCE`（T1）→ T2–T7；`expandPairing` / `PairingLane` / `defaultItemRef` / `promptFor`（T2）→ T3、T6；`GroupSelection` / `NewRunRequest` / `RedoRequest` / `buildRedoPlan` / `deliveryStem`（T3）→ T4；`CollectionView` / `OutputView` / `InFlightView`（T4）→ T5–T7；`window.__COLLECTION__`（T5）→ T6、T7；`window.__COLLECTION_DRAWER__`（T6）→ T5 出图组装。
- 无占位符；未预写实现代码。
