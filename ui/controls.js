// 共享控件：分段控件、开关、弹出菜单、工作表确认、toast、快速预览、Esc 层级栈
// 无依赖，合集页与 run 页都可先加载；全部挂在 window.__UI__
(function () {
  'use strict'
  // 重复加载时不重复绑定事件
  if (window.__UI__) return

  const esc = (text) => String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
  const CLOSE_MS = 260

  // ===== Esc 层级栈：Esc 只关最上层 =====
  const layers = []
  function addLayer(close, onKey) {
    const entry = { close, onKey }
    layers.push(entry)
    return () => {
      const index = layers.indexOf(entry)
      if (index >= 0) layers.splice(index, 1)
    }
  }
  function pushLayer(close) {
    return addLayer(close)
  }

  // ===== 分段控件与开关 =====
  function segHtml(attrs, options, value, label) {
    return '<span class="ui-seg" role="radiogroup" aria-label="' + esc(label) + '" ' + attrs + '>' +
      options.map((option) => {
        const on = option.value === value
        return '<button type="button" role="radio" data-value="' + esc(option.value) + '" aria-checked="' + on + '" tabindex="' + (on ? 0 : -1) + '">' +
          (option.icon || '') + esc(option.label) + '</button>'
      }).join('') + '</span>'
  }

  function switchHtml(attrs, checked, label) {
    return '<button type="button" class="ui-switch" role="switch" aria-checked="' + (checked === true) + '" ' + attrs + '><i></i>' + esc(label) + '</button>'
  }

  function emit(root, value) {
    root.dispatchEvent(new CustomEvent('ui-change', { bubbles: true, detail: { value } }))
  }

  function selectSeg(item) {
    if (item.getAttribute('aria-checked') === 'true') return false
    const root = item.closest('.ui-seg')
    for (const other of root.querySelectorAll('[role="radio"]')) {
      const on = other === item
      other.setAttribute('aria-checked', String(on))
      other.tabIndex = on ? 0 : -1
    }
    emit(root, item.dataset.value)
    return true
  }

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null
    if (!target) return
    const item = target.closest('.ui-seg [role="radio"]')
    if (item && !item.disabled) {
      selectSeg(item)
      return
    }
    const sw = target.closest('.ui-switch')
    if (sw && !sw.disabled) {
      const next = sw.getAttribute('aria-checked') !== 'true'
      sw.setAttribute('aria-checked', String(next))
      emit(sw, next)
    }
  })

  // ===== 弹出菜单 =====
  let closeMenu = null
  function menu(anchor, items, onPick) {
    if (closeMenu) closeMenu(false)
    const el = document.createElement('div')
    el.className = 'ui-menu'
    el.setAttribute('role', 'menu')
    el.tabIndex = -1
    el.innerHTML = items.map((item) =>
      (item.separatorBefore ? '<hr>' : '') +
      '<button type="button" role="menuitem" tabindex="-1" data-value="' + esc(item.value) + '">' +
      (item.image ? '<img src="' + esc(item.image) + '" alt="">' : '') +
      '<span>' + esc(item.label) + '</span>' +
      (item.checked ? '<span class="ui-ck" aria-hidden="true">✓</span>' : '') +
      '</button>').join('')
    document.body.appendChild(el)
    // 放在控件下方；下方放不下时翻到上方
    const rect = anchor.getBoundingClientRect()
    const height = el.offsetHeight
    el.style.left = Math.max(8, Math.min(rect.left, innerWidth - el.offsetWidth - 8)) + 'px'
    el.style.top = (rect.bottom + 6 + height > innerHeight ? Math.max(8, rect.top - 6 - height) : rect.bottom + 6) + 'px'

    const buttons = () => [...el.querySelectorAll('[role="menuitem"]')]
    const pick = (button) => {
      done(true)
      onPick(button.dataset.value)
    }
    const onKey = (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const list = buttons()
        const index = list.indexOf(document.activeElement)
        const step = event.key === 'ArrowDown' ? 1 : -1
        const next = index < 0 ? (step > 0 ? 0 : list.length - 1) : (index + step + list.length) % list.length
        list[next]?.focus()
        return true
      }
      if (event.key === 'Enter' || event.key === ' ') {
        if (el.contains(document.activeElement) && document.activeElement.matches('[role="menuitem"]')) pick(document.activeElement)
        return true
      }
      return false
    }
    const onPointer = (event) => {
      if (!el.contains(event.target) && !anchor.contains(event.target)) done(true)
    }
    el.addEventListener('click', (event) => {
      const button = event.target instanceof Element ? event.target.closest('[role="menuitem"]') : null
      if (button) pick(button)
    })
    let closed = false
    const done = (refocus) => {
      if (closed) return
      closed = true
      pop()
      closeMenu = null
      document.removeEventListener('pointerdown', onPointer, true)
      el.classList.remove('on')
      setTimeout(() => el.remove(), CLOSE_MS)
      if (refocus) anchor.focus()
    }
    const pop = addLayer(() => done(true), onKey)
    closeMenu = done
    document.addEventListener('pointerdown', onPointer, true)
    el.classList.add('on')
    el.focus()
  }

  // ===== 遮罩 =====
  function scrim(onClick) {
    const el = document.createElement('div')
    el.className = 'ui-scrim'
    el.addEventListener('click', onClick)
    document.body.appendChild(el)
    void el.offsetWidth
    el.classList.add('on')
    return () => {
      el.classList.remove('on')
      setTimeout(() => el.remove(), CLOSE_MS)
    }
  }

  // ===== 工作表确认 =====
  // field 为 null 是确认（返回 true/false）；否则带输入框，确认返回输入的文字、取消返回 null
  function sheet(opts, field) {
    return new Promise((resolve) => {
      const before = document.activeElement
      const el = document.createElement('div')
      el.className = 'ui-sheet'
      el.setAttribute('role', 'alertdialog')
      el.setAttribute('aria-modal', 'true')
      el.setAttribute('aria-labelledby', 'ui-sheet-title')
      el.innerHTML = '<h3 id="ui-sheet-title">' + esc(opts.title) + '</h3><p>' + esc(opts.text || '') + '</p>' +
        (field === null ? '' : '<input class="ui-sheet-input" aria-label="' + esc(opts.title) + '"' +
          (opts.maxLength ? ' maxlength="' + esc(opts.maxLength) + '"' : '') + (opts.placeholder ? ' placeholder="' + esc(opts.placeholder) + '"' : '') + '>') +
        '<div class="ui-sheet-btns"><button type="button" class="ui-btn" data-answer="0">取消</button>' +
        '<button type="button" class="ui-btn ui-btn-primary' + (opts.danger ? ' ui-btn-danger' : '') + '" data-answer="1">' + esc(opts.ok) + '</button></div>'
      let settled = false
      const finish = (answer) => {
        if (settled) return
        settled = true
        pop()
        hideScrim()
        el.classList.remove('on')
        setTimeout(() => el.remove(), CLOSE_MS)
        if (before instanceof HTMLElement) before.focus()
        resolve(field === null ? answer : (answer ? input.value : null))
      }
      const hideScrim = scrim(() => finish(false))
      el.addEventListener('click', (event) => {
        const button = event.target instanceof Element ? event.target.closest('[data-answer]') : null
        if (button) finish(button.dataset.answer === '1')
      })
      const onKey = (event) => {
        if (event.key === 'Enter') {
          // 焦点在「取消」上时回车 = 取消，避免误确认产生费用
          finish(!(document.activeElement instanceof HTMLElement && document.activeElement.dataset.answer === '0'))
          return true
        }
        return false
      }
      const pop = addLayer(() => finish(false), onKey)
      const input = el.querySelector('.ui-sheet-input')
      if (input !== null) input.value = field
      document.body.appendChild(el)
      void el.offsetWidth
      el.classList.add('on')
      if (input !== null) {
        input.focus()
        input.select()
      } else el.querySelector('[data-answer="1"]').focus()
    })
  }
  function confirm(opts) {
    return sheet(opts, null)
  }
  /** 带输入框的工作表：opts.value 预填，回车确认、Esc 取消 */
  function ask(opts) {
    return sheet(opts, opts.value || '')
  }

  // ===== toast =====
  function toast(message, opts) {
    const options = opts || {}
    let box = document.getElementById('ui-toasts')
    if (!box) {
      box = document.createElement('div')
      box.id = 'ui-toasts'
      box.className = 'ui-toasts'
      document.body.appendChild(box)
    }
    const el = document.createElement('div')
    el.className = 'ui-toast' + (options.error ? ' is-error' : '')
    el.setAttribute('role', options.error ? 'alert' : 'status')
    el.innerHTML = '<span class="ui-toast-ic"></span><span class="ui-toast-msg"></span>'
    el.querySelector('.ui-toast-msg').textContent = message
    if (options.link) {
      const link = document.createElement('a')
      link.className = 'ui-toast-link'
      link.href = options.link.href
      link.textContent = options.link.label
      el.appendChild(link)
    }
    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      el.classList.add('out')
      setTimeout(() => el.remove(), CLOSE_MS)
    }
    if (options.action) {
      const action = document.createElement('button')
      action.type = 'button'
      action.className = 'ui-toast-act'
      action.textContent = options.action.label
      action.addEventListener('click', () => {
        options.action.run()
        close()
      })
      el.appendChild(action)
    }
    const closer = document.createElement('button')
    closer.type = 'button'
    closer.className = 'ui-toast-close'
    closer.setAttribute('aria-label', '关闭')
    closer.textContent = '✕'
    closer.addEventListener('click', close)
    el.appendChild(closer)
    box.appendChild(el)
    // 出错停留到点关闭；其余按时自动消失
    if (!options.error) setTimeout(close, options.ms || (options.action ? 5000 : 3000))
  }

  // ===== 快速预览 =====
  let closeQuickLook = null
  function quickLook(items, index) {
    if (closeQuickLook) closeQuickLook()
    if (items.length === 0) return
    const before = document.activeElement
    let current = Math.max(0, Math.min(index, items.length - 1))
    const el = document.createElement('div')
    el.className = 'ui-ql'
    el.setAttribute('role', 'dialog')
    el.setAttribute('aria-modal', 'true')
    el.setAttribute('aria-label', '快速预览')
    el.innerHTML = '<figure><img alt=""><figcaption><span class="ui-ql-name"></span><span>← → 切换 · 空格或 Esc 关闭</span></figcaption></figure>'
    const show = () => {
      el.querySelector('img').src = items[current].src
      el.querySelector('.ui-ql-name').textContent = items[current].name
    }
    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      pop()
      closeQuickLook = null
      hideScrim()
      el.classList.remove('on')
      setTimeout(() => el.remove(), CLOSE_MS)
      if (before instanceof HTMLElement) before.focus()
    }
    const onKey = (event) => {
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        current = (current + (event.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length
        show()
        return true
      }
      if (event.key === ' ') {
        close()
        return true
      }
      return false
    }
    // 点图片之外的地方关闭
    el.addEventListener('click', (event) => { if (!(event.target instanceof Element && event.target.closest('figure'))) close() })
    const hideScrim = scrim(close)
    const pop = addLayer(close, onKey)
    closeQuickLook = close
    show()
    document.body.appendChild(el)
    void el.offsetWidth
    el.classList.add('on')
  }

  // ===== 键盘：层级栈优先，其次分段控件的 ← → =====
  document.addEventListener('keydown', (event) => {
    const top = layers[layers.length - 1]
    if (top) {
      if ((top.onKey && top.onKey(event)) || event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (event.key === 'Escape') {
          layers.pop()
          top.close()
        }
        return
      }
    }
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
    const item = event.target instanceof Element ? event.target.closest('.ui-seg [role="radio"]') : null
    if (!item) return
    event.preventDefault()
    const list = [...item.closest('.ui-seg').querySelectorAll('[role="radio"]')].filter((button) => !button.disabled)
    const index = list.findIndex((button) => button.getAttribute('aria-checked') === 'true')
    const next = list[(index + (event.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length]
    if (!next) return
    // 先移焦点再派发：页面重画控件时可按 data-value 找回焦点
    next.focus()
    selectSeg(next)
  }, true)

  const RULE_ICONS = {
    fixedGarment: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M5.5 2 3 3.5 1.5 7l2 1V14h9V8l2-1L13 3.5 10.5 2C10 3.2 9.1 3.8 8 3.8S6 3.2 5.5 2Z"/></svg>',
    fixedModel: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="8" cy="4.2" r="2.4"/><path d="M3 14.5c.4-3.2 2.4-5 5-5s4.6 1.8 5 5"/></svg>',
    oneToOne: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M2 5h9m-2.5-2.5L11 5 8.5 7.5M14 11H5m2.5-2.5L5 11l2.5 2.5"/></svg>',
  }

  window.__UI__ = Object.freeze({ segHtml, switchHtml, RULE_ICONS, menu, confirm, ask, toast, quickLook, pushLayer })
})()
