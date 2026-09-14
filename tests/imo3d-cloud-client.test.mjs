import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=await readFile(path.join(root,'src/lib/imo3d/cloud/client.ts'),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const compiledModule={exports:{}};new Function('exports','module',compiled)(compiledModule.exports,compiledModule);
const client=compiledModule.exports;
async function mocked(run){
  const originalFetch=globalThis.fetch,oldUrl=process.env.SUPABASE_URL,oldKey=process.env.SUPABASE_SERVICE_ROLE_KEY;
  const calls=[];process.env.SUPABASE_URL='https://abcdefghijklmnopqrst.supabase.co';process.env.SUPABASE_SERVICE_ROLE_KEY='synthetic-private-server-key';
  let result=Response.json([]);globalThis.fetch=async(url,init)=>{calls.push({url,init});return result.clone();};
  try{await run({calls,response:value=>{result=value;}});}finally{globalThis.fetch=originalFetch;if(oldUrl===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=oldUrl;if(oldKey===undefined)delete process.env.SUPABASE_SERVICE_ROLE_KEY;else process.env.SUPABASE_SERVICE_ROLE_KEY=oldKey;}
}
test('server transport uses service headers and auto-prefixed tables without exposing credentials in URL',async()=>mocked(async({calls})=>{
  await client.cloudQuery('projects','id=eq.example');
  assert.equal(calls[0].url,'https://abcdefghijklmnopqrst.supabase.co/rest/v1/imo3d_projects?id=eq.example');
  assert.equal(calls[0].init.headers.get('Authorization'),'Bearer synthetic-private-server-key');assert.equal(calls[0].init.cache,'no-store');assert.ok(!calls[0].url.includes('synthetic-private'));
  await assert.rejects(client.cloudQuery('../outside',''),/identifier/);await assert.rejects(client.cloudQuery('projects','','DELETE'),/Unscoped/);assert.equal(calls.length,1);
}));
test('object uploads never overwrite and unsafe paths are rejected',async()=>mocked(async({calls,response})=>{
  response(Response.json({}));await client.cloudUploadObject('tour/scene.webp',new Uint8Array([1,2]),'image/webp');assert.equal(calls[0].init.method,'POST');assert.equal(calls[0].init.headers.get('x-upsert'),'false');assert.ok(calls[0].url.startsWith('https://abcdefghijklmnopqrst.storage.supabase.co/'));
  await assert.rejects(client.cloudUploadObject('../other/data',new Uint8Array(),'image/webp'),/Invalid storage/);assert.equal(calls.length,1);
}));
test('signed URLs normalize the storage prefix and reject unexpected origins',async()=>mocked(async({response})=>{
  response(Response.json({signedURL:'/object/sign/imo3d-private/image.webp?token=signed'}));assert.equal(await client.cloudSignedDownload('image.webp'),'https://abcdefghijklmnopqrst.storage.supabase.co/storage/v1/object/sign/imo3d-private/image.webp?token=signed');
  response(Response.json({signedURL:'https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/sign/imo3d-private/image.webp?token=signed'}));assert.ok((await client.cloudSignedDownload('image.webp')).startsWith('https://abcdefghijklmnopqrst.supabase.co/'));
  response(Response.json({signedURL:'https://untrusted.invalid/file'}));await assert.rejects(client.cloudSignedDownload('image.webp'),/Unexpected/);
  response(Response.json({url:'/object/upload/sign/imo3d-private/image.webp?token=upload-token'}));const upload=await client.cloudSignedUpload('image.webp');assert.equal(upload.token,'upload-token');assert.equal(upload.path,'image.webp');
}));
test('revision conflict maps to409 and remote diagnostics never leak server secrets',async()=>mocked(async({response})=>{
  response(Response.json({code:'40001',message:'sensitive remote diagnostics'},{status:500}));await assert.rejects(client.cloudRpc('save_tour',{}),error=>error.status===409&&error.message==='CONFLICT'&&!String(error).includes('sensitive'));
  response(Response.json({code:'synthetic-private-server-key data',message:'sensitive'},{status:400}));await assert.rejects(client.cloudRpc('save_tour',{}),error=>error.code==='400'&&!JSON.stringify(error).includes('synthetic-private'));
}));
