import type { RunRecord, RunShot } from './record.js'

// 精简流程的结果报告：每款一节，列出参考图和提示词；每张模特照一行，原图与成图并排
// 只读页面，没有按键、判定或交付操作；图片用相对 runDir 的路径

function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 相对路径逐段编码，文件名里的空格和括号也能正常加载。 */
function src(relative: string): string {
  return relative.split('/').map(encodeURIComponent).join('/')
}

const STYLE = `
:root{--bg:#f6f5f2;--card:#fff;--fg:#1d1c1a;--mut:#77736b;--line:#e3e0d9;--ok:#2f5d50;--err:#9a3b3b}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#161614;--card:#1f1e1b;--fg:#ece9e2;--mut:#9a958a;--line:#34322d;--ok:#7fc0aa;--err:#e39a8f;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,"PingFang SC",sans-serif}
.wrap{max-width:1240px;margin:auto;padding:32px 16px 80px}h1{font-size:26px;margin:0 0 4px}.sub{color:var(--mut);margin:0 0 20px}
nav{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px}nav a{color:var(--fg);border:1px solid var(--line);padding:3px 12px;border-radius:99px;text-decoration:none}
section{margin-top:36px}.head{display:flex;gap:14px;align-items:baseline;border-bottom:2px solid var(--fg);padding-bottom:6px}.head h2{margin:0;font-size:22px}.head p{margin:0;color:var(--mut)}
.refs-label{font-size:12px;color:var(--mut);margin:12px 0 4px}.refs{display:flex;gap:8px;overflow-x:auto;margin:0 0 12px}.refs figure{margin:0;flex:none}.refs img{height:220px;border-radius:4px;cursor:zoom-in;display:block}.refs figcaption{font-size:11px;color:var(--mut);max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
details{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 14px;margin-bottom:12px}summary{cursor:pointer;color:var(--mut)}pre{white-space:pre-wrap;margin:8px 0 0;font:12.5px/1.7 ui-monospace,Menlo,monospace}
.shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,520px),1fr));gap:12px}
.shot{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.pair img{width:100%;aspect-ratio:2/3;object-fit:cover;border-radius:6px;cursor:zoom-in;display:block}.ph{aspect-ratio:2/3;border:1px dashed var(--line);border-radius:6px;display:grid;place-items:center;color:var(--err);padding:12px;text-align:center;font-size:12px}
.cap{display:flex;justify-content:space-between;gap:8px;font-size:12px;color:var(--mut);margin-top:6px;overflow-wrap:anywhere}.cap b{color:var(--ok);font-weight:600}
#lb{position:fixed;inset:0;background:rgba(0,0,0,.85);display:flex;align-items:center;justify-content:center;z-index:9}#lb[hidden]{display:none}#lb img{max-height:94vh;max-width:96vw}
`

const PENDING_TEXT: Record<RunShot['state'], string> = {
  queued: '排队',
  generating: '生成中',
  done: '',
  failed: '失败',
  cancelled: '已取消',
}

/** 每组的锚点与标题：同款号多组时依次加 -2、-3，带 item 的组标题带衣服图名。 */
function groupHeads(result: RunRecord): { id: string; title: string }[] {
  const seen = new Map<string, number>()
  return result.groups.map((group) => {
    const count = (seen.get(group.sku) ?? 0) + 1
    seen.set(group.sku, count)
    const id = count === 1 ? group.sku : `${group.sku}-${String(count)}`
    const title = group.item === undefined ? group.sku : `${group.sku} · ${group.item.split('/').pop() ?? group.item}`
    return { id, title }
  })
}

export function renderSimpleReport(result: RunRecord, sourceRoot: string): string {
  const heads = groupHeads(result)
  const sections = result.groups.map((group, index) => {
    const head = heads[index]!
    const refs = group.references.map((ref) => {
      const name = ref.file.split('/').pop() ?? ref.file
      return `<figure><img src="${src(ref.thumb)}" alt="${escape(name)}"><figcaption title="${escape(name)}">${escape(name)}</figcaption></figure>`
    }).join('')
    const shots = group.shots.map((shot) => {
      const name = shot.model.split('/').pop() ?? shot.model
      const output = shot.result !== undefined
        ? `<img src="${src(shot.result)}" alt="成图">`
        : `<div class="ph">${shot.error === undefined ? PENDING_TEXT[shot.state] : `失败：${escape(shot.error)}`}</div>`
      return `<article class="shot"><div class="pair"><img src="${src(shot.modelThumb)}" alt="${escape(name)}">${output}</div>
<div class="cap"><span>模特图 ${escape(name)}</span>${shot.delivered === undefined ? '' : `<b>${escape(shot.delivered)}</b>`}</div></article>`
    }).join('')
    return `<section id="${escape(head.id)}"><div class="head"><h2>${escape(head.title)}</h2><p>${group.references.length} 张服装参考图 · ${group.shots.length} 张模特图${group.note === undefined ? '' : ` · ${escape(group.note)}`}</p></div>
<p class="refs-label">${group.referenceSource === 'crops' ? '发给模型的服装参考图：裁图/ 里的裁切图' : '发给模型的服装参考图：服装/ 里的原图，只缩小到 1024px，未裁切'}</p>
<div class="refs">${refs}</div>
<details><summary>提示词</summary><pre>${escape(group.prompt)}</pre></details>
<div class="shots">${shots}</div></section>`
  }).join('\n')

  const { delivered, failed, cancelled, skippedGroups } = result.counts
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>试衣结果</title><style>${STYLE}</style></head><body><div class="wrap">
<h1>试衣结果</h1>
<p class="sub">${escape(sourceRoot)} · 引擎 ${escape(result.engine)} · 已写入成图 ${String(delivered)} 张${failed > 0 ? ` · 失败 ${String(failed)} 张` : ''}${cancelled > 0 ? ` · 已取消 ${String(cancelled)} 张` : ''}${skippedGroups > 0 ? ` · 跳过 ${String(skippedGroups)} 款` : ''}</p>
<nav>${heads.map((head) => `<a href="#${escape(head.id)}">${escape(head.title)}</a>`).join('')}</nav>
${sections}
</div><div id="lb" hidden><img alt=""></div>
<script>
const lb=document.getElementById('lb'),li=lb.querySelector('img');
document.addEventListener('click',e=>{const t=e.target;if(t.tagName==='IMG'&&!lb.contains(t)){li.src=t.src;lb.hidden=false}else if(lb.contains(t))lb.hidden=true});
document.addEventListener('keydown',e=>{if(e.key==='Escape')lb.hidden=true});
</script></body></html>
`
}
