import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import vm from 'node:vm';
import sharp from 'sharp';
import {engineState,onlinePlanProvider,planPanelStatusText,planProviderOf,planWorkerLabel,PHOTOS_WORKER_ID,PLANS_WORKER_ID} from '../src/lib/imo3d/worker-presence';
import {parseProcessingJob,photosEngineNotice,type ProcessingJob} from '../src/lib/imo3d/processing-model';
import {publicTourPayload,sceneDisplayDepth} from '../src/lib/imo3d/public-tour';
import {supportedDisplayDepth} from '../src/lib/imo3d/display-depth';
import {planImageVariant,planImageVariantOf,shareImageFromPanorama} from '../src/lib/imo3d/image-variants';
import {NEUTRAL_TOUR_ICON,shareCard,tourShareTitle} from '../src/lib/imo3d/share-card';
import {nextThemeChoice,resolveTheme,themeChoice,THEME_BOOT_SCRIPT,THEME_KEY} from '../src/lib/imo3d/theme';
import {studioLink} from '../src/lib/imo3d/viewer-chrome';
import {architectureLayers,defaultPlanView} from '../src/lib/imo3d/architecture-visibility';
import {LINK_PREVIEW_BOTS,imo3dConfig} from '../next.config';
import {HTML_LIMITED_BOT_UA_RE} from 'next/dist/shared/lib/router/utils/html-bots';
import {createViewerPlanCache} from '../src/components/imo3d/viewer-plan-cache';
import {syntheticTour} from './fixtures/imo3d-synthetic-tour';
import type {DisplayDepth,Plan} from '../src/lib/imo3d/model';

const source=(file:string)=>readFileSync(file,'utf8');
const now=Date.parse('2026-09-25T10:00:00Z'),ago=(ms:number)=>new Date(now-ms).toISOString();

test('TOUR-G10: the plans worker is labelled by the provider it reports, never assumed to be Gemini',()=>{
 const rows=[{id:PLANS_WORKER_ID,seen_at:ago(5_000)},{id:'subscription:codex',seen_at:ago(6_000)},{id:'subscription:gemini-local',seen_at:ago(3_600_000)}];
 assert.equal(onlinePlanProvider(rows,now),'codex');
 assert.equal(planWorkerLabel('codex',true),'عامل Codex على جهازك متصل.');
 assert.equal(planWorkerLabel('gemini-local',true),'عامل Gemini على جهازك متصل.');
 // A worker built before it named its provider is not called Gemini.
 assert.equal(onlinePlanProvider([{id:PLANS_WORKER_ID,seen_at:ago(5_000)}],now),null);
 assert.equal(planWorkerLabel(null,true),'عامل المخططات على جهازك متصل.');
 assert.match(planWorkerLabel(null,false),/غير متصل/);
 assert.equal(onlinePlanProvider([{id:PLANS_WORKER_ID,seen_at:ago(200_000)},{id:'subscription:codex',seen_at:ago(1_000)}],now),null);
 // A provider row left by an earlier build (rollback, or a switch from Codex to Gemini) goes stale and names nobody.
 assert.equal(onlinePlanProvider([{id:PLANS_WORKER_ID,seen_at:ago(5_000)},{id:'subscription:codex',seen_at:ago(91_000)}],now),null);
 assert.equal(onlinePlanProvider([{id:PLANS_WORKER_ID,seen_at:ago(5_000)},{id:'subscription:codex',seen_at:ago(3_600_000)},{id:'subscription:gemini-local',seen_at:ago(4_000)}],now),'gemini-local');
 assert.equal(planProviderOf('gemini'),'gemini-local');assert.equal(planProviderOf('codex'),'codex');assert.equal(planProviderOf('other'),null);
 const panel=source('src/components/imo3d/AIPlanPanel.tsx');
 assert.doesNotMatch(panel,/عامل Gemini متصل/);
 // The panel prints what the status says, through one function (below); it names no provider itself.
 assert.match(panel,/\{status&&<p role="status">\{planPanelStatusText\(status\)\}<\/p>\}/);assert.doesNotMatch(panel,/planWorkerLabel|'gemini-local'|'codex'/);
 assert.doesNotMatch(source('src/lib/imo3d/cloud/subscription-plans.ts'),/provider:'gemini-local'/);
});

test('TOUR-G10: the plans worker heartbeat writes its provider beside its presence row',()=>{
 const worker=source('src/lib/imo3d/subscription-plan-worker.ts');
 assert.match(worker,/export async function ping\(provider\?:PlanProviderName\)\{await touchWorker\(PLANS_WORKER_ID\);if\(provider\)await touchWorker\(planProviderWorkerId\(provider\)\);\}/);
 assert.match(worker,/providerName=planProviderOf\(provider\?\.id\?\?'codex'\)\?\?'codex',beat=\(\)=>ping\(providerName\)/);
 assert.equal((worker.match(/beat\(\)/g)??[]).length>=2,true);
});

test('G-PHOTOENGINE-OFFLINE: a queued upload says so in Arabic when the photos engine is down',()=>{
 const job:ProcessingJob={id:'j',tourId:'t',status:'queued',progress:0,stage:'في انتظار المعالجة',createdAt:ago(120_000),updatedAt:ago(120_000),error:null,warnings:[],photosEngine:'offline'};
 assert.equal(photosEngineNotice(job,now),'محرك الصور على جهازك غير متصل — شغّل الجهاز أو سجّل الدخول عليه. الصور المرفوعة محفوظة وتبدأ معالجتها تلقائيًا عند اتصاله.');
 assert.equal(photosEngineNotice({...job,createdAt:ago(30_000),updatedAt:ago(30_000)},now),null,'the engine gets 90 s to claim it');
 assert.equal(photosEngineNotice({...job,createdAt:ago(600_000),updatedAt:ago(30_000)},now),null,'a re-queued job counts from its last change');
 assert.equal(photosEngineNotice({...job,photosEngine:'online'},now),null);
 assert.equal(photosEngineNotice({...job,photosEngine:'unknown'},now),null,'an engine that never reported is not declared down');
 assert.equal(photosEngineNotice({...job,status:'running'},now),null);
 assert.equal(parseProcessingJob(job)?.photosEngine,'offline');
 assert.equal(engineState([{id:PHOTOS_WORKER_ID,seen_at:ago(10_000)}],PHOTOS_WORKER_ID,now),'online');
 assert.equal(engineState([{id:PHOTOS_WORKER_ID,seen_at:ago(91_000)}],PHOTOS_WORKER_ID,now),'offline');
 assert.equal(engineState([],PHOTOS_WORKER_ID,now),'unknown');
 assert.match(source('src/components/imo3d/Studio.tsx'),/\{photosEngineNotice\(job\)&&<p className="imo-inline-alert" role="alert">\{photosEngineNotice\(job\)\}<\/p>\}/);
});

const depth=(fill=3):DisplayDepth=>({width:32,height:16,values:Array.from({length:512},(_,i)=>i<64?0:fill+i/1e5),confidence:.6,coverage:.875,source:'monocular-multiview-floor-aligned',units:'camera_height',purpose:'display_only'});
test('TOUR-G6: a buyer arrival carries no display depth; each scene serves its own on demand',()=>{
 const tour=syntheticTour();tour.published=true;tour.scenes=tour.scenes.map((scene,index)=>index<4?{...scene,displayDepth:depth()}:scene);
 const buyer=publicTourPayload(tour,{presentation:true,deferDepth:true});
 assert.ok(buyer.scenes.every(scene=>!('displayDepth' in scene)));
 assert.deepEqual(buyer.deferredDepth,tour.scenes.slice(0,4).map(scene=>scene.id));
 assert.ok(JSON.stringify(buyer).length*4<JSON.stringify(tour).length,'the arrival payload loses the depth bytes');
 const admin=publicTourPayload(tour,{presentation:false,deferDepth:false});
 assert.deepEqual(admin.scenes[0].displayDepth,tour.scenes[0].displayDepth);assert.equal(admin.deferredDepth,undefined);
 const served=sceneDisplayDepth(tour,tour.scenes[1].id)!;
 assert.ok(supportedDisplayDepth(served),'the compacted depth still passes the renderer gate');
 assert.equal(served.values.filter(v=>v>0).length,tour.scenes[1].displayDepth!.values.filter(v=>v>0).length);
 assert.ok(JSON.stringify(served).length<JSON.stringify(tour.scenes[1].displayDepth).length);
 assert.equal(sceneDisplayDepth(tour,tour.scenes[5].id),null);assert.equal(sceneDisplayDepth(tour,'missing'),null);
 // Coverage counts non-zero values: a value that rounds to 0.0000 must still arrive as a (smallest) depth.
 const faint=depth();faint.values=faint.values.map((v,i)=>i===100?0.00004:i===101?0.00016:v);tour.scenes[2]={...tour.scenes[2],displayDepth:faint};
 const kept=sceneDisplayDepth(tour,tour.scenes[2].id)!;assert.equal(kept.values[100],1e-4);assert.equal(kept.values[101],2e-4);assert.equal(kept.values[0],0);
 assert.equal(kept.values.filter(v=>v>0).length,faint.values.filter(v=>v>0).length);
});

test('TOUR-G6: the viewer asks for depth per scene and the engine never waits for it on the first view',()=>{
 const viewer=source('src/components/imo3d/TourViewer.tsx'),engine=source('src/components/imo3d/PanoramaEngine.ts');
 assert.match(viewer,/\/api\/imo3d\/tours\/\$\{encodeURIComponent\(tour\.id\)\}\/depth\/\$\{encodeURIComponent\(scene\.id\)\}\?r=\$\{tour\.revision\}/);
 assert.match(viewer,/new PanoramaEngine\(el,\{plans:tour\.plans,sceneDepth:scene=>sceneDepthRef\.current\(scene\)/);
 assert.match(engine,/window\.setTimeout\(resolve,arrival\?DEPTH_WAIT_MS:0\)/);
 assert.match(engine,/this\.attachDisplayDepth\(\{\.\.\.later,displayDepth:depth\}\)/);
});

test('TOUR-G8: the plan is served as WebP and as a ≤600 px copy for the compact map',async()=>{
 const png=await sharp({create:{width:1086,height:1448,channels:3,background:'#f4f1ea'}}).composite([{input:Buffer.from('<svg width="1086" height="1448"><rect x="100" y="120" width="880" height="1200" fill="none" stroke="#222" stroke-width="18"/></svg>')}]).png().toBuffer();
 const mini=await planImageVariant(png,'mini'),full=await planImageVariant(png,'webp');
 const miniMeta=await sharp(mini).metadata(),fullMeta=await sharp(full).metadata();
 assert.equal(miniMeta.format,'webp');assert.ok(Math.max(miniMeta.width!,miniMeta.height!)<=600);
 assert.equal(fullMeta.format,'webp');assert.equal(fullMeta.width,1086);assert.equal(fullMeta.height,1448);
 assert.ok(mini.length<full.length&&full.length<png.length);
 // Smaller, not blurrier: a plan of fine walls and labels comes back within ~1 grey level (quality 82; 60 already reads 1.26).
 const lines=Array.from({length:40},(_,i)=>`<line x1="${60+i*24}" y1="100" x2="${60+i*24}" y2="1350" stroke="#222" stroke-width="${2+i%5}"/>`).join('')+Array.from({length:30},(_,i)=>`<rect x="${80+(i%6)*170}" y="${160+Math.floor(i/6)*230}" width="${40+i*3}" height="14" fill="#333"/>`).join('');
 const detailed=await sharp({create:{width:1086,height:1448,channels:3,background:'#f4f1ea'}}).composite([{input:Buffer.from(`<svg width="1086" height="1448">${lines}</svg>`)}]).png().toBuffer();
 const [before,after]=await Promise.all([sharp(detailed).removeAlpha().raw().toBuffer(),planImageVariant(detailed,'webp').then(webp=>sharp(webp).removeAlpha().raw().toBuffer())]);
 let error=0;for(let i=0;i<before.length;i++)error+=Math.abs(before[i]-after[i]);
 assert.ok(error/before.length<1.1,`mean error ${(error/before.length).toFixed(2)} grey levels`);
 assert.equal(planImageVariantOf('mini'),'mini');assert.equal(planImageVariantOf('png'),null);assert.equal(planImageVariantOf(null),null);
});

test('TOUR-G8: the compact map fetches the mini variant, the dialog the WebP, and the PNG only opens on request',async()=>{
 const originalFetch=globalThis.fetch,originalCreate=URL.createObjectURL,originalLocation=Object.getOwnPropertyDescriptor(globalThis,'location');
 Object.defineProperty(globalThis,'location',{value:{origin:'https://example.test'},configurable:true});
 const requested:string[]=[];URL.createObjectURL=()=>'blob:plan';
 globalThis.fetch=async input=>{requested.push(String(input));return String(input).includes('/image?')?new Response('img'):Response.json({job:{id:'job-1',status:'draft',result:{floors:[{floor:0}]}},stale:false});};
 const cache=createViewerPlanCache(),key='/api/imo3d/tours/t/ai-plan?viewer=1&floor=0';
 try{
  await cache.get(key,'mini');await cache.get(key,'webp');
  const images=requested.filter(url=>url.includes('/image?'));
  assert.deepEqual(images,['/api/imo3d/tours/t/ai-plan/image?job=job-1&floor=0&variant=mini','/api/imo3d/tours/t/ai-plan/image?job=job-1&floor=0&variant=webp']);
 }finally{cache.dispose();globalThis.fetch=originalFetch;URL.createObjectURL=originalCreate;if(originalLocation)Object.defineProperty(globalThis,'location',originalLocation);else Reflect.deleteProperty(globalThis,'location');}
 const plan=source('src/components/imo3d/ViewerFloorPlan.tsx');
 assert.match(plan,/const variant=compact\?"mini":"webp";/);assert.match(plan,/<a href=\{original\} target="_blank" rel="noreferrer">فتح بالحجم الكامل<\/a>/);
});

test('G-SHARECARD: a shared link previews the tour under the developer’s name, never the marketing site',()=>{
 const tour={...syntheticTour(),id:'6e8f6cef-d849-45c3-9a7f-0c4c6ce3e968',title:'شقة 101',revision:7};tour.unit={...tour.unit,area:145,bedrooms:3};
 const card=shareCard({tour,brandName:'مساكن الروضة',projectName:'برج الروضة',location:'جدة'},{origin:'https://os.bmk.solutions',id:tour.id});
 assert.deepEqual(card.title,{absolute:'شقة 101 — مساكن الروضة'});
 const og=card.openGraph as {url:string;siteName:string;title:string;images:{url:string;width:number;height:number}[]};
 assert.equal(og.url,'https://os.bmk.solutions/media-support/tour/t/6e8f6cef-d849-45c3-9a7f-0c4c6ce3e968');
 assert.equal(og.siteName,'مساكن الروضة');assert.equal(og.title,'شقة 101 — مساكن الروضة');
 assert.deepEqual(og.images,[{url:'https://os.bmk.solutions/media-support/tour/api/imo3d/tours/6e8f6cef-d849-45c3-9a7f-0c4c6ce3e968/og-image?r=7',width:1200,height:630,alt:'شقة 101'}]);
 assert.match(String(card.description),/جولة افتراضية 360° داخل شقة 101 — برج الروضة، جدة\. المساحة 145 م² · 3 غرف نوم\./);
 assert.equal(String(card.metadataBase),'https://os.bmk.solutions/');
 const text=JSON.stringify(card);
 for(const leak of ['www.bmk.solutions','hero.webp','Visual & Digital','استوديو الجولات','BMK Solutions'])assert.ok(!text.includes(leak),leak);
 // The platform's default name gives way to the project's own.
 assert.deepEqual(shareCard({tour,brandName:'IMO 3D',projectName:'برج الروضة'},{origin:'https://os.bmk.solutions',id:tour.id}).title,{absolute:'شقة 101 — برج الروضة'});
 const neutral=shareCard(null,{origin:'https://os.bmk.solutions',id:'x'});
 assert.deepEqual(neutral.title,{absolute:'جولة افتراضية 360°'});assert.equal((neutral.openGraph as {images?:unknown}).images,undefined);
 assert.ok(!JSON.stringify(neutral).includes('bmk.solutions/assets'));
 assert.match(source('src/app/imo3d/t/[id]/page.tsx'),/export async function generateMetadata\(\{params\}:Props\):Promise<Metadata>\{const \{id\}=await params;return tourShareMetadata\(id\);\}/);
});

test('G-SHARECARD: the preview picture is the panorama centre at 1200×630, under WhatsApp’s 300 KB',async()=>{
 const noise=Buffer.alloc(4096*2048*3);for(let i=0;i<noise.length;i++)noise[i]=(i*2654435761>>>24)&255;
 const panorama=await sharp(noise,{raw:{width:4096,height:2048,channels:3}}).jpeg({quality:90}).toBuffer();
 const card=await shareImageFromPanorama(panorama),meta=await sharp(card).metadata();
 assert.deepEqual([meta.format,meta.width,meta.height],['jpeg',1200,630]);assert.ok(card.length<300_000,String(card.length));
});

test('G-LOGO-TO-LOGIN: only a signed-in administrator is offered the studio from a public tour',()=>{
 assert.equal(studioLink({embedded:false,admin:false}),null);
 assert.equal(studioLink({embedded:true,admin:true}),null);
 assert.equal(studioLink({embedded:false,admin:true}),'/media-support/tour');
 const viewer=source('src/components/imo3d/TourViewer.tsx');
 assert.doesNotMatch(viewer,/href=\{withBasePath\("\/"\)\}/,'no unconditional link to the studio');
 assert.doesNotMatch(viewer,/href=\{embedded\?undefined:withBasePath/);
 assert.match(viewer,/const Wordmark=studio\?"a":"div";/);
 assert.match(viewer,/\{studio\?<a className="imo-button primary" href=\{studio\}>العودة إلى الاستوديو<\/a>:/);
});

test('TOUR-G2: «سجّل اهتمامك» is a visible dock button on phone and desktop',()=>{
 const viewer=source('src/components/imo3d/TourViewer.tsx'),dock=/<nav className="imo-mobile-dock"[\s\S]*?<\/nav>/.exec(viewer)?.[0]??'';
 assert.match(dock,/<button className="imo-dock-interest" aria-haspopup="dialog" aria-expanded=\{panel==="lead"\} onClick=\{\(\)=>openPanel\("lead"\)\}><span>سجّل اهتمامك<\/span>/);
 const css=['viewer-mobile','liquid-glass','viewer-clean','viewer-presentation'].map(name=>source(`src/components/imo3d/${name}.css`)).join('\n')+source('src/app/imo3d/imo3d.css')+source('src/app/imo3d/imo3d-theme.css');
 for(const rule of css.split('}'))if(/imo-dock-interest/.test(rule))assert.doesNotMatch(rule,/display:\s*none|visibility:\s*hidden/,rule);
 assert.match(source('src/components/imo3d/viewer-presentation.css'),/\.imo-shell\.imo-viewer \.imo-mobile-dock>\.imo-dock-interest\{display:flex;/);
 // The dock itself is shown at every width.
 assert.match(source('src/components/imo3d/viewer-clean.css'),/\.imo-viewer \.imo-mobile-dock\{display:flex;/);
});

test('TOUR-G5: a reviewed architectural plan is the default clean plan; the furnished picture is the toggle',()=>{
 const tour=syntheticTour(),plan=tour.plans[0] as Plan;
 assert.equal(defaultPlanView(plan),'furnished');assert.equal(defaultPlanView(undefined),'furnished');
 const architecture={floor:0,walls:[{id:'w'}],rooms:[{id:'r'}],openings:[],columns:[]} as unknown as NonNullable<Plan['architecture']>;
 assert.equal(defaultPlanView({...plan,architecture,architectureReview:'draft'}),'furnished');
 assert.equal(defaultPlanView({...plan,architecture,architectureReview:'reviewed'}),'architecture');
 const view=source('src/components/imo3d/ViewerFloorPlan.tsx'),viewer=source('src/components/imo3d/TourViewer.tsx');
 assert.match(view,/useState\(\(\)=>hasInteractivePlan\)/);assert.match(view,/>المخطط النظيف<\/button>/);assert.match(view,/>المخطط المؤثث<\/button>/);
 assert.equal((viewer.match(/hasInteractivePlan=\{defaultPlanView\((?:currentPlan|plan)\)==="architecture"\}/g)??[]).length,2);
});

test('light/dark: the tour follows the suite’s «bmk-theme», the device by default, with a toggle',()=>{
 assert.equal(THEME_KEY,'bmk-theme');
 assert.equal(themeChoice(null),'system');assert.equal(themeChoice('system'),'system');assert.equal(themeChoice('dark'),'dark');
 assert.equal(resolveTheme('system',true),'light');assert.equal(resolveTheme('system',false),'dark');assert.equal(resolveTheme('light',false),'light');
 assert.equal(nextThemeChoice('dark',false),'light');assert.equal(nextThemeChoice('light',false),'system');assert.equal(nextThemeChoice('dark',true),'system');
 const boot=(stored:string|null,prefersLight:boolean)=>{
  const listeners:(()=>void)[]=[];const root={dataset:{} as Record<string,string>,style:{} as Record<string,string>};
  vm.runInNewContext(THEME_BOOT_SCRIPT,{document:{documentElement:root},localStorage:{getItem:(key:string)=>key==='bmk-theme'?stored:null},matchMedia:()=>({matches:prefersLight,addEventListener:(_:string,fn:()=>void)=>listeners.push(fn)}),addEventListener:()=>{}});
  return {theme:root.dataset.imoTheme,scheme:root.style.colorScheme,listeners};
 };
 assert.deepEqual({...boot(null,true),listeners:undefined},{theme:'light',scheme:'light',listeners:undefined});
 assert.equal(boot(null,false).theme,'dark');assert.equal(boot('light',false).theme,'light');assert.equal(boot('dark',true).theme,'dark');
 assert.equal(boot(null,true).listeners.length,1,'a system choice keeps following the device');
 assert.match(source('src/app/imo3d/layout.tsx'),/<script dangerouslySetInnerHTML=\{\{__html:THEME_BOOT_SCRIPT\}\}\/>/);
 assert.match(source('src/components/imo3d/Studio.tsx'),/<\/nav><ThemeToggle\/>/);
 assert.match(source('src/components/imo3d/TourViewer.tsx'),/<ThemeToggle\/>/);
 const css=source('src/app/imo3d/imo3d-theme.css');
 for(const selector of ['html[data-imo-theme=dark] .imo-dialog','html[data-imo-theme=dark] .imo-shell.imo-studio','html[data-imo-theme=light] .imo-shell.imo-viewer .imo-mobile-dock','html[data-imo-theme=dark] .imo-viewer .imo-compact-apartment-map'])assert.ok(css.includes(selector),selector);
});

test('TOUR-G10 / ENG-4: the plan panel names the worker the status reports, and a desk copy keeps its own lines',()=>{
 const codex=planPanelStatusText({configured:true,provider:'codex',workerOnline:true});
 assert.match(codex,/^عامل Codex على جهازك متصل\. /);assert.match(codex,/يعمل باشتراك ChatGPT المسجّل على الجهاز\./);assert.doesNotMatch(codex,/Gemini/);
 const gemini=planPanelStatusText({configured:true,provider:'gemini-local',workerOnline:true});
 assert.match(gemini,/^عامل Gemini على جهازك متصل\. /);assert.match(gemini,/حساب Gemini API/);assert.doesNotMatch(gemini,/Codex|ChatGPT/);
 const unnamed=planPanelStatusText({configured:true,provider:null,workerOnline:true});
 assert.match(unnamed,/^عامل المخططات على جهازك متصل\. /);assert.doesNotMatch(unnamed,/Codex|Gemini|ChatGPT/);
 const down=planPanelStatusText({configured:false,provider:null,workerOnline:false});
 assert.match(down,/^عامل المخططات على جهازك غير متصل\. /);assert.match(down,/زر التحليل يعمل عند اتصاله\.$/);
 // A desk copy (local mode) has no PC worker: it never reports one offline, it says whether its API key is set.
 assert.equal(planPanelStatusText({configured:true}),'يستخدم هذا المسار حساب API المهيّأ على الخادم.');
 assert.equal(planPanelStatusText({configured:false}),'التوليد التلقائي غير مهيّأ على هذه النسخة.');
});

const SNAP='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.36 (compatible; Snap URL Preview Service; bot; snapchat; https://developers.snap.com/robots)';
test('BUY-1: every link-preview crawler gets the card in <head>; a browser keeps streamed metadata',()=>{
 assert.equal(imo3dConfig({}).htmlLimitedBots,LINK_PREVIEW_BOTS);
 assert.ok(LINK_PREVIEW_BOTS.source.startsWith(HTML_LIMITED_BOT_UA_RE.source),'Next’s own list is kept whole');
 assert.doesNotMatch(SNAP,HTML_LIMITED_BOT_UA_RE,'Next alone streams the card past Snapchat');
 for(const agent of [SNAP,'Viber/20.0','Mozilla/5.0 (compatible; SignalBot)','Microsoft Teams','Mozilla/5.0 (Windows NT 6.1; WOW64) SkypeUriPreview Preview/0.5','TelegramBot (like TwitterBot)','WhatsApp/2.23.20.0','facebookexternalhit/1.1','Pinterestbot/1.0','LinkedInBot/1.0','Discordbot/2.0','kakaotalk-scrap/1.0','facebookexternalhit/1.1;line-poker/1.0'])assert.match(agent,LINK_PREVIEW_BOTS,agent);
 for(const agent of ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36','Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1','Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'])assert.doesNotMatch(agent,LINK_PREVIEW_BOTS,agent);
});

test('BUY-2: the viewer’s architectural plan opens as the clean drawing; the studio editor keeps the tour layers',()=>{
 const clean=architectureLayers('clean'),tour=architectureLayers('tour');
 assert.deepEqual([clean.cameras,clean.direction,clean.confidence],[false,false,false]);
 assert.deepEqual([clean.walls,clean.doors,clean.windows,clean.rooms,clean.names],[true,true,true,true,true]);
 assert.deepEqual([tour.cameras,tour.direction],[true,true]);
 const view=source('src/components/imo3d/ArchitecturalPlanView.tsx');
 assert.match(view,/presentation="tour"\}:ArchitecturalPlanViewProps\)\{\r?\n const \[layers,setLayers\]=useState<ArchitectureLayers>\(\(\)=>architectureLayers\(presentation\)\);/);
 // «مخطط نظيف» is pressed exactly when the 360 positions are off, which the clean presentation starts with.
 assert.match(view,/<button type="button" aria-pressed=\{!layers\.cameras\} onClick=\{\(\)=>setLayers\(p=>\(\{\.\.\.p,cameras:false,direction:false,confidence:false\}\)\)\}>مخطط نظيف<\/button>/);
 assert.match(source('src/components/imo3d/CompactApartmentMap.tsx'),/mode=\{mode\} compact presentation="clean"\/>/);
 assert.match(source('src/components/imo3d/InteractiveFloorPlan.tsx'),/mode=\{mode\} presentation=\{presentation\}\/><\/section>/);
 assert.match(source('src/components/imo3d/TourViewer.tsx'),/<InteractiveFloorPlan presentation="clean" /);
 assert.doesNotMatch(source('src/components/imo3d/ArchitecturalPlanEditor.tsx'),/presentation=/,'the editor still shows where each photo stands');
});

test('BUY-3: the viewer’s plan tools, compact plan header, unit summary and controls toggle have a light theme',()=>{
 const rules=source('src/app/imo3d/imo3d-theme.css').replace(/\/\*[\s\S]*?\*\//g,'').split('}').map(rule=>rule.trim());
 const light=(selector:string)=>rules.find(rule=>rule.split('{')[0].split(/,(?![^(]*\))/).some(part=>part.trim()===selector))?.split('{')[1]??'';
 const frosted=/background:#f5f8f6eb/,ink=/color:#17372f/;
 for(const selector of ['html[data-imo-theme=light] .imo-shell.imo-viewer .imo-controls-toggle','html[data-imo-theme=light] .imo-viewer .imo-unit-summary','html[data-imo-theme=light] .imo-viewer .imo-map-dialog .imo-viewer-draft-tools :is(button,a)','html[data-imo-theme=light] .imo-viewer .imo-map-dialog>header button']){
  assert.match(light(selector),frosted,selector);assert.match(light(selector),ink,selector);
 }
 assert.match(light('html[data-imo-theme=light] .imo-viewer .imo-draft-minimap .imo-plan-header'),frosted);
 assert.match(light('html[data-imo-theme=light] .imo-viewer .imo-draft-minimap .imo-plan-header button'),/color:#17372f;text-shadow:none/);
 // Their dark-theme look is the dark glass they already have.
 assert.match(source('src/components/imo3d/viewer-presentation.css'),/\.imo-draft-minimap \.imo-plan-header button\{[^}]*color:white/);
});

test('BUY-4: the browser tab and the share sheet use the shared card’s title, never the platform name',()=>{
 assert.equal(tourShareTitle({title:'Al Hamra',brandName:'IMO 3D',projectName:'Aved'}),'Al Hamra — Aved');
 assert.equal(tourShareTitle({title:'Al Hamra',brandName:'مساكن',projectName:'Aved'}),'Al Hamra — مساكن');
 assert.equal(tourShareTitle({title:'Al Hamra',brandName:'IMO 3D'}),'Al Hamra');
 assert.equal(tourShareTitle({title:'Al Hamra'}),'Al Hamra');
 const tour={...syntheticTour(),title:'Al Hamra'};
 assert.deepEqual(shareCard({tour,brandName:'IMO 3D',projectName:'Aved'},{origin:'https://os.bmk.solutions',id:tour.id}).title,{absolute:'Al Hamra — Aved'});
 const viewer=source('src/components/imo3d/TourViewer.tsx');
 assert.match(viewer,/document\.title=tourShareTitle\(\{title:tour\.title,brandName:tour\.branding\?\.name,projectName:tour\.branding\?\.projectName\}\)/);
 assert.doesNotMatch(viewer,/document\.title=[^;]*"IMO 3D"/);
});

test('BUY-5: the tour and the studio carry none of BMK’s own metadata, JSON-LD, chrome or mark',()=>{
 const root=source('src/app/layout.tsx'),site=source('src/app/(site)/layout.tsx');
 for(const leak of ['ld+json','WebsiteChrome','BMK Solutions','7007295608','+966','metadata:','icons'])assert.ok(!root.includes(leak),leak);
 for(const kept of ['application/ld+json','<WebsiteChrome','export const metadata','mark-black.png'])assert.ok(site.includes(kept),kept);
 assert.ok(!existsSync('src/app/icon.svg')&&existsSync('src/app/(site)/icon.svg'),'the BMK mark is the marketing pages’ icon only');
 assert.ok(!existsSync('src/app/(site)/imo3d')&&existsSync('src/app/imo3d/t/[id]/page.tsx'),'IMO3D is outside the marketing group');
 assert.ok(existsSync('public'+NEUTRAL_TOUR_ICON));
 assert.match(source('src/app/imo3d/layout.tsx'),/icons:\{icon:withBasePath\(NEUTRAL_TOUR_ICON\)\}/);
 const tour=syntheticTour(),target={origin:'https://os.bmk.solutions',id:tour.id},neutral={icon:'https://os.bmk.solutions/media-support/tour/assets/imo3d-tour-icon.svg'};
 assert.deepEqual(shareCard(null,target).icons,neutral);
 assert.deepEqual(shareCard({tour,brandName:'مساكن'},target).icons,neutral);
 const logo='https://os.bmk.solutions/media-support/tour/api/imo3d/branding-assets/l';
 assert.deepEqual(shareCard({tour,brandName:'مساكن',brandLogo:'/api/imo3d/branding-assets/l'},target).icons,{icon:logo,apple:logo});
});

test('BUY-6: the dock fits a 320 px screen with «سجّل اهتمامك» whole',()=>{
 const css=source('src/components/imo3d/viewer-presentation.css'),block=/@media\(max-width:340px\)\{([\s\S]*?\})\}/.exec(css)?.[1]??'';
 const px=(pattern:RegExp)=>Number(pattern.exec(block)?.[1]);
 const padding=px(/\.imo-mobile-dock\{padding:(\d+)px/),gap=px(/\.imo-mobile-dock\{[^}]*gap:(\d+)px/),gutter=px(/max-width:calc\(100% - (\d+)px\)/),glass=px(/>\.imo-glass\{width:(\d+)px!important/);
 const interest=/>\.imo-dock-interest\{([^}]*)\}/.exec(block)?.[1]??'',inner=Number(/gap:(\d+)px/.exec(interest)?.[1]),margin=Number(/margin-inline-start:(\d+)px/.exec(interest)?.[1]),side=Number(/padding:0 (\d+)px/.exec(interest)?.[1]),icon=px(/>svg\{width:(\d+)px/);
 // «سجّل اهتمامك» at 12 px Alexandria measures 86 px (measured at 320x640: the button is 120 px); the border is 1 px a side.
 const width=2*padding+3*glass+3*gap+margin+(2*side+86+inner+icon)+2;
 assert.ok([padding,gap,gutter,glass,inner,margin,side,icon].every(Number.isFinite),block);
 // 8 px to spare: text metrics differ a little between Android and iOS fonts.
 assert.ok(width+8<=320-gutter,`${width} px + 8 > ${320-gutter} px`);
});
