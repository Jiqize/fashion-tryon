---
name: fashion-tryon
description: Run fashion try-on for a folder of garment and model photos — one image per model photo with all garments of the group as references — deliver to 成图/ and return the report path; the older studio page is still available on request.
---

# Fashion Try-on

Use the installed `fashion-tryon` CLI as the only execution interface. Do not recreate scanning, pairing, cropping, prompting, generation, judging, or delivery logic in the Agent.

When the `fashion-tryon` MCP server is installed, prefer its tools (`scan` → `crop` → `start_run` → `run_status`; `cancel_run` and `list_runs` when asked) and give the user the `editorUrl` that `start_run` returns (the editable node graph; fall back to the `graph` path when `editorUrl` is missing). Otherwise follow the CLI steps below.

To redo only some images, use `rerun`, never a whole-group `start_run`: read the group's current references, prompt (`promptEdited`) and swap with `run_status` first, then call `rerun` with `fromRunId`, the `shots` to redo (款号 + model photo) and per-group changes in `groups`; anything left out keeps the source run's settings. A reference photo that shows the model's face pulls the result toward that face: `crop` the face away first and pass the new crop in `references`. A rerun creates a new run and delivers as `-v2`, `-v3`; an edited prompt is used for that rerun only. Use `open_graph` when the user wants to edit and rerun in the page themselves. When the user wants to place or pick images themselves, call `open_graph` instead of asking them to send images one by one in chat: the page lets them drag images into the material folder, add new 款号 and start a run; without a runId it opens the collection page (合集页), which is also where the user looks at all results and picks images to redo. Every folder opened this way is added to the project page (项目页), which the user opens by double-clicking「Tryon 合集」or with `fashion-tryon open`; it lists all their material folders.

Pairing rules are chosen per 款号 on the collection page and saved in `成图/_runs/collection.json`; `start_run` follows the saved rules, and a 款号 never set there runs as 固定服装. Do not pick a rule for the user:
- 固定服装 (default): the garment photos are one look; each selected model photo gets one image with the whole look. Delivered as `成图/<款号>/<model name>.png`.
- 固定模特: each garment photo is a separate item; each selected garment gets one image on the single selected model. With 0 or more than 1 model selected the group is skipped with `<款号>：固定模特只能选 1 个模特`. Delivered as `成图/<款号>/<garment name>-<model name>.png`.
- 一对一: the n-th garment photo pairs with the n-th selected model photo; extra photos are left unpaired. Delivered like 固定模特.
For 固定模特 / 一对一 each combo is its own group in `run_status` with the same 款号 and an `item` field (its garment photo); to redo one, pass that `item` in the `rerun` shot.

## Default: run

The user gives one material root folder (素材根目录). Two layouts are read: `<款号>/服装/` + `<款号>/模特/`, or `服装/<款号>/` + `模特/<款号>/`.

1. Crop first (default; skip only when the user says so or `裁图/<款号>/` already has images the user placed there):
   - Look at every garment photo of each group yourself.
   - Write a plan JSON: `{ "<款号>": [{ "from": "<garment file name>", "role": "<用途>", "box": [x0, y0, x1, y1] }] }`. `box` is per-mille (0–1000) of the image; omit it to keep the whole image.
   - Per group pick 4–5 references: 1 `全身-正面` and 1 `半身-正面` without box, then 2–3 detail crops named `细节-<部位>` (领口 / 印花 / 面料 / 下摆 / 袖口 / 口袋), plus `背面` or `侧面` when such a photo exists. Each detail crop shows one garment area large and sharp, with as little face as possible.
   - Run `fashion-tryon crop <source-root> --plan <plan.json> --json`. Crops are written to `<source-root>/裁图/<款号>/`. Open every crop file and check it shows the intended area; fix the box and rerun with `--replace` if not.
2. Run in the background (Codex image generation is serial and takes about 2–3 minutes per image):

   ~~~bash
   fashion-tryon run <source-root> --json
   ~~~

   Swap scope: the default `--swap outfit` puts the whole reference look (garments and shoes, including visible inner layers) on the model. When a group is a single top (flat-lay of one top, the bottoms in the references are only styling) or the model photos are mostly half-body, add `--swap top`: only the upper-body clothes change, the model keeps her own bottoms and shoes. Use `--sku <款号...>` to run only some groups; groups that need different scopes go in separate runs.
3. Progress lines (`OK …` / `FAIL …`) go to stderr. The last stdout line is `{ ok, command: "run", report, runDir, counts }`. Return the `report` path; the report opens in the browser unless `--no-open` is given.
4. What it does: each model photo gets one image. The group's crops in `裁图/<款号>/` are the references when present, otherwise all garment photos (up to `--max-refs`, default 6); file names containing 全身 / 半身 / 侧面 / 背面 / 细节 are passed to the prompt as the role of that image. Only garments and shoes are replaced; worn necklaces and neck scarves are removed; hands keep the model photo's position. No vision model, no pairing page, no quality check.
5. Outputs go to `<source-root>/成图/<款号>/<model-file-name>.png`. An existing file is never overwritten; the new image gets `-v2`, `-v3`. Run files (prepared images, prompts, `run.json`, `report.html`) are in `<source-root>/成图/_runs/<timestamp>/`.
6. Use Codex (the default engine) unless the user asks for the paid provider; that engine needs keys in `.env.local` and is named in the README.

Use the studio below only when the user asks for the page with pairing, crops and per-image judging.

## Studio (on request)

The user gives one material root folder (素材根目录). Each subfolder is one group (one outfit, folder name = 款号) containing `服装/` and `模特/`.

1. Run the studio **in the background** (it stays resident; a foreground call with a timeout would kill it):

   ~~~bash
   fashion-tryon studio <source-root> --json
   ~~~

2. Read only the first stdout line: `{ "url": ..., "batchDir": ... }`. Return the clickable `url` and leave the process running. The page opens in the browser by default; add `--no-open` only when the user asks.
3. Tell the user the rest happens in the page: check the material table (garment crop + model images per row), adjust mode / scope / candidates / concurrency, press 开始 once, then judge each group as it finishes. Passed groups are delivered automatically.

One studio process serves one batch. For another batch, start `fashion-tryon studio <another-source-root>` as a separate background process. Reopening the same root restores all generation progress, judgments, and deliveries. A second studio on the same root is refused while the first is running.

## Progress

~~~bash
fashion-tryon status <source-root> --json
~~~

Report `counts` (delivered / review / generating groups, failed images, `generationCalls`) and per-group `status` from this output. It reads `studio.json` without a lock, so it works while the studio is running. If it returns `NOT_FOUND`, the batch has not been started.

## Boundaries

- The human is the only quality gate. Never judge, pass, exclude, or regenerate on the user's behalf, and never call the page API yourself.
- Never copy, move, rename, or delete generated files. The CLI alone publishes passed groups to `<source-root>/成图/<款号>/`; existing files are never overwritten, and scans ignore `成图/`.
- The material root is read-only. All run data lives in `batchDir` (`<parent>/<root-name>-tryon-studio/`).
- Never read, print, or pass API keys. Missing keys surface as `CONFIG_ERROR` before any network call; tell the user to fill `.env.local`.

Read [references/workflow.md](references/workflow.md) for folder layout, pairing modes, keyboard shortcuts, recovery, and output files.
