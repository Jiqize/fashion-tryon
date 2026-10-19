# Studio workflow

## Folder layout

~~~text
<source-root>/               # 素材根目录，只读
├── EK52338_灰色套装/        # 一组 = 一套；第一个 `_` 或空格前是款号
│   ├── 服装/                # 也识别 衣服 / 单品 / garment / clothes …
│   └── 模特/                # 也识别 人物 / 人像 / model / person …
├── EK52339/
│   ├── 服装/
│   └── 模特/
└── 成图/                    # 唯一的业务输出，扫描时忽略
~~~

Supported images: `.jpg` `.jpeg` `.png` `.webp` (magic bytes checked). System files such as `._*` and `.DS_Store` are skipped.

## Pairing modes

One default for the batch, overridable per group in the page:

| Mode | Group contents | Output |
| --- | --- | --- |
| `fixedClothing` (default) | 1 garment + N model poses | N images, one per pose |
| `pair` | N garments + N models | N images, paired in file order |
| `fixedModel` | N garments + 1 model | N images, one per garment |

A group whose counts do not fit its mode is marked 素材不全 and is not generated; other groups continue. Model counts outside 3–8 only show a hint (never in fixedModel mode).

Scope (换装范围): `full` (default), `top`, `bottom`, `full_acc`. Candidates per image: 1–4 (default 1). Concurrency: 1–10 (default 5).

## Commands

~~~bash
fashion-tryon studio <source-root> [--port <n>] [--no-open] --json   # background, resident
fashion-tryon status <source-root> --json                             # read-only progress
~~~

`studio` prints one line `{ "url", "batchDir" }` and keeps serving on `127.0.0.1` with a random token in the URL. It stops on SIGINT/SIGTERM. Restarting on the same root reuses the port and token when possible.

`status` returns `batchDir`, `counts` (groups `delivered` / `review` / `generating` / `queued` / `incomplete`, failed images `failed`, total `tasks`, `generationCalls` used) and `groups[{ sku, status }]` with status `incomplete | idle | queued | generating | review | delivered | failed`.

## What the user does in the page

1. Material table: one row per group, garment crop on the left, model images on the right. The crop can be adjusted per garment (`C`), the prompt viewed (`E`).
2. Settings bar: mode, scope, candidates, concurrency, estimated cost. Tick groups (default all) and press 开始 once. More groups can be started later.
3. Generation runs group by group. Rows show queued / running / done / failed; failed images can be retried one by one or with 重试所有失败, or marked 不交付 with X so the rest of the group can pass. A group whose preparation failed shows 重新准备 in its row. Pause / 继续 is available.
4. Judging per group while other groups still generate:

| Key | Action |
| --- | --- |
| `↑` `↓` | previous / next group |
| `←` `→` | previous / next image in the group |
| `Enter` | pass the whole group (all unmarked images are delivered) |
| `X` | mark / unmark the image as 不交付 |
| `R` | regenerate: tags `1`–`8`, `Tab` to write a note, `Enter` to confirm, `Esc` to cancel |
| `1`–`4` | choose between versions / candidates |
| `Space` | side-by-side loupe: garment crop, original model, result |
| `E` | show the prompt |
| `C` | adjust the garment crop |
| `⌘Z` / `Ctrl+Z` | undo the last judgment |

5. A passed group is published to `<source-root>/成图/<款号>/` immediately. A delivered group can be withdrawn (撤回交付) and judged again; files already written stay in `成图/`.

## Recovery and cost

- Every generation is submitted once. After a crash or reboot, rerun `fashion-tryon studio <source-root>`: jobs already accepted by the provider only fetch their result; nothing is submitted twice.
- Rate limits lower concurrency automatically and retry later without extra charges.
- All versions are kept; which one is delivered changes only by the user's choice.

## Output files

~~~text
<parent>/<root-name>-tryon-studio/   # batchDir
├── studio.json          # the only run record (atomic writes)
├── prepared/            # garment crops and compressed working copies
├── images/              # every generated version
├── thumbs/              # page thumbnails
├── 总览.html            # delivery overview, one row per delivered group
└── mapping.csv          # 款号 / garment / model / output mapping

<source-root>/成图/<款号>/<款号>_<model file stem>.<ext>   # fixedModel uses the garment file name
~~~

Same content is not written twice; a different file with the same name gets `_2`, `_3`, … and nothing is overwritten.
