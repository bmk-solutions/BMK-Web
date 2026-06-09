(function(){
"use strict";
var RM = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- DATA ---------- */
var CLIENTS = [
  {ab:'NWC', ar:'المياه الوطنية', en:'NWC'},
  {ab:'NHC', ar:'الإسكان NHC', en:'NHC'},
  {ab:'NK',  ar:'نُسك', en:'Nusuk'},
  {ab:'TB',  ar:'طيبة', en:'Taiba'},
  {ab:'SH',  ar:'شيراتون المدينة', en:'Sheraton Almadinah'},
  {ab:'RX',  ar:'ريكسوس جدة', en:'Rixos Jeddah'},
  {ab:'NV',  ar:'نوفوتيل', en:'Novotel'},
  {ab:'MS',  ar:'مسكان', en:'Miskan'},
  {ab:'MK',  ar:'مكّيون', en:'Makkiyoon'},
  {ab:'AZ',  ar:'الزاملية', en:'Alzamiliah'},
  {ab:'BO',  ar:'بن عميرة', en:'Bin Omairah'},
  {ab:'SD',  ar:'سدانة', en:'Sadana'},
  {ab:'OS',  ar:'أسس الإنشاء', en:'Osus Alinsha'},
  {ab:'SB',  ar:'شيربورن', en:'Sherborne'},
  {ab:'MA',  ar:'معارف', en:'Maarif'}
];
/* Drop official logos here (key by ab code) → replaces the monogram automatically */
var LOGOS = {
  NWC:"/assets/logos/NWC.png", NHC:"/assets/logos/NHC.png", NK:"/assets/logos/NK.png",
  TB:"/assets/logos/TB.png", SH:"/assets/logos/SH.svg", RX:"/assets/logos/RX.png", NV:"/assets/logos/NV.svg",
  AZ:"/assets/logos/AZ.png", OS:"/assets/logos/OS.png", MS:"/assets/logos/MS.svg", SD:"/assets/logos/SD.png",
  MK:"/assets/logos/MK.png", BO:"/assets/logos/BO.png", SB:"/assets/logos/SB.png", MA:"/assets/logos/MA.png"
};
/* logos that are white-on-transparent → render as a clean black silhouette on the white chip */
var LIGHTLOGO = {MS:1, SD:1};

var REPORTS = [
  {projAr:'منتجع ساحلي', projEn:'Coastal Resort', elemAr:'الهيكل الخرساني', elemEn:'Concrete structure',
   ar:'صبّ السقف للطابق السابع مكتمل ومطابق للمخطط. رُصد تأخّر طفيف في أعمال الحديد بالمحور C — مُوصى بمعالجته قبل الصبّ القادم.',
   en:'Slab pour for level 7 complete and matches plan. Minor rebar lag detected on grid C — recommend clearing before next pour.', pct:62},
  {projAr:'برج مكتبي', projEn:'Office Tower', elemAr:'الواجهة الزجاجية', elemEn:'Glass facade',
   ar:'تركيب وحدات الكلادينج يسير ضمن الجدول. اكتُشف لوحان غير محاذيين في الواجهة الشمالية — تم وسمهما للمراجعة.',
   en:'Cladding unit installation on schedule. Two misaligned panels found on the north elevation — tagged for review.', pct:48},
  {projAr:'مجمع ضيافة', projEn:'Hospitality Complex', elemAr:'الأعمال الترابية', elemEn:'Earthworks',
   ar:'الحفر والردم مكتمل بنسبة 90%. حجم الكمية يطابق المساحة المحسوبة من القياس التصويري ضمن هامش 2%.',
   en:'Cut & fill 90% complete. Measured volume matches photogrammetry quantity within a 2% margin.', pct:90},
  {projAr:'مشروع سكني', projEn:'Residential Project', elemAr:'البنية التحتية', elemEn:'Infrastructure',
   ar:'شبكات الخدمات تحت الأرض مكتملة في القطاع الشرقي. مسار الوصول مطابق لخطة الموقع المعتمدة.',
   en:'Underground utilities complete in the east sector. Access route matches the approved site logistics plan.', pct:35}
];

var FAQS = [
  {qAr:'هل أنتم شركة تصوير بالدرون؟', qEn:'Are you a drone photography company?',
   aAr:'لا. التصوير مُدخَل وليس المنتج. BMK تبني طبقة معلومات تربط ما تراه الكاميرا بنِسب الإنجاز والجدول والتكلفة داخل منصّة خاصّة بك — هذا ما يميّزنا.',
   aEn:'No. Capture is an input, not the product. BMK builds an information layer that binds what the camera sees to progress %, schedule and cost inside a portal that is yours — that is our differentiator.'},
  {qAr:'ما الذي تقدّمه تقارير الذكاء الاصطناعي؟', qEn:'What do the AI reports actually do?',
   aAr:'يفحص نموذجنا كل صورة ويرصد التقدّم والمخاطر والانحرافات عن المخطط، ثم يربطها تلقائياً بنِسب Primavera والبيانات المالية — لتقرأ موقعك كتقرير لا كمعرض صور.',
   aEn:'Our model inspects each image, flags progress, risks and deviations from plan, then automatically links them to Primavera % and financials — so you read your site as a report, not a photo gallery.'},
  {qAr:'هل العمليات الجوية مرخّصة؟', qEn:'Are aerial operations licensed?',
   aAr:'نعم. تُدار العمليات على يد طيّار درون مرخّص من الهيئة العامة للطيران المدني (GACA)، وفق متطلبات السلامة والتصاريح المعتمدة.',
   aEn:'Yes. Operations are run by a GACA-licensed drone pilot, in line with approved safety and permit requirements.'},
  {qAr:'ما القطاعات التي تخدمونها؟', qEn:'Which sectors do you serve?',
   aAr:'نركّز حصرياً على الإنشاء والعقار — من المشاريع الحكومية والبنية التحتية إلى الضيافة والتطوير العقاري في أنحاء المملكة.',
   aEn:'We focus exclusively on construction and real estate — from government and infrastructure projects to hospitality and real-estate development across the Kingdom.'},
  {qAr:'كيف نبدأ؟', qEn:'How do we start?',
   aAr:'راسلنا عبر واتساب أو البريد بنبذة عن مشروعك. نحدّد الطبقات المناسبة والباقة، ثم نُطلق منصّتك الخاصّة ونجدول أول زيارة.',
   aEn:'Message us on WhatsApp or email with a brief on your project. We scope the right layers and package, then launch your private portal and schedule the first visit.'}
];

/* ---------- BUILD: marquee ---------- */
(function(){ var mq = document.getElementById('mqTrack'); if(!mq) return;
  var s = '<span>' + CLIENTS.map(function(c){return c.en;}).join('</span><span>') + '</span>';
  mq.innerHTML = s + s;
})();

/* ---------- BUILD: clients logo bar (animated marquee) ---------- */
(function(){
  var t1 = document.getElementById('lt1');
  if(!t1) return;
  function item(c){
    var logo = LOGOS[c.ab];
    var inner = logo
      ? '<img src="'+logo+'" alt="'+c.en+'" decoding="async">'
      : '<span class="lmono">'+c.ab+'</span>';
    return '<div class="litem" title="'+c.en+'">'+inner+'</div>';
  }
  var a = CLIENTS.map(item).join('');
  t1.innerHTML = a + a;   // exact duplicate → translateX -50% loops seamlessly (last → first)
})();

/* ---------- BUILD: deliverables ---------- */
(function(){
  var el = document.getElementById('delivList'); if(!el) return;
  var D = [
    ['منصّة رقمية خاصّة بالعميل','Private client platform'],['دومين خاص للمشروع أو العميل','Custom project/client domain'],
    ['خريطة تفاعلية للمشاريع','Interactive projects map'],['لوحة مشاريع ونِسب إنجاز','Projects & progress dashboard'],
    ['أرشيف زيارات توثيقية','Documentation-visit archive'],['صور درون','Drone photos'],['فيديوهات درون','Drone videos'],
    ['صور 360°','360° photos'],['جولات 360°','360° tours'],['تصوير أرضي احترافي','Professional ground photography'],
    ['فيديو مونتاج للزيارة','Visit montage video'],['صور قبل/بعد','Before / after images'],['تقارير المهندس','Engineer reports'],
    ['تقارير PDF احترافية','Professional PDF reports'],['تقارير مرتبطة بالمخططات','Plan-linked reports'],
    ['تقارير مرتبطة بـ Primavera','Primavera-linked reports'],['تقارير للإدارة والمستثمرين','Management & investor reports'],
    ['فيديوهات تسويقية قبل الإنشاء','Pre-construction marketing films'],['فيديوهات أثناء الإنشاء','During-construction films'],
    ['فيديوهات بعد الإنشاء','Post-construction films'],['فيديوهات 3D بالكامل','Full 3D films'],
    ['مجسمات 3D تفاعلية','Interactive 3D models'],['منصّات عرض وحدات','Unit-showcase platforms'],
    ['ربط Units Inventory','Units Inventory linkage'],['ربط CRM','CRM linkage'],['جولات افتراضية للوحدات','Per-unit virtual tours'],
    ['منصّة الزيارات الافتراضية','Virtual-visits platform'],['تسجيلات الزيارات','Visit recordings'],
    ['ملخّصات الزيارات','Visit summaries'],['تقارير ملاحظات العملاء','Customer-notes reports']
  ];
  var chk = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M5 12l5 5L20 7"/></svg>';
  el.innerHTML = D.map(function(d){
    return '<div class="dv">'+chk+'<b data-en="'+d[1].replace(/"/g,'&quot;')+'">'+d[0]+'</b></div>';
  }).join('');
})();

/* ---------- BUILD: FAQ ---------- */
(function(){
  var l = document.getElementById('faqList'), s = ''; if(!l) return;
  FAQS.forEach(function(f){
    s += '<div class="faq-item"><button class="faq-q"><span data-en="'+f.qEn.replace(/"/g,'&quot;')+'">'+f.qAr+'</span><i class="pm"></i></button>'
       + '<div class="faq-a"><p data-en="'+f.aEn.replace(/"/g,'&quot;')+'">'+f.aAr+'</p></div></div>';
  });
  l.innerHTML = s;
  l.querySelectorAll('.faq-q').forEach(function(q){
    q.addEventListener('click', function(){
      var it = q.parentElement, a = it.querySelector('.faq-a'), open = it.classList.contains('on');
      l.querySelectorAll('.faq-item').forEach(function(x){x.classList.remove('on');x.querySelector('.faq-a').style.maxHeight=null;});
      if(!open){it.classList.add('on'); a.style.maxHeight = a.scrollHeight + 'px';}
    });
  });
})();

/* ---------- LANGUAGE TOGGLE ---------- */
var L = 'ar';
function applyLang(){
  var html = document.documentElement;
  html.setAttribute('lang', L);
  html.setAttribute('dir', L === 'ar' ? 'rtl' : 'ltr');
  document.getElementById('langBtn').textContent = L === 'ar' ? 'EN' : 'ع';
  document.querySelectorAll('[data-en]').forEach(function(el){
    if(!el.hasAttribute('data-ar')){
      // capture the first meaningful text node / or innerHTML for <br> cases
      el.setAttribute('data-ar', el.innerHTML);
    }
    el.innerHTML = (L === 'en') ? el.getAttribute('data-en') : el.getAttribute('data-ar');
  });
  // re-measure any open FAQ
  document.querySelectorAll('.faq-item.on .faq-a').forEach(function(a){a.style.maxHeight = a.scrollHeight + 'px';});
}
document.getElementById('langBtn').addEventListener('click', function(){
  L = (L === 'ar') ? 'en' : 'ar';
  try{localStorage.setItem('bmk_lang', L);}catch(e){}
  applyLang();
});
try{ var sl = localStorage.getItem('bmk_lang'); if(sl){ L = sl; } }catch(e){}
applyLang();

/* ---------- THEME TOGGLE ---------- */
function applyTheme(t){ document.documentElement.setAttribute('data-theme', t); try{localStorage.setItem('bmk_theme', t);}catch(e){} }
document.getElementById('themeBtn').addEventListener('click', function(){
  var cur = document.documentElement.getAttribute('data-theme');
  applyTheme(cur === 'dark' ? 'light' : 'dark');
});
try{ var st = localStorage.getItem('bmk_theme'); if(st){ applyTheme(st); } }catch(e){}

/* ---------- PRELOADER (full once per session, then instant) ---------- */
(function(){
  var pre = document.getElementById('pre'), bar = document.getElementById('preBar'), pct = document.getElementById('prePct');
  if(!pre){ startCounters(); return; }
  var seen = false; try{ seen = sessionStorage.getItem('bmk_seen') === '1'; }catch(e){}
  if(seen){ pre.classList.add('done'); startCounters(); return; }
  try{ sessionStorage.setItem('bmk_seen','1'); }catch(e){}
  var n = 0;
  var t = setInterval(function(){
    n += Math.max(1, Math.round((100 - n) * 0.12));
    if(n >= 100){ n = 100; clearInterval(t); setTimeout(function(){ pre.classList.add('done'); startCounters(); }, 280); }
    bar.style.width = n + '%'; pct.textContent = n;
  }, 55);
  setTimeout(function(){ if(!pre.classList.contains('done')){ pre.classList.add('done'); startCounters(); } }, 3500);
})();

/* ---------- HEADER scroll state ---------- */
var hdr = document.getElementById('hdr');
addEventListener('scroll', function(){
  hdr.classList.toggle('scrolled', scrollY > 30);
  document.getElementById('totop').classList.toggle('on', scrollY > 700);
}, {passive:true});

/* ---------- MOBILE NAV ---------- */
var burger = document.getElementById('burger'), mobnav = document.getElementById('mobnav');
burger.addEventListener('click', function(){
  var on = burger.classList.toggle('on'); mobnav.classList.toggle('on', on);
  document.body.style.overflow = on ? 'hidden' : '';
});
mobnav.querySelectorAll('a').forEach(function(a){
  a.addEventListener('click', function(){ burger.classList.remove('on'); mobnav.classList.remove('on'); document.body.style.overflow=''; });
});

/* ---------- REVEAL on scroll ---------- */
(function(){
  var io = new IntersectionObserver(function(es){
    es.forEach(function(e){ if(e.isIntersecting){ e.target.classList.add('in'); io.unobserve(e.target); } });
  }, {rootMargin:'0px 0px -8% 0px', threshold:0.08});
  document.querySelectorAll('.r').forEach(function(el){ io.observe(el); });
})();

/* ---------- NAV: active page (clean routes) ---------- */
(function(){
  var cur = location.pathname.replace(/index\.html$/,'').replace(/\/+$/,'') || '/';
  document.querySelectorAll('.navlinks a, #mobnav a').forEach(function(a){
    var href = (a.getAttribute('href') || '').replace(/\/+$/,'') || '/';
    if(href === cur) a.classList.add('active');
  });
})();

/* ---------- SIX SERVICES ACCORDION ---------- */
(function(){
  var items = [].slice.call(document.querySelectorAll('#svc6 .s6'));
  if(!items.length) return;
  function setH(it){ var b = it.querySelector('.s6-body'); b.style.maxHeight = it.classList.contains('on') ? (b.scrollHeight + 'px') : null; }
  items.forEach(function(it){
    it.querySelector('.s6-head').addEventListener('click', function(){
      var open = it.classList.contains('on');
      items.forEach(function(x){ x.classList.remove('on'); x.querySelector('.s6-body').style.maxHeight = null; });
      if(!open){ it.classList.add('on'); setH(it); }
    });
  });
  var first = document.querySelector('#svc6 .s6.on'); if(first) setH(first);
  function remeasure(){ var op = document.querySelector('#svc6 .s6.on'); if(op) setH(op); }
  addEventListener('resize', remeasure);
  var lb = document.getElementById('langBtn'); if(lb) lb.addEventListener('click', function(){ setTimeout(remeasure, 40); });
})();

/* ---------- AI REPORTS CAROUSEL ---------- */
(function(){
  var i = 0, typeTimer = null;
  var elText = document.getElementById('rText'), elProj = document.getElementById('rProj'),
      elElem = document.getElementById('rElem'), elNum = document.getElementById('rNum'),
      elBar = document.getElementById('rBar'), elPctL = document.getElementById('rPctL'),
      dots = document.getElementById('rDots');
  if(!elText || !dots) return;
  REPORTS.forEach(function(_,k){ var d=document.createElement('i'); d.addEventListener('click',function(){i=k;render();}); dots.appendChild(d); });
  function render(){
    var r = REPORTS[i], en = (L === 'en');
    elProj.textContent = en ? r.projEn : r.projAr;
    elElem.textContent = en ? r.elemEn : r.elemAr;
    elNum.textContent = String(i+1).padStart(2,'0') + ' / ' + String(REPORTS.length).padStart(2,'0');
    elPctL.textContent = r.pct + '%';
    elBar.style.width = '0%'; setTimeout(function(){ elBar.style.width = r.pct + '%'; }, 60);
    dots.querySelectorAll('i').forEach(function(d,k){ d.classList.toggle('on', k===i); });
    // typewriter
    var full = en ? r.en : r.ar;
    clearInterval(typeTimer); elText.innerHTML = '';
    if(RM){ elText.textContent = full; return; }
    var j = 0;
    typeTimer = setInterval(function(){
      j++; elText.innerHTML = full.slice(0,j) + '<span class="cur">▋</span>';
      if(j >= full.length){ clearInterval(typeTimer); elText.innerHTML = full; }
    }, 16);
  }
  document.getElementById('rNext').addEventListener('click', function(){ i=(i+1)%REPORTS.length; render(); });
  document.getElementById('rPrev').addEventListener('click', function(){ i=(i-1+REPORTS.length)%REPORTS.length; render(); });
  // re-render on language change
  document.getElementById('langBtn').addEventListener('click', function(){ setTimeout(render, 10); });
  var seen = false;
  new IntersectionObserver(function(es){
    es.forEach(function(e){ if(e.isIntersecting && !seen){ seen = true; render();
      if(!RM){ setInterval(function(){ i=(i+1)%REPORTS.length; render(); }, 6500); } } });
  }, {threshold:0.3}).observe(document.getElementById('reports'));
})();

/* ---------- COUNTERS ---------- */
var countersStarted = false;
function startCounters(){
  if(countersStarted) return; countersStarted = true;
  document.querySelectorAll('[data-count]').forEach(function(el){
    var io = new IntersectionObserver(function(es){
      es.forEach(function(e){
        if(e.isIntersecting){
          var target = +el.getAttribute('data-count'), suf = el.getAttribute('data-suf') || '', n = 0;
          var step = Math.max(1, target/40);
          var t = setInterval(function(){
            n += step; if(n >= target){ n = target; clearInterval(t); }
            el.textContent = Math.round(n) + suf;
          }, 28);
          io.unobserve(el);
        }
      });
    }, {threshold:0.5});
    io.observe(el);
  });
}

/* ---------- WORK lightbox (simple) ---------- */
document.querySelectorAll('.work').forEach(function(w){
  w.addEventListener('click', function(){
    var src = w.getAttribute('data-img'); if(!src) return;
    var ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:9998;background:rgba(5,7,11,.92);display:grid;place-items:center;padding:30px;cursor:zoom-out;opacity:0;transition:opacity .3s';
    ov.innerHTML = '<img src="'+src+'" style="max-width:94vw;max-height:90vh;border-radius:12px;border:1px solid rgba(255,255,255,.12);box-shadow:0 30px 80px -20px #000">';
    document.body.appendChild(ov); requestAnimationFrame(function(){ ov.style.opacity='1'; });
    ov.addEventListener('click', function(){ ov.style.opacity='0'; setTimeout(function(){ov.remove();}, 300); });
  });
});

/* ---------- PACKAGE request ---------- */
window.pkgReq = function(name){
  var msg = encodeURIComponent('مرحباً BMK، أرغب في طلب الباقة ' + name + ' لمشروعي.');
  window.open('https://wa.me/966568279558?text=' + msg, '_blank');
};

/* ---------- YEAR ---------- */
document.getElementById('yr').textContent = new Date().getFullYear();

})();

/* ========= INTERACTIVE / PREMIUM MOTION LAYER ========= */
(function(){
"use strict";
var RM   = matchMedia('(prefers-reduced-motion: reduce)').matches;
var FINE = matchMedia('(hover:hover) and (pointer:fine)').matches;
var root = document.documentElement;
var W = innerWidth, H = innerHeight;
var mx = W/2, my = H/2;

/* ---- pointer + spotlight ---- */
addEventListener('pointermove', function(e){
  mx = e.clientX; my = e.clientY;
  root.style.setProperty('--mx', mx + 'px');
  root.style.setProperty('--my', my + 'px');
}, {passive:true});

/* ---- scroll progress ---- */
var spI = document.querySelector('#sprog i');
function onScroll(){
  var h = document.documentElement.scrollHeight - innerHeight;
  if(spI) spI.style.width = (h > 0 ? (scrollY / h * 100) : 0) + '%';
}
addEventListener('scroll', onScroll, {passive:true}); onScroll();

/* ---- interactive constellation behind content ---- */
(function(){
  var cv = document.getElementById('bgfx'); if(!cv || RM) return;
  var ctx = cv.getContext('2d'), DPR = Math.min(devicePixelRatio || 1, 1.6);
  var pts = [], N = 0, maxD = 0, cw = 0, ch = 0, mX = -9999, mY = -9999, run = true;
  function resize(){
    W = innerWidth; H = innerHeight;
    cw = cv.width = Math.floor(W * DPR); ch = cv.height = Math.floor(H * DPR);
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    N = Math.max(24, Math.min(FINE ? 88 : 38, Math.floor(W * H / 16000)));
    maxD = (FINE ? 150 : 118) * DPR;
    pts = [];
    for(var i=0;i<N;i++) pts.push({
      x: Math.random()*cw, y: Math.random()*ch,
      vx: (Math.random()-.5)*0.28*DPR, vy: (Math.random()-.5)*0.28*DPR
    });
  }
  resize(); addEventListener('resize', resize);
  addEventListener('pointermove', function(e){ mX = e.clientX*DPR; mY = e.clientY*DPR; }, {passive:true});
  document.addEventListener('visibilitychange', function(){ run = !document.hidden; if(run) tick(); });
  var A = '200,168,92', mR = 190*DPR;
  function tick(){
    if(!run) return;
    ctx.clearRect(0,0,cw,ch);
    for(var i=0;i<N;i++){
      var p = pts[i];
      p.x += p.vx; p.y += p.vy;
      if(p.x < 0 || p.x > cw) p.vx *= -1;
      if(p.y < 0 || p.y > ch) p.vy *= -1;
      ctx.beginPath(); ctx.arc(p.x, p.y, 1.25*DPR, 0, 6.2832);
      ctx.fillStyle = 'rgba('+A+',.55)'; ctx.fill();
      for(var j=i+1;j<N;j++){
        var q = pts[j], dx = p.x-q.x, dy = p.y-q.y, d = Math.sqrt(dx*dx+dy*dy);
        if(d < maxD){
          ctx.beginPath(); ctx.moveTo(p.x,p.y); ctx.lineTo(q.x,q.y);
          ctx.strokeStyle = 'rgba('+A+','+(0.15*(1-d/maxD))+')'; ctx.lineWidth = DPR; ctx.stroke();
        }
      }
      var ddx = p.x-mX, ddy = p.y-mY, dm = Math.sqrt(ddx*ddx+ddy*ddy);
      if(dm < mR){
        ctx.beginPath(); ctx.moveTo(p.x,p.y); ctx.lineTo(mX,mY);
        ctx.strokeStyle = 'rgba('+A+','+(0.28*(1-dm/mR))+')'; ctx.lineWidth = DPR; ctx.stroke();
      }
    }
    requestAnimationFrame(tick);
  }
  tick();
})();

/* ---- everything below is fine-pointer + motion only ---- */
if(FINE && !RM){
  /* custom cursor */
  var ring = document.getElementById('curRing'), dot = document.getElementById('curDot');
  var rx = mx, ry = my, started = false;
  function cloop(){
    rx += (mx - rx) * 0.2; ry += (my - ry) * 0.2;
    ring.style.transform = 'translate('+rx+'px,'+ry+'px) translate(-50%,-50%)';
    dot.style.transform  = 'translate('+mx+'px,'+my+'px) translate(-50%,-50%)';
    requestAnimationFrame(cloop);
  }
  requestAnimationFrame(cloop);
  addEventListener('pointermove', function(){
    if(!started){ started = true; ring.classList.add('live'); dot.classList.add('live'); document.body.classList.add('has-cursor'); }
  }, {passive:true});
  var HOV = 'a,button,.work,.pkg,.faq-q,.svc-tab,.cw,.demo-btn,[role="button"]';
  addEventListener('pointerover', function(e){ if(e.target.closest && e.target.closest(HOV)) ring.classList.add('hov'); });
  addEventListener('pointerout', function(e){
    if(e.target.closest && e.target.closest(HOV)){
      var to = e.relatedTarget;
      if(!(to && to.closest && to.closest(HOV))) ring.classList.remove('hov');
    }
  });
  addEventListener('pointerdown', function(){ ring.classList.add('down'); });
  addEventListener('pointerup', function(){ ring.classList.remove('down'); });
  addEventListener('mouseleave', function(){ ring.classList.remove('live'); dot.classList.remove('live'); });
  addEventListener('mouseenter', function(){ if(started){ ring.classList.add('live'); dot.classList.add('live'); } });

  /* magnetic buttons */
  document.querySelectorAll('.cta-btn,.btn-ghost,.demo-btn,.icbtn,#wafloat,#totop').forEach(function(el){
    el.addEventListener('pointermove', function(e){
      var r = el.getBoundingClientRect();
      var dx = e.clientX - (r.left + r.width/2), dy = e.clientY - (r.top + r.height/2);
      el.style.transform = 'translate('+(dx*0.28)+'px,'+(dy*0.4)+'px)';
    });
    el.addEventListener('pointerleave', function(){ el.style.transform = ''; });
  });

  /* 3D tilt on media + work cards */
  document.querySelectorAll('.work,.about-media,.plat-media,.rep-media,.svc-panel').forEach(function(el){
    el.addEventListener('pointermove', function(e){
      var r = el.getBoundingClientRect();
      var px = (e.clientX - r.left) / r.width - .5, py = (e.clientY - r.top) / r.height - .5;
      var amt = el.classList.contains('work') ? 7 : 4;
      el.style.transform = 'perspective(900px) rotateY('+(px*amt)+'deg) rotateX('+(-py*amt)+'deg)';
    });
    el.addEventListener('pointerleave', function(){ el.style.transform = ''; });
  });

  /* hero parallax */
  var hero = document.getElementById('hero');
  if(hero){
    var hbg = hero.querySelector('.hero-bg'), hglow = hero.querySelector('.hero-glow');
    hero.addEventListener('pointermove', function(e){
      var px = e.clientX/innerWidth - .5, py = e.clientY/innerHeight - .5;
      if(hbg)  hbg.style.transform  = 'translate('+(px*-20)+'px,'+(py*-14)+'px) scale(1.07)';
      if(hglow) hglow.style.transform = 'translateX(-50%) translate('+(px*34)+'px,'+(py*22)+'px)';
    });
    hero.addEventListener('pointerleave', function(){ if(hbg) hbg.style.transform = ''; if(hglow) hglow.style.transform = 'translateX(-50%)'; });
  }
}
})();

/* ========= SCROLL-DRIVEN VIDEO SHOWREEL ========= */
(function(){
"use strict";
var RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
var sec = document.getElementById('reel'); if(!sec) return;
var frame = sec.querySelector('.reel-frame');
var cap = sec.querySelector('.reel-cap');
var vid = document.getElementById('reelVid');
var fb  = sec.querySelector('.reel-fallback');
function clamp(v,a,b){ return Math.max(a, Math.min(b, v)); }

/* if the video file is missing/cannot play, show the poster image instead */
if(vid){
  vid.addEventListener('error', showFallback, true);
  var src = vid.querySelector('source');
  if(src) src.addEventListener('error', showFallback);
  // play / pause only while in view
  var io = new IntersectionObserver(function(es){
    es.forEach(function(e){
      if(e.isIntersecting){ var p = vid.play(); if(p && p.catch) p.catch(function(){}); }
      else { vid.pause(); }
    });
  }, {threshold:0.12});
  io.observe(sec);
}
function showFallback(){ if(fb){ fb.style.display='block'; } if(vid){ vid.style.display='none'; } }

/* scroll-driven expand + caption parallax */
if(RM){
  frame.style.clipPath = 'inset(0 round 0)';
  frame.style.transform = 'none';
  if(cap){ cap.style.opacity = 1; cap.style.transform = 'none'; }
} else {
  function onScroll(){
    var r = sec.getBoundingClientRect();
    var range = sec.offsetHeight - innerHeight;
    var prog = range > 0 ? clamp(-r.top / range, 0, 1) : 0;
    var e = clamp(prog / 0.62, 0, 1);            // expand over first 62% of travel
    var iy = (1 - e) * 11, ix = (1 - e) * 7, rad = (1 - e) * 26, sc = 0.9 + e * 0.1;
    frame.style.clipPath = 'inset(' + iy + '% ' + ix + '% round ' + rad + 'px)';
    frame.style.transform = 'scale(' + sc + ')';
    if(cap){
      cap.style.opacity = clamp((e - 0.22) / 0.5, 0, 1);
      cap.style.transform = 'translateY(' + ((1 - e) * 42) + 'px)';
    }
  }
  addEventListener('scroll', onScroll, {passive:true});
  addEventListener('resize', onScroll);
  onScroll();
}
})();
/* ---------- CONTACT FORM -> WhatsApp ---------- */
window.bmkContact = function(form){
  try{
    var f = function(n){ var el = form.elements[n]; return el ? el.value.trim() : ''; };
    var lines = [
      'New project inquiry — BMK Solutions',
      'Name: ' + f('name'),
      'Company: ' + f('company'),
      'Project type: ' + f('ptype'),
      'Message: ' + f('message')
    ];
    var url = 'https://wa.me/966568279558?text=' + encodeURIComponent(lines.join('\n'));
    window.open(url, '_blank');
  }catch(e){}
  return false;
};
