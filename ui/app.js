'use strict'
// Tryon Studio 看板页面：开跑前素材表与设置、判断视图、手动裁切。
// 页面状态全部来自 /api/batch；判断直接调用 JSON API 写入运行记录；SSE 推送变化后增量刷新（只重建变化的行与检视区）。

const TOKEN = new URLSearchParams(location.search).get('token') || ''

// 顺序即数字键 1–8 的顺序，与服务端 regenTags 一致
const REGEN_TAGS = [
  ['color', '颜色偏'],
  ['extra_item', '多了配饰'],
  ['missing_item', '少了单品'],
  ['outside_changed', '下装被换'],
  ['pose_changed', '姿势变了'],
  ['person_changed', '人物变了'],
  ['role_swap', '角色互换'],
  ['other', '其他'],
]
const TAG_LABEL = Object.fromEntries(REGEN_TAGS)
const MODE_LABEL = { fixedClothing: '固定服装', pair: '一对一', fixedModel: '固定模特' }
const SCOPE_LABEL = { full: '全身', top: '上装', bottom: '下装', full_acc: '含配饰' }
const STATUS_TEXT = {
  delivered: '已交付',
  review: '待判断',
  generating: '生成中',
  queued: '排队',
  idle: '未开始',
  incomplete: '素材不全',
  failed: '有失败',
}
const STATUS_CLASS = {
  delivered: 'st-done',
  review: 'st-review',
  generating: 'st-gen',
  queued: 'st-queue',
  idle: 'st-idle',
  incomplete: 'st-bad',
  failed: 'st-bad',
}
const TOAST_MS = 2600
const RECONNECT_MS = 2000
// 页面获得焦点时重扫素材根目录的最小间隔
const RESCAN_MS = 10_000
// 与服务端 validateCropOverride 的短边下限一致
const MIN_CROP_EDGE = 128
// 与服务端 computeCropBox 的自动裁切留白一致（以 1024 为基准）
const CROP_MARGINS = { left: 20, right: 20, top: 22, bottom: 34 }

let view = null
let groups = []
const groupById = new Map()
const tasksByGroup = new Map()
const taskById = new Map()
const assetById = new Map()
// groupId → { el, sig }：签名不变的行不重建
const rows = new Map()
const sel = { groupId: null, taskIndex: 0 }
// 本页交付过的套（撤销时跳回）
const passedHistory = []
let inspectorHtml = ''
let firstThumbWatched = false
// 素材表：取消勾选的组（默认全选）、展开提示词的组与提示词缓存
const unchecked = new Set()
const expanded = new Set()
// groupId → { ok, text }
const prompts = new Map()

function $(id) {
  return document.getElementById(id)
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char])
}

function pad(n) {
  return String(n).padStart(2, '0')
}

function withToken(pathname) {
  const url = new URL(pathname, location.origin)
  url.searchParams.set('token', TOKEN)
  return url.pathname + url.search
}

function assetUrl(assetId, variant) {
  const asset = assetById.get(assetId)
  // 裁后图随手动裁切变化：带上内容摘要避免取到旧图
  const hash = asset && asset.preparedHash ? `&h=${asset.preparedHash.slice(0, 12)}` : ''
  return withToken(`/files/asset/${encodeURIComponent(assetId)}?variant=${variant}${hash}`)
}

function versionUrl(versionId, variant) {
  return withToken(`/files/version/${encodeURIComponent(versionId)}?variant=${variant}`)
}

/** 调用服务端：无 body 为 GET，有 body 为 POST JSON；业务错误以 { ok: false, message } 返回。 */
async function api(path, body) {
  const init = body === undefined
    ? {}
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
  let response
  try {
    response = await fetch(withToken(path), init)
  } catch {
    return { ok: false, code: 'NETWORK_ERROR', message: '连接不到本地服务' }
  }
  let data = {}
  try {
    data = await response.json()
  } catch {
    // 非 JSON 响应按失败处理
  }
  if (!response.ok && data.ok === undefined) {
    return { ok: false, code: `HTTP_${response.status}`, message: data.message || `请求失败（${response.status}）` }
  }
  return data
}

let toastTimer
function toast(message, sub) {
  const el = $('toast')
  el.innerHTML = `<span>${esc(message)}</span>${sub ? `<span class="mono">${esc(sub)}</span>` : ''}`
  el.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove('show'), TOAST_MS)
}

// ---------- 状态索引 ----------

function indexState(state) {
  view = state
  groups = [...state.groups].sort((left, right) => left.order - right.order)
  groupById.clear()
  tasksByGroup.clear()
  taskById.clear()
  assetById.clear()
  for (const group of groups) {
    groupById.set(group.id, group)
    tasksByGroup.set(group.id, [])
  }
  // 组内顺序沿用服务端任务顺序（与交付文件名、提示文案的序号一致）
  for (const task of state.tasks) {
    taskById.set(task.id, task)
    const list = tasksByGroup.get(task.groupId)
    if (list) list.push(task)
  }
  for (const asset of state.assets) assetById.set(asset.id, asset)
}

function currentGroup() {
  return groupById.get(sel.groupId)
}

function currentTasks() {
  return tasksByGroup.get(sel.groupId) || []
}

function currentTask() {
  return currentTasks()[sel.taskIndex]
}

/** 一张图的显示状态。 */
function taskInfo(task) {
  const total = task.versions.length
  let index = task.versions.findIndex((version) => version.id === task.chosenVersionId)
  if (index < 0 && total > 0) index = total - 1
  const version = index >= 0 ? task.versions[index] : undefined
  const busy = task.status === 'queued' || task.status === 'running'
  const regenJob = task.pending.find((job) => job.kind === 'regen')
  return {
    total,
    index,
    version,
    ghost: total === 0,
    busy,
    regenerating: total > 0 && (busy || regenJob !== undefined),
    regenJob,
  }
}

function tagText(regen) {
  if (!regen) return ''
  const labels = regen.tags.map((tag) => TAG_LABEL[tag] || tag)
  if (labels.length === 0 && regen.note) labels.push(regen.note)
  return labels.join('、')
}

function groupMode(group) {
  const mode = group.mode || view.settings.mode
  const scope = group.scope || view.settings.scope
  return `${MODE_LABEL[mode] || mode} · ${SCOPE_LABEL[scope] || scope}`
}

// ---------- 顶栏 ----------

function renderTop() {
  const c = view.counts
  $('batchName').textContent = view.name
  const bad = groups.filter((group) => group.status === 'incomplete' || group.status === 'failed').length
  const parts = [['m-done', c.delivered], ['m-review', c.review], ['m-gen', c.generating], ['m-queue', c.queued], ['m-bad', bad]]
  $('meter').innerHTML = parts.map(([cls, n]) => `<i class="${cls}" style="flex-grow:${n}"></i>`).join('')
  $('counts').innerHTML = [
    `<span>已交付<b>${c.delivered}</b> 套</span>`,
    `<span>待判断<b>${c.review}</b> 套</span>`,
    `<span>生成中<b>${c.generating}</b> 套</span>`,
    c.queued > 0 ? `<span>排队<b>${c.queued}</b> 套</span>` : '',
    `<span class="${c.failed > 0 ? 'bad' : ''}">失败<b>${c.failed}</b> 张</span>`,
  ].join('')
  const price = view.imagePriceCny
  // 预计 = 首轮生成次数；重出会让已用超过首轮预计，此时预计取已用
  const planned = Math.max(c.tasks * view.settings.candidates, c.generationCalls)
  const used = price === undefined
    ? `已用 <b>${c.generationCalls}</b> 次生成`
    : `已用 <b>¥${(c.generationCalls * price).toFixed(1)}</b> / 预计 <b>¥${(planned * price).toFixed(1)}</b>`
  const running = groups.some((group) => group.started)
  $('meta').innerHTML = running ? used : `并发 <b>${view.settings.concurrency}</b> · ${used}`
}

// ---------- 设置条与运行控制 ----------

function optionsHtml(labels, value) {
  return Object.entries(labels)
    .map(([key, label]) => `<option value="${esc(key)}"${String(key) === String(value) ? ' selected' : ''}>${esc(label)}</option>`)
    .join('')
}

function rangeLabels(from, to) {
  const labels = {}
  for (let n = from; n <= to; n += 1) labels[n] = String(n)
  return labels
}

/** 聚焦中的下拉框不改值，避免打断用户操作。 */
function setSelect(select, value) {
  if (select && document.activeElement !== select) select.value = String(value)
}

/** 未开始（且未交付）的组：在素材表中显示为素材行。 */
function isSetupGroup(group) {
  return !group.started && !group.delivered
}

/** 仍会被调度的任务（素材已变化的旧任务不计）。 */
function activeTasksOf(groupId) {
  return (tasksByGroup.get(groupId) || []).filter((task) => !(task.error && task.error.code === 'INPUT_CHANGED'))
}

/** 已勾选、可开始的组。 */
function checkedGroups() {
  return groups.filter((group) => isSetupGroup(group) && group.status === 'idle' && !unchecked.has(group.id))
}

function renderSetup() {
  const el = $('setup')
  // 素材不全的组不能开始，只有它们时不显示设置条
  const show = groups.some((group) => isSetupGroup(group) && group.status === 'idle')
  el.hidden = !show
  if (!show) return
  if (!el.firstChild) {
    el.innerHTML = `<div class="opts">
        <label>搭配模式<select name="mode">${optionsHtml(MODE_LABEL, '')}</select></label>
        <label>换装范围<select name="scope">${optionsHtml(SCOPE_LABEL, '')}</select></label>
        <label>每张候选<select name="candidates">${optionsHtml(rangeLabels(1, 4), '')}</select></label>
        <label>并发<select name="concurrency">${optionsHtml(rangeLabels(1, 10), '')}</select></label>
      </div>
      <div class="sum"></div>
      <button class="btn primary start" type="button">开始 <kbd>Enter</kbd></button>`
  }
  for (const name of ['mode', 'scope', 'candidates', 'concurrency']) {
    setSelect(el.querySelector(`select[name="${name}"]`), view.settings[name])
  }
  const picked = checkedGroups()
  const taskCount = picked.reduce((sum, group) => sum + activeTasksOf(group.id).length, 0)
  const calls = taskCount * view.settings.candidates
  const price = view.imagePriceCny
  const estimate = price === undefined ? '' : ` · 预计约 ¥${(calls * price).toFixed(1)}`
  el.querySelector('.sum').textContent = `共 ${picked.length} 套、${taskCount} 张任务、${calls} 次生成${estimate}`
  el.querySelector('.start').disabled = picked.length === 0
}

function renderRun() {
  const el = $('run')
  const show = groups.some((group) => group.started)
  el.hidden = !show
  if (!show) return
  if (!el.firstChild) {
    el.innerHTML = `<button class="btn sm" type="button" data-run="pause"></button>
      <label>并发<select name="concurrency">${optionsHtml(rangeLabels(1, 10), '')}</select></label>
      <span class="retry-slot"></span>`
  }
  el.querySelector('[data-run="pause"]').textContent = view.paused ? '继续' : '暂停'
  setSelect(el.querySelector('select[name="concurrency"]'), view.settings.concurrency)
  const failed = retryableCount()
  const html = failed > 0 ? `<button class="btn sm bad" type="button" data-run="retry">重试所有失败（${failed}）</button>` : ''
  const slot = el.querySelector('.retry-slot')
  if (slot.dataset.html !== html) {
    slot.dataset.html = html
    slot.innerHTML = html
  }
}

/** "重试所有失败"能恢复的张数：失败的任务，加上已开始但准备失败的组里被卡住的任务（素材已变化的旧任务、已标记不交付的失败图不计）。 */
function retryableCount() {
  return view.tasks.filter((task) => {
    if (task.error && task.error.code === 'INPUT_CHANGED') return false
    if (task.status === 'failed') return !task.excluded
    const group = groupById.get(task.groupId)
    return Boolean(group && group.started && group.error && task.status === 'queued')
  }).length
}

async function saveSettings(patch) {
  const result = await api('/api/settings', patch)
  if (!result.ok) toast(result.message)
  await refresh()
}

async function startChecked() {
  const picked = checkedGroups()
  if (picked.length === 0) {
    toast('没有可开始的套')
    return
  }
  const result = await api('/api/start', { groupIds: picked.map((group) => group.id) })
  if (!result.ok) {
    toast(result.message)
    return
  }
  toast(`已开始 ${picked.length} 套`)
  if (document.activeElement && document.activeElement.closest('#setup')) document.activeElement.blur()
  await refresh()
}

async function togglePause() {
  const result = await api(view.paused ? '/api/resume' : '/api/pause', {})
  if (!result.ok) toast(result.message)
  await refresh()
}

async function retryFailed() {
  const result = await api('/api/retry', {})
  if (!result.ok) toast(result.message)
  await refresh()
}

/** 准备失败的组重新准备（裁切、服装描述、首轮 prompt）；完成后经 SSE 刷新这一行。 */
async function retryPrepare(groupId) {
  const result = await api(`/api/groups/${encodeURIComponent(groupId)}/prepare`, {})
  if (!result.ok) toast(result.message)
  await refresh()
}

async function saveGroupSettings(groupId, patch) {
  const result = await api(`/api/groups/${encodeURIComponent(groupId)}/settings`, patch)
  if (!result.ok) toast(result.message)
  await refresh()
}

// ---------- 表格行 ----------

function tileHtml(task, index) {
  const info = taskInfo(task)
  const src = info.version ? versionUrl(info.version.id, 'thumb') : assetUrl(task.modelAssetId, 'thumb')
  const cls = ['tile']
  if (info.ghost) cls.push('is-ghost')
  if (info.regenerating) cls.push('is-regen')
  if (task.excluded) cls.push('is-excl')
  const prog = info.busy || info.regenerating
    ? `<span class="prog${task.status === 'running' ? ' run' : ''}"><i></i></span>`
    : ''
  let tag = ''
  if (task.excluded) tag = '<span class="tag">不交付</span>'
  else if (info.regenerating) {
    const text = tagText(info.regenJob && info.regenJob.regen)
    tag = `<span class="tag">重出中${text ? ` · ${esc(text)}` : ''}</span>`
  } else if (task.status === 'failed') {
    const message = task.error ? task.error.message : ''
    tag = `<span class="tag bad" title="${esc(message)}">失败${message ? ` · ${esc(message.slice(0, 80))}` : ''}</span>`
  }
  else if (task.status === 'running') tag = '<span class="tag quiet">生成中</span>'
  else if (task.status === 'queued') tag = '<span class="tag quiet">排队</span>'
  const versions = info.total > 1 ? `<span class="v mono">v${info.index + 1}/${info.total}</span>` : ''
  return `<button class="${cls.join(' ')}" type="button" tabindex="-1" data-task-id="${esc(task.id)}" data-index="${index}">
    <span class="frame"><img src="${src}" alt="" loading="lazy" decoding="async">${prog}</span>
    <span class="cap"><span class="n mono">${pad(index + 1)}</span>${versions}${tag}</span>
  </button>`
}

/** 素材行的一张模特图：原图缩略图，配对的服装不止一件时标出服装序号。 */
function setupTileHtml(task, index, garmentIds) {
  const garment = garmentIds.length > 1 ? `<span class="v">服装 ${pad(garmentIds.indexOf(task.garmentAssetId) + 1)}</span>` : ''
  return `<button class="tile" type="button" tabindex="-1" data-task-id="${esc(task.id)}" data-index="${index}">
    <span class="frame"><img src="${assetUrl(task.modelAssetId, 'thumb')}" alt="" loading="lazy" decoding="async"></span>
    <span class="cap"><span class="n mono">${pad(index + 1)}</span>${garment}</span>
  </button>`
}

/** 组准备失败的错误摘要（悬停显示全文）。 */
function prepError(group) {
  return group.error ? ` title="${esc(group.error.message)}"` : ''
}

function prepFailedText(group) {
  return `准备失败 · ${esc(group.error.message.slice(0, 80))}`
}

function garmentHtml(group, garmentId) {
  const asset = assetById.get(garmentId)
  if (isSetupGroup(group) && !(asset && asset.preparedHash)) {
    // 准备中：服装原图淡影；旧的裁后副本已过时，改取原图
    const variant = asset && asset.preparedRelativePath ? 'source' : 'thumb'
    return `<div class="garment is-prep"><span class="frame"><img src="${assetUrl(garmentId, variant)}" alt="" loading="lazy" decoding="async"></span><span class="cap"${prepError(group)}>${group.error ? prepFailedText(group) : '裁切中'}</span></div>`
  }
  const manual = asset && asset.cropOverride ? ' · 手动' : ''
  const label = group.error ? prepFailedText(group) : `服装裁后图${manual}`
  return `<div class="garment"><span class="frame"><img src="${assetUrl(garmentId, 'thumb')}" alt="" loading="lazy" decoding="async"></span><span class="cap"${prepError(group)}>${label}</span></div>`
}

/** 未开始的组：勾选框（素材不全不可勾选）、准备失败时的"重新准备"，以及本组模式、范围。 */
function groupSetupHtml(group) {
  if (!isSetupGroup(group)) return ''
  const pick = group.status === 'idle'
    ? `<label class="pick-l"><input class="pick" type="checkbox" tabindex="-1"${unchecked.has(group.id) ? '' : ' checked'}>开始</label>`
    : ''
  const prep = group.error ? '<button class="btn sm bad" type="button" tabindex="-1" data-prep>重新准备</button>' : ''
  return `<div class="gset">${pick}${prep}
    <select data-gset="mode" tabindex="-1" aria-label="本组搭配模式">${optionsHtml(MODE_LABEL, group.mode || view.settings.mode)}</select>
    <select data-gset="scope" tabindex="-1" aria-label="本组换装范围">${optionsHtml(SCOPE_LABEL, group.scope || view.settings.scope)}</select>
  </div>`
}

function promptHtml(group) {
  if (!expanded.has(group.id)) return ''
  const entry = prompts.get(group.id)
  return `<div class="prompt"><pre>${esc(entry ? entry.text : '读取中…')}</pre></div>`
}

function rowHtml(group) {
  const setup = isSetupGroup(group)
  const tasks = setup ? activeTasksOf(group.id) : (tasksByGroup.get(group.id) || [])
  const status = group.status
  let stateText = STATUS_TEXT[status] || status
  if (status === 'generating') stateText = `生成中 ${group.counts.done}/${group.counts.tasks}`
  if (group.error) stateText = '准备失败'
  const path = status === 'delivered' ? `<div class="path">→ 成图/${esc(group.sku)}/</div>` : ''
  const head = `<div class="head">
    <div class="sku">${esc(group.sku)}</div><div class="sub">${esc(group.name)}</div>
    ${groupSetupHtml(group)}<div class="state">${esc(stateText)}<kbd>Enter</kbd></div>${path}
  </div>`
  const open = `<article class="set ${STATUS_CLASS[status] || ''}" data-group-id="${esc(group.id)}" data-status="${esc(status)}">`
  if (status === 'incomplete') {
    return `${open}${head}<div class="note"><b>${esc(group.incompleteReason)}</b><span>补齐后自动加入队列，其他套不受影响</span></div>${promptHtml(group)}</article>`
  }
  if (tasks.length === 0) {
    const reason = group.error ? group.error.message : '这套没有可生成的图'
    return `${open}${head}<div class="note"><b>${esc(reason)}</b></div>${promptHtml(group)}</article>`
  }
  const garmentIds = [...new Set(tasks.map((task) => task.garmentAssetId))]
  const tiles = setup
    ? tasks.map((task, index) => setupTileHtml(task, index, garmentIds))
    : tasks.map(tileHtml)
  return `${open}${head}${garmentHtml(group, tasks[0].garmentAssetId)}
    <div class="tiles" style="--n:${tasks.length}">${tiles.join('')}</div>
    ${promptHtml(group)}
  </article>`
}

function rowSignature(group) {
  const tasks = tasksByGroup.get(group.id) || []
  const garment = tasks[0] ? assetById.get(tasks[0].garmentAssetId) : undefined
  const setup = isSetupGroup(group)
    ? [unchecked.has(group.id), view.settings.mode, view.settings.scope, garment && garment.cropOverride]
    : null
  return JSON.stringify([group, tasks, garment && garment.preparedHash, setup, expanded.has(group.id) && (prompts.get(group.id) || null)])
}

function buildElement(html) {
  const template = document.createElement('template')
  template.innerHTML = html.trim()
  return template.content.firstElementChild
}

function renderBoard() {
  const board = $('board')
  const seen = new Set()
  let previous = null
  for (const group of groups) {
    seen.add(group.id)
    const sig = rowSignature(group)
    let entry = rows.get(group.id)
    if (!entry || entry.sig !== sig) {
      const el = buildElement(rowHtml(group))
      if (entry) entry.el.replaceWith(el)
      entry = { el, sig }
      rows.set(group.id, entry)
    }
    // 保持行顺序与组 order 一致
    const expected = previous ? previous.nextSibling : board.firstChild
    if (entry.el !== expected) board.insertBefore(entry.el, expected)
    previous = entry.el
  }
  for (const [groupId, entry] of rows) {
    if (seen.has(groupId)) continue
    entry.el.remove()
    rows.delete(groupId)
  }
  const empty = board.querySelector('.empty')
  if (groups.length === 0 && !empty) board.insertAdjacentHTML('beforeend', '<p class="empty">素材根目录下还没有可用的套</p>')
  if (groups.length > 0 && empty) empty.remove()
  watchFirstThumb()
}

/** 首行缩略图全部加载完成时打点，用于首屏耗时检查。 */
function watchFirstThumb() {
  if (firstThumbWatched) return
  const first = $('board').querySelector('.set')
  if (!first) return
  firstThumbWatched = true
  const images = [...first.querySelectorAll('img')]
  Promise.all(images.map((img) => img.complete
    ? Promise.resolve()
    : new Promise((resolve) => {
      img.addEventListener('load', resolve, { once: true })
      img.addEventListener('error', resolve, { once: true })
    }))).then(() => performance.mark('studio-first-thumb'))
}

// ---------- 选中 ----------

function clampSelection() {
  if (!groupById.has(sel.groupId)) {
    const first = groups.find((group) => group.status === 'review') || groups[0]
    sel.groupId = first ? first.id : null
    sel.taskIndex = 0
  }
  const count = currentTasks().length
  sel.taskIndex = count === 0 ? 0 : Math.min(Math.max(sel.taskIndex, 0), count - 1)
}

function applySelection() {
  for (const el of document.querySelectorAll('.set.is-active')) el.classList.remove('is-active')
  for (const el of document.querySelectorAll('.tile.is-sel')) el.classList.remove('is-sel')
  const entry = rows.get(sel.groupId)
  if (!entry) return
  entry.el.classList.add('is-active')
  const group = currentGroup()
  const tile = entry.el.querySelectorAll('.tile')[sel.taskIndex]
  if (tile && group && group.status !== 'delivered') tile.classList.add('is-sel')
}

function scrollToActive() {
  const entry = rows.get(sel.groupId)
  if (entry) entry.el.scrollIntoView({ block: 'nearest' })
}

function selectGroup(groupId, taskIndex = 0) {
  if (!groupById.has(groupId)) return
  sel.groupId = groupId
  sel.taskIndex = taskIndex
  clampSelection()
  applySelection()
  renderInspector()
  scrollToActive()
}

function selectTask(taskId) {
  const task = taskById.get(taskId)
  if (!task) return
  selectGroup(task.groupId, (tasksByGroup.get(task.groupId) || []).indexOf(task))
}

// ---------- 检视区 ----------

function inspectorBody() {
  const group = currentGroup()
  if (!group) return '<p class="hint">素材根目录下还没有可用的套。</p>'
  const head = (pos) => `<div class="insp-head"><div class="sku">${esc(group.sku)}</div>${pos ? `<span class="pos mono">${pos}</span>` : ''}</div>`
  if (group.status === 'delivered') {
    return `${head('')}
      <p class="hint">这一套已交付到 成图/${esc(group.sku)}/。按 ⌘Z 撤销最近一次判断，或撤回交付后重新判断。</p>
      <div class="acts"><button class="btn" type="button" tabindex="-1" data-act="withdraw">撤回交付</button></div>`
  }
  if (group.status === 'incomplete') {
    return `${head('')}<p class="hint">${esc(group.incompleteReason)}。补齐后自动加入队列，其他套不受影响。</p>`
  }
  const tasks = currentTasks()
  const task = currentTask()
  if (!task) return `${head('')}<p class="hint">${esc(group.error ? group.error.message : '这套没有可生成的图')}</p>`

  const info = taskInfo(task)
  const big = info.version
    ? `<img src="${versionUrl(info.version.id, 'full')}" alt="">`
    : `<img class="ghost" src="${assetUrl(task.modelAssetId, 'thumb')}" alt="">`
  const garment = assetById.get(task.garmentAssetId)
  const garmentSrc = assetUrl(task.garmentAssetId, garment && garment.preparedRelativePath ? 'prepared' : 'source')
  const versions = info.total > 1
    ? `<div class="vers"><span class="lab">版本</span>${task.versions.map((_, k) => `<button class="chip" type="button" tabindex="-1" data-v="${k}" aria-pressed="${k === info.index}">v${k + 1}</button>`).join('')}<span class="lab end">${info.index === info.total - 1 ? '最新' : '历史版本'}</span></div>`
    : ''
  const setup = isSetupGroup(group)
  let status = '待判断 · 默认通过'
  if (setup) status = '未开始'
  else if (task.excluded) status = '不交付'
  else if (info.regenerating) status = '重出中'
  else if (task.status === 'failed') status = '生成失败'
  else if (task.status === 'running') status = '生成中'
  else if (task.status === 'queued') status = '排队'
  else if (group.status !== 'review') status = '已出图'
  const regenSource = (info.regenJob && info.regenJob.regen) || (info.version && info.version.regen)
  const facts = [
    ['状态', status],
    ['模式', groupMode(group)],
    regenSource ? ['重出', tagText(regenSource) || '重出'] : null,
    task.error ? ['原因', task.error.message] : null,
  ].filter(Boolean)
  return `${head(`${pad(sel.taskIndex + 1)} / ${pad(tasks.length)}`)}
    <div class="compare">
      <div class="stack"><span class="big" data-act="loupe">${big}</span><span class="cap">成图${info.total > 1 ? ` v${info.index + 1}` : ''}</span></div>
      <div class="stack">
        <span class="big-s"><img src="${garmentSrc}" alt=""></span><span class="cap">服装裁后图</span>
        <span class="big-s"><img src="${assetUrl(task.modelAssetId, 'source')}" alt=""></span><span class="cap">模特原图</span>
      </div>
    </div>
    ${versions}
    <dl class="facts">${facts.map(([key, value]) => `<dt>${key}</dt><dd>${esc(value)}</dd>`).join('')}</dl>
    ${setup ? `<div class="acts two">
      <button class="btn" type="button" tabindex="-1" data-act="crop">裁切服装 <kbd>C</kbd></button>
      <button class="btn" type="button" tabindex="-1" data-act="prompt">提示词 <kbd>E</kbd></button>
    </div>` : `<div class="acts">
      <button class="btn primary" type="button" tabindex="-1" data-act="pass">整套通过 <kbd>Enter</kbd></button>
      <button class="btn" type="button" tabindex="-1" data-act="regen">重出 <kbd>R</kbd></button>
      <button class="btn" type="button" tabindex="-1" data-act="exclude">${task.excluded ? '恢复交付' : '不交付'} <kbd>X</kbd></button>
    </div>`}`
}

function renderInspector() {
  const html = inspectorBody()
  if (html === inspectorHtml) return
  inspectorHtml = html
  $('insp').innerHTML = html
}

/** 用新的批次视图刷新页面：只重建签名变化的行。 */
function render(state) {
  indexState(state)
  clampSelection()
  renderTop()
  renderSetup()
  renderRun()
  renderBoard()
  applySelection()
  renderInspector()
  refreshPrompts()
}

/** 只重建素材表的行（勾选、展开等本地变化）。 */
function rerenderRows() {
  renderSetup()
  renderBoard()
  applySelection()
}

// ---------- 提示词展开 ----------

const promptLoading = new Set()

function promptTaskOf(groupId) {
  return sel.groupId === groupId && currentTask() ? currentTask() : activeTasksOf(groupId)[0]
}

/** 提示词随模式、范围、裁切与任务变化重新生成：这些变了，缓存的提示词即过时。 */
function promptKey(groupId) {
  const group = groupById.get(groupId)
  const task = promptTaskOf(groupId)
  const garment = task ? assetById.get(task.garmentAssetId) : undefined
  return JSON.stringify([
    group && (group.mode || view.settings.mode),
    group && (group.scope || view.settings.scope),
    task && task.id,
    garment && garment.preparedHash,
    task && task.chosenVersionId,
  ])
}

async function loadPrompt(groupId) {
  if (promptLoading.has(groupId)) return
  const task = promptTaskOf(groupId)
  const key = promptKey(groupId)
  if (!task) {
    prompts.set(groupId, { ok: false, key, text: '这套没有可生成的图' })
    rerenderRows()
    return
  }
  promptLoading.add(groupId)
  try {
    const data = await api(`/api/prompt/${encodeURIComponent(task.id)}`)
    prompts.set(groupId, typeof data.prompt === 'string'
      ? { ok: true, key, text: data.prompt }
      : { ok: false, key, text: data.message || '读取提示词失败' })
  } finally {
    promptLoading.delete(groupId)
  }
  if (expanded.has(groupId)) rerenderRows()
}

/** 展开中的组：提示词还没准备好或已过时，随刷新重新读取。 */
function refreshPrompts() {
  for (const groupId of expanded) {
    const entry = prompts.get(groupId)
    if (!entry || !entry.ok || entry.key !== promptKey(groupId)) void loadPrompt(groupId)
  }
}

function toggleExpand(groupId = sel.groupId) {
  if (!groupId) return
  if (expanded.has(groupId)) {
    expanded.delete(groupId)
    rerenderRows()
    return
  }
  expanded.add(groupId)
  prompts.delete(groupId)
  rerenderRows()
  void loadPrompt(groupId)
}

// ---------- 刷新与 SSE ----------

let refreshing = null
let refreshAgain = false
/** 拉取 /api/batch 并渲染；进行中再次调用会在本轮结束后再拉一次，返回的 Promise 覆盖到最后一次。 */
function refresh() {
  if (refreshing) {
    refreshAgain = true
    return refreshing
  }
  refreshing = (async () => {
    do {
      refreshAgain = false
      const data = await api('/api/batch')
      if (data && data.state) render(data.state)
    } while (refreshAgain)
  })().finally(() => {
    refreshing = null
  })
  return refreshing
}

let refreshTimer
function scheduleRefresh() {
  if (refreshTimer !== undefined) return
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined
    void refresh()
  }, 50)
}

function connectEvents() {
  const source = new EventSource(withToken('/api/events'))
  source.addEventListener('change', (event) => {
    let data
    try {
      data = JSON.parse(event.data)
    } catch {
      return
    }
    if (data.type === 'notice') {
      toast(data.message)
      return
    }
    scheduleRefresh()
  })
  // 断开后每 2 秒重连；连上时服务端先发一次 batch 事件，页面随之重新拉取
  source.onerror = () => {
    source.close()
    setTimeout(connectEvents, RECONNECT_MS)
  }
}

// ---------- 判断操作 ----------

function nextReview(fromGroupId) {
  const start = groups.findIndex((group) => group.id === fromGroupId)
  for (let step = 1; step <= groups.length; step += 1) {
    const group = groups[(start + step + groups.length) % groups.length]
    if (group && group.status === 'review') return group
  }
  return undefined
}

async function pass() {
  const group = currentGroup()
  if (!group) return
  const result = await api('/api/decisions', { op: 'pass', groupId: group.id })
  if (!result.ok) {
    toast(result.message)
    return
  }
  toast(result.message, `→ 成图/${group.sku}/   ⌘Z 撤销`)
  passedHistory.push(group.id)
  await refresh()
  const next = nextReview(group.id)
  if (next) selectGroup(next.id)
}

async function withdraw() {
  const group = currentGroup()
  if (!group) return
  const result = await api('/api/decisions', { op: 'withdraw', groupId: group.id })
  toast(result.message)
  await refresh()
}

async function toggleExclude() {
  const task = currentTask()
  if (!task) return
  const result = await api('/api/decisions', { op: 'exclude', taskId: task.id, excluded: !task.excluded })
  if (!result.ok) toast(result.message)
  await refresh()
}

async function chooseVersion(k) {
  const task = currentTask()
  if (!task || !task.versions[k] || task.versions[k].id === task.chosenVersionId) return
  const result = await api('/api/decisions', { op: 'choose', taskId: task.id, versionId: task.versions[k].id })
  if (!result.ok) toast(result.message)
  await refresh()
}

async function undo() {
  const result = await api('/api/undo', {})
  toast(result.message)
  await refresh()
  if (!result.ok) return
  // 撤销的是本页最近一次交付：跳回那一套
  const last = passedHistory[passedHistory.length - 1]
  const group = last && groupById.get(last)
  if (group && group.status === 'review') {
    passedHistory.pop()
    selectGroup(group.id)
  }
}

// ---------- 重出标签层 ----------

const popTags = new Set()
let popTaskId = null

function isPopOpen() {
  return $('pop').classList.contains('open')
}

function renderTags() {
  $('tags').innerHTML = REGEN_TAGS.map(([key, label], k) =>
    `<button type="button" tabindex="-1" data-tag="${key}" aria-pressed="${popTags.has(key)}"><kbd>${k + 1}</kbd>${label}</button>`).join('')
}

function openPop() {
  const group = currentGroup()
  const task = currentTask()
  if (!group || !task) return
  if (group.status === 'delivered') {
    toast('这套已交付，先撤回再修改')
    return
  }
  if (task.versions.length === 0) {
    toast('这张还没有生成结果，无法重出')
    return
  }
  popTaskId = task.id
  popTags.clear()
  renderTags()
  $('popWhat').textContent = `${group.sku} · ${pad(sel.taskIndex + 1)}`
  $('popNote').value = ''
  const entry = rows.get(group.id)
  const tile = entry && entry.el.querySelectorAll('.tile')[sel.taskIndex]
  const rect = tile ? tile.getBoundingClientRect() : { right: innerWidth / 2, top: innerHeight / 3 }
  const pop = $('pop')
  pop.style.left = `${Math.max(12, Math.min(rect.right + 12, innerWidth - 320))}px`
  pop.style.top = `${Math.max(12, Math.min(rect.top, innerHeight - 280))}px`
  pop.classList.add('open')
}

function closePop() {
  $('pop').classList.remove('open')
  $('popNote').blur()
  popTaskId = null
}

function toggleTag(k) {
  const entry = REGEN_TAGS[k]
  if (!entry) return
  if (popTags.has(entry[0])) popTags.delete(entry[0])
  else popTags.add(entry[0])
  renderTags()
}

async function confirmRegen() {
  if (!popTaskId) return
  const tags = REGEN_TAGS.map(([key]) => key).filter((key) => popTags.has(key))
  const note = $('popNote').value.trim()
  const result = await api('/api/decisions', {
    op: 'regenerate',
    taskId: popTaskId,
    tags,
    ...(note ? { note } : {}),
  })
  if (!result.ok) {
    // 标签层保持打开，补选后可再确认
    toast(result.message)
    return
  }
  closePop()
  toast(result.message, tags.map((tag) => TAG_LABEL[tag]).join('、'))
  await refresh()
}

// ---------- 三图对照 ----------

function isLoupeOpen() {
  return $('loupe').classList.contains('open')
}

function openLoupe() {
  const group = currentGroup()
  const task = currentTask()
  if (!group || !task) return
  const info = taskInfo(task)
  const garment = assetById.get(task.garmentAssetId)
  const garmentSrc = assetUrl(task.garmentAssetId, garment && garment.preparedRelativePath ? 'prepared' : 'source')
  const result = info.version ? `<img src="${versionUrl(info.version.id, 'full')}" alt="">` : ''
  $('loupe').innerHTML = `<header>
      <div class="sku">${esc(group.sku)} <span class="mono" style="font-size:14px">${pad(sel.taskIndex + 1)}</span></div>
      <span>点击任意一张同步放大，移动鼠标同步平移 · <kbd>Space</kbd>/<kbd>Esc</kbd> 关闭</span>
    </header>
    <div class="cols">
      <div class="col"><div class="frame"><img src="${garmentSrc}" alt=""></div><span class="cap">服装裁后图</span></div>
      <div class="col"><div class="frame"><img src="${assetUrl(task.modelAssetId, 'source')}" alt=""></div><span class="cap">模特原图</span></div>
      <div class="col"><div class="frame">${result}</div><span class="cap">成图${info.total > 1 ? ` v${info.index + 1}` : ''}</span></div>
    </div>`
  $('loupe').classList.add('open')
}

function closeLoupe() {
  $('loupe').classList.remove('open')
}

/** 三栏同步放大的锚点：按鼠标在当前栏内的相对位置。 */
function syncOrigin(event, frame) {
  const rect = frame.getBoundingClientRect()
  const origin = `${((event.clientX - rect.left) / rect.width) * 100}% ${((event.clientY - rect.top) / rect.height) * 100}%`
  for (const img of $('loupe').querySelectorAll('.col img')) img.style.transformOrigin = origin
}

// ---------- 手动裁切 ----------

// 框的坐标均为原图像素（按 EXIF 方向校正后，与浏览器 naturalWidth/Height 一致）
const crop = { groupId: null, assetId: null, natural: null, box: null, drag: null }

function isCropOpen() {
  return $('crop').classList.contains('open')
}

/** 与服务端 computeCropBox 相同的自动裁切框。 */
function autoCropBox(bbox, width, height) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return undefined
  const [x1, y1, x2, y2] = bbox
  const left = Math.max(0, Math.round((x1 / 1000) * width) - Math.round((CROP_MARGINS.left / 1024) * width))
  const top = Math.max(0, Math.round((y1 / 1000) * height) - Math.round((CROP_MARGINS.top / 1024) * height))
  const right = Math.min(width, Math.round((x2 / 1000) * width) + Math.round((CROP_MARGINS.right / 1024) * width))
  const bottom = Math.min(height, Math.round((y2 / 1000) * height) + Math.round((CROP_MARGINS.bottom / 1024) * height))
  if (right <= left || bottom <= top) return undefined
  return { left, top, width: right - left, height: bottom - top }
}

function openCrop() {
  const group = currentGroup()
  const task = currentTask() || activeTasksOf(sel.groupId)[0]
  if (!group || !task) return
  const asset = assetById.get(task.garmentAssetId)
  if (!asset) return
  const started = !isSetupGroup(group)
  if (started) toast('这套已开始生成，裁切只影响之后的重出')
  crop.groupId = group.id
  crop.assetId = asset.id
  crop.natural = null
  crop.box = null
  crop.drag = null
  $('crop').innerHTML = `<header>
      <div class="sku">${esc(group.sku)} <span class="sub">服装裁切</span></div>
      <span>${started ? '这套已开始生成，裁切只影响之后的重出' : '拖动四角缩放，拖动框内平移；只作用于本批'}</span>
    </header>
    <div class="stage"><div class="wrap">
      <img src="${assetUrl(asset.id, 'source')}" alt="" draggable="false">
      <div class="box"><i class="h" data-h="nw"></i><i class="h" data-h="ne"></i><i class="h" data-h="sw"></i><i class="h" data-h="se"></i></div>
    </div></div>
    <footer><span><kbd>Enter</kbd> 保存</span><span><kbd>Backspace</kbd> 恢复自动裁切</span><span><kbd>Esc</kbd> 取消</span></footer>`
  const img = $('crop').querySelector('img')
  const ready = () => {
    const width = img.naturalWidth
    const height = img.naturalHeight
    crop.natural = { width, height }
    crop.box = { ...(asset.cropOverride || autoCropBox(asset.bbox, width, height) || { left: 0, top: 0, width, height }) }
    drawCrop()
  }
  if (img.complete && img.naturalWidth > 0) ready()
  else img.addEventListener('load', ready, { once: true })
  $('crop').classList.add('open')
}

function closeCrop() {
  $('crop').classList.remove('open')
  crop.drag = null
}

function cropScale() {
  const img = $('crop').querySelector('img')
  return img && crop.natural ? img.clientWidth / crop.natural.width : 1
}

function drawCrop() {
  const el = $('crop').querySelector('.box')
  if (!el || !crop.box) return
  const scale = cropScale()
  el.style.left = `${crop.box.left * scale}px`
  el.style.top = `${crop.box.top * scale}px`
  el.style.width = `${crop.box.width * scale}px`
  el.style.height = `${crop.box.height * scale}px`
}

function clamp(value, low, high) {
  return Math.min(Math.max(value, low), high)
}

/** 按拖动位移（原图像素）计算新框：框内拖动平移，四角缩放；不超出原图、短边不小于下限。 */
function draggedBox(start, handle, dx, dy) {
  const { width, height } = crop.natural
  if (handle === 'move') {
    return {
      ...start,
      left: clamp(start.left + dx, 0, width - start.width),
      top: clamp(start.top + dy, 0, height - start.height),
    }
  }
  const min = Math.min(MIN_CROP_EDGE, width, height)
  let x1 = start.left
  let y1 = start.top
  let x2 = start.left + start.width
  let y2 = start.top + start.height
  if (handle.includes('w')) x1 = clamp(x1 + dx, 0, x2 - min)
  if (handle.includes('e')) x2 = clamp(x2 + dx, x1 + min, width)
  if (handle.includes('n')) y1 = clamp(y1 + dy, 0, y2 - min)
  if (handle.includes('s')) y2 = clamp(y2 + dy, y1 + min, height)
  return { left: x1, top: y1, width: x2 - x1, height: y2 - y1 }
}

function roundedBox(box) {
  const { width, height } = crop.natural
  const left = clamp(Math.round(box.left), 0, width - 1)
  const top = clamp(Math.round(box.top), 0, height - 1)
  return {
    left,
    top,
    width: clamp(Math.round(box.width), 1, width - left),
    height: clamp(Math.round(box.height), 1, height - top),
  }
}

/** 保存裁切框；box 为 null 时恢复自动裁切。 */
async function saveCrop(box) {
  if (!crop.assetId || (box !== null && !crop.natural)) return
  const result = await api(`/api/groups/${encodeURIComponent(crop.groupId)}/crop`, {
    assetId: crop.assetId,
    box: box === null ? null : roundedBox(box),
  })
  if (!result.ok) {
    // 裁切层保持打开，调整后可再保存
    toast(result.message)
    return
  }
  closeCrop()
  toast(box === null ? '已恢复自动裁切' : '裁切已保存', '服装图重新准备中')
  await refresh()
}

function onCropKey(event) {
  const key = event.key
  if (key !== 'Enter' && key !== 'Backspace' && key !== 'Escape') return
  event.preventDefault()
  if (key === 'Escape') closeCrop()
  else if (key === 'Enter') enqueue(() => saveCrop(crop.box))
  else enqueue(() => saveCrop(null))
}

// ---------- 素材重扫 ----------

let lastRescan = 0
let rescanTimer

async function rescan() {
  lastRescan = Date.now()
  const result = await api('/api/rescan', {})
  if (!result.ok) toast(result.message)
  await refresh()
}

/** 页面获得焦点时重扫；10 秒内最多一次，间隔内的请求合并到间隔结束时执行。 */
function onFocus() {
  const wait = lastRescan + RESCAN_MS - Date.now()
  if (wait <= 0) {
    void rescan()
    return
  }
  if (rescanTimer === undefined) {
    rescanTimer = setTimeout(() => {
      rescanTimer = undefined
      void rescan()
    }, wait)
  }
}

// ---------- 键盘与鼠标 ----------

// 操作按按键顺序串行执行，避免上一个判断还没返回时下一个键作用到旧的选中项
let actionChain = Promise.resolve()
function enqueue(action) {
  actionChain = actionChain.then(action).catch((error) => toast(error instanceof Error ? error.message : String(error)))
}

function moveGroup(delta) {
  const index = groups.findIndex((group) => group.id === sel.groupId)
  const next = groups[index + delta]
  if (next) selectGroup(next.id, sel.taskIndex)
}

function moveTask(delta) {
  const count = currentTasks().length
  if (count === 0) return
  selectGroup(sel.groupId, (sel.taskIndex + delta + count) % count)
}

const HANDLED_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', ' ', 'Tab', 'Escape'])

function onKey(key) {
  if (isPopOpen()) {
    if (key === 'Escape') closePop()
    else if (key === 'Enter') return confirmRegen()
    else if (key === 'Tab') $('popNote').focus()
    else if (/^[1-8]$/.test(key)) toggleTag(Number(key) - 1)
    return
  }
  if (isLoupeOpen()) {
    if (key === 'Escape' || key === ' ') closeLoupe()
    return
  }
  if (isCropOpen()) return
  switch (key) {
    case 'ArrowDown': return moveGroup(1)
    case 'ArrowUp': return moveGroup(-1)
    case 'ArrowRight': return moveTask(1)
    case 'ArrowLeft': return moveTask(-1)
    case 'Enter': return pass()
    case 'r': case 'R': return openPop()
    case 'x': case 'X': return toggleExclude()
    case ' ': return openLoupe()
    case 'e': case 'E': return toggleExpand()
    case 'c': case 'C': return openCrop()
    default:
      if (/^[1-4]$/.test(key)) return chooseVersion(Number(key) - 1)
  }
}

function onKeydown(event) {
  const typing = event.target === $('popNote')
  const key = event.key
  if (isCropOpen()) {
    onCropKey(event)
    return
  }
  // 设置条与运行控制里的表单控件保留原生按键；设置条内 Enter 等价于"开始"
  const control = !typing && event.target instanceof Element && event.target.closest('#setup, #run, select, input')
  if (control) {
    if (key === 'Enter' && event.target.closest('#setup') && !event.metaKey && !event.ctrlKey) {
      event.preventDefault()
      enqueue(startChecked)
    }
    return
  }
  if ((event.metaKey || event.ctrlKey) && key.toLowerCase() === 'z') {
    if (typing) return
    event.preventDefault()
    enqueue(undo)
    return
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return
  if (typing) {
    // 输入说明时只接管确认与取消，其余按键照常输入
    if (key === 'Enter' || key === 'Escape' || key === 'Tab') {
      event.preventDefault()
      if (key !== 'Tab') enqueue(() => onKey(key))
    }
    return
  }
  if (HANDLED_KEYS.has(key) || /^[1-8rRxXeEcC]$/.test(key)) {
    event.preventDefault()
    enqueue(() => onKey(key))
  }
}

function bindEvents() {
  document.addEventListener('keydown', onKeydown)

  $('board').addEventListener('click', (event) => {
    if (event.target.closest('.gset')) {
      // 勾选与本组设置只选中这一行
      const row = event.target.closest('.set')
      if (row && row.dataset.groupId !== sel.groupId) selectGroup(row.dataset.groupId)
      const prep = event.target.closest('[data-prep]')
      if (prep && row) {
        prep.disabled = true
        enqueue(() => retryPrepare(row.dataset.groupId))
      }
      return
    }
    if (event.target.closest('.sku')) {
      const row = event.target.closest('.set')
      if (row) {
        if (row.dataset.groupId !== sel.groupId) selectGroup(row.dataset.groupId)
        toggleExpand(row.dataset.groupId)
      }
      return
    }
    const tile = event.target.closest('.tile')
    if (tile) {
      selectTask(tile.dataset.taskId)
      return
    }
    const row = event.target.closest('.set')
    if (row && row.dataset.groupId !== sel.groupId) selectGroup(row.dataset.groupId)
  })
  $('board').addEventListener('change', (event) => {
    const row = event.target.closest('.set')
    if (!row) return
    const groupId = row.dataset.groupId
    if (event.target.matches('input.pick')) {
      if (event.target.checked) unchecked.delete(groupId)
      else unchecked.add(groupId)
      event.target.blur()
      rerenderRows()
      return
    }
    const field = event.target.dataset.gset
    if (field) {
      const value = event.target.value
      event.target.blur()
      enqueue(() => saveGroupSettings(groupId, { [field]: value }))
    }
  })
  $('setup').addEventListener('change', (event) => {
    const name = event.target.name
    if (!name) return
    const raw = event.target.value
    const value = name === 'candidates' || name === 'concurrency' ? Number(raw) : raw
    enqueue(() => saveSettings({ [name]: value }))
  })
  $('setup').addEventListener('click', (event) => {
    if (event.target.closest('.start')) enqueue(startChecked)
  })
  $('run').addEventListener('change', (event) => {
    if (event.target.name !== 'concurrency') return
    const value = Number(event.target.value)
    event.target.blur()
    enqueue(() => saveSettings({ concurrency: value }))
  })
  $('run').addEventListener('click', (event) => {
    const button = event.target.closest('[data-run]')
    if (!button) return
    button.blur()
    enqueue(button.dataset.run === 'retry' ? retryFailed : togglePause)
  })
  $('crop').addEventListener('mousedown', (event) => {
    if (!crop.box || !crop.natural) return
    const handle = event.target.closest('.h')
    const box = event.target.closest('.box')
    if (!handle && !box) return
    event.preventDefault()
    crop.drag = { handle: handle ? handle.dataset.h : 'move', x: event.clientX, y: event.clientY, start: { ...crop.box } }
  })
  window.addEventListener('mousemove', (event) => {
    if (!crop.drag) return
    const scale = cropScale()
    const { handle, x, y, start } = crop.drag
    crop.box = draggedBox(start, handle, (event.clientX - x) / scale, (event.clientY - y) / scale)
    drawCrop()
  })
  window.addEventListener('mouseup', () => {
    crop.drag = null
  })
  window.addEventListener('resize', drawCrop)
  window.addEventListener('focus', onFocus)
  $('board').addEventListener('dblclick', (event) => {
    const garment = event.target.closest('.garment')
    if (garment) {
      const row = garment.closest('.set')
      if (row) selectGroup(row.dataset.groupId, row.dataset.groupId === sel.groupId ? sel.taskIndex : 0)
      openCrop()
      return
    }
    const tile = event.target.closest('.tile')
    if (!tile) return
    selectTask(tile.dataset.taskId)
    openLoupe()
  })
  $('insp').addEventListener('click', (event) => {
    const chip = event.target.closest('[data-v]')
    if (chip) {
      enqueue(() => chooseVersion(Number(chip.dataset.v)))
      return
    }
    const act = event.target.closest('[data-act]')
    if (!act) return
    const actions = {
      pass,
      regen: openPop,
      exclude: toggleExclude,
      withdraw,
      loupe: openLoupe,
      crop: openCrop,
      prompt: () => toggleExpand(),
    }
    const action = actions[act.dataset.act]
    if (action) enqueue(action)
  })
  $('tags').addEventListener('click', (event) => {
    const button = event.target.closest('[data-tag]')
    if (button) toggleTag(REGEN_TAGS.findIndex(([key]) => key === button.dataset.tag))
  })
  $('loupe').addEventListener('click', (event) => {
    const frame = event.target.closest('.frame')
    if (!frame) return
    syncOrigin(event, frame)
    for (const el of $('loupe').querySelectorAll('.col .frame')) el.classList.toggle('zoom')
  })
  $('loupe').addEventListener('mousemove', (event) => {
    const frame = event.target.closest('.frame')
    if (frame && frame.classList.contains('zoom')) syncOrigin(event, frame)
  })
}

function init() {
  bindEvents()
  void refresh()
  connectEvents()
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
else init()
