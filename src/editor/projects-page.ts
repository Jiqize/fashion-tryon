import { THEME_CSS } from '../simple/graph.js'

// 项目页外壳：只经项目服务（http）打开，内容由 /ui/projects.js 按 /api/projects 画出
// 内联只有样式（CSP 按 sha256 放行），脚本全部从 /ui/ 加载

export function renderProjectsPage(): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>项目</title>
<style>${THEME_CSS}</style>
<link rel="stylesheet" href="/ui/editor.css">
<script src="/ui/controls.js" defer></script>
<script src="/ui/projects.js" defer></script>
</head><body class="pj-page">
<header id="pj-top"></header>
<main class="wrap" id="pj-app"><div id="pj-grid"></div></main>
</body></html>
`
}
