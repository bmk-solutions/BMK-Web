import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import ts from 'typescript';
const root=path.resolve('work/cloud-upload-tests');mkdirSync(root,{recursive:true});
for(const [source,name] of [['src/lib/imo3d/cloud/upload-policy.ts','policy'],['src/components/imo3d/panorama-upload.ts','upload']])writeFileSync(path.join(root,name+'.cjs'),ts.transpileModule(readFileSync(source,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText);
writeFileSync(path.join(root,'client.js'),'exports.api=()=>{throw Error("API should not be called in TUS transport tests")};');
const require=createRequire(import.meta.url),policy=require(path.join(root,'policy.cjs')),{uploadResumable}=require(path.join(root,'upload.cjs'));
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
 const original=globalThis.fetch;let offset=0;const chunks=[];
 globalThis.fetch=async(input,init)=>{
  assert.ok(String(input).startsWith(session.endpoint));assert.equal(init.credentials,'omit');assert.equal(init.headers['x-signature'],'test-signed');assert.equal(init.headers.Authorization,undefined);assert.equal(init.headers['x-upsert'],undefined);
  if(init.method==='POST')return new Response(null,{status:201,headers:{Location:session.endpoint+'/upload-1'}});
  if(init.method==='HEAD')return new Response(null,{headers:{'Upload-Offset':String(offset)}});
  assert.equal(init.method,'PATCH');assert.equal(Number(init.headers['Upload-Offset']),offset);chunks.push(init.body.size);offset+=init.body.size;return new Response(null,{status:204,headers:{'Upload-Offset':String(offset)}});
 };
 try{const progress=[];await uploadResumable(new File([new Uint8Array(7*1024*1024)],'p.jpg',{type:'image/jpeg'}),session,p=>progress.push(p));assert.deepEqual(chunks,[6*1024*1024,1024*1024]);assert.equal(progress.at(-1),1);}finally{globalThis.fetch=original;}
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
 try{await uploadResumable(new File(['test'],'p.jpg',{type:'image/jpeg'}),session);assert.equal(patches,1);assert.equal(heads,2);}finally{globalThis.fetch=original;}
});

