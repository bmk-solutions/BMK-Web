import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import ts from 'typescript';
const root=path.resolve('work/cloud-upload-tests');mkdirSync(root,{recursive:true});
for(const [source,name] of [['src/lib/imo3d/cloud/upload-policy.ts','policy'],['src/components/imo3d/panorama-upload.ts','upload']])writeFileSync(path.join(root,name+'.cjs'),ts.transpileModule(readFileSync(source,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText);
writeFileSync(path.join(root,'client.js'),'exports.api=(...args)=>exports.handler(...args);');
const require=createRequire(import.meta.url),policy=require(path.join(root,'policy.cjs')),{uploadResumable,uploadPanoramas}=require(path.join(root,'upload.cjs'));
const sample={revision:4,scenes:[{sourceName:'Café.JPG'}]};
test('panorama upload validates exact100MiB bound and stale or canonically duplicated names',()=>{
 assert.equal(policy.uploadInitSchema.safeParse({name:'a.jpg',size:104857600,type:'image/jpeg',floor:0,revision:4}).success,true);
 assert.equal(policy.uploadInitSchema.safeParse({name:'a.jpg',size:104857601,type:'image/jpeg',floor:0,revision:4}).success,false);
 assert.ok(policy.uploadConflict(sample,{name:'Cafe\u0301.jpg',revision:4}));
 assert.ok(policy.uploadConflict(sample,{name:'new.jpg',revision:3}));
 assert.equal(policy.uploadConflict(sample,{name:'new.jpg',revision:4}),null);
});
test('invalid panorama geometry, EXIF rotation, animation and decompression bombs rejected',()=>{
 assert.equal(policy.panoramaProblem({format:'jpeg',width:16000,height:8000}),null);
 for(const meta of [{format:'gif',width:2048,height:1024},{format:'png',width:1024,height:1024},{format:'jpeg',width:2048,height:1024,orientation:6},{format:'webp',width:2048,height:1024,pages:2},{format:'jpeg',width:32768,height:16384}])assert.ok(policy.panoramaProblem(meta));
});
const session={token:'test-signed',bucket:'imo3d-private',objectKey:'uploads/tour/session/original',endpoint:'https://testproject.storage.supabase.co/storage/v1/upload/resumable/sign'};
test('TUS uses sixMiB chunks, private signed token and confirms progress without app proxy',async()=>{
 const original=globalThis.fetch;let offset=0,heads=0;const chunks=[];
 globalThis.fetch=async(input,init)=>{
  assert.ok(String(input).startsWith(session.endpoint));assert.equal(init.credentials,'omit');assert.equal(init.headers['x-signature'],'test-signed');assert.equal(init.headers.Authorization,undefined);assert.equal(init.headers['x-upsert'],undefined);
  if(init.method==='POST')return new Response(null,{status:201,headers:{Location:session.endpoint+'/upload-1'}});
  if(init.method==='HEAD'){heads++;return new Response(null,{headers:{'Upload-Offset':String(offset)}});}
  assert.equal(init.method,'PATCH');assert.equal(Number(init.headers['Upload-Offset']),offset);chunks.push(init.body.size);offset+=init.body.size;return new Response(null,{status:204,headers:{'Upload-Offset':String(offset)}});
 };
 try{const progress=[];await uploadResumable(new File([new Uint8Array(7*1024*1024)],'p.jpg',{type:'image/jpeg'}),session,p=>progress.push(p));assert.deepEqual(chunks,[6*1024*1024,1024*1024]);assert.equal(progress.at(-1),1);assert.equal(heads,0);}finally{globalThis.fetch=original;}
});
test('TUS refuses cross-origin continuation rather than sending signed token elsewhere',async()=>{
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return new Response(null,{status:201,headers:{Location:'https://elsewhere.invalid/storage/v1/upload/resumable/sign/1'}});};
 try{await assert.rejects(()=>uploadResumable(new File(['test'],'p.jpg',{type:'image/jpeg'}),session));assert.equal(calls,3);}finally{globalThis.fetch=original;}
});
test('TUS recovers a committed chunk after a lost network response using HEAD offset',async()=>{
 const original=globalThis.fetch;let offset=0,patches=0,heads=0;
 globalThis.fetch=async(input,init)=>{
  if(init.method==='POST')return new Response(null,{status:201,headers:{Location:session.endpoint+'/recover'}});
  if(init.method==='HEAD'){heads++;return new Response(null,{headers:{'Upload-Offset':String(offset)}});}
  patches++;offset+=init.body.size;throw new TypeError('response lost after storage commit');
 };
 try{await uploadResumable(new File(['test'],'p.jpg',{type:'image/jpeg'}),session);assert.equal(patches,1);assert.equal(heads,1);}finally{globalThis.fetch=original;}
});


const client=require(path.join(root,'client.js'));
test('100 uploads use bounded parallel transfers, ordered latest-revision commits and one session lookup',async()=>{
 const original=globalThis.fetch;let revision=4,lookup=0,inFlight=0,peak=0,committing=0;const committed=[],saved=[],progress=[];const events=[];
 client.handler=async(route,init)=>{
  if(route==='session'){lookup++;return {cloud:true};}const body=JSON.parse(init.body);
  if(route.endsWith('images-init')){assert.equal(body.revision,revision);events.push('init:'+body.name);return {...session,uploadId:body.name,token:body.name};}
  assert.ok(route.endsWith('images-finalize'));assert.equal(body.revision,revision);assert.equal(committing++,0);events.push('commit:'+body.uploadId);await new Promise(r=>setTimeout(r,1));committing--;committed.push(body.uploadId);return {id:'tour',revision:++revision};
 };
 globalThis.fetch=async(input,init)=>{if(init.method==='POST')return new Response(null,{status:201,headers:{Location:session.endpoint+'/'+init.headers['x-signature']}});assert.equal(init.method,'PATCH');inFlight++;peak=Math.max(peak,inFlight);await new Promise(r=>setTimeout(r,Number(init.headers['x-signature'].split('.')[0])%3===0?5:1));inFlight--;return new Response(null,{status:204,headers:{'Upload-Offset':String(init.body.size)}});};
 try{const files=Array.from({length:100},(_,i)=>new File(['data'],i+'.jpg',{type:'image/jpeg'}));const result=await uploadPanoramas({id:'tour',revision},files,0,{onSaved:t=>saved.push(t.revision),onProgress:p=>progress.push(p)});assert.equal(result.uploaded,100);assert.deepEqual(result.failures,[]);assert.deepEqual(committed,files.map(f=>f.name));assert.equal(lookup,1);assert.equal(peak,3);assert.equal(saved.at(-1),104);assert.equal(progress.at(-1).uploadedBytes,400);assert.equal(progress.at(-1).done,100);assert.ok(events.indexOf('init:2.jpg')<events.indexOf('commit:0.jpg'));assert.ok(events.indexOf('commit:2.jpg')<events.indexOf('init:3.jpg'));}finally{globalThis.fetch=original;}
});
test('one rejected file does not discard its batch; local uploads remain serial',async()=>{
 const original=globalThis.fetch;let revision=0;
 client.handler=async(route,init)=>{if(route==='session')return {cloud:true};const body=JSON.parse(init.body);assert.equal(body.revision,revision);if(route.endsWith('images-init')){if(body.name==='bad.jpg')throw Error('invalid image');return {...session,uploadId:body.name};}return {id:'tour',revision:++revision};};
 globalThis.fetch=async(input,init)=>init.method==='POST'?new Response(null,{status:201,headers:{Location:session.endpoint+'/test'}}):new Response(null,{status:204,headers:{'Upload-Offset':String(init.body.size)}});
 try{const files=['a.jpg','bad.jpg','c.jpg'].map(name=>new File(['x'],name,{type:'image/jpeg'}));const result=await uploadPanoramas({id:'tour',revision},files,0,{onSaved:()=>{}});assert.equal(result.uploaded,2);assert.equal(result.failures[0].file.name,'bad.jpg');assert.equal(result.tour.revision,2);
 let active=0,peak=0;client.handler=async(route,init)=>{if(route==='session')return {cloud:false};assert.ok(init.body instanceof FormData);active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,1));active--;return {id:'tour',revision:++revision};};const local=await uploadPanoramas({id:'tour',revision},files,0,{onSaved:()=>{}});assert.equal(local.uploaded,3);assert.equal(peak,1);
 }finally{globalThis.fetch=original;}
});
