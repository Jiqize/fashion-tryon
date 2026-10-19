# 前端交互升级 Implementation Plan

**Goal:** 把合集页与 run 节点图的下拉、复选框、`alert`/`confirm` 换成 macOS 新式交互（分段控件、开关、弹出菜单、工作表、toast、快速预览、拖动排序），业务规则与接口不变。
**Architecture:** 新增无构建的共享控件脚本 `ui/controls.js`（挂到 `window.__UI__`，提供 HTML 片段生成与事件委托），样式并入 `ui/editor.css` 的 `.ui-*`；两个页面先加载它，再逐块把现有渲染改为调用它。服务端只把新脚本加进白名单与页面外壳，接口不改。
**Tech Stack:** 原生 JS（无构建）、CSS、TypeScript/Node（只动页面外壳与白名单）、Vitest、Playwright。

Spec：`docs/specs/2026-10-16-frontend-interaction.md`（已确认）。原型：`docs/prototypes/2026-10-16-frontend-interaction.html`（交互与动效以原型为准）。

## Global Constraints

- 合集页 spec（`docs/specs/2026-10-15-collection-page.md`）的业务规则、接口、文件命名、运行记录格式一律不变；同样的操作发出的请求体与改造前相同。
- 配色、字体、整体版式不变；颜色只用 `THEME_CSS` 已有变量（`--bg --card --fg --mut --line --wire --ok --err`），新增只允许 `--warn`（浅色 `#a26a12`、深色 `#e0b35c`）与 `--ui-ease: cubic-bezier(.2,.82,.22,1)`。
- 时长：悬停 / 按下 / 开关 0.2–0.3s；抽屉、弹出菜单、工作表 0.3–0.4s；toast 滑入 0.3s。`prefers-reduced-motion: reduce` 时所有 transition / animation 关闭。不做装饰性动画。
- 页面上不得再出现原生 `<select>`、`alert(`、`confirm(`；复选框只保留「选这款出图」（`.cl-pick`）。离开页面的「有未出图编辑」仍用 `beforeunload`。
- 控件显示文字与现在一致：「固定服装」「固定模特」「一对一」「换整套」「只换上衣」「保持画幅」「全部保持画幅」「按各款设置」「全部换整套」「全部只换上衣」「codex」「apimart」「放图」「节点」。
- apimart 确认文案沿用现有：出图「apimart 会产生真实费用，确定用它出图吗？」，run 页重出「apimart 会产生真实费用，确定用它重出吗？」。
- 无前端框架、组件库、构建步骤；CSP 不放宽（脚本只从 `/ui/` 加载，不加内联脚本、不加 `unsafe-inline`）。Studio（`ui/app.js`、`src/studio/`）不改。
- 不做自动质检、自动评分、自动识别半身。
- 代码英文，注释中文；每个任务结束跑 `npm run build && npm test && npm run typecheck && npm run scan:secrets`。

## 文件结构

| 文件 | 职责 |
|---|---|
| `ui/controls.js`（新） | 共享控件：分段控件、开关、弹出菜单、工作表确认、toast、快速预览、Esc 层级栈；全部挂在 `window.__UI__` |
| `ui/editor.css` | 新增 `.ui-*` 控件样式、`--warn`、`--ui-ease`、减少动态效果规则；合集页 `.cl-*` 与 run 页 `.ed-*` 样式随改造调整 |
| `src/editor/server.ts` | `UI_FILES` 加 `controls.js` |
| `src/editor/collection-page.ts` | 外壳先加载 `/ui/controls.js` |
| `src/simple/graph.ts` | 编辑模式动态加载列表最前加 `controls.js` |
| `ui/collection.js` | 顶栏、组头、底栏、放图 / 节点模式、对照、待重出、出图进度改用控件 |
| `ui/collection-drawer.js` | 抽屉改用控件；每件衣服参考图改弹出菜单 |
| `ui/editor-panel.js` | 换装范围改分段控件；替换裁图确认改工作表 |
| `ui/editor.js` | run 页引擎、确认、报错、成图选中、进度改用控件 |
| `tests/ui-controls.browser.test.ts`（新） | 控件单测（Playwright `page.setContent` + `addScriptTag({ path: 'ui/controls.js' })`） |
| `tests/ui-static.test.ts`（新） | 静态检查：四个页面脚本不含 `<select`、`alert(`、`confirm(` |
| `tests/collection-ui.browser.test.ts`、`tests/editor-ui.browser.test.ts`、`tests/simple-graph.browser.test.ts` | 现有用例的选择器随控件更新，行为断言保持 |
| `README.md`、`docs/USAGE.md`、`skills/fashion-tryon/SKILL.md`、`tests/colleague-package.test.ts` | 文档与同事包清单 |

---

### Task 1: 共享控件 `ui/controls.js`

**Files:**
- Create: `ui/controls.js`
- Modify: `ui/editor.css`、`src/editor/server.ts`（`UI_FILES`）、`src/editor/collection-page.ts`、`src/simple/graph.ts`（动态脚本列表）
- Test: `tests/ui-controls.browser.test.ts`、`tests/editor-server.test.ts`（`/ui/controls.js` 可取）、`tests/simple-graph.browser.test.ts`（编辑模式加载顺序）

**Interfaces:**
- Produces（`window.__UI__`）：
  - `segHtml(attrs: string, options: { value: string; label: string; icon?: string }[], value: string, label: string): string` → `<span class="ui-seg" role="radiogroup" aria-label="<label>" <attrs>>`，每项 `<button type="button" role="radio" data-value aria-checked tabindex>`；`icon` 为内联 SVG 字符串。
  - `switchHtml(attrs: string, checked: boolean, label: string): string` → `<button type="button" class="ui-switch" role="switch" aria-checked <attrs>><i></i>label</button>`。
  - 事件：点分段项 / 在分段控件上按 ← →，或点开关 / 在开关上按空格、回车 → 更新 `aria-checked`，并在控件根元素上派发冒泡的 `CustomEvent('ui-change', { detail: { value } })`（分段：`value` 为字符串；开关：`value` 为切换后的布尔值）。值未变（点已选中项）不派发。
  - `RULE_ICONS: { fixedGarment: string; fixedModel: string; oneToOne: string }` 规则图标 SVG。
  - `menu(anchor: HTMLElement, items: { value: string; label: string; image?: string; checked?: boolean; separatorBefore?: boolean }[], onPick: (value: string) => void): void` → `.ui-menu[role=menu]`，项为 `button[role=menuitem][data-value]`；↑ ↓ 移动焦点，回车选中，Esc / 点外面 / 选中后关闭，关闭后焦点回到 anchor。
  - `confirm(opts: { title: string; text: string; ok: string; danger?: boolean }): Promise<boolean>` → `.ui-sheet[role=alertdialog]` + `.ui-scrim`；回车 = true，Esc / 点取消 / 点遮罩 = false。
  - `toast(message: string, opts?: { error?: boolean; action?: { label: string; run: () => void }; ms?: number; link?: { label: string; href: string } }): void` → `#ui-toasts > .ui-toast`；普通 3000ms 自动消失，带 action 默认 5000ms，`error` 不自动消失；每条有关闭按钮 `.ui-toast-close`。
  - `quickLook(items: { src: string; name: string }[], index: number): void` → `.ui-ql`；← → 循环切换，空格 / Esc 关闭。
  - `pushLayer(close: () => void): () => void` → Esc 关闭栈：Esc 只关最上层，返回的函数用于出栈；`menu`、`confirm`、`quickLook` 自己入栈。

**Requirements:**
- `controls.js` 为 IIFE，不依赖其它脚本，可在合集页与 run 页任意一个先加载；重复加载不重复绑定事件。
- 样式与动效照原型（`.seg` / `.sw` / `.pop` / `.sheet` / `.toast` / `.ql` 对应 `.ui-seg` / `.ui-switch` / `.ui-menu` / `.ui-sheet` / `.ui-toast` / `.ui-ql`）；`.ui-seg` 选中项白底浅阴影，`.ui-switch` 开为 `--ok`。
- 所有可交互元素键盘可达，焦点用 `:focus-visible` 高亮。
- 外壳与 run 页编辑模式在其它 `/ui/` 脚本之前加载 `/ui/controls.js`。

**Test cases:**
- `segHtml` 渲染 3 项、选中项 `aria-checked=true`；点第 2 项 → 根元素收到 `ui-change`，`detail.value` 为第 2 项值；再点同一项不派发。
- 分段控件聚焦后按 → / ← → 选中项循环移动并派发 `ui-change`。
- 开关点击与空格各切换一次，`detail.value` 依次为 `true`、`false`。
- `menu` 打开后 ↓ 两次回车 → `onPick` 收到第 2 项值，菜单关闭，焦点回 anchor；Esc 关闭不回调。
- `confirm` 回车 → resolve `true`；Esc → `false`；点遮罩 → `false`。
- `toast` 普通 3 秒后消失；`error` 5 秒后仍在；`action` 点击执行 `run` 并关闭。
- `quickLook` 3 张，→ 三次回到第 1 张；空格关闭。
- 打开菜单再打开 quickLook，Esc 先关 quickLook，再 Esc 关菜单。
- `emulateMedia({ reducedMotion: 'reduce' })` 下 `.ui-switch i` 的 `transition-duration` 计算值为 `0s`。
- `GET /ui/controls.js` 带 token 返回 200 与 JS 类型；未带 token 403（沿用现有鉴权）。
- run 页编辑模式下 `controls.js` 在 `editor-panel.js` 之前执行（`window.__UI__` 在 `editor-panel.js` 执行时已存在）。

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：`npx vitest run tests/ui-controls.browser.test.ts` → 找不到 `ui/controls.js`
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**：同上全部通过；再跑全量四件套
- [x] **Step 5: Commit**

进展：新增 `ui/controls.js`（`window.__UI__` 八个接口）与 `.ui-*` 样式，两页外壳先加载它；控件单测 10 条通过，全量四件套通过（421 passed / 1 skipped）；未带 token 取 `/ui/controls.js` 按现有鉴权为 401（plan 写 403）。

---

### Task 2: 合集页顶栏、组头、底栏控件

**Files:**
- Modify: `ui/collection.js`（`buildTop`、`headHtml`、`buildBar`、`renderBar`、`bindEvents`、`submit`、`savePrefs`）、`ui/editor.css`
- Test: `tests/collection-ui.browser.test.ts`

**Interfaces:**
- Consumes: `window.__UI__.segHtml / switchHtml / RULE_ICONS / confirm / toast`（Task 1）
- Produces:
  - 组头：`.cl-group .ui-seg[data-cl="pairing"]`、`.ui-seg[data-cl="swap"]`、`.ui-switch[data-cl="keep"]`；编辑按钮 `.cl-edit`，改过时文字「编辑 · 已改」，提示词可能对不上时加类 `is-stale` 且文字「编辑 · 提示词可能对不上」。
  - 顶栏：模式 `.ui-seg[data-cl="mode"]`；缩略图大小 `input[type=range]#cl-size`（min 64、max 132、默认 84），写入 CSS 变量 `--cl-tile`，存 localStorage 键 `ft.collection.tile`。
  - 底栏：`.ui-seg#cl-swap-all`（值 `each` / `outfit` / `top`）、`.ui-switch#cl-keep-all`、`.ui-seg#ed-engine`（值 `codex` / `apimart`）。
  - `window.__COLLECTION__.prefsQueue(sku: string): Promise<void>` 返回该款当前保存队列完成的 Promise（测试用）。

**Requirements:**
- 规则、范围、画幅、模式、统一范围、全部保持画幅、引擎的取值与改造前下拉 / 复选框完全对应，保存与出图请求体不变。
- 组设置保存按款串行：同一款前一次保存完成后才发下一次；界面以最后一次操作为准，晚到的响应不覆盖；保存失败时该款界面恢复到这次操作前，并 `toast(<错误信息>, { error: true })`。
- 半身标记切换基于该款当前（含未保存完成的）状态计算，连点两次 = 加上再去掉。
- 所有原 `#ed-msg` / `.ed-err` 红字改为 `toast`；「没有勾选要出图的图」等多条错误各出一条 error toast。
- 出图与只出这款：apimart 时 `await UI.confirm({ title: '用 apimart 出图？', text: 'apimart 会产生真实费用，确定用它出图吗？', ok: '确定出图' })`，false 时不发请求。
- 键盘：⌘F / Ctrl+F 聚焦并全选搜索框；搜索框内 Esc 清空并失焦；⌘↩ / Ctrl+↩ 等同点「出图」（含 apimart 确认）。
- 缩略图大小滑块拖动即时生效，刷新后保持；读写 localStorage 包 try/catch。

**Test cases:**
- 组头规则分段点「固定模特」→ `POST /api/collection/prefs` 体为 `{ sku, pairing: 'fixedModel' }`，刷新后仍选中。
- 画幅开关打开 → prefs 体 `{ sku, keepFrame: true }`；出图提示词末尾含 `KEEP_FRAME_SENTENCE`。
- 底栏统一范围点「全部只换上衣」并出图 → `/api/new-run` 体顶层 `swap: 'top'`，与改造前同用例一致。
- 引擎切 apimart 点出图 → 出现 `.ui-sheet`；Esc → 无 new-run 请求；回车 → 有请求。
- 同一款快速点规则 固定模特 → 一对一 → 固定服装（服务端每次延迟 300ms）→ 刷新后为固定服装，期间界面不回跳。
- 连点同一模特「半身」两次 → `halfModels` 最终不含该图。
- prefs 接口返回 400 → 界面回到操作前的规则，并出现 `.ui-toast.is-error`。
- ⌘F 聚焦搜索；输入后 Esc 清空；⌘↩ 触发出图请求。
- 滑块设到 120 → `--cl-tile` 为 `120px`，刷新后仍为 120。
- 页面中 `select` 数量为 0。

- [x] **Step 1: 按上述 cases 写失败测试（同时把现有用例里的 select / checkbox 操作改为新选择器）**
- [x] **Step 2: 运行确认失败**：`npx vitest run tests/collection-ui.browser.test.ts`
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**；全量四件套
- [x] **Step 5: Commit**

进展：组头 / 顶栏 / 底栏改用分段控件与开关，组设置按款串行保存、失败回滚并出 error toast，⌘F / ⌘↩ / 缩略图滑块就位；合集页用例 34 条通过，全量四件套通过（429 passed / 1 skipped）；引擎在服务默认非 codex 时保留空值项。验证修复：error toast 类改为 plan 写定的 `is-error`；组头「编辑 · 提示词可能对不上」（`is-stale`）已接上面板 stale 状态并加用例；组设置保存改为「服务端确认值 + 按序重放未完成操作」，连续失败后界面与服务端一致、期间不回跳，并加连续两次失败用例；底栏「勾选要出图的款」灰字提示恢复。跟踪项：抽屉与组头同步暂用过渡桥接，抽屉 `savePrefs` 仍直接 POST、未进按款串行队列，Task 5 收口。

---

### Task 3: 组排序、折叠摘要与「…」菜单

**Files:**
- Modify: `ui/collection.js`（`headHtml`、`moveTo`、`saveOrder`、`bindEvents`）、`ui/editor.css`
- Test: `tests/collection-ui.browser.test.ts`

**Interfaces:**
- Consumes: `UI.menu / toast`（Task 1）
- Produces: 组头序号 `.cl-no[draggable=true]` 为拖动把手；拖动中的组加类 `is-dragging`，落点组加 `drop-before` / `drop-after`；「…」按钮 `.cl-more[aria-haspopup=menu]`，菜单项值 `first` / `last` / `fold`。

**Requirements:**
- 拖动序号到另一组上半部 → 插到该组前，下半部 → 插到后；松手后按新顺序调用现有 `saveOrder`（`POST /api/collection/order`），成功后 `toast('已调整顺序')`。
- 「…」菜单：移到最前、移到最后、折叠 / 展开（文字随状态）。移除原上移 / 下移按钮。
- 折叠后组头下显示 `.cl-summary`：`衣服 N · 模特 已选/共 · 将出 N 张 · 成图 N 版`；折叠状态仍存 `ft.collection.folded`。
- 搜索过滤中拖动排序只在可见组之间移动，隐藏组的相对顺序不变。

**Test cases:**
- 3 款，拖第 3 款序号到第 1 款上半部 → 顺序变为 3、1、2，`/api/collection/order` 体为新顺序，刷新后保持。
- 「…」→ 移到最后 → 该款排最后。
- 「…」→ 折叠 → 显示摘要文字，与组头计数一致；刷新后仍折叠。
- 页面不再有上移 / 下移按钮。

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：`npx vitest run tests/collection-ui.browser.test.ts -t "order"`
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**；全量四件套
- [x] **Step 5: Commit**

进展：序号拖动排序（上半插前 / 下半插后，搜索中只在可见组间移动）、「…」菜单移到最前 / 最后 / 折叠展开、折叠摘要就位，上移 / 下移按钮移除，成功后 toast「已调整顺序」；合集页用例 39 条通过，全量四件套通过（434 passed / 1 skipped）；节点衣服格原有「+N」同名 `.cl-more` 样式限定到 `.cl-node-grid` 内，组头折叠按钮 `.cl-fold` 保留。

---

### Task 4: 放图模式：拖放区、上传排队、悬停操作、快速预览

**Files:**
- Modify: `ui/collection.js`（`dropHtml`、`garmentTile`、`modelTile`、`outsHtml`、`uploadFiles`、`progHtml`、`bindEvents`）、`ui/editor.css`
- Test: `tests/collection-ui.browser.test.ts`

**Interfaces:**
- Consumes: `UI.quickLook / toast`（Task 1）
- Produces: 缩略图根元素 `.cl-tile[data-ql]`（`data-ql` 为该栏分组名：`garments-<sku>`、`models-<sku>`、`outs-<sku>`）；当前聚焦缩略图加类 `is-focus`；悬停操作条 `.cl-acts`，按钮 `.cl-half`（模特）、`.cl-cmp` 与 `.cl-addredo`（成图）。

**Requirements:**
- 衣服栏、模特栏整栏是拖放区；拖文件经过时整栏加类 `is-over`（高亮、上浮 2px），离开或放下移除。
- 上传进行中往同一款另一栏放图：加入该款队列，该栏标题显示「排队中…」，前一批完成后自动上传；不丢文件、不覆盖已有文件（沿用现有上传接口与重名规则）。
- 上传成功 `toast('服装图放入成功 N 张')` / `toast('模特图放入成功 N 张')`；失败为 error toast（文案用接口返回信息）。
- 模特图悬停出现「标半身 / 取消半身」，成图悬停出现「对照」「待重出」（已在清单时显示「已在待重出」）；键盘聚焦缩略图时操作条同样出现。
- 点缩略图（模特图点击仍切换选中）或 Tab 聚焦设为 `is-focus`；按空格对 `is-focus` 所在栏打开 `UI.quickLook`，从该图开始。

**Test cases:**
- 模拟拖文件进入模特栏 → 栏有 `is-over`；dragleave 后消失。
- 上传 3 张（服务端每张延迟 500ms）期间往同款衣服栏再放 1 张 → 衣服栏显示「排队中…」，最终两批文件都在磁盘上，原有文件哈希不变。
- 悬停模特图点「标半身」→ prefs `halfModels` 含该图，缩略图显示半身标记。
- 点第 2 张衣服图后按空格 → `.ui-ql` 显示第 2 张；→ 显示第 3 张；Esc 关闭。
- 成图悬停「待重出」→ 底栏待重出数量 +1。

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：`npx vitest run tests/collection-ui.browser.test.ts -t "place"`
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**；全量四件套
- [x] **Step 5: Commit**

进展：衣服 / 模特整栏拖放高亮、上传中同款放图排队（栏标题「排队中…」）、放图结果改 toast、模特「标半身 / 取消半身」与成图「对照」「待重出」悬停操作条、点击或 Tab 聚焦 `is-focus` 后空格快速预览就位；成图缩略图点击改为只聚焦，对照经「对照」按钮打开；合集页用例 45 条通过，全量四件套通过（440 passed / 1 skipped）。

---

### Task 5: 编辑抽屉、编辑面板与节点模式设置节点

**Files:**
- Modify: `ui/collection-drawer.js`、`ui/editor-panel.js`、`ui/collection.js`（`setNode`、`laneHtml`）、`ui/editor.css`
- Test: `tests/collection-ui.browser.test.ts`、`tests/editor-ui.browser.test.ts`

**Interfaces:**
- Consumes: `UI.segHtml / switchHtml / RULE_ICONS / menu / confirm / toast / pushLayer`（Task 1）；`window.__COLLECTION__` 现有接口
- Produces:
  - 抽屉：`.cl-drawer .ui-seg[data-cl="pairing"]`、`.ui-seg[data-cl="swap"]`、`.ui-switch[data-cl="keep"]`；每件衣服参考图按钮 `.cl-itemref[data-item="<衣服相对路径>"][aria-haspopup=menu]`，显示当前参考图缩略图与文件名。
  - 编辑面板换装范围：`.ed-panel .ui-seg[data-ed="swap"]`（取代 `input[type=radio]`）。
  - 节点模式设置节点：`.cl-setnode .ui-seg[data-cl="pairing"]`、`.ui-seg[data-cl="swap"]`、`.ui-switch[data-cl="keep"]`，与组头同一保存逻辑（Task 2 的按款串行保存）。
  - `window.__COLLECTION_DRAWER__` 现有 `{ open, close, selection }` 不变。

**Requirements:**
- 抽屉从右侧滑出，Esc（经 `pushLayer`）或点抽屉外关闭；打开时页面其余部分可滚动。
- 固定模特 / 一对一：点 `.cl-itemref` → `UI.menu` 列出「<衣服文件名>（原图）」与该衣服的各张裁图（图片缩略图），当前项 `checked`；选中后 `selection(sku).itemRefs[item]` 变为所选文件，出图计划 `itemRefs` 随之变化。
- 「恢复默认」先 `UI.confirm({ title: '恢复默认？', text: '参考图和提示词回到默认，搭配规则与换装范围不变。', ok: '恢复默认' })`，确认后行为与现在相同。
- 编辑面板「替换同用途裁图」确认改用 `UI.confirm`（title 用接口返回的提示文字，ok「替换」），取消时不发替换请求。
- 编辑面板换装范围改分段控件后，默认提示词跟随、已改判断、`keepFrame` 行为不变（含 run 页面板）。
- 节点模式设置节点上直接改规则、范围、画幅，与组头、抽屉三处显示同步。

**Test cases:**
- 固定模特款抽屉，点 g2 的参考图按钮 → 菜单含原图与 2 张裁图；选第 2 张裁图 → 按钮显示该裁图，`selection(sku).itemRefs['服装/EX1/g2.jpg']` 为该裁图路径。
- 抽屉 Esc 关闭；点抽屉外关闭。
- 恢复默认：Esc 取消 → 提示词不变；回车 → 恢复为默认提示词，规则与范围不变。
- 编辑面板点范围「只换上衣」→ `/api/prompt` 体 `swap: 'top'`，没改过的提示词跟随。
- 替换裁图确认 Esc → 无 `replace: true` 请求；回车 → 有。
- 节点模式设置节点点「一对一」→ prefs 体 `pairing: 'oneToOne'`，组头分段同步为一对一。
- run 页保持画幅组打开面板不显示「已改」（沿用 Fable 第 1 条修复用例）。

- [x] **Step 1: 按上述 cases 写失败测试（现有 radio / select 用例改新选择器）**
- [x] **Step 2: 运行确认失败**：`npx vitest run tests/collection-ui.browser.test.ts tests/editor-ui.browser.test.ts`
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**；全量四件套
- [x] **Step 5: Commit**

进展：抽屉改用分段控件 / 开关、Esc（`pushLayer`）与点外关闭、每件衣服参考图改带缩略图的弹出菜单、「恢复默认」与替换裁图改工作表确认，面板范围改分段控件，节点模式设置节点可直接改规则 / 范围 / 画幅，三处经同一按款串行保存并同步显示（Task 2 跟踪项收口，过渡桥接移除）；合集页 + 编辑页用例 63 条通过，全量四件套通过（443 passed / 1 skipped）；裁图对话框也入 Esc 栈（开着时 Esc 先关它，不关抽屉）。

---

### Task 6: 成图对照、待重出面板与合集页出图进度

**Files:**
- Modify: `ui/collection.js`（`renderCompare`、`openCompare`、`renderRedo`、`openRedo`、`runRedo`、`closeModal`、`buildModals`、`bindModals`、`watchRun`、`renderBar`）、`ui/editor.css`
- Test: `tests/collection-ui.browser.test.ts`

**Interfaces:**
- Consumes: `UI.segHtml / confirm / toast / pushLayer`（Task 1）；现有 `/api/redo`、`/api/redo/run`、`POST /api/runs/<runId>/cancel`
- Produces: 对照版本 `.cl-compare .ui-seg[data-cl="version"]`；待重出面板 `#cl-redo.cl-side`（与抽屉同位置，二者互斥）；底栏进度 `#ed-go` 文字 `出图中 N/M` 与 `#ed-go .cl-pbar`，停止按钮 `#cl-stop`。

**Requirements:**
- 对照：版本用分段控件；← → 切换版本；Esc 关闭；其余内容与现在相同。
- 待重出改为右侧面板，打开时若抽屉开着则关闭抽屉（反之亦然）；Esc 关闭。
- 移除一项后 `toast('已移除 <模特图名>', { action: { label: '撤销', run } })`，5 秒内点撤销 → 以原备注重新加入（`/api/redo` add + note）。
- 「重出这 N 张」apimart 时 `UI.confirm`（文案同出图）；成功后 `toast('已开始重出 N 张', { link: { label: '查看出图记录', href } })`。
- 出图中（本页发起或检测到在跑的 run）：`#ed-go` 显示「出图中 N/M」与进度条并禁用，`#cl-stop` 出现；点停止 → `UI.confirm({ title: '停止出图？', text: '已交付的图会保留，排队中的不再生成。', ok: '停止', danger: true })` → 确认后调用取消接口。
- run 结束：`toast('出图完成 · 交付 N 张 · 失败 N 张', { link: { label: '查看出图记录', href } })`；已取消时 `toast('已停止 · 已交付 N 张')`。

**Test cases:**
- 对照打开后按 → 切到下一版本，分段选中同步；Esc 关闭。
- 打开抽屉再打开待重出 → 只有待重出面板开着。
- 待重出移除一项 → 列表少一项；点 toast 撤销 → 该项与备注恢复。
- 出图（fake 引擎，每张延迟 600ms，共 2 张）→ 期间 `#ed-go` 文本匹配 `/^出图中 \d\/2$/`；点停止并回车 → run 状态为 cancelled，已交付文件保留，出现「已停止」toast。
- 正常跑完 → 出现「出图完成 · 交付 2 张 · 失败 0 张」toast。

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：`npx vitest run tests/collection-ui.browser.test.ts -t "compare|redo|progress"`
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**；全量四件套
- [x] **Step 5: Commit**

进展：对照版本改分段控件（← → 切换、Esc 经层级栈关闭），待重出改右侧面板（与抽屉互斥、Esc 关闭、移除带 5 秒撤销、apimart 重出走工作表、重出后留在本页出「已开始重出」toast），底栏出图中显示「出图中 N/M」+ 进度条与「停止」（工作表确认后调取消接口），run 结束出汇总或「已停止」toast；「出图」主按钮仍按原样跳到 run 页（submit 未在本任务文件清单内），合集页用例 53 条通过，全量四件套通过（448 passed / 1 skipped）。

验证修复：「出图」主按钮（含 ⌘↩、「只出这款」）改为按原型留在合集页，toast「开始出图 · 共 N 张」带出图记录链接，底栏显示进度并在结束出汇总（请求体不变，补本页发起用例）；重出成功后关闭待重出面板。

验证修复 2：合集页浏览器测试偶发 ENOTEMPTY（Task 6 之前已有）——服务关闭时缩略图请求还在途、未登记到缓存写入队列，关闭后才写 `.thumbs`，与测试清理临时目录抢；改为关闭时先等在途请求处理完再等缩略图写完，全量四件套连跑 3 次通过（449 passed / 1 skipped）。

---

### Task 7: run 节点图页

**Files:**
- Modify: `ui/editor.js`、`ui/editor.css`、`src/simple/graph.ts`（仅成图节点勾选标记的类名，如需要）
- Test: `tests/editor-ui.browser.test.ts`、`tests/simple-graph.browser.test.ts`

**Interfaces:**
- Consumes: `UI.segHtml / confirm / toast / quickLook / pushLayer`（Task 1）；Task 5 的编辑面板分段控件
- Produces: 引擎 `.ui-seg#ed-engine`；成图卡片选中：`.pair[data-sku][data-model]` 点击切换类 `is-picked`（取代 `input.ed-pick`），右上角勾标 `.ed-tick`；`window.__EDITOR__.picked(): { sku: string; item?: string; model: string }[]`（测试用）。

**Requirements:**
- 成图卡片点击切换选中；「全选」按钮保留；带 item 的组仍只读、不可选，「在合集里重出」链接保留。
- 重出：apimart 时 `UI.confirm({ title: '用 apimart 重出？', text: 'apimart 会产生真实费用，确定用它重出吗？', ok: '确定重出' })`；请求体与改造前相同（shots 的 sku / item / model）。
- 报错改 error toast；「取消」按钮先 `UI.confirm({ title: '停止出图？', text: '已交付的图会保留，排队中的不再生成。', ok: '停止', danger: true })`。
- 重出中底栏显示进度（与合集页同样式）。
- 点成图后按空格快速预览同一款的成图；Esc 关闭任何弹层。
- file:// 打开的只读节点图不加载任何 `/ui/` 脚本，外观与改造前一致（快照不变）。

**Test cases:**
- 点两张成图卡片 → `__EDITOR__.picked()` 含两项；再点一张取消。
- 选 1 张、引擎 codex 点重出 → 新 run 只含该张（沿用现有用例）。
- 引擎 apimart 点重出 → 出现工作表；Esc 无请求。
- 重出接口返回 409 → 出现 error toast，文字为接口信息。
- 带 item 的组卡片点击不改变选中。
- 只读节点图 HTML 快照与改造前相同。
- 页面 `input.ed-pick` 与 `select` 数量为 0。

- [x] **Step 1: 按上述 cases 写失败测试（现有用例改新选择器）**
- [x] **Step 2: 运行确认失败**：`npx vitest run tests/editor-ui.browser.test.ts tests/simple-graph.browser.test.ts`
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**；全量四件套
- [x] **Step 5: Commit**

进展：run 页成图改点卡片选中（`is-picked` + 勾标，捕获点击不再开大图）、引擎改分段控件、apimart 重出与取消走工作表、报错改 error toast、本页 run 在跑时底栏显示「出图中 N/M」与进度条、空格快速预览同款成图，只读页不加载 /ui/；相关用例 31 条通过，全量四件套通过（451 passed / 1 skipped）。

---

### Task 8: 静态检查、文档与同事包

**Files:**
- Create: `tests/ui-static.test.ts`
- Modify: `README.md`、`docs/USAGE.md`、`docs/COLLEAGUE_INSTALL_AND_REAL_TEST.md`、`skills/fashion-tryon/SKILL.md`（如有页面操作说明）、`tests/colleague-package.test.ts`
- Test: `tests/ui-static.test.ts`、`tests/colleague-package.test.ts`、`tests/skill-contract.test.ts`

**Interfaces:**
- Consumes: Task 1–7 全部产物

**Requirements:**
- 静态检查：`ui/collection.js`、`ui/collection-drawer.js`、`ui/editor-panel.js`、`ui/editor.js` 不含 `<select`、`alert(`、`confirm(`（`UI.confirm(` 除外）、`type="radio"`；`ui/controls.js` 存在且被两页加载。
- 文档写明：分段控件 / 开关的位置、拖动序号排序与「…」菜单、空格快速预览、⌘F / ⌘↩ / Esc、缩略图大小滑块、合集页底栏停止、待重出撤销。
- 同事包清单含 `ui/controls.js`；包内文件只因新增该文件而变化。

**Test cases:**
- `ui-static`：四个脚本无上述禁用写法 → 通过；人为在临时副本里加一个 `<select` → 检查函数报出文件名。
- colleague-package：清单含 `ui/controls.js`。
- 全量四件套通过；合集页 spec 第 11 节验收对应的现有用例全部通过。

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：`npx vitest run tests/ui-static.test.ts tests/colleague-package.test.ts`
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**；全量四件套
- [x] **Step 5: Commit**

进展：新增 `tests/ui-static.test.ts`（四个页面脚本无 `<select` / `alert(` / `confirm(` / 单选框，临时副本加 `<select` 报出文件名，controls.js 被两页加载），同事包与同事文档列出 `ui/controls.js`，README / USAGE / 同事文档写明分段控件、开关、拖动序号与「…」菜单、空格快速预览、⌘F / ⌘↩ / Esc、缩略图滑块、底栏停止、待重出撤销；相关用例 8 条通过，全量四件套通过（455 passed / 1 skipped）。

---

## 自查记录

- Spec 覆盖：§2 控件规则 → Task 1（控件）+ 2、5、6、7（替换）；§3 动效 → Task 1；§4.1 顶栏 → Task 2；§4.2 组头 → Task 2、3；§4.3 放图 → Task 4；§4.4 节点 → Task 5；§4.5 抽屉 → Task 5；§4.6 底栏 → Task 2、6；§4.7 对照与待重出 → Task 6；§4.8 保存一致性 → Task 2；§5 run 页 → Task 7；§7 验收 1 → Task 8，2–3 → Task 2，4 → Task 5，5 → Task 3，6 → Task 2、5、6、7，7 → Task 2、4、6，8 → Task 6，9 → Task 4、6，10 → Task 2、5、6，11 → Task 2，12 → Task 4，13 → Task 2，14 → Task 1，15–16 → Task 8。
- 类型一致：`window.__UI__` 的 `segHtml / switchHtml / RULE_ICONS / menu / confirm / toast / quickLook / pushLayer` 与 `ui-change` 事件（T1）→ T2–T7；`data-cl` 取值 `pairing / swap / keep / mode / version`（T2、T5、T6）一致；`#ed-engine`、`#ed-go` 两页沿用现有 id。
- 无占位符；未预写实现代码。
