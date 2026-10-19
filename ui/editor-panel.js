'use strict';
// 共用编辑面板：节点图 run 页面（editor.js）与合集页编辑抽屉（collection-drawer.js）都用它编辑一款的出图设置。
// 参考图拖动排序、从可添加区拖入即加入、拖出列表或点 × 即移除；↑↓ 按钮保留给键盘；点模特缩略图切换选中。
// 可改项、校验与提示词跟随规则与节点编辑器 spec 3.1–3.3 一致：编辑只在页面内存里，拖框裁图例外（保存即写入 裁图/<款号>/）。

(() => {
  const SWAP_TEXT = { outfit: '换整套', top: '只换上衣' }
  const SWAP_OPTIONS = Object.entries(SWAP_TEXT).map(([value, label]) => ({ value, label }))
  /** 共享控件（controls.js 先于本脚本加载） */
  const UI = window.__UI__
  const REF_TYPE = 'application/x-ed-ref'

  const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  const base = (file) => file.split('/').pop()
  /** 裁图被重新保存后换个地址，绕过浏览器缓存 */
  const busted = new Map()
  const imageUrl = (prefix, file) => prefix + file.split('/').map(encodeURIComponent).join('/') + (busted.has(file) ? '?t=' + busted.get(file) : '')
  /** 原图：裁图、对照大图用 */
  const sourceUrl = (file) => imageUrl('/source/', file)
  /** 缩略图（长边 320）：列表、面板里的小图用 */
  const thumbUrl = (file) => imageUrl('/thumb/', file)

  async function api(method, url, body) {
    const response = await fetch(url, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      const error = new Error((data.error && data.error.message) || ('请求失败：' + response.status))
      error.code = data.error && data.error.code
      error.status = response.status
      throw error
    }
    return data
  }

  /** 保持画幅时由服务端在默认提示词末尾加固定句子 */
  const defaultPrompt = (references, swap, keepFrame) =>
    api('POST', '/api/prompt', keepFrame ? { references, swap, keepFrame: true } : { references, swap }).then((data) => data.prompt)

  // ---------- 拖框裁图（全页一个对话框） ----------

  let cropping = null
  /** Esc 层级栈里裁图对话框这一层的出栈函数：Esc 先关裁图，不关下面的抽屉 */
  let popCrop = null

  function ensureCropDialog() {
    if (document.getElementById('ed-crop') !== null) return
    document.body.insertAdjacentHTML('beforeend',
      '<div id="ed-crop" hidden><div class="ed-crop-box"><div class="ed-crop-head"><b>拖框裁图</b><span id="ed-crop-file"></span><button type="button" id="ed-crop-close">关闭</button></div>' +
      '<div class="ed-crop-stage"><img id="ed-crop-img" alt="" draggable="false"><div id="ed-crop-rect" hidden></div></div>' +
      '<div class="ed-crop-foot"><label>用途名 <input id="ed-crop-role" maxlength="40" placeholder="如 全身-正面、细节-领口"></label>' +
      '<button type="button" id="ed-crop-save" disabled>保存裁图</button><span id="ed-crop-msg"></span></div></div></div>')
    const img = document.getElementById('ed-crop-img')
    const rect = document.getElementById('ed-crop-rect')
    let start = null
    const point = (event) => {
      const area = img.getBoundingClientRect()
      return {
        x: Math.min(Math.max(event.clientX - area.left, 0), area.width),
        y: Math.min(Math.max(event.clientY - area.top, 0), area.height),
        width: area.width,
        height: area.height,
      }
    }
    const draw = (a, b) => {
      rect.style.left = img.offsetLeft + Math.min(a.x, b.x) + 'px'
      rect.style.top = img.offsetTop + Math.min(a.y, b.y) + 'px'
      rect.style.width = Math.abs(b.x - a.x) + 'px'
      rect.style.height = Math.abs(b.y - a.y) + 'px'
      rect.hidden = false
    }
    img.addEventListener('pointerdown', (event) => {
      if (cropping === null) return
      event.preventDefault()
      img.setPointerCapture(event.pointerId)
      start = point(event)
    })
    img.addEventListener('pointermove', (event) => {
      if (start !== null) draw(start, point(event))
    })
    img.addEventListener('pointerup', (event) => {
      if (start === null || cropping === null) return
      const end = point(event)
      // 千分比，与 crop 工具相同的 [x0,y0,x1,y1]
      const box = [
        Math.round((Math.min(start.x, end.x) / end.width) * 1000),
        Math.round((Math.min(start.y, end.y) / end.height) * 1000),
        Math.round((Math.max(start.x, end.x) / end.width) * 1000),
        Math.round((Math.max(start.y, end.y) / end.height) * 1000),
      ]
      start = null
      cropping.box = box[2] > box[0] && box[3] > box[1] ? box : null
      rect.hidden = cropping.box === null
      document.getElementById('ed-crop-save').disabled = cropping.box === null
    })
    // 对话框里的点击不冒泡到节点图：松开拖框时的 click 会打开节点图的看大图
    document.getElementById('ed-crop').addEventListener('click', (event) => event.stopPropagation())
    document.getElementById('ed-crop-close').addEventListener('click', closeCrop)
    document.getElementById('ed-crop-save').addEventListener('click', () => { void saveCrop() })
  }

  function openCrop(sku, from, role, onSaved) {
    ensureCropDialog()
    cropping = { sku, from, box: null, onSaved }
    document.getElementById('ed-crop-file').textContent = from
    document.getElementById('ed-crop-role').value = role || ''
    document.getElementById('ed-crop-rect').hidden = true
    document.getElementById('ed-crop-msg').textContent = ''
    document.getElementById('ed-crop-save').disabled = true
    document.getElementById('ed-crop-img').src = sourceUrl(from)
    document.getElementById('ed-crop').hidden = false
    if (popCrop === null) popCrop = UI.pushLayer(closeCrop)
  }

  function closeCrop() {
    cropping = null
    if (popCrop !== null) popCrop()
    popCrop = null
    document.getElementById('ed-crop').hidden = true
  }

  async function saveCrop() {
    if (cropping === null || cropping.box === null) return
    const role = document.getElementById('ed-crop-role').value.trim()
    const message = document.getElementById('ed-crop-msg')
    if (role === '') {
      message.textContent = '请填用途名'
      return
    }
    const body = { sku: cropping.sku, from: cropping.from, role, box: cropping.box }
    let result
    try {
      result = await api('POST', '/api/crop', body)
    } catch (error) {
      if (error.code !== 'CROP_EXISTS') {
        message.textContent = error.message
        return
      }
      // 工作表确认：取消时不发替换请求
      if (!(await UI.confirm({ title: error.message, text: '', ok: '替换' }))) return
      if (cropping === null) return
      try {
        result = await api('POST', '/api/crop', { ...body, replace: true })
      } catch (again) {
        message.textContent = again.message
        return
      }
    }
    busted.set(result.file, Date.now())
    const onSaved = cropping.onSaved
    closeCrop()
    onSaved(result.file, role)
  }

  // ---------- 面板 ----------

  /** 拖拽中的东西：{ kind: 'ref', panel, index, remove } 或 { kind: 'pool', panel, file } */
  let drag = null

  /** 参考图松手处是否算「拖出」：本面板列表外的地方算；别的面板里、页面外不算 */
  function isOutsideDrop(target) {
    if (drag === null || drag.kind !== 'ref') return false
    const el = target instanceof Element ? target : null
    if (el === null) return true
    const panel = el.closest('[data-ed-panel]')
    return panel === null || (panel === drag.panel && el.closest('.ed-refs') === null)
  }

  // 只有真正松手在列表外才移除：Esc 取消、拖到窗口外都不会触发 drop
  document.addEventListener('dragover', (event) => {
    if (isOutsideDrop(event.target)) event.preventDefault()
  })
  document.addEventListener('drop', (event) => {
    if (!isOutsideDrop(event.target)) return
    event.preventDefault()
    const remove = drag.remove
    drag = null
    remove()
  })

  function create(container, opts) {
    const settings = opts.settings
    // 拖出判断用：松手处在不在某个面板里
    container.dataset.edPanel = ''
    const state = {
      initial: JSON.stringify({ references: settings.references, swap: settings.swap, prompt: settings.prompt }),
      references: settings.references.map((ref) => ({ ...ref })),
      swap: settings.swap,
      prompt: settings.prompt,
      keepFrame: opts.keepFrame === true,
      // 默认提示词异步取回前，按来源记录判断是否改过
      fallback: settings.promptEdited ? null : settings.prompt,
      // 人改过提示词后参考图或换装范围又变了
      stale: false,
      garments: opts.garments.slice(),
      crops: opts.crops.slice(),
      models: opts.models.map((model) => ({ ...model })),
    }
    const initialModels = opts.models.map((model) => ({ ...model }))
    const notify = () => opts.onChange && opts.onChange(getState())
    // 默认提示词请求的序号：晚到的旧响应不覆盖新的
    let promptSeq = 0

    const isEdited = () => state.prompt !== state.fallback
    const isChanged = () => JSON.stringify({ references: state.references, swap: state.swap, prompt: state.prompt }) !== state.initial

    function blockers() {
      const reasons = []
      if (state.references.length > opts.maxReferences) {
        reasons.push(opts.sku + '：参考图 ' + state.references.length + ' 张，超过上限 ' + opts.maxReferences + ' 张')
      }
      if (state.references.length === 0) reasons.push(opts.sku + '：没有参考图')
      return reasons
    }

    function getState() {
      return {
        swap: state.swap,
        references: state.references.map((ref) => ({ ...ref })),
        prompt: state.prompt,
        promptEdited: isEdited(),
        // 人改过提示词后参考图、范围或画幅又变了：提示词里的图号可能对不上
        stale: state.stale && isEdited(),
        models: state.models.filter((model) => model.selected).map((model) => model.file),
        dirty: isChanged(),
        blockers: blockers(),
      }
    }

    /** 参考图或换装范围变了：取新的默认提示词；没改过提示词就跟随，改过就只提示 */
    async function settingsChanged() {
      const seq = ++promptSeq
      const wasEdited = isEdited()
      render()
      notify()
      const fallback = await defaultPrompt(state.references, state.swap, state.keepFrame)
      if (seq !== promptSeq) return
      state.fallback = fallback
      if (wasEdited) state.stale = true
      else state.prompt = state.fallback
      render()
      notify()
    }

    const promptFlags = () => isEdited() ? ' <span class="ed-edited">已改</span> <button type="button" class="ed-restore">恢复默认</button>' : ''
    const promptWarn = () => state.stale && isEdited() ? '<p class="ed-warn">参考图已变，提示词里的图号可能对不上</p>' : ''

    function refItem(ref, index) {
      const label = ref.role || base(ref.file)
      const last = index === state.references.length - 1
      return '<li class="ed-ref" draggable="true" data-index="' + index + '">' +
        '<div class="ed-ref-img"><img src="' + esc(thumbUrl(ref.file)) + '" alt="' + esc(label) + '" draggable="false">' +
        '<span class="ed-no">图' + (index + 2) + '</span>' +
        '<div class="ed-icons">' +
        '<button type="button" data-act="up"' + (index === 0 ? ' disabled' : '') + ' title="前移" aria-label="前移">↑</button>' +
        '<button type="button" data-act="down"' + (last ? ' disabled' : '') + ' title="后移" aria-label="后移">↓</button>' +
        (ref.file.startsWith('裁图/') ? '<button type="button" data-act="recrop" title="拖框裁图" aria-label="拖框裁图">✂</button>' : '') +
        '<button type="button" data-act="remove" title="移除" aria-label="移除">×</button>' +
        '</div></div>' +
        '<input class="ed-role" value="' + esc(ref.role || '') + '" placeholder="' + esc(base(ref.file)) + '" maxlength="40" aria-label="用途名">' +
        '<span class="ed-file" title="' + esc(ref.file) + '">' + esc(base(ref.file)) + '</span></li>'
    }

    function poolItem(file) {
      return '<figure class="ed-pool-item" draggable="true" data-file="' + esc(file) + '">' +
        '<div class="ed-ref-img"><img src="' + esc(thumbUrl(file)) + '" alt="' + esc(base(file)) + '" draggable="false">' +
        '<div class="ed-icons"><button type="button" data-add="' + esc(file) + '" title="加入" aria-label="加入">+</button>' +
        '<button type="button" data-crop="' + esc(file) + '" title="拖框裁图" aria-label="拖框裁图">✂</button></div></div>' +
        '<figcaption title="' + esc(file) + '">' + esc(base(file)) + '</figcaption></figure>'
    }

    function html() {
      const over = state.references.length > opts.maxReferences
      const selected = state.models.filter((model) => model.selected).length
      const models = state.models.map((model) =>
        '<button type="button" class="ed-model' + (model.selected ? ' is-on' : '') + '" data-model="' + esc(model.file) + '" aria-pressed="' + model.selected + '">' +
        '<img src="' + esc(thumbUrl(model.file)) + '" alt="" draggable="false"><span class="ed-tick" aria-hidden="true">✓</span>' +
        '<span class="ed-model-name" title="' + esc(model.file) + '">' + esc(base(model.file)) + (model.tag ? ' · ' + esc(model.tag) : '') + '</span></button>').join('')
      return '<div class="ed-grid">' +
        '<section class="ed-sec ed-sec-models"><h3>模特图 <span class="ed-count">已选 ' + selected + ' / ' + state.models.length + '</span>' +
        '<button type="button" class="ed-all">全选</button></h3>' +
        '<div class="ed-models">' + (models || '<span class="ed-mut">没有模特图</span>') + '</div></section>' +
        '<section class="ed-sec ed-sec-refs"><h3>参考图 <span class="ed-count">' + state.references.length + ' / ' + opts.maxReferences + '</span>' +
        '<span class="ed-mut ed-hint">拖动排序，拖出列表或点 × 移除</span></h3>' +
        (over ? '<p class="ed-err">参考图 ' + state.references.length + ' 张，超过上限 ' + opts.maxReferences + ' 张</p>' : '') +
        '<ol class="ed-refs">' + state.references.map(refItem).join('') + '</ol>' +
        '<div class="ed-pool"><p class="ed-pool-h">可添加 · 原图 <span class="ed-mut">拖进上面的列表，或点 +</span></p>' +
        '<div class="ed-pool-list" data-pool="garments">' + (state.garments.length ? state.garments.map(poolItem).join('') : '<span class="ed-mut">没有服装原图</span>') + '</div>' +
        '<p class="ed-pool-h">可添加 · 裁图</p><div class="ed-pool-list" data-pool="crops">' + (state.crops.length ? state.crops.map(poolItem).join('') : '<span class="ed-mut">还没有裁图</span>') + '</div>' +
        '</div></section>' +
        '<section class="ed-sec ed-sec-prompt"><h3>换装范围</h3><div class="ed-swap">' +
        UI.segHtml('data-ed="swap"', SWAP_OPTIONS, state.swap, '换装范围') + '</div>' +
        '<h3>提示词<span class="ed-flags">' + promptFlags() + '</span></h3>' +
        '<div class="ed-warn-slot">' + promptWarn() + '</div>' +
        '<textarea class="ed-prompt" rows="12" spellcheck="false">' + esc(state.prompt) + '</textarea></section>' +
        '</div>'
    }

    function render() {
      // 保留正在输入的提示词焦点与光标
      const active = document.activeElement
      const typing = active && container.contains(active) && active.classList.contains('ed-prompt')
      // 范围分段控件有焦点（键盘 ← → 切换）时，画完按值找回
      const seg = active && container.contains(active) && active.closest('.ui-seg[data-ed]') !== null ? active.dataset.value : null
      container.innerHTML = html()
      if (typing) {
        const area = container.querySelector('.ed-prompt')
        area.focus()
        area.setSelectionRange(area.value.length, area.value.length)
      }
      if (seg !== null) {
        const item = container.querySelector('.ui-seg[data-ed="swap"] [data-value="' + seg + '"]')
        if (item !== null) item.focus()
      }
    }

    function moveRef(from, to) {
      const refs = state.references
      const [ref] = refs.splice(from, 1)
      refs.splice(to > from ? to - 1 : to, 0, ref)
    }

    /** 落点：鼠标在某张参考图左半边插到它前面，右半边插到后面；空白处放到末尾 */
    function dropIndex(event) {
      const item = event.target instanceof Element ? event.target.closest('.ed-ref') : null
      if (item === null || !container.contains(item)) return state.references.length
      const rect = item.getBoundingClientRect()
      const index = Number(item.dataset.index)
      return event.clientX < rect.left + rect.width / 2 ? index : index + 1
    }

    container.addEventListener('click', (event) => {
      // 面板里的点击不触发节点图的看大图；分段控件的点击要冒泡到 controls.js 的委托
      if (!(event.target instanceof Element && event.target.closest('.ui-seg') !== null)) event.stopPropagation()
      const target = event.target instanceof Element ? event.target.closest('button') : null
      if (target === null) return
      const item = target.closest('.ed-ref')
      const act = target.dataset.act
      if (item && act) {
        const index = Number(item.dataset.index)
        const refs = state.references
        if (act === 'recrop') {
          openCrop(opts.sku, refs[index].file, refs[index].role, onCropSaved)
          return
        }
        if (act === 'remove') refs.splice(index, 1)
        else if (act === 'up' && index > 0) moveRef(index, index - 1)
        else if (act === 'down' && index < refs.length - 1) moveRef(index, index + 2)
        void settingsChanged().then(() => {
          // 键盘操作后焦点留在挪动后的那张上
          const moved = act === 'up' ? index - 1 : act === 'down' ? index + 1 : -1
          const button = container.querySelector('.ed-ref[data-index="' + moved + '"] button[data-act="' + act + '"]:not(:disabled)')
          if (moved >= 0 && button) button.focus()
        })
        return
      }
      if (target.dataset.add !== undefined) {
        state.references.push({ file: target.dataset.add })
        void settingsChanged()
        return
      }
      if (target.dataset.crop !== undefined) {
        openCrop(opts.sku, target.dataset.crop, '', onCropSaved)
        return
      }
      if (target.dataset.model !== undefined) {
        const model = state.models.find((candidate) => candidate.file === target.dataset.model)
        model.selected = !model.selected
        render()
        notify()
        return
      }
      if (target.classList.contains('ed-all')) {
        const all = state.models.every((model) => model.selected)
        for (const model of state.models) model.selected = !all
        render()
        notify()
        return
      }
      if (target.classList.contains('ed-restore')) {
        state.prompt = state.fallback
        state.stale = false
        render()
        notify()
      }
    })

    container.addEventListener('change', (event) => {
      const target = event.target
      if (!(target instanceof HTMLInputElement)) return
      if (target.classList.contains('ed-role')) {
        const index = Number(target.closest('.ed-ref').dataset.index)
        const role = target.value.trim()
        if (role === '') delete state.references[index].role
        else state.references[index].role = role
        void settingsChanged()
      }
    })

    // 换装范围分段控件
    container.addEventListener('ui-change', (event) => {
      if (!(event.target instanceof HTMLElement) || event.target.dataset.ed !== 'swap') return
      state.swap = event.detail.value
      void settingsChanged()
    })

    container.addEventListener('input', (event) => {
      const target = event.target
      if (!(target instanceof HTMLTextAreaElement) || !target.classList.contains('ed-prompt')) return
      state.prompt = target.value
      if (!isEdited()) state.stale = false
      // 只更新标记，不重画面板：重画会把光标挪走
      container.querySelector('.ed-flags').innerHTML = promptFlags()
      container.querySelector('.ed-warn-slot').innerHTML = promptWarn()
      notify()
    })

    container.addEventListener('dragstart', (event) => {
      const target = event.target instanceof Element ? event.target : null
      const ref = target && target.closest('.ed-ref')
      const pool = target && target.closest('.ed-pool-item')
      if (ref) {
        const index = Number(ref.dataset.index)
        drag = { kind: 'ref', panel: container, index, remove: () => {
          state.references.splice(index, 1)
          void settingsChanged()
        } }
      }
      else if (pool) drag = { kind: 'pool', panel: container, file: pool.dataset.file }
      else return
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData(REF_TYPE, '')
      ;(ref || pool).classList.add('ed-dragging')
    })

    container.addEventListener('dragover', (event) => {
      if (drag === null || drag.panel !== container) return
      const list = event.target instanceof Element ? event.target.closest('.ed-refs') : null
      if (list === null) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      list.classList.add('ed-over')
    })

    container.addEventListener('dragleave', (event) => {
      const list = event.target instanceof Element ? event.target.closest('.ed-refs') : null
      if (list !== null && !list.contains(event.relatedTarget)) list.classList.remove('ed-over')
    })

    container.addEventListener('drop', (event) => {
      if (drag === null || drag.panel !== container) return
      const list = event.target instanceof Element ? event.target.closest('.ed-refs') : null
      if (list === null) return
      event.preventDefault()
      const to = dropIndex(event)
      if (drag.kind === 'ref') {
        moveRef(drag.index, to)
      } else {
        state.references.splice(to, 0, { file: drag.file })
      }
      // 重画会移除被拖的元素，它的 dragend 冒泡不到面板，这里先清掉
      drag = null
      void settingsChanged()
    })

    container.addEventListener('dragend', () => {
      // 拖到列表外松手的移除在 document 的 drop 里做；这里只收尾
      if (drag !== null && drag.panel === container) drag = null
      for (const el of container.querySelectorAll('.ed-dragging,.ed-over')) el.classList.remove('ed-dragging', 'ed-over')
    })

    function onCropSaved(file, role) {
      if (!state.crops.includes(file)) state.crops.push(file)
      const existing = state.references.find((ref) => ref.file === file)
      if (existing === undefined) state.references.push({ file, role })
      else existing.role = role
      void settingsChanged()
    }

    render()
    if (state.keepFrame && !settings.promptEdited) {
      // 保持画幅：传入的默认提示词不带固定句子，没改过就跟随带句子的默认
      void settingsChanged().catch(() => undefined)
    } else {
      // 取回真正的默认提示词，用来判断「已改」与跟随
      const initialSeq = ++promptSeq
      void defaultPrompt(state.references, state.swap, state.keepFrame).then((fallback) => {
        if (initialSeq !== promptSeq) return
        state.fallback = fallback
        render()
        notify()
      }).catch(() => undefined)
    }

    return {
      getState,
      /** 保持画幅开关：没改过的提示词跟随，改过的只提示 */
      setKeepFrame(on) {
        if (state.keepFrame === on) return
        state.keepFrame = on
        void settingsChanged().catch(() => undefined)
      },
      /** 外部改模特勾选（run 页面左侧勾选框） */
      setSelected(files) {
        const wanted = new Set(files)
        for (const model of state.models) model.selected = wanted.has(model.file)
        render()
      },
      reset() {
        const initial = JSON.parse(state.initial)
        state.references = initial.references
        state.swap = initial.swap
        state.prompt = initial.prompt
        state.stale = false
        state.models = initialModels.map((model) => ({ ...model }))
        render()
        notify()
      },
      /** 刷新后的素材：可添加区换新；模特图保留原勾选，新出现的默认选中，消失的去掉 */
      refreshPool(garments, crops, models) {
        state.garments = garments.slice()
        state.crops = crops.slice()
        if (models !== undefined) {
          const old = new Map(state.models.map((model) => [model.file, model]))
          state.models = models.map((file) => old.get(file) || { file, selected: true })
        }
        render()
        notify()
      },
    }
  }

  window.__EDITOR_PANEL__ = { create, api, esc, base, sourceUrl, thumbUrl }
})()
