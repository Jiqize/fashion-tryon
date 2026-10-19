'use strict';
// 合集页编辑抽屉：放图 / 节点两种模式共用，右侧滑出。
// 搭配规则、换装范围、保持画幅的分段控件 / 开关派发 ui-change，由 collection.js 按款串行保存（与组头、设置节点同一逻辑）；
// 合集每次重画后抽屉按当前设置同步显示。
// 参考图、提示词、每件衣服的参考图只存在页面内存里，出图时由 collection.js 经 selection(sku) 取用。

(() => {
  const PANEL = window.__EDITOR_PANEL__
  const COLLECTION = window.__COLLECTION__
  const UI = window.__UI__
  if (PANEL === undefined || COLLECTION === undefined || UI === undefined) return
  const { api, esc, base, thumbUrl } = PANEL
  const PAIRING_TEXT = { fixedGarment: '固定服装', fixedModel: '固定模特', oneToOne: '一对一' }
  const SWAP_TEXT = { outfit: '换整套', top: '只换上衣' }
  const PAIRING_OPTIONS = Object.entries(PAIRING_TEXT).map(([value, label]) => ({ value, label, icon: UI.RULE_ICONS[value] }))
  const SWAP_OPTIONS = Object.entries(SWAP_TEXT).map(([value, label]) => ({ value, label }))
  /** 点这些地方不算「点抽屉外」：抽屉自己、它弹出的菜单、工作表、预览、toast、裁图对话框 */
  const INSIDE = '#cl-drawer, .ui-menu, .ui-sheet, .ui-scrim, .ui-ql, .ui-toasts, #ed-crop'

  /** sku → { panel, el, itemRefs }：关掉抽屉后编辑仍保留 */
  const edits = new Map()
  let openSku = null
  let opener = null
  /** Esc 层级栈里抽屉这一层的出栈函数 */
  let popLayer = null
  /** sku → 上次通知组头时的摘要，变了才重画合集 */
  const summaries = new Map()

  const groupOf = (sku) => COLLECTION.view().groups.find((group) => group.sku === sku)
  const swapOf = (sku) => {
    const selected = COLLECTION.state().selected[sku]
    return selected === undefined ? 'outfit' : selected.swap
  }
  const headOf = (sku) => document.querySelector('#cl-list section.cl-group[data-sku="' + CSS.escape(sku) + '"] .cl-head')

  /** 每件衣服默认用的参考图：裁图顺序里第一张由它裁出的裁图，没有则用原图（与 defaultItemRef 一致） */
  function defaultItemRef(group, garment) {
    return group.crops.find((crop) => group.cropFrom[crop] === garment) || garment
  }

  /** 每件衣服可选的参考图：原图、由它裁出的裁图，再是其余本款裁图 */
  function itemOptions(group, garment) {
    const own = group.crops.filter((crop) => group.cropFrom[crop] === garment)
    const rest = group.crops.filter((crop) => group.cropFrom[crop] !== garment)
    return [garment, ...own, ...rest]
  }

  function entryOf(sku) {
    if (!edits.has(sku)) edits.set(sku, { panel: null, el: null, itemRefs: {} })
    return edits.get(sku)
  }

  /** 固定服装的面板：用默认参考图与范围建，再按当前范围、画幅跟随 */
  function ensurePanel(group) {
    const entry = entryOf(group.sku)
    if (entry.panel !== null) {
      entry.panel.refreshPool(group.garments, group.crops)
      return entry
    }
    const el = document.createElement('div')
    el.className = 'ed-panel'
    el.dataset.sku = group.sku
    entry.el = el
    entry.panel = PANEL.create(el, {
      sku: group.sku,
      settings: { swap: group.defaults.swap, references: group.defaults.references, prompt: group.defaults.prompt, promptEdited: false },
      garments: group.garments,
      crops: group.crops,
      models: [],
      maxReferences: COLLECTION.view().maxReferences,
      keepFrame: group.prefs.keepFrame,
      onChange: () => changed(group.sku),
    })
    return entry
  }

  /** 面板的换装范围跟组头一致（面板里的范围分段控件隐藏） */
  function syncPanelSwap(entry, swap) {
    if (entry.panel === null || entry.panel.getState().swap === swap) return
    const item = entry.el.querySelector('.ui-seg[data-ed="swap"] [data-value="' + swap + '"]')
    if (item !== null) item.click()
  }

  function selection(sku) {
    const group = groupOf(sku)
    const entry = edits.get(sku)
    if (group === undefined || entry === undefined) return null
    const selected = COLLECTION.state().selected[sku]
    const models = selected === undefined ? [] : selected.models
    if (group.prefs.pairing === 'fixedGarment') {
      if (entry.panel === null) return null
      const state = entry.panel.getState()
      const refsChanged = JSON.stringify(state.references) !== JSON.stringify(group.defaults.references)
      if (!refsChanged && !state.promptEdited) return null
      return { models, ...(refsChanged ? { references: state.references } : {}), ...(state.promptEdited ? { prompt: state.prompt } : {}) }
    }
    const changedRefs = Object.entries(entry.itemRefs).filter(([garment, file]) => group.garments.includes(garment) && file !== defaultItemRef(group, garment))
    if (changedRefs.length === 0) return null
    return { models, itemRefs: Object.fromEntries(changedRefs) }
  }

  /** 固定服装款：人改过的提示词可能与当前参考图对不上 */
  function stale(sku) {
    const group = groupOf(sku)
    const entry = edits.get(sku)
    if (group === undefined || entry === undefined || entry.panel === null || group.prefs.pairing !== 'fixedGarment') return false
    return entry.panel.getState().stale
  }

  /** 编辑变了：只在「已改」、参考图张数、提示词可能对不上等摘要变化时重画合集 */
  function changed(sku) {
    const current = selection(sku)
    const summary = JSON.stringify(current === null ? null : { references: current.references, prompt: current.prompt !== undefined, itemRefs: current.itemRefs, stale: stale(sku) })
    if (summaries.get(sku) === summary) return
    summaries.set(sku, summary)
    COLLECTION.render()
  }

  // ---------- 抽屉 ----------

  function ensureDrawer() {
    if (document.getElementById('cl-drawer') !== null) return
    document.body.insertAdjacentHTML('beforeend',
      '<aside id="cl-drawer" class="cl-drawer" aria-hidden="true" aria-labelledby="cl-drawer-title" inert>' +
      '<div class="cl-drawer-head"><h2 id="cl-drawer-title" tabindex="-1"></h2><button type="button" class="cl-btn cl-close">关闭</button></div>' +
      '<div class="cl-drawer-body"></div></aside>')
    const drawer = document.getElementById('cl-drawer')
    drawer.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target.closest('button') : null
      if (target === null) return
      if (target.classList.contains('cl-close')) close()
      else if (target.classList.contains('cl-restore')) void restore()
      else if (target.classList.contains('cl-itemref')) pickItemRef(target)
    })
    // 点抽屉外关闭（页面其余部分仍可滚动查看）
    document.addEventListener('pointerdown', (event) => {
      if (openSku === null) return
      const target = event.target instanceof Element ? event.target : null
      if (target === null || target === document.documentElement || target.closest(INSIDE) !== null) return
      close()
    }, true)
    // 组头、设置节点、抽屉改了设置都会重画合集：重画后抽屉按当前设置同步
    new MutationObserver(sync).observe(document.getElementById('cl-list'), { childList: true })
  }

  /** 分段控件显示某个值（不派发 ui-change） */
  function setSeg(root, value) {
    if (root === null) return
    for (const item of root.querySelectorAll('[role="radio"]')) {
      const on = item.dataset.value === value
      item.setAttribute('aria-checked', String(on))
      item.tabIndex = on ? 0 : -1
    }
  }

  /** 抽屉里的规则、范围、画幅跟合集当前设置一致；规则变了重画内容 */
  function sync() {
    if (openSku === null) return
    const group = groupOf(openSku)
    const body = document.querySelector('#cl-drawer .cl-drawer-body')
    if (group === undefined || body.dataset.pairing !== group.prefs.pairing) {
      renderBody()
      return
    }
    const swap = swapOf(group.sku)
    setSeg(body.querySelector('.ui-seg[data-cl="swap"]'), swap)
    const keep = body.querySelector('.ui-switch[data-cl="keep"]')
    if (keep !== null) keep.setAttribute('aria-checked', String(group.prefs.keepFrame))
    const entry = edits.get(group.sku)
    if (group.prefs.pairing === 'fixedGarment' && entry !== undefined && entry.panel !== null) {
      syncPanelSwap(entry, swap)
      entry.panel.setKeepFrame(group.prefs.keepFrame)
    }
  }

  /** 每件衣服一行：衣服缩略图 → 当前参考图按钮（点开弹出菜单换） */
  function itemRows(group) {
    const entry = entryOf(group.sku)
    return '<ul class="cl-items">' + group.garments.map((garment) => {
      const value = entry.itemRefs[garment] || defaultItemRef(group, garment)
      return '<li class="cl-item"><img src="' + esc(thumbUrl(garment)) + '" alt="" loading="lazy">' +
        '<span class="cl-item-name" title="' + esc(garment) + '">' + esc(base(garment)) + '</span>' +
        '<span class="cl-item-arrow" aria-hidden="true">→</span>' +
        '<button type="button" class="cl-itemref" data-item="' + esc(garment) + '" data-value="' + esc(value) + '" aria-haspopup="menu" title="' + esc(base(garment)) + ' 用的参考图">' +
        '<img src="' + esc(thumbUrl(value)) + '" alt="" loading="lazy"><span class="cl-itemref-name">' + esc(base(value)) + '</span><span class="cl-chev" aria-hidden="true">⌄</span></button></li>'
    }).join('') + '</ul>'
  }

  /** 弹出菜单：原图与各张裁图（带缩略图），当前项打勾；选中即换 */
  function pickItemRef(button) {
    const sku = openSku
    const group = groupOf(sku)
    if (group === undefined) return
    const garment = button.dataset.item
    const current = button.dataset.value
    const items = itemOptions(group, garment).map((file, index) => ({
      value: file,
      label: file === garment ? base(garment) + '（原图）' : base(file),
      image: thumbUrl(file),
      checked: file === current,
      separatorBefore: index === 1,
    }))
    UI.menu(button, items, (value) => {
      if (openSku !== sku) return
      entryOf(sku).itemRefs[garment] = value
      renderBody()
      const again = document.querySelector('#cl-drawer .cl-itemref[data-item="' + CSS.escape(garment) + '"]')
      if (again !== null) again.focus()
      changed(sku)
    })
  }

  function renderBody() {
    const group = groupOf(openSku)
    const body = document.querySelector('#cl-drawer .cl-drawer-body')
    if (group === undefined) {
      delete body.dataset.pairing
      body.innerHTML = '<p class="cl-empty">这款还没有素材</p>'
      return
    }
    // 重画会冲掉焦点：规则 / 范围 / 画幅控件有焦点时，画完找回
    const active = document.activeElement
    const control = active instanceof Element && body.contains(active) ? active.closest('[data-cl]') : null
    const keep = control === null ? null : { cl: control.dataset.cl, value: active.dataset.value }
    const swap = swapOf(group.sku)
    const rule = group.prefs.pairing
    const fixed = rule === 'fixedGarment'
    body.dataset.pairing = rule
    body.innerHTML =
      '<h4>搭配规则</h4>' + UI.segHtml('data-cl="pairing"', PAIRING_OPTIONS, rule, '搭配规则') +
      '<h4>换装范围</h4>' + UI.segHtml('data-cl="swap"', SWAP_OPTIONS, swap, '换装范围') +
      '<h4>画幅</h4>' + UI.switchHtml('data-cl="keep"', group.prefs.keepFrame, '保持图1画幅，不补画被截掉的部位') +
      '<h4>' + (fixed ? '参考图与提示词' : '每件衣服用的参考图') + '</h4>' +
      (fixed ? '<div class="cl-panel-slot"></div>' : itemRows(group)) +
      '<p class="cl-drawer-foot"><button type="button" class="cl-btn cl-restore">恢复默认</button></p>'
    if (fixed) {
      const entry = ensurePanel(group)
      body.querySelector('.cl-panel-slot').append(entry.el)
      syncPanelSwap(entry, swap)
      entry.panel.setKeepFrame(group.prefs.keepFrame)
    }
    if (keep !== null) {
      const root = body.querySelector('[data-cl="' + keep.cl + '"]')
      const target = root === null || keep.value === undefined ? root : root.querySelector('[data-value="' + CSS.escape(keep.value) + '"]')
      if (target !== null) target.focus()
    }
  }

  function open(sku) {
    ensureDrawer()
    if (groupOf(sku) === undefined) return
    opener = document.activeElement
    openSku = sku
    const drawer = document.getElementById('cl-drawer')
    drawer.dataset.sku = sku
    document.getElementById('cl-drawer-title').textContent = '编辑 · ' + sku
    renderBody()
    drawer.removeAttribute('inert')
    drawer.setAttribute('aria-hidden', 'false')
    // Esc 经层级栈关闭：上面还有菜单、工作表、裁图对话框时先关它们
    if (popLayer === null) popLayer = UI.pushLayer(close)
    document.getElementById('cl-drawer-title').focus()
  }

  function close() {
    const drawer = document.getElementById('cl-drawer')
    if (drawer === null || openSku === null) return
    const sku = openSku
    openSku = null
    if (popLayer !== null) popLayer()
    popLayer = null
    drawer.setAttribute('aria-hidden', 'true')
    drawer.setAttribute('inert', '')
    // 焦点回到打开抽屉的按钮；它被重画掉了就回到这款的组头
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
    else {
      const head = headOf(sku)
      const edit = head && head.querySelector('.cl-edit')
      if (edit) edit.focus()
    }
  }

  /** 恢复默认：先出工作表确认；参考图、提示词、每件衣服的参考图回到默认，规则与范围不变 */
  async function restore() {
    if (openSku === null) return
    const sku = openSku
    const ok = await UI.confirm({ title: '恢复默认？', text: '参考图和提示词回到默认，搭配规则与换装范围不变。', ok: '恢复默认' })
    if (!ok) return
    edits.delete(sku)
    if (openSku === sku) renderBody()
    changed(sku)
  }

  ensureDrawer()
  window.__COLLECTION_DRAWER__ = { open, close, selection, stale }
})()
