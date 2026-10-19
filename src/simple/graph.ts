import { randomUUID } from 'node:crypto'
import { rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { RunRecord } from './record.js'

// 每次出图的只读节点图：graph.html 是不含数据的静态页，数据在同目录 run-data.js
// 页面在 file:// 下加载 run-data.js，进行中每 3 秒重新加载一次，只更新变化的节点
// 经编辑服务（http）打开时再加载 /ui/editor.js，编辑交互都在那里；file:// 下只读

/** 配色变量与基础排版；合集页共用。 */
export const THEME_CSS = `
:root{--bg:#f6f5f2;--card:#fff;--fg:#1d1c1a;--mut:#77736b;--line:#e3e0d9;--wire:#c9c5bc;--ok:#2f5d50;--err:#9a3b3b}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#161614;--card:#1f1e1b;--fg:#ece9e2;--mut:#9a958a;--line:#34322d;--wire:#4a4740;--ok:#7fc0aa;--err:#e39a8f;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 -apple-system,"PingFang SC",sans-serif}
.wrap{padding:28px 16px 80px;max-width:1600px;margin:auto}h1{font-size:24px;margin:0 0 6px}
.meta{display:flex;flex-wrap:wrap;gap:6px 18px;color:var(--mut);margin:0 0 6px}.meta b{color:var(--fg);font-weight:600}`

const STYLE = `${THEME_CSS}
.status{font-weight:600}.st-running{color:var(--fg)}.st-completed{color:var(--ok)}.st-partial,.st-interrupted{color:var(--err)}.st-cancelled{color:var(--mut)}
.skipped{color:var(--mut);margin:4px 0 0}.skipped span{margin-right:14px}
.lane{margin-top:26px;border-top:2px solid var(--fg);padding-top:10px}.lane h2{margin:0 0 10px;font-size:19px}.lane .note{color:var(--mut);font-weight:400;font-size:13px;margin-left:10px}
.flow{display:flex;align-items:center}
.node{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px;flex:none}
.wire{flex:none;width:28px;height:1px;background:var(--wire)}
.label{font-size:11px;color:var(--mut);margin:0 0 6px;letter-spacing:.02em}
.refs{display:grid;grid-template-columns:repeat(2,74px);gap:6px}.refs figure{margin:0}.refs img{width:74px;height:100px;object-fit:cover;border-radius:4px;display:block;cursor:zoom-in}
.refs figcaption{font-size:10.5px;color:var(--mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:74px}
.prompt{width:170px}.prompt .swap{font-weight:600;margin:0 0 6px}.prompt details summary{cursor:pointer;color:var(--mut);font-size:12px}
.prompt pre{position:absolute;z-index:3;max-width:min(520px,90vw);background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;white-space:pre-wrap;font:12px/1.7 ui-monospace,Menlo,monospace;margin:6px 0 0}
.shots{display:flex;flex-wrap:wrap;gap:10px 14px;flex:1;min-width:0;border-left:1px solid var(--wire);padding-left:14px}
.pair{display:flex;align-items:center}.pair .wire{width:18px}
.thumb{width:96px;height:182px;padding:6px}img[data-role=result]{width:84px;height:126px;object-fit:cover;border-radius:4px;cursor:zoom-in}.thumb img{width:84px;height:126px;object-fit:cover;border-radius:4px;display:block;cursor:zoom-in}
.out{width:150px;padding:6px}.out .ph{width:84px;height:126px;border:1px dashed var(--line);border-radius:4px;display:grid;place-items:center;color:var(--mut);font-size:12px}
.out{height:182px;overflow:hidden}.out .row{display:flex;gap:8px}.out .state{font-size:12px;font-weight:600;overflow-wrap:anywhere;margin-top:3px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.out .file{font-size:11px;color:var(--mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.s-done .state{color:var(--ok)}.s-failed .state{color:var(--err)}.s-cancelled .state{color:var(--mut)}.s-generating{border-color:var(--fg)}
.extra{font-size:10.5px;color:var(--mut);max-width:150px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:3px}.lane h2 .cl-redo{font-size:12px;font-weight:400;margin-left:10px;color:var(--mut)}
.cap{font-size:10.5px;color:var(--mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:84px;margin-top:3px}
#lb{position:fixed;inset:0;background:rgba(0,0,0,.86);display:flex;gap:12px;align-items:center;justify-content:center;z-index:9;padding:16px}#lb[hidden]{display:none}
#lb img{max-height:92vh;max-width:min(48vw,900px);object-fit:contain}#lb.single img{max-width:96vw}
.empty{color:var(--mut);margin-top:30px}
.ro{color:var(--mut);font-size:12px;margin:0 0 6px}.from{margin:0 0 6px;color:var(--mut)}.from a{color:inherit}
.prompt .edited{font-size:11px;font-weight:600;color:var(--err);margin-left:6px}
@media (max-width:720px){.flow{flex-direction:column;align-items:flex-start;gap:10px}.flow>.wire{display:none}.shots{border-left:0;padding-left:0}}
`

const SCRIPT = String.raw`
const STATUS_TEXT={running:'进行中',completed:'已完成',partial:'部分失败',cancelled:'已取消',interrupted:'已中断'};
const STATE_TEXT={queued:'排队',generating:'生成中',done:'已完成',failed:'失败',cancelled:'已取消'};
const SWAP_TEXT={outfit:'换整套',top:'只换上衣'};
const STALE_MS=60000;
const $=(sel,el=document)=>el.querySelector(sel);
const esc=v=>String(v).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
const src=rel=>rel.split('/').map(encodeURIComponent).join('/');
const base=p=>p.split('/').pop();
let built=false,lastRun=null,timer=null;
const nodeCache=new Map();
const HTTP=location.protocol==='http:'||location.protocol==='https:';
const renderHooks=[];

function effective(run){
  if(run.status!=='running')return run.status;
  const beat=Date.parse(run.heartbeatAt||run.startedAt||'');
  return Number.isFinite(beat)&&Date.now()-beat>STALE_MS?'interrupted':'running';
}
function elapsed(run,status){
  const start=Date.parse(run.startedAt||'');if(!Number.isFinite(start))return '—';
  const end=status==='running'?Date.now():Date.parse(run.finishedAt||run.heartbeatAt||'')||Date.now();
  const s=Math.max(0,Math.round((end-start)/1000));const m=Math.floor(s/60);
  return m>=60?Math.floor(m/60)+' 小时 '+(m%60)+' 分':m>0?m+' 分 '+(s%60)+' 秒':s+' 秒';
}
function renderHead(run){
  const status=effective(run),p=run.params,c=run.counts;
  const parts=[];
  if(p){parts.push('换装范围 <b>'+esc(SWAP_TEXT[p.swap]||p.swap)+'</b>');parts.push('款号 <b>'+esc(p.skus?p.skus.join('、'):'全部')+'</b>');}
  parts.push('引擎 <b>'+esc(run.engine||'—')+'</b>');
  parts.push('状态 <span class="status st-'+status+'">'+STATUS_TEXT[status]+'</span>');
  parts.push('已完成 <b>'+c.delivered+'</b> / 计划 <b>'+c.planned+'</b>'+(c.failed?' · 失败 <b>'+c.failed+'</b>':'')+(c.cancelled?' · 已取消 <b>'+c.cancelled+'</b>':''));
  parts.push('已用时间 <b>'+elapsed(run,status)+'</b>');
  $('#meta').innerHTML=parts.map(x=>'<span>'+x+'</span>').join('');
  const skipped=run.groups.filter(g=>g.shots.length===0&&g.note);
  $('#skipped').innerHTML=skipped.length?'跳过 '+skipped.length+' 款：'+skipped.map(g=>'<span>'+esc(g.sku)+' '+esc(g.note)+'</span>').join(''):'';
  const from=$('#from');
  if(run.derivedFrom){
    const href=HTTP?'/runs/'+encodeURIComponent(run.derivedFrom)+'/':'../'+encodeURIComponent(run.derivedFrom)+'/graph.html';
    from.innerHTML='来自 <a href="'+esc(href)+'">'+esc(run.derivedFrom)+'</a>';from.hidden=false;
  }else from.hidden=true;
  document.title='出图节点图 · '+STATUS_TEXT[status];
  return status;
}
function shotHtml(g,s){
  const state=s.state,name=base(s.model);
  const item=g.item?' data-item="'+esc(g.item)+'"':'';
  let body;
  if(state==='done'&&s.result){
    body='<div class="row"><img data-role="result" src="'+src(s.result)+'" alt="成图"></div><div class="state">已完成</div><div class="file" title="'+esc(s.delivered||'')+'">'+esc(base(s.delivered||''))+'</div>';
  }else{
    const text=state==='failed'?'失败：'+(s.error||''):STATE_TEXT[state];
    body='<div class="ph">'+(state==='generating'?'生成中…':STATE_TEXT[state])+'</div><div class="state" title="'+esc(text)+'">'+esc(text)+'</div>';
  }
  let out='<div class="node out s-'+state+'">'+body+'</div>';
  // 追加提示词（半身、待重出备注）在成图节点下以小字显示前 20 字
  if(s.extraPrompt){const chars=[...s.extraPrompt];out='<div>'+out+'<div class="extra" title="'+esc(s.extraPrompt)+'">追加：'+esc(chars.slice(0,20).join(''))+(chars.length>20?'…':'')+'</div></div>';}
  return '<div class="pair" data-shot data-sku="'+esc(g.sku)+'"'+item+' data-model="'+esc(s.model)+'"><div class="node thumb"><img data-role="model" src="'+src(s.modelThumb)+'" alt="'+esc(name)+'"><div class="cap" title="'+esc(name)+'">'+esc(name)+'</div></div><span class="wire"></span>'+out+'</div>';
}
function build(run){
  const lanes=run.groups.map((g,gi)=>{
    // 带 item 的组（固定模特、一对一）只读：修改与重出在合集页完成
    const title=g.item?esc(g.sku)+' · '+esc(base(g.item)):esc(g.sku);
    const redo=g.item&&HTTP?'<a class="cl-redo" href="/materials/">在合集里重出</a>':'';
    const head='<h2>'+title+(g.note?'<span class="note">'+esc(g.note)+'</span>':'')+redo+'</h2>';
    const lane='<section class="lane" data-sku="'+esc(g.sku)+'"'+(g.item?' data-item="'+esc(g.item)+'"':'')+'>';
    if(g.shots.length===0)return lane+head+'</section>';
    const refs=g.references.map(r=>{const n=r.role||base(r.file);return '<figure><img src="'+src(r.thumb)+'" alt="'+esc(n)+'"><figcaption title="'+esc(r.file)+'">'+esc(n)+'</figcaption></figure>'}).join('');
    const mode=g.swap||(run.params&&run.params.swap);
    const swap=mode?SWAP_TEXT[mode]||mode:'—';
    const source=g.referenceSource==='crops'?'裁图':g.referenceSource==='custom'?'自选':'原图';
    const shots=g.shots.map((s,si)=>'<div id="s'+gi+'-'+si+'">'+shotHtml(g,s)+'</div>').join('');
    return lane+head+'<div class="flow">'+
      '<div class="node"><p class="label">服装参考图 · '+source+'</p><div class="refs">'+refs+'</div></div><span class="wire"></span>'+
      '<div class="node prompt"><p class="label">提示词'+(g.promptEdited?'<span class="edited">已改</span>':'')+'</p><p class="swap">'+esc(swap)+'</p><details><summary>展开全文</summary><pre>'+esc(g.prompt)+'</pre></details></div><span class="wire"></span>'+
      '<div class="shots">'+shots+'</div></div></section>';
  }).join('');
  $('#lanes').innerHTML=lanes||'<p class="empty">没有可出图的款</p>';
  run.groups.forEach((g,gi)=>g.shots.forEach((s,si)=>nodeCache.set(gi+'-'+si,JSON.stringify(s))));
  built=true;
}
function update(run){
  run.groups.forEach((g,gi)=>g.shots.forEach((s,si)=>{
    const key=gi+'-'+si,json=JSON.stringify(s);
    if(nodeCache.get(key)===json)return;
    nodeCache.set(key,json);
    const el=document.getElementById('s'+key);if(el)el.innerHTML=shotHtml(g,s);
  }));
  // 缩略图在计划写出后才生成：加载失败的图下次刷新时重试
  document.querySelectorAll('img[data-broken]').forEach(img=>{img.removeAttribute('data-broken');img.src=img.src.split('?')[0]+'?t='+Date.now()});
}
function render(run){
  lastRun=run;
  if(!built)build(run);else update(run);
  const status=renderHead(run);
  for(const hook of renderHooks)hook(run);
  return status;
}
// 编辑脚本用：取当前数据、每次渲染后回调、整页重建
window.__GRAPH__={getRun:()=>lastRun,onRender:cb=>{renderHooks.push(cb)},rebuild:()=>{if(!lastRun)return;built=false;nodeCache.clear();render(lastRun)}};
if(HTTP){
  const css=document.createElement('link');css.rel='stylesheet';css.href='/ui/editor.css';document.head.appendChild(css);
  const h1=$('h1');if(h1)h1.insertAdjacentHTML('beforeend',' <a class="cl-nav" href="/materials/">合集</a>');
  // 动态插入的脚本默认异步：关掉 async，保证共享控件、面板脚本依次先于 editor.js 执行
  for(const name of ['controls.js','editor-panel.js','editor.js']){const js=document.createElement('script');js.src='/ui/'+name;js.async=false;document.head.appendChild(js);}
}else $('#ro').hidden=false;
function load(){
  const s=document.createElement('script');
  s.src='run-data.js?t='+Date.now();
  s.onload=()=>{s.remove();const run=window.__RUN__;if(!run)return;const status=render(run);if(status==='running')timer=setTimeout(load,3000);};
  s.onerror=()=>{s.remove();timer=setTimeout(load,3000)};
  document.head.appendChild(s);
}
document.addEventListener('error',e=>{if(e.target.tagName==='IMG')e.target.setAttribute('data-broken','')},true);
setInterval(()=>{if(lastRun&&effective(lastRun)==='running')renderHead(lastRun)},1000);
const lb=$('#lb');
document.addEventListener('click',e=>{
  const t=e.target;
  if(lb.contains(t)){lb.hidden=true;lb.innerHTML='';return}
  if(t.tagName!=='IMG')return;
  const pair=t.closest('[data-shot]');
  const imgs=pair?[...pair.querySelectorAll('img[data-role]')]:[t];
  lb.className=imgs.length>1?'':'single';
  lb.innerHTML=imgs.map(i=>'<img src="'+i.src+'" alt="'+esc(i.alt)+'">').join('');
  lb.hidden=false;
});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){lb.hidden=true;lb.innerHTML=''}});
load();
`

export function renderGraphPage(record: RunRecord): string {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>出图节点图</title><style>${STYLE}</style></head><body><div class="wrap">
<h1>出图节点图 · ${record.runId}</h1>
<p class="ro" id="ro" hidden>只读页面：要编辑请让 Agent 调用 open_graph，或运行 fashion-tryon editor &lt;素材根目录&gt;</p>
<p class="from" id="from" hidden></p>
<div class="meta" id="meta">加载中…</div>
<p class="skipped" id="skipped"></p>
<div id="lanes"></div>
</div><div id="lb" hidden></div>
<script>${SCRIPT}</script></body></html>
`
}

export function renderRunData(record: RunRecord): string {
  return `window.__RUN__ = ${JSON.stringify(record)};\n`
}

/** graph.html 只在不存在时写；run-data.js 每次原子覆盖。 */
export async function writeGraphFiles(record: RunRecord): Promise<void> {
  await writeFile(record.graphPath, renderGraphPage(record), { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error
  })
  const target = path.join(record.runDir, 'run-data.js')
  const temporary = `${target}.tmp-${String(process.pid)}-${randomUUID()}`
  try {
    await writeFile(temporary, renderRunData(record))
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}
