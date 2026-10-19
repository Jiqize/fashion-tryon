# Input and Output Contract

## 输入：素材根目录

~~~text
本次素材/                       # 一批
├── EK52227_深灰/               # 一组 = 一套；目录名按第一个 `_` 或空格拆成款号与名称
│   ├── 服装/01.jpg
│   └── 模特/01.jpg 02.jpg 03.jpg
├── EK52338 灰/
│   ├── garment/01.jpg
│   └── model/01.jpg
└── 成图/                       # 业务输出，扫描时忽略
~~~

- 一级子目录中含有角色子目录的才算一组。角色目录名（大小写不敏感）：服装侧 `服装` `衣服` `单品` `产品图` `平铺` `garment(s)` `clothes` `clothing` `product`；模特侧 `模特` `人物` `人像` `模特图` `model(s)` `person`。
- 组内不在角色子目录里的文件记为 stray，不参与任务。
- 支持 `.jpg` `.jpeg` `.png` `.webp`，按文件头魔数校验，与扩展名不符的跳过；空文件与超过 64 MiB 的文件跳过。
- `._*`、`.DS_Store`、`Thumbs.db`、`desktop.ini` 跳过；`.git`、`node_modules`、`成图`、`.tryon-*` 整棵不扫描。
- 逻辑路径统一 NFC 并按码位排序，同一批素材在不同系统上得到相同的顺序与 ID。
- 素材目录只读；整批运行前后，除 `成图/` 外的文件字节不变。

## 搭配与任务

| 模式 | 组内素材 | 任务 |
| --- | --- | --- |
| `fixedClothing`（默认） | 1 服装 + N 模特 | 第 1 张服装 × 每张模特 |
| `pair` | N 服装 + N 模特 | 按顺序一一配对 |
| `fixedModel` | N 服装 + 1 模特 | 每张服装 × 第 1 张模特 |

任一侧为空或一对一两侧张数不同，组标为素材不全（`incompleteReason`），不生成任务。任务 ID 由组目录、两张图的内容 hash 与模式派生，重扫稳定。每个任务按候选数（1–4）生成首轮版本。

## 批次目录

批次目录固定为 `<素材根目录的父目录>/<素材根目录名>-tryon-studio/`：

~~~text
studio.json           # 唯一运行记录
.run.lock             # 运行锁（pid）
.studio-session.json  # 端口与 token，重启时复用
prepared/             # 服装裁后图、模特压缩副本（JPEG，最长边 ≤1600 px，约 ≤1 MB）
images/               # 全部生成版本，不覆盖
thumbs/               # 缩略图缓存
总览.html             # 交付总览：每套一行缩略图 + 映射表
mapping.csv           # 带 BOM 的映射表：款号、服装、模特、成图
~~~

### studio.json（schemaVersion 1）

- `settings`：`mode`、`scope`、`candidates`（1–4）、`concurrency`（1–10）、`size`、`imageModel`。
- `groups[]`：`id`、`sku`、`name`、`dir`、可选单组覆盖 `mode` / `scope`、`order`、`incompleteReason`、`started`、`delivered { at, files }`、服装描述 `brief`、`basePrompt`、准备失败 `error`。
- `assets[]`：`id`、`role`、`relativePath`（相对素材根目录）、`contentHash`、`preparedRelativePath`、`preparedHash`、自动定位 `bbox`、手动裁切 `cropOverride`、`warnings`。
- `tasks[]`：`id`、`groupId`、`garmentAssetId`、`modelAssetId`、`status`（`queued` `running` `done` `failed`）、`versions[]`、`chosenVersionId`、`excluded`、`pending[]`、`error`。
- `versions[]`：`id`、`relativePath`、`sha256`、`mediaType`、`createdAt`、`prompt`、重出来源 `regen { tags, note, fromVersionId }`。
- `pending[]`：待执行作业 `jobId`、`kind`（`first` / `regen`）、`prompt`、服务商受理后的 `providerRequestId` 与 `submittedAt`。
- `generationCallsUsed`：已拿到结果的生成次数。

所有路径都是相对路径；不写绝对路径与密钥。页面视图另外隐藏 prompt 与素材根目录的上级路径。

## CLI 输出

~~~bash
fashion-tryon studio <素材根目录> --json
# 首行：{"url":"http://127.0.0.1:<port>/?token=<token>","batchDir":"<批次目录>"}

fashion-tryon status <素材根目录> --json
# {"ok":true,"command":"status","batchDir":...,"counts":{...},"groups":[{"sku":...,"status":...}]}
~~~

`counts`：组计数 `delivered` `review` `generating` `queued` `incomplete`，失败张数 `failed`，任务总数 `tasks`，已用生成次数 `generationCalls`。组状态：`incomplete` `idle` `queued` `generating` `review` `delivered` `failed`。

错误时输出 `{"ok":false,"command":...,"status":"error","error":{"code","message"}}`，退出码 1；缺少密钥为 `CONFIG_ERROR`，批次不存在为 `NOT_FOUND`，同一批已有进程运行为 `VALIDATION_ERROR`。

## 交付输出

~~~text
<素材根目录>/成图/<款号>/<款号>_<模特图文件名（不含扩展名）>.<成图扩展名>
~~~

- 固定模特模式用服装图文件名。
- 只交付未标记不交付的任务的采用版本。
- 已有同内容文件跳过；同名不同内容依次尝试 `_2`、`_3`……，绝不覆盖。
- 撤回交付只删除本批 `delivered` 记录，不删除 `成图/` 里的文件。
