const STAGES = {
  compra:{label:"Compra", cats:[["precio","Pago del precio al vendedor"],["registro","Transfer fee ADGM (2%)"],["adgm_fee","Tarifa electrónica ADGM"],["agencia","Comisión de agencia"],["iva_agencia","IVA comisión de agencia"],["noc","NOC del desarrollador (Aldar)"],["hip_registro","Registro de hipoteca"],["hip_efee","Tarifa electrónica de hipoteca"],["hip_banco","Comisión del banco"],["tasacion","Tasación del banco"],["legal","Conveyancing (Del Pilar)"],["otro_compra","Otro (compra)"]]},
  remodelacion:{label:"Remodelación y dotación", cats:[["obras","Obras y reparaciones"],["muebles","Muebles"],["electro","Electrodomésticos"],["deco","Decoración y cortinas"],["mudanza","Mudanza"],["otro_remo","Otro (remodelación)"]]},
  recurrente:{label:"Recurrentes", cats:[["service","Service charge"],["cooling","Enfriamiento (Tasleem)"],["addc","Agua y luz (ADDC / TAQA)"],["internet","Internet"],["seguro","Seguro de hogar / vida"],["cuota","Cuota hipotecaria"],["abono","Abono extra a capital"],["mant","Mantenimiento"],["otro_rec","Otro (recurrente)"]]}
};
const CAT = {}; for (const [s,o] of Object.entries(STAGES)) for (const [k,l] of o.cats) CAT[k]={label:l,stage:s};

const FEES = [
  {k:"registro", est:c=>c.precio*0.02*c.share, note:c=>c.share<1?"2% del precio; tu mitad":"MOU (C): 2% del precio, cheque de gerencia el día de la transferencia"},
  {k:"adgm_fee", est:()=>1050, note:()=>"MOU (D): ADGM electronic service fee"},
  {k:"legal", est:()=>2650, note:()=>"MOU (G): a Del Pilar Real Estate, el día de la transferencia"},
  {k:"agencia", est:c=>c.precio*0.02, note:()=>"MOU (B): 2% a Del Pilar Real Estate, cheque de gerencia"},
  {k:"iva_agencia", est:c=>c.precio*0.02*0.05, note:()=>"5% IVA sobre la comisión"},
  {k:"noc", est:()=>3750, note:()=>"MOU (H): dev-admin-fee 2,700 + oa-admin-fee 1,050"},
  {k:"hip_registro", est:c=>c.loan*0.001, note:()=>"MOU (E): 0.1% del préstamo (por confirmar)", loanOnly:true},
  {k:"hip_efee", est:()=>475, note:()=>"MOU (F): mortgage electronic fee", loanOnly:true},
  {k:"hip_banco", est:c=>c.loan*0.01*1.05, note:()=>"Hasta 1% del préstamo + IVA; varía por banco", loanOnly:true},
  {k:"tasacion", est:()=>3000*1.05, note:()=>"AED 2,500–3,500 + IVA", loanOnly:true},
];
const RECS = [
  {k:"service", est:c=>c.area*(c.scRate||14.5), note:c=>!c.area?"Ingresa el área para estimarlo":(c.scRate?`${c.area} sq ft × AED ${c.scRate} / sq ft / año`:`${c.area} sq ft × AED 14.5 (referencia; pon la tarifa real arriba)`)},
  {k:"cooling", est:()=>null, note:()=>"Tasleem: consumo + cargos fijos del enfriamiento central"},
  {k:"addc", est:()=>null, note:()=>"Requiere depósito al abrir la cuenta"},
  {k:"seguro", est:()=>null, note:()=>"Obligatorio si hay hipoteca"},
];

const $ = id => document.getElementById(id);
const fmt = n => (n==null||isNaN(n)) ? "—" : "AED " + Number(n).toLocaleString("en-US",{minimumFractionDigits:0,maximumFractionDigits:2});
const fmtD = s => { if(!s) return "—"; const [y,m,d]=s.split("-"); return `${d}/${m}/${y}`; };
const esc = s => String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function toast(msg){const t=$("toast");t.textContent=msg;t.hidden=false;clearTimeout(toast._t);toast._t=setTimeout(()=>t.hidden=true,2600);}
function status(msg){const s=$("status");s.textContent=msg||"";s.hidden=!msg;}

let db=null, assets=null, downloads=null, canWrite=true;
let gastos=[]; let cfg={precio:0,loan:0,area:0,share:1,banco:"",tasa:0,plazo:0,inicio:""}; let loaded=false;
const NUMF=[["pPrecio","precio"],["pLoan","loan"],["pArea","area"],["pSc","scRate"],["pTasa","tasa"],["pPlazo","plazo"]], TXTF=[["pBanco","banco"],["pInicio","inicio"]];
function cfgFrom(d){const c={share:Number(d.share)||1};for(const[,k]of NUMF)c[k]=Number(d[k])||0;for(const[,k]of TXTF)c[k]=String(d[k]||"");return c;}
let stageFilter="todas", query="";

// ---------- render ----------
function sums(){
  const t={compra:0,remodelacion:0,recurrente:0,pend:0,sinComp:0,byCat:{}};
  for(const g of gastos){
    const m=Number(g.monto)||0;
    if(g.estado==="pendiente"){t.pend+=m;continue;}
    const st=CAT[g.categoria]?.stage||g.etapa; if(t[st]!=null) t[st]+=m;
    t.byCat[g.categoria]=(t.byCat[g.categoria]||0)+m;
    if(!(g.comprobantes||[]).length) t.sinComp++;
  }
  return t;
}
function renderFigs(){
  const t=sums(); const all=t.compra+t.remodelacion+t.recurrente;
  $("tCompra").textContent=fmt(t.compra);$("tRemo").textContent=fmt(t.remodelacion);$("tRec").textContent=fmt(t.recurrente);$("tAll").textContent=fmt(all);
  const n=s=>gastos.filter(g=>(CAT[g.categoria]?.stage||g.etapa)===s&&g.estado!=="pendiente").length;
  $("tCompraS").textContent=`${n("compra")} movimientos`;$("tRemoS").textContent=`${n("remodelacion")} movimientos`;$("tRecS").textContent=`${n("recurrente")} movimientos`;
  $("tAllS").textContent = t.pend? `Pendiente: ${fmt(t.pend)}` : (t.sinComp? `${t.sinComp} sin comprobante` : (gastos.length?"Todo con comprobante":" "));
}
function renderChips(){
  const opts=[["todas","Todas"],...Object.entries(STAGES).map(([k,o])=>[k,o.label]),["pendiente","Pendientes"],["sincomp","Sin comprobante"]];
  $("stageChips").innerHTML=opts.map(([k,l])=>`<button class="chip" data-k="${k}" aria-pressed="${k===stageFilter}">${esc(l)}</button>`).join("");
}
function renderList(){
  const L=$("list");
  if(!loaded){L.innerHTML=`<div class="empty"><span class="muted">Cargando gastos…</span></div>`;return;}
  if(!gastos.length){L.innerHTML=`<div class="empty"><h2>Aún no hay gastos</h2><span class="muted">Registra el primero: el depósito del MOU, el transfer fee del 2% o la comisión de la agencia. Adjunta la foto o el PDF del comprobante en el mismo paso.</span>${canWrite?'<button class="btn primary" data-act="new">+ Nuevo gasto</button>':''}</div>`;return;}
  const q=query.trim().toLowerCase();
  let rows=gastos.filter(g=>{
    const st=CAT[g.categoria]?.stage||g.etapa;
    if(stageFilter==="pendiente"&&g.estado!=="pendiente")return false;
    if(stageFilter==="sincomp"&&(g.comprobantes||[]).length)return false;
    if(STAGES[stageFilter]&&st!==stageFilter)return false;
    if(q){const hay=[g.concepto,g.proveedor,g.notas,CAT[g.categoria]?.label].join(" ").toLowerCase();if(!hay.includes(q))return false;}
    return true;
  }).sort((a,b)=>(b.fecha||"").localeCompare(a.fecha||"")||(b.creado||0)-(a.creado||0));
  if(!rows.length){L.innerHTML=`<div class="empty"><span class="muted">Ningún gasto coincide con el filtro.</span></div>`;return;}
  const groups={};for(const g of rows){const st=CAT[g.categoria]?.stage||g.etapa||"compra";(groups[st]=groups[st]||[]).push(g);}
  L.innerHTML=Object.keys(STAGES).filter(s=>groups[s]).map(s=>{
    const tot=groups[s].filter(g=>g.estado!=="pendiente").reduce((a,g)=>a+(Number(g.monto)||0),0);
    return `<div class="group" style="margin-bottom:14px"><h3><span>${esc(STAGES[s].label)}</span><span class="num muted" style="font-size:14px">${fmt(tot)}</span></h3>${groups[s].map(rowHTML).join("")}</div>`;
  }).join("");
}
function rowHTML(g){
  const n=(g.comprobantes||[]).length;
  const clip=n?`<span class="clip">📎 ${n} comprobante${n>1?"s":""}</span>`:`<span class="clip none">Sin comprobante</span>`;
  const orig=g.moneda&&g.montoOrig?`<small>${esc(g.moneda)} ${Number(g.montoOrig).toLocaleString("en-US")}</small>`:"";
  return `<div class="row" data-id="${esc(g.id)}" tabindex="0" role="button" aria-label="Editar ${esc(g.concepto)}">
    <span class="d">${fmtD(g.fecha)}</span>
    <div class="c"><b>${esc(g.concepto||CAT[g.categoria]?.label||"Gasto")}</b>
      <span class="sub"><span>${esc(CAT[g.categoria]?.label||"")}</span>${g.proveedor?`<span>· ${esc(g.proveedor)}</span>`:""}${clip}</span></div>
    <div class="a"><span>${fmt(g.monto)}</span>${orig}${g.estado==="pendiente"?'<span class="pill warn">Pendiente</span>':''}</div></div>`;
}
function renderFees(){
  const c=cfg, t=sums();
  let est=0, reg=0;
  $("feeBody").innerHTML=FEES.map(f=>{
    const skip=f.loanOnly&&!c.loan; const e=skip?0:f.est(c); const r=t.byCat[f.k]||0;
    if(!skip){est+=e;} reg+=r;
    let pill; if(skip) pill='<span class="pill neutral">No aplica</span>'; else if(!r) pill='<span class="pill warn">Por registrar</span>'; else if(Math.abs(r-e)<=Math.max(50,e*0.02)) pill='<span class="pill ok">Registrado</span>'; else pill=`<span class="pill ${r>e?'bad':'ok'}">${r>e?'Sobre estimado':'Registrado'}</span>`;
    return `<tr><td>${esc(CAT[f.k].label)}<span class="note">${esc(skip?"Solo con hipoteca":f.note(c))}</span></td><td class="n">${skip||!c.precio&&!f.est({precio:0,loan:0,share:1})?"—":fmt(e)}</td><td class="n">${r?fmt(r):"—"}</td><td>${pill}</td><td>${canWrite&&!skip?`<button class="btn small" data-reg="${f.k}" data-est="${Math.round(e*100)/100}">Registrar</button>`:""}</td></tr>`;
  }).join("");
  $("feeEst").textContent=c.precio?fmt(est):"—"; $("feeReg").textContent=fmt(reg);
  $("recBody").innerHTML=RECS.map(f=>{const e=f.est(c);const r=t.byCat[f.k]||0;
    return `<tr><td>${esc(CAT[f.k].label)}<span class="note">${esc(f.note(c))}</span></td><td class="n">${e?fmt(e):"—"}</td><td class="n">${r?fmt(r):"—"}</td><td>${canWrite?`<button class="btn small" data-reg="${f.k}" data-est="">Registrar</button>`:""}</td></tr>`;}).join("");
}
function renderParams(){
  for(const [id,k] of [...NUMF,...TXTF]) if(document.activeElement!==$(id)) $(id).value=cfg[k]||"";
  $("pShare").value=String(cfg.share||1);
}
function feeTotals(){
  const t=sums(); let est=0, reg=0;
  for(const f of FEES){ if(f.loanOnly&&!cfg.loan) continue; est+=f.est(cfg); reg+=t.byCat[f.k]||0; }
  return {est,reg};
}
function amort(){
  const P=cfg.loan; if(!P) return null;
  const pagos=gastos.filter(g=>g.categoria==="cuota"&&g.estado!=="pendiente");
  const k=pagos.length, sumC=pagos.reduce((a,g)=>a+(Number(g.monto)||0),0);
  const abonos=gastos.filter(g=>g.categoria==="abono"&&g.estado!=="pendiente").reduce((a,g)=>a+(Number(g.monto)||0),0);
  const n=Math.round(cfg.plazo*12), r=cfg.tasa/100/12;
  const out={P,k,sumC,abonos,n:n||null,cuota:null,saldo:null,capital:null,intPag:null,intTot:null,fin:null};
  if(!n||!cfg.tasa) return out;
  const cuota=P*r/(1-Math.pow(1+r,-n)); const kk=Math.min(k,n);
  let saldo=P*Math.pow(1+r,kk)-cuota*(Math.pow(1+r,kk)-1)/r; saldo=Math.max(0,saldo-abonos);
  const capital=P-saldo;
  Object.assign(out,{cuota,saldo,capital,intPag:Math.max(0,sumC+abonos-capital),intTot:cuota*n-P});
  if(cfg.inicio){const [y,m,d]=cfg.inicio.split("-").map(Number);const f=new Date(y,m-1+n-1,d);out.fin=f.toLocaleDateString("es",{month:"long",year:"numeric"});}
  return out;
}
const row3=(a,b,c,cls="")=>`<tr class="${cls}"><td>${a}</td><td class="n">${b}</td><td>${c}</td></tr>`;
function renderCasa(){
  const t=sums(), P=cfg.precio, L=cfg.loan;
  const pagosV=gastos.filter(g=>g.categoria==="precio"&&g.estado!=="pendiente"); const pagadoV=t.byCat.precio||0;
  const pct=P?Math.min(100,pagadoV/P*100):0;
  const propio=Math.max(0,P-pagadoV-L);
  $("casaBody").innerHTML = !P ? `<tr><td colspan="3" class="muted">Ingresa el precio de compra arriba.</td></tr>` :
    row3("Precio de compra",fmt(P),"Gate Tower 1 · 28-10","key")+
    row3("Pagado al vendedor",fmt(pagadoV),`${pagosV.length} pago${pagosV.length===1?"":"s"} · ${pct.toFixed(1)}% del precio<div class="prog"><i style="width:${pct}%"></i></div>`)+
    row3("Lo cubre la hipoteca",L?fmt(L):"—",L?`${(L/P*100).toFixed(1)}% del precio; el banco lo paga al vendedor en la transferencia`:"Sin hipoteca ingresada")+
    row3("Falta aportar de tu bolsillo",fmt(propio),propio?"Precio − pagado − hipoteca; se paga en la transferencia":"Cubierto","key");
  const a=amort();
  if(!a){ $("hipBody").innerHTML=`<tr><td colspan="3" class="muted">Ingresa el monto, la tasa y el plazo de la hipoteca arriba para ver cuota, saldo e intereses.</td></tr>`; }
  else {
    const est=a.cuota!=null;
    $("hipBody").innerHTML=
      row3("Préstamo",fmt(a.P),esc(cfg.banco||"Banco sin indicar"),"key")+
      row3("Cuota mensual",est?fmt(a.cuota):"—",est?`${cfg.tasa}% anual · ${a.n} cuotas (${cfg.plazo} años)`:"Ingresa tasa y plazo para calcularla")+
      row3("Cuotas pagadas",fmt(a.sumC),`${a.k}${a.n?" de "+a.n:""} cuotas registradas`)+
      (a.abonos?row3("Abonos extra a capital",fmt(a.abonos),"Reducen el saldo directamente"):"")+
      row3("Capital amortizado",est?fmt(a.capital):"—",est?`${(a.capital/a.P*100).toFixed(1)}% del préstamo<div class="prog"><i style="width:${Math.min(100,a.capital/a.P*100)}%"></i></div>`:"")+
      row3("Intereses pagados",est?fmt(a.intPag):"—","Estimado")+
      row3("Saldo pendiente",est?fmt(a.saldo):fmt(a.P-a.abonos),est?"Estimado; confírmalo con el banco":"Sin amortización calculada","key")+
      row3("Intereses totales del crédito",est?fmt(a.intTot):"—",est?(a.fin?`Si pagas todas las cuotas; última en ${a.fin}`:"Si pagas todas las cuotas"):"");
  }
  const ft=feeTotals(); const remo=t.remodelacion;
  const capPag=a&&a.cuota!=null?a.capital:(a?a.abonos:0); const intPag=a&&a.cuota!=null?a.intPag:0;
  const intEst=a&&a.cuota!=null?a.intTot:null;
  const rows=[
    ["Precio de la vivienda",P,pagadoV+capPag,"Pagos al vendedor + capital de hipoteca ya amortizado"],
    ["Costos de cierre (registro, agencia, NOC…)",ft.est,ft.reg,"Detalle en Costos de compra"],
    ["Intereses de la hipoteca",intEst,intPag,L?(intEst==null?"Falta tasa y plazo":"Proyección a todo el plazo"):"Sin hipoteca"],
    ["Remodelación y dotación",remo||null,remo,"Lo registrado hasta hoy"],
  ];
  $("totBody").innerHTML=rows.map(([l,e,p,n])=>`<tr><td>${esc(l)}<span class="note">${esc(n)}</span></td><td class="n">${e?fmt(e):"—"}</td><td class="n">${p?fmt(p):"—"}</td></tr>`).join("");
  $("totEst").textContent=P?fmt(rows.reduce((s,r)=>s+(r[1]||0),0)):"—";
  $("totPag").textContent=fmt(rows.reduce((s,r)=>s+(r[2]||0),0));
}
function renderAll(){renderFigs();renderChips();renderList();renderFees();renderParams();renderCasa();renderDocs();renderFotoChips();renderFotos();}

// ---------- tabs & filters ----------
const TABS=["mov","casa","fees","docs","fotos"];
function setTab(which){
  for(const k of TABS){ $("tab-"+k).setAttribute("aria-selected",k===which); const v=$("view-"+k); v.hidden=k!==which; v.style.display=k===which?"flex":""; }
}
for(const k of TABS) $("tab-"+k).onclick=()=>setTab(k);
$("stageChips").onclick=e=>{const b=e.target.closest(".chip");if(!b)return;stageFilter=b.dataset.k;renderChips();renderList();};
$("q").oninput=e=>{query=e.target.value;renderList();};
$("list").onclick=e=>{if(e.target.closest('[data-act="new"]'))return openForm();const r=e.target.closest(".row");if(r)openForm(gastos.find(g=>g.id===r.dataset.id));};
$("list").onkeydown=e=>{if(e.key==="Enter"){const r=e.target.closest(".row");if(r)openForm(gastos.find(g=>g.id===r.dataset.id));}};
$("view-fees").addEventListener("click",feeClick);
function feeClick(e){const b=e.target.closest("[data-reg]");if(!b)return;const k=b.dataset.reg;openForm(null,{categoria:k,etapa:CAT[k].stage,concepto:CAT[k].label,monto:b.dataset.est?Number(b.dataset.est):""});}

// params → db
let paramTimer;
for(const id of ["pPrecio","pLoan","pArea","pSc","pShare","pBanco","pTasa","pPlazo","pInicio"]) $(id).addEventListener(id==="pShare"||id==="pInicio"?"change":"input",()=>{
  const d={share:$("pShare").value};for(const[id,k]of[...NUMF,...TXTF])d[k]=$(id).value;cfg=cfgFrom(d);
  renderFees(); renderCasa(); clearTimeout(paramTimer); paramTimer=setTimeout(saveCfg,700);
});
let cfgSaving=false, cfgDirty=false;
async function saveCfg(){
  if(!db||!canWrite)return; if(cfgSaving){cfgDirty=true;return;}
  cfgSaving=true; try{await db.doc("config/apto").set({...cfg});}catch(e){status("No se pudieron guardar los datos del apartamento. Revisa la conexión e inténtalo de nuevo.");}
  cfgSaving=false; if(cfgDirty){cfgDirty=false;saveCfg();}
}

// ---------- form ----------
let editing=null, formStage="compra", formEstado="pagado", keptFiles=[], newFiles=[], removedFiles=[];
function fillCats(stage, sel){ $("fCat").innerHTML=STAGES[stage].cats.map(([k,l])=>`<option value="${k}" ${k===sel?"selected":""}>${esc(l)}</option>`).join(""); }
function renderSeg(){
  $("segStage").innerHTML=Object.entries(STAGES).map(([k,o])=>`<button type="button" data-v="${k}" aria-pressed="${k===formStage}">${esc(o.label.split(" ")[0])}</button>`).join("");
  for(const b of $("segEstado").children) b.setAttribute("aria-pressed",b.dataset.v===formEstado);
}
$("segStage").onclick=e=>{const b=e.target.closest("button");if(!b)return;formStage=b.dataset.v;fillCats(formStage);renderSeg();};
$("segEstado").onclick=e=>{const b=e.target.closest("button");if(!b)return;formEstado=b.dataset.v;renderSeg();};
$("fCat").onchange=()=>{if(!$("fConcepto").value)$("fConcepto").value=CAT[$("fCat").value].label;};

function openForm(g, preset){
  if(!canWrite && !g){toast("Solo puedes ver los gastos.");return;}
  editing=g||null; const d=g||preset||{};
  formStage=CAT[d.categoria]?.stage||d.etapa||(STAGES[stageFilter]?stageFilter:"compra");
  formEstado=d.estado||"pagado";
  fillCats(formStage,d.categoria); renderSeg();
  $("fConcepto").value=d.concepto||""; $("fFecha").value=d.fecha||new Date().toISOString().slice(0,10);
  $("fMonto").value=d.monto??""; $("fMon").value=d.moneda||""; $("fMontoOrig").value=d.montoOrig||"";
  $("fProv").value=d.proveedor||""; $("fMetodo").value=d.metodo||""; $("fNotas").value=d.notas||"";
  keptFiles=[...(g?.comprobantes||[])]; newFiles=[]; removedFiles=[];
  $("pTitle").textContent=g?"Editar gasto":"Nuevo gasto";
  $("btnDel").hidden=!g||!canWrite; $("delConfirm").hidden=true; $("formErr").hidden=true;
  $("drop").hidden=!assets||!canWrite; $("noUpload").hidden=!!assets||!canWrite;
  for(const el of $("form").querySelectorAll("input,select,textarea,button")) el.disabled=!canWrite&&!el.closest(".file");
  $("btnSave").hidden=!canWrite;
  renderFiles(); $("scrim").hidden=false; $("panel").hidden=false; setTimeout(()=>$("fConcepto").focus(),50);
}
function closeForm(){ for(const f of newFiles) if(f.preview) URL.revokeObjectURL(f.preview); $("panel").hidden=true;$("scrim").hidden=true; editing=null; }
$("btnClose").onclick=closeForm;$("btnCancel").onclick=closeForm;$("scrim").onclick=()=>{if(!$("fPanel").hidden)closeFoto();else if(!$("dPanel").hidden)closeDoc();else closeForm();};
$("btnNew").onclick=()=>openForm();
document.addEventListener("keydown",e=>{if(e.key==="Escape"){if(!$("viewer").hidden)closeViewer();else if(!$("fPanel").hidden)closeFoto();else if(!$("dPanel").hidden)closeDoc();else if(!$("panel").hidden)closeForm();}});

function renderFiles(){
  const items=[...keptFiles.map((f,i)=>({...f,kind:"kept",i})),...newFiles.map((f,i)=>({...f,kind:"new",i}))];
  $("fileList").innerHTML=items.map(f=>{
    const src=f.kind==="kept"?"/_blob/"+f.id:f.preview; const isImg=(f.tipo||"").startsWith("image/");
    return `<div class="file ${f.kind==="new"?"pending":""}"><div class="thumb" data-kind="${f.kind}" data-i="${f.i}">${isImg&&src?`<img src="${esc(src)}" alt="">`:"PDF"}</div><span class="nm" title="${esc(f.nombre)}">${esc(f.nombre)}</span>${canWrite?`<button type="button" class="x" data-kind="${f.kind}" data-i="${f.i}" aria-label="Quitar ${esc(f.nombre)}">×</button>`:""}</div>`;
  }).join("");
}
$("fileList").onclick=e=>{
  const x=e.target.closest(".x"); if(x){const i=+x.dataset.i; if(x.dataset.kind==="kept"){removedFiles.push(keptFiles[i]);keptFiles.splice(i,1);} else {const f=newFiles.splice(i,1)[0]; if(f.preview)URL.revokeObjectURL(f.preview);} renderFiles(); return;}
  const t=e.target.closest(".thumb"); if(!t)return; const i=+t.dataset.i;
  if(t.dataset.kind==="kept"){const f=keptFiles[i];openViewer("/_blob/"+f.id,f.tipo);} else {const f=newFiles[i]; if(f.preview) openViewer(f.preview,f.tipo);}
};
const OK_TYPES=["image/png","image/jpeg","image/gif","image/webp","application/pdf"];
async function normalize(file){
  if(OK_TYPES.includes(file.type)) return file;
  if(/\.pdf$/i.test(file.name)) return new File([file],file.name,{type:"application/pdf"});
  // HEIC u otros formatos de imagen: convertir a JPEG si el navegador puede leerlos
  try{
    const url=URL.createObjectURL(file); const img=new Image(); img.src=url; await img.decode();
    const c=document.createElement("canvas"); const s=Math.min(1,3000/Math.max(img.naturalWidth,img.naturalHeight));
    c.width=Math.round(img.naturalWidth*s); c.height=Math.round(img.naturalHeight*s); c.getContext("2d").drawImage(img,0,0,c.width,c.height); URL.revokeObjectURL(url);
    const blob=await new Promise(r=>c.toBlob(r,"image/jpeg",0.85)); if(!blob) throw 0;
    return new File([blob],file.name.replace(/\.[^.]+$/,"")+".jpg",{type:"image/jpeg"});
  }catch{ return null; }
}
async function addFiles(list){
  const bad=[];
  for(const f0 of list){ const f=await normalize(f0); if(!f){bad.push(f0.name);continue;} if(f.size>20*1024*1024){bad.push(f0.name+" (más de 20 MB)");continue;}
    newFiles.push({file:f,nombre:f.name,tipo:f.type,preview:URL.createObjectURL(f)}); }
  renderFiles(); if(bad.length) showErr("No se pudo adjuntar: "+bad.join(", ")+". Usa fotos JPG/PNG o PDF.");
}
$("fFiles").onchange=e=>{addFiles([...e.target.files]);e.target.value="";};
const drop=$("drop");
drop.addEventListener("dragover",e=>{e.preventDefault();drop.classList.add("over");});
drop.addEventListener("dragleave",()=>drop.classList.remove("over"));
drop.addEventListener("drop",e=>{e.preventDefault();drop.classList.remove("over");if(assets)addFiles([...e.dataTransfer.files]);});
function showErr(m){const el=$("formErr");el.textContent=m;el.hidden=false;}

let saving=false;
$("form").onsubmit=async e=>{
  e.preventDefault(); if(saving||!db||!canWrite)return;
  const monto=parseFloat($("fMonto").value); const concepto=$("fConcepto").value.trim(); const fecha=$("fFecha").value;
  if(!concepto) return showErr("Escribe un concepto."); if(!fecha) return showErr("Elige la fecha.");
  if(isNaN(monto)||monto<0) return showErr("Escribe el monto en AED (puede ser 0 si aún no sabes la cifra).");
  saving=true; $("btnSave").disabled=true; $("btnSave").textContent=newFiles.length?"Subiendo comprobantes…":"Guardando…"; $("formErr").hidden=true;
  const uploaded=[]; const failed=[];
  for(const f of newFiles){
    try{ const r=await uploadOnce(f.file); uploaded.push({id:r.id,nombre:f.nombre,tipo:r.contentType,bytes:r.sizeBytes}); }
    catch(err){ failed.push(f.nombre+" ("+uploadMsg(err)+")"); }
  }
  const doc={concepto,fecha,monto,categoria:$("fCat").value,etapa:formStage,estado:formEstado,
    moneda:$("fMon").value||"",montoOrig:$("fMontoOrig").value?Number($("fMontoOrig").value):null,
    proveedor:$("fProv").value.trim(),metodo:$("fMetodo").value,notas:$("fNotas").value.trim(),
    comprobantes:[...keptFiles,...uploaded],creado:editing?.creado||Date.now(),actualizado:Date.now()};
  try{
    const ref=editing? db.doc("gastos/"+editing.id) : db.collection("gastos").doc();
    await ref.set(doc);
    for(const f of removedFiles){ try{await assets?.delete(f.id);}catch{} }
    if(failed.length){ editing={...doc,id:ref.id}; keptFiles=[...doc.comprobantes]; newFiles=newFiles.filter(f=>failed.some(x=>x.startsWith(f.nombre))); removedFiles=[]; renderFiles(); showErr("Gasto guardado, pero no se subieron: "+failed.join(", ")+". Vuelve a intentarlo."); }
    else { closeForm(); toast(editing?"Gasto actualizado":"Gasto guardado"); }
  }catch(err){
    showErr(err?.code==="quota_exceeded"?"Se llenó el espacio de la base de datos. Borra gastos que no necesites.":"No se pudo guardar. Revisa la conexión e inténtalo de nuevo.");
  }finally{ saving=false; $("btnSave").disabled=false; $("btnSave").textContent="Guardar"; }
};
async function uploadOnce(file){
  try{ return await assets.upload(file,{type:file.type}); }
  catch(e){ if(e?.code==="store_unavailable"){ await new Promise(r=>setTimeout(r,800)); return await assets.upload(file,{type:file.type}); } throw e; }
}
function uploadMsg(e){return ({too_large:"muy pesado",unsupported_type:"formato no admitido",quota_or_state:"espacio lleno",rate_limited:"demasiados intentos, espera un momento"})[e?.code]||"error al subir";}

$("btnDel").onclick=()=>{$("delConfirm").hidden=false;$("delConfirm").scrollIntoView({block:"nearest"});};
$("btnDelNo").onclick=()=>$("delConfirm").hidden=true;
$("btnDelYes").onclick=async()=>{
  if(!editing)return; const g=editing;
  try{ await db.doc("gastos/"+g.id).delete(); for(const f of g.comprobantes||[]){try{await assets?.delete(f.id);}catch{}} closeForm(); toast("Gasto borrado"); }
  catch{ showErr("No se pudo borrar. Inténtalo de nuevo."); }
};

// ---------- viewer ----------
let vList=null, vIdx=0;
function showViewer(src,tipo,cap){
  if(!(tipo||"").startsWith("image/")){ $("vImg").hidden=true; } else { $("vImg").hidden=false; $("vImg").src=src; }
  $("vOpen").href=src; $("vCap").textContent=cap||""; $("vCap").hidden=!cap;
  const nav=!!vList&&vList.length>1; $("vPrev").hidden=!nav; $("vNext").hidden=!nav;
  $("viewer").hidden=false;
}
function openViewer(src,tipo){ vList=null; showViewer(src,tipo); }
// list: [{src,tipo,cap}] — enables previous/next navigation
function openGallery(list,i){ vList=list; vIdx=i; stepViewer(0); }
function stepViewer(d){ if(!vList)return; vIdx=(vIdx+d+vList.length)%vList.length; const f=vList[vIdx]; showViewer(f.src,f.tipo,f.cap); }
function closeViewer(){$("viewer").hidden=true;$("vImg").removeAttribute("src");vList=null;}
$("vClose").onclick=closeViewer; $("viewer").onclick=e=>{if(e.target.id==="viewer")closeViewer();};
$("vPrev").onclick=()=>stepViewer(-1); $("vNext").onclick=()=>stepViewer(1);
document.addEventListener("keydown",e=>{if($("viewer").hidden||!vList)return; if(e.key==="ArrowLeft")stepViewer(-1); else if(e.key==="ArrowRight")stepViewer(1);});

// ---------- CSV ----------
$("btnCsv").onclick=async()=>{
  if(!downloads)return;
  const cols=["Fecha","Etapa","Categoría","Concepto","Pagado a","Método","Estado","Monto AED","Moneda original","Monto original","Comprobantes","Notas"];
  const q=v=>{const s=String(v??"");return /[",\n;]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;};
  const rows=[...gastos].sort((a,b)=>(a.fecha||"").localeCompare(b.fecha||"")).map(g=>[g.fecha,STAGES[CAT[g.categoria]?.stage||g.etapa]?.label,CAT[g.categoria]?.label,g.concepto,g.proveedor,g.metodo,g.estado,g.monto,g.moneda,g.montoOrig??"",(g.comprobantes||[]).map(c=>c.nombre).join(" | "),g.notas]);
  const csv="﻿"+[cols,...rows].map(r=>r.map(q).join(",")).join("\r\n");
  try{ await downloads.save({filename:`gastos-gate-towers-${new Date().toISOString().slice(0,10)}.csv`,data:csv}); toast("Archivo guardado"); }
  catch(e){ if(e?.code!=="declined") toast("No se pudo exportar en esta vista."); }
};

// ---------- documentos ----------
const DOC_TYPES=[["titulo","Título de propiedad (Title Deed)",true],["plano","Plano de la unidad (Unit Site Plan)",true],["mou","MOU / Form F",true],["spa","Contrato de compraventa (SPA)",false],["noc","NOC de Aldar",true],["dari","Recibos y certificados ADGM",true],["poa","Poder (POA)",false],["hipoteca","Documentos de la hipoteca",false],["servicios","Contratos de servicios (Tasleem, ADDC)",false],["seguro","Póliza de seguro",false],["otro","Otro",false]];
const DOCL=Object.fromEntries(DOC_TYPES.map(([k,l])=>[k,l]));
let docs=[], unidad=null, docsLoaded=false;
function renderFicha(){
  const u=unidad||{}; const f=[["Unidad",u.unidad||"2810"],["Torre",u.torre||"The Gate Tower 1"],["Piso",u.piso||"28"],["Tipo",u.tipo||"—"],["Área",u.areaM2?`${u.areaM2} m² · ${u.areaSqft} sq ft`:"—"],["Parqueadero",u.parqueo||"—"],["Lote (plot)",u.plot||"—"],["Desarrollador",u.desarrollador||"Aldar"],["Vendedor",u.vendedor||"—"],["Agencia",u.agencia||"—"],["Transferencia",u.transferencia||"—"],["Ocupación",u.ocupacion||"—"]];
  $("ficha").innerHTML=f.map(([k,v])=>`<div><span class="eyebrow">${esc(k)}</span><b>${esc(v)}</b></div>`).join("");
}
function renderDocs(){
  renderFicha();
  if(!docsLoaded){$("docBody").innerHTML=`<tr><td colspan="4" class="muted">Cargando documentos…</td></tr>`;return;}
  const by={}; for(const d of docs)(by[d.tipo||"otro"]=by[d.tipo||"otro"]||[]).push(d);
  const rows=[];
  for(const [k,l,clave] of DOC_TYPES){
    const list=(by[k]||[]).sort((a,b)=>(b.fecha||"").localeCompare(a.fecha||""));
    if(!list.length){ if(clave||k==="spa") rows.push(`<tr><td>${esc(l)}</td><td class="muted">—</td><td><span class="pill ${clave?"warn":"neutral"}">${clave?"Falta":"Opcional"}</span></td><td>${canWrite?`<button class="btn small" data-newdoc="${k}">Agregar</button>`:""}</td></tr>`); continue; }
    for(const d of list){
      const files=(d.archivos||[]).map((a,i)=>`<button type="button" class="dfile" data-doc="${esc(d.id)}" data-i="${i}" title="${esc(a.nombre)}">${a.tipo==="application/pdf"?"PDF":"IMG"} · ${esc(a.nombre)}</button>`).join("");
      rows.push(`<tr><td><b>${esc(d.nombre||l)}</b><span class="note">${esc(l)}${d.ref?" · "+esc(d.ref):""}${d.fecha?" · "+fmtD(d.fecha):""}</span>${d.notas?`<span class="note">${esc(d.notas)}</span>`:""}</td><td><div class="dfiles">${files||'<span class="muted">Sin archivo</span>'}</div></td><td><span class="pill ${(d.archivos||[]).length?"ok":"warn"}">${(d.archivos||[]).length?"Guardado":"Sin archivo"}</span></td><td>${canWrite?`<button class="btn small" data-editdoc="${esc(d.id)}">Editar</button>`:""}</td></tr>`);
    }
  }
  $("docBody").innerHTML=rows.join("");
}
$("docBody").onclick=e=>{
  const f=e.target.closest(".dfile"); if(f){const d=docs.find(x=>x.id===f.dataset.doc);const a=d?.archivos?.[+f.dataset.i]; if(a) openViewer("/_blob/"+a.id,a.tipo); return;}
  const n=e.target.closest("[data-newdoc]"); if(n) return openDoc(null,{tipo:n.dataset.newdoc});
  const ed=e.target.closest("[data-editdoc]"); if(ed) openDoc(docs.find(x=>x.id===ed.dataset.editdoc));
};
$("btnNewDoc").onclick=()=>openDoc();
let dEditing=null,dKept=[],dNew=[],dRemoved=[],dSaving=false;
function openDoc(d,preset){
  if(!canWrite)return; dEditing=d||null; const v=d||preset||{};
  $("dTipo").innerHTML=DOC_TYPES.map(([k,l])=>`<option value="${k}" ${k===(v.tipo||"otro")?"selected":""}>${esc(l)}</option>`).join("");
  $("dNombre").value=v.nombre||""; $("dFecha").value=v.fecha||""; $("dRef").value=v.ref||""; $("dNotas").value=v.notas||"";
  dKept=[...(d?.archivos||[])]; dNew=[]; dRemoved=[];
  $("dTitle").textContent=d?"Editar documento":"Agregar documento"; $("dDel").hidden=!d; $("dDelConfirm").hidden=true; $("dErr").hidden=true;
  $("dDrop").hidden=!assets; renderDFiles(); $("scrim").hidden=false; $("dPanel").hidden=false;
}
function closeDoc(){ for(const f of dNew) if(f.preview) URL.revokeObjectURL(f.preview); $("dPanel").hidden=true; $("scrim").hidden=true; dEditing=null; }
$("dClose").onclick=closeDoc; $("dCancel").onclick=closeDoc;
function renderDFiles(){
  const items=[...dKept.map((f,i)=>({...f,kind:"kept",i})),...dNew.map((f,i)=>({...f,kind:"new",i}))];
  $("dFileList").innerHTML=items.map(f=>{const src=f.kind==="kept"?"/_blob/"+f.id:f.preview;const isImg=(f.tipo||"").startsWith("image/");
    return `<div class="file ${f.kind==="new"?"pending":""}"><div class="thumb" data-kind="${f.kind}" data-i="${f.i}">${isImg?`<img src="${esc(src)}" alt="">`:"PDF"}</div><span class="nm" title="${esc(f.nombre)}">${esc(f.nombre)}</span><button type="button" class="x" data-kind="${f.kind}" data-i="${f.i}" aria-label="Quitar ${esc(f.nombre)}">×</button></div>`;}).join("");
}
$("dFileList").onclick=e=>{
  const x=e.target.closest(".x"); if(x){const i=+x.dataset.i; if(x.dataset.kind==="kept"){dRemoved.push(dKept[i]);dKept.splice(i,1);} else {const f=dNew.splice(i,1)[0]; if(f.preview)URL.revokeObjectURL(f.preview);} renderDFiles(); return;}
  const t=e.target.closest(".thumb"); if(!t)return; const i=+t.dataset.i;
  if(t.dataset.kind==="kept") openViewer("/_blob/"+dKept[i].id,dKept[i].tipo); else openViewer(dNew[i].preview,dNew[i].tipo);
};
async function addDFiles(list){
  const bad=[]; for(const f0 of list){const f=await normalize(f0); if(!f||f.size>20*1024*1024){bad.push(f0.name);continue;} dNew.push({file:f,nombre:f.name,tipo:f.type,preview:URL.createObjectURL(f)});}
  renderDFiles(); if(bad.length){$("dErr").textContent="No se pudo adjuntar: "+bad.join(", ")+". Usa PDF o fotos de hasta 20 MB.";$("dErr").hidden=false;}
}
$("dFiles").onchange=e=>{addDFiles([...e.target.files]);e.target.value="";};
$("dDrop").addEventListener("dragover",e=>{e.preventDefault();$("dDrop").classList.add("over");});
$("dDrop").addEventListener("dragleave",()=>$("dDrop").classList.remove("over"));
$("dDrop").addEventListener("drop",e=>{e.preventDefault();$("dDrop").classList.remove("over");if(assets)addDFiles([...e.dataTransfer.files]);});
$("dForm").onsubmit=async e=>{
  e.preventDefault(); if(dSaving||!db)return;
  const tipo=$("dTipo").value, nombre=$("dNombre").value.trim()||DOCL[tipo];
  dSaving=true; $("dSave").disabled=true; $("dSave").textContent=dNew.length?"Subiendo…":"Guardando…"; $("dErr").hidden=true;
  const up=[],failed=[];
  for(const f of dNew){try{const r=await uploadOnce(f.file);up.push({id:r.id,nombre:f.nombre,tipo:r.contentType,bytes:r.sizeBytes});}catch(err){failed.push(f.nombre+" ("+uploadMsg(err)+")");}}
  const doc={tipo,nombre,fecha:$("dFecha").value,ref:$("dRef").value.trim(),notas:$("dNotas").value.trim(),archivos:[...dKept,...up],creado:dEditing?.creado||Date.now(),actualizado:Date.now()};
  try{
    const ref=dEditing?db.doc("documentos/"+dEditing.id):db.collection("documentos").doc();
    await ref.set(doc); for(const f of dRemoved){try{await assets?.delete(f.id);}catch{}}
    if(failed.length){dEditing={...doc,id:ref.id};dKept=[...doc.archivos];dNew=dNew.filter(f=>failed.some(x=>x.startsWith(f.nombre)));dRemoved=[];renderDFiles();$("dErr").textContent="Guardado, pero no se subieron: "+failed.join(", ");$("dErr").hidden=false;}
    else {closeDoc();toast("Documento guardado");}
  }catch{ $("dErr").textContent="No se pudo guardar. Revisa la conexión e inténtalo de nuevo."; $("dErr").hidden=false; }
  finally{ dSaving=false; $("dSave").disabled=false; $("dSave").textContent="Guardar"; }
};
$("dDel").onclick=()=>$("dDelConfirm").hidden=false; $("dDelNo").onclick=()=>$("dDelConfirm").hidden=true;
$("dDelYes").onclick=async()=>{ if(!dEditing)return; const d=dEditing;
  try{await db.doc("documentos/"+d.id).delete(); for(const a of d.archivos||[]){try{await assets?.delete(a.id);}catch{}} closeDoc(); toast("Documento borrado");}
  catch{$("dErr").textContent="No se pudo borrar.";$("dErr").hidden=false;} };

// ---------- fotos ----------
// fotos/<id>: etapa (original|reforma), reforma, ambiente, fecha, nota, archivo{id,nombre,tipo,bytes}, creado, actualizado
const FOTO_ETAPAS=[["original","Original"],["reforma","Reforma"]];
const AMBIENTES=[["sala","Sala"],["comedor","Comedor"],["cocina","Cocina"],["dorm1","Dormitorio principal"],["dorm2","Dormitorio 2"],["bano1","Baño principal"],["bano2","Baño 2"],["balcon","Balcón"],["lavanderia","Lavandería"],["entrada","Entrada y pasillo"],["vista","Vista"],["edificio","Edificio y áreas comunes"],["otro","Otro"]];
const AMBL=Object.fromEntries(AMBIENTES), AMBO=Object.fromEntries(AMBIENTES.map(([k],i)=>[k,i]));
let fotos=[], fotosLoaded=false, fotoFilter="todas", fotoAmb="", fotoView=[];
const fotoCap=f=>[AMBL[f.ambiente]||"Otro",f.etapa==="reforma"?(f.reforma||"Reforma"):"Original",f.fecha?fmtD(f.fecha):"",f.nota||""].filter(Boolean).join(" · ");
function renderFotoChips(){
  const opts=[["todas","Todas"],["original","Original"],["reforma","Reformas"]];
  $("fotoChips").innerHTML=opts.map(([k,l])=>`<button class="chip" data-k="${k}" aria-pressed="${k===fotoFilter}">${esc(l)}</button>`).join("");
  $("fotoAmb").innerHTML=`<option value="">Todos los ambientes</option>`+AMBIENTES.map(([k,l])=>`<option value="${k}" ${k===fotoAmb?"selected":""}>${esc(l)}</option>`).join("");
}
function renderFotos(){
  const L=$("fotoList");
  if(!fotosLoaded){L.innerHTML=`<div class="empty"><span class="muted">Cargando fotos…</span></div>`;return;}
  if(!fotos.length){L.innerHTML=`<div class="empty"><h2>Aún no hay fotos</h2><span class="muted">Sube cómo recibiste el apartamento, ambiente por ambiente. Cuando hagas una reforma, guarda el antes, el durante y el después con el nombre de la obra.</span>${canWrite&&assets?'<button class="btn primary" data-act="newfoto">+ Subir fotos</button>':''}</div>`;return;}
  const rows=fotos.filter(f=>(fotoFilter==="todas"||(f.etapa||"original")===fotoFilter)&&(!fotoAmb||f.ambiente===fotoAmb));
  if(!rows.length){L.innerHTML=`<div class="empty"><span class="muted">Ninguna foto coincide con el filtro.</span></div>`;return;}
  // Groups: "Original" first, then each reforma, most recent first
  const groups=new Map();
  for(const f of rows){const k=f.etapa==="reforma"?"r:"+(f.reforma||"Sin nombre"):"o";if(!groups.has(k))groups.set(k,[]);groups.get(k).push(f);}
  const last=list=>list.reduce((m,f)=>(f.fecha||"")>m?f.fecha:m,"");
  const keys=[...groups.keys()].sort((a,b)=>a==="o"?-1:b==="o"?1:last(groups.get(b)).localeCompare(last(groups.get(a))));
  fotoView=[];
  L.innerHTML=keys.map(k=>{
    const list=groups.get(k).sort((a,b)=>(AMBO[a.ambiente]??99)-(AMBO[b.ambiente]??99)||(a.fecha||"").localeCompare(b.fecha||"")||(a.creado||0)-(b.creado||0));
    const title=k==="o"?"Original":"Reforma · "+k.slice(2);
    const cards=list.map(f=>{const i=fotoView.push(f)-1;
      return `<figure class="foto"><button type="button" class="fimg" data-i="${i}" aria-label="Ver ${esc(fotoCap(f))}"><img loading="lazy" src="/_blob/${esc(f.archivo?.id)}" alt=""></button>
        <figcaption><span><b>${esc(AMBL[f.ambiente]||"Otro")}</b>${f.fecha?`<small>${fmtD(f.fecha)}</small>`:""}</span>${canWrite?`<button type="button" class="btn small" data-editfoto="${esc(f.id)}">Editar</button>`:""}</figcaption></figure>`;}).join("");
    return `<div class="group" style="margin-bottom:14px"><h3><span>${esc(title)}</span><span class="muted" style="font-size:14px">${list.length} foto${list.length===1?"":"s"}</span></h3><div class="gallery">${cards}</div></div>`;
  }).join("");
}
$("fotoChips").onclick=e=>{const b=e.target.closest(".chip");if(!b)return;fotoFilter=b.dataset.k;renderFotoChips();renderFotos();};
$("fotoAmb").onchange=e=>{fotoAmb=e.target.value;renderFotos();};
$("fotoList").onclick=e=>{
  if(e.target.closest('[data-act="newfoto"]')) return openFoto();
  const ed=e.target.closest("[data-editfoto]"); if(ed) return openFoto(fotos.find(f=>f.id===ed.dataset.editfoto));
  const b=e.target.closest(".fimg"); if(b) openGallery(fotoView.map(f=>({src:"/_blob/"+f.archivo?.id,tipo:f.archivo?.tipo||"image/jpeg",cap:fotoCap(f)})),+b.dataset.i);
};
$("btnNewFoto").onclick=()=>openFoto();
let fEditing=null, fEtapa="original", fNew=[], fSaving=false;
function renderFotoSeg(){
  $("segFoto").innerHTML=FOTO_ETAPAS.map(([k,l])=>`<button type="button" data-v="${k}" aria-pressed="${k===fEtapa}">${esc(l)}</button>`).join("");
  $("fReformaWrap").hidden=fEtapa!=="reforma";
}
$("segFoto").onclick=e=>{const b=e.target.closest("button");if(!b)return;fEtapa=b.dataset.v;renderFotoSeg();};
function openFoto(f){
  if(!canWrite)return; if(!f&&!assets){toast("No se pueden subir fotos en esta vista.");return;}
  fEditing=f||null; fNew=[];
  fEtapa=f?.etapa||(fotoFilter==="reforma"?"reforma":"original"); renderFotoSeg();
  const reformas=[...new Set(fotos.map(x=>x.reforma).filter(Boolean))];
  $("fReformaList").innerHTML=reformas.map(r=>`<option value="${esc(r)}">`).join("");
  $("fReforma").value=f?.reforma||"";
  $("fAmb").innerHTML=AMBIENTES.map(([k,l])=>`<option value="${k}">${esc(l)}</option>`).join("");
  $("fAmb").value=f?.ambiente||fotoAmb||"sala";
  $("fFotoFecha").value=f?.fecha||new Date().toISOString().slice(0,10); $("fNota").value=f?.nota||"";
  $("fTitle").textContent=f?"Editar foto":"Subir fotos";
  $("fFotoFilesWrap").hidden=!!f; $("fFotoOne").hidden=!f;
  $("fFotoOne").innerHTML=f?`<div class="file"><div class="thumb"><img src="/_blob/${esc(f.archivo?.id)}" alt=""></div><span class="nm" title="${esc(f.archivo?.nombre)}">${esc(f.archivo?.nombre)}</span></div>`:"";
  $("fDel").hidden=!f; $("fDelConfirm").hidden=true; $("fErr").hidden=true;
  renderFotoFiles(); $("scrim").hidden=false; $("fPanel").hidden=false;
}
function closeFoto(){ for(const x of fNew) if(x.preview) URL.revokeObjectURL(x.preview); fNew=[]; $("fPanel").hidden=true; $("scrim").hidden=true; fEditing=null; }
$("fClose").onclick=closeFoto; $("fCancel").onclick=closeFoto;
function fotoErr(m){$("fErr").textContent=m;$("fErr").hidden=false;}
function renderFotoFiles(){
  $("fFotoList").innerHTML=fNew.map((f,i)=>`<div class="file pending"><div class="thumb"><img src="${esc(f.preview)}" alt=""></div><span class="nm" title="${esc(f.nombre)}">${esc(f.nombre)}</span><button type="button" class="x" data-i="${i}" aria-label="Quitar ${esc(f.nombre)}">×</button></div>`).join("");
}
$("fFotoList").onclick=e=>{const x=e.target.closest(".x");if(!x)return;const f=fNew.splice(+x.dataset.i,1)[0];if(f?.preview)URL.revokeObjectURL(f.preview);renderFotoFiles();};
async function addFotoFiles(list){
  const bad=[];
  for(const f0 of list){
    if(/\.pdf$/i.test(f0.name)||f0.type==="application/pdf"){bad.push(f0.name+" (es PDF; guárdalo en Documentos)");continue;}
    const f=await normalize(f0); if(!f){bad.push(f0.name);continue;} if(f.size>20*1024*1024){bad.push(f0.name+" (más de 20 MB)");continue;}
    fNew.push({file:f,nombre:f.name,tipo:f.type,preview:URL.createObjectURL(f)});
  }
  renderFotoFiles(); if(bad.length) fotoErr("No se pudo adjuntar: "+bad.join(", ")+".");
}
$("fFotoFiles").onchange=e=>{addFotoFiles([...e.target.files]);e.target.value="";};
$("fDrop").addEventListener("dragover",e=>{e.preventDefault();$("fDrop").classList.add("over");});
$("fDrop").addEventListener("dragleave",()=>$("fDrop").classList.remove("over"));
$("fDrop").addEventListener("drop",e=>{e.preventDefault();$("fDrop").classList.remove("over");if(assets)addFotoFiles([...e.dataTransfer.files]);});
$("fForm").onsubmit=async e=>{
  e.preventDefault(); if(fSaving||!db||!canWrite)return;
  const reforma=fEtapa==="reforma"?$("fReforma").value.trim():"";
  if(fEtapa==="reforma"&&!reforma) return fotoErr("Escribe el nombre de la reforma (ej. Cocina 2027).");
  if(!fEditing&&!fNew.length) return fotoErr("Elige al menos una foto.");
  const meta={etapa:fEtapa,reforma,ambiente:$("fAmb").value,fecha:$("fFotoFecha").value,nota:$("fNota").value.trim()};
  fSaving=true; $("fSave").disabled=true; $("fErr").hidden=true;
  try{
    if(fEditing){
      const {id,...prev}=fEditing;
      await db.doc("fotos/"+id).set({...prev,...meta,actualizado:Date.now()});
      closeFoto(); toast("Foto actualizada"); return;
    }
    const failed=[], total=fNew.length; let ok=0;
    for(const [n,f] of [...fNew].entries()){
      $("fSave").textContent=`Subiendo ${n+1} de ${total}…`;
      try{
        const r=await uploadOnce(f.file);
        const now=Date.now();
        try{ await db.collection("fotos").doc().set({...meta,archivo:{id:r.id,nombre:f.nombre,tipo:r.contentType,bytes:r.sizeBytes},creado:now,actualizado:now}); }
        catch(err){ try{await assets.delete(r.id);}catch{} throw err; }
        ok++; URL.revokeObjectURL(f.preview); fNew=fNew.filter(x=>x!==f);
      }catch(err){ failed.push(f.nombre+" ("+uploadMsg(err)+")"); }
    }
    if(failed.length){ renderFotoFiles(); fotoErr(`${ok?`Se guardaron ${ok}, pero no`:"No"} se subieron: ${failed.join(", ")}. Vuelve a intentarlo.`); }
    else { closeFoto(); toast(ok===1?"Foto guardada":`${ok} fotos guardadas`); }
  }catch{ fotoErr("No se pudo guardar. Revisa la conexión e inténtalo de nuevo."); }
  finally{ fSaving=false; $("fSave").disabled=false; $("fSave").textContent="Guardar"; }
};
$("fDel").onclick=()=>$("fDelConfirm").hidden=false; $("fDelNo").onclick=()=>$("fDelConfirm").hidden=true;
$("fDelYes").onclick=async()=>{ if(!fEditing)return; const f=fEditing;
  try{await db.doc("fotos/"+f.id).delete(); if(f.archivo?.id){try{await assets?.delete(f.archivo.id);}catch{}} closeFoto(); toast("Foto borrada");}
  catch{fotoErr("No se pudo borrar. Inténtalo de nuevo.");} };

// ---------- boot ----------
renderAll();
(async()=>{
  const timer=setTimeout(()=>{ if(!loaded) status("Aún no se pueden cargar los datos. Revisa tu conexión; la página seguirá intentando."); },10000);
  try{ db=await claude.use("db"); }catch{ db=null; }
  if(!db){ clearTimeout(timer); loaded=true; docsLoaded=true; fotosLoaded=true; canWrite=false; $("btnNewFoto").hidden=true; status("No se pudo conectar con el servidor. Revisa que el contenedor esté corriendo."); $("btnNew").hidden=true; renderAll(); return; }
  const [user, a, d] = await Promise.all([claude.use("user").catch(()=>null), claude.use("assets").catch(()=>null), claude.use("downloads").catch(()=>null)]);
  assets=a; downloads=d; $("btnCsv").hidden=!downloads;
  try{ const w=await user?.can?.("data.write"); if(w===false) canWrite=false; }catch{}
  if(!canWrite){ $("btnNew").hidden=true; for(const id of ["pPrecio","pLoan","pArea","pSc","pShare","pBanco","pTasa","pPlazo","pInicio"]) $(id).disabled=true; }
  db.collection("gastos").onSnapshot(snap=>{
    gastos=snap.docs.map(s=>({id:s.id,...s.data()})); if(!snap.metadata.fromCache){loaded=true;clearTimeout(timer);status("");}
    else if(gastos.length) loaded=true;
    renderFigs();renderList();renderFees();renderCasa();
  },err=>{clearTimeout(timer);loaded=true;status(err.code==="revoked"?"Ya no tienes acceso a estos datos.":"No se pudieron cargar los gastos. Recarga la página para intentarlo de nuevo.");renderList();});
  if(!canWrite) $("btnNewDoc").hidden=true;
  if(!canWrite||!assets) $("btnNewFoto").hidden=true;
  db.collection("fotos").onSnapshot(s=>{fotos=s.docs.map(x=>({id:x.id,...x.data()}));if(!s.metadata.fromCache||fotos.length)fotosLoaded=true;renderFotos();},()=>{fotosLoaded=true;renderFotos();});
  db.collection("documentos").onSnapshot(s=>{docs=s.docs.map(x=>({id:x.id,...x.data()}));if(!s.metadata.fromCache||docs.length)docsLoaded=true;renderDocs();},()=>{docsLoaded=true;renderDocs();});
  db.doc("config/unidad").onSnapshot(s=>{unidad=s.exists?s.data():null;renderFicha();},()=>{});
  db.doc("config/apto").onSnapshot(s=>{ if(s.exists && !cfgSaving){ cfg=cfgFrom(s.data()); renderParams(); renderFees(); renderCasa(); } },()=>{});
})();
