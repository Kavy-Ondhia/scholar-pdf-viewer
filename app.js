
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.js');

// ─── STATE ─────────────────────────────────────────────────────────
const PALETTE = [
  '#fbbf24','#4ade80','#f472b6','#60a5fa',
  '#fb923c','#a78bfa','#34d399','#f87171'
];
let pdfDoc=null, pdfBytes=null, scale=1.5;
let tool='select', penColor='#fbbf24', penOpacity=0.45;
let annotations=[], searchIDs=[], searchIdx=-1;
let currentPage=1, darkPDF=true, sidebarOpen=true;
const scroll=document.getElementById('scroll');

// ─── HELPERS ───────────────────────────────────────────────────────
const uid=()=>Math.random().toString(36).slice(2,9);
function toast(msg,ms=2600){
  const t=document.getElementById('toast');
  t.textContent=msg;t.classList.add('show');
  clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove('show'),ms);
}
function setLoad(on,txt='',pct=0){
  document.getElementById('loading').classList.toggle('gone',!on);
  document.getElementById('load-text').textContent=txt;
  document.getElementById('load-bar').style.width=pct+'%';
}
function hex2rgba(hex,a){
  const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${a})`;
}

// ─── COLOR DOTS ────────────────────────────────────────────────────
(function buildColors(){
  const wrap=document.getElementById('color-dots');
  PALETTE.forEach(c=>{
    const d=document.createElement('div');
    d.className='c-dot'+(c===penColor?' on':'');
    d.style.background=c;d.title=c;
    d.onclick=()=>{
      penColor=c;
      document.querySelectorAll('.c-dot').forEach(x=>x.classList.remove('on'));
      d.classList.add('on');
    };
    wrap.appendChild(d);
  });
})();
document.getElementById('color-custom').addEventListener('input',e=>{
  penColor=e.target.value;
  document.querySelectorAll('.c-dot').forEach(x=>x.classList.remove('on'));
});
document.getElementById('opacity-range').addEventListener('input',e=>{
  penOpacity=parseInt(e.target.value)/100;
});

// ─── TOOL BUTTONS ──────────────────────────────────────────────────
document.querySelectorAll('.tool[data-tool]').forEach(btn=>{
  btn.addEventListener('click',()=>activateTool(btn.dataset.tool));
});
function activateTool(t){
  tool=t;
  document.querySelectorAll('.tool[data-tool]').forEach(b=>b.classList.toggle('on',b.dataset.tool===t));
  const drawTools=['pen','rect','arrow','note','text-a','eraser','ai-area'];
  const isText=['select','highlight','underline','strikethrough'].includes(t);
  document.querySelectorAll('.ann-c').forEach(c=>{
    c.classList.toggle('draw',drawTools.includes(t));
  });
  document.querySelectorAll('.txt-layer').forEach(tl=>{
    tl.style.pointerEvents=isText?'auto':'none';
  });
  if(t==='ai-area') startAICapture();
}

// ─── DARK/LIGHT TOGGLE ─────────────────────────────────────────────
document.getElementById('btn-dark').addEventListener('click',()=>{
  darkPDF=!darkPDF;
  document.body.classList.toggle('dark-pdf',darkPDF);
  document.getElementById('btn-dark').textContent=darkPDF?'☀ Light':'🌙 Dark';
});

// ─── SIDEBAR ───────────────────────────────────────────────────────
document.getElementById('btn-sidebar').addEventListener('click',()=>{
  sidebarOpen=!sidebarOpen;
  document.getElementById('sidebar').classList.toggle('closed',!sidebarOpen);
});
document.querySelectorAll('.stab').forEach(tab=>{
  tab.addEventListener('click',()=>{
    document.querySelectorAll('.stab').forEach(t=>t.classList.remove('on'));
    document.querySelectorAll('.spanel').forEach(p=>p.classList.remove('on'));
    tab.classList.add('on');
    document.getElementById('panel-'+tab.dataset.panel).classList.add('on');
  });
});

// ─── LOAD PDF ──────────────────────────────────────────────────────
const params=new URLSearchParams(location.search);
const fileUrl=params.get('file')||'';

async function loadPDF(){
  if(!fileUrl){setLoad(false);toast('No PDF specified.');return;}
  try{
    const name=decodeURIComponent(fileUrl).split('/').pop().split('?')[0];
    document.getElementById('filename').textContent=name;
    document.title=name+' — Scholar';
  }catch(_){}
  setLoad(true,'Loading PDF…',10);
  try{
    // Use PDF.js built-in fetching — handles file:// and https:// without CORS issues
    const loadingTask = pdfjsLib.getDocument({
      url: fileUrl,
      withCredentials: false,
    });
    loadingTask.onProgress = function(p){
      if(p.total) setLoad(true,'Downloading…', 10+(p.loaded/p.total)*40);
    };
    pdfDoc = await loadingTask.promise;
    const n=pdfDoc.numPages;
    document.getElementById('page-of').textContent='/ '+n;
    document.getElementById('page-input').max=n;
    setLoad(true,'Rendering pages…',55);
    await renderAll();
    setLoad(false);
    renderThumbs();
    // Grab raw bytes for export in background (non-blocking)
    try{
      const r=await fetch(fileUrl);
      pdfBytes=await r.arrayBuffer();
    }catch(_){ pdfBytes=null; }
  }catch(e){
    setLoad(false);
    document.getElementById('scroll').innerHTML=
      '<div style="padding:40px;text-align:center;color:#f87171;font-size:14px;">'
      +'\u26a0\ufe0f Could not load PDF<br><br>'
      +'<span style="color:#666;font-size:12px;">'+e.message+'</span><br><br>'
      +'<span style="color:#555;font-size:11px;">If this is a local file, enable \"Allow access to file URLs\"<br>'
      +'in brave://extensions → Scholar → Details</span></div>';
    console.error(e);
  }
}

// ─── LAZY RENDER SYSTEM ──────────────────────────────────────
// Pages are placeholder divs until they scroll into view
const renderedPages = new Set();
let lazyObserver = null;

async function renderAll(){
  scroll.innerHTML='';
  renderedPages.clear();
  if(lazyObserver) lazyObserver.disconnect();

  // Get real page size from page 1 to size all placeholders correctly
  const firstPage = await pdfDoc.getPage(1);
  const firstVP = firstPage.getViewport({scale});
  const pw = Math.round(firstVP.width), ph = Math.round(firstVP.height);

  // Create placeholder shells for every page instantly
  for(let i=1;i<=pdfDoc.numPages;i++){
    const wrap=document.createElement('div');
    wrap.className='page-wrap page-placeholder';
    wrap.dataset.page=i;
    wrap.style.width=pw+'px';
    wrap.style.height=ph+'px';
    wrap.style.background='#1e1e1e';
    const lbl=document.createElement('div');
    lbl.className='page-label';lbl.textContent=i;
    wrap.appendChild(lbl);
    scroll.appendChild(wrap);
  }
  setLoad(false);
  observePages();

  // Lazy observer: render when page enters viewport (+2 page buffer)
  lazyObserver = new IntersectionObserver((entries)=>{
    entries.forEach(e=>{
      if(e.isIntersecting){
        const num=parseInt(e.target.dataset.page);
        if(!renderedPages.has(num)) renderPageIntoWrap(num, e.target);
        // Pre-render neighbours
        [num-1,num+1,num+2].forEach(n=>{
          if(n>=1&&n<=pdfDoc.numPages&&!renderedPages.has(n)){
            const el=document.querySelector(`.page-wrap[data-page="${n}"]`);
            if(el) renderPageIntoWrap(n,el);
          }
        });
      }
    });
  },{root:scroll,rootMargin:'200px 0px',threshold:0});

  document.querySelectorAll('.page-wrap').forEach(p=>lazyObserver.observe(p));

  // Immediately render first 3 pages
  for(let i=1;i<=Math.min(3,pdfDoc.numPages);i++){
    const el=document.querySelector(`.page-wrap[data-page="${i}"]`);
    if(el) await renderPageIntoWrap(i,el);
  }
}

async function renderPageIntoWrap(num, wrap){
  if(renderedPages.has(num)) return;
  renderedPages.add(num);
  wrap.classList.remove('page-placeholder');

  const page = await pdfDoc.getPage(num);
  const vp = page.getViewport({scale});

  // Resize wrap to actual page dimensions
  wrap.style.width = vp.width+'px';
  wrap.style.height = vp.height+'px';

  // Remove placeholder label temporarily
  const oldLbl = wrap.querySelector('.page-label');
  if(oldLbl) oldLbl.remove();

  // PDF Canvas
  const pdfC=document.createElement('canvas');
  pdfC.className='pdf-c';
  pdfC.width=vp.width; pdfC.height=vp.height;
  wrap.appendChild(pdfC);

  // Text layer
  const txtL=document.createElement('div');
  txtL.className='txt-layer';
  txtL.style.setProperty('--scale-factor', scale);
  wrap.appendChild(txtL);

  // Annotation canvas
  const annC=document.createElement('canvas');
  annC.className='ann-c';
  annC.width=vp.width; annC.height=vp.height;
  wrap.appendChild(annC);

  // Note layer
  const noteL=document.createElement('div');
  noteL.className='note-layer';
  wrap.appendChild(noteL);

  // Page label
  const lbl=document.createElement('div');
  lbl.className='page-label'; lbl.textContent=num;
  wrap.appendChild(lbl);

  await page.render({canvasContext:pdfC.getContext('2d'),viewport:vp}).promise;

  try{
    const tc=await page.getTextContent();
    pdfjsLib.renderTextLayer({textContent:tc,container:txtL,viewport:vp,textDivs:[]});
  }catch(e){}

  setupEvents(annC,noteL,num);
  redraw(num);
}

// renderPage replaced by renderPageIntoWrap above


// ─── PAGE OBSERVER ─────────────────────────────────────────────────
const io=new IntersectionObserver(entries=>{
  entries.forEach(e=>{
    if(e.isIntersecting){
      const p=parseInt(e.target.dataset.page);
      currentPage=p;
      document.getElementById('page-input').value=p;
      document.querySelectorAll('.thumb').forEach(t=>
        t.classList.toggle('on',parseInt(t.dataset.page)===p));
    }
  });
},{root:scroll,threshold:.3});
function observePages(){
  document.querySelectorAll('.page-wrap').forEach(p=>io.observe(p));
}

// ─── NAVIGATION ────────────────────────────────────────────────────
function goPage(n){
  const el=document.querySelector(`.page-wrap[data-page="${n}"]`);
  if(el)el.scrollIntoView({behavior:'smooth',block:'start'});
}
document.getElementById('btn-prev').onclick=()=>goPage(Math.max(1,currentPage-1));
document.getElementById('btn-next').onclick=()=>goPage(Math.min(pdfDoc?.numPages||1,currentPage+1));
document.getElementById('page-input').addEventListener('change',e=>{
  const n=Math.max(1,Math.min(parseInt(e.target.value)||1,pdfDoc?.numPages||1));
  goPage(n);
});

// ─── ZOOM ──────────────────────────────────────────────────────────
function setScale(s){
  scale=Math.max(.4,Math.min(4,s));
  document.getElementById('zoom-label').textContent=Math.round(scale*100)+'%';
  if(pdfDoc) renderAll().then(renderThumbs);
}
document.getElementById('btn-zout').onclick=()=>setScale(scale-.2);
document.getElementById('btn-zin').onclick=()=>setScale(scale+.2);
document.getElementById('btn-fw').onclick=async()=>{
  if(!pdfDoc)return;
  const p=await pdfDoc.getPage(1);
  const vp=p.getViewport({scale:1});
  setScale((scroll.clientWidth-48)/vp.width);
};
document.getElementById('btn-fp').onclick=async()=>{
  if(!pdfDoc)return;
  const p=await pdfDoc.getPage(1);
  const vp=p.getViewport({scale:1});
  setScale((scroll.clientHeight-48)/vp.height);
};
scroll.addEventListener('wheel',e=>{
  if(e.ctrlKey){e.preventDefault();setScale(scale+(e.deltaY<0?.1:-.1));}
},{passive:false});

// ─── ANNOTATION EVENTS ─────────────────────────────────────────────
function setupEvents(annC,noteL,num){
  let down=false,sx=0,sy=0,penPts=[];

  const getXY=e=>{
    const r=annC.getBoundingClientRect();
    return [(e.clientX-r.left)*(annC.width/r.width),(e.clientY-r.top)*(annC.height/r.height)];
  };

  annC.addEventListener('mousedown',e=>{
    if(!['pen','rect','arrow','note','text-a','eraser'].includes(tool))return;
    [sx,sy]=getXY(e);down=true;penPts=[[sx,sy]];
    if(tool==='note'){addStickyNote(num,sx,sy,noteL);down=false;}
    if(tool==='text-a'){addTextLabel(num,sx,sy,noteL);down=false;}
  });

  annC.addEventListener('mousemove',e=>{
    if(!down)return;
    const[x,y]=getXY(e);
    if(tool==='pen'){
      penPts.push([x,y]);
      redraw(num,annC);
      drawPenLive(annC.getContext('2d'),penPts);
    }else if(tool==='rect'||tool==='arrow'){
      redraw(num,annC);
      drawShapeLive(annC.getContext('2d'),tool,sx,sy,x,y);
    }else if(tool==='eraser'){
      eraseNear(num,x,y);
    }
  });

  annC.addEventListener('mouseup',e=>{
    if(!down)return;down=false;
    const[x,y]=getXY(e);
    if(tool==='pen'&&penPts.length>2){
      annotations.push({id:uid(),type:'pen',page:num,color:penColor,opacity:penOpacity,pts:penPts,scale});
    }else if(tool==='rect'){
      annotations.push({id:uid(),type:'rect',page:num,color:penColor,opacity:penOpacity,x1:sx,y1:sy,x2:x,y2:y,scale});
    }else if(tool==='arrow'){
      annotations.push({id:uid(),type:'arrow',page:num,color:penColor,opacity:penOpacity,x1:sx,y1:sy,x2:x,y2:y,scale});
    }
    redraw(num,annC);refreshAnnots();
  });

  // Text highlights via selection
  document.addEventListener('mouseup',e=>{
    if(!['highlight','underline','strikethrough'].includes(tool))return;
    const sel=window.getSelection();
    if(!sel||sel.isCollapsed)return;
    const rng=sel.getRangeAt(0);
    const tl=annC.parentElement.querySelector('.txt-layer');
    if(!tl.contains(rng.commonAncestorContainer))return;
    const pr=annC.getBoundingClientRect();
    const rects=[...rng.getClientRects()].map(r=>({
      x:(r.left-pr.left)*(annC.width/pr.width),
      y:(r.top-pr.top)*(annC.height/pr.height),
      w:r.width*(annC.width/pr.width),
      h:r.height*(annC.height/pr.height)
    })).filter(r=>r.w>0&&r.h>0);
    if(!rects.length)return;
    annotations.push({
      id:uid(),type:tool,page:num,color:penColor,opacity:penOpacity,
      rects,scale,text:sel.toString().slice(0,80)
    });
    sel.removeAllRanges();
    redraw(num,annC);refreshAnnots();
  });
}

// ─── DRAWING ───────────────────────────────────────────────────────
function drawPenLive(ctx,pts){
  if(pts.length<2)return;
  ctx.save();
  ctx.strokeStyle=hex2rgba(penColor,Math.min(penOpacity+.3,1));
  ctx.lineWidth=2.5;ctx.lineCap='round';ctx.lineJoin='round';
  ctx.beginPath();ctx.moveTo(pts[0][0],pts[0][1]);
  pts.slice(1).forEach(p=>ctx.lineTo(p[0],p[1]));
  ctx.stroke();ctx.restore();
}

function drawShapeLive(ctx,type,x1,y1,x2,y2){
  ctx.save();
  ctx.strokeStyle=hex2rgba(penColor,.9);
  ctx.fillStyle=hex2rgba(penColor,penOpacity);
  ctx.lineWidth=2;
  if(type==='rect'){
    ctx.fillRect(x1,y1,x2-x1,y2-y1);
    ctx.strokeRect(x1,y1,x2-x1,y2-y1);
  }else{
    drawArrowShape(ctx,x1,y1,x2,y2);
  }
  ctx.restore();
}

function drawArrowShape(ctx,x1,y1,x2,y2){
  const a=Math.atan2(y2-y1,x2-x1),L=14;
  ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x2,y2);
  ctx.lineTo(x2-L*Math.cos(a-.4),y2-L*Math.sin(a-.4));
  ctx.lineTo(x2-L*Math.cos(a+.4),y2-L*Math.sin(a+.4));
  ctx.closePath();ctx.fill();
}

function redraw(num,canvas){
  if(!canvas)canvas=document.querySelector(`.page-wrap[data-page="${num}"] .ann-c`);
  if(!canvas)return;
  const ctx=canvas.getContext('2d');
  ctx.clearRect(0,0,canvas.width,canvas.height);
  annotations.filter(a=>a.page===num&&!a._search).forEach(a=>drawAnnot(ctx,a,canvas));
}

function redrawAll(){
  if(!pdfDoc)return;
  for(let i=1;i<=pdfDoc.numPages;i++)redraw(i);
}

function drawAnnot(ctx,a,canvas){
  const sf=scale/a.scale;
  ctx.save();ctx.scale(sf,sf);
  const c=a.color||'#fbbf24',op=a.opacity||.4;
  switch(a.type){
    case 'highlight':
      ctx.fillStyle=hex2rgba(c,op);
      a.rects.forEach(r=>ctx.fillRect(r.x,r.y,r.w,r.h));break;
    case 'underline':
      ctx.strokeStyle=hex2rgba(c,Math.min(op+.4,1));ctx.lineWidth=2;
      a.rects.forEach(r=>{ctx.beginPath();ctx.moveTo(r.x,r.y+r.h);ctx.lineTo(r.x+r.w,r.y+r.h);ctx.stroke();});break;
    case 'strikethrough':
      ctx.strokeStyle=hex2rgba(c,Math.min(op+.4,1));ctx.lineWidth=2;
      a.rects.forEach(r=>{ctx.beginPath();ctx.moveTo(r.x,r.y+r.h/2);ctx.lineTo(r.x+r.w,r.y+r.h/2);ctx.stroke();});break;
    case 'pen':
      if(a.pts.length<2)break;
      ctx.strokeStyle=hex2rgba(c,Math.min(op+.3,1));
      ctx.lineWidth=2.5;ctx.lineCap='round';ctx.lineJoin='round';
      ctx.beginPath();ctx.moveTo(a.pts[0][0],a.pts[0][1]);
      a.pts.slice(1).forEach(p=>ctx.lineTo(p[0],p[1]));ctx.stroke();break;
    case 'rect':
      ctx.fillStyle=hex2rgba(c,op);ctx.strokeStyle=hex2rgba(c,.9);ctx.lineWidth=2;
      ctx.fillRect(a.x1,a.y1,a.x2-a.x1,a.y2-a.y1);
      ctx.strokeRect(a.x1,a.y1,a.x2-a.x1,a.y2-a.y1);break;
    case 'arrow':
      ctx.strokeStyle=hex2rgba(c,.9);ctx.fillStyle=hex2rgba(c,.9);ctx.lineWidth=2;
      drawArrowShape(ctx,a.x1,a.y1,a.x2,a.y2);break;
  }
  ctx.restore();
}

function eraseNear(num,x,y,r=22){
  const before=annotations.length;
  annotations=annotations.filter(a=>{
    if(a.page!==num||a._search)return true;
    if(a.type==='pen')return!a.pts.some(p=>Math.hypot(p[0]-x,p[1]-y)<r);
    if(a.type==='rect'||a.type==='arrow')
      return!(x>Math.min(a.x1,a.x2)-r&&x<Math.max(a.x1,a.x2)+r&&
              y>Math.min(a.y1,a.y2)-r&&y<Math.max(a.y1,a.y2)+r);
    if(a.rects)return!a.rects.some(rt=>x>rt.x-r&&x<rt.x+rt.w+r&&y>rt.y-r&&y<rt.y+rt.h+r);
    return true;
  });
  if(annotations.length!==before){redraw(num);refreshAnnots();}
}

// ─── STICKY NOTES ──────────────────────────────────────────────────
function addStickyNote(num,px,py,noteL){
  const id=uid();
  const a={id,type:'note',page:num,x:px,y:py,content:'',scale,color:'#fef08a'};
  annotations.push(a);
  renderNote(a,noteL);refreshAnnots();
}

function renderNote(a,noteL){
  if(!noteL)noteL=document.querySelector(`.page-wrap[data-page="${a.page}"] .note-layer`);
  if(!noteL)return;
  const sf=scale/a.scale;
  const el=document.createElement('div');
  el.className='sticky';el.dataset.id=a.id;
  el.style.left=(a.x*sf)+'px';el.style.top=(a.y*sf)+'px';

  const bar=document.createElement('div');
  bar.className='sticky-bar';
  bar.innerHTML='NOTE';
  const x=document.createElement('span');
  x.className='sticky-x';x.textContent='×';
  x.onclick=()=>{annotations=annotations.filter(n=>n.id!==a.id);el.remove();refreshAnnots();};
  bar.appendChild(x);el.appendChild(bar);

  const ta=document.createElement('textarea');
  ta.placeholder='Write a note…';ta.value=a.content;
  ta.oninput=()=>{a.content=ta.value;refreshAnnots();};
  el.appendChild(ta);
  noteL.appendChild(el);

  // Drag
  let drag=false,ox=0,oy=0;
  bar.addEventListener('mousedown',e=>{drag=true;ox=e.clientX-el.offsetLeft;oy=e.clientY-el.offsetTop;e.preventDefault();});
  document.addEventListener('mousemove',e=>{
    if(!drag)return;
    el.style.left=(e.clientX-ox)+'px';el.style.top=(e.clientY-oy)+'px';
    a.x=(e.clientX-ox)/(scale/a.scale);a.y=(e.clientY-oy)/(scale/a.scale);
  });
  document.addEventListener('mouseup',()=>drag=false);
}

function addTextLabel(num,px,py,noteL){
  if(!noteL)noteL=document.querySelector(`.page-wrap[data-page="${num}"] .note-layer`);
  const id=uid();
  const a={id,type:'text-a',page:num,x:px,y:py,content:'Label',color:penColor,scale};
  annotations.push(a);
  const sf=scale/a.scale;
  const el=document.createElement('div');
  el.className='text-annot';el.dataset.id=id;
  el.style.left=(px*sf)+'px';el.style.top=(py*sf)+'px';
  el.style.color=penColor;
  el.contentEditable=true;el.textContent='Label';
  el.oninput=()=>a.content=el.textContent;
  noteL.appendChild(el);
  el.focus();
  document.execCommand('selectAll',false,null);
  refreshAnnots();
}

// ─── ANNOTATIONS LIST ──────────────────────────────────────────────
const TYPE_LABELS={highlight:'Highlight',underline:'Underline',strikethrough:'Strikethrough',pen:'Drawing',rect:'Rectangle',arrow:'Arrow',note:'Note','text-a':'Text Label'};
function refreshAnnots(){
  const panel=document.getElementById('panel-annots');
  const real=annotations.filter(a=>!a._search);
  if(!real.length){
    panel.innerHTML='<div class="alist-empty">No annotations yet.<br>Use the tools on the left to start annotating.</div>';
    return;
  }
  panel.innerHTML='';
  [...real].reverse().forEach(a=>{
    const el=document.createElement('div');el.className='aitem';
    const dot=document.createElement('div');dot.className='aitem-dot';dot.style.background=a.color||'#888';
    const body=document.createElement('div');body.className='aitem-body';
    body.innerHTML=`<div class="aitem-type">${TYPE_LABELS[a.type]||a.type}</div><div class="aitem-page">Page ${a.page}</div>`;
    if(a.text||a.content){
      const s=document.createElement('div');s.className='aitem-text';
      s.textContent=(a.text||a.content).slice(0,50);body.appendChild(s);
    }
    const del=document.createElement('span');del.className='aitem-del';del.textContent='✕';
    del.onclick=e=>{
      e.stopPropagation();
      annotations=annotations.filter(x=>x.id!==a.id);
      document.querySelectorAll(`[data-id="${a.id}"]`).forEach(n=>n.remove());
      redraw(a.page);refreshAnnots();
    };
    el.onclick=()=>goPage(a.page);
    el.appendChild(dot);el.appendChild(body);el.appendChild(del);
    panel.appendChild(el);
  });
}

// ─── THUMBNAILS ────────────────────────────────────────────────────
async function renderThumbs(){
  const panel=document.getElementById('panel-thumbs');
  panel.innerHTML='';
  // Create placeholders for all pages first
  for(let i=1;i<=pdfDoc.numPages;i++){
    const item=document.createElement('div');
    item.className='thumb'+(i===currentPage?' on':'');
    item.dataset.page=i;
    item.style.minHeight='80px';
    item.style.justifyContent='center';
    item.style.alignItems='center';
    const lbl=document.createElement('span');lbl.textContent=i;
    item.appendChild(lbl);
    item.onclick=()=>goPage(i);
    panel.appendChild(item);
  }
  // Lazily render thumbnails as they scroll into view in sidebar
  const thumbObs = new IntersectionObserver(async(entries)=>{
    for(const e of entries){
      if(!e.isIntersecting) continue;
      const i=parseInt(e.target.dataset.page);
      if(e.target.dataset.rendered) continue;
      e.target.dataset.rendered='1';
      thumbObs.unobserve(e.target);
      try{
        const page=await pdfDoc.getPage(i);
        const vp=page.getViewport({scale:.18});
        const c=document.createElement('canvas');
        c.width=vp.width;c.height=vp.height;
        await page.render({canvasContext:c.getContext('2d'),viewport:vp}).promise;
        e.target.insertBefore(c,e.target.firstChild);
      }catch(err){}
    }
  },{root:panel,rootMargin:'300px 0px',threshold:0});
  document.querySelectorAll('#panel-thumbs .thumb').forEach(t=>thumbObs.observe(t));
}

// ─── SEARCH ────────────────────────────────────────────────────────
const searchMatches=[];
let searchTimer;
document.getElementById('search-input').addEventListener('input',e=>{
  clearTimeout(searchTimer);
  searchTimer=setTimeout(()=>doSearch(e.target.value.trim()),400);
});
document.getElementById('btn-sprev').onclick=()=>jumpSearch(-1);
document.getElementById('btn-snext').onclick=()=>jumpSearch(1);

async function doSearch(q){
  // Clear old search highlights (DOM)
  document.querySelectorAll('.search-hl').forEach(el=>el.remove());
  searchIDs.forEach(id=>annotations=annotations.filter(a=>a.id!==id));
  searchIDs.length=0;searchMatches.length=0;searchIdx=-1;
  document.getElementById('search-count').textContent='';
  if(!q||!pdfDoc)return;

  for(let pg=1;pg<=pdfDoc.numPages;pg++){
    const page=await pdfDoc.getPage(pg);
    const tc=await page.getTextContent();
    const vp=page.getViewport({scale});
    tc.items.forEach(item=>{
      if(!item.str.toLowerCase().includes(q.toLowerCase()))return;
      const tx=pdfjsLib.Util.transform(vp.transform,item.transform);
      const x=tx[4],y=tx[5]-item.height*scale;
      const w=item.width*scale,h=item.height*scale;
      const id=uid();
      annotations.push({id,type:'highlight',page:pg,color:'#fbbf24',opacity:.45,rects:[{x,y,w,h}],scale,_search:true});
      searchIDs.push(id);
      searchMatches.push({page:pg,id});
    });
    redraw(pg);
  }
  document.getElementById('search-count').textContent=searchMatches.length?`${searchMatches.length} found`:'0 found';
  if(searchMatches.length){searchIdx=0;goPage(searchMatches[0].page);toast(`${searchMatches.length} match(es) found`);}
  else toast('No matches found');
}

function jumpSearch(dir){
  if(!searchMatches.length)return;
  searchIdx=(searchIdx+dir+searchMatches.length)%searchMatches.length;
  goPage(searchMatches[searchIdx].page);
}

// ─── AI INTEGRATION ────────────────────────────────────────────────
document.getElementById('btn-claude').addEventListener('click',()=>{
  const sel=getSelection().toString().trim();
  if(!sel){toast('Select some text first, then click Ask Claude');return;}
  navigator.clipboard.writeText(sel).then(()=>{
    window.open('https://claude.ai/new','_blank');
    toast('✦ Text copied — paste it in Claude!');
  });
});
document.getElementById('btn-gemini').addEventListener('click',()=>{
  const sel=getSelection().toString().trim();
  if(!sel){toast('Select text or use 📸 to capture an area for Gemini');return;}
  navigator.clipboard.writeText(sel).then(()=>{
    window.open('https://gemini.google.com','_blank');
    toast('◈ Text copied — paste it in Gemini!');
  });
});

function startAICapture(){
  const overlay=document.getElementById('ai-overlay');
  const selEl=document.getElementById('ai-sel');
  overlay.classList.add('on');
  let drawing=false,sx=0,sy=0;

  function onDown(e){drawing=true;sx=e.clientX;sy=e.clientY;
    selEl.style.cssText=`left:${sx}px;top:${sy}px;width:0;height:0;`;}
  function onMove(e){
    if(!drawing)return;
    const x=Math.min(e.clientX,sx),y=Math.min(e.clientY,sy);
    selEl.style.left=x+'px';selEl.style.top=y+'px';
    selEl.style.width=Math.abs(e.clientX-sx)+'px';
    selEl.style.height=Math.abs(e.clientY-sy)+'px';
  }
  async function onUp(e){
    if(!drawing)return;drawing=false;
    overlay.classList.remove('on');
    overlay.removeEventListener('mousedown',onDown);
    overlay.removeEventListener('mousemove',onMove);
    overlay.removeEventListener('mouseup',onUp);
    const rx=parseFloat(selEl.style.left),ry=parseFloat(selEl.style.top);
    const rw=parseFloat(selEl.style.width),rh=parseFloat(selEl.style.height);
    selEl.style.cssText='';
    if(rw<10||rh<10){activateTool('select');return;}
    await captureArea(rx,ry,rw,rh);
    activateTool('select');
  }
  overlay.addEventListener('mousedown',onDown);
  overlay.addEventListener('mousemove',onMove);
  overlay.addEventListener('mouseup',onUp);
}

async function captureArea(rx,ry,rw,rh){
  // Find matching page
  for(const wrap of document.querySelectorAll('.page-wrap')){
    const pr=wrap.getBoundingClientRect();
    if(rx<pr.right&&rx+rw>pr.left&&ry<pr.bottom&&ry+rh>pr.top){
      const pdfC=wrap.querySelector('.pdf-c');
      const annC=wrap.querySelector('.ann-c');
      const pr2=pdfC.getBoundingClientRect();
      const cx=(rx-pr2.left)*(pdfC.width/pr2.width);
      const cy=(ry-pr2.top)*(pdfC.height/pr2.height);
      const cw=rw*(pdfC.width/pr2.width);
      const ch=rh*(pdfC.height/pr2.height);
      const comp=document.createElement('canvas');
      comp.width=Math.min(cw,pdfC.width-cx);
      comp.height=Math.min(ch,pdfC.height-cy);
      const ctx=comp.getContext('2d');
      ctx.drawImage(pdfC,cx,cy,comp.width,comp.height,0,0,comp.width,comp.height);
      ctx.drawImage(annC,cx,cy,comp.width,comp.height,0,0,comp.width,comp.height);
      comp.toBlob(async blob=>{
        let copied=false;
        try{
          await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);
          copied=true;
        }catch(_){}
        if(copied){showAIDialog();}
        else{
          const url=URL.createObjectURL(blob);
          const a=document.createElement('a');a.href=url;a.download='capture.png';a.click();
          URL.revokeObjectURL(url);
          toast('Image saved — upload it manually to Gemini/Claude');
        }
      });
      return;
    }
  }
}

function showAIDialog(){
  const d=document.createElement('div');d.className='ai-dialog';
  d.innerHTML=`
    <h3>📋 Image Captured!</h3>
    <p>The selected area is copied to your clipboard.<br>Open an AI assistant and paste it directly.</p>
    <div class="ai-btns">
      <button class="ai-btn claude" id="d-claude">✦ Open Claude</button>
      <button class="ai-btn gemini" id="d-gemini">◈ Open Gemini</button>
    </div>
    <button class="ai-close" id="d-close">Close</button>`;
  document.body.appendChild(d);
  d.querySelector('#d-claude').onclick=()=>{window.open('https://claude.ai/new','_blank');toast('Paste the image in Claude! ✦');d.remove();};
  d.querySelector('#d-gemini').onclick=()=>{window.open('https://gemini.google.com','_blank');toast('Paste the image in Gemini! ◈');d.remove();};
  d.querySelector('#d-close').onclick=()=>d.remove();
}

// ─── EXPORT ANNOTATED PDF ──────────────────────────────────────────
document.getElementById('btn-dl').addEventListener('click',exportPDF);

async function exportPDF(){
  if(!pdfDoc||!pdfBytes){toast('No PDF loaded');return;}
  toast('Preparing annotated PDF…',4000);
  try{
    const {PDFDocument,rgb}=PDFLib;
    const doc=await PDFDocument.load(pdfBytes);
    const pages=doc.getPages();

    for(const a of annotations){
      if(a._search||a.type==='note'||a.type==='text-a')continue;
      const pg=pages[a.page-1];if(!pg)continue;
      const{width:pw,height:ph}=pg.getSize();
      const canvas=document.querySelector(`.page-wrap[data-page="${a.page}"] .pdf-c`);
      if(!canvas)continue;
      const cw=canvas.width/(scale/a.scale);
      const ch=canvas.height/(scale/a.scale);
      const sx=pw/cw,sy=ph/ch;

      const hr=parseInt((a.color||'#fbbf24').slice(1,3),16)/255;
      const hg=parseInt((a.color||'#fbbf24').slice(3,5),16)/255;
      const hb=parseInt((a.color||'#fbbf24').slice(5,7),16)/255;
      const c=rgb(hr,hg,hb);
      const op=a.opacity||.4;

      if(a.type==='highlight'){
        a.rects.forEach(r=>pg.drawRectangle({x:r.x*sx,y:ph-(r.y+r.h)*sy,width:r.w*sx,height:r.h*sy,color:c,opacity:op}));
      }else if(a.type==='underline'){
        a.rects.forEach(r=>pg.drawLine({start:{x:r.x*sx,y:ph-(r.y+r.h)*sy},end:{x:(r.x+r.w)*sx,y:ph-(r.y+r.h)*sy},thickness:1.5,color:c,opacity:Math.min(op+.4,1)}));
      }else if(a.type==='strikethrough'){
        a.rects.forEach(r=>pg.drawLine({start:{x:r.x*sx,y:ph-(r.y+r.h*.5)*sy},end:{x:(r.x+r.w)*sx,y:ph-(r.y+r.h*.5)*sy},thickness:1.5,color:c,opacity:Math.min(op+.4,1)}));
      }else if(a.type==='pen'){
        for(let i=1;i<a.pts.length;i++){
          pg.drawLine({start:{x:a.pts[i-1][0]*sx,y:ph-a.pts[i-1][1]*sy},end:{x:a.pts[i][0]*sx,y:ph-a.pts[i][1]*sy},thickness:2,color:c,opacity:Math.min(op+.3,1)});
        }
      }else if(a.type==='rect'){
        const x=Math.min(a.x1,a.x2)*sx,y=ph-Math.max(a.y1,a.y2)*sy;
        const w=Math.abs(a.x2-a.x1)*sx,h=Math.abs(a.y2-a.y1)*sy;
        pg.drawRectangle({x,y,width:w,height:h,color:c,opacity:op,borderColor:c,borderWidth:1.5});
      }else if(a.type==='arrow'){
        pg.drawLine({start:{x:a.x1*sx,y:ph-a.y1*sy},end:{x:a.x2*sx,y:ph-a.y2*sy},thickness:2,color:c,opacity:Math.min(op+.4,1)});
      }
    }

    const bytes=await doc.save();
    const blob=new Blob([bytes],{type:'application/pdf'});
    const url=URL.createObjectURL(blob);
    const link=document.createElement('a');
    link.href=url;
    const fname=(document.getElementById('filename').textContent||'document').replace(/\.pdf$/i,'');
    link.download=fname+'_annotated.pdf';
    link.click();
    URL.revokeObjectURL(url);
    toast('✓ Annotated PDF exported!');
  }catch(err){
    console.error(err);toast('Export error: '+err.message);
  }
}

// ─── BOOT ──────────────────────────────────────────────────────────
loadPDF();
