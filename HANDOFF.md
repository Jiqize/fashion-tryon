# Fashion Try-on Runner 接手说明

**日期：** 2026-09-25
**状态：** Tryon Studio（本地看板）已实现，plan 的 10 个任务与验收后修正全部完成；真实服务商冒烟尚未运行。

## 先读什么

1. [`PROJECT.md`](PROJECT.md)：当前阶段与下一步。
2. [`docs/specs/2026-09-25-tryon-studio.md`](docs/specs/2026-09-25-tryon-studio.md)：唯一事实来源（行为与验收标准）。
3. [`docs/plans/2026-09-25-tryon-studio.md`](docs/plans/2026-09-25-tryon-studio.md)：任务拆分、进展备注与后续修正。
4. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)、[`docs/INPUT_OUTPUT.md`](docs/INPUT_OUTPUT.md)、[`docs/SECURITY.md`](docs/SECURITY.md)。
5. [`docs/USAGE.md`](docs/USAGE.md)：面向使用者的完整流程与快捷键。

v1–v6 的 spec/plan 与 `docs/reviews/` 只作历史参考，描述的旧命令流水线已删除。

## 现状一句话

`fashion-tryon studio <素材根目录>` 启动本机看板（127.0.0.1），用户在素材表确认一次“开始”，之后边生成边按套判断（`Enter` 通过、`R` 重出、`X` 不交付），判完的套自动发布到 `<素材根目录>/成图/<款号>/`。唯一运行记录是批次目录 `<素材根目录名>-tryon-studio/studio.json`。CLI 只有 `studio` 与 `status`。

## 命令

```bash
pnpm install
pnpm build                       # 产出 dist/cli.mjs
pnpm test                        # 全部使用 fake provider，不产生费用
pnpm typecheck
pnpm scan:secrets                # 检查已跟踪文件不含本机密钥与私人路径
pnpm package:colleague <新目录>  # 生成给同事的未压缩安装包（仓库外）
```

真实服务商冒烟：`FASHION_TRYON_PAID_E2E=1 PAID_E2E_SOURCE_ROOT=<素材根目录> pnpm test:paid`（2 套 × 3 张，会产生真实费用，必须用户明确要求才运行）。

## 已知事项

- 真实冒烟未运行；服务商并发上限（默认 5、上限 10）待冒烟时核对。
- “固定模特”模式下一组多件服装仍按组目录名作为款号交付（spec 待决事项）。
- 同事安装与真实测试说明见 [`docs/COLLEAGUE_INSTALL_AND_REAL_TEST.md`](docs/COLLEAGUE_INSTALL_AND_REAL_TEST.md)，反馈模板见 [`docs/COLLEAGUE_TEST_FEEDBACK_TEMPLATE.md`](docs/COLLEAGUE_TEST_FEEDBACK_TEMPLATE.md)。
- 密钥只在 `.env.local` / `local-secrets/`（Git 忽略），不得读取打印。
