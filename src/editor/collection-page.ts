import { THEME_CSS } from '../simple/graph.js'

// 合集页外壳：只经编辑服务（http）打开，内容由 /ui/collection.js 按 /api/collection 画出
// 内联只有样式（CSP 按 sha256 放行），脚本全部从 /ui/ 加载

export function renderCollectionPage(): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>合集</title>
<style>${THEME_CSS}</style>
<link rel="stylesheet" href="/ui/editor.css">
<script src="/ui/controls.js" defer></script>
<script src="/ui/editor-panel.js" defer></script>
<script src="/ui/collection.js" defer></script>
<script src="/ui/collection-drawer.js" defer></script>
</head><body class="cl-page">
<header id="cl-top"></header>
<main class="wrap" id="cl-app"><div id="cl-list"></div></main>
</body></html>
`
}
