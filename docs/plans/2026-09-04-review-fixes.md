# 评审修复计划（2026-09-04）

Spec：`docs/reviews/2026-09-04-deep-review.md`。编号（P0-x / P1-x / P2）均指该文档。目标：修完全部 P0、P1，以及第 5 节列出的 P2；每批一个 commit。

## 阶段 0：基线（主审）

- [x] 提交当前未提交的成图发布工作 + typecheck 修复 + `.gitignore` 加 `output/`
- [x] 补 `docs/specs/2026-09-04-v6-material-output.md`（成图发布 spec，含双目录根目录语义与失败降级）
- [x] P1-27 私人路径：`docs/REUSE_MAP.md` 去绝对路径；同事包脚本内置 `scan-secrets --private-path` 自检；PDF 重新导出时去 file:// 链接

## 阶段 A（并行，文件互斥）

### A1 图像准备：`src/prepare/*`
- [x] P0-1 透明 PNG flatten 白底 + warning
- [x] P1-14 bbox 面积下限/上限断言（`computeCropBox`）
- [x] P1-15 sRGB 转换 + ICC
- [x] P1-16 降质阶梯对调 + 质量下限 60 + warning
- [x] P2 解码一次再循环编码；`limitInputPixels`
- [x] P2 历史无 plan 路径的服装全图回退按 role 拒绝
- [x] P2 prompt 中模型自产文本隔离；brief 缓存键改 preparedHash；契约版本取指令 hash

### A2 预检与计划：`src/preflight/*`、`src/contracts.ts`（本阶段独占）
- [x] P0-2 顶层角色目录 → 用下一级作款号；无法判定则 NEEDS_INPUT
- [x] P0-3 跳过 `._*`、`.DS_Store`、`Thumbs.db`、`desktop.ini`；magic-number 校验
- [x] P1-13 classify 不透传 bbox，定位统一走 locateGarment
- [x] P1-6 classify 走降采样副本 + 调用数上限 + 返回 `visionCalls`
- [x] P1-17 `unused_asset` warning；pairing reason 写明丢弃数量
- [x] P1-18 忽略目录写 `reserved_directory` skipped + warning
- [x] P1-19 NFC 归一化 + 码位比较排序
- [x] P1-20 `promptTemplateVersion` + 真实 cliVersion 进 digest
- [x] P2 preflight `writeJsonAtomic` 复用 store；manifest 失败清 run 目录；风险账本聚合；死代码 `crop_fallback`/`safeAssetWarnings` 清理；硬编码枚举；`.framing-*` 残留清理；dedupeStem trim

### A3 provider 与配置：`src/providers/*`、`src/config.ts`
- [x] P1-1 submit 阶段一律不可重试
- [x] P1-22 轮询墙钟 deadline + 每请求超时
- [x] P1-23 DashScope 可重试错误退避重试
- [x] P1-24 Content-Length 上限 + 流式落盘 + sharp 校验
- [x] P0-4（config 部分）base URL 强制 https，非默认 host 需 `ALLOW_CUSTOM_PROVIDER_HOST`
- [x] P2 结果 URL host 限制；`suggestedPrompt` 可选、`fix` 报错拆分；未知抛出不再判可重试；`preparedHash` 相关：pin sharp

### A4 主审
- [x] P0-4（cli 部分）dotenv 额外从包根加载
- [x] P1-26 finalize dry-run 返回并预检 `materialOutputDir`；素材侧失败降级为 warning
- [x] P1-28 `.gitignore` 与 preflight 对仓库内 output-root 的警告

## 阶段 B（并行，文件互斥）

### B1 运行状态机：`src/run/*`、`src/review/retry.ts`、`src/contracts.ts`（本阶段独占）
- [x] P1-2 run 级排他锁
- [x] P1-3 revision 失败置 interrupted；runner 断言 pendingRegeneration 必有 pendingPrompt
- [x] P1-5 `generationCallsUsed` 核算并超限 NEEDS_APPROVAL
- [x] P1-7 仅 prompt 变化时删 checkpoint
- [x] P1-8 attempt marker + 孤儿隔离
- [x] P1-9 修复死守卫
- [x] P1-10 events 末行截断容错 + 单次 write
- [x] P1-11 review 先清 pending 再落 state；execute 开头对账
- [x] P2 Runner 层并发封顶；版本 ID 净化一致性校验；safeError 保留 cause code 并判可重试；终态写入 finally；rm catch；tmp 残留清理；recover 透传 providerRequestId

### B2 审核与报告：`src/review/{decisions,session,selection-file,local-drift,manual-selection}.ts`、`src/report/*`
- [x] P1-4 apply 记录 selection sha256 拒绝重复；新增 `clear` 决定
- [x] P1-12 session 空闲超时 + 端口复用 + 草稿文案
- [x] P1-25 report 哈希并发闸门 + 错误分流
- [x] P2 陈旧候选校验；local-drift contain/权重/阈值；未检查口径统一；fullscreen 监听一次；selection fsync；删除 `selectedImage`/`reviewable` 死字段；v3 accept 清 pending；session `closeAllConnections`

### B3 主审
- [x] cli.ts：review 后 `writeReport`；agents 汇报的其余 cli 改动
- [x] Skill/workflow：review-session 后台运行指引
- [x] ARCHITECTURE/SECURITY/INPUT_OUTPUT 与代码对齐；HANDOFF/PROJECT 更新

## 阶段 C：收尾
- [x] 全量 typecheck / test / build / scan:secrets
- [x] 评审文档标注各条修复状态

## Progress

- 2026-09-04：阶段 0 与阶段 A 完成。A2 子代理因额度中断后由主审接手收尾（input-source 排序、cli visionCalls、fixture 真图字节）。PDF 导出脚本已写，导出待阶段 C 执行（内存不足被中止）。契约版本取指令 hash 未做（指令在 dashscope.ts），沿用 'v3'；pin sharp 待阶段 C 一并处理。
- 2026-09-04：阶段 B 完成。revision 失败改为不可重试 generation_failed（而非 interrupted，因 interrupted 可被 resume）；session 关闭用 closeIdleConnections + 下一 tick closeAllConnections；render.ts 自带流式 events 计数，未切换到 store 的 readEvents（两者都容忍末行截断）。
- 2026-09-04：阶段 C 完成。全量门禁：typecheck 通过、38 文件 387 通过 / 1 跳过、build 通过、密钥与私人路径扫描通过。评审文档第 11 节记录各条状态；HANDOFF/PROJECT 已更新。
- 2026-09-04：使用指南 PDF 经 scripts/export-usage-guide-pdf.mjs 重新导出：去链接注释、Heiti SC 作 CID 字体、导出时替换棋盘格渐变背景；单页 930×9139 pt、2.1 MB、无私人路径、文本可提取。
