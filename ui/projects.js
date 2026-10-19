'use strict';
// 项目页：一个项目就是一个素材根目录，卡片网格列出本机项目列表（经 /api/projects）。
// 点卡片进入该目录的合集页（同一个标签页）；新建 = 系统选文件夹窗口；管理只有改显示名、在 Finder 里打开、从列表移除（可撤销）。
// 打开页面或点「刷新」时重新统计，不做定时刷新；不删除、不移动任何文件夹或文件。

(() => {
  const UI = window.__UI__
  if (UI === undefined) return
  const esc = (text) => String(text).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
  const NAME_MAX = 40

  let projects = []
  let busy = false

  async function api(method, url, body) {
    const response = await fetch(url, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error((data.error && data.error.message) || ('请求失败：' + response.status))
    return data
  }

  const fail = (error) => UI.toast(error.message, { error: true })
  const folderName = (root) => root.split('/').filter(Boolean).pop() || root
  const pad = (value) => String(value).padStart(2, '0')

  /** 本地时间 MM-DD HH:mm */
  function shortTime(iso) {
    const date = new Date(iso)
    return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
  }

  const byId = (id) => projects.find((project) => project.id === id)

  function visible() {
    const query = document.getElementById('pj-search').value.trim().toLowerCase()
    if (query === '') return projects
    return projects.filter((project) => project.name.toLowerCase().includes(query) || folderName(project.root).toLowerCase().includes(query))
  }

  function cardHtml(project) {
    const more = '<button type="button" class="pj-more" aria-label="更多操作" title="更多操作">…</button>'
    if (project.missing) {
      return '<article class="pj-card is-missing" data-id="' + esc(project.id) + '">' +
        '<div class="pj-cover is-empty"></div>' + more +
        '<div class="pj-body"><h2 class="pj-name">' + esc(project.name) + '</h2>' +
        '<p class="pj-meta pj-gone">找不到文件夹</p><p class="pj-path">' + esc(project.root) + '</p></div></article>'
    }
    const cover = project.cover === null
      ? '<div class="pj-cover is-empty"></div>'
      : '<div class="pj-cover"><img src="/cover/' + encodeURIComponent(project.id) + '?v=' + encodeURIComponent(project.cover) + '" alt="" loading="lazy"></div>'
    return '<article class="pj-card" data-id="' + esc(project.id) + '" tabindex="0" role="link" aria-label="打开 ' + esc(project.name) + '">' +
      cover + more +
      '<div class="pj-body"><h2 class="pj-name">' + esc(project.name) + '</h2>' +
      '<p class="pj-meta">' + project.skuCount + ' 款 · ' + project.outputCount + ' 张成图</p>' +
      '<p class="pj-meta">' + (project.lastRunAt === null ? '还没出图' : '最近出图 ' + esc(shortTime(project.lastRunAt))) +
      (project.redoCount > 0 ? ' <span class="pj-redo">待重出 ' + project.redoCount + '</span>' : '') + '</p></div></article>'
  }

  function render() {
    document.getElementById('pj-info').textContent = projects.length + ' 个项目'
    document.getElementById('pj-grid').innerHTML = visible().map(cardHtml).join('') +
      '<button type="button" class="pj-card pj-new" id="pj-new"><span class="pj-plus" aria-hidden="true">＋</span>新建项目</button>'
  }

  async function load() {
    try {
      projects = (await api('GET', '/api/projects')).projects
      render()
    } catch (error) {
      fail(error)
    }
  }

  /** 进入合集页：服务端拉起或复用该目录的编辑服务 */
  async function openProject(id) {
    if (busy) return
    busy = true
    try {
      location.href = (await api('POST', '/api/projects/open', { id })).url
    } catch (error) {
      fail(error)
    } finally {
      busy = false
    }
  }

  async function newProject() {
    if (busy) return
    busy = true
    try {
      const result = await api('POST', '/api/projects/pick', {})
      if (!result.cancelled) location.href = result.url
    } catch (error) {
      fail(error)
    } finally {
      busy = false
    }
  }

  async function rename(project) {
    const name = await UI.ask({ title: '改显示名', text: '只改显示的名字，不改文件夹名；清空恢复为文件夹名', value: project.name, maxLength: NAME_MAX, ok: '保存' })
    if (name === null) return
    try {
      await api('POST', '/api/projects/rename', { id: project.id, name })
      await load()
    } catch (error) {
      fail(error)
    }
  }

  async function reveal(project) {
    try {
      await api('POST', '/api/projects/reveal', { id: project.id })
    } catch (error) {
      fail(error)
    }
  }

  async function remove(project) {
    const ok = await UI.confirm({ title: '从列表移除「' + project.name + '」？', text: '只从项目页移除，不删除文件夹里的任何文件', ok: '移除' })
    if (!ok) return
    try {
      const { removed } = await api('POST', '/api/projects/remove', { id: project.id })
      await load()
      UI.toast('已移除 ' + project.name, {
        action: {
          label: '撤销',
          run: () => {
            void api('POST', '/api/projects/restore', { entry: removed }).then(load, fail)
          },
        },
      })
    } catch (error) {
      fail(error)
    }
  }

  function openMenu(button, project) {
    const items = project.missing
      ? [{ value: 'remove', label: '从列表移除' }]
      : [{ value: 'rename', label: '改显示名' }, { value: 'reveal', label: '在 Finder 里打开' }, { value: 'remove', label: '从列表移除', separatorBefore: true }]
    UI.menu(button, items, (value) => {
      if (value === 'rename') void rename(project)
      else if (value === 'reveal') void reveal(project)
      else void remove(project)
    })
  }

  function buildTop() {
    document.getElementById('pj-top').innerHTML = '<div class="cl-top-in">' +
      '<div class="cl-brand"><h1>项目</h1><span id="pj-info"></span></div>' +
      '<span class="cl-spacer"></span>' +
      '<input id="pj-search" type="search" placeholder="搜索项目" aria-label="搜索项目">' +
      '<button type="button" class="cl-btn" id="pj-refresh">刷新</button></div>'
  }

  function bind() {
    const grid = document.getElementById('pj-grid')
    grid.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : null
      if (target === null) return
      if (target.closest('#pj-new') !== null) {
        void newProject()
        return
      }
      const card = target.closest('.pj-card[data-id]')
      const project = card === null ? undefined : byId(card.dataset.id)
      if (project === undefined) return
      const more = target.closest('.pj-more')
      if (more !== null) openMenu(more, project)
      else if (!project.missing) void openProject(project.id)
    })
    grid.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || !(event.target instanceof Element) || !event.target.matches('.pj-card[data-id]')) return
      const project = byId(event.target.dataset.id)
      if (project !== undefined && !project.missing) void openProject(project.id)
    })
    // 封面加载失败时显示空白占位
    grid.addEventListener('error', (event) => {
      if (event.target instanceof HTMLImageElement) event.target.parentElement.classList.add('is-empty')
    }, true)
    const search = document.getElementById('pj-search')
    search.addEventListener('input', render)
    document.getElementById('pj-refresh').addEventListener('click', () => { void load() })
    // ⌘F / Ctrl+F 聚焦搜索
    document.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        search.focus()
        search.select()
      }
    })
  }

  buildTop()
  bind()
  render()
  void load()
})()
