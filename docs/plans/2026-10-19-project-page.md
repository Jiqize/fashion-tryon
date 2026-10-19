# 项目页 Implementation Plan

**Goal:** 新增项目页：一个素材根目录一个项目，卡片显示封面、款数 · 成图数、最近出图、待重出，点进去是该目录的合集页；启动器和不带参数的 `fashion-tryon open` 打开项目页。
**Architecture:** 每个素材目录的编辑服务（`startEditorServer`）不变。新增一个全局「项目服务」进程（`fashion-tryon hub`，只监听 127.0.0.1，会话文件在 `~/.config/fashion-tryon/hub.json`），读写本机项目列表 `projects.json`、统计各目录、弹系统选文件夹窗口；点卡片时由项目服务调用现有 `ensureEditor` 拉起或复用该目录的编辑服务，再把浏览器带到它的合集页。合集页的「项目」入口走编辑服务的 `/projects`，由它 `ensureHub` 后 302 到项目页。
**Tech Stack:** TypeScript/Node、node:http、zod、sharp（复用 thumbs.ts）、Vitest、Playwright、tsdown、AppleScript；前端无构建原生 JS + `ui/controls.js`。

Spec：`docs/specs/2026-10-19-project-page.md`（已确认）。

## Global Constraints

- 文件夹是唯一事实来源；项目页不重命名、移动、删除任何文件夹或文件。除封面缩略图缓存（`成图/_runs/.thumbs/`，复用 `thumbnail()`）外，不往素材目录写入。
- 项目列表只写 `<配置目录>/projects.json`；配置目录与 `last-root` 相同：`FASHION_TRYON_HOME` 或 `~/.config/fashion-tryon`。
- 同一文件夹按 `path.resolve` 后的绝对路径判重，只出现一次。
- 显示名默认是文件夹名（`path.basename`）；不能超过 40 字（按 Unicode 字符数），超出报 `显示名最长 40 字`；传空字符串表示清除自定义名。
- 选文件夹拒绝 `/` 与用户主目录本身，报 `请选一个具体的素材文件夹`。
- 卡片排序：有出图的按最近出图开始时间从新到旧；没出过图的按加入时间从新到旧，排在后面。
- 合集页、run 节点图、出图规则、MCP 工具参数不改（只加「项目」入口和显示名）。
- 项目服务与编辑服务同一套安全规则：只监听 127.0.0.1，token（query 一次后换 HttpOnly SameSite=Strict Cookie，项目服务 Cookie 名 `ft_hub`），POST 校验 Origin，CSP 按 sha256 放行内联样式、脚本只从 `/ui/` 加载；响应与日志不含密钥。
- 页面脚本不出现原生 `<select`、`alert(`、`confirm(`（`UI.confirm` 除外）、`type="radio"`。
- 测试一律不碰真实 `~/.config/fashion-tryon`：全局 setup 把 `FASHION_TRYON_HOME` 指到临时目录。
- 代码英文，注释中文；每个任务结束跑 `npm run build && npm test && npm run typecheck && npm run scan:secrets`。

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/editor/last-root.ts` | 导出配置目录函数，供项目列表共用 |
| `src/editor/projects.ts`（新） | 项目列表读写：加入、改名、移除、撤销移除、首次从 last-root 带入 |
| `src/editor/project-stats.ts`（新） | 单个目录的卡片数据：是否存在、款数、成图数、最近出图、待重出、封面 |
| `src/editor/hub-server.ts`（新） | 项目服务：页面、接口、鉴权、会话文件 |
| `src/editor/hub-launch.ts`（新） | `ensureHub`：项目服务在跑就复用，否则后台拉起 `fashion-tryon hub` |
| `src/editor/projects-page.ts`（新） | 项目页外壳 HTML |
| `ui/projects.js`（新） | 项目页：卡片网格、搜索、新建、菜单（改名、Finder、移除 + 撤销） |
| `ui/editor.css` | 项目页样式（`.pj-*`）；合集页「项目」入口样式 |
| `src/cli.ts` | 新命令 `hub`；`open` 无参数时打开项目页；`open <目录>`、`editor` 加入项目列表 |
| `src/editor/server.ts`、`src/editor/collection-view.ts` | 合集视图带显示名；GET `/projects` 跳项目页 |
| `ui/collection.js` | 顶栏「项目」入口、显示名 |
| `scripts/macos/launcher.applescript` | 双击只运行 `open`，去掉 Option 选目录 |
| `vitest.config.ts`、`tests/helpers/isolate-home.ts`（新） | 全局隔离配置目录 |
| 文档 | README、`docs/USAGE.md`、`skills/fashion-tryon/SKILL.md` |

---

### Task 1: 项目列表存储

**Files:**
- Modify: `src/editor/last-root.ts`（抽出 `configDir`）
- Create: `src/editor/projects.ts`
- Create: `tests/helpers/isolate-home.ts`；Modify: `vitest.config.ts`（`setupFiles`）
- Test: `tests/editor-projects.test.ts`（新）

**Interfaces:**
- Produces:
  - `configDir(env: NodeJS.ProcessEnv): string`（`last-root.ts` 导出；`readLastRoot` / `writeLastRoot` 改用它，行为不变）
  - `interface ProjectEntry { id: string; root: string; name?: string; addedAt: string }`（`id` = `root` 的 sha256 前 12 位十六进制；`addedAt` 为 ISO 时间）
  - `projectsPath(env): string` → `<configDir>/projects.json`
  - `listProjects(env): Promise<ProjectEntry[]>`
  - `addProject(env, root: string, now?: Date): Promise<{ entry: ProjectEntry; added: boolean }>`
  - `renameProject(env, id: string, name: string): Promise<ProjectEntry>`
  - `removeProject(env, id: string): Promise<ProjectEntry>`
  - `restoreProject(env, entry: ProjectEntry): Promise<ProjectEntry>`
  - `displayName(entry: ProjectEntry): string`（`name ?? path.basename(root)`）
  - `findProjectByRoot(env, root: string): Promise<ProjectEntry | undefined>`

**Requirements:**
- 文件格式 `{ "version": 1, "projects": ProjectEntry[] }`；文件不存在时：有 `last-root` 则带入它作为唯一项目并写文件，没有则返回空列表且不建文件。带入只做一次（文件存在后不再看 last-root）。
- 文件损坏（非 JSON 或不符合 schema）抛 `RunnerError('VALIDATION_ERROR', '项目列表文件损坏：<projectsPath>')`，不覆盖原文件。
- 写入先写同目录临时文件再 rename；同进程内修改串行。
- `addProject` 按 `path.resolve(root)` 判重：已存在返回 `{ added: false }` 且不改动；不检查目录内容。
- `renameProject`：`name.trim()` 为空时删掉 `name` 字段；超过 40 字报 `显示名最长 40 字`；找不到 id 报 `RunnerError('VALIDATION_ERROR', '找不到这个项目')`。
- `removeProject` 返回被移除的条目（供撤销）；`restoreProject` 原样放回（同 root 已存在则不重复，返回已有条目）。
- 全局 setup：每个测试文件把 `process.env.FASHION_TRYON_HOME` 设为新的临时目录（已显式设置的测试不受影响）。

**Test cases:**
- 无 projects.json、无 last-root → `[]`，配置目录里没有新文件。
- 无 projects.json、last-root 为 `/x/AI` → 返回一项 `root: '/x/AI'`，文件已写出；随后删掉 last-root 再读仍是这一项。
- `addProject('/x/A')` 两次（第二次传 `'/x/A/'`）→ 第二次 `added: false`，列表 1 项。
- `renameProject(id, '26冬毛绒')` → `displayName` 为 `26冬毛绒`；`renameProject(id, '  ')` → 回到文件夹名；41 字 → 报 `显示名最长 40 字`。
- `removeProject` 后列表为空，`restoreProject(removed)` 后恢复，`addedAt` 不变。
- 写入损坏 JSON → `listProjects` 抛「项目列表文件损坏」，文件内容不变。
- 并发两次 `addProject`（不同目录）→ 两项都在。
- `readLastRoot` / `writeLastRoot` 现有测试仍通过。

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：`npx vitest run tests/editor-projects.test.ts` → 找不到模块 `src/editor/projects.ts`
- [x] **Step 3: 最小实现使其通过**（含 setupFiles）
- [x] **Step 4: 运行确认通过**：同上命令全绿；`npm test` 全量通过
- [x] **Step 5: Commit**：`feat(projects): local project list`
- 进展 2026-10-19：完成；setupFiles 每个测试文件把 FASHION_TRYON_HOME 指到新临时目录；全量 480 通过

### Task 2: 项目卡片数据

**Files:**
- Create: `src/editor/project-stats.ts`
- Test: `tests/editor-project-stats.test.ts`（新）

**Interfaces:**
- Consumes: `ProjectEntry`、`displayName`（Task 1）；`scanSimple`、`listRunRecords`、`readCollection`
- Produces:
  - `interface ProjectCard { id: string; name: string; root: string; missing: boolean; skuCount: number; outputCount: number; lastRunAt: string | null; redoCount: number; cover: string | null; addedAt: string }`（`cover` 为相对素材根目录的路径）
  - `projectCard(entry: ProjectEntry): Promise<ProjectCard>`
  - `sortCards(cards: ProjectCard[]): ProjectCard[]`

**Requirements:**
- 目录不存在或不是目录 → `missing: true`，数字为 0、`lastRunAt`/`cover` 为 null，不抛错。
- `skuCount` = `scanSimple(root).length`（与合集页一致）。
- `outputCount` = 每款 `成图/<款号>/` 下非隐藏的 jpg/jpeg/png/webp 文件数之和（含各版本，不含 `_runs/`）。
- `lastRunAt` = `listRunRecords` 中最新记录的 `startedAt`（没有 startedAt 的记录跳过）；没有 → null。
- `redoCount` = `readCollection(root).redo.length`；合集设置文件损坏时按 0，不抛错。
- `cover`：按运行记录从新到旧，取第一张仍存在的 `delivered` 成图；没有则取第一款（`scanSimple` 顺序）的第一张衣服图；都没有 → null。
- `sortCards`：`lastRunAt` 非空的按其降序在前；为空的按 `addedAt` 降序在后。
- 不往目录写任何文件。

**Test cases:**
- 临时目录 2 款、成图 `EX1/a.png`、`EX1/a-v2.png`、`EX2/b.webp`，`成图/_runs/` 下有图 → `skuCount 2`、`outputCount 3`。
- 有两条运行记录 → `lastRunAt` 为较新的 startedAt；`cover` 为较新记录交付且仍存在的成图；把它删掉 → 回退到较旧记录的成图。
- 没有成图 → `cover` 为第一款第一张衣服图；空目录 → `cover null`、`skuCount 0`。
- collection.json 有 2 条 redo → `redoCount 2`；损坏 → 0。
- 不存在的路径 → `missing: true`。
- `sortCards`：A(lastRunAt 10-16)、B(null, addedAt 10-18)、C(lastRunAt 10-17)、D(null, addedAt 10-19) → C、A、D、B。
- 统计前后目录文件列表不变。

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：`npx vitest run tests/editor-project-stats.test.ts` → 找不到模块
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**：同上命令全绿
- [x] **Step 5: Commit**：`feat(projects): project card stats`
- 进展 2026-10-19：完成；成图数只数 scanSimple 款号对应的 成图/<款号>/；全量 486 通过

### Task 3: 项目服务与 `hub` 命令

**Files:**
- Create: `src/editor/hub-server.ts`、`src/editor/hub-launch.ts`、`src/editor/projects-page.ts`（外壳先只含挂载点与脚本引用）
- Modify: `src/cli.ts`（新命令 `hub`）
- Test: `tests/hub-server.test.ts`（新）、`tests/cli.test.ts`（`hub` 首行输出）

**Interfaces:**
- Consumes: Task 1、Task 2 全部导出；`ensureEditor(root, config)`、`editorMaterialsUrl`、`thumbnail`/`imageTag`（thumbs.ts）、`LaunchConfig`
- Produces:
  - `interface HubServerOptions { port?: number; launch: LaunchConfig; pickFolder?: () => Promise<string | null>; revealFolder?: (root: string) => void }`（默认 `pickFolder` 用 `osascript` 运行 `choose folder with prompt "选择素材文件夹"`，取消返回 null；默认 `revealFolder` 用 `open <root>`）
  - `startHubServer(options: HubServerOptions): Promise<{ url: string; origin: string; token: string; close(): Promise<void> }>`
  - `hubSessionPath(env): string` → `<configDir>/hub.json`；`readHubSession(env)`、`pingHub(session)`（同 `EditorSession` 形状与 ping 规则）
  - `ensureHub(config: LaunchConfig): Promise<{ origin: string; token: string }>`（同 `ensureEditor` 的复用 / 拉起 / 等待规则，子进程 `hub --no-open --json`，日志 `<configDir>/hub.log`）
  - `hubPageUrl(origin: string, token: string): string` → `${origin}/?token=${token}`
  - HTTP 接口：
    - `GET /` → 项目页 HTML
    - `GET /api/projects` → `{ projects: ProjectCard[] }`（已 `sortCards`）
    - `GET /cover/<id>` → 该项目封面的缩略图（JPEG）；没有封面或 missing → 404
    - `POST /api/projects/pick` → 弹窗；取消 → `{ cancelled: true }`；否则 `{ id, added, url }`
    - `POST /api/projects/open` `{ id }` → `{ url }`（该目录合集页地址，`ensureEditor` 得到）
    - `POST /api/projects/rename` `{ id, name }` → `{ project: ProjectCard }`
    - `POST /api/projects/remove` `{ id }` → `{ removed: ProjectEntry }`
    - `POST /api/projects/restore` `{ entry: ProjectEntry }` → `{ project: ProjectCard }`
    - `POST /api/projects/reveal` `{ id }` → `{ ok: true }`
    - `GET /ui/<file>` 同编辑服务白名单加 `projects.js`；`GET /api/ping`
- CLI：`fashion-tryon hub [--port <n>] [--no-open] [--json]`，stdout 首行 `{ url, origin }`，前台运行直到中止。

**Requirements:**
- 鉴权、Origin、CSP、路径片段校验、错误响应格式与编辑服务一致；Cookie 名 `ft_hub`。
- 会话文件写法与编辑服务的 `claimSession` 规则一致：已有活着的项目服务时，后启动的进程报错退出；关闭时只删自己的会话文件。
- `pick`：拿到路径后 `path.resolve`；是 `/` 或 `os.homedir()` → 报 `请选一个具体的素材文件夹`；不是目录 → 报 `RunnerError('VALIDATION_ERROR', '不是文件夹：<路径>')`；然后 `addProject`，再 `ensureEditor` 返回合集页 url。
- `open`：项目 missing → 报 `找不到文件夹：<root>`；不存在的 id → `找不到这个项目`（HTTP 400）。
- `reveal`：missing 时报 `找不到文件夹：<root>`。
- 不提供删除文件夹的接口；任何接口都不写素材目录（封面缩略图缓存除外）。
- 不自动退出（无 idle）。

**Test cases:**
- 无 token → 401；query token 后得到 `ft_hub` Cookie，带 Cookie 可访问。
- POST 无 Origin 或 Origin 不符 → 403。
- 页面响应带 CSP，内联样式哈希匹配，`script-src` 不含 `unsafe-inline`。
- `GET /api/projects` 返回已排序的卡片；有 last-root 时首次即含该项目。
- `pick` 注入返回临时目录 → `added: true`、url 指向编辑服务 `/materials/?token=`（`ensureEditor` 用测试 CLI 命令真实拉起）；再 pick 同一目录 → `added: false`；注入返回 null → `{ cancelled: true }`；注入返回 `os.homedir()` → 400「请选一个具体的素材文件夹」。
- `rename` 41 字 → 400「显示名最长 40 字」；`remove` 再 `restore` → 列表恢复；目录内文件列表在所有操作前后不变（除 `成图/_runs/.thumbs/`）。
- `reveal` 调用注入的 `revealFolder` 且参数为该 root。
- `GET /cover/<id>` 有成图 → 200 image/jpeg；空目录 → 404。
- 第二个 `startHubServer` 在第一个活着时报错；关闭第一个后 hub.json 被删除。
- `ensureHub` 两次 → 第二次复用同一 origin。
- CLI `hub --no-open --json` 首行可解析为 `{ url, origin }`。

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：`npx vitest run tests/hub-server.test.ts` → 找不到模块
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**：同上命令全绿；`npm test` 全量通过
- [x] **Step 5: Commit**：`feat(projects): hub server and hub command`
- 进展 2026-10-19：完成；鉴权、CSP、会话文件等抽到 `src/editor/http.ts` 两个服务共用，拉起逻辑抽成 `ensureService`；restore 校验 id 与路径对得上；全量 495 通过

### Task 4: 项目页前端

**Files:**
- Modify: `src/editor/projects-page.ts`（完整外壳）
- Create: `ui/projects.js`
- Modify: `ui/editor.css`（`.pj-*`）
- Modify: `tests/ui-static.test.ts`（`PAGE_SCRIPTS` 加 `ui/projects.js`）
- Test: `tests/projects-ui.browser.test.ts`（新，Playwright，起真实 `startHubServer`，`pickFolder` / `revealFolder` 注入）

**Interfaces:**
- Consumes: Task 3 的 HTTP 接口；`window.__UI__`（`menu`、`confirm`、`toast`）
- Produces: 页面 DOM 约定（测试用）：卡片 `.pj-card[data-id]`，缺失卡片加 `.is-missing`；新建卡片 `#pj-new`；搜索 `#pj-search`；刷新 `#pj-refresh`；卡片菜单按钮 `.pj-more`

**Requirements:**
- 页面标题「项目」；顶栏：标题「项目」、项目数「N 个项目」、搜索框（placeholder `搜索项目`）、「刷新」。
- 卡片网格随宽度换行（`grid-template-columns: repeat(auto-fill, minmax(220px, 1fr))`），窄窗口至少一列；最后一张是「＋ 新建项目」。
- 每张卡片：封面（`/cover/<id>`，无封面显示空白占位）、显示名、「N 款 · M 张成图」、最近出图「MM-DD HH:mm」或「还没出图」、`redoCount > 0` 时显示「待重出 N」。
- missing 卡片变灰，显示「找不到文件夹」与原路径，点击不进入，菜单只有「从列表移除」。
- 点卡片：POST open，成功后 `location.href = url`（同一标签页）；失败 toast（不自动消失）。
- 「＋ 新建项目」：POST pick；`cancelled` 什么都不做；成功后跳到返回的 url；失败 toast。
- 「…」菜单：改显示名（弹出带输入框的工作表，回车保存、Esc 取消，预填当前显示名）、在 Finder 里打开、从列表移除。
- 移除先弹确认工作表，文案「只从项目页移除，不删除文件夹里的任何文件」，回车确认、Esc 取消；移除后 toast「已移除 <显示名>」带「撤销」，点了 POST restore 并刷新。
- 搜索按显示名或文件夹名过滤，不区分大小写；⌘F 聚焦搜索框。
- 改名、移除、刷新后重新拉 `/api/projects` 重画；不做定时刷新。
- 风格沿用合集页（`THEME_CSS` + `editor.css` 现有变量），明暗主题都可读。

**Test cases:**
- 两个项目（一个有成图、一个空）→ 2 张卡片 + 新建卡；有成图的在前，显示「2 款 · 3 张成图」与时间；空项目显示「还没出图」。
- 搜索「ai」只剩显示名或文件夹名含 ai 的卡片。
- 点新建（注入返回新空目录）→ 页面跳到编辑服务的 `/materials/`。
- 改显示名为「26冬毛绒」→ 卡片标题更新；刷新页面仍是新名。
- 移除 → 确认 → 卡片消失；点 toast「撤销」→ 卡片回来。
- 把一个项目目录删掉后点刷新 → 卡片 `.is-missing`，点击不跳转。
- `ui-static` 检查 `ui/projects.js` 无禁用写法。

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：`npx vitest run tests/projects-ui.browser.test.ts tests/ui-static.test.ts` → 页面元素找不到 / 文件不存在
- [x] **Step 3: 最小实现使其通过**
- [x] **Step 4: 运行确认通过**：同上命令全绿
- [x] **Step 5: Commit**：`feat(projects): project page ui`
- 进展 2026-10-19：完成；改显示名用新增的共享控件 `UI.ask`（工作表 + 输入框）；缺失卡片不加 aria-disabled（否则「…」也被当成禁用）；全量 501 通过

### Task 5: 入口接线：open、编辑服务、合集页、启动器、文档

**Files:**
- Modify: `src/cli.ts`（`open`、`editor`）
- Modify: `src/editor/server.ts`（GET `/projects`、给视图传显示名）、`src/editor/collection-view.ts`（`CollectionView.projectName`）
- Modify: `ui/collection.js`（`buildTop` / `renderTop`）、`ui/editor.css`
- Modify: `scripts/macos/launcher.applescript`
- Modify: README、`docs/USAGE.md`、`skills/fashion-tryon/SKILL.md`
- Test: `tests/cli.test.ts`、`tests/editor-server.test.ts`、`tests/collection-ui.browser.test.ts`

**Interfaces:**
- Consumes: `addProject`、`findProjectByRoot`、`displayName`（Task 1）；`ensureHub`、`hubPageUrl`（Task 3）
- Produces:
  - `CollectionView.projectName: string`（在列表里取 `displayName`，不在列表里为文件夹名；取代页面上 `rootName` 的显示，`rootName` 字段保留）
  - 编辑服务 `GET /projects` → `ensureHub(options.launch)` 后 302 到 `hubPageUrl`；拉起失败返回 500 JSON 错误

**Requirements:**
- `fashion-tryon open`（无参数）：`ensureHub` 后打开项目页 url；输出 `{ ok: true, command: 'open', status: 'completed', url }`；不再报「还没有记住素材根目录」。
- `fashion-tryon open <目录>`：行为不变（打开合集页、写 last-root），并 `addProject`。
- `fashion-tryon editor <目录>`：启动成功后 `addProject`（因此 `open_graph`、`start_run` 自动打开、`ensureEditor` 拉起的目录都会进入项目列表）。`addProject` 失败（如列表文件损坏）只写 stderr 警告，不影响编辑服务。
- 合集页顶栏最左边加按钮「项目」（`<a class="cl-btn" href="/projects">`），点了同一标签页去项目页；`<h1>` 由「合集」改为项目显示名，`#cl-info` 改为「N 款」+ 原有其余内容；`<title>` 保持「合集」。
- 启动器：双击只运行 `open --json`；删除 Option 键判断与 `pickAndOpen`；失败仍 `display alert "打开项目页失败"`；注释同步。重新运行 `npm run install:launcher` 生效。
- 文档：USAGE「在合集页放图并出图」前加「项目页」小节（入口、卡片内容、新建、管理、排序、项目列表位置）；一键打开一段改为打开项目页；README 命令表加 `hub`；SKILL 里 `open` 的说明同步。

**Test cases:**
- CLI `open --no-open --json`（无参数，空配置目录）→ ok 且 url 指向项目服务 `/?token=`。
- CLI `open <tmp> --no-open --json` → `listProjects` 含 `<tmp>`，last-root 为 `<tmp>`。
- CLI `editor <tmp> --no-open --json` 起来后 `listProjects` 含 `<tmp>`；projects.json 损坏时 editor 仍正常启动。
- 编辑服务 `GET /api/collection` 含 `projectName`；改名后再取为新名；不在列表里为文件夹名。
- 编辑服务 `GET /projects`（带 Cookie）→ 302，`location` 以项目服务 origin 开头。
- 合集页浏览器测试：顶栏有「项目」链接 `href="/projects"`，`h1` 文本为显示名。
- 现有 `open`、`open_graph`、合集页测试全部仍通过。

- [x] **Step 1: 按上述 cases 写失败测试**
- [x] **Step 2: 运行确认失败**：`npx vitest run tests/cli.test.ts tests/editor-server.test.ts tests/collection-ui.browser.test.ts` → 新用例失败
- [x] **Step 3: 最小实现使其通过**（含启动器与文档）
- [x] **Step 4: 运行确认通过**：`npm run build && npm test && npm run typecheck && npm run scan:secrets` 全绿
- [x] **Step 5: Commit**：`feat(projects): open, collection page and launcher go through the project page`
- 进展 2026-10-19：完成；`open <目录>` 与 `editor` 加入列表失败都只写 stderr 警告；dist 冒烟：无参 open 拉起并复用项目服务；全量 505 通过

### Task 6: 真实验收

**Files:**
- Modify: `PROJECT.md`

**Requirements:**
- `npm run build && npm run install:launcher`，双击桌面「Tryon 合集」→ 项目页，`~/Documents/AI` 作为第一个项目出现，数字与进入后合集页一致。
- 用「＋ 新建项目」在窗口里新建一个空文件夹（例如 `~/Documents/AI-项目验收`）→ 进入 0 款合集页 → 新建款放 1 张衣服 1 张模特 → 「项目」回项目页，款数变 1。
- 改名、在 Finder 里打开、移除 + 撤销各点一次。
- 截图交用户目测，不做自动评价；不出图（不花费）。

- [x] **Step 1: 按上述步骤走一遍并截图**
- [x] **Step 2: 交用户目测，记录反馈**
- [x] **Step 3: 更新 PROJECT.md 并 Commit**：`docs: project status after project page`
- 进展 2026-10-19：完成；~/Documents/AI 作为首个项目自动带入，卡片 7 款 · 72 张成图与合集页一致；封面改靠上取图；用户确认验收通过

## 自查

- Spec 覆盖：§2 入口 → Task 5（open、启动器、合集页入口、editor/open_graph 加入）；§3 列表 → Task 1；§4 卡片 → Task 2（数据）+ Task 4（显示、missing、点击）；§5 新建 → Task 3（pick 规则）+ Task 4；§6 管理 → Task 1/3/4；§7 视觉与安全 → Task 3/4；§9 验收 1–12 → Task 1–6（第 10 条两个项目各自出图：编辑服务本来按目录一个进程，不改动，由现有测试保证，Task 6 不出图）。
- 无占位符；签名在各任务间一致（`ProjectEntry`、`ProjectCard`、`ensureHub`、`hubPageUrl`、`projectName`）。
