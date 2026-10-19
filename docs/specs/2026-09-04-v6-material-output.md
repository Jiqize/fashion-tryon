# v6：素材侧成图发布

日期：2026-09-04。局部覆盖 v3 delivery 规范；未被本文修改的 v3 行为继续有效。

## 背景与目标

v3 的 delivery 只落在 `<run>/deliveries/`，使用者需要自己把采用图复制回素材目录。v6 让同一次成功 `finalize` 把人工采用版本发布到素材侧保留树 `成图/<款号>/`，使用者在素材目录旁直接拿到业务成图，内部 delivery 继续作为审计与恢复事实。

## 关键行为

1. 发布只在 `finalize` 成功路径发生，只包含 persisted human decision 明确 accepted 的版本；excluded、候选、历史、未采用的重出结果都不发布。
2. 素材根目录：
   - 单目录输入：`manifest.input.root`。
   - 双目录输入：`dirname(manifest.input.garmentRoot)`，即服装目录与模特目录的共同上级。`finalize --dry-run` 必须先返回该目录，Agent 在执行前向用户展示。
3. 目标路径 `<素材根>/成图/<款号>/<服装源文件名>.<生成扩展名>`。款号取服装 `relativePath` 的目录层级并移除角色目录；没有目录层级时为 `未分组`。
4. 同名同 hash 复用已有文件；同名不同内容按 `-2`、`-3` 稳定追加；永不覆盖或删除任何已有文件。
5. `成图` 是保留输出树：扫描器全局忽略，并把忽略记录写入 `skipped`，在预览页作为提示出现。
6. `finalize --dry-run` 返回 `materialOutputDir` 与 `materialOutputWritable`；不可写只产生 `warnings`，不是 blocker。
7. 素材侧发布失败（目录只读、磁盘满、权限）不阻断 run 内 delivery：已创建的半成品文件回滚，delivery 照常发布，结果中携带 `materialPublishError`，`materialFiles` 为空。hash 复核失败仍是 `INTEGRITY_ERROR` 并回滚整个 finalize。
8. `finalize` 成功返回 `materialOutputDir`、`materialSkuDirs`、`materialFiles`；Agent 只转述这些字段，不自行复制或猜路径。

## Out of Scope

- 成图侧的来源 sidecar（记录 run/version/model）。
- 同一服装配多模特时在文件名中区分模特。
- 删除或整理历史成图。

## 验收标准

1. 单目录与双目录两种输入各有测试证明素材根目录与款号推导。
2. 只读素材根目录下 finalize 仍创建 delivery，返回 `materialPublishError`，成图目录无残留文件。
3. dry-run 结果含 `materialOutputDir` 与 `materialOutputWritable`。
4. 同名同 hash 复用、同名不同内容加后缀、不覆盖三条各有测试。
5. 扫描器忽略 `成图` 并写入 `skipped`。
