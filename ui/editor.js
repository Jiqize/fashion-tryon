'use strict';
// 可编辑节点图：在节点图页面（graph.ts 渲染）上为每款加编辑面板，点成图卡片选中要重出的图后提交 /api/rerun。
// 每款的编辑面板由 editor-panel.js 提供；这里负责选中、底部条、重出、取消、进度与占用提示。
// 依赖 graph.ts 暴露的 window.__GRAPH__、controls.js 的 window.__UI__ 与各款 data-sku、各张 data-sku/data-model。
// 带 data-item 的组（固定模特、一对一）只读：不挂面板、不可选中，修改与重出在合集页完成。

(() => {
  const GRAPH = window.__GRAPH__
  const PANEL = window.__EDITOR_PANEL__
  const UI = window.__UI__
  if (GRAPH === undefined || PANEL === undefined || UI === undefined) return
  const RUN_ID = decodeURIComponent(location.pathname.split('/')[2] || '')
  const PING_MS = 60_000
  const BUSY_POLL_MS = 5000
  const { api, esc } = PANEL
  /** 一张图的键：款号 + item（固定服装为空）+ 模特图 */
  const shotKey = (sku, item, model) => sku + '\n' + (item || '') + '\n' + model

  let view = null
  /** sku → { el, panel, open } */
  const panels = new Map()
  /** 选中的图：shotKey 集合 */
  const picked = new Set()
  let sending = false
  /** 最近点过的成图卡片，空格快速预览从它开始 */
  let lastPair = null

  const groupOf = (sku) => view.groups.find((group) => group.sku === sku)
  const pickedOf = (sku) => groupOf(sku).models.map((model) => model.file).filter((file) => picked.has(shotKey(sku, '', file)))
  const dirty = () => [...panels.values()].some((entry) => entry.panel.getState().dirty)

  function createPanel(group) {
    const el = document.createElement('div')
    el.className = 'ed-panel'
    el.dataset.sku = group.sku
    el.hidden = true
    const entry = { el, open: false, panel: null }
    entry.panel = PANEL.create(el, {
      sku: group.sku,
      settings: group.settings,
      garments: group.garments,
      crops: group.crops,
      models: group.models.map((model) => ({ file: model.file, selected: false, ...(model.inRun ? {} : { tag: '新' }) })),
      maxReferences: view.maxReferences,
      keepFrame: group.keepFrame === true,
      onChange: (state) => {
        // 面板里点模特图与成图卡片是同一份选中
        for (const model of groupOf(group.sku).models) picked.delete(shotKey(group.sku, '', model.file))
        for (const file of state.models) picked.add(shotKey(group.sku, '', file))
        syncChecks()
      },
    })
    panels.set(group.sku, entry)
  }

  /** 每次节点图渲染后补上编辑入口、面板与勾标（节点更新会重写这些元素） */
  function decorate() {
    if (view === null) return
    for (const lane of document.querySelectorAll('.lane[data-sku]:not([data-item])')) {
      const entry = panels.get(lane.dataset.sku)
      if (entry === undefined) continue
      const head = lane.querySelector('h2')
      if (head !== null && head.querySelector('.ed-toggle') === null) {
        head.insertAdjacentHTML('beforeend', '<button type="button" class="ed-toggle">编辑</button><button type="button" class="ed-all ed-all-lane">全选</button>')
      }
      if (entry.el.parentElement !== lane) lane.appendChild(entry.el)
      entry.el.hidden = !entry.open
      const toggle = lane.querySelector('.ed-toggle')
      if (toggle !== null) toggle.textContent = entry.open ? '收起' : '编辑'
    }
    for (const pair of document.querySelectorAll('.pair[data-sku][data-model]:not([data-item])')) {
      if (pair.querySelector('.ed-tick') === null) {
        pair.classList.add('ed-pickable')
        pair.title = '点选后重出这张'
        // 键盘可达：Tab 聚焦，回车切换选中，空格快速预览（与合集页缩略图一致）
        pair.tabIndex = 0
        pair.setAttribute('role', 'button')
        pair.insertAdjacentHTML('afterbegin', '<span class="ed-tick" aria-hidden="true">✓</span>')
      }
    }
    syncChecks()
  }

  /** 卡片选中态（类 is-picked）与 picked 同步 */
  function syncChecks() {
    for (const pair of document.querySelectorAll('.pair.ed-pickable')) {
      const on = picked.has(shotKey(pair.dataset.sku, pair.dataset.item, pair.dataset.model))
      pair.classList.toggle('is-picked', on)
      pair.setAttribute('aria-pressed', String(on))
    }
    renderBar()
  }

  // ---------- 底部固定条 ----------

  function blockers() {
    const reasons = []
    for (const [sku, entry] of panels) {
      const state = entry.panel.getState()
      const used = [...picked].some((key) => key.split('\n')[0] === sku)
      if (used || state.dirty) reasons.push(...state.blockers)
    }
    return reasons
  }

  function renderBar() {
    const bar = document.getElementById('ed-bar')
    if (bar === null || view === null) return
    const engine = engineOf()
    const reasons = blockers()
    const busy = view.activeRunId
    document.getElementById('ed-count').textContent = '已选 ' + picked.size + ' 张'
    document.getElementById('ed-cost').hidden = engine !== 'apimart'
    const go = document.getElementById('ed-go')
    go.disabled = sending || busy !== null || picked.size === 0 || reasons.length > 0
    // 本页的 run 在跑：主按钮显示「出图中 N/M」与细进度条（与合集页底栏同样式）
    const run = busy !== null && busy === RUN_ID ? GRAPH.getRun() : null
    if (run === null || run === undefined || run.status !== 'running') go.textContent = '重出'
    else {
      const counts = run.counts
      const done = counts.delivered + counts.failed + counts.cancelled
      go.innerHTML = '出图中 ' + done + '/' + counts.planned + '<span class="cl-pbar"><i></i></span>'
      go.querySelector('.cl-pbar i').style.width = (counts.planned > 0 ? Math.min(100, done / counts.planned * 100) : 0) + '%'
    }
    const messages = []
    if (busy !== null) {
      messages.push('<span class="ed-busy">正在出图：<a href="/runs/' + encodeURIComponent(busy) + '/">' + esc(busy) + '</a></span>')
    }
    for (const reason of reasons) messages.push('<span class="ed-err">' + esc(reason) + '</span>')
    if (dirty()) messages.push('<span class="ed-dirty">有未重出的修改，离开会丢失</span>')
    document.getElementById('ed-msg').innerHTML = messages.join('')
    document.getElementById('ed-cancel').hidden = busy === null || busy !== RUN_ID
  }

  /** 引擎：服务默认引擎不是 codex 时（如测试用的 fake），第一项值为空 = 不传 engine，与原下拉一致 */
  function engineOf() {
    const on = document.querySelector('#ed-engine [aria-checked="true"]')
    return on === null ? '' : on.dataset.value
  }

  function buildBar() {
    const engines = [
      ...(view.engineDefault === 'codex' ? [] : [{ value: '', label: view.engineDefault }]),
      { value: 'codex', label: 'codex' },
      { value: 'apimart', label: 'apimart' },
    ]
    document.body.insertAdjacentHTML('beforeend',
      '<div id="ed-bar"><span id="ed-count">已选 0 张</span>' +
      '<span class="cl-bar-field ed-engine">引擎 ' + UI.segHtml('id="ed-engine"', engines, engines[0].value, '引擎') + '</span>' +
      '<span id="ed-cost" class="ed-cost" hidden>会产生真实费用</span>' +
      '<button type="button" id="ed-go" disabled>重出</button>' +
      '<button type="button" id="ed-cancel" hidden>取消</button>' +
      '<span id="ed-msg"></span></div>')
  }

  // ---------- 事件 ----------

  /** 点可编辑的成图卡片：切换选中；捕获阶段拦下，不再打开节点图的大图 */
  function onPairClick(event) {
    const target = event.target
    if (!(target instanceof Element)) return
    const pair = target.closest('.pair.ed-pickable')
    if (pair === null) return
    event.stopPropagation()
    event.preventDefault()
    togglePair(pair)
  }

  function togglePair(pair) {
    lastPair = pair
    const sku = pair.dataset.sku
    const key = shotKey(sku, pair.dataset.item, pair.dataset.model)
    picked.has(key) ? picked.delete(key) : picked.add(key)
    const entry = panels.get(sku)
    if (entry) entry.panel.setSelected(pickedOf(sku))
    syncChecks()
  }

  /** 回车：切换聚焦的成图卡片（空格留给快速预览） */
  function onPairKey(event) {
    if (event.key !== 'Enter' || !(event.target instanceof Element) || !event.target.matches('.pair.ed-pickable')) return
    event.preventDefault()
    togglePair(event.target)
  }

  /** 空格：快速预览聚焦或最近点过的卡片所在款的成图（层级栈里有弹层时由 controls.js 先处理） */
  function onSpace(event) {
    if (event.key !== ' ' || event.metaKey || event.ctrlKey || event.altKey) return
    const target = event.target
    if (target instanceof Element && target.matches('.pair.ed-pickable')) lastPair = target
    if (target instanceof Element && target.closest('input, textarea, button, [contenteditable="true"]')) return
    if (lastPair === null || !lastPair.isConnected) return
    const sku = lastPair.dataset.sku
    const items = []
    let index = 0
    for (const pair of document.querySelectorAll('.pair.ed-pickable')) {
      if (pair.dataset.sku !== sku) continue
      const img = pair.querySelector('img[data-role="result"]')
      if (img === null) continue
      if (pair === lastPair) index = items.length
      items.push({ src: img.src, name: pair.dataset.model.split('/').pop() })
    }
    if (items.length === 0) return
    event.preventDefault()
    UI.quickLook(items, index)
  }

  function bindEvents() {
    window.addEventListener('click', onPairClick, true)
    document.addEventListener('keydown', onPairKey)
    document.addEventListener('keydown', onSpace)
    // Tab 聚焦卡片：作为空格快速预览的起点
    document.addEventListener('focusin', (event) => {
      if (event.target instanceof Element && event.target.matches('.pair.ed-pickable')) lastPair = event.target
    })

    document.addEventListener('click', (event) => {
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      const lane = target.closest('.lane[data-sku]:not([data-item])')
      const entry = lane && panels.get(lane.dataset.sku)
      if (!entry) return
      if (target.classList.contains('ed-toggle')) {
        entry.open = !entry.open
        decorate()
        return
      }
      if (target.classList.contains('ed-all-lane')) {
        const sku = lane.dataset.sku
        const keys = groupOf(sku).models.map((model) => shotKey(sku, '', model.file))
        const all = keys.every((key) => picked.has(key))
        for (const key of keys) all ? picked.delete(key) : picked.add(key)
        entry.panel.setSelected(pickedOf(sku))
        syncChecks()
      }
    })

    document.getElementById('ed-engine').addEventListener('ui-change', renderBar)
    document.getElementById('ed-go').addEventListener('click', () => { void submit() })
    document.getElementById('ed-cancel').addEventListener('click', () => { void cancel() })

    window.addEventListener('beforeunload', (event) => {
      if (!dirty() || sending) return
      event.preventDefault()
      event.returnValue = ''
    })
  }

  async function submit() {
    const engine = engineOf()
    if (engine === 'apimart' && !(await UI.confirm({ title: '用 apimart 重出？', text: 'apimart 会产生真实费用，确定用它重出吗？', ok: '确定重出' }))) return
    const shots = [...picked].map((key) => {
      const [sku, item, model] = key.split('\n')
      return { sku, model, ...(item ? { item } : {}) }
    })
    // 只提交改过的款；提示词只在与默认不同时提交
    const groups = {}
    for (const [sku, entry] of panels) {
      const state = entry.panel.getState()
      if (!state.dirty) continue
      groups[sku] = {
        references: state.references,
        swap: state.swap,
        ...(state.promptEdited ? { prompt: state.prompt } : {}),
      }
    }
    const body = { fromRunId: RUN_ID, shots, ...(Object.keys(groups).length ? { groups } : {}), ...(engine ? { engine } : {}) }
    sending = true
    renderBar()
    try {
      const result = await api('POST', '/api/rerun', body)
      location.href = result.url
    } catch (error) {
      sending = false
      if (error.code === 'RUN_IN_PROGRESS') await refreshBusy().catch(() => undefined)
      renderBar()
      UI.toast(error.message, { error: true })
    }
  }

  async function cancel() {
    const ok = await UI.confirm({ title: '停止出图？', text: '已交付的图会保留，排队中的不再生成。', ok: '停止', danger: true })
    if (!ok) return
    const button = document.getElementById('ed-cancel')
    button.disabled = true
    try {
      await api('POST', '/api/runs/' + encodeURIComponent(RUN_ID) + '/cancel', {})
    } catch (error) {
      UI.toast(error.message, { error: true })
      return
    } finally {
      button.disabled = false
    }
    location.reload()
  }

  async function refreshBusy() {
    const latest = await api('GET', '/api/runs/' + encodeURIComponent(RUN_ID) + '/editor')
    view.activeRunId = latest.activeRunId
    renderBar()
  }

  async function init() {
    view = await api('GET', '/api/runs/' + encodeURIComponent(RUN_ID) + '/editor')
    buildBar()
    for (const group of view.groups) createPanel(group)
    bindEvents()
    document.body.classList.add('ed-on')
    GRAPH.onRender(decorate)
    decorate()
    renderBar()
    // 测试用：当前选中的图
    window.__EDITOR__ = Object.freeze({
      picked: () => [...picked].map((key) => {
        const [sku, item, model] = key.split('\n')
        return { sku, ...(item ? { item } : {}), model }
      }),
    })
    // 有出图在跑时定时查占用，结束后重出按钮恢复
    setInterval(() => {
      if (view.activeRunId !== null && document.visibilityState === 'visible') void refreshBusy().catch(() => undefined)
    }, BUSY_POLL_MS)
    setInterval(() => {
      if (document.visibilityState === 'visible') void fetch('/api/ping').catch(() => undefined)
    }, PING_MS)
  }

  void init().catch((error) => {
    document.body.insertAdjacentHTML('beforeend', '<div id="ed-bar"><span class="ed-err">编辑功能加载失败：' + esc(error.message) + '</span></div>')
  })
})()
