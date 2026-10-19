# Legacy Reuse Map

`reference/legacy/` 是 2026-08-30 的只读快照。它用来保留已验证逻辑与测试证据，不是新项目依赖，也不代表旧架构继续有效。

## dsh-gen-core

原路径：本机 `DSH-改装/packages/dsh-gen-core`（私有工作区，未随仓库分发）

| 参考文件 | 可复用内容 | 不要照搬 |
|---|---|---|
| `src/apimart.ts` | 异步生图请求、轮询、错误解释、返回解析 | Cordis 配置取得方式 |
| `src/batch.ts` | 共享并发、任务隔离、版本写盘和 retry 思路 | UI/Agent source 标签与 DSH store 形状 |
| `src/tool-runner.ts` | 目录展开、同步/后台任务结果合同 | DSH jobs service |
| `src/crop-geometry.ts`、`crop-image.ts` | bbox、余量、sharp 裁切和压缩 | DSH 输出目录注册 |
| `src/store.ts` | 原子持久化与历史恢复测试意图 | 旧浏览器画廊兼容迁移 |
| 对应 tests | provider、并发、裁切、恢复的边界案例 | 只验证旧内部字段的测试 |

## dsh-tryon

原路径：本机 `DSH-改装/packages/dsh-tryon`（私有工作区，未随仓库分发）

| 参考文件 | 可复用内容 | 不要照搬 |
|---|---|---|
| `src/pairing.ts` | pair/fixedModel/fixedClothing 的确定性配对 | UI 预览状态 |
| `src/vision.ts` | garment brief、六段式 prompt、full/single 和四维质检合同 | 把分析模型绑定到 DSH 会话 |
| `src/tool-vision.ts` | 视觉工具输入输出 schema 与错误案例 | `@deepseek-ai/dsh-tools` 注册 |
| `src/tool-crop.ts` | 多图裁切输入合同、逐项失败隔离 | Agent bbox 必须人工提供的限制 |
| `src/tool.ts` | 目录参数、任务数、输出合同 | DSH job owner 与 render block |
| 对应 tests | prompt 结构、模式、配对和工具边界 | client-state 测试 |

## dsh-maid

原路径：本机 `DSH-改装/packages/dsh-maid`（私有工作区，未随仓库分发）

| 参考文件 | 可复用内容 | 明确拒绝 |
|---|---|---|
| `src/classify.ts` | 角色词表、款级目录算法、0.70 低置信门槛、重名去重 | 浏览器上传后再落临时目录 |
| `src/compress.ts`、`crop-step.ts` | 入模压缩和裁切失败回退 | 代理请求专用 shape |
| `src/prompts.ts` | 分类、brief、质检结构化 prompt | 与 `dsh-tryon/vision.ts` 维护两份文本 |
| `src/brief-cache.ts` | 内容指纹缓存 | DSH dataDir 布局 |
| `src/proxy.ts` | 固定流水线阶段和错误隔离经验 | iframe 兼容代理、异步回写面板相册 |
| `src/settings.ts` | maxRetries 0–3 校验 | manual/agent 双模式 |
| 对应 tests | 分类、缓存、prompt、semaphore、代理错误案例 | ball、panel、routes、multipart 等 UI 宿主测试 |

## 单 HTML 与产品文档

原路径：本机 `BOOMBANANA-华子版/挽回挽回她`（私有工作区，未随仓库分发）

- `BOOM-NOIR-MAID-挽回她终极版.html`：只用于核对已经跑通的 scope、裁图、prompt、质检、日志和浏览器兼容行为。
- `2026-08-29-千问智能升级复盘.md`：真实调用结论与已知模型可用性。
- `AI换装提示词方案复盘.md`：prompt 与质检口径的详细来源。
- `AI试衣_服装前期处理工作流.md`：素材准备和裁图业务背景。
- 两份旧 dsh-maid spec：解释旧方案为什么出现，仅作历史，不是新 v1 事实来源。

不要从单 HTML 复制 React/Babel/Tailwind、localStorage、IndexedDB、相册或设置 UI。需要复用的行为先写成核心模块 focused test，再移植最小逻辑。

## 复用顺序

1. 先以新 spec 写测试和新 Interface。
2. 在旧快照找到对应算法或错误案例。
3. 移植到新模块并删除 DSH/浏览器依赖。
4. 运行新测试；不得以“与旧源码一样”代替行为验证。
