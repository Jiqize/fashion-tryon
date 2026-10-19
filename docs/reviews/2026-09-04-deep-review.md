# Fashion Try-on Runner 深度评审（2026-09-04）

评审对象：工作区当前状态（HEAD `0e19780` + 约 940 行未提交改动：成图发布、同事包脚本、文档）。
评审方式：主审通读 CLI / review-session / finalize / 配置 / Skill / 文档并执行全部门禁；四个子评审分别通读 run-state、provider、review-report、preflight 四个子系统及其测试。所有 P0 与主要 P1 由主审在源码或本机复现中二次确认，标记见各条末尾（复现 / 源码确认 / 子评审）。

## 1. 结论

- 架构与安全边界设计扎实：运行事实与派生物分离、原子写盘、append-only delivery、loopback 审核会话、密钥脱敏、注入防护均达到生产水准，未发现密钥泄漏路径或 HTML 注入面。
- **当前不宜交给同事做真实测试。** 4 个 P0 中有 3 个会在同事最常见的素材形态下静默出错或直接崩溃，1 个会让安装流程第一条真实调用就报 CONFIG_ERROR。
- 付费边界存在 6 处可导致重复计费或超出已授权上限的路径，均未被测试覆盖。
- 未提交的成图发布特性没有 spec，且首次让工具写入 run 目录之外的用户素材树；建议补 spec 后再提交。
- 门禁现状：测试 305 通过 / 1 跳过；`pnpm typecheck` 失败；`pnpm build` 通过；密钥扫描通过但私人路径扫描 4 处命中；`pnpm audit` 因网络超时未完成。

## 2. 门禁基线

| 项目 | 结果 |
| --- | --- |
| `pnpm test` | 37 文件，305 通过，1 跳过（paid e2e），40 s |
| `pnpm typecheck` | 失败：`tests/skill-contract.test.ts:250` 使用 `HTMLImageElement`，tsconfig lib 无 DOM |
| `pnpm build` | 通过，`dist/cli.mjs` 393 KB |
| `scan:secrets --private-path $HOME --path docs --path output` | 4 处私人绝对路径：`docs/REUSE_MAP.md`、`reference/legacy/README.md`、`reference/legacy/product-notes/…`、`output/pdf/…continuous.pdf`（17 处 file:// 链接注释） |
| `pnpm audit` | 未完成（registry 超时） |
| 提交节奏 | 62 个 commit 全部在 2026-08-30/31 两天内 |

## 3. P0：交付前必须修

### P0-1 透明 PNG 服装图被压成黑底 JPEG，全链路无告警（复现）
`src/prepare/images.ts:112-121`。编码管线无 `.flatten()`，libvips 转 JPEG 直接丢弃 alpha，透明像素变 `0,0,0`。本机复现：透明底、中心 `230,220,210` 的 PNG 输出后四角像素为 `0,0,0`。抠图 PNG 是电商平铺图最常见形态，黑底会污染 `locateGarment` 定位、`brief` 颜色读取、prompt 的"颜色以图1为准"，每张都付费出错，preflight 页人眼是唯一防线。
修法：`.rotate()` 后加 `.flatten({ background: '#ffffff' })`，有 alpha 时写入 `PreparedAsset.warnings`。

### P0-2 角色目录在顶层时全部款号塌缩为"未分组"，按全局下标跨款配对（源码确认）
`src/preflight/classifier.ts:60-80`、`src/preflight/preflight.ts:92`。`服装/款A/01.jpg` + `模特/款A/01.jpg` 这种"先分角色再分款"布局下 `roleIndex === 0`，`groupKey` 被写成常量 `'未分组'`，所有款进同一 group，`roleSource: 'directory'` 且置信度 1，不产生任何问题；`pair` 模式按排序下标配对，任一款图片数不齐即跨款错配，digest、预览、上限全部正常，付费生成一批错图。
修法：`roleIndex === 0` 时用 `directories[roleIndex + 1]` 作款号，或抛 `NEEDS_INPUT` 要求改用双目录输入；禁止静默 `ready`。

### P0-3 macOS AppleDouble `._*.jpg` 被当作合法素材，plan 整体崩溃（源码确认）
`src/preflight/scanner.ts:119-133`。扫描器只看扩展名与大小，`._look.jpg` 约 4 KB 非零、扩展名合法，直接进入 `files`。后果：服装数翻倍、配对下标错位、无角色线索时每个伴生文件触发一次付费 `classify`、`plan` 阶段 `sharp().metadata()` 抛 `IO_ERROR` 且无逐资产降级。U 盘 / SMB / zip 交换素材是本项目的既定场景。
修法：跳过 `._` 前缀、`.DS_Store`、`Thumbs.db`，并对文件头做 magic-number 校验。

### P0-4 dotenv 只从 `process.cwd()` 读取，同事安装流程第一条真实调用即 CONFIG_ERROR（源码确认）
`src/cli.ts:918-919`。`path.resolve('.env.local')` 以当前工作目录为基准。README 写"仓库根目录"，同事文档让在包根建 `.env.local` 后 `pnpm link --global`，但 Skill 从任意 cwd 调 CLI，`plan` 的 `locateGarment` 会报 `DASHSCOPE_API_KEY` 缺失。附带安全面：`z.url()` 不限制 scheme/host，第三方仓库里的 `.env` 可把 `APIMART_BASE_URL` 改成 `http://` 外部地址，真实 key 与用户图片明文外发（`src/config.ts:60-61`）。
修法：同时从 dist 所在包根加载 `.env.local`；base URL 强制 `https:`，非默认 host 需显式开关。

## 4. P1：按主题

### 4.1 付费与重复计费

- **P1-1 提交阶段 HTTP 5xx/429 会重传两图并重新提交**（源码确认）。`src/providers/apimart.ts:75-84` 只对无响应的网络错误标 `PROVIDER_SUBMISSION_UNKNOWN`；有响应的 502/503/429 走通用分支 `retryable: true`，`src/run/runner.ts:518` 重跑整个 `generate()`。网关在上游已受理后返回 502 即产生多个计费任务。修法：submit 阶段一律 `retryable: false`。
- **P1-2 无 run 级跨进程锁**（源码确认）。`src/run/` 与 `src/cli.ts` 无任何 lock 文件，只有 finalize 有。两个 `resume` 并发即对同一 task 双提交，有效并发突破 2，`state.json` 互相覆盖。修法：`openRunStore` 时 `open(runDir/.run.lock, 'wx')` 排他。
- **P1-3 prompt 修订失败后 `resume` 用首轮 prompt 静默生图，feedback 丢失**（源码确认）。`src/review/retry.ts:417-436` 把任务置 `generation_failed` + 可重试 error 且已删 `pendingPrompt`；`src/run/runner.ts:103-110` 判为 runnable，`runner.ts:561` 回退 `prepared.prompt`。用户以为是重出结果。修法：catch 分支置 `interrupted` 或 `retryable: false`，`runner.ts:561` 前断言 `pendingRegeneration` 存在时必须有 `pendingPrompt`。
- **P1-4 同一份 `review-selection.json` 可重复 apply，触发重复付费 regenerate**（子评审）。`src/review/decisions.ts:218-273` 幂等写回 `pendingRegeneration`，CLI 无"已消费"记录。配合 **无撤销决定**（只有 accept/exclude/再 regenerate 能清 pending）与 **`review` 命令不重写 report.html**（`src/cli.ts:681-695` 未调 `writeReport`），误点后只能接受失败版本或不交付。修法：apply 后落盘 selection sha256 并拒绝重复；新增 `clear` 决定；review 后刷新报告。
- **P1-5 运行期不核算实际生成调用数**（子评审）。`maximumGenerationCalls` 仅展示，`generation_failed && retryable` 每次 resume 重新获得 `1 + transportRetries` 次尝试，累计可任意超过授权上限（`src/run/runner.ts:97-109`）。修法：state 维护 `generationCallsUsed`，超限抛 `NEEDS_APPROVAL`。
- **P1-6 preflight 视觉分类调用无上限、不计成本、发生在任何授权之前，且上传 64 MB 上限的原图含 EXIF/GPS**（子评审）。`src/preflight/classifier.ts:157-176`、`src/providers/dashscope.ts:32-33`。修法：分类前降采样、加调用数上限并纳入返回值与预览成本区。
- **P1-7 retry 无条件删除 `pendingProviderRequestId`**（子评审）。`src/review/retry.ts:285`。prompt 未变的 redo 也会对仍在跑的付费任务重新提交。修法：仅 prompt hash 变化时删 checkpoint。

### 4.2 恢复与一致性

- **P1-8 孤儿版本仅按文件名收编，可把旧图冒充成"重新生成"结果**（子评审）。`src/run/runner.ts:334-368`、`src/run/store.ts:342-392`。attempt 落盘后崩溃，随后 regenerate + retry 会把旧字节标上新 prompt 与新血统，生图调用 0 次。修法：attempt 前写 `{attempt, promptSha256}` marker，不匹配则隔离到 `images/orphan/`。
- **P1-9 state 侧完整性守卫是死代码**（源码确认）。`src/run/runner.ts:179-199` 先重建 `state.tasks` 再检查差集，`continue` 永远命中；manifest 被替换后已付费任务状态被静默抹掉。
- **P1-10 `events.jsonl` 半行截断后 report/resume/retry 全部永久失败**（两份子评审一致）。`src/run/store.ts:288-299` 写入非原子，`src/report/render.ts:264-285` 任何坏行抛 `INTEGRITY_ERROR`，而读取结果只用于 `eventCount`。修法：流式计数，末行截断降级为警告。
- **P1-11 state 与 review 清理顺序留下僵尸 `pendingRegeneration`**（子评审）。`src/run/runner.ts:500-511` 两次独立原子写之间断电，finalize 永远被 blocker 挡住。
- **P1-12 review-session 前台阻塞且无空闲超时**（主审）。`src/review/session.ts` 无 timeout；`workflow.md` 明说"stays in the foreground"。Agent 宿主的 Bash 工具默认 2 分钟、上限 10 分钟超时，超时即杀进程，用户浏览器里的审核页保存失败。另外 `server.listen(0)` 随机端口使 localStorage 草稿按 origin 隔离，第二次会话草稿全部消失（`src/report/template.ts:752-755`）。修法：Skill 指示后台启动并轮询 `selectionPath`；端口写入 run 目录复用；文案说明草稿仅本会话有效。

### 4.3 输入与图像质量

- **P1-13 `classify` 返回的 bbox 在未旋转坐标系，裁切却按 EXIF 旋转后尺寸计算**（源码确认）。`src/preflight/classifier.ts:195` 透传 bbox，`src/preflight/garment-framing.ts:38-42` 有 bbox 即跳过 `locateGarment`，`src/prepare/images.ts:198-215` 用 `autoOrient` 尺寸。手机竖拍图裁出错误区域且 `cropped: true`。修法：classify 不透传 bbox，统一由 `locateGarment` 在已旋转副本上定位。
- **P1-14 bbox 无最小面积与整幅拒绝**（两份子评审一致）。`src/contracts.ts:183-190`、`src/prepare/images.ts:65-86`。`[500,500,505,505]` 产出 45 px 裁图，`[0,0,1000,1000]` 等于全图回退但预览显示"可信裁切"，绕过"不存在服装全图回退"不变量。修法：面积下限与上限断言。
- **P1-15 ICC 配置被剥离且不转 sRGB**（子评审，本机验证 P3 输入输出 `icc: false`）。`src/prepare/images.ts:112-121`。iPhone 直出 P3 图颜色系统性偏移，与"颜色以图1为准"直接冲突。修法：`.toColourspace('srgb').withIccProfile('srgb')`。
- **P1-16 降质阶梯顺序反，分辨率档位是死代码**（子评审）。`src/prepare/images.ts:95-131` 外层边长内层质量，1600 px 会压到 q30 才降边长；细条纹/提花糊成色块，AI 审核规则又要求纹理差异判 pass。修法：对调循环并给质量下限 60。
- **P1-17 `fixedModel`/`fixedClothing` 静默丢弃另一侧多余素材**（子评审）。`src/preflight/preflight.ts:93-97,153-171`，无 warning code，且数量不等时推荐值必然是丢素材的一侧。修法：新增 `unused_asset` warning。
- **P1-18 被忽略目录不记 `skipped`**（主审 + 子评审）。`src/preflight/scanner.ts:18,94-101`。用户款号下自带的 `成图` 参考图子树整棵静默消失，成图 现在是全局保留名。修法：写 `reserved_directory` skipped 并在预览页提示。
- **P1-19 排序 `localeCompare` 非全序，`relativePath` 未 NFC 归一化**（子评审）。`src/preflight/scanner.ts:50-52,88,151`、`src/run/store.ts:213-227`。NFC/NFD、零宽字符比较返回 0，配对下标与 digest 跨机器漂移；run 从 macOS 拷到 Linux 报 `INPUT_CHANGED`。修法：NFC 后码位比较。

### 4.4 授权与 digest 绑定

- **P1-20 digest 不含 prompt 模板与真实 CLI 版本**（子评审）。`src/preflight/generation-plan.ts:25-64`，`cliVersion` 硬编码 `'0.1.0'`。升级 CLI 后旧 digest 仍通过，用户从未预览过的新 prompt 付费生成。修法：`promptTemplateVersion` + package.json 版本进 digest。
- **P1-21 `preparedHash` 依赖 sharp/libvips 版本**（子评审）。`^0.34.0` 未锁定，升级后同一输入 digest 变化，无法区分"环境变了"与"输入变了"。修法：pin 精确版本，`sharp.versions.vips` 进 PlanFacts。

### 4.5 网络与资源

- **P1-22 轮询超时只累加 sleep，所有 fetch 无单次超时**（子评审）。`src/providers/apimart.ts:174-183`；全仓无 `AbortSignal.timeout`。网关半死时一个任务可占用信号量槽位数小时。修法：墙钟 deadline + 每请求 `AbortSignal.any([signal, timeout])`。
- **P1-23 DashScope vision 调用零重试**（子评审）。`src/providers/dashscope.ts:269-327`。50 件服装第 41 件 429 即整条 plan 失败，前 40 次付费定位作废。修法：adapter 内退避重试或 bbox 断点落盘。
- **P1-24 响应体无大小上限，下载字节不做图像校验**（子评审）。`src/providers/apimart.ts:222,108-116`。异常大响应 OOM；带 `image/png` 头的错误页可成为版本、被采用、进入成图。修法：Content-Length 上限、流式落盘、`sharp().metadata()` 校验。
- **P1-25 report 无并发上限地哈希全部版本，EMFILE 被折叠成"版本损坏"**（子评审）。`src/report/render.ts:303,347-354`。200 任务在 macOS 默认 fd 上限下出现几十条假 blocker。修法：信号量 + 按 `error.code` 分流。

### 4.6 交付、安装与隐私

- **P1-26 成图发布无 spec，双目录模式写入用户未授权的父目录，dry-run 不报位置，只读盘劫持内部交付**（主审）。`docs/specs` 无一处定义成图；`src/delivery/finalize.ts:365-372` 双目录时 `dirname(garmentRoot)/成图`；`planDelivery` 不返回 `materialOutputDir`，不预检可写；`finalizeRun` 中材料发布失败会回滚整个 delivery。修法：补 spec；dry-run 返回并预检 `materialOutputDir`；素材侧发布失败降级为警告而非阻断内部 delivery。
- **P1-27 私人绝对路径进入对外交付物**（主审，扫描器命中）。`docs/REUSE_MAP.md` 含 4 处 本机绝对路径，`create-colleague-package.mjs` 整目录复制 `docs/`；`output/pdf/…continuous.pdf` 含 17 处 `file://<本机绝对路径>` 链接注释，且 `output/` 未被 `.gitignore` 覆盖（14 MB）。同事包脚本未调用 `scan:secrets --private-path` 自检。
- **P1-28 `--output-root` 指向仓库内目录时 run 不受 `.gitignore` 保护**（子评审）。`.gitignore` 只忽略 `runs/` 与 `*-tryon-output/`，与 SECURITY.md"run 目录必须保持 Git 忽略"承诺不符。

## 5. P2（择要）

- `src/review/decisions.ts:106-113` vs `retry.ts:140-173`：v4 丢失 v1/v2 的"陈旧候选"校验，可对两轮前的版本反复重出。
- `src/review/local-drift.ts:98,246,255`：`fit: 'fill'` 拉伸让画幅变化产生假身份漂移；`Math.max(0.2, …)` 死代码；两条 fallback 分支不可达且无测试。
- `src/report/template.ts:409` vs `:934`：服务端与浏览器"未检查"口径不同，同一 HTML 显示两个数字。
- `src/report/template.ts:1447,1563`：每任务注册 document 级 `fullscreenchange` 监听且不移除。
- `src/review/selection-file.ts:66-72`：selection 落盘缺 fsync，与项目自身规范不一致。
- `src/run/runner.ts:177` vs `src/cli.ts:198`：并发封顶 2 只在 CLI 层，Runner 导出 API 不设限，与架构文档矛盾。
- `src/run/store.ts:148-158,323`：版本文件名净化而版本 ID 未净化，`a.b` 与 `a_b` 多对一。
- `src/run/runner.ts:62-75`：非 RunnerError 一律 IO_ERROR 不可重试，sharp 临时失败永久卡死任务。
- `src/run/runner.ts:619-623`：任务 reject 时终态与 `run_interrupted` 事件不写，`state.status` 永久 `running`。
- `src/prepare/images.ts:205-237`：历史 v2 无 plan 路径仍存在服装全图回退；plan 路径的 `crop_fallback` 与预览"使用全图回退"文案是死代码。
- `src/prepare/prompt.ts:40-78`：模型自产 `item`/`uncertainty` 未做与 feedback 同等的 JSON 隔离，可破坏 `【…】` 分节。
- `src/prepare/brief.ts:17-21`：brief 缓存按源 contentHash 而非 preparedHash，与 framing 去重隐式耦合。
- `src/providers/dashscope.ts:177-209`：`suggestedPrompt` 必填但从未使用；pass 结果省略 `fix` 报"retry 需要 fix"。
- `src/providers/http-errors.ts:52-75`：未知抛出一律判可重试网络超时，URL 配置错误被伪装成瞬时故障。
- `src/providers/apimart.ts:98-106,209`：结果 URL 无 host 限制，可被引导访问 `127.0.0.1:9222` 等本机端口。
- `src/preflight/preflight.ts:114-124,320-334`：preflight 自带的 `writeJsonAtomic` 失败不清临时文件，manifest 校验失败留下空 run 目录。
- `src/preflight/generation-plan.ts:118-139`：风险账本逐条重复文案，`.DS_Store` 50 个即 50 条，淹没真实风险。
- `src/preflight/preview.ts:99-102`：一次 `plan` 全量读盘哈希素材 2-3 遍，`encodeWorkingCopy` 最坏 132 次解码同一图。
- `src/review/session.ts:218`：`server.close()` 不断开 keep-alive，`done` 需等浏览器空闲连接超时；可用 `closeAllConnections()`。
- 成图侧：同服装多模特文件名仅靠 `-2/-3` 区分；回滚不删空款号目录；双目录模式与写失败回滚无测试。
- `retry --task` 仍是 CLI 公开口子，架构文档只在 Skill 层禁止。
- `docs/REUSE_MAP.md` 与 `reference/legacy/`（93 个 tracked 文件，含 348 KB 无关 HTML）作为证据保留，但会随包外发。

## 6. 测试盲区（高风险且完全无断言）

- 顶层角色目录布局；`._*` 伴生文件；透明 PNG、CMYK、EXIF 5-8。
- submit 阶段返回 5xx；轮询墙钟超时（现有测试用 fake timer 立即 resolve 恰好绕过）。
- revision 失败后再 `resume`；同一 selection 重复 apply；孤儿收编时 prompt 已变。
- `runner.ts:185-199` 守卫；`store.ts:353-368` 两条 orphan 完整性分支；`semaphore.ts` 无独立测试。
- `asset_group`/`skip_group` 全链路；group 级 scope/pairing override 三条校验。
- `--output-root` 在仓库内；dotenv 加载顺序与 cwd 依赖。
- 报告规模 > 40 任务（fd、DOM、监听器）；跨 review-session 草稿恢复。
- 双目录模式成图根目录；成图写失败回滚。

## 7. 做得扎实的部分

- JSON 原子写为教科书式 temp(0600,wx) → write → fsync → rename → dir fsync，落盘前 zod 重解析；版本文件用 `link()` 把"不覆盖"下沉到文件系统 EEXIST 语义。
- APIMART checkpoint 语义正确：task ID 一解析即落盘，有 checkpoint 的恢复跳过上传与提交，端到端测试覆盖。
- 密钥外泄面：三层脱敏、`toJSON` 不带 cause、缺配置只报变量名；逐点检查未发现泄漏路径。
- HTML/JS 注入面：report 与 preflight 全部插值经 `escapeHtml`，无 `data:` 内嵌，无 JSON 逃逸面，preflight 页零脚本。
- 人工 feedback 隔离：归一后 `JSON.stringify` 为显式不可信数据块并加角色边界，是模范做法。
- review-session：127.0.0.1 + 随机 token + realpath containment + 同源 + CSP + 1 MiB 上限，三类拒绝均有测试。
- 决定应用真原子：全部校验完成后一次 `saveReviewAtomic`，任何一条 stale 整体不落盘。
- digest 重算防篡改且失败关闭；`applyAnswers` 首先删除旧 plan。
- 符号链接不跟随、不逃逸 root；ID 派生用 `\0` 分隔 + NFC + SHA-256，不依赖数组下标。
- Semaphore 移交语义正确，未发现抛出路径下的泄漏。
- 输出 JSON 契约、退出码、诊断到 stderr 的约定一致，Agent 可稳定解析。

## 8. 治理观察

- 62 个 commit 集中在两天，12k 行源码 + 大量测试同期产出。测试数量多但盲区集中在"真实素材形态"与"付费路径的失败分支"，说明测试多为受控合成输入下的形状验证。
- 成图发布约 940 行未提交改动没有 spec 与 plan，违反项目自身 AGENTS.md"以 docs/specs 为事实来源"的纪律。
- ARCHITECTURE.md 有 5 处承诺与代码不符：Runner 并发封顶、"不存在服装全图回退"、"定位临时副本必定清理"、"transport 错误按秒级退避"、localStorage 草稿层。
- PROJECT.md 记录"PDF 已导出并验收"，但该 PDF 含 17 处本机路径。

## 9. 建议修复顺序

1. **第一批（阻断同事真实测试）**：P0-1 至 P0-4，P1-27（私人路径），typecheck 修复，`.gitignore` 加 `output/`。
2. **第二批（付费边界）**：P1-1、P1-2、P1-3、P1-4、P1-5、P1-7。
3. **第三批（输入质量）**：P1-13 至 P1-19。
4. **第四批（恢复与授权）**：P1-8 至 P1-12、P1-20 至 P1-25。
5. **成图发布**：先补 spec 确认双目录根目录语义与失败降级策略，再提交现有改动。

## 10. 未验证项

- `pnpm audit` 未完成，依赖漏洞状态未知。
- 子评审标记的 P2 未逐条复核。
- 未执行真实 provider 调用，未在真实素材上验证 P0-2 与 P0-3 的端到端后果。

## 11. 修复状态（2026-09-04 更新）

修复提交：`c95c1a3`（阶段 A）、`af90c2c`（阶段 B）。修复后门禁：typecheck 通过；测试 38 文件 387 通过 / 1 跳过；build 通过；密钥与私人路径扫描通过。

| 编号 | 状态 | 说明 |
| --- | --- | --- |
| P0-1 至 P0-4 | 已修 | flatten 白底 + sRGB；顶层角色目录取下一级为款号；系统伴生文件与文件头校验；dotenv 包根加载 + https/主机白名单 |
| P1-1、P1-22、P1-23、P1-24 | 已修 | submit 永不重试；墙钟轮询与每请求超时；DashScope 退避重试；响应体上限与图像校验 |
| P1-2、P1-5、P1-7、P1-8、P1-9、P1-10、P1-11 | 已修 | run 锁；调用数核算；checkpoint 保留；attempt marker 与孤儿隔离；守卫修复；events 单次写与末行容错；清理顺序与对账 |
| P1-3 | 已修 | revision 失败置不可重试 generation_failed 并保留 pending；runner 拒绝无 pendingPrompt 的回退 |
| P1-4 | 已修 | appliedSelectionDigests 拒绝重复 apply；新增 clear 决定；review 后重写报告 |
| P1-6 | 已修 | 分类走降采样副本；上限 40 次；visionCalls 返回并显示 |
| P1-12 | 已修 | 45 分钟空闲关闭；端口写入 run 目录复用；Skill 改为后台运行 |
| P1-13 至 P1-19 | 已修 | classify 不透传 bbox；bbox 面积上下限；ICC/sRGB；降质阶梯对调；unused_asset；reserved_directory；NFC + 码位排序 |
| P1-20、P1-21 | 已修 | 真实 CLI 版本与提示词模板版本进 digest；sharp 锁定 0.34.5（libvips 版本未进 PlanFacts） |
| P1-25 | 已修 | 报告哈希 8 路并发闸门；非 ENOENT 抛 IO_ERROR |
| P1-26 | 已修 | v6 spec；dry-run 返回 materialOutputDir 与可写性；素材侧失败降级为 materialPublishError |
| P1-27、P1-28 | 已修 | REUSE_MAP 与 legacy 笔记去私人路径；同事包自检；PDF 导出去链接；output/ 忽略；仓库内 run 目录告警 |
| 第 5 节 P2 | 大部分已修 | 未做：成图侧 sidecar 与多模特文件名区分（v6 spec 明确 out of scope）；retry --task 口子保留；brief 契约版本仍为手工字符串；reference/legacy 仍随仓库保留 |
| 第 6 节测试盲区 | 已覆盖 | 各修复项均附 focused test，见对应测试文件 |
