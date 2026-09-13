(function(){
"use strict";
var META=window.QMETA, AR=window.QAR;
var EN=window.QEN||null, TR=window.QTR||null, WB=window.QWB||null;
var SUR=META.surahs;
var $=function(id){return document.getElementById(id)};

/* ---------- persistence ---------- */
var LS="sabaq.v1";
var store={pos:{s:1,a:1},tl:false,tr:false,wb:true,wbSet:false,theme:"",prog:{},target:5,mask:"none",reciter:"husary",source:"everyayah",saved:{},arep:1,aspd:1,loopRounds:0,at:0};
try{var raw=localStorage.getItem(LS); if(raw) store=Object.assign(store,JSON.parse(raw));}catch(e){}
if(!store.wbSet) store.wb=true;   /* on by default until the reader chooses otherwise */
var db=null,saveT=null;
function save(){
  store.at=Date.now();
  try{localStorage.setItem(LS,JSON.stringify(store));}catch(e){}
  if(db){clearTimeout(saveT);saveT=setTimeout(function(){
    try{db.doc("hifz/state").set({data:JSON.stringify(store),at:store.at});}catch(e){}
  },900);}
}
function connectDb(tries){
  if(!(window.claude&&window.claude.use)){ if(tries>0) setTimeout(function(){connectDb(tries-1)},1500); return; }
  window.claude.use("db").then(function(d){
    if(!d) return; db=d;
    return d.doc("hifz/state").get().then(function(doc){
      if(!doc||!doc.data){save();return;}
      try{
        var rem=JSON.parse(doc.data);
        if((rem.at||0)>(store.at||0)){
          store=Object.assign(store,rem);
          try{localStorage.setItem(LS,JSON.stringify(store));}catch(e){}
          paintSurah();paintIndex();
        } else save();
      }catch(e){}
    });
  }).catch(function(){});
}
setTimeout(function(){connectDb(4)},400);

/* ---------- text helpers ---------- */
function pad(n){return n<10?"0"+n:""+n}
function arDigits(n){return String(n).replace(/\d/g,function(d){return String.fromCharCode(0x660+ +d)})}
var BUILD="2026-09-12c";

/* A half-updated app is the worst failure mode there is: nothing throws, a
   few things quietly do not work, and the cause is invisible. So the two
   files most likely to disagree carry the same stamp, and disagreeing is
   something the app announces. */
function banner(msg){
  var b=$("banner"); if(!b) return;
  $("bannerMsg").textContent=msg; b.hidden=false;
}
function resetApp(){
  var done=Promise.resolve();
  if(navigator.serviceWorker&&navigator.serviceWorker.getRegistrations)
    done=navigator.serviceWorker.getRegistrations().then(function(rs){
      return Promise.all(rs.map(function(r){return r.unregister()}));
    }).catch(function(){});
  return done.then(function(){
    /* saved recitation and the model are deliberately kept */
    return window.caches?caches.keys().then(function(ks){
      return Promise.all(ks.map(function(k){
        return /audio|model/.test(k)?null:caches.delete(k);
      }));
    }):null;
  }).catch(function(){}).then(function(){ location.reload(true); });
}
if(!window.SABAQ_CONFIG){
  banner("config.js did not load — the reciter list will be empty. Check it uploaded.");
  /* stand something in its place. Without audio the mushaf is still a mushaf:
     reading, concealment, word-by-word and the microphone all work, and there
     is no reason for a missing config file to take them down with it. */
  window.SABAQ_CONFIG={version:BUILD,defaultSource:"everyayah",defaultReciter:"",
    sources:{everyayah:{label:"everyayah.com",url:function(){return ""}}},reciters:[]};
}else if(SABAQ_CONFIG.version&&SABAQ_CONFIG.version!==BUILD){
  banner("These files are from two different builds ("+SABAQ_CONFIG.version+" and "+BUILD+").");
}

function esc(t){return t.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/"/g,"&quot;")}
function mb(n){return (n/1048576).toFixed(n<10485760?1:0)+" MB"}
var DIAC=/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u08D3-\u08FF\u0640\u200B-\u200F]/g;
function norm(w){
  return w.replace(DIAC,"")
    .replace(/[\u0622\u0623\u0625\u0671\u0672\u0673]/g,"\u0627")
    .replace(/[\u0649\u06CC]/g,"\u064A")
    .replace(/\u0629/g,"\u0647")
    .replace(/\u0624/g,"\u0648").replace(/\u0626/g,"\u064A")
    .replace(/[^\u0621-\u064A]/g,"");
}
var HEAD=/^[\u0621-\u064A][\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u08D3-\u08FF]*/;
function head(w){var m=w.match(HEAD);return m?m[0]:w.charAt(0)}
function splitWords(t){return t.split(/\s+/).filter(function(w){return norm(w).length>0})}
var STAGE=["","Sabaq","Sabqī","Manzil"];

function key(s,a){return s+":"+a}
function rec(s,a){return store.prog[key(s,a)]||null}
function stateOf(s,a){var r=rec(s,a);return r?(r.st||0):0}
function repsOf(s,a){var r=rec(s,a);return r?(r.rp||0):0}
function setRec(s,a,patch){
  var k=key(s,a),r=store.prog[k]||{st:0,rp:0};
  for(var p in patch) r[p]=patch[p];
  if(!r.st&&!r.rp&&!r.mk) delete store.prog[k]; else store.prog[k]=r;
  save();
}
function meterHTML(s){
  var n=SUR[s-1].count,c=[0,0,0,0];
  for(var i=1;i<=n;i++) c[stateOf(s,i)]++;
  var h="";
  for(var k=1;k<=3;k++) if(c[k]) h+='<i class="s'+k+'" style="width:'+(c[k]/n*100)+'%"></i>';
  return h;
}
function worked(s){var n=SUR[s-1].count,c=0;for(var i=1;i<=n;i++)if(stateOf(s,i))c++;return c}

/* ---------- theme ---------- */
function applyTheme(){
  if(store.theme) document.documentElement.setAttribute("data-theme",store.theme);
  else document.documentElement.removeAttribute("data-theme");
}
applyTheme();
$("tgTheme").onclick=function(){
  var dark=store.theme?store.theme==="dark":matchMedia("(prefers-color-scheme: dark)").matches;
  store.theme=dark?"light":"dark"; applyTheme(); save();
};

/* ---------- surah render ---------- */
var curS=store.pos.s||1;
var SEQ=[],WEL=[],AS=[],AE=[];   /* flat word sequence for the open surah */
var pos=0, revealed=null;

function paintSurah(){
  var s=SUR[curS-1];
  $("pickNum").textContent=pad(s.n);
  $("pickName").textContent=s.tr;
  $("shead").innerHTML=
    '<div class="row1"><div><h1>'+s.tr+'</h1><div class="sub">'+s.en+'</div></div>'+
    '<div class="ar">'+s.ar+'</div></div>'+
    '<div class="meter">'+meterHTML(s.n)+'</div>'+
    '<div class="legend"><span><i class="dot s1"></i>Sabaq</span><span><i class="dot s2"></i>Sabqī</span>'+
    '<span><i class="dot s3"></i>Manzil</span>'+
    '<span style="margin-left:auto"><b class="mono" style="color:var(--ink)">'+worked(s.n)+'</b>&nbsp;of '+s.count+' worked</span></div>'+
    '<div class="facts"><div class="fact">Revealed <b>'+s.rev+'</b></div>'+
    '<div class="fact">Ayāt <b>'+s.count+'</b></div>'+
    '<div class="fact">Juzʾ <b>'+s.juz+'</b></div>'+
    '<div class="fact">Mushaf page <b>'+s.page+'</b></div></div>';

  var noB=(curS===1||curS===9);
  $("bism").textContent=noB?"":AR["1"][0];
  $("bism").classList.toggle("hidden",noB);

  var ar=AR[String(curS)],out=[],f=0;
  SEQ=[];AS=[];AE=[];
  for(var i=0;i<ar.length;i++){
    var v=i+1,st=stateOf(curS,v),rp=repsOf(curS,v);
    var ws=splitWords(ar[i]),wh="";
    var gl=(store.wb&&WB&&WB[String(curS)])?WB[String(curS)][i]:null;
    AS[v]=f;
    for(var j=0;j<ws.length;j++){
      SEQ.push({a:v,n:norm(ws[j]),raw:ws[j]});
      wh+='<span class="w" data-f="'+f+'">'+
          '<i class="aw" data-h="'+esc(head(ws[j]))+'">'+esc(ws[j])+'</i>'+
          (gl?'<i class="gl">'+esc(gl[j]||"")+'</i>':'')+
        '</span> ';
      f++;
    }
    AE[v]=f-1;
    out.push(
      '<div class="ayah" data-a="'+v+'">'+
        '<span class="spine'+(st?" s"+st:"")+'"></span>'+
        '<div class="ahead">'+
          '<span class="aref">'+curS+':'+v+'</span>'+
          (st?'<span class="astate s'+st+'">'+STAGE[st]+'</span>':'')+
          (rp?'<span class="areps">×'+rp+'</span>':'')+
          '<button class="ago" data-open="'+v+'">Ayah tools ›</button>'+
        '</div>'+
        '<div class="ar-text">'+wh+'<span class="rosette">'+arDigits(v)+'</span></div>'+
        (store.tl&&EN?'<span class="tl">'+esc(EN[String(curS)][i])+'</span>':'')+
        (store.tr&&TR?'<span class="tr">'+esc(TR[String(curS)][i])+'</span>':'')+
      '</div>');
  }
  $("ayat").innerHTML=out.join("");
  WEL=[].slice.call($("ayat").querySelectorAll(".w"));
  revealed=new Uint8Array(SEQ.length);
  applyMask();
  if(loopTo>ar.length){ loopFrom=0; loopTo=0; }
  markLoop();

  var p=curS>1?SUR[curS-2]:null,nx=curS<114?SUR[curS]:null;
  $("navrow").innerHTML=
    (p?'<button class="nav" data-go="'+p.n+'"><span class="k">Previous</span><span class="v">'+p.tr+'</span></button>':'<span style="flex:1"></span>')+
    (nx?'<button class="nav r" data-go="'+nx.n+'"><span class="k">Next</span><span class="v">'+nx.tr+'</span></button>':'<span style="flex:1"></span>');
}

function updateAyahRow(a){
  var el=$("ayat").querySelector('.ayah[data-a="'+a+'"]');
  if(el){
    var st=stateOf(curS,a),rp=repsOf(curS,a),r0=rec(curS,a),mk=r0?(r0.mk||0):0;
    el.querySelector(".spine").className="spine"+(st?" s"+st:"");
    el.querySelector(".ahead").innerHTML=
      '<span class="aref">'+curS+':'+a+'</span>'+
      (st?'<span class="astate s'+st+'">'+STAGE[st]+'</span>':'')+
      (rp?'<span class="areps">×'+rp+'</span>':'')+
      (mk?'<span class="amiss">'+mk+' slip'+(mk===1?'':'s')+'</span>':'')+
      '<button class="ago" data-open="'+a+'">Ayah tools ›</button>';
  }
  var mt=$("shead").querySelector(".meter"); if(mt) mt.innerHTML=meterHTML(curS);
  var lg=$("shead").querySelector(".legend span:last-child b"); if(lg) lg.textContent=worked(curS);
  var row=$("dlist").querySelector('.srow[data-s="'+curS+'"] .mt'); if(row) row.innerHTML=meterHTML(curS);
}

function goSurah(n,a){
  stopMic();
  curS=n; stopAudio(); clearLoop(); store.pos={s:n,a:a||1}; save();
  if(typeof paintOfflineNote==="function") paintOfflineNote();
  if(typeof paintCounter==="function") paintCounter();
  paintSurah(); paintIndex();
  pos=AS[a||1]||0;
  if(a){var el=$("ayat").querySelector('.ayah[data-a="'+a+'"]'); if(el) el.scrollIntoView({block:"center"});}
  else window.scrollTo({top:0});
}

/* ---------- concealment ---------- */
var mask=store.mask||"none";
function applyMask(){
  var c=$("ayat");
  c.className="ayat"+(mask==="none"?"":" m-"+mask)+(store.wb&&WB?" wbw":"");
  [].forEach.call($("segMask").children,function(b){b.classList.toggle("on",b.dataset.m===mask)});
}
function setMask(m){ mask=m; store.mask=m; save(); applyMask(); }
$("segMask").addEventListener("click",function(e){
  var b=e.target.closest("button[data-m]"); if(b) setMask(b.dataset.m);
});

function revealWord(f,on){
  if(f<0||f>=SEQ.length) return;
  revealed[f]=on?1:0;
  if(WEL[f]) WEL[f].classList.toggle("got",!!on);
}
function clearAyahReveals(a){
  for(var f=AS[a];f<=AE[a];f++) revealWord(f,false);
}
var nowEl=null;
function setNow(f){
  if(nowEl) nowEl.classList.remove("now");
  nowEl=(f>=0&&f<WEL.length)?WEL[f]:null;
  if(nowEl) nowEl.classList.add("now");
}

/* ---------- clicks in the mushaf ---------- */
$("ayat").addEventListener("click",function(e){
  var open=e.target.closest("[data-open]");
  if(open){ openPanel(+open.dataset.open); return; }
  var w=e.target.closest(".w");
  if(w){
    var f=+w.dataset.f;
    if(listening){ pos=f; if(TRK) TRK.position=f; setNow(pos); flashStatus(); return; }
    if(mask!=="none"){ revealWord(f,!revealed[f]); return; }
  }
  var ay=e.target.closest(".ayah");
  if(ay) openPanel(+ay.dataset.a);
});
$("navrow").addEventListener("click",function(e){
  var b=e.target.closest("[data-go]"); if(b) goSurah(+b.dataset.go);
});

/* ---------- translations ---------- */
function bindToggle(id,flag,get,label,setKey){
  var el=$(id);
  if(!get()){
    store[flag]=false;
    el.disabled=true;
    el.title=label+" data did not load \u2014 reload the page to try again";
    return;
  }
  function sync(){el.classList.toggle("on",!!store[flag])}
  sync();
  el.onclick=function(){
    store[flag]=!store[flag];
    if(setKey) store[setKey]=true;
    save(); sync(); paintSurah();
  };
}
bindToggle("tgTl","tl",function(){return EN},"Translation");
bindToggle("tgTr","tr",function(){return TR},"Transliteration");
bindToggle("tgWb","wb",function(){return WB},"Word-by-word","wbSet");

/* ---------- surah index ---------- */
function paintIndex(){
  var q=($("search").value||"").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036F]/g,"");
  var out=[];
  for(var i=0;i<SUR.length;i++){
    var s=SUR[i];
    if(q){
      var hay=(s.tr+" "+s.en+" "+s.n+" "+s.ar).toLowerCase().normalize("NFD").replace(/[\u0300-\u036F]/g,"");
      if(hay.indexOf(q)<0) continue;
    }
    out.push('<button class="srow'+(s.n===curS?" cur":"")+'" data-s="'+s.n+'">'+
      '<span class="n">'+pad(s.n)+'</span>'+
      '<span class="t"><b>'+s.tr+'</b><i>'+s.en+' · '+s.count+' ayāt · '+s.rev+'</i></span>'+
      '<span class="a">'+s.ar+'</span>'+
      '<span class="mt">'+meterHTML(s.n)+'</span></button>');
  }
  $("dlist").innerHTML=out.join("")||'<div class="note" style="padding:18px 10px">No surah matches that.</div>';
}
function drawer(on){
  $("drawer").classList.toggle("show",on);
  $("scrim").classList.toggle("show",on);
  if(on){paintIndex();setTimeout(function(){$("search").focus()},120);}
}
$("pick").onclick=function(){drawer(true)};
$("dClose").onclick=function(){drawer(false)};
$("scrim").onclick=function(){drawer(false);closePanel();dlPanel(false);revPanel(false)};
$("search").oninput=paintIndex;
$("dlist").addEventListener("click",function(e){
  var b=e.target.closest("[data-s]"); if(!b) return;
  drawer(false); goSurah(+b.dataset.s);
});

/* ---------- ayah panel ---------- */
var curA=null, loopFrom=0, loopTo=0, rounds=0, dFrom=1, dTo=1;
function openPanel(a){
  if($("dlPanel")) $("dlPanel").classList.remove("show");
  if($("revPanel")) $("revPanel").classList.remove("show");
  curA=a; store.pos={s:curS,a:a}; save();
  $("pRef").textContent=SUR[curS-1].tr+" "+curS+":"+a;
  $("pGloss").textContent=(store.tl&&EN)?EN[String(curS)][a-1]:"";
  $("pGloss").classList.toggle("hidden",!(store.tl&&EN));
  document.querySelectorAll(".ayah.active").forEach(function(e){e.classList.remove("active")});
  var el=$("ayat").querySelector('.ayah[data-a="'+a+'"]');
  if(el){el.classList.add("active");el.scrollIntoView({block:"nearest"});}
  if(loopTo){dFrom=loopFrom;dTo=loopTo;} else {dFrom=a;dTo=a;}
  paintReps(); paintStates(); paintLoopBtn(); paintLoopRounds(); paintCounter();
  $("panel").classList.add("show");
  document.body.classList.add("docked");
  if(innerWidth<1024) $("scrim").classList.add("show");
}
function closePanel(){
  $("panel").classList.remove("show");
  document.body.classList.remove("docked");
  $("scrim").classList.remove("show");
  document.querySelectorAll(".ayah.active").forEach(function(e){e.classList.remove("active")});
  curA=null;
}
$("pClose").onclick=closePanel;

function paintReps(){
  var n=repsOf(curS,curA),t=store.target||5,C=2*Math.PI*18;
  var fg=$("ringFg");
  fg.setAttribute("stroke-dasharray",C);
  fg.setAttribute("stroke-dashoffset",C*(1-Math.min(1,n/t)));
  fg.setAttribute("stroke",n>=t?"var(--manzil)":"var(--brass)");
  $("ringTxt").textContent=n;
  [].forEach.call($("tgt").querySelectorAll("button"),function(b){b.classList.toggle("on",+b.dataset.t===t)});
}
function paintStates(){
  var st=stateOf(curS,curA);
  [].forEach.call($("states").children,function(b){b.classList.toggle("on",+b.dataset.s===st)});
}
function paintLoopBtn(){
  if(!curA) return;
  var n=SUR[curS-1].count;
  dFrom=Math.max(1,Math.min(n,dFrom)); dTo=Math.max(dFrom,Math.min(n,dTo));
  $("dFrom").textContent=dFrom; $("dTo").textContent=dTo;
  var span=dTo-dFrom+1;
  $("loopSet").textContent="Loop "+dFrom+(dTo>dFrom?"\u2013"+dTo:"")+" ("+span+" ay"+(span>1?"\u0101t":"ah")+")";
  var one=loopTo&&loopFrom===curA&&loopTo===curA;
  $("loopOne").textContent=one?"Looping this ayah":"Loop just this ayah";
  $("loopOne").classList.toggle("onb",!!one);
  $("loopClear").disabled=!loopTo;
  $("loopNote").textContent=loopTo
    ? ("Looping "+curS+":"+loopLabel()+". Reciting past the last ayah in the range takes you back to the first and starts a new round; each ayah still counts its own repetitions.")
    : "Set a range around the part you keep slipping on \u2014 while it loops, the tracker returns to the start instead of carrying on through the surah.";
}
function markLoop(){
  $("ayat").querySelectorAll(".inloop").forEach(function(e){
    e.classList.remove("inloop","loopstart","loopend");
  });
  if(!loopTo) return;
  for(var a=loopFrom;a<=loopTo;a++){
    var el=$("ayat").querySelector('.ayah[data-a="'+a+'"]');
    if(!el) continue;
    el.classList.add("inloop");
    if(a===loopFrom) el.classList.add("loopstart");
    if(a===loopTo) el.classList.add("loopend");
  }
}
function loopLabel(){ return loopFrom+(loopTo>loopFrom?"\u2013"+loopTo:""); }
function paintChip(){
  var c=$("chip");
  c.classList.toggle("on",!!loopTo);
  if(!loopTo) return;
  $("chipRange").textContent=curS+":"+loopLabel();
  var lim=store.loopRounds||0;
  $("chipRounds").textContent = lim
    ? ("round "+Math.min(rounds+1,lim)+" of "+lim)
    : (rounds?("round "+(rounds+1)):((loopTo-loopFrom+1)+" ay\u0101t"));
}
function loopLimitReached(){ return (store.loopRounds||0)>0 && rounds>=store.loopRounds }
function finishLoop(){
  var done=rounds, where=curS+":"+loopLabel();
  stopAudio(); stopMic();
  rounds=0; paintChip(); paintCounter();
  showStatus("Finished "+done+" round"+(done===1?"":"s")+" of "+where,"done");
  setTimeout(function(){ if(!playing&&!listening) hideStatus(); },7000);
}
function paintLoopRounds(){
  [].forEach.call($("loopRounds").children,function(b){
    b.classList.toggle("on",+b.dataset.r===(store.loopRounds||0));
  });
}
$("loopRounds").addEventListener("click",function(e){
  var b=e.target.closest("button[data-r]"); if(!b) return;
  store.loopRounds=+b.dataset.r; save(); paintLoopRounds(); paintChip();
});
function setLoop(f,t){
  var n=SUR[curS-1].count;
  loopFrom=Math.max(1,Math.min(f,t)); loopTo=Math.min(n,Math.max(f,t));
  rounds=0; markLoop(); paintChip();
  pos=AS[loopFrom]; if(listening) setNow(pos);
  store.loop={s:curS,f:loopFrom,t:loopTo}; save();
}
function clearLoop(){
  loopFrom=0; loopTo=0; rounds=0; markLoop(); paintChip();
  store.loop=null; save();
}
function bump(a,by){
  var n=Math.max(0,repsOf(curS,a)+by);
  setRec(curS,a,{rp:n});
  if(by>0&&!stateOf(curS,a)) setRec(curS,a,{st:1});
  updateAyahRow(a);
  if(curA===a){paintReps();paintStates();}
  paintCounter();
}
$("repAdd").onclick=function(){bump(curA,1)};
$("repUndo").onclick=function(){bump(curA,-1)};
$("tgt").addEventListener("click",function(e){
  var b=e.target.closest("button[data-t]"); if(!b) return;
  store.target=+b.dataset.t; save(); paintReps(); paintCounter();
});
$("states").addEventListener("click",function(e){
  var b=e.target.closest("button[data-s]"); if(!b) return;
  setRec(curS,curA,{st:+b.dataset.s}); paintStates(); updateAyahRow(curA);
});
$("loopOne").onclick=function(){
  if(loopTo&&loopFrom===curA&&loopTo===curA) clearLoop();
  else { dFrom=dTo=curA; setLoop(curA,curA); }
  paintLoopBtn();
};
$("loopSet").onclick=function(){ setLoop(dFrom,dTo); paintLoopBtn(); };
$("loopClear").onclick=function(){ clearLoop(); paintLoopBtn(); };
$("chipX").onclick=function(){ clearLoop(); paintLoopBtn(); };
document.querySelector(".range").addEventListener("click",function(e){
  var b=e.target.closest("button[data-r]"); if(!b) return;
  var r=b.dataset.r;
  if(r==="f-") dFrom--; else if(r==="f+") dFrom++;
  else if(r==="t-") dTo--; else if(r==="t+") dTo++;
  if(dTo<dFrom){ if(r.charAt(0)==="f") dTo=dFrom; else dFrom=dTo; }
  paintLoopBtn();
});
$("startHere").onclick=function(){
  pos=AS[curA]; setNow(listening?pos:-1);
  if(!listening) startMic(); else flashStatus();
};
$("revealAyah").onclick=function(){
  for(var f=AS[curA];f<=AE[curA];f++) revealWord(f,true);
};
$("prevAyah").onclick=function(){if(curA>1) openPanel(curA-1)};
$("nextAyah").onclick=function(){
  if(curA<SUR[curS-1].count) openPanel(curA+1);
  else if(curS<114){goSurah(curS+1);openPanel(1);}
};

/* ---------- recitation tracking ---------- */
/* The alignment and mistake detection live in tracker.js. This section is
   only the plumbing: feed it what the recogniser heard, and turn what it
   reports back into marks on the page. Replacing the recogniser with a
   Whisper or CTC endpoint later means changing startMic and nothing else. */

var SR=window.SpeechRecognition||window.webkitSpeechRecognition;
var recog=null,listening=false,doneCount=0,utterConsumed=0,lastScroll=0;
var TRK=null, IDX=null, idleT=null;
var mistakes=[];                       /* this session's findings */

/* Two ways of hearing, and the tracker cannot tell them apart: both hand it
   a list of words. The browser's recogniser is free and needs no download
   but sends your voice to a vendor and returns no timing. The on-device
   model is a deliberate download and gives a start and end time for every
   letter, which is the only way madd length is measurable. */
var CTC=window.SabaqCTC;
var localOK=!!(CTC&&CTC.supported());
var engine=(store.engine==="local"&&localOK)?"local":"speech";
if(!SR&&localOK) engine="local";
function engineAvailable(){ return engine==="local" ? localOK : !!SR; }
if(!SR&&!localOK){
  $("micBtn").disabled=true;
  $("micBtn").title="This browser has neither speech recognition nor WebAssembly";
}

function showStatus(txt,cls){
  $("status").className="status on"+(cls?" "+cls:"");
  $("where").textContent=txt;
}
function hideStatus(){ if(!listening&&!playing) $("status").className="status"; }
function statusText(extra,cls){
  if(!listening) return;
  if(extra){ showStatus(extra,cls||"lost"); return; }
  var e=SEQ[pos];
  $("status").className="status on";
  if(!e){ $("where").textContent="End of "+SUR[curS-1].tr+" — choose the next surah"; return; }
  $("where").textContent="Following "+SUR[curS-1].tr+" "+curS+":"+e.a+
    (loopTo?" · loop "+loopFrom+(loopTo>loopFrom?"–"+loopTo:""):"")+
    " · word "+(pos-AS[e.a]+1)+" of "+(AE[e.a]-AS[e.a]+1);
}
function flashStatus(){ statusText(); }

function scrollTo_(f){
  var el=WEL[f]; if(!el) return;
  var now=Date.now(); if(now-lastScroll<450) return;
  var r=el.getBoundingClientRect();
  if(r.top<110||r.bottom>innerHeight-190){
    lastScroll=now;
    el.scrollIntoView({block:"center",behavior:"smooth"});
  }
}

/* ---- turning findings into marks ---- */

var KIND={
  substitution:{label:"Wrong word",cls:"k-sub"},
  omission:{label:"Words missed",cls:"k-omit"},
  skipped_ayah:{label:"Ayah skipped",cls:"k-skip"},
  drift:{label:"Slipped elsewhere",cls:"k-drift"},
  hesitation:{label:"Hesitated",cls:"k-hesit"},
  repeat:{label:"Repeated",cls:"k-rep"},
  insertion:{label:"Extra word",cls:"k-rep"},
  restart:{label:"Started again",cls:"k-rep"}
};
var COUNTED={substitution:1,omission:1,skipped_ayah:1,drift:1};

function markWord(f,cls,letters){
  var el=WEL[f]; if(!el) return;
  el.classList.add(cls);
  var aw=el.querySelector(".aw");
  if(aw&&letters&&letters.length&&(cls==="miss"||cls==="soft")){
    var raw=SEQ[f].raw||aw.textContent;
    /* letters are indices into the normalised form; map them back by
       walking the raw word and counting only letters that survive
       normalisation, so diacritics do not shift the highlight */
    var out="",li=0,set={};
    for(var i=0;i<letters.length;i++) set[letters[i]]=1;
    for(var c=0;c<raw.length;c++){
      var ch=raw.charAt(c);
      var isLetter=SabaqTracker.normalise(ch).length>0;
      if(isLetter){
        out+= set[li] ? '<i class="badletters">'+esc(ch)+'</i>' : esc(ch);
        li++;
      } else out+=esc(ch);
    }
    aw.innerHTML=out;
  }
  var ay=el.closest(".ayah"); if(ay) ay.classList.add("hasmiss");
}

function logMistake(ev){
  var a=ev.ayah||1;
  mistakes.push({s:curS,a:a,type:ev.type,expected:ev.expected||"",heard:ev.heard||"",
                 word:ev.word,ayat:ev.ayat,to:ev.to,conf:ev.confidence||0,at:ev.at});
  if(COUNTED[ev.type]){
    var r=rec(curS,a)||{};
    setRec(curS,a,{mk:(r.mk||0)+1});
    updateAyahRow(a);
  }
  paintRevDot();
}

function onTrackEvent(ev){
  switch(ev.type){
    case "match":
      revealWord(ev.word,true);
      if(ev.word>=pos) pos=ev.word+1;
      break;
    case "substitution":
      revealWord(ev.word,true);
      markWord(ev.word,"miss",ev.letters);
      if(ev.word>=pos) pos=ev.word+1;
      logMistake(ev);
      statusText("Said “"+ev.heard+"” for “"+ev.expected+"”","lost");
      break;
    case "omission":
      for(var i=0;i<ev.words.length;i++) markWord(ev.words[i],"gap");
      logMistake(ev);
      statusText(ev.words.length+" word"+(ev.words.length===1?"":"s")+" missed","lost");
      break;
    case "skipped_ayah":
      for(var f=ev.from;f<=ev.to;f++) markWord(f,"gap");
      logMistake(ev);
      statusText("Skipped "+curS+":"+ev.ayat.join(", "),"lost");
      break;
    case "drift":
      logMistake(ev);
      statusText("That is "+ev.to.surah+":"+ev.to.ayah+" — a similar passage","lost");
      break;
    case "restart":
      statusText();
      break;
    case "repeat": case "insertion": case "hesitation":
      logMistake(ev);
      break;
    case "lost":
      statusText("Lost the thread — tap a word to pick up from there","lost");
      break;
  }
}

/* the loop range still governs where recitation goes next */
function afterFeed(){
  if(!TRK) return;
  pos=TRK.position;
  if(loopTo&&pos>AE[loopTo]){
    rounds++; paintChip();
    if(loopLimitReached()){ finishLoop(); return; }
    for(var q=loopFrom;q<=loopTo;q++) clearAyahReveals(q);
    pos=AS[loopFrom]; TRK.position=pos;
  }
  setNow(pos);
  scrollTo_(Math.min(pos,SEQ.length-1));
  statusText();
}

function makeTracker(){
  TRK=SabaqTracker.create({
    words:SEQ, ayahStart:AS, ayahEnd:AE, surah:curS,
    index:IDX, onEvent:onTrackEvent
  });
  TRK.reset(pos||0);
}

function startMic(){
  if(listening||!engineAvailable()) return;
  stopAudio();
  if(mask==="none") setMask("blur");

  /* the drift index covers the whole mushaf, so build it once, lazily */
  if(!IDX&&window.QAR){
    showStatus("Preparing…","");
    try{ IDX=SabaqTracker.buildIndex(window.QAR); }catch(e){ IDX=null; }
  }

  if(loopTo&&(pos<AS[loopFrom]||pos>AE[loopTo])) pos=AS[loopFrom];
  else if(curA&&!loopTo) pos=AS[curA];
  else if(!pos) pos=0;
  makeTracker();

  if(engine==="local") startLocal(); else startSpeech();
}

/* ---- the on-device model ---- */

/* The engine is told, every window, which letters it should expect next.
   Giving it the text turns an open-vocabulary guess into a constrained
   one, and that is the whole reason the alignment is trustworthy. */
function expectedPlan(){
  if(!CTC||!CTC.meta()) return null;
  var ids=[],words=[],start=pos,n=0;
  for(var f=start;f<SEQ.length&&n<10;f++,n++){
    var enc=CTC.encode(SEQ[f].raw);
    if(!enc||!enc.length) continue;
    if(ids.length) ids.push(CTC.meta().separator);
    words.push({index:f,from:ids.length,to:ids.length+enc.length-1});
    for(var k=0;k<enc.length;k++) ids.push(enc[k]);
  }
  return ids.length?{ids:ids,words:words}:null;
}

/* Letter detail only means something for a word the tracker has accepted.
   Flagging letters in a word the reciter never reached would be inventing
   mistakes out of silence, which is the one failure worth avoiding. */
function onLetterDetail(details){
  for(var i=0;i<details.length;i++){
    var d=details[i];
    if(d.word>=pos) continue;                 /* not yet passed — say nothing */
    if(!d.weak.length||d.startMs===null) continue;
    var el=WEL[d.word]; if(!el) continue;
    var aw=el.querySelector(".aw"); if(!aw) continue;
    if(aw.getAttribute("data-lt")) continue;  /* already judged */
    aw.setAttribute("data-lt","1");
    markWord(d.word,"soft",d.weak);
  }
}

function startLocal(){
  showStatus(CTC.loaded()?"Starting…":"Loading the model…","");
  CTC.setExpected(expectedPlan);
  CTC.start({
    onProgress:function(got,total){
      showStatus("Downloading the model — "+mb(got)+(total?" of "+mb(total):""),"");
    },
    onWords:function(ws){
      if(!ws.length||!TRK) return;
      TRK.feed(ws); afterFeed();
    },
    onDetail:onLetterDetail,
    onError:function(msg){ showStatus(msg,"lost"); }
  }).then(function(){
    listening=true;
    micLive();
  }).catch(function(e){
    showStatus(String(e.message||e),"lost");
    stopMic(true);
  });
}

function micLive(){
  setNow(pos);
  $("micBtn").classList.add("live");
  $("micBtn").setAttribute("aria-label","Stop reciting");
  statusText();
  scrollTo_(pos);
  clearInterval(idleT);
  idleT=setInterval(function(){ if(TRK&&listening) TRK.idle(); },1500);
}

/* ---- the browser's recogniser ---- */

function startSpeech(){
  recog=new SR();
  recog.lang="ar-SA"; recog.continuous=true; recog.interimResults=true;
  doneCount=0; utterConsumed=0;

  recog.onresult=function(ev){
    var dc=doneCount,uc=utterConsumed,batch=[];
    for(var r=dc;r<ev.results.length;r++){
      var ws=ev.results[r][0].transcript.split(/\s+/).filter(Boolean);
      var start=(r===dc)?uc:0;
      for(var k=start;k<ws.length;k++) batch.push(ws[k]);
      if(ev.results[r].isFinal){doneCount=r+1;utterConsumed=0;}
      else utterConsumed=ws.length;
    }
    if(batch.length&&TRK){ TRK.feed(batch); afterFeed(); }
  };
  recog.onerror=function(ev){
    if(ev.error==="not-allowed"||ev.error==="service-not-allowed"){
      showStatus("Microphone blocked — allow it for this page, then tap the mic again","lost");
      stopMic(true);
    }
  };
  recog.onend=function(){ if(listening){ try{recog.start()}catch(e){} } };
  try{recog.start()}catch(e){return}
  listening=true;
  micLive();
}
function stopMic(keepMsg){
  listening=false;
  clearInterval(idleT);
  $("micBtn").classList.remove("live");
  $("micBtn").setAttribute("aria-label","Recite to reveal");
  if(recog){try{recog.onend=null;recog.stop()}catch(e){} recog=null;}
  if(CTC) CTC.stop();
  setNow(-1);
  if(!keepMsg) hideStatus();
}
$("micBtn").onclick=function(){listening?stopMic():startMic()};

/* ---------- choosing how to listen ---------- */

function paintEngine(){
  var sel=$("engineSel"); if(!sel) return;
  if(!CTC){ sel.parentNode.style.display="none"; return; }
  sel.value=engine;
  var opt=sel.options[1];
  if(!localOK){ opt.disabled=true; opt.textContent="On-device model — not supported here"; }
  if(!SR){ sel.options[0].disabled=true; sel.options[0].textContent="Browser speech recognition — not in this browser"; }

  var note=$("engNote"), foot=$("engFoot");
  if(engine!=="local"){
    foot.style.display="none";
    note.textContent=SR
      ? "Words are recognised by the browser's own service, so this needs a network and returns no timing — mistakes are found by comparing words, not sound."
      : "This browser has no speech recognition. Use the on-device model.";
    return;
  }
  foot.style.display="";
  CTC.modelBytes().then(function(b){
    $("mdlGet").style.display=b?"none":"";
    $("mdlDrop").style.display=b?"":"none";
    note.textContent=b
      ? "Saved on this device ("+mb(b)+"). Your voice never leaves the phone, and every letter is timed, so madd length is measured rather than guessed."
      : "A one-off download of about 95 MB. After that it runs on the device with no network, and times every letter.";
  });
}

if($("engineSel")) $("engineSel").onchange=function(){
  engine=this.value; store.engine=engine; save();
  if(listening) stopMic();
  paintEngine();
};
if($("mdlGet")) $("mdlGet").onclick=function(){
  var bar=$("mdlBar"), pr=$("mdlProg");
  pr.classList.add("on"); bar.style.width="0%";
  this.disabled=true;
  CTC.download(function(got,total){
    bar.style.width=(total?(got/total*100):0).toFixed(1)+"%";
    $("engNote").textContent="Downloading — "+mb(got)+(total?" of "+mb(total):"");
  }).then(function(){
    pr.classList.remove("on"); $("mdlGet").disabled=false; paintEngine();
  }).catch(function(e){
    pr.classList.remove("on"); $("mdlGet").disabled=false;
    $("engNote").textContent="Could not fetch the model: "+(e.message||e)+
      " — check that web-model/ was copied in beside config.js.";
  });
};
if($("mdlDrop")) $("mdlDrop").onclick=function(){
  CTC.clearModel().then(paintEngine);
};
paintEngine();

/* ---------- the review sheet ---------- */
function paintRevDot(){
  var n=mistakes.filter(function(m){return COUNTED[m.type]}).length;
  var d=$("revDot");
  d.textContent=n;
  d.classList.toggle("on",n>0);
}
function revPanel(on){
  if(on){ closePanel(); $("dlPanel").classList.remove("show"); paintReview(); }
  $("revPanel").classList.toggle("show",on);
  document.body.classList.toggle("docked",on);
  if(innerWidth<1024) $("scrim").classList.toggle("show",on);
}
$("revOpen").onclick=function(){ revPanel(true) };
$("revClose").onclick=function(){ revPanel(false) };
$("revClear").onclick=function(){
  mistakes=[]; paintRevDot(); paintReview();
  $("ayat").querySelectorAll(".miss,.gap").forEach(function(e){e.classList.remove("miss","gap")});
  $("ayat").querySelectorAll(".hasmiss").forEach(function(e){e.classList.remove("hasmiss")});
};
function paintReview(){
  var counted=mistakes.filter(function(m){return COUNTED[m.type]});
  var hes=mistakes.filter(function(m){return m.type==="hesitation"||m.type==="repeat"}).length;
  $("revCount").textContent=counted.length?(counted.length+" to look at"):"nothing flagged";
  var byAyah={};
  counted.forEach(function(m){ byAyah[m.a]=(byAyah[m.a]||0)+1; });
  var weakest=Object.keys(byAyah).sort(function(x,y){return byAyah[y]-byAyah[x]})[0];
  $("revSum").innerHTML=
    '<div class="revstat"><b>'+counted.length+'</b><span>Mistakes</span></div>'+
    '<div class="revstat"><b>'+hes+'</b><span>Hesitations</span></div>'+
    '<div class="revstat"><b>'+(weakest?(curS+":"+weakest):"—")+'</b><span>Weakest ayah</span></div>';

  if(!mistakes.length){
    $("revList").innerHTML='<div class="dlempty">Nothing flagged yet. Recite with the microphone on and anything that goes astray will be listed here.</div>';
    return;
  }
  var out=[];
  for(var i=mistakes.length-1;i>=0;i--){
    var m=mistakes[i], k=KIND[m.type]||{label:m.type,cls:""};
    var body="";
    if(m.type==="substitution"){
      body='<div class="rar">'+esc(SEQ[m.word]?(SEQ[m.word].raw||m.expected):m.expected)+'</div>'+
           '<div class="rwas">you said “'+esc(m.heard)+'”</div>';
    } else if(m.type==="omission"){
      body='<div class="rar">'+esc(m.expected)+'</div><div class="rwas">missed</div>';
    } else if(m.type==="skipped_ayah"){
      body='<div class="rwas">ayah '+(m.ayat||[]).join(", ")+' not recited</div>';
    } else if(m.type==="drift"){
      body='<div class="rwas">matched '+m.to.surah+":"+m.to.ayah+' instead — “'+esc(m.heard)+'”</div>';
    } else if(m.type==="repeat"||m.type==="insertion"){
      body='<div class="rwas">“'+esc(m.heard)+'”</div>';
    } else if(m.type==="hesitation"){
      body='<div class="rwas">paused here</div>';
    }
    out.push('<div class="revrow" data-a="'+m.a+'">'+
      '<div class="rh"><span class="rref">'+m.s+':'+m.a+'</span>'+
      '<span class="rkind '+k.cls+'">'+k.label+'</span>'+
      '<span class="rgo">Go ›</span></div>'+body+'</div>');
  }
  $("revList").innerHTML=out.join("");
}
$("revList").addEventListener("click",function(e){
  var r=e.target.closest("[data-a]"); if(!r) return;
  revPanel(false);
  var el=$("ayat").querySelector('.ayah[data-a="'+r.dataset.a+'"]');
  if(el) el.scrollIntoView({block:"center",behavior:"smooth"});
});
paintRevDot();

/* ---------- recitation audio ---------- */
var CFG=window.SABAQ_CONFIG||{sources:{},reciters:[]};
var AUDIO_CACHE="sabaq-audio-v1";
var haveCaches=(typeof caches!=="undefined");

function p3(n){ return n<10?"00"+n:(n<100?"0"+n:""+n) }
var GSTART=(function(){ var g=[0,1],t=1; for(var i=1;i<=114;i++){ g[i]=t; t+=SUR[i-1].count; } return g; })();
function globalAyah(s,a){ return GSTART[s]+a-1 }

function srcKey(){
  var k=store.source;
  if(!k||!CFG.sources[k]) k=CFG.defaultSource;
  if(!k||!CFG.sources[k]) k=Object.keys(CFG.sources)[0];
  return k;
}
function recById(id){
  var list=CFG.reciters||[];
  for(var i=0;i<list.length;i++) if(list[i].id===id) return list[i];
  return null;
}
function recObj(){
  var k=srcKey(), list=CFG.reciters||[];
  var r=recById(store.reciter);
  if(!r||!r[k]) r=recById(CFG.defaultReciter);
  if(!r||!r[k]) for(var i=0;i<list.length;i++) if(list[i][k]){ r=list[i]; break; }
  return r||list[0]||null;
}
function availableReciters(){
  var k=srcKey();
  return CFG.reciters.filter(function(r){ return !!r[k] });
}
function audioUrl(s,a){
  var src=CFG.sources[srcKey()], rec=recObj();
  if(!src||!rec||!rec[srcKey()]) return null;
  return src.url(rec,s,a,p3,globalAyah(s,a));
}
function reciterName(){ var r=recObj(); return r?r.name:"" }
function recId(){ var r=recObj(); return r?r.id:"" }

/* ---------- offline store ---------- */
function savedKey(s){ return recId()+"|"+srcKey()+"|"+s }
function isSaved(s){ return !!(store.saved&&store.saved[savedKey(s)]) }
function markSaved(s,n){ store.saved=store.saved||{}; store.saved[savedKey(s)]={n:n,at:Date.now()}; save(); }
function unmarkSaved(k){ if(store.saved) delete store.saved[k]; save(); }

function surahUrls(s){
  var out=[],n=SUR[s-1].count;
  for(var a=1;a<=n;a++){ var u=audioUrl(s,a); if(u) out.push(u); }
  return out;
}
function juzSurahs(s){
  var j=META.juz[String(s)][0], list=[];
  for(var n=1;n<=114;n++){
    var js=META.juz[String(n)];
    for(var i=0;i<js.length;i++) if(js[i]===j){ list.push(n); break; }
  }
  return {juz:j,surahs:list};
}

/* A host that sends CORS gives a readable copy, which the page can turn
   into a blob url. A host that does not gives an opaque copy: only
   cache.put accepts those (cache.add rejects them), and only the service
   worker can hand one back to the audio element. Both are stored here. */
function cacheOne(cache,url){
  return fetch(url,{mode:"cors"}).then(function(r){
    if(r&&r.ok) return cache.put(url,r.clone());
    throw 0;
  }).catch(function(){
    return fetch(url,{mode:"no-cors"}).then(function(r){
      if(!r) throw 0;
      return cache.put(url,r);
    });
  });
}

/* An opaque response looks identical whether the file exists or not, so a
   wrong reciter path would fill the cache with 404s. Play-test one ayah
   before committing to a few hundred downloads. */
function probeUrl(url){
  return new Promise(function(res){
    var a=new Audio(), done=false;
    function end(ok){ if(done) return; done=true; clearTimeout(t); a.onloadedmetadata=a.onerror=null; a.removeAttribute("src"); res(ok); }
    var t=setTimeout(function(){ end(false) },10000);
    a.preload="metadata";
    a.onloadedmetadata=function(){ end(true) };
    a.onerror=function(){ end(false) };
    a.src=url; a.load();
  });
}
function withProbe(urls,label,onDone){
  $("dlNote").textContent="Checking " + reciterName() + " on " + (CFG.sources[srcKey()]||{}).label + "…";
  probeUrl(urls[0]).then(function(ok){
    if(!ok){
      $("dlNote").textContent=reciterName()+" did not respond on "+((CFG.sources[srcKey()]||{}).label||"this source")+
        ". Nothing was downloaded — try the other source, or another reciter.";
      return;
    }
    downloadUrls(urls,label,onDone);
  });
}
var dlAbort=false, dlBusy=false;
function downloadUrls(urls,label,onDone){
  if(!haveCaches){ $("dlNote").textContent="This browser will not let a page store files offline. Serve the app over https and try again."; return; }
  if(dlBusy) return;
  dlBusy=true; dlAbort=false;
  var done=0,failed=0,total=urls.length,i=0,active=0;
  $("dlProg").classList.add("on");
  $("dlCancel").style.display="";
  $("dlNote").textContent="Saving "+label+" — 0 of "+total;
  caches.open(AUDIO_CACHE).then(function(cache){
    function step(){
      if(dlAbort||i>=urls.length){
        if(active===0) finish();
        return;
      }
      var u=urls[i++]; active++;
      cacheOne(cache,u).catch(function(){failed++}).then(function(){
        active--; done++;
        $("dlBar").style.width=(done/total*100)+"%";
        $("dlNote").textContent="Saving "+label+" — "+done+" of "+total+(failed?(" ("+failed+" failed)"):"");
        step();
      });
    }
    for(var k=0;k<4;k++) step();
    function finish(){
      dlBusy=false;
      $("dlCancel").style.display="none";
      $("dlProg").classList.remove("on");
      $("dlBar").style.width="0%";
      if(dlAbort){ $("dlNote").textContent="Stopped. What had already saved is kept."; }
      else if(failed>=total){ $("dlNote").textContent="Nothing could be saved — the recitation source did not respond. Try the other source above."; }
      else { $("dlNote").textContent="Saved "+label+(failed?(", "+failed+" ayat could not be fetched"):"")+"."; }
      if(onDone) onDone(failed,total);
      paintDownloads(); paintOfflineNote();
    }
  });
}
$("dlCancel").onclick=function(){ dlAbort=true; };

function removeSaved(key){
  var parts=key.split("|"), rid=parts[0], sk=parts[1], s=+parts[2];
  var keep={reciter:store.reciter,source:store.source};
  store.reciter=rid; store.source=sk;
  var urls=surahUrls(s);
  store.reciter=keep.reciter; store.source=keep.source;
  if(!haveCaches) return;
  caches.open(AUDIO_CACHE).then(function(cache){
    return Promise.all(urls.map(function(u){ return cache.delete(u) }));
  }).then(function(){ unmarkSaved(key); paintDownloads(); paintOfflineNote(); });
}

function paintDownloads(){
  var keys=Object.keys(store.saved||{});
  var host=$("dlList");
  if(!keys.length){ host.innerHTML='<div class="dlempty">Nothing saved yet.</div>'; }
  else{
    keys.sort();
    host.innerHTML=keys.map(function(k){
      var p=k.split("|"), s=+p[2], rec=null;
          rec=recById(p[0]);
      return '<div class="dlrow"><b>'+SUR[s-1].tr+'</b>'+
        '<span style="color:var(--muted);font-size:12px">'+(rec?rec.name.split(" — ")[0]:p[0])+'</span>'+
        '<span class="sz">'+store.saved[k].n+' ayāt</span>'+
        '<button data-del="'+k+'">Remove</button></div>';
    }).join("");
  }
  if(navigator.storage&&navigator.storage.estimate){
    navigator.storage.estimate().then(function(e){
      if(!e||!e.usage) return;
      $("dlUsage").textContent=(e.usage/1048576).toFixed(0)+" MB stored";
    });
  }
}
$("dlList").addEventListener("click",function(e){
  var b=e.target.closest("[data-del]"); if(b) removeSaved(b.dataset.del);
});
$("dlClear").onclick=function(){
  if(!haveCaches) return;
  caches.delete(AUDIO_CACHE).then(function(){
    store.saved={}; save(); paintDownloads(); paintOfflineNote();
  });
};
$("dlSurah").onclick=function(){
  var urls=surahUrls(curS);
  if(!urls.length){ $("dlNote").textContent="This reciter is not available on the selected source."; return; }
  withProbe(urls,SUR[curS-1].tr,function(failed,total){
    if(failed<total) markSaved(curS,total-failed);
  });
};
$("dlJuz").onclick=function(){
  var j=juzSurahs(curS), all=[], per=[];
  j.surahs.forEach(function(n){ var u=surahUrls(n); per.push([n,u.length]); all=all.concat(u); });
  if(!all.length){ $("dlNote").textContent="This reciter is not available on the selected source."; return; }
  withProbe(all,"Juzʾ "+j.juz,function(failed,total){
    if(failed<total){
      var keep=curS;
      per.forEach(function(x){ curS=x[0]; markSaved(x[0],x[1]); });
      curS=keep;
    }
  });
};

/* ---------- reciter pickers ---------- */
function fillReciters(){
  var list=availableReciters(), h="";
  if(!list.length) list=CFG.reciters||[];
  if(!list.length){
    /* no reciters configured at all: say so in the control itself rather
       than throwing and taking the rest of the app down with it */
    ["reciter","reciter2"].forEach(function(id){
      var sel=$(id); if(sel){ sel.innerHTML='<option>No reciters configured</option>'; sel.disabled=true; }
    });
    return;
  }
  for(var i=0;i<list.length;i++) h+='<option value="'+list[i].id+'">'+list[i].name+'</option>';
  var cur=recId()||list[0].id;
  ["reciter","reciter2"].forEach(function(id){
    var sel=$(id); if(!sel) return;
    sel.innerHTML=h; sel.value=cur;
    sel.onchange=function(){
      store.reciter=sel.value; save(); fillReciters();
      if(playing) playAyah(playA,playLeft);
      paintDownloads(); paintOfflineNote();
    };
  });
  var srcOpts=Object.keys(CFG.sources).map(function(k){
    return '<button data-src="'+k+'"'+(k===srcKey()?' class="on"':'')+'>'+CFG.sources[k].label+'</button>';
  }).join("");
  $("srcNote").innerHTML='<div class="mini" id="srcPick" style="margin-top:6px">'+srcOpts+'</div>'+
    '<div style="margin-top:6px">If a reciter will not play, try the other source.</div>';
  $("srcPick").addEventListener("click",function(e){
    var b=e.target.closest("[data-src]"); if(!b) return;
    store.source=b.dataset.src; save(); fillReciters(); paintDownloads(); paintOfflineNote();
  });
}
function paintOfflineNote(){
  var n=$("offlineNote");
  if(!n) return;
  n.innerHTML=isSaved(curS)
    ? '<span class="offline-badge">Saved offline</span> This surah plays without a network.'
    : 'Not saved offline yet — open the download panel in the top bar to keep it on this device.';
}

/* ---------- playback ---------- */
var audio=new Audio(), playing=false, playA=0, playLeft=1, blobUrl=null, playToken=0;
audio.preload="none";
var PLAY_ICON='<path d="M7 4.5v15l13-7.5z"/>', PAUSE_ICON='<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>';

function paintAudioBtns(){
  [].forEach.call($("aRep").children,function(b){b.classList.toggle("on",+b.dataset.n===(store.arep||1))});
  [].forEach.call($("aSpd").children,function(b){b.classList.toggle("on",+b.dataset.s===(store.aspd||1))});
}
$("aRep").addEventListener("click",function(e){
  var b=e.target.closest("button[data-n]"); if(!b) return;
  store.arep=+b.dataset.n; save(); paintAudioBtns();
});
$("aSpd").addEventListener("click",function(e){
  var b=e.target.closest("button[data-s]"); if(!b) return;
  store.aspd=+b.dataset.s; save(); paintAudioBtns();
  audio.playbackRate=store.aspd;
});
function markPlaying(a){
  $("ayat").querySelectorAll(".ayah.playing").forEach(function(e){e.classList.remove("playing")});
  if(!a) return;
  var el=$("ayat").querySelector('.ayah[data-a="'+a+'"]');
  if(el){ el.classList.add("playing"); el.scrollIntoView({block:"center",behavior:"smooth"}); }
}
function setPlayIcon(on){
  $("playBtn").classList.toggle("on",on);
  $("playIcon").innerHTML=on?PAUSE_ICON:PLAY_ICON;
}
function releaseBlob(){ if(blobUrl){ URL.revokeObjectURL(blobUrl); blobUrl=null; } }

function resolveSrc(url){
  /* a readable cached copy becomes a blob url, which sidesteps range-request
     quirks; an opaque cached copy is served by the service worker instead. */
  if(!haveCaches) return Promise.resolve(url);
  return caches.match(url).then(function(r){
    if(!r) return url;
    if(r.type==="opaque") return url;
    return r.blob().then(function(b){
      if(!b||!b.size) return url;
      releaseBlob(); blobUrl=URL.createObjectURL(b); return blobUrl;
    });
  }).catch(function(){ return url });
}
function playAyah(a,left){
  stopMic();
  var url=audioUrl(curS,a);
  if(!url){ audioFailed("This reciter is not available on the selected source."); return; }
  var tok=++playToken;
  playA=a; playLeft=left||store.arep||1;
  playing=true; setPlayIcon(true); markPlaying(a); paintCounter();
  showStatus("Playing "+curS+":"+a+" · "+reciterName(),"audio");
  resolveSrc(url).then(function(src){
    if(tok!==playToken||!playing) return;
    audio.src=src;            /* assigning src clears any previous error state */
    audio.load();
    audio.playbackRate=store.aspd||1;
    var pr=audio.play();
    if(pr&&pr.catch) pr.catch(function(){ if(tok===playToken) audioFailed(); });
  });
}
function audioFailed(msg){
  playing=false;
  setPlayIcon(false); markPlaying(0);
  showStatus(msg||"That recitation would not load","failed");
  $("audioNote").textContent=msg||"The recitation file did not load. Check the source in the download panel, or save this surah for offline use.";
}
audio.addEventListener("error",function(){
  /* ignore the error the element fires while its source is being swapped */
  if(!playing) return;
  if(!audio.currentSrc&&!audio.getAttribute("src")) return;
  audioFailed();
});
audio.addEventListener("ended",function(){
  if(!playing) return;
  if(playLeft>1){ playLeft--; audio.currentTime=0; audio.play(); return; }
  var last=loopTo?loopTo:SUR[curS-1].count;
  if(playA>=last){
    if(loopTo){
      rounds++; paintChip();
      if(loopLimitReached()){ finishLoop(); return; }
      playAyah(loopFrom,store.arep||1); return;
    }
    stopAudio(); return;
  }
  playAyah(playA+1,store.arep||1);
});
function stopAudio(){
  playing=false;
  try{ audio.pause(); }catch(e){}
  releaseBlob();
  setPlayIcon(false); markPlaying(0); hideStatus(); paintCounter();
}
$("playBtn").onclick=function(){
  if(playing){ stopAudio(); return; }
  var start=curA||(loopTo?loopFrom:(SEQ[pos]?SEQ[pos].a:1));
  playAyah(start,store.arep||1);
};
$("playOne").onclick=function(){ stopAudio(); playAyah(curA,1); };
$("playFrom").onclick=function(){ stopAudio(); playAyah(curA,store.arep||1); };

/* ---------- repetition counter ---------- */
function focusAyah(){
  if(playing&&playA) return playA;
  if(curA) return curA;
  if(SEQ[pos]) return SEQ[pos].a;
  return 1;
}
function paintCounter(){
  var a=focusAyah(), n=repsOf(curS,a), t=store.target||5;
  $("cnNow").textContent=n;
  $("cnTarget").textContent=t;
  $("cnLabel").textContent=curS+":"+a;
  $("cnFill").style.width=Math.min(100,t?(n/t*100):0)+"%";
  $("counter").classList.toggle("done",t>0&&n>=t);
}
(function(){
  var el=$("counter"), holdT=null, held=false;
  function startHold(){
    held=false;
    el.classList.add("holding");
    $("cnFill").style.width="100%";
    holdT=setTimeout(function(){
      held=true; el.classList.remove("holding");
      var a=focusAyah();
      setRec(curS,a,{rp:0});
      updateAyahRow(a); paintCounter();
      if(curA===a) paintReps();
    },700);
  }
  function endHold(){ clearTimeout(holdT); el.classList.remove("holding"); if(!held) paintCounter(); }
  el.addEventListener("pointerdown",function(e){ e.preventDefault(); startHold(); });
  el.addEventListener("pointerup",function(){
    endHold();
    if(held){ held=false; paintCounter(); return; }
    bump(focusAyah(),1); paintCounter();
  });
  el.addEventListener("pointercancel",endHold);
  el.addEventListener("pointerleave",endHold);
})();

/* ---------- downloads panel ---------- */
function dlPanel(on){
  if(on) closePanel();
  $("dlPanel").classList.toggle("show",on);
  document.body.classList.toggle("docked",on);
  if(innerWidth<1024) $("scrim").classList.toggle("show",on);
  if(on){ paintDownloads(); paintOfflineNote(); }
}
$("dlOpen").onclick=function(){ dlPanel(true); paintEngine(); };
if($("bannerFix")) $("bannerFix").onclick=resetApp;
if($("appReset")) $("appReset").onclick=function(){ this.textContent="Reloading…"; resetApp(); };
$("dlClose").onclick=function(){ dlPanel(false) };

fillReciters(); paintAudioBtns(); paintDownloads(); paintOfflineNote();

/* ---------- display menu ---------- */
$("dispBtn").onclick=function(e){
  e.stopPropagation();
  var m=$("dispMenu"), on=!m.classList.contains("show");
  m.classList.toggle("show",on);
  $("dispBtn").setAttribute("aria-expanded",on?"true":"false");
};
document.addEventListener("click",function(e){
  if(!e.target.closest(".menuwrap")) $("dispMenu").classList.remove("show");
});

/* ---------- navigation ---------- */
$("toIndex").onclick=function(){ drawer(true) };
$("toTools").onclick=function(){ openPanel(focusAyah()) };

/* swipe right anywhere in the mushaf goes back to the surah list */
(function(){
  var x0=0,y0=0,t0=0,live=false;
  document.addEventListener("touchstart",function(e){
    if(e.touches.length!==1){ live=false; return; }
    if(e.target.closest(".drawer,.panel,.dock,.seg,.mini,.step")){ live=false; return; }
    var t=e.touches[0]; x0=t.clientX; y0=t.clientY; t0=Date.now(); live=true;
  },{passive:true});
  document.addEventListener("touchend",function(e){
    if(!live) return; live=false;
    var t=e.changedTouches[0], dx=t.clientX-x0, dy=t.clientY-y0;
    if(Date.now()-t0>700) return;
    if(Math.abs(dx)<70||Math.abs(dx)<Math.abs(dy)*1.6) return;
    if(document.querySelector(".panel.show")) return;
    if(dx>0) drawer(true); else drawer(false);
  },{passive:true});
})();

paintLoopRounds(); paintCounter();

/* ---------- keys ---------- */
document.addEventListener("keydown",function(e){
  if(e.target.tagName==="INPUT") return;
  if(e.key==="Escape"){ if($("panel").classList.contains("show")) closePanel(); else drawer(false); }
  if(e.key==="m"&&!e.metaKey&&!e.ctrlKey){ $("micBtn").click(); }
  if(!curA) return;
  if(e.key==="["){ dFrom=curA; if(dTo<dFrom) dTo=dFrom; setLoop(dFrom,dTo); paintLoopBtn(); }
  if(e.key==="]"){ dTo=curA; if(dTo<dFrom) dFrom=dTo; setLoop(dFrom,dTo); paintLoopBtn(); }
  if(e.key==="ArrowDown"||e.key==="j"){e.preventDefault();$("nextAyah").click()}
  if(e.key==="ArrowUp"||e.key==="k"){e.preventDefault();$("prevAyah").click()}
  if(e.key===" "){e.preventDefault();if(e.target.tagName==="BUTTON")e.target.blur();bump(curA,1)}
});

/* ---------- boot ---------- */
paintSurah();
paintIndex();
if(store.loop&&store.loop.s===curS&&store.loop.t<=SUR[curS-1].count){
  loopFrom=store.loop.f; loopTo=store.loop.t; markLoop();
}
paintChip();
pos=(loopTo?AS[loopFrom]:AS[store.pos.a])||0;
if(store.pos&&store.pos.a>1){
  var b=$("ayat").querySelector('.ayah[data-a="'+store.pos.a+'"]');
  if(b) b.scrollIntoView({block:"center"});
}

/* ---------- offline shell ---------- */
if("serviceWorker" in navigator){
  window.addEventListener("load",function(){
    navigator.serviceWorker.register("sw.js").catch(function(){});
  });
}
})();
