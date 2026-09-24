import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {createHmac,randomUUID} from 'node:crypto';
import {NextRequest} from 'next/server';
import {getPathMatch} from 'next/dist/shared/lib/router/utils/path-match';
import {IMO3D_BASE_PATH,withBasePath,withoutBasePath,servedAssetPath,storedAssetPath,servePayloadPaths,suiteLoginPath} from '../src/lib/imo3d/base-path';
import {suiteSession,clearSuiteSessionCache,embedTourURL,suiteBrowserOrigins} from '../src/lib/imo3d/suite';
import {isAdmin} from '../src/lib/imo3d/auth';
import {hotspotSchema} from '../src/lib/imo3d/hotspots';
import {proxy,config as proxyConfig} from '../src/proxy';
import configForPhase,{imo3dConfig,selfOrigin} from '../next.config';

// A fake suite zone answering exactly the contract: GET /media-support/api/_ms/session → 200 {ok,uid,email} | 401.
const owner={uid:'owner-uid',email:'owner@example.test'},goodToken='fake-suite-token.'+'a'.repeat(40);
let zone:Server,zoneCalls:string[]=[];const envOriginal={...process.env};
before(async()=>{
 zone=createServer((request,response)=>{
  const token=/(?:^|;\s*)ms_session=([^;]+)/.exec(request.headers.cookie??'')?.[1];zoneCalls.push(request.url??'');
  const ok=request.method==='GET'&&request.url==='/media-support/api/_ms/session'&&token===goodToken;
  response.writeHead(ok?200:401,{'content-type':'application/json'});response.end(JSON.stringify(ok?{ok:true,...owner}:{ok:false}));
 });
 await new Promise<void>(resolve=>zone.listen(0,'127.0.0.1',resolve));
});
after(()=>new Promise<void>(resolve=>zone.close(()=>resolve())));
beforeEach(()=>{
 for(const key of Object.keys(process.env))if(!(key in envOriginal))delete process.env[key];Object.assign(process.env,envOriginal);
 process.env.MS_ZONE_ORIGIN='http://127.0.0.1:'+(zone.address() as AddressInfo).port;zoneCalls=[];clearSuiteSessionCache();
});
// The config a production build of this project produces (no Vercel preview variables).
const nextConfig=imo3dConfig({});
const withCookie=(cookie?:string)=>new Request('https://bmk-imo3d.vercel.app/media-support/tour/api/imo3d/session',{headers:cookie?{cookie}:{}});

test('app paths carry the suite basePath once; URLs and protocol-relative paths pass through',()=>{
 assert.equal(IMO3D_BASE_PATH,'/media-support/tour');assert.equal(nextConfig.basePath,IMO3D_BASE_PATH);
 assert.equal(withBasePath('/'),'/media-support/tour');assert.equal(withBasePath('/api/imo3d/tours/x'),'/media-support/tour/api/imo3d/tours/x');
 assert.equal(withBasePath(withBasePath('/t/abc')),'/media-support/tour/t/abc');
 for(const value of ['https://example.test/a','//evil.test/a','relative/path'])assert.equal(withBasePath(value),value);
 assert.equal(withoutBasePath('/media-support/tour/api/imo3d/assets/a'),'/api/imo3d/assets/a');assert.equal(withoutBasePath('/media-support/tour'),'/');
 assert.equal(withoutBasePath('/media-support/tourist'),'/media-support/tourist','a longer segment is not the basePath');
});

test('stored payload paths are served under the basePath at read time and return canonical on the way in',()=>{
 const id=randomUUID(),stored=`/api/imo3d/assets/${id}`;
 const payload={id:'tour',scenes:[{image:stored,preview:'/api/imo3d/assets/p',thumbnail:'/imo3d/example/s000.poster.webp',name:'see /api/imo3d/assets/x'}],
  plans:[{surfaceModel:{url:'/api/imo3d/assets/model'}}],branding:{logo:'/api/imo3d/branding-assets/logo'},
  media:{expiresAt:1,urls:{[stored]:'https://x.storage.supabase.co/storage/v1/object/sign/a?token=t'}},
  hotspots:[{url:'https://example.test/video.mp4',link:''}],revision:3,published:true,nothing:null};
 const before=JSON.stringify(payload),served=servePayloadPaths(payload);
 assert.equal(JSON.stringify(payload),before,'the stored payload is not mutated');
 assert.equal(served.scenes[0].image,'/media-support/tour'+stored);assert.equal(served.scenes[0].thumbnail,'/media-support/tour/imo3d/example/s000.poster.webp');
 assert.equal(served.scenes[0].name,'see /api/imo3d/assets/x','free text is data, not a path');
 assert.equal(served.plans[0].surfaceModel.url,'/media-support/tour/api/imo3d/assets/model');assert.equal(served.branding.logo,'/media-support/tour/api/imo3d/branding-assets/logo');
 assert.deepEqual(Object.keys(served.media.urls),['/media-support/tour'+stored],'the viewer still finds each signed URL under the scene path it holds');
 assert.equal(served.media.urls[served.scenes[0].image],payload.media.urls[stored]);
 assert.equal(served.hotspots[0].url,'https://example.test/video.mp4');assert.equal(served.revision,3);assert.equal(served.nothing,null);
 assert.deepEqual(servePayloadPaths(served),served,'serving is idempotent');
 assert.equal(storedAssetPath(served.scenes[0].image),stored);assert.equal(storedAssetPath(stored),stored);assert.equal(servedAssetPath('https://a.test/api/imo3d/assets/x'),'https://a.test/api/imo3d/assets/x');
 const hostile=servePayloadPaths(JSON.parse('{"__proto__":{"polluted":"/api/imo3d/assets/p"}}'));
 assert.equal(({} as Record<string,unknown>).polluted,undefined);assert.equal(Object.getPrototypeOf(hostile),Object.prototype);
 assert.deepEqual(Object.keys(hostile),['__proto__']);
});

test('hotspot media posted back in its served form is stored canonical; foreign and traversal paths stay refused',()=>{
 const base={id:randomUUID(),sceneId:'synthetic-0',kind:'image',title:'Photo',yaw:0,pitch:0},id=randomUUID();
 assert.equal(hotspotSchema.parse({...base,url:`/media-support/tour/api/imo3d/assets/${id}`}).url,`/api/imo3d/assets/${id}`);
 assert.equal(hotspotSchema.parse({...base,url:`/api/imo3d/assets/${id}`}).url,`/api/imo3d/assets/${id}`);
 for(const url of ['/media-support/tour/api/imo3d/assets/../../secret','/media-support/other/api/imo3d/assets/'+id,'http://example.test/a'])assert.equal(hotspotSchema.safeParse({...base,url}).success,false,url);
});

test('the suite login location is relative and only ever returns inside this app',()=>{
 const inside='/media-support/tour/imo3d/connect-chatgpt?client_id=a&state=b';
 assert.equal(suiteLoginPath(inside),'/media-support/login?next='+encodeURIComponent(inside));
 for(const next of ['https://evil.test/','//evil.test/x','/media-support/account','/elsewhere','/media-support/tour\\@evil.test'])assert.equal(suiteLoginPath(next),'/media-support/login?next=%2Fmedia-support%2Ftour',next);
});

test('the suite session is asked of the zone, cached only when positive, and fails closed',async()=>{
 assert.equal(await suiteSession(withCookie()),null);assert.equal(await suiteSession(withCookie('imo3d_session=1.2')),null);assert.deepEqual(zoneCalls,[],'no cookie, no network');
 assert.deepEqual(await suiteSession(withCookie('a=1; ms_session='+goodToken)),owner);assert.deepEqual(zoneCalls,['/media-support/api/_ms/session']);
 assert.deepEqual(await suiteSession(withCookie('ms_session='+goodToken)),owner);assert.equal(zoneCalls.length,1,'a positive answer is reused for up to a minute');
 assert.equal(await suiteSession(withCookie('ms_session=wrong-token-0123456789')),null);assert.equal(await suiteSession(withCookie('ms_session=wrong-token-0123456789')),null);
 assert.equal(zoneCalls.length,3,'a refusal is never cached');
 assert.equal(await suiteSession(withCookie('ms_session=bad token with spaces')),null);assert.equal(zoneCalls.length,3,'a malformed cookie is not forwarded');
 clearSuiteSessionCache();process.env.MS_ZONE_ORIGIN='http://zone.example.test';
 assert.equal(await suiteSession(withCookie('ms_session='+goodToken)),null,'the token never travels in clear text off this machine');
 process.env.MS_ZONE_ORIGIN='http://127.0.0.1:9';assert.equal(await suiteSession(withCookie('ms_session='+goodToken)),null,'an unreachable zone is not a session');
});

test('the admin pages redirect a signed-out visitor to the suite login and open inside a suite session',async()=>{
 assert.deepEqual(proxyConfig.matcher,['/','/imo3d/connect-chatgpt'],'public tours (/t/<id>) and the API guide stay open');
 const page=(path:string,cookie?:string)=>new NextRequest('https://bmk-imo3d.vercel.app'+path,{headers:cookie?{cookie}:{}});
 const out=await proxy(page('/media-support/tour'));assert.equal(out.status,307);
 const location=new URL(out.headers.get('location')!);assert.equal(location.host,'bmk-imo3d.vercel.app','same host: the proxy adapter emits it relative');
 assert.equal(location.pathname+location.search,'/media-support/login?next=%2Fmedia-support%2Ftour');
 const consent=await proxy(page('/media-support/tour/imo3d/connect-chatgpt?client_id=c&state=s'));
 assert.equal(new URL(consent.headers.get('location')!).searchParams.get('next'),'/media-support/tour/imo3d/connect-chatgpt?client_id=c&state=s');
 const signedIn=await proxy(page('/media-support/tour','ms_session='+goodToken));assert.equal(signedIn.headers.get('x-middleware-next'),'1');
 const refused=await proxy(page('/media-support/tour','ms_session=wrong-token-0123456789'));assert.equal(refused.status,307);
});

// Evaluates next.config the way the router does: first matching rule wins.
type Rule={source:string;destination:string;basePath?:false;permanent?:boolean};
function route(rules:Rule[],path:string,outside:boolean){
 for(const rule of rules){
  const source=outside?rule.source:rule.basePath===false?null:IMO3D_BASE_PATH+(rule.source==='/'?'':rule.source);
  if(outside&&rule.basePath!==false||!source)continue;
  const params=getPathMatch(source,{strict:true,removeUnnamedParams:true})(path);if(!params)continue;
  const destination=rule.destination.replace(/:(\w+)\*?/g,(_,name)=>Array.isArray(params[name])?params[name].join('/'):params[name]??'');
  return {destination:rule.basePath===false||/^https?:/.test(destination)?destination:IMO3D_BASE_PATH+(destination==='/'?'':destination),permanent:rule.permanent};
 }
 return null;
}
test('old public links on the app host move to the new paths; the ChatGPT connector keeps its old paths',async()=>{
 const redirects=await nextConfig.redirects!() as Rule[],rewrites=(await nextConfig.rewrites!()) as {beforeFiles:Rule[]},id=randomUUID();
 const moved:[string,string][]=[['/imo3d/t/'+id,'/media-support/tour/t/'+id],['/imo3d','/media-support/tour'],['/imo3d/connect-chatgpt','/media-support/tour/imo3d/connect-chatgpt'],
  ['/imo3d/api','/media-support/tour/imo3d/api'],['/api/imo3d/assets/'+id,'/media-support/tour/api/imo3d/assets/'+id],['/api/imo3d/branding-assets/'+id,'/media-support/tour/api/imo3d/branding-assets/'+id],
  ['/media-support/login','https://os.bmk.solutions/media-support/login']];
 for(const [from,to] of moved){const hit=route(redirects,from,true);assert.equal(hit?.destination,to,from);assert.equal(hit?.permanent,false,'a 307 keeps the cutover reversible');}
 const kept:[string,string][]=[['/api/imo3d-chatgpt/mcp','https://bmk-imo3d.vercel.app/media-support/tour/api/imo3d-chatgpt/mcp'],['/api/imo3d-chatgpt/token','https://bmk-imo3d.vercel.app/media-support/tour/api/imo3d-chatgpt/token'],
  ['/.well-known/oauth-authorization-server','https://bmk-imo3d.vercel.app/media-support/tour/.well-known/oauth-authorization-server'],['/.well-known/oauth-protected-resource','https://bmk-imo3d.vercel.app/media-support/tour/.well-known/oauth-protected-resource'],
  ['/api/imo3d/tours/'+id,'https://bmk-imo3d.vercel.app/media-support/tour/api/imo3d/tours/'+id]];
 for(const [from,to] of kept){assert.equal(route(redirects,from,true),null,from+' is not redirected');assert.equal(route(rewrites.beforeFiles,from,true)?.destination,to,from);}
 // Inside the basePath: the studio is the root, a tour is /t/<id>, and the long form redirects to it without a loop.
 assert.equal(route(rewrites.beforeFiles,'/media-support/tour',false)?.destination,'/media-support/tour/imo3d');
 assert.equal(route(rewrites.beforeFiles,'/media-support/tour/t/'+id,false)?.destination,'/media-support/tour/imo3d/t/'+id);
 assert.equal(route(redirects,'/media-support/tour/imo3d/t/'+id,false)?.destination,'/media-support/tour/t/'+id);
 assert.equal(route(redirects,'/media-support/tour/imo3d',false)?.destination,'/media-support/tour');
 assert.equal(route(redirects,'/media-support/tour/t/'+id,false),null,'the short tour address is final');
});

test('IMO3D pages are not given the marketing CDN cache header',async()=>{
 const [rule]=await nextConfig.headers!(),match=getPathMatch(IMO3D_BASE_PATH+rule.source,{strict:true,removeUnnamedParams:true});
 assert.equal(rule.headers[0].value,'public, s-maxage=300, stale-while-revalidate=600');
 for(const path of ['/media-support/tour','/media-support/tour/','/media-support/tour/t/abc','/media-support/tour/imo3d','/media-support/tour/api/imo3d/tours'])assert.equal(match(path),false,path);
 assert.ok(match('/media-support/tour/about'));
});

test('embed codes always frame the app host with the new basePath, never the suite domain',()=>{
 const id=randomUUID();
 assert.equal(embedTourURL(id),'https://bmk-imo3d.vercel.app/media-support/tour/t/'+id);
 process.env.IMO3D_PUBLIC_ORIGIN='https://os.bmk.solutions';assert.equal(embedTourURL(id),'https://bmk-imo3d.vercel.app/media-support/tour/t/'+id,'the public origin does not move embeds');
 assert.equal(embedTourURL(id,'http://127.0.0.1:4393'),'http://127.0.0.1:4393/media-support/tour/t/'+id,'a local run frames itself');
 process.env.IMO3D_APP_ORIGIN='https://tours.example.test/ignored';assert.equal(embedTourURL(id,'http://127.0.0.1:4393'),'https://tours.example.test/media-support/tour/t/'+id);
 delete process.env.IMO3D_APP_ORIGIN;assert.deepEqual(suiteBrowserOrigins(),['https://os.bmk.solutions','http://127.0.0.1:'+(zone.address() as AddressInfo).port]);
});

test('the gated admin pages are never stored by a shared cache',async()=>{
 const rules=await nextConfig.headers!(),at=(path:string)=>rules.filter(rule=>getPathMatch(rule.source==='/'?IMO3D_BASE_PATH:IMO3D_BASE_PATH+rule.source,{strict:true,removeUnnamedParams:true})(path)).flatMap(rule=>rule.headers.filter(header=>header.key==='Cache-Control').map(header=>header.value));
 for(const path of ['/media-support/tour','/media-support/tour/imo3d/connect-chatgpt'])assert.deepEqual(at(path),['private, no-store'],path);
 assert.deepEqual(at('/media-support/tour/t/abc'),[],'a public tour keeps its own caching');
});

test('a production build of this config runs only for the bmk-imo3d Vercel project or an explicit local opt-in',()=>{
 const saved={VERCEL:process.env.VERCEL,IMO3D_SUITE_BUILD:process.env.IMO3D_SUITE_BUILD};
 try{
  delete process.env.VERCEL;delete process.env.IMO3D_SUITE_BUILD;
  // Hostinger builds the marketing site from main with `npm run build`: it must stop, not ship 404s at /.
  assert.throws(()=>configForPhase('phase-production-build'),/Never merge it into main/);
  assert.equal(configForPhase('phase-development-server').basePath,IMO3D_BASE_PATH,'next dev is unaffected');
  assert.equal(configForPhase('phase-production-server').basePath,IMO3D_BASE_PATH,'next start of a finished build is unaffected');
  process.env.VERCEL='1';assert.equal(configForPhase('phase-production-build').basePath,IMO3D_BASE_PATH);
  delete process.env.VERCEL;process.env.IMO3D_SUITE_BUILD='1';assert.equal(configForPhase('phase-production-build').basePath,IMO3D_BASE_PATH);
 }finally{for(const [key,value] of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value;}
});

test('a Vercel preview proxies the old paths to itself, never to production',async()=>{
 assert.equal(selfOrigin({}),'https://bmk-imo3d.vercel.app');
 assert.equal(selfOrigin({VERCEL_ENV:'production',VERCEL_URL:'bmk-imo3d-prod123.vercel.app'}),'https://bmk-imo3d.vercel.app','production answers on its public alias (deployment URLs are protected)');
 const preview={VERCEL_ENV:'preview',VERCEL_URL:'bmk-imo3d-git-abc123.vercel.app',IMO3D_APP_ORIGIN:'https://bmk-imo3d.vercel.app'};
 assert.equal(selfOrigin(preview),'https://bmk-imo3d-git-abc123.vercel.app','a project-wide IMO3D_APP_ORIGIN does not send a preview to production');
 const rewrites=(await imo3dConfig(preview).rewrites!()) as {beforeFiles:Rule[]};
 for(const from of ['/api/imo3d-chatgpt/mcp','/.well-known/oauth-authorization-server','/api/imo3d/tours/x'])
  assert.equal(route(rewrites.beforeFiles,from,true)?.destination,'https://bmk-imo3d-git-abc123.vercel.app/media-support/tour'+from,from);
});

test('local mode: only the suite session is the owner; the old password cookie needs the break-glass switch',async()=>{
 const secret='isolated-unit-test-secret-01234567890123456789';process.env.IMO3D_ADMIN_SECRET=secret;delete process.env.IMO3D_PASSWORD_LOGIN;
 const expiry=String(Date.now()+60_000),legacy=`imo3d_session=${expiry}.${createHmac('sha256',secret).update(expiry).digest('hex')}`;
 assert.equal(await isAdmin(withCookie()),false,'anonymous');
 assert.equal(await isAdmin(withCookie('ms_session=wrong-token-0123456789')),false,'a cookie the zone refuses');
 assert.equal(await isAdmin(withCookie(legacy)),false,'the old password session is closed by default');
 assert.equal(await isAdmin(withCookie('ms_session='+goodToken)),true,'the suite session');
 process.env.IMO3D_PASSWORD_LOGIN='1';assert.equal(await isAdmin(withCookie(legacy)),true,'break-glass');
 assert.equal(await isAdmin(withCookie('imo3d_session='+expiry+'.'+'0'.repeat(64))),false,'a forged legacy cookie stays refused');
});
