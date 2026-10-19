'use strict';
// 合集页：一款一组（左衣服、右模特），放图 / 节点两种模式；按每款的搭配规则与选中项新建出图。
// 文件夹是唯一事实来源：页面往里放图；删除衣服图是移到 成图/_runs/已删除/（可撤销），每次进入或点「刷新」都重新扫描。
// 搭配规则、保持画幅、半身标记、组顺序与组内图片顺序存在 成图/_runs/collection.json（经 /api/collection/*）；选中项只在页面内存里。

(() => {
  const PANEL = window.__EDITOR_PANEL__
  const UI = window.__UI__
  if (PANEL === undefined || UI === undefined) return
  const { api, esc, base, sourceUrl, thumbUrl } = PANEL
  const PING_MS = 60_000
  const BUSY_POLL_MS = 5000
  const MAX_BYTES = 52_428_800
  const ALLOWED = /\.(jpe?g|png|webp)$/i
  const VERSION = /^(.*)-v(\d+)$/
  const KIND_TEXT = { garment: '服装图', model: '模特图' }
  const PAIRING_TEXT = { fixedGarment: '固定服装', fixedModel: '固定模特', oneToOne: '一对一' }
  const SWAP_TEXT = { outfit: '换整套', top: '只换上衣' }
  const STATE_TEXT = { generating: '生成中', queued: '排队', failed: '失败' }
  const FIXED_MODEL_ERROR = '固定模特只能选 1 个模特'
  const MODE_KEY = 'ft.collection.mode'
  const FOLDED_KEY = 'ft.collection.folded'
  const TILE_KEY = 'ft.collection.tile'
  const TILE_MIN = 64
  const TILE_MAX = 132
  const TILE_DEFAULT = 84
  const PAIRING_OPTIONS = Object.entries(PAIRING_TEXT).map(([value, label]) => ({ value, label, icon: UI.RULE_ICONS[value] }))
  const SWAP_OPTIONS = Object.entries(SWAP_TEXT).map(([value, label]) => ({ value, label }))
  const SWAP_ALL_OPTIONS = [{ value: 'each', label: '按各款设置' }, { value: 'outfit', label: '全部换整套' }, { value: 'top', label: '全部只换上衣' }]
  const SKU_TYPE = 'application/x-cl-sku'
  const ITEM_TYPE = 'application/x-cl-item'

  let view = null
  /** 只在页面里的新款（还没放图） */
  const pending = []
  /** 勾选参与出图的款 */
  const picked = new Set()
  /** sku → 取消选中的图（新放的图默认选中） */
  const offModels = new Map()
  const offGarments = new Map()
  /** sku → 换装范围（只在页面里） */
  const swaps = new Map()
  /** sku → { kind, done, total } 正在放图 */
  const uploads = new Map()
  /** sku → 上传中又往同款放的图，按放入顺序排队 [{ kind, files }] */
  const queues = new Map()
  /** 当前聚焦的缩略图 { ql, file }：重画后按它找回 is-focus，空格快速预览从它开始 */
  let focused = null
  let mode = load(MODE_KEY) === 'node' ? 'node' : 'place'
  const folded = new Set(loadFolded())
  let sending = false
  let uploading = 0
  let polling = null
  /** 对照弹层当前的成图 { sku, file }；未打开为 null */
  let cmp = null
  /** 待重出的写请求串行排队，重出前等备注写完 */
  let redoChain = Promise.resolve()
  /** sku → 该款组设置的保存队列（按款串行） */
  const prefsQueues = new Map()
  /** sku → { confirmed: 服务端最后确认的组设置, pending: 还没完成的操作改动（按顺序） } */
  const prefsStates = new Map()
  /** 底栏已提示过的错误，同一条不重复弹 */
  let barErrors = new Set()
  /** 本页点过「停止」的 runId：结束时提示「已停止」 */
  const stopped = new Set()
  /** 对照、待重出在 Esc 层级栈里的出栈函数 */
  let popCompare = null
  let popRedo = null

  // ---------- 本浏览器记住的设置（存取失败时用默认） ----------

  function load(key) {
    try { return localStorage.getItem(key) } catch { return null }
  }

  function save(key, value) {
    try { localStorage.setItem(key, value) } catch { /* 存不了就只在本次有效 */ }
  }

  function loadFolded() {
    try {
      const value = JSON.parse(load(FOLDED_KEY) || '[]')
      return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []
    } catch {
      return []
    }
  }

  // ---------- 款与选中 ----------

  const offOf = (map, sku) => {
    if (!map.has(sku)) map.set(sku, new Set())
    return map.get(sku)
  }
  const pendingGroup = (sku) => ({ sku, garments: [], crops: [], cropFrom: {}, models: [], outputs: [], inFlight: [], prefs: { pairing: 'fixedGarment', keepFrame: false, halfModels: [] }, pending: true })

  /** 组顺序：order 非空时按 order，其余按款号排在后面；页面里的新款最后 */
  function sortedGroups() {
    const order = view.order || []
    const known = view.groups.slice()
    const ranked = order.map((sku) => known.find((group) => group.sku === sku)).filter((group) => group !== undefined)
    const rest = known.filter((group) => !order.includes(group.sku))
    return [...ranked, ...rest]
  }

  const groups = () => [...sortedGroups(), ...pending.filter((sku) => !view.groups.some((group) => group.sku === sku)).map(pendingGroup)]
  const groupOf = (sku) => groups().find((group) => group.sku === sku)
  const swapOf = (sku) => swaps.get(sku) || 'outfit'
  const selectedModels = (group) => group.models.filter((file) => !offOf(offModels, group.sku).has(file))
  const selectedGarments = (group) => group.prefs.pairing === 'fixedGarment'
    ? group.garments
    : group.garments.filter((file) => !offOf(offGarments, group.sku).has(file))

  /** 缺素材的原因；能出图返回 null */
  const why = (group) => group.pending ? null : group.garments.length === 0 && group.crops.length === 0 ? '缺少服装图' : group.models.length === 0 ? '缺少模特图' : null

  /** 按搭配规则算出这款将出几张、未配对几张、报错 */
  function plan(group) {
    const models = selectedModels(group).length
    const garments = selectedGarments(group).length
    const pairing = group.prefs.pairing
    if (pairing === 'fixedModel') return models === 1 ? { count: garments, unpaired: 0, error: null } : { count: 0, unpaired: 0, error: FIXED_MODEL_ERROR }
    if (pairing === 'oneToOne') return { count: Math.min(models, garments), unpaired: Math.abs(models - garments), error: null }
    return { count: models, unpaired: 0, error: null }
  }

  const pickable = (group) => !group.pending && why(group) === null && plan(group).error === null
  const drawer = () => window.__COLLECTION_DRAWER__

  // ---------- 渲染 ----------

  function countText(group) {
    if (group.pending) return '新款，放图后写入文件夹'
    const result = plan(group)
    let text = '衣服 ' + group.garments.length + ' · 模特 ' + selectedModels(group).length + '/' + group.models.length
    if (why(group) !== null) return esc(text)
    if (result.error !== null) return esc(text) + ' · <span class="cl-err">' + esc(result.error) + '</span>'
    text += ' · 将出 ' + result.count + ' 张'
    if (group.prefs.pairing === 'oneToOne' && result.unpaired > 0) text += ' · 未配对 ' + result.unpaired
    return esc(text)
  }

  function headHtml(group, index) {
    const reason = why(group)
    const edited = drawer() !== undefined && drawer().selection(group.sku) !== null
    const stale = edited && drawer().stale(group.sku)
    const isFolded = folded.has(group.sku)
    return '<header class="cl-head">' +
      '<input type="checkbox" class="cl-pick" aria-label="选这款出图"' + (pickable(group) ? '' : ' disabled') + (picked.has(group.sku) ? ' checked' : '') + '>' +
      '<span class="cl-no"' + (group.pending ? '' : ' draggable="true" title="拖动排序"') + '>' + String(index + 1).padStart(2, '0') + '</span>' +
      '<b class="cl-sku">' + esc(group.sku) + '</b>' +
      '<span class="cl-cnt">' + countText(group) + '</span>' +
      (reason === null ? '' : '<span class="cl-why">' + reason + '</span>') +
      (group.pending ? '' : '<span class="cl-tools">' +
        UI.segHtml('data-cl="pairing"', PAIRING_OPTIONS, group.prefs.pairing, '搭配规则') +
        UI.segHtml('data-cl="swap"', SWAP_OPTIONS, swapOf(group.sku), '换装范围') +
        UI.switchHtml('data-cl="keep"', group.prefs.keepFrame, '保持画幅') +
        '<button type="button" class="cl-btn cl-edit' + (stale ? ' is-stale' : '') + '">编辑' + (stale ? '<span class="cl-flag"> · 提示词可能对不上</span>' : edited ? '<span class="cl-flag"> · 已改</span>' : '') + '</button>' +
        '<button type="button" class="cl-btn cl-only"' + (canStart() && pickable(group) && plan(group).count > 0 ? '' : ' disabled') + '>只出这款</button>' +
        '<button type="button" class="cl-more" aria-haspopup="menu" aria-label="更多">⋯</button>' +
        '</span>') +
      '<button type="button" class="cl-fold" aria-label="' + (isFolded ? '展开' : '折叠') + '" aria-expanded="' + !isFolded + '">' + (isFolded ? '▸' : '▾') + '</button>' +
      '</header>' +
      (isFolded ? '<p class="cl-summary">' + esc(summaryText(group)) + '</p>' : '')
  }

  /** 折叠后的一行摘要：衣服 N · 模特 已选/共 · 将出 N 张 · 成图 N 版 */
  const summaryText = (group) => '衣服 ' + group.garments.length + ' · 模特 ' + selectedModels(group).length + '/' + group.models.length +
    ' · 将出 ' + plan(group).count + ' 张 · 成图 ' + group.outputs.length + ' 版'

  function dropHtml(kind, big) {
    return '<label class="cl-drop' + (big ? ' is-big' : '') + '" data-kind="' + kind + '">' +
      '<input type="file" multiple accept=".jpg,.jpeg,.png,.webp">' +
      (big ? '<b>拖入' + (kind === 'garment' ? '衣服' : '模特') + '图</b><span>或点击选择</span>' : '<span>＋<br>拖入' + (kind === 'garment' ? '衣服' : '模特') + '</span>') +
      '</label>'
  }

  function progHtml(group, kind) {
    const upload = uploads.get(group.sku)
    if (upload === undefined || upload.kind !== kind) return ''
    return '<div class="cl-prog">正在放入 ' + upload.done + ' / ' + upload.total +
      '<progress max="' + upload.total + '" value="' + upload.done + '"></progress></div>'
  }

  /** 该栏有排队等放的图时，栏标题显示「排队中…」 */
  const queuedHtml = (group, kind) => (queues.get(group.sku) || []).some((batch) => batch.kind === kind) ? '<span class="cl-q">排队中…</span>' : ''

  /** 缩略图根元素的公共属性：data-ql 为该栏分组名（快速预览在同栏切换），可 Tab 聚焦 */
  function tileAttrs(ql, file) {
    return ' data-ql="' + esc(ql) + '" data-file="' + esc(file) + '" title="' + esc(file) + '" tabindex="0"'
  }
  const focusClass = (ql, file) => focused !== null && focused.ql === ql && focused.file === file ? ' is-focus' : ''
  const imgHtml = (file) => '<img src="' + esc(thumbUrl(file)) + '" alt="" loading="lazy" draggable="false">'
  /** 悬停或键盘聚焦缩略图时出现的操作条 */
  const actsHtml = (buttons) => '<span class="cl-acts">' + buttons + '</span>'

  /** 出图实际用的参考图：固定服装看参考图列表，其余看每件衣服选的原图或裁图 */
  function usedRefs(group) {
    if (group.prefs.pairing === 'fixedGarment') {
      const edited = drawer() === undefined ? null : drawer().selection(group.sku)
      const refs = edited !== null && edited.references !== undefined ? edited.references : group.defaults.references
      return new Set(refs.map((ref) => ref.file))
    }
    return new Set(selectedGarments(group).map((garment) => itemRefOf(group, garment)))
  }

  /** 裁图缩略图：可拖动排序；出图实际用它时描边 */
  function cropTile(group, crop, used) {
    const ql = 'crops-' + group.sku
    return '<div class="cl-tile cl-crop' + (used.has(crop) ? ' is-used' : '') + focusClass(ql, crop) + '" draggable="true" data-drag="crop"' + tileAttrs(ql, crop) + '>' +
      '<span class="cl-ph">' + imgHtml(crop) + '<span class="cl-tag">裁</span></span><span class="cl-cap">' + esc(base(crop)) + '</span></div>'
  }

  /** 删除按钮：悬停时出现在图左上角，避开图中间（点图是选中）和底部操作条 */
  function delHtml(file, title) {
    return '<button type="button" class="cl-del" data-file="' + esc(file) + '" aria-label="删除 ' + esc(base(file)) + '" title="删除：' + esc(title) + '">×</button>'
  }

  /** 衣服图：可拖动排序、可删除；有裁图时出图用原图才描边 */
  function garmentTile(group, file, used) {
    const ql = 'garments-' + group.sku
    const usedClass = group.crops.length > 0 && used.has(file) ? ' is-used' : ''
    const acts = delHtml(file, '连同由它裁出的裁图移到 成图/_runs/已删除/，可撤销')
    const cap = '<span class="cl-cap">' + esc(base(file)) + '</span>'
    const drag = ' draggable="true" data-drag="garment"'
    if (group.prefs.pairing === 'fixedGarment') {
      return '<div class="cl-tile' + usedClass + focusClass(ql, file) + '"' + drag + tileAttrs(ql, file) + '><span class="cl-ph">' + imgHtml(file) + acts + '</span>' + cap + '</div>'
    }
    const on = !offOf(offGarments, group.sku).has(file)
    return '<div class="cl-tile is-pick' + (on ? ' is-on' : '') + usedClass + focusClass(ql, file) + '" role="button" aria-pressed="' + on + '"' + drag + tileAttrs(ql, file) + '>' +
      '<span class="cl-ph">' + imgHtml(file) + '<span class="cl-tick" aria-hidden="true">✓</span>' + acts + '</span>' + cap + '</div>'
  }

  /** 裁图单独一排（在成图上面），按服务端给的顺序（拖过的按拖的顺序，否则按文件名）；出图实际用的描边 */
  function cropsHtml(group) {
    if (group.crops.length === 0) return ''
    const used = usedRefs(group)
    return '<div class="cl-outs cl-crops"><span class="cl-lab">裁图</span>' + group.crops.map((crop) => cropTile(group, crop, used)).join('') + '</div>'
  }

  function modelTile(group, file) {
    const ql = 'models-' + group.sku
    const on = !offOf(offModels, group.sku).has(file)
    const half = group.prefs.halfModels.includes(file)
    return '<div class="cl-tile is-pick' + (on ? ' is-on' : '') + focusClass(ql, file) + '" role="button" aria-pressed="' + on + '" draggable="true" data-drag="model"' + tileAttrs(ql, file) + '>' +
      '<span class="cl-ph">' + imgHtml(file) + '<span class="cl-tick" aria-hidden="true">✓</span>' +
      (half ? '<span class="cl-halfmark">半身</span>' : '') +
      actsHtml('<button type="button" class="cl-half' + (half ? ' is-on' : '') + '" data-file="' + esc(file) + '" aria-pressed="' + half + '" title="被截掉的部位不补画">' + (half ? '取消半身' : '标半身') + '</button>') +
      delHtml(file, '移到 成图/_runs/已删除/，可撤销') +
      '</span><span class="cl-cap">' + esc(base(file)) + '</span></div>'
  }

  /** 每个出图组合（衣服 + 模特）的最新成图与进行中状态 */
  function combos(group) {
    const map = new Map()
    const entry = (key) => {
      if (!map.has(key)) map.set(key, { outputs: [], state: null })
      return map.get(key)
    }
    for (const output of group.outputs) {
      const stem = base(output.file).replace(/\.[^.]+$/, '')
      const match = VERSION.exec(stem)
      // 手放、没有出图记录的成图按文件名归组
      const key = output.model === null ? 'file:' + (match === null ? stem : match[1]) : (output.item || '') + '|' + output.model
      entry(key).outputs.push(output)
    }
    for (const flight of group.inFlight) {
      const target = entry((flight.item || '') + '|' + flight.model)
      if (target.state === null || target.state === 'failed') target.state = flight.state
    }
    return [...map.values()]
  }

  function outsHtml(group) {
    const ql = 'outs-' + group.sku
    const items = combos(group).map((combo) => {
      const latest = combo.outputs[combo.outputs.length - 1]
      const queued = latest !== undefined && view.redo.some((entry) => entry.delivered === latest.file)
      // 手放、没有出图记录的成图不能加入待重出；已在清单里的可以再点移出
      const canRedo = latest !== undefined && (queued || latest.runId !== null)
      return (latest === undefined ? '' : '<div class="cl-tile cl-out' + focusClass(ql, latest.file) + '"' + tileAttrs(ql, latest.file) + '>' +
        '<span class="cl-ph">' + imgHtml(latest.file) + '<span class="cl-v">v' + latest.version + '</span>' +
        actsHtml('<button type="button" class="cl-cmp" data-file="' + esc(latest.file) + '">对照</button>' +
          '<button type="button" class="cl-addredo" data-file="' + esc(latest.file) + '"' + (canRedo ? '' : ' disabled') + '>' + (queued ? '移出待重出' : '待重出') + '</button>') +
        delHtml(latest.file, '删掉这个版本，移到 成图/_runs/已删除/，可撤销') +
        '</span></div>') +
        (combo.state === null ? '' : '<span class="cl-out-st is-' + combo.state + '">' + STATE_TEXT[combo.state] + '</span>')
    }).join('')
    return items === '' ? '' : '<div class="cl-outs"><span class="cl-lab">成图</span>' + items + '</div>'
  }

  /** 放图模式：衣服栏、模特栏整栏是拖放区 */
  function placeHtml(group) {
    if (group.pending) {
      return '<div class="cl-cols">' +
        '<div class="cl-col" data-kind="garment"><h3>衣服 <small>要换上的服装参考图</small>' + queuedHtml(group, 'garment') + '</h3>' + dropHtml('garment', true) + progHtml(group, 'garment') + '</div>' +
        '<div class="cl-col" data-kind="model"><h3>模特 <small>要生成的模特照片</small>' + queuedHtml(group, 'model') + '</h3>' + dropHtml('model', true) + progHtml(group, 'model') + '</div>' +
        '</div>'
    }
    const cropped = group.garments.filter((file) => Object.values(group.cropFrom || {}).includes(file)).length
    return '<div class="cl-cols">' +
      '<div class="cl-col" data-kind="garment"><h3>衣服 <small>' + group.garments.length + ' 张' + (cropped ? ' · 已裁 ' + cropped : '') + '</small>' + queuedHtml(group, 'garment') + '</h3>' +
      '<div class="cl-tiles">' + (() => { const used = usedRefs(group); return group.garments.map((file) => garmentTile(group, file, used)).join('') })() + dropHtml('garment', false) + '</div>' + progHtml(group, 'garment') + '</div>' +
      '<div class="cl-col" data-kind="model"><h3>模特 <small>点图选中 · 已选 ' + selectedModels(group).length + '/' + group.models.length + '</small>' + queuedHtml(group, 'model') + '</h3>' +
      '<div class="cl-tiles">' + group.models.map((file) => modelTile(group, file)).join('') + dropHtml('model', false) + '</div>' + progHtml(group, 'model') + '</div>' +
      '</div>' + cropsHtml(group) + outsHtml(group)
  }

  // ---------- 节点模式 ----------

  const stemOf = (file) => base(file).replace(/\.[^.]+$/, '')
  const keyOf = (item, model) => (item || '') + '|' + (model || '')

  /** 每件衣服默认是否用裁图（与 defaultItemRef 一致：有由它裁出的裁图就用裁图） */
  const cropsAsDefault = (group, garment) => Object.values(group.cropFrom || {}).includes(garment)

  /** 出图组合的行：当前规则下会出的组合 + 已有成图的组合；不在当前选择里的行 on 为 false */
  function laneRows(group) {
    const rows = []
    const find = (item, model) => rows.find((row) => row.item === item && row.model === model)
    const add = (item, model, on) => {
      const found = find(item, model)
      if (found !== undefined) return found
      const row = { item, model, on, outputs: [], state: null, stem: model === null ? null : (item === null ? '' : stemOf(item) + '-') + stemOf(model) }
      rows.push(row)
      return row
    }
    const models = selectedModels(group)
    const garments = selectedGarments(group)
    const pairing = group.prefs.pairing
    if (pairing === 'fixedGarment') {
      for (const model of group.models) add(null, model, models.includes(model))
    } else if (pairing === 'fixedModel') {
      if (models.length === 1) for (const garment of group.garments) add(garment, models[0], garments.includes(garment))
      for (const model of group.models) if (models.length !== 1 || model !== models[0]) add(null, model, false)
    } else {
      const count = Math.min(models.length, garments.length)
      for (let index = 0; index < count; index += 1) add(garments[index], models[index], true)
      for (const model of group.models) if (!models.slice(0, count).includes(model)) add(null, model, false)
    }
    for (const output of group.outputs) {
      if (output.model !== null) {
        add(output.item, output.model, false).outputs.push(output)
        continue
      }
      // 手放、没有出图记录的成图：按文件名对上组合，对不上的单独一行
      const match = VERSION.exec(stemOf(output.file))
      const stem = match === null ? stemOf(output.file) : match[1]
      let row = rows.find((candidate) => candidate.stem === stem)
      if (row === undefined) {
        const combos = [
          ...group.models.map((model) => ({ item: null, model })),
          ...group.garments.flatMap((item) => group.models.map((model) => ({ item, model }))),
        ]
        const combo = combos.find((entry) => (entry.item === null ? '' : stemOf(entry.item) + '-') + stemOf(entry.model) === stem)
        if (combo !== undefined) row = add(combo.item, combo.model, false)
        else {
          row = { item: null, model: null, on: false, outputs: [], state: null, stem, label: stem }
          rows.push(row)
        }
      }
      row.outputs.push(output)
    }
    for (const flight of group.inFlight) {
      const row = add(flight.item, flight.model, false)
      if (row.state === null || row.state === 'failed') row.state = flight.state
    }
    for (const row of rows) row.outputs.sort((a, b) => a.version - b.version)
    return rows
  }

  function garmentNode(group) {
    const shown = group.garments.slice(0, 5)
    return '<div class="cl-node cl-node-garments" data-kind="garment" role="button" tabindex="0" aria-label="编辑 ' + esc(group.sku) + '，或拖图到这里放入衣服图">' +
      '<p class="cl-node-lab">衣服 <b>' + group.garments.length + '</b> · 拖图到这里加入</p>' +
      '<div class="cl-node-grid">' + shown.map((file) => '<img src="' + esc(thumbUrl(file)) + '" alt="" loading="lazy" draggable="false">').join('') +
      (group.garments.length > shown.length ? '<span class="cl-more">+' + (group.garments.length - shown.length) + '</span>' : '') + '</div>' +
      progHtml(group, 'garment') + '</div>'
  }

  function setNode(group) {
    const edited = drawer() === undefined ? null : drawer().selection(group.sku)
    let refs
    if (group.prefs.pairing === 'fixedGarment') {
      const list = edited !== null && edited.references !== undefined ? edited.references : group.defaults.references
      refs = list.length + ' 张' + (list.some((ref) => ref.file.startsWith('裁图/')) ? '（含裁图）' : '')
    } else {
      const itemRefs = edited !== null && edited.itemRefs !== undefined ? edited.itemRefs : {}
      const anyCrop = group.garments.some((garment) => itemRefs[garment] !== undefined ? itemRefs[garment].startsWith('裁图/') : cropsAsDefault(group, garment))
      refs = '每件 1 张' + (anyCrop ? '（含裁图）' : '')
    }
    const prompt = edited !== null && edited.prompt !== undefined ? '已改' : '默认'
    // 规则、范围、画幅直接在节点上改（与组头同一保存逻辑）；点其余地方或「编辑」打开抽屉
    return '<div class="cl-node cl-node-set cl-setnode">' +
      '<p class="cl-node-lab">设置</p>' +
      '<div class="cl-setrow"><span>规则</span>' + UI.segHtml('data-cl="pairing"', PAIRING_OPTIONS, group.prefs.pairing, '搭配规则') + '</div>' +
      '<div class="cl-setrow"><span>范围</span>' + UI.segHtml('data-cl="swap"', SWAP_OPTIONS, swapOf(group.sku), '换装范围') + '</div>' +
      '<div class="cl-setrow"><span>画幅</span>' + UI.switchHtml('data-cl="keep"', group.prefs.keepFrame, group.prefs.keepFrame ? '保持' : '默认') + '</div>' +
      '<dl><dt>参考图</dt><dd>' + refs + '</dd>' +
      '<dt>提示词</dt><dd>' + prompt + '</dd></dl>' +
      '<button type="button" class="cl-node-edit" aria-label="编辑 ' + esc(group.sku) + ' 的设置">在抽屉里编辑 →</button></div>'
  }

  function rowHtml(group, row) {
    const thumbs = [row.item, row.model].filter((file) => file !== null)
    const name = row.model === null ? row.label + '（手放）' : (row.item === null ? '' : base(row.item) + ' + ') + base(row.model)
    const half = row.model !== null && group.prefs.halfModels.includes(row.model)
    const node = row.model === null
      ? '<div class="cl-node cl-node-model is-loose"><span class="cl-cap">' + esc(name) + '</span></div>'
      : '<button type="button" class="cl-node cl-node-model" data-model="' + esc(row.model) + '" data-item="' + esc(row.item || '') + '" aria-pressed="' + row.on + '" title="点击切换出不出">' +
        '<span class="cl-node-imgs">' + thumbs.map((file) => '<img src="' + esc(thumbUrl(file)) + '" alt="" loading="lazy" draggable="false">').join('') + '</span>' +
        '<span class="cl-tick" aria-hidden="true">✓</span>' +
        '<span class="cl-cap">' + esc(name) + (half ? ' · 半身' : '') + '</span></button>'
    const latest = row.outputs[row.outputs.length - 1]
    const versions = row.outputs.map((output) => '<button type="button" class="cl-ver' + (output === latest ? ' is-latest' : '') + '" data-file="' + esc(output.file) + '" title="' + esc(output.file) + '">' +
      '<img src="' + esc(thumbUrl(output.file)) + '" alt="" loading="lazy" draggable="false">' +
      (view.redo.some((entry) => entry.delivered === output.file) ? '<span class="cl-mark">待重出</span>' : '') +
      '<span class="cl-ver-v">v' + output.version + '</span></button>').join('')
    const state = row.state === null ? '' : '<span class="cl-out-st is-' + row.state + '">' + STATE_TEXT[row.state] + '</span>'
    const queued = latest !== undefined && view.redo.some((entry) => entry.delivered === latest.file)
    const canRedo = latest !== undefined && (queued || latest.runId !== null)
    return '<div class="cl-row' + (row.on ? '' : ' is-off') + '" data-item="' + esc(row.item || '') + '" data-model="' + esc(row.model || '') + '">' +
      node + '<span class="cl-wire"></span>' +
      '<div class="cl-node cl-node-outs">' + (versions || state ? versions + state : '<span class="cl-ph">未出图</span>') +
      '<button type="button" class="cl-btn cl-add-redo"' + (canRedo ? '' : ' disabled') + (latest === undefined ? '' : ' data-file="' + esc(latest.file) + '"') + '>' + (queued ? '移出待重出' : '＋待重出') + '</button></div>' +
      '</div>'
  }

  function laneHtml(group) {
    if (group.pending) return placeHtml(group)
    return '<section class="cl-lane" data-sku="' + esc(group.sku) + '"><div class="cl-flow">' +
      garmentNode(group) + '<span class="cl-wire"></span>' + setNode(group) + '<span class="cl-wire"></span>' +
      '<div class="cl-rows">' + laneRows(group).map((row) => rowHtml(group, row)).join('') + '</div>' +
      '</div></section>'
  }

  /** 成图上的待重出按钮：不在清单里就加入该组合的最新版本，已在就移出 */
  function toggleRedo(file) {
    const queued = view.redo.some((entry) => entry.delivered === file)
    return editRedo({ action: queued ? 'remove' : 'add', delivered: file })
  }

  /** 改待重出清单（加入 / 移除 / 备注），按顺序一个个发 */
  function editRedo(body) {
    redoChain = redoChain.then(async () => {
      try {
        const { redo } = await api('POST', '/api/redo', body)
        view.redo = redo
      } catch (error) {
        if (document.getElementById('cl-redo').hidden) UI.toast(error.message, { error: true })
        else document.getElementById('cl-redo-msg').insertAdjacentHTML('afterbegin', '<span class="ed-err">' + esc(error.message) + '</span>')
        return
      }
      render()
    })
    return redoChain
  }

  function renderList() {
    const list = document.getElementById('cl-list')
    const all = groups()
    const query = document.getElementById('cl-search').value.trim().toLowerCase()
    const shown = all.map((group, index) => ({ group, index })).filter(({ group }) => query === '' || group.sku.toLowerCase().includes(query))
    // 重画会冲掉焦点：组头控件有焦点时，画完按款号与控件找回
    const active = document.activeElement
    const control = active instanceof Element && list.contains(active) ? active.closest('[data-cl]') : null
    const keep = control === null ? null : { sku: skuOf(control), scope: control.closest('.cl-setnode') === null ? '.cl-head' : '.cl-setnode', cl: control.dataset.cl, value: active.dataset.value }
    const tile = active instanceof Element && list.contains(active) ? active.closest('.cl-tile[data-ql]') : null
    const keepTile = tile === null ? null : { ql: tile.dataset.ql, file: tile.dataset.file }
    list.innerHTML = shown.map(({ group, index }) => '<section class="cl-group' + (picked.has(group.sku) ? ' is-picked' : '') + '" data-sku="' + esc(group.sku) + '">' +
      headHtml(group, index) +
      (folded.has(group.sku) ? '' : mode === 'place' ? placeHtml(group) : laneHtml(group)) +
      '</section>').join('')
    if (all.length === 0) list.innerHTML = '<p class="cl-empty">这个素材目录还没有款。点「新建款」，再把衣服图和模特图拖进来。</p>'
    else if (shown.length === 0) list.innerHTML = '<p class="cl-empty">没有匹配的款号</p>'
    if (keep !== null) {
      const root = list.querySelector('section.cl-group[data-sku="' + CSS.escape(keep.sku) + '"] ' + keep.scope + ' [data-cl="' + keep.cl + '"]')
      const target = root === null || keep.value === undefined ? root : root.querySelector('[data-value="' + CSS.escape(keep.value) + '"]')
      if (target !== null) target.focus()
    }
    if (keepTile !== null) {
      const target = list.querySelector('.cl-tile[data-ql="' + CSS.escape(keepTile.ql) + '"][data-file="' + CSS.escape(keepTile.file) + '"]')
      if (target !== null) target.focus()
    }
  }

  function renderTop() {
    document.getElementById('cl-name').textContent = view.projectName
    document.getElementById('cl-info').innerHTML = view.groups.length + ' 款' +
      (view.latestRunId ? ' · <a href="/runs/' + encodeURIComponent(view.latestRunId) + '/">最近一次出图</a>' : '')
    const progress = document.getElementById('cl-progress')
    const active = view.activeRun
    progress.hidden = active === null
    progress.innerHTML = active === null ? '' : '<span class="cl-dot"></span>正在出图 ' + active.done + ' / ' + active.total +
      ' · <a href="/runs/' + encodeURIComponent(active.runId) + '/">查看</a>'
  }

  function render() {
    renderTop()
    renderList()
    renderBar()
    renderCompare()
    renderRedo()
  }

  // ---------- 底栏 ----------

  const canStart = () => !sending && uploading === 0 && view.activeRun === null

  function pickedGroups() {
    return groups().filter((group) => picked.has(group.sku) && pickable(group))
  }

  /** 分段控件当前选中的值 */
  function segValue(root) {
    const on = root === null ? null : root.querySelector('[aria-checked="true"]')
    return on === null ? '' : on.dataset.value
  }

  /** 引擎：服务默认引擎不是 codex 时（如测试用的 fake），第一项值为空 = 不传 engine，与原下拉一致 */
  const engineOf = () => segValue(document.getElementById('ed-engine'))

  function buildBar() {
    const engines = [
      ...(view.engineDefault === 'codex' ? [] : [{ value: '', label: view.engineDefault }]),
      { value: 'codex', label: 'codex' },
      { value: 'apimart', label: 'apimart' },
    ]
    document.body.insertAdjacentHTML('beforeend',
      '<div id="ed-bar"><span id="ed-count">已选 0 款 · 出图 0 张</span>' +
      '<span class="cl-bar-field">换装范围 ' + UI.segHtml('id="cl-swap-all"', SWAP_ALL_OPTIONS, 'each', '统一换装范围') + '</span>' +
      UI.switchHtml('id="cl-keep-all"', false, '全部保持画幅') +
      '<span class="cl-bar-field ed-engine">引擎 ' + UI.segHtml('id="ed-engine"', engines, engines[0].value, '引擎') + '</span>' +
      '<span id="ed-cost" class="ed-cost" hidden>会产生真实费用</span>' +
      '<span class="cl-spacer"></span>' +
      '<button type="button" id="cl-redo-open">待重出<span class="cl-redo-n">0</span></button>' +
      '<button type="button" id="ed-go" disabled>出图</button>' +
      '<button type="button" id="cl-stop" hidden>停止</button>' +
      '<span id="ed-msg"></span></div>')
  }

  function renderBar() {
    if (document.getElementById('ed-bar') === null || view === null) return
    const list = pickedGroups()
    const total = list.reduce((sum, group) => sum + plan(group).count, 0)
    const empty = list.filter((group) => plan(group).count === 0)
    document.getElementById('ed-count').textContent = '已选 ' + list.length + ' 款 · 出图 ' + total + ' 张'
    document.getElementById('ed-cost').hidden = engineOf() !== 'apimart'
    document.querySelector('#cl-redo-open .cl-redo-n').textContent = String(view.redo.length)
    const go = document.getElementById('cl-redo-go')
    if (go !== null) go.disabled = !canStart() || view.redo.length === 0
    const goButton = document.getElementById('ed-go')
    goButton.disabled = !canStart() || total === 0 || empty.length > 0
    // 出图中：主按钮显示「出图中 N/M」与细进度条，旁边出现「停止」
    const active = view.activeRun
    if (active === null) goButton.textContent = '出图'
    else {
      goButton.innerHTML = '出图中 ' + active.done + '/' + active.total + '<span class="cl-pbar"><i></i></span>'
      goButton.querySelector('.cl-pbar i').style.width = (active.total > 0 ? Math.min(100, active.done / active.total * 100) : 0) + '%'
    }
    document.getElementById('cl-stop').hidden = active === null
    // 每条错误各出一条 error toast；同一条只在新出现时弹
    const errors = empty.map((group) => group.sku + '：没有勾选要出图的图')
    for (const text of errors) if (!barErrors.has(text)) UI.toast(text, { error: true })
    barErrors = new Set(errors)
    // 没勾选款、也没在跑的 run 时，灰字提示（不是报错）
    document.getElementById('ed-msg').innerHTML = list.length === 0 && view.activeRun === null ? '<span class="ed-dirty">勾选要出图的款</span>' : ''
  }

  // ---------- 设置 ----------

  /** 组设置变了：选不了的款取消勾选，再重画 */
  function prefsChanged(sku) {
    const group = groupOf(sku)
    if (group && !pickable(group)) picked.delete(sku)
    render()
  }

  /**
   * 保存组设置（规则、画幅、半身）：界面先按这次操作显示；同一款按顺序一个个发。
   * 界面 = 服务端最后确认的设置 + 按顺序重放还没完成的操作，所以以最后一次操作为准、期间不回跳；
   * 某次失败只丢掉这次改动并出错误 toast，全部完成后界面与服务端一致。
   */
  function savePrefs(sku, change) {
    const known = view.groups.find((entry) => entry.sku === sku)
    if (known === undefined) return Promise.resolve()
    let state = prefsStates.get(sku)
    if (state === undefined || state.pending.length === 0) {
      state = { confirmed: known.prefs, pending: [] }
      prefsStates.set(sku, state)
    }
    const entry = { change }
    state.pending.push(entry)
    known.prefs = { ...known.prefs, ...change }
    prefsChanged(sku)
    const queue = (prefsQueues.get(sku) || Promise.resolve()).then(async () => {
      try {
        const { prefs } = await api('POST', '/api/collection/prefs', { sku, ...change })
        state.confirmed = prefs
      } catch (error) {
        UI.toast(error.message, { error: true })
      }
      state.pending = state.pending.filter((item) => item !== entry)
      const group = view.groups.find((item) => item.sku === sku)
      if (group) group.prefs = state.pending.reduce((prefs, item) => ({ ...prefs, ...item.change }), state.confirmed)
      prefsChanged(sku)
    })
    prefsQueues.set(sku, queue)
    return queue
  }

  async function saveOrder(order, done) {
    try {
      const result = await api('POST', '/api/collection/order', { order })
      view.order = result.order
      if (done) UI.toast(done)
    } catch (error) {
      UI.toast(error.message, { error: true })
    }
    render()
  }

  /** 把 sku 移到 target 位置（「…」菜单的移到最前 / 最后） */
  function moveTo(sku, targetIndex) {
    const order = sortedGroups().map((group) => group.sku)
    const from = order.indexOf(sku)
    if (from < 0 || targetIndex < 0 || targetIndex >= order.length || targetIndex === from) return
    order.splice(from, 1)
    order.splice(targetIndex, 0, sku)
    void saveOrder(order, '已调整顺序')
  }

  /**
   * 拖动排序：把 sku 插到 target 前（after 为 true 时插到后）。
   * 只在当前可见的组之间移动，被搜索隐藏的组留在原位，相对顺序不变。
   */
  function dropOrder(sku, target, after, visible) {
    const order = sortedGroups().map((group) => group.sku)
    const shown = visible.filter((entry) => order.includes(entry))
    if (sku === target || !shown.includes(sku) || !shown.includes(target)) return null
    const moved = shown.filter((entry) => entry !== sku)
    moved.splice(moved.indexOf(target) + (after ? 1 : 0), 0, sku)
    let next = 0
    const result = order.map((entry) => shown.includes(entry) ? moved[next++] : entry)
    return result.every((entry, index) => entry === order[index]) ? null : result
  }

  /** 把一张图移到同栏另一张的前 / 后，保存组内顺序 */
  async function moveItem(sku, kind, file, target, after) {
    const group = groupOf(sku)
    const key = { garment: 'garments', model: 'models', crop: 'crops' }[kind]
    const previous = group[key].slice()
    const order = previous.filter((entry) => entry !== file)
    order.splice(order.indexOf(target) + (after ? 1 : 0), 0, file)
    group[key] = order
    render()
    try {
      await api('POST', '/api/collection/item-order', { sku, kind, order })
      // 裁图顺序决定固定服装的默认参考图：重新取一次视图
      if (kind === 'crop') await refresh().catch(() => undefined)
      UI.toast('已调整顺序')
    } catch (error) {
      group[key] = previous
      render()
      UI.toast(error.message, { error: true })
    }
  }

  /** 删除衣服图（连同由它裁出的裁图）、模特图或成图：移到 成图/_runs/已删除/，toast 里可撤销 */
  async function deleteItem(sku, file) {
    try {
      const result = await api('POST', '/api/item/delete', { sku, file })
      offOf(offGarments, sku).delete(file)
      offOf(offModels, sku).delete(file)
      await refresh().catch(() => undefined)
      const crops = result.files.length - 1
      UI.toast('已删除 ' + base(file) + (crops > 0 ? '（含裁图 ' + crops + ' 张）' : ''), {
        action: {
          label: '撤销',
          run: () => {
            void api('POST', '/api/item/restore', { sku, id: result.id })
              .then(() => refresh())
              .catch((error) => UI.toast(error.message, { error: true }))
          },
        },
      })
    } catch (error) {
      UI.toast(error.message, { error: true })
    }
  }

  function toggleFold(sku) {
    folded.has(sku) ? folded.delete(sku) : folded.add(sku)
    save(FOLDED_KEY, JSON.stringify([...folded]))
    renderList()
  }

  // ---------- 放图 ----------

  /** 前端先挡掉格式与大小不对的文件，文案与服务端一致；服务端仍会再校验 */
  function precheck(file) {
    if (!ALLOWED.test(file.name)) return file.name + '：只支持 jpg、png、webp'
    if (file.size > MAX_BYTES) return file.name + '：超过 50 MB'
    return null
  }

  /** 放图：同一款正在上传时，新放的图排进该款队列，前一批放完后接着放 */
  async function uploadFiles(sku, kind, files) {
    if (files.length === 0) return
    if (uploads.has(sku)) {
      if (!queues.has(sku)) queues.set(sku, [])
      queues.get(sku).push({ kind, files })
      renderList()
      return
    }
    uploading += 1
    let batch = { kind, files }
    while (batch !== undefined) {
      const ok = await uploadBatch(sku, batch.kind, batch.files)
      const next = (queues.get(sku) || []).shift()
      if (next === undefined) {
        queues.delete(sku)
        uploads.delete(sku)
        uploading -= 1
        await refresh()
      } else {
        uploads.set(sku, { kind: next.kind, done: 0, total: next.files.length })
        // 先刷新显示上一批放进去的图；刷新失败不打断后面的批次
        await refresh().catch(() => undefined)
      }
      // 图已显示在页面上再提示成功
      if (ok > 0) UI.toast(KIND_TEXT[batch.kind] + '放入成功 ' + ok + ' 张')
      batch = next
    }
  }

  /** 逐张串行写入一批，单张失败不影响其它张；失败逐张出错误 toast，返回成功张数 */
  async function uploadBatch(sku, kind, files) {
    let ok = 0
    uploads.set(sku, { kind, done: 0, total: files.length })
    render()
    for (const file of files) {
      const reason = precheck(file)
      if (reason !== null) UI.toast(reason, { error: true })
      else {
        const query = 'sku=' + encodeURIComponent(sku) + '&kind=' + kind + '&name=' + encodeURIComponent(file.name)
        try {
          const response = await fetch('/api/upload?' + query, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file })
          const data = await response.json().catch(() => ({}))
          if (!response.ok) UI.toast((data.error && data.error.message) || (file.name + '：放入失败'), { error: true })
          else ok += 1
        } catch (error) {
          UI.toast(file.name + '：' + error.message, { error: true })
        }
      }
      uploads.get(sku).done += 1
      renderList()
    }
    return ok
  }

  // ---------- 数据 ----------

  async function refresh() {
    const before = view === null ? null : view.activeRun
    view = await api('GET', '/api/collection')
    if (before !== null && (view.activeRun === null || view.activeRun.runId !== before.runId)) finished(before)
    // 已写入文件夹的新款不再是页面内的临时卡片
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      if (view.groups.some((group) => group.sku === pending[index])) pending.splice(index, 1)
    }
    for (const sku of [...picked]) {
      const group = groupOf(sku)
      if (group === undefined || !pickable(group)) picked.delete(sku)
    }
    render()
    watchRun()
  }

  /** 有出图在跑时每 5 秒查进度，结束后整页刷新成图 */
  function watchRun() {
    if (view.activeRun === null || polling !== null) return
    polling = setInterval(() => {
      void api('GET', '/api/collection').then((next) => {
        if (next.activeRun === null) {
          clearInterval(polling)
          polling = null
          return refresh()
        }
        view.activeRun = next.activeRun
        renderTop()
        renderBar()
        return undefined
      }).catch(() => undefined)
    }, BUSY_POLL_MS)
  }

  /** run 结束：按合集视图里该 run 交付的成图与失败项汇总出 toast */
  function finished(run) {
    const delivered = view.groups.reduce((sum, group) => sum + group.outputs.filter((output) => output.runId === run.runId).length, 0)
    const failed = view.groups.reduce((sum, group) => sum + group.inFlight.filter((shot) => shot.runId === run.runId && shot.state === 'failed').length, 0)
    if (stopped.has(run.runId) || delivered + failed < run.total) {
      UI.toast('已停止 · 已交付 ' + delivered + ' 张')
      return
    }
    UI.toast('出图完成 · 交付 ' + delivered + ' 张 · 失败 ' + failed + ' 张', { link: { label: '查看出图记录', href: '/runs/' + encodeURIComponent(run.runId) + '/' } })
  }

  /** 停止出图：先工作表确认，再调取消接口 */
  async function stopRun() {
    const active = view.activeRun
    if (active === null) return
    const ok = await UI.confirm({ title: '停止出图？', text: '已交付的图会保留，排队中的不再生成。', ok: '停止', danger: true })
    if (!ok || view.activeRun === null || view.activeRun.runId !== active.runId) return
    stopped.add(active.runId)
    try {
      await api('POST', '/api/runs/' + encodeURIComponent(active.runId) + '/cancel', {})
    } catch (error) {
      stopped.delete(active.runId)
      UI.toast(error.message, { error: true })
      return
    }
    await refresh().catch(() => undefined)
  }

  async function addSku() {
    const input = document.getElementById('cl-new-sku')
    try {
      const { sku } = await api('POST', '/api/sku', { sku: input.value })
      if (pending.includes(sku)) throw new Error('款号已存在：' + sku)
      pending.push(sku)
      input.value = ''
      render()
    } catch (error) {
      UI.toast(error.message, { error: true })
    }
  }

  /** 一款的出图选择（NewRunRequest.groups 的一项）；编辑抽屉里的改动合进来 */
  function selectionOf(group) {
    const selection = { models: selectedModels(group) }
    if (group.prefs.pairing !== 'fixedGarment') selection.garments = selectedGarments(group)
    if (swapOf(group.sku) !== 'outfit') selection.swap = swapOf(group.sku)
    const edited = drawer() === undefined ? null : drawer().selection(group.sku)
    return edited === null ? selection : { ...edited, ...selection }
  }

  async function submit(only) {
    const engine = engineOf()
    if (engine === 'apimart' && !(await UI.confirm({ title: '用 apimart 出图？', text: 'apimart 会产生真实费用，确定用它出图吗？', ok: '确定出图' }))) return
    const list = only === undefined ? pickedGroups() : [groupOf(only)]
    const selections = {}
    let count = 0
    for (const group of list) {
      if (!pickable(group) || plan(group).count === 0) continue
      selections[group.sku] = selectionOf(group)
      count += plan(group).count
    }
    const swapAll = segValue(document.getElementById('cl-swap-all'))
    const body = {
      groups: selections,
      ...(swapAll !== 'each' ? { swap: swapAll } : {}),
      ...(document.getElementById('cl-keep-all').getAttribute('aria-checked') === 'true' ? { keepFrame: true } : {}),
      ...(engine ? { engine } : {}),
    }
    sending = true
    render()
    try {
      const result = await api('POST', '/api/new-run', body)
      sending = false
      UI.toast('开始出图 · 共 ' + count + ' 张', { link: { label: '查看出图记录', href: result.url } })
      // 留在合集页：先记下本页发起的 run，刷新后底栏显示进度；刷新前已跑完也会出结束汇总
      view.activeRun = { runId: result.runId, done: 0, total: count }
      await refresh().catch(() => undefined)
    } catch (error) {
      sending = false
      if (error.code === 'RUN_IN_PROGRESS') await refresh().catch(() => undefined)
      render()
      UI.toast(error.message, { error: true })
    }
  }

  // ---------- 事件 ----------

  function buildTop() {
    document.getElementById('cl-top').innerHTML = '<div class="cl-top-in">' +
      '<a class="cl-btn" href="/projects">项目</a>' +
      '<div class="cl-brand"><h1 id="cl-name">合集</h1><span id="cl-info"></span></div>' +
      UI.segHtml('data-cl="mode"', [{ value: 'place', label: '放图' }, { value: 'node', label: '节点' }], mode, '模式') +
      '<span class="cl-spacer"></span>' +
      '<input id="cl-size" type="range" min="' + TILE_MIN + '" max="' + TILE_MAX + '" step="1" aria-label="缩略图大小" title="缩略图大小">' +
      '<input id="cl-search" type="search" placeholder="搜索款号" aria-label="搜索款号">' +
      '<span id="cl-progress" class="cl-chip" hidden></span>' +
      '<button type="button" class="cl-btn" id="cl-sort-sku">按款号排序</button>' +
      '<button type="button" class="cl-btn" id="cl-refresh">刷新</button>' +
      '<span class="cl-new"><input id="cl-new-sku" maxlength="64" placeholder="新款号" aria-label="新款号"><button type="button" class="cl-btn" id="cl-new">新建款</button></span></div>'
  }

  /** 缩略图大小：写入 CSS 变量 --cl-tile，本浏览器记住 */
  function setTile(size) {
    const value = Math.min(TILE_MAX, Math.max(TILE_MIN, Math.round(Number(size)) || TILE_DEFAULT))
    document.documentElement.style.setProperty('--cl-tile', value + 'px')
    return value
  }

  /** 抽屉与待重出面板同位置、互斥 */
  function openDrawer(sku) {
    if (drawer() === undefined) return
    closeRedo()
    drawer().open(sku)
  }

  const skuOf = (element) => element.closest('.cl-group').dataset.sku
  /** 放图区：放图模式的整栏（衣服栏、模特栏）、节点模式的衣服节点 */
  const DROP_ZONES = '.cl-col, .cl-node-garments'
  const EDIT_NODES = '.cl-node-garments, .cl-node-set'
  const hasFiles = (event) => event.dataTransfer && [...event.dataTransfer.types].includes('Files')

  /** 组头、设置节点、抽屉改了规则 / 范围 / 画幅：规则与画幅按款串行保存，范围只在页面里 */
  function changeSetting(sku, kind, value) {
    if (kind === 'pairing') void savePrefs(sku, { pairing: value })
    else if (kind === 'keep') void savePrefs(sku, { keepFrame: value })
    else if (kind === 'swap') {
      swaps.set(sku, value)
      render()
    }
  }

  /** 把缩略图设为当前聚焦（同页只有一张 is-focus） */
  function markFocus(tile) {
    focused = { ql: tile.dataset.ql, file: tile.dataset.file }
    document.querySelectorAll('#cl-list .cl-tile.is-focus').forEach((el) => { if (el !== tile) el.classList.remove('is-focus') })
    tile.classList.add('is-focus')
  }

  /** 快速预览该缩略图所在栏，从这张开始 */
  function quickLookFrom(tile) {
    const list = [...document.querySelectorAll('#cl-list .cl-tile[data-ql="' + CSS.escape(tile.dataset.ql) + '"]')]
    UI.quickLook(list.map((el) => ({ src: sourceUrl(el.dataset.file), name: base(el.dataset.file) })), list.indexOf(tile))
  }

  function bindEvents() {
    // 拖到放置区外松手时不让浏览器直接打开图片
    document.addEventListener('dragover', (event) => { if (hasFiles(event)) event.preventDefault() })
    document.addEventListener('drop', (event) => { if (hasFiles(event)) event.preventDefault() })

    const top = document.getElementById('cl-top')
    top.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target.closest('button') : null
      if (target === null) return
      if (target.id === 'cl-refresh') void refresh()
      else if (target.id === 'cl-new') void addSku()
      else if (target.id === 'cl-sort-sku') void saveOrder([])
    })
    top.addEventListener('keydown', (event) => {
      if (event.target instanceof HTMLElement && event.target.id === 'cl-new-sku' && event.key === 'Enter') void addSku()
    })
    top.addEventListener('ui-change', (event) => {
      if (!(event.target instanceof HTMLElement) || event.target.dataset.cl !== 'mode') return
      mode = event.detail.value
      save(MODE_KEY, mode)
      render()
    })
    const search = document.getElementById('cl-search')
    search.addEventListener('input', renderList)
    search.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      search.value = ''
      search.blur()
      renderList()
    })
    const size = document.getElementById('cl-size')
    size.value = String(setTile(load(TILE_KEY) || TILE_DEFAULT))
    size.addEventListener('input', () => save(TILE_KEY, String(setTile(size.value))))
    // ⌘F / Ctrl+F 聚焦搜索；⌘↩ / Ctrl+↩ 等同点「出图」
    document.addEventListener('keydown', (event) => {
      if (!(event.metaKey || event.ctrlKey)) return
      if (event.key.toLowerCase() === 'f') {
        event.preventDefault()
        search.focus()
        search.select()
      } else if (event.key === 'Enter') {
        event.preventDefault()
        if (!document.getElementById('ed-go').disabled) void submit()
      }
    })

    const list = document.getElementById('cl-list')
    let dragging = null
    const clearMarks = () => list.querySelectorAll('.is-dragging, .drop-before, .drop-after').forEach((el) => el.classList.remove('is-dragging', 'drop-before', 'drop-after'))
    // 组内拖图排序：只在同款同栏内移动
    let itemDrag = null
    const itemTarget = (event) => {
      if (itemDrag === null || !(event.target instanceof Element)) return null
      const el = event.target.closest('.cl-tile[data-drag="' + itemDrag.kind + '"]')
      if (el === null || skuOf(el) !== itemDrag.sku || el.dataset.file === itemDrag.file) return null
      const rect = el.getBoundingClientRect()
      return { el, after: event.clientX >= rect.left + rect.width / 2 }
    }
    list.addEventListener('dragstart', (event) => {
      const tile = event.target instanceof Element ? event.target.closest('.cl-tile[data-drag]') : null
      if (tile !== null) {
        itemDrag = { sku: skuOf(tile), kind: tile.dataset.drag, file: tile.dataset.file }
        event.dataTransfer.setData(ITEM_TYPE, tile.dataset.file)
        event.dataTransfer.effectAllowed = 'move'
        tile.classList.add('is-dragging')
        return
      }
      const handle = event.target instanceof Element ? event.target.closest('.cl-no[draggable="true"]') : null
      if (handle === null) return
      dragging = skuOf(handle)
      event.dataTransfer.setData(SKU_TYPE, dragging)
      event.dataTransfer.effectAllowed = 'move'
      handle.closest('.cl-group').classList.add('is-dragging')
    })
    list.addEventListener('dragend', () => {
      itemDrag = null
      dragging = null
      clearMarks()
    })
    list.addEventListener('dragover', (event) => {
      if (!(event.target instanceof Element) || !event.dataTransfer) return
      if ([...event.dataTransfer.types].includes(ITEM_TYPE)) {
        const hit = itemTarget(event)
        list.querySelectorAll('.drop-before, .drop-after').forEach((el) => { if (hit === null || el !== hit.el) el.classList.remove('drop-before', 'drop-after') })
        if (hit === null) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        hit.el.classList.toggle('drop-after', hit.after)
        hit.el.classList.toggle('drop-before', !hit.after)
        return
      }
      if ([...event.dataTransfer.types].includes(SKU_TYPE)) {
        const card = event.target.closest('.cl-group')
        if (card === null) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        // 上半部插到前面，下半部插到后面
        const rect = card.getBoundingClientRect()
        const mark = event.clientY < rect.top + rect.height / 2 ? 'drop-before' : 'drop-after'
        if (!card.classList.contains(mark)) {
          list.querySelectorAll('.drop-before, .drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'))
          card.classList.add(mark)
        }
        return
      }
      const zone = event.target.closest(DROP_ZONES)
      if (zone === null || !hasFiles(event)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
      list.querySelectorAll('.is-over').forEach((el) => { if (el !== zone) el.classList.remove('is-over') })
      zone.classList.add('is-over')
    })
    list.addEventListener('dragleave', (event) => {
      const zone = event.target instanceof Element ? event.target.closest(DROP_ZONES) : null
      if (zone !== null && !zone.contains(event.relatedTarget)) zone.classList.remove('is-over')
    })
    list.addEventListener('drop', (event) => {
      if (!(event.target instanceof Element) || !event.dataTransfer) return
      if ([...event.dataTransfer.types].includes(ITEM_TYPE)) {
        const hit = itemTarget(event)
        const moving = itemDrag
        clearMarks()
        itemDrag = null
        if (hit === null || moving === null) return
        event.preventDefault()
        void moveItem(moving.sku, moving.kind, moving.file, hit.el.dataset.file, hit.after)
        return
      }
      if ([...event.dataTransfer.types].includes(SKU_TYPE)) {
        const card = event.target.closest('.cl-group')
        if (card === null || dragging === null) return
        event.preventDefault()
        const rect = card.getBoundingClientRect()
        const visible = [...list.querySelectorAll('section.cl-group')].map((el) => el.dataset.sku)
        const order = dropOrder(dragging, card.dataset.sku, event.clientY >= rect.top + rect.height / 2, visible)
        clearMarks()
        if (order !== null) void saveOrder(order, '已调整顺序')
        return
      }
      const zone = event.target.closest(DROP_ZONES)
      if (zone === null) return
      event.preventDefault()
      zone.classList.remove('is-over')
      void uploadFiles(skuOf(zone), zone.dataset.kind, [...event.dataTransfer.files])
    })

    list.addEventListener('change', (event) => {
      const target = event.target
      if (!(target instanceof HTMLElement) || target.closest('.cl-group') === null) return
      const sku = skuOf(target)
      if (target instanceof HTMLInputElement && target.type === 'file') {
        const files = [...target.files]
        target.value = ''
        void uploadFiles(sku, target.closest('.cl-drop').dataset.kind, files)
      } else if (target.classList.contains('cl-pick')) {
        target.checked ? picked.add(sku) : picked.delete(sku)
        render()
      }
    })

    // 组头与设置节点的规则、范围、画幅
    list.addEventListener('ui-change', (event) => {
      const root = event.target
      if (!(root instanceof HTMLElement) || root.closest('.cl-group') === null || root.closest('.cl-head, .cl-setnode') === null) return
      changeSetting(skuOf(root), root.dataset.cl, event.detail.value)
    })
    // 抽屉的规则、范围、画幅（面板里的范围由面板自己处理）
    document.addEventListener('ui-change', (event) => {
      const root = event.target
      const drawerEl = root instanceof HTMLElement ? root.closest('#cl-drawer') : null
      if (drawerEl === null || root.closest('.ed-panel') !== null || root.dataset.cl === undefined) return
      const sku = drawerEl.dataset.sku
      if (sku === undefined || groupOf(sku) === undefined) return
      changeSetting(sku, root.dataset.cl, event.detail.value)
    })

    list.addEventListener('click', (event) => {
      const node = event.target instanceof Element ? event.target.closest(EDIT_NODES) : null
      if (node !== null) {
        // 设置节点上的分段控件、开关只改设置，不开抽屉
        if (event.target.closest('.ui-seg, .ui-switch') !== null) return
        openDrawer(skuOf(node))
        return
      }
      const target = event.target instanceof Element ? event.target.closest('button, .cl-tile') : null
      if (target === null || target.closest('.cl-group') === null) return
      const sku = skuOf(target)
      const group = groupOf(sku)
      if (target.classList.contains('cl-fold')) toggleFold(sku)
      else if (target.classList.contains('cl-more')) {
        UI.menu(target, [
          { value: 'first', label: '移到最前' },
          { value: 'last', label: '移到最后' },
          { value: 'fold', label: folded.has(sku) ? '展开' : '折叠', separatorBefore: true },
        ], (value) => {
          if (value === 'fold') toggleFold(sku)
          else moveTo(sku, value === 'first' ? 0 : sortedGroups().length - 1)
        })
      }
      else if (target.classList.contains('cl-only')) void submit(sku)
      else if (target.classList.contains('cl-del')) void deleteItem(sku, target.dataset.file)
      else if (target.classList.contains('cl-edit')) openDrawer(sku)
      else if (target.classList.contains('cl-ver') || target.classList.contains('cl-cmp')) openCompare(target.dataset.file)
      else if (target.classList.contains('cl-add-redo') || target.classList.contains('cl-addredo')) void toggleRedo(target.dataset.file)
      else if (target.classList.contains('cl-node-model')) {
        // 固定模特的「衣服 + 模特」行切换这件衣服，其余切换模特
        const item = target.dataset.item
        const byItem = item !== '' && group.prefs.pairing === 'fixedModel'
        const off = offOf(byItem ? offGarments : offModels, sku)
        const file = byItem ? item : target.dataset.model
        off.has(file) ? off.delete(file) : off.add(file)
        if (!pickable(group)) picked.delete(sku)
        render()
      }
      else if (target.classList.contains('cl-half')) {
        // 基于当前（含未保存完）的半身标记切换，连点两次 = 加上再去掉
        const file = target.dataset.file
        const half = group.prefs.halfModels.includes(file) ? group.prefs.halfModels.filter((entry) => entry !== file) : [...group.prefs.halfModels, file]
        void savePrefs(sku, { halfModels: half })
      } else if (target.classList.contains('cl-tile')) {
        markFocus(target)
        // 只有可选的图点击切换选中；其余缩略图点击只聚焦
        if (!target.classList.contains('is-pick')) return
        const kind = target.closest('.cl-col').dataset.kind
        const off = offOf(kind === 'model' ? offModels : offGarments, sku)
        const file = target.dataset.file
        off.has(file) ? off.delete(file) : off.add(file)
        if (!pickable(group)) picked.delete(sku)
        render()
      }
    })

    // 双击成图直接打开对照（悬停按钮上的双击不算）
    list.addEventListener('dblclick', (event) => {
      const target = event.target instanceof Element ? event.target : null
      const tile = target !== null && target.closest('button') === null ? target.closest('.cl-tile.cl-out') : null
      if (tile !== null) openCompare(tile.dataset.file)
    })

    // 回车切换可选缩略图（空格留给快速预览）
    list.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || !(event.target instanceof Element) || !event.target.matches('.cl-tile.is-pick')) return
      event.preventDefault()
      event.target.click()
    })
    // Tab 或点击聚焦缩略图：设为 is-focus
    list.addEventListener('focusin', (event) => {
      const tile = event.target instanceof Element ? event.target.closest('.cl-tile[data-ql]') : null
      if (tile !== null) markFocus(tile)
    })
    // 空格：从聚焦的缩略图打开快速预览（输入框、按钮等控件上不拦）
    document.addEventListener('keydown', (event) => {
      if (event.key !== ' ' || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target instanceof Element ? event.target : null
      if (target !== null && !target.matches('.cl-tile') && target.closest('input, textarea, select, button, a, [contenteditable], [role]') !== null) return
      const tile = target !== null && target.matches('.cl-tile[data-ql]') ? target : list.querySelector('.cl-tile.is-focus')
      if (tile === null) return
      event.preventDefault()
      quickLookFrom(tile)
    })

    list.addEventListener('keydown', (event) => {
      // 只认节点本身有焦点（节点里的按钮、控件按自己的方式响应）
      const node = event.target instanceof Element && event.target.matches(EDIT_NODES) ? event.target : null
      if (node === null || (event.key !== 'Enter' && event.key !== ' ')) return
      event.preventDefault()
      openDrawer(skuOf(node))
    })

    document.getElementById('ed-bar').addEventListener('ui-change', renderBar)
    document.getElementById('ed-go').addEventListener('click', () => { void submit() })
    document.getElementById('cl-stop').addEventListener('click', () => { void stopRun() })

    // 有未出图的编辑才拦离开；只勾选不拦
    window.addEventListener('beforeunload', (event) => {
      if (sending || drawer() === undefined || !groups().some((group) => drawer().selection(group.sku) !== null)) return
      event.preventDefault()
      event.returnValue = ''
    })
  }

  // ---------- 成图对照 ----------

  /** 每件衣服默认用的参考图：裁图顺序里第一张由它裁出的裁图，没有则用原图（与抽屉一致） */
  function defaultItemRef(group, garment) {
    return group.crops.find((crop) => group.cropFrom[crop] === garment) || garment
  }

  /** 这件衣服出图用的参考图：抽屉里改过的优先，否则默认 */
  function itemRefOf(group, garment) {
    const edited = drawer() === undefined ? null : drawer().selection(group.sku)
    const refs = edited !== null && edited.itemRefs !== undefined ? edited.itemRefs : {}
    return refs[garment] || defaultItemRef(group, garment)
  }

  /** 成图所在的款与组合行（同一组合的全部版本） */
  function compareOf(file) {
    const group = view === null ? undefined : view.groups.find((entry) => entry.outputs.some((output) => output.file === file))
    if (group === undefined) return null
    const row = laneRows(group).find((entry) => entry.outputs.some((output) => output.file === file))
    return row === undefined ? null : { group, row, output: row.outputs.find((output) => output.file === file) }
  }

  function figure(file, caption) {
    return '<figure><img src="' + esc(sourceUrl(file)) + '" alt=""><figcaption>' + esc(caption) + '</figcaption></figure>'
  }

  function renderCompare() {
    const modal = document.getElementById('cl-cmp')
    if (modal === null || cmp === null) return
    const found = compareOf(cmp.file)
    if (found === null) {
      closeModal(modal)
      return
    }
    const { group, row, output } = found
    // 有出图记录的用那次实际用的参考图（固定服装可能多张）；手放或没有记录的才按当前设置推断
    const refs = output.refs.length > 0 ? output.refs : row.item === null ? [...usedRefs(group)] : [itemRefOf(group, row.item)]
    const name = row.model === null ? row.label : (row.item === null ? '' : base(row.item) + ' + ') + base(row.model)
    document.getElementById('cl-cmp-title').textContent = group.sku + ' · ' + name
    // 版本分段控件：重画后焦点在控件里时找回选中项
    const tabs = modal.querySelector('.cl-vtabs')
    const focused = tabs.contains(document.activeElement)
    tabs.innerHTML = UI.segHtml('data-cl="version"', row.outputs.map((entry) => ({ value: entry.file, label: 'v' + entry.version })), output.file, '版本')
    if (focused) tabs.querySelector('[aria-checked="true"]').focus()
    document.getElementById('cl-cmp-body').innerHTML =
      // 左服装、中成图、右模特
      (refs.length === 0 ? '' : refs.length === 1 ? figure(refs[0], '服装图 · ' + base(refs[0])) :
        '<figure class="cl-refs"><div>' + refs.map((file) => '<img src="' + esc(sourceUrl(file)) + '" alt="" title="' + esc(base(file)) + '">').join('') + '</div><figcaption>服装图 ' + refs.length + ' 张 · ' + refs.map((file) => esc(base(file))).join('、') + '</figcaption></figure>') +
      figure(output.file, '成图 v' + output.version) +
      (row.model === null ? '' : figure(row.model, '模特图 · ' + base(row.model)))
    const add = document.getElementById('cl-cmp-add')
    const link = document.getElementById('cl-cmp-run')
    const queued = view.redo.some((entry) => entry.delivered === output.file)
    add.hidden = output.runId === null
    add.textContent = queued ? '移出待重出' : '加入待重出'
    link.hidden = output.runId === null
    if (output.runId !== null) link.href = '/runs/' + encodeURIComponent(output.runId) + '/'
  }

  function openCompare(file) {
    if (compareOf(file) === null) return
    cmp = { file }
    const modal = document.getElementById('cl-cmp')
    modal.hidden = false
    if (popCompare === null) popCompare = UI.pushLayer(() => closeModal(modal))
    renderCompare()
    document.getElementById('cl-cmp-close').focus()
  }

  // ---------- 待重出 ----------

  function redoItemHtml(entry) {
    const group = view.groups.find((candidate) => candidate.sku === entry.sku)
    const output = group === undefined ? undefined : group.outputs.find((candidate) => candidate.file === entry.delivered)
    const match = VERSION.exec(stemOf(entry.delivered))
    const version = output !== undefined ? output.version : match === null ? 1 : Number(match[2])
    return '<li class="cl-redo-item" data-delivered="' + esc(entry.delivered) + '">' +
      '<img src="' + esc(thumbUrl(entry.delivered)) + '" alt="" loading="lazy">' +
      '<div class="cl-redo-t">' + esc(entry.sku) + ' · ' + (entry.item ? esc(base(entry.item)) + ' + ' : '') + esc(base(entry.model)) + ' <small>v' + version + '</small>' +
      '<input class="cl-redo-note" maxlength="200" placeholder="备注（选填，写进提示词末尾）" aria-label="备注" value="' + esc(entry.note || '') + '"></div>' +
      '<button type="button" class="cl-btn cl-redo-del" aria-label="移出待重出">×</button></li>'
  }

  function renderRedo() {
    const modal = document.getElementById('cl-redo')
    if (modal === null || modal.hidden) return
    const list = modal.querySelector('.cl-redo-list')
    // 正在输入备注时不重画，免得冲掉输入
    if (!list.contains(document.activeElement)) {
      list.innerHTML = view.redo.map(redoItemHtml).join('') || '<li class="cl-redo-none">还没有。在成图上点「＋待重出」或在对照里点「加入待重出」。</li>'
    }
    const go = document.getElementById('cl-redo-go')
    go.textContent = '重出这 ' + view.redo.length + ' 张'
    go.disabled = !canStart() || view.redo.length === 0
  }

  /** 待重出改为右侧面板：与抽屉互斥，Esc 关闭 */
  function openRedo() {
    const modal = document.getElementById('cl-redo')
    if (drawer() !== undefined) drawer().close()
    document.getElementById('cl-redo-msg').innerHTML = ''
    modal.hidden = false
    if (popRedo === null) popRedo = UI.pushLayer(closeRedo)
    renderRedo()
    document.getElementById('cl-redo-close').focus()
  }

  function closeRedo() {
    const modal = document.getElementById('cl-redo')
    if (modal !== null) closeModal(modal)
  }

  /** 移出待重出：服务端确认后出带「撤销」的 toast，撤销以原备注重新加入 */
  function removeRedo(button) {
    const item = button.closest('.cl-redo-item')
    const delivered = item.dataset.delivered
    const entry = view.redo.find((candidate) => candidate.delivered === delivered)
    // 等服务端确认后由 render 重画；先移开焦点，否则列表含焦点不会重画。失败时这项留在列表里
    button.disabled = true
    button.blur()
    void editRedo({ action: 'remove', delivered }).then(() => {
      if (item.isConnected) {
        button.disabled = false
        return
      }
      if (entry === undefined) return
      UI.toast('已移除 ' + base(entry.model), {
        action: { label: '撤销', run: () => { void editRedo({ action: 'add', delivered, ...(entry.note ? { note: entry.note } : {}) }) } },
      })
    })
  }

  async function runRedo() {
    const engine = engineOf()
    if (engine === 'apimart' && !(await UI.confirm({ title: '用 apimart 出图？', text: 'apimart 会产生真实费用，确定用它出图吗？', ok: '确定出图' }))) return
    sending = true
    render()
    const message = document.getElementById('cl-redo-msg')
    message.innerHTML = ''
    try {
      // 先等备注写完
      await redoChain
      const count = view.redo.length
      const result = await api('POST', '/api/redo/run', engine ? { engine } : {})
      sending = false
      closeRedo()
      UI.toast('已开始重出 ' + count + ' 张', { link: { label: '查看出图记录', href: result.url } })
      // 留在合集页：刷新后底栏显示出图进度
      await refresh().catch(() => undefined)
    } catch (error) {
      sending = false
      if (error.code === 'RUN_IN_PROGRESS') await refresh().catch(() => undefined)
      render()
      message.innerHTML = '<span class="ed-err">' + esc(error.message) + '</span>'
    }
  }

  function closeModal(modal) {
    modal.hidden = true
    if (modal.id === 'cl-cmp') {
      cmp = null
      if (popCompare !== null) popCompare()
      popCompare = null
    } else if (modal.id === 'cl-redo') {
      if (popRedo !== null) popRedo()
      popRedo = null
    }
  }

  /** 对照里 ← / → 切换版本（上面还有工作表、预览、菜单时不切） */
  function stepVersion(event) {
    if (cmp === null || event.defaultPrevented || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return
    if (event.target instanceof Element && event.target.closest('input, textarea') !== null) return
    if (document.querySelector('.ui-sheet, .ui-ql, .ui-menu.on') !== null) return
    const found = compareOf(cmp.file)
    if (found === null) return
    const list = found.row.outputs
    const index = list.indexOf(found.output)
    event.preventDefault()
    cmp = { file: list[(index + (event.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length].file }
    renderCompare()
  }

  function buildModals() {
    document.body.insertAdjacentHTML('beforeend',
      '<div id="cl-cmp" class="cl-modal cl-compare" role="dialog" aria-modal="true" aria-labelledby="cl-cmp-title" hidden><div class="cl-box">' +
      '<div class="cl-box-head"><b id="cl-cmp-title"></b><span class="cl-vtabs"></span>' +
      '<button type="button" class="cl-btn" id="cl-cmp-add">加入待重出</button>' +
      '<a class="cl-btn" id="cl-cmp-run" href="#">出图记录</a>' +
      '<button type="button" class="cl-btn cl-close-x" id="cl-cmp-close">关闭</button></div>' +
      '<div id="cl-cmp-body" class="cl-pair"></div></div></div>' +
      '<aside id="cl-redo" class="cl-side" role="dialog" aria-labelledby="cl-redo-title" hidden>' +
      '<div class="cl-side-head"><b id="cl-redo-title">待重出</b>' +
      '<button type="button" class="cl-btn cl-close-x" id="cl-redo-close">关闭</button></div>' +
      '<ul class="cl-redo-list"></ul>' +
      '<p class="cl-redo-tip">每张按产出它的那次出图的参考图、范围和提示词重出，备注接在提示词末尾。</p>' +
      '<div class="cl-redo-foot"><button type="button" class="cl-btn" id="cl-redo-go" disabled>重出这 0 张</button><span id="cl-redo-msg"></span></div>' +
      '</aside>')
  }

  function bindModals() {
    const cmpModal = document.getElementById('cl-cmp')
    const redoModal = document.getElementById('cl-redo')
    cmpModal.addEventListener('click', (event) => {
      // 点遮罩关闭
      if (event.target === cmpModal) {
        closeModal(cmpModal)
        return
      }
      const target = event.target instanceof Element ? event.target.closest('button') : null
      if (target === null) return
      if (target.id === 'cl-cmp-close') closeModal(cmpModal)
      else if (target.id === 'cl-cmp-add' && cmp !== null) void toggleRedo(cmp.file)
    })
    cmpModal.addEventListener('ui-change', (event) => {
      if (!(event.target instanceof HTMLElement) || event.target.dataset.cl !== 'version') return
      cmp = { file: event.detail.value }
      renderCompare()
    })
    document.addEventListener('keydown', stepVersion)
    redoModal.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target.closest('button') : null
      if (target === null) return
      if (target.id === 'cl-redo-close') closeModal(redoModal)
      else if (target.id === 'cl-redo-go') void runRedo()
      else if (target.classList.contains('cl-redo-del')) removeRedo(target)
    })
    // 备注失焦时保存（有改动才发）
    redoModal.addEventListener('change', (event) => {
      const input = event.target
      if (!(input instanceof HTMLInputElement) || !input.classList.contains('cl-redo-note')) return
      const delivered = input.closest('.cl-redo-item').dataset.delivered
      const entry = view.redo.find((candidate) => candidate.delivered === delivered)
      if (entry === undefined || (entry.note || '') === input.value) return
      void editRedo({ action: 'note', delivered, note: input.value })
    })
    document.getElementById('cl-redo-open').addEventListener('click', openRedo)
  }

  window.__COLLECTION__ = {
    view: () => view,
    state: () => ({
      mode,
      picked: [...picked],
      uploading,
      selected: Object.fromEntries(groups().map((group) => [group.sku, { models: selectedModels(group), garments: selectedGarments(group), swap: swapOf(group.sku) }])),
    }),
    render: () => render(),
    openCompare: (file) => openCompare(file),
    refresh: () => refresh(),
    /** 该款当前保存队列完成（测试用） */
    prefsQueue: (sku) => prefsQueues.get(sku) || Promise.resolve(),
  }

  async function init() {
    view = await api('GET', '/api/collection')
    buildTop()
    buildBar()
    buildModals()
    bindEvents()
    bindModals()
    document.body.classList.add('ed-on')
    render()
    watchRun()
    setInterval(() => {
      if (document.visibilityState === 'visible') void fetch('/api/ping').catch(() => undefined)
    }, PING_MS)
  }

  void init().catch((error) => {
    const hint = /合集设置文件损坏/.test(error.message) ? '。修好这个文件，或删掉它（各款恢复默认设置）后刷新' : ''
    document.body.insertAdjacentHTML('beforeend', '<div id="ed-bar"><span class="ed-err">合集页加载失败：' + esc(error.message) + esc(hint) + '</span><button type="button" class="ed-reload">刷新</button></div>')
    document.querySelector('#ed-bar .ed-reload').addEventListener('click', () => location.reload())
  })
})()
