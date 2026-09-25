import {test,before,after,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {createServer,type IncomingMessage,type Server} from 'node:http';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {cloudRoute} from '../src/lib/imo3d/cloud/handlers';
import {clearVeraContextCache,maskLeadPhone,parseVeraContext,requestIp,tourInterest,veraBodyDigest,veraCanonical,veraConfig,veraIpHash,veraLeadFailure,veraSignature} from '../src/lib/imo3d/vera-integration';
import {beaconBody,beaconTarget,consentText,interestOffered,UNLINKED_CHIP,whatsappHref,type TourInterest} from '../src/lib/imo3d/tour-interest';
import {honeypotFilled,projectShowcase,tourLeadSchema} from '../src/lib/imo3d/tour-lead';
import {syntheticTour} from './fixtures/imo3d-synthetic-tour';
import type {Tour} from '../src/lib/imo3d/model';

/*
 * The tour → VERA lead federation, proven against a LOCAL fake VERA (a real HTTP server on
 * loopback) that implements the contract: it recomputes the signature from the canonical text
 * with its own code, refuses a stale clock and a replayed nonce, and records every request.
 * Supabase is faked at fetch; nothing here reaches a real VERA, a real database or the network.
 */

// ── VERA's contract vectors, copied verbatim from bmk-spatial tests/unit/integration-signature.test.mjs ──
// The same four in three repos: a green run here proves this signer and VERA's are the same function.
const S_TOUR = 'vera-contract-test-secret-tour360-0123456789';
const S_POI = 'vera-contract-test-secret-poi-0123456789abcdef';
const S_OS = 'vera-contract-test-secret-os-hook-0123456789ab';

/** Key order matters: these are the exact bytes V1 signs (453 of them). */
const LEAD_BODY = JSON.stringify({
  app: 'tour360',
  ref: { project: '4ada0c2b-0000-4000-8000-000000000001', developer: null, developerHint: null, item: 'tour-6e8f6cef' },
  buyer: { name: 'خالد العتيبي', phone: '٠٥٠١٢٣٤٥٦٧', message: 'مهتم بالوحدة' },
  unit: { code: 'T1-F07-U03' },
  consent: { given: true, version: 'vera-consent-2026-09-25' },
  context: { title: 'Al Hamra', url: 'https://example.com/tour/al-hamra' },
  client: { ipHash: 'AAAAAAAAAAAAAAAAAAAAAA' },
});

const EMPTY_DIGEST = '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU';

const VECTORS = [
  {
    name: 'V1', secret: S_TOUR, app: 'tour360', ts: '1790000000', nonce: 'n0nce-tour360-000001',
    method: 'POST', path: '/api/integrations/v1/leads', query: '', rawBody: LEAD_BODY,
    digest: 'xZbcqXNJab7dpBoAKSpLRgu9W0MdHPbXWdurt7qXQ6Y',
    signature: 'v1=_VjNsnrKKQeooEZ3GZENI6IiV3ivTTlIO-_e-CisHh0',
  },
  {
    name: 'V2', secret: S_POI, app: 'poi', ts: '1790000030', nonce: 'n0nce-poi-00000000002',
    method: 'GET', path: '/api/integrations/v1/context', query: 'project=poi-proj-1&unit=T1-F07-U03', rawBody: '',
    digest: EMPTY_DIGEST,
    signature: 'v1=cNmlwmc91hHXyfFrVPjSlc8lPlthty9aw1aCx4wLgqA',
  },
  {
    name: 'V3', secret: S_TOUR, app: 'tour360', ts: '1790000060', nonce: 'n0nce-tour360-000003',
    method: 'DELETE', path: '/api/integrations/v1/links', query: 'kind=project&ref=4ada0c2b-0000-4000-8000-000000000001', rawBody: '',
    digest: EMPTY_DIGEST,
    signature: 'v1=bbvMNnjlD74yHjm0s060pFPuXxrJTLHYXIKyEKyEihA',
  },
  {
    name: 'V4', secret: S_OS, app: 'vera', ts: '1790000090', nonce: 'n0nce-vera-os-000004',
    method: 'POST', path: '/api/integrations/vera/lead-created', query: '',
    rawBody: '{"leadId":"00000000-0000-4000-8000-0000000000aa"}',
    digest: 'CLndMw7nBPkcXODmmxqUVKks6yPP_KYVayk2yHjrRcU',
    signature: 'v1=miG8fbDP3w2xls1_Dk94C8Eus2uW3G-uekxyP-X9AQg',
  },
];

test('VERA-SIG: the lead body of V1 is the 453 bytes the vector names',()=>{
 assert.equal(Buffer.byteLength(LEAD_BODY,'utf8'),453);
 assert.equal(veraBodyDigest(LEAD_BODY),VECTORS[0].digest);
 assert.equal(veraBodyDigest(''),EMPTY_DIGEST,'an empty body digests the empty string');
});
for(const v of VECTORS)test(`VERA-SIG: ${v.name} — the canonical string, line by line, and its signature`,()=>{
 const canonical=veraCanonical({app:v.app,ts:v.ts,nonce:v.nonce,method:v.method,path:v.path,query:v.query,body:v.rawBody});
 assert.deepEqual(canonical.split('\n'),['vera-int-v1',v.app,v.ts,v.nonce,v.method,`${v.path}?${v.query}`,v.digest]);
 assert.equal(veraSignature(v.secret,canonical),v.signature);
 assert.equal(veraSignature(v.secret,veraCanonical({app:v.app,ts:v.ts,nonce:v.nonce,method:v.method.toLowerCase(),path:v.path,query:v.query,body:v.rawBody})),v.signature,'a lower-case method signs the same');
});
test('VERA-SIG: the IP hash vector: HMAC(secret, «ip:» + ip), first 16 bytes, b64url',()=>{
 assert.equal(veraIpHash(S_TOUR,'203.0.113.7'),'xQ7oxzObmmfTMVFDjkcJTg');
 assert.match(veraIpHash(S_POI,'2001:db8::1'),/^[A-Za-z0-9_-]{22}$/);
});

test('VERA-CONFIG: no secret, a short secret or a non-TLS remote origin switch the feature off',()=>{
 const secret='s'.repeat(32),env=(values:Record<string,string>)=>values as unknown as NodeJS.ProcessEnv;
 assert.equal(veraConfig(env({VERA_INTEGRATION_ORIGIN:'https://vera.example'})),null);
 assert.equal(veraConfig(env({VERA_INTEGRATION_SECRET:'short',VERA_INTEGRATION_ORIGIN:'https://vera.example'})),null);
 assert.equal(veraConfig(env({VERA_INTEGRATION_SECRET:secret,VERA_INTEGRATION_ORIGIN:'http://vera.example'})),null);
 assert.equal(veraConfig(env({VERA_INTEGRATION_SECRET:secret,VERA_INTEGRATION_ORIGIN:'https://vera.example/imo3d'})),null,'the basePath is added by the client, never configured');
 assert.equal(veraConfig(env({VERA_INTEGRATION_SECRET:secret,VERA_INTEGRATION_ORIGIN:'http://127.0.0.1:9',NODE_ENV:'production'})),null,'production never talks plain http');
 assert.deepEqual(veraConfig(env({VERA_INTEGRATION_SECRET:secret,VERA_INTEGRATION_ORIGIN:'https://vera.example/'})),{secret,origin:'https://vera.example'});
 assert.equal(veraConfig(env({VERA_INTEGRATION_SECRET:secret,VERA_INTEGRATION_ORIGIN:'https://vera.example',VERCEL_ENV:'preview'})),null,'a preview never writes the CRM');
 assert.deepEqual(veraConfig(env({VERA_INTEGRATION_SECRET:secret,VERA_INTEGRATION_ORIGIN:'https://vera.example',VERCEL_ENV:'production'})),{secret,origin:'https://vera.example'});
});

test('VERA-MASK: the audit keeps 05••••123 and never the number; the migration check accepts exactly this shape',()=>{
 const sql=readFileSync('supabase/migrations/20260925120000_imo3d_lead_audit.sql','utf8');
 const check=new RegExp(/imo3d_leads_masked_phone CHECK\(phone ~ '([^']+)'\)/.exec(sql)![1]);
 const cases:[string,string][]=[['0501234567','05••••567'],['+966501234567','05••••567'],['00966501234567','05••••567'],['501234567','05••••567'],['٠٥٠١٢٣٤٥٦٧'.replace(/[٠-٩]/g,d=>String(d.charCodeAt(0)-0x660)),'05••••567'],['+447700900123','+44••••123'],['0044 7700 900123','+44••••123'],['12345678','12••••678']];
 for(const [phone,masked] of cases){assert.equal(maskLeadPhone(phone),masked,phone);assert.match(masked,check);assert.doesNotMatch(masked,/\d{4}/);}
 assert.doesNotMatch('0501234567',check,'a full number is refused by the database');
 // The audit carries no name and no message, and the list returns where VERA sent each request.
 assert.match(sql,/DROP COLUMN name,DROP COLUMN note/);
 assert.match(sql,/l\.forwarded_at AS "forwardedAt",l\.vera_routed AS "routed"/);
 assert.doesNotMatch(sql,/l\.name|l\.note/);
});

test('VERA-BUYER: consent names the developer or the sales team, never BMK; the button hides on a sold unit',()=>{
 assert.equal(consentText('شركة العوالي العقارية','العوالي هومز'),'أوافق على إرسال اسمي ورقم جوالي إلى شركة العوالي العقارية للتواصل معي بخصوص العوالي هومز.');
 assert.equal(consentText(null,'الحمراء'),'أوافق على إرسال اسمي ورقم جوالي إلى فريق مبيعات المشروع للتواصل معي بخصوص الحمراء.');
 const context=(routed:'project'|'fallback')=>parseVeraContext({ok:true,linked:routed!=='fallback',routed,developer:{name:'BMK Solutions'},project:null,whatsapp:'+966 50 000 0000',unit:{code:'A-101',status:'sold',offMarket:true},privacyUrl:'https://os.bmk.solutions/bmk/privacy',consent:{version:'vera-consent-2026-09-25'}});
 const linked=tourInterest(true,context('project'),'https://os.bmk.solutions'),unlinked=tourInterest(true,context('fallback'),'https://os.bmk.solutions');
 assert.deepEqual(linked,{enabled:true,developerName:'BMK Solutions',whatsapp:'966500000000',unitOffMarket:true,privacyUrl:'https://os.bmk.solutions/bmk/privacy',beacon:'https://os.bmk.solutions/imo3d/api/events'});
 assert.equal(unlinked.developerName,null);assert.equal(unlinked.whatsapp,null,'the fallback inbox is not the developer');
 assert.equal(interestOffered(linked),false,'a sold unit takes no request');
 assert.equal(interestOffered({...linked,unitOffMarket:false}),true);
 assert.equal(interestOffered(tourInterest(false,null,'https://os.bmk.solutions')),false,'no secret: no button');
 assert.equal(interestOffered(undefined),true,'the local adapter keeps its button');
 for(const status of ['reserved','rented','SOLD'])assert.equal(parseVeraContext({routed:'project',unit:{status}})?.unitOffMarket,true,status);
 assert.equal(parseVeraContext({routed:'project',unit:{status:'available'}})?.unitOffMarket,false);
 assert.equal(parseVeraContext({routed:'elsewhere'}),null);
 assert.equal(parseVeraContext({routed:'project',privacyUrl:'javascript:alert(1)'})?.privacyUrl,null);
 assert.equal(parseVeraContext({routed:'project',whatsapp:'05'})?.whatsapp,null);
});

test('VERA-WHATSAPP: the button opens wa.me with a question about the unit; the beacon carries ids only and stays on VERA\'s origin',()=>{
 assert.equal(whatsappHref('966500000000','الحمراء','A-101'),'https://wa.me/966500000000?text='+encodeURIComponent('مرحبًا، أرغب بالاستفسار عن الوحدة A-101 في الحمراء.'));
 assert.equal(whatsappHref(null,'الحمراء',''),null);assert.equal(whatsappHref('0500','الحمراء',''),null);
 const interest:TourInterest={enabled:true,developerName:null,whatsapp:null,unitOffMarket:false,privacyUrl:null,beacon:'https://os.bmk.solutions/imo3d/api/events'};
 assert.equal(beaconTarget(interest,'https://os.bmk.solutions'),'https://os.bmk.solutions/imo3d/api/events');
 assert.equal(beaconTarget(interest,'https://bmk-imo3d.vercel.app'),null,'an embed on the tour\'s own host sends nothing');
 assert.equal(beaconTarget({...interest,beacon:null},'https://os.bmk.solutions'),null);
 const tour={...syntheticTour(),unit:{...syntheticTour().unit,code:'A-101'}};
 assert.deepEqual(JSON.parse(beaconBody('wa_click',tour)),{kind:'wa_click',app:'tour360',ref:'synthetic-project',item:'synthetic-tour',unit_code:'A-101'});
 const viewer=readFileSync('src/components/imo3d/TourViewer.tsx','utf8');
 assert.match(viewer,/href=\{whatsapp\} target="_blank" rel="noopener noreferrer" onClick=\{\(\)=>onBeacon\("wa_click"\)\}>تواصل عبر واتساب<\/a>/);
 assert.match(viewer,/useEffect\(\(\)=>\{beacon\("tour_view"\);\},\[beacon\]\);/);
 assert.match(viewer,/if\(!calculated\.current\)\{calculated\.current=true;onBeacon\("mortgage_use"\);\}/);
 // Both entry points and the unit card follow the same rule; the consent is the generated text, not a fixed sentence.
 assert.match(viewer,/\{offered&&<button className="imo-interest"/);assert.match(viewer,/\{offered&&<button className="imo-dock-interest"/);
 assert.match(viewer,/lead=\{panel==="lead"&&offered\}/);
 assert.match(viewer,/\{consentText\(interest\?\.developerName\?\?null,projectName\)\}/);
 assert.doesNotMatch(viewer,/أوافق على حفظ بياناتي/);
 assert.match(viewer,/<input name="name" required minLength=\{2\} maxLength=\{80\}/);assert.match(viewer,/<textarea name="note" maxLength=\{500\}/);
});

test('VERA-FORM: the tour accepts VERA\'s lengths, requires consent, and treats a filled honeypot as a bot',()=>{
 const base={tourId:'t',name:'سارة',phone:'0501234567',consent:true};
 assert.equal(tourLeadSchema.parse(base).note,'');
 assert.throws(()=>tourLeadSchema.parse({...base,consent:false}));
 assert.throws(()=>tourLeadSchema.parse({...base,name:'س'.repeat(81)}));
 assert.throws(()=>tourLeadSchema.parse({...base,note:'x'.repeat(501)}));
 assert.equal(honeypotFilled({website:' spam '}),true);assert.equal(honeypotFilled({website:''}),false);assert.equal(honeypotFilled(null),false);
 assert.deepEqual(veraLeadFailure('REPLAY',409),{ok:false,status:503,error:'REPLAY',message:'تعذّر الإرسال، حاول مجددًا.'},'a fault the buyer cannot fix is one retry message');
 assert.equal(veraLeadFailure('UNIT_OFF_MARKET',409).status,409);assert.equal(veraLeadFailure('',429).status,429);
 assert.equal(requestIp(new Request('https://x',{headers:{'x-forwarded-for':'203.0.113.7, 10.0.0.1'}})),'203.0.113.7');
});

test('VERA-SHOWCASE: a linked project shows its latest published tour, or nothing published',()=>{
 const a={...syntheticTour(),id:'a',title:'A',published:true,updatedAt:'2026-01-01T00:00:00Z'},b={...a,id:'b',title:'B',updatedAt:'2026-02-01T00:00:00Z'},draft={...a,id:'c',published:false,updatedAt:'2026-03-01T00:00:00Z'};
 assert.deepEqual(projectShowcase('Aved',[a,b,draft]),{title:'B',publicUrl:'https://os.bmk.solutions/media-support/tour/t/b',published:true,unitCode:null});
 assert.deepEqual(projectShowcase('Aved',[draft]),{title:'Aved',publicUrl:null,published:false,unitCode:null});
});

// ── the fake VERA ──
const SECRET='fake-vera-shared-secret-at-least-32-characters-long';
type Seen={method:string;path:string;query:string;body:Record<string,unknown>|null;raw:string;headers:IncomingMessage['headers']};
let server:Server,veraOrigin='',seen:Seen[]=[],answer:(request:Seen)=>{status:number;body:unknown}=()=>({status:500,body:{}});
const nonces=new Set<string>();
const digest=(value:string)=>createHash('sha256').update(value).digest();
/** The contract's verification, written here independently of the client under test. */
function verify(request:IncomingMessage,raw:string):{status:number;error:string}|null{
 const app=request.headers['x-vera-app'],ts=String(request.headers['x-vera-ts']??''),nonce=String(request.headers['x-vera-nonce']??''),signature=String(request.headers['x-vera-signature']??'');
 if(app!=='tour360')return{status:401,error:'UNKNOWN_APP'};
 const url=new URL(request.url!,'http://fake'),pathAfterBase=url.pathname.replace(/^\/imo3d/,'');
 const canonical=`vera-int-v1\n${app}\n${ts}\n${nonce}\n${request.method}\n${pathAfterBase}?${url.search.slice(1)}\n${createHash('sha256').update(raw,'utf8').digest('base64url')}`;
 const expected='v1='+createHmac('sha256',SECRET).update(canonical).digest('base64url');
 if(!timingSafeEqual(digest(expected),digest(signature)))return{status:401,error:'BAD_SIGNATURE'};
 if(!/^\d{1,12}$/.test(ts)||Math.abs(Date.now()/1000-Number(ts))>60)return{status:401,error:'STALE_REQUEST'};
 if(!/^[A-Za-z0-9_-]{16,64}$/.test(nonce))return{status:401,error:'BAD_SIGNATURE'};
 if(request.method!=='GET'){if(nonces.has(nonce))return{status:409,error:'REPLAY'};nonces.add(nonce);}
 return null;
}
before(async()=>{
 server=createServer((request,response)=>{
  const chunks:Buffer[]=[];request.on('data',chunk=>chunks.push(chunk));request.on('end',()=>{
   const raw=Buffer.concat(chunks).toString('utf8'),url=new URL(request.url!,'http://fake'),refused=verify(request,raw);
   const entry:Seen={method:request.method!,path:url.pathname,query:url.search.slice(1),body:raw?JSON.parse(raw):null,raw,headers:request.headers};seen.push(entry);
   const {status,body}=refused?{status:refused.status,body:{ok:false,error:refused.error}}:answer(entry);
   response.writeHead(status,{'Content-Type':'application/json'});response.end(JSON.stringify(body));
  });
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',()=>resolve()));
 const address=server.address();veraOrigin=`http://127.0.0.1:${typeof address==='object'&&address?address.port:0}`;
});
after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));

// ── the tour's cloud handler, with Supabase faked at fetch ──
const origin='https://imo3d.example',adminSecret='synthetic-admin-secret-is-at-least-32-characters',fetchOriginal=globalThis.fetch,envOriginal={...process.env};
type Call={url:URL;method:string;body:unknown;raw:string};let calls:Call[]=[];let supabase:(call:Call)=>unknown=()=>{throw Error('unexpected');};
const result=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const adminCookie=()=>{const expiry=String(Date.now()+60_000);return `imo3d_session=${expiry}.${createHmac('sha256',adminSecret).update(expiry).digest('hex')}`;};
const req=(url:string,options:RequestInit={},admin=false)=>new Request(origin+'/api/imo3d/'+url,{...options,headers:{'x-forwarded-for':'198.51.100.23',...(admin?{cookie:adminCookie()}:{}),...(options.method&&options.method!=='GET'?{Origin:origin,'Content-Type':'application/json'}:{}),...Object.fromEntries(new Headers(options.headers))}});
const published=():Tour=>({...syntheticTour(),published:true,unit:{code:'A-101',area:120,price:900000,bedrooms:3,bathrooms:2}});
let rateLimit:(key:string)=>boolean=()=>true;
// Every failure path logs; each line is collected and checked for the buyer's number and name.
const errorOriginal=console.error;let logged:unknown[][]=[];
function standardSupabase(tour:Tour,developer:string|null='tour-dev-1'){
 let saved:Tour|null=null;
 return (call:Call)=>{
  const table=call.url.pathname.split('/').pop();
  if(table==='imo3d_rate_limit')return rateLimit(String((call.body as {p_key:string}).p_key));
  if(table==='imo3d_tours')return[{payload:tour}];
  if(table==='imo3d_project_developers')return developer?[{developer_id:developer}]:[];
  if(table==='imo3d_leads'&&call.method==='POST')return[call.body];
  if(table==='imo3d_project_branding')return[];
  if(table==='imo3d_projects')return[{id:tour.projectId,name:'Aved',location:'',created_at:'2026-01-01T00:00:00Z'}];
  if(table==='imo3d_list_tour_summaries')return[saved??tour];
  if(table==='imo3d_save_tour')return saved=(call.body as {p_tour:Tour}).p_tour;
  if(table==='imo3d_developers')return[{id:'tour-dev-1',name:'Al Awaly',created_at:'2026-01-01T00:00:00Z'}];
  throw Error('Unexpected Supabase request '+call.method+' '+call.url.pathname);
 };
}
beforeEach(()=>{
 Object.assign(process.env,{IMO3D_CLOUD:'1',SUPABASE_URL:'https://synthetic.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-key',IMO3D_ADMIN_SECRET:adminSecret,IMO3D_PASSWORD_LOGIN:'1',IMO3D_PUBLIC_ORIGIN:origin,MS_SUITE_ORIGIN:'https://os.bmk.solutions',VERA_INTEGRATION_SECRET:SECRET,VERA_INTEGRATION_ORIGIN:veraOrigin,IMO3D_DATA_DIR:path.resolve('work/vera-test-must-not-create-database')});
 calls=[];seen=[];logged=[];console.error=(...args:unknown[])=>{logged.push(args);};rateLimit=()=>true;clearVeraContextCache();answer=()=>({status:500,body:{ok:false,error:'UNSCRIPTED'}});
 globalThis.fetch=async(input,init)=>{
  const url=new URL(String(input instanceof Request?input.url:input));
  if(url.origin===veraOrigin)return fetchOriginal(input,init);
  const raw=typeof init?.body==='string'?init.body:'',call={url,method:init?.method??'GET',body:raw?JSON.parse(raw):null,raw};
  if(url.pathname.endsWith('/imo3d_admin_credentials'))return result([]);
  calls.push(call);return result(supabase(call));
 };
});
afterEach(()=>{console.error=errorOriginal;noPhoneAnywhere(logged.map(args=>JSON.stringify(args)));globalThis.fetch=fetchOriginal;for(const key of Object.keys(process.env))if(!(key in envOriginal))delete process.env[key];Object.assign(process.env,envOriginal);});
const leadBody=(tour:Tour,extra:Record<string,unknown>={})=>JSON.stringify({tourId:tour.id,name:'سارة التجربة',phone:'0501234567',note:'أرغب بزيارة',consent:true,website:'',...extra});
const noPhoneAnywhere=(texts:string[])=>{for(const text of texts)assert.doesNotMatch(text,/0?501234567|سارة/,'the tour keeps no number and no name');};

test('VERA-LEAD: the request reaches VERA signed, routed by the server\'s ids, and the tour keeps only the masked audit',async()=>{
 const tour=published();supabase=standardSupabase(tour);
 answer=request=>request.path==='/imo3d/api/integrations/v1/leads'?{status:200,body:{ok:true,duplicate:false,routed:'project'}}:{status:404,body:{}};
 const response=await cloudRoute(req('leads',{method:'POST',body:leadBody(tour,{developerId:'foreign-developer'})}));
 assert.equal(response.status,201,await response.clone().text());assert.deepEqual(await response.json(),{ok:true});
 assert.equal(seen.length,1);const [sent]=seen;
 assert.equal(sent.method,'POST');assert.equal(sent.path,'/imo3d/api/integrations/v1/leads');
 assert.deepEqual(sent.body,{app:'tour360',ref:{project:tour.projectId,developer:'tour-dev-1',developerHint:null,item:tour.id},buyer:{name:'سارة التجربة',phone:'0501234567',message:'أرغب بزيارة'},unit:{code:'A-101'},consent:{given:true,version:'vera-consent-2026-09-25'},context:{title:tour.title,url:'https://os.bmk.solutions/media-support/tour/t/synthetic-tour'},client:{ipHash:veraIpHash(SECRET,'198.51.100.23')}});
 assert.doesNotMatch(sent.raw,/198\.51\.100\.23/,'VERA never sees the raw IP');
 const audit=calls.filter(call=>call.url.pathname==='/rest/v1/imo3d_leads'&&call.method==='POST');
 assert.equal(audit.length,1);
 assert.deepEqual(Object.keys(audit[0].body as object).sort(),['created_at','forwarded_at','id','phone','tour_id','vera_routed']);
 assert.equal((audit[0].body as {phone:string}).phone,'05••••567');assert.equal((audit[0].body as {vera_routed:string}).vera_routed,'project');
 noPhoneAnywhere(calls.map(call=>call.url.href+call.raw));
 const keys=calls.filter(call=>call.url.pathname.endsWith('/imo3d_rate_limit')).map(call=>(call.body as {p_key:string}).p_key);
 assert.deepEqual(keys.map(key=>key.split(':')[0]),['lead-ip10','lead-ip60','lead','lead-global']);
 assert.equal(keys.some(key=>key.includes('198.51')),false,'rate-limit keys carry a hash of the address');
});

test('VERA-LEAD: a filled honeypot is told it succeeded and nothing is limited, sent or stored',async()=>{
 const tour=published();supabase=standardSupabase(tour);
 const response=await cloudRoute(req('leads',{method:'POST',body:leadBody(tour,{website:'https://spam.example'})}));
 assert.equal(response.status,201);assert.deepEqual(await response.json(),{ok:true});
 assert.equal(calls.length,0);assert.equal(seen.length,0);
});

test('VERA-LEAD: an off-market unit, a rate limit and an outage each answer the buyer in Arabic and store nothing',async()=>{
 const tour=published();supabase=standardSupabase(tour);
 answer=()=>({status:409,body:{ok:false,error:'UNIT_OFF_MARKET',message:'x'}});
 let response=await cloudRoute(req('leads',{method:'POST',body:leadBody(tour)}));
 assert.equal(response.status,409);assert.equal((await response.json()).error,'هذه الوحدة غير متاحة للبيع حاليًا.');
 answer=()=>({status:429,body:{ok:false,error:'RATE_LIMITED'}});
 response=await cloudRoute(req('leads',{method:'POST',body:leadBody(tour)}));assert.equal(response.status,429);
 assert.equal(logged.length,0,'the buyer can fix these: no incident is logged');
 answer=()=>({status:503,body:{ok:false,error:'PLATFORM_UNAVAILABLE'}});
 response=await cloudRoute(req('leads',{method:'POST',body:leadBody(tour)}));
 assert.equal(response.status,503);assert.equal((await response.json()).error,'تعذّر الإرسال، حاول مجددًا.');
 process.env.VERA_INTEGRATION_ORIGIN='http://127.0.0.1:9';
 response=await cloudRoute(req('leads',{method:'POST',body:leadBody(tour)}));assert.equal(response.status,503,'unreachable VERA');
 assert.deepEqual(logged,[['IMO3D VERA request failed',{app:'tour360',operation:'lead',status:503,code:'PLATFORM_UNAVAILABLE'}],['IMO3D VERA request failed',{app:'tour360',operation:'lead',status:0,code:'UNREACHABLE'}]]);
 assert.equal(calls.some(call=>call.url.pathname==='/rest/v1/imo3d_leads'),false,'nothing half-written');
});

test('VERA-LEAD: the per-IP limit refuses before VERA is asked; without a secret nothing is sent or kept',async()=>{
 const tour=published();supabase=standardSupabase(tour);rateLimit=key=>!key.startsWith('lead-ip10:');
 let response=await cloudRoute(req('leads',{method:'POST',body:leadBody(tour)}));
 assert.equal(response.status,429);assert.equal(seen.length,0);
 rateLimit=()=>true;delete process.env.VERA_INTEGRATION_SECRET;
 response=await cloudRoute(req('leads',{method:'POST',body:leadBody(tour)}));
 assert.equal(response.status,503);assert.equal(seen.length,0);assert.equal(calls.some(call=>call.url.pathname==='/rest/v1/imo3d_leads'),false);
 response=await cloudRoute(req('leads',{method:'POST',body:leadBody(tour,{consent:false})}));assert.equal(response.status,400);
});

test('VERA-LEAD: every request carries a fresh nonce, so a resubmission is not a replay',async()=>{
 const tour=published();supabase=standardSupabase(tour);
 answer=()=>({status:200,body:{ok:true,duplicate:seen.length>1,routed:'fallback'}});
 for(let i=0;i<2;i++)assert.equal((await cloudRoute(req('leads',{method:'POST',body:leadBody(tour)}))).status,201);
 assert.equal(seen.length,2);assert.notEqual(seen[0].headers['x-vera-nonce'],seen[1].headers['x-vera-nonce']);
 assert.equal(calls.filter(call=>call.url.pathname==='/rest/v1/imo3d_leads').map(call=>(call.body as {vera_routed:string}).vera_routed).join(),'fallback,fallback');
});

test('VERA-CONTEXT: the public tour carries interest from VERA\'s context, cached for a minute',async()=>{
 const tour=published();supabase=standardSupabase(tour);
 answer=()=>({status:200,body:{ok:true,linked:true,routed:'developer',developer:{name:'شركة العوالي العقارية'},project:null,whatsapp:'966500000000',privacyUrl:'https://os.bmk.solutions/alawaly/privacy',unit:null,consent:{version:'vera-consent-2026-09-25'}}});
 const first=await (await cloudRoute(req('tours/'+tour.id))).json();
 assert.deepEqual(first.interest,{enabled:true,developerName:'شركة العوالي العقارية',whatsapp:'966500000000',unitOffMarket:false,privacyUrl:'https://os.bmk.solutions/alawaly/privacy',beacon:'https://os.bmk.solutions/imo3d/api/events'});
 assert.equal(seen.length,1);assert.equal(seen[0].method,'GET');assert.equal(seen[0].path,'/imo3d/api/integrations/v1/context');
 assert.equal(seen[0].query,`project=${tour.projectId}&developer=tour-dev-1&unit=A-101`,'the app is the signed header, never a parameter');
 await cloudRoute(req('tours/'+tour.id));assert.equal(seen.length,1,'the second arrival is served from the 60 s cache');
 clearVeraContextCache();answer=()=>({status:200,body:{ok:true,linked:true,routed:'project',developer:{name:'X'},project:{name:'Y'},whatsapp:null,privacyUrl:null,unit:{code:'A-101',status:'reserved',offMarket:true}}});
 assert.equal((await (await cloudRoute(req('tours/'+tour.id))).json()).interest.unitOffMarket,true);
 clearVeraContextCache();answer=()=>({status:503,body:{ok:false}});
 const down=await (await cloudRoute(req('tours/'+tour.id))).json();
 assert.deepEqual(down.interest,{enabled:true,developerName:null,whatsapp:null,unitOffMarket:false,privacyUrl:null,beacon:'https://os.bmk.solutions/imo3d/api/events'},'VERA down: the button stays, the request will say so');
 delete process.env.VERA_INTEGRATION_SECRET;clearVeraContextCache();seen=[];
 assert.equal((await (await cloudRoute(req('tours/'+tour.id))).json()).interest.enabled,false);assert.equal(seen.length,0);
});

test('VERA-LINKS: only the studio session reads the catalogue and writes a link, with the project\'s published tour',async()=>{
 const tour=published();supabase=standardSupabase(tour);
 assert.equal((await cloudRoute(req('vera/catalogue'))).status,401);
 assert.equal((await cloudRoute(req('vera/link/project/'+tour.projectId,{method:'PUT',body:JSON.stringify({developerId:'os-dev',projectId:'os-project'})}))).status,401);
 assert.equal(seen.length,0);
 let linked=false;
 answer=request=>{
  if(request.path.endsWith('/catalogue'))return{status:200,body:{developers:[{id:'os-dev',name:'شركة العوالي العقارية',source:'platform'},{id:'local-dev',name:'Local',source:'local'}],projects:request.query.includes('developer=os-dev')?[{id:'os-project',name:'العوالي هومز – المروة'}]:[]}};
  if(request.path.endsWith('/links')){if(request.method==='DELETE'&&!linked)return{status:404,body:{ok:false,error:'NOT_FOUND'}};linked=request.method==='PUT';return{status:200,body:{ok:true}};}
  return{status:200,body:linked?{ok:true,linked:true,routed:'project',developer:{name:'شركة العوالي العقارية'},project:{name:'العوالي هومز – المروة'},whatsapp:null,privacyUrl:null,unit:null}:{ok:true,linked:false,routed:'fallback',developer:null,project:null,whatsapp:null,privacyUrl:null,unit:null}};
 };
 const catalogue=await (await cloudRoute(req('vera/catalogue',{},true))).json();
 assert.deepEqual(catalogue.developers,[{id:'os-dev',name:'شركة العوالي العقارية',local:false},{id:'local-dev',name:'Local',local:true}]);
 assert.deepEqual((await (await cloudRoute(req('vera/catalogue?developer=os-dev',{},true))).json()).projects,[{id:'os-project',name:'العوالي هومز – المروة'}]);
 const before=await (await cloudRoute(req('vera/link/project/'+tour.projectId,{},true))).json();
 assert.equal(before.routed,'fallback');assert.equal(before.linked,false);
 const saved=await (await cloudRoute(req('vera/link/project/'+tour.projectId,{method:'PUT',body:JSON.stringify({developerId:'os-dev',projectId:'os-project'})},true))).json();
 assert.equal(saved.linked,true);assert.deepEqual(saved.project,{id:'os-project',name:'العوالي هومز – المروة'},'the picker is preselected from the catalogue');assert.equal(saved.developer.id,'os-dev');
 const put=seen.find(request=>request.method==='PUT')!;
 assert.deepEqual(put.body,{kind:'project',ref:tour.projectId,developerId:'os-dev',projectId:'os-project',title:tour.title,publicUrl:'https://os.bmk.solutions/media-support/tour/t/synthetic-tour',published:true,unitCode:'A-101',actor:null});
 assert.equal((await cloudRoute(req('vera/link/project/'+tour.projectId,{method:'PUT',body:JSON.stringify({developerId:'os-dev'})},true))).status,400,'a project link names a project');
 assert.equal((await cloudRoute(req('vera/link/project/unknown-project',{},true))).status,404);
 const removed=await (await cloudRoute(req('vera/link/project/'+tour.projectId,{method:'DELETE'},true))).json();
 assert.equal(removed.linked,false);const deleted=seen.find(request=>request.method==='DELETE')!;assert.equal(deleted.query,`kind=project&ref=${tour.projectId}`);assert.equal(deleted.raw,'');
 assert.equal((await cloudRoute(req('vera/link/project/'+tour.projectId,{method:'DELETE'},true))).status,200,'unlinking twice is not an error');
 seen=[];await cloudRoute(req('vera/link/developer/tour-dev-1',{},true));
 assert.equal(seen[0].query,'project=developer-link%3Atour-dev-1&developer=tour-dev-1','a developer link is read past any project link');
 answer=request=>request.method==='PUT'?{status:409,body:{ok:false,error:'BAD_TARGET'}}:{status:200,body:{ok:true,routed:'fallback'}};
 const refused=await cloudRoute(req('vera/link/developer/tour-dev-1',{method:'PUT',body:JSON.stringify({developerId:'os-dev'})},true));
 assert.equal(refused.status,409);assert.match((await refused.json()).error,/لا يتبع هذا المطوّر/);
 answer=()=>({status:503,body:{}});
 const down=await cloudRoute(req('vera/link/developer/tour-dev-1',{},true));assert.equal(down.status,503);assert.match((await down.json()).error,/VERA/);
 const studio=readFileSync('src/components/imo3d/VeraLinkPicker.tsx','utf8');
 assert.match(studio,/state\.routed==="fallback"\?<span className="imo-vera-chip">\{UNLINKED_CHIP\}<\/span>/);assert.equal(UNLINKED_CHIP,'غير مربوط — الطلبات تذهب إلى صندوق BMK');
 assert.match(readFileSync('src/components/imo3d/ManagementDialogs.tsx','utf8'),/\{vera&&<VeraLinkPicker kind="project" refId=\{project\.id\}\/>\}/);
 assert.match(readFileSync('src/components/imo3d/DeveloperDirectory.tsx','utf8'),/\{vera&&editing!=="new"&&<VeraLinkPicker kind="developer" refId=\{editing\.id\}\/>\}/);
});

test('VERA-PUBLISH: publishing or unpublishing re-states a linked project in VERA; an unlinked one is left alone',async()=>{
 const draft={...published(),published:false};supabase=standardSupabase(draft);
 let routed='project';
 answer=request=>request.method==='PUT'?{status:200,body:{ok:true}}:request.path.endsWith('/catalogue')?{status:200,body:{ok:true,developers:[{id:'os-dev',name:'X',source:'platform'},{id:'other',name:'Z',source:'platform'}],projects:[{id:'os-project',name:'Y',source:'platform'}]}}
  :{status:200,body:{ok:true,linked:routed!=='fallback',routed,developer:routed==='fallback'?null:{name:'X'},project:routed==='project'?{name:'Y'}:null,whatsapp:null,privacyUrl:null,unit:null}};
 const patch=(tour:Tour,next:boolean)=>cloudRoute(req('tours/'+tour.id,{method:'PATCH',body:JSON.stringify({revision:tour.revision,published:next})},true));
 let response=await patch(draft,true);assert.equal(response.status,200,await response.clone().text());
 const put=seen.find(request=>request.method==='PUT')!;
 assert.equal(put.body!.ref,draft.projectId);assert.equal(put.body!.developerId,'os-dev');assert.equal(put.body!.projectId,'os-project');assert.equal(put.body!.published,true);assert.equal(put.body!.publicUrl,'https://os.bmk.solutions/media-support/tour/t/synthetic-tour');
 const live=published();seen=[];supabase=standardSupabase(live);response=await patch(live,false);
 const unpublished=seen.filter(request=>request.method==='PUT');assert.equal(unpublished.length,1,'unpublish re-states it too');assert.equal(unpublished[0].body!.published,false);assert.equal(unpublished[0].body!.publicUrl,null);
 supabase=standardSupabase(draft);
 seen=[];routed='fallback';clearVeraContextCache();response=await patch(draft,true);
 assert.equal(response.status,200);assert.equal(seen.filter(request=>request.method==='PUT').length,0);
 seen=[];routed='developer';response=await patch(draft,true);
 assert.equal(seen.filter(request=>request.method==='PUT').length,0,'a project filing through its developer link has no project entry to re-state');
 seen=[];response=await cloudRoute(req('tours/'+draft.id,{method:'PATCH',body:JSON.stringify({revision:draft.revision,title:'Renamed'})},true));
 assert.equal(response.status,200);assert.equal(seen.length,0,'an edit that does not publish asks VERA nothing');
 answer=()=>({status:503,body:{}});routed='project';response=await patch(draft,true);assert.equal(response.status,200,'VERA down: the tour is still published');
 // Two Developer OS developers with the linked name: the tour cannot tell which, so it writes nothing.
 seen=[];answer=request=>request.path.endsWith('/catalogue')?{status:200,body:{ok:true,developers:[{id:'os-dev',name:'X'},{id:'twin',name:'X'}],projects:[{id:'os-project',name:'Y'}]}}
  :request.method==='PUT'?{status:200,body:{ok:true}}:{status:200,body:{ok:true,linked:true,routed:'project',developer:{name:'X'},project:{name:'Y'}}};
 response=await patch(draft,true);assert.equal(response.status,200);assert.equal(seen.filter(request=>request.method==='PUT').length,0);
});

test('VERA-LOCAL: the local adapter forwards only with a secret, keeps the masked audit then, and its honeypot is silent too',()=>{
 const route=readFileSync('src/app/api/imo3d/[...path]/route.ts','utf8'),lead=/if\(resource==="leads"&&method==="POST"\)\{([\s\S]*?)\n  \}/.exec(route)?.[1]??'';
 assert.match(lead,/const raw=await readJSON\(request,8000\);if\(honeypotFilled\(raw\)\)return json\(\{ok:true\},201\);/);
 assert.match(lead,/const refusal=await leadLimitRefusal\(withinRateLimit,request,tour\.id,input\.phone\);if\(refusal\)return fail\(refusal,429\);/);
 assert.match(lead,/if\(!veraConfig\(\)\)\{addLead\(tour\.id,input\.name,input\.phone,input\.note\);return json\(\{ok:true\},201\);\}/);
 assert.match(lead,/if\(!sent\.ok\)return fail\(sent\.message,sent\.status\);\s*addLead\(tour\.id,"",maskLeadPhone\(input\.phone\),""\);/);
 assert.ok(lead.indexOf('leadLimitRefusal')<lead.indexOf('forwardTourLead'),'limits before VERA');
});
