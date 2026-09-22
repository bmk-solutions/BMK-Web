import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {z} from 'zod';
import {createGeminiPlanProvider} from '../src/lib/imo3d/gemini-plan-provider';
import type {geminiStructuredJson,geminiGenerateImage} from '../src/lib/imo3d/gemini-transport';
async function fixture(t:{after:(fn:()=>Promise<void>)=>void}){
 const root=await mkdtemp(path.join(os.tmpdir(),'imo-gemini-provider-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const dir=path.join(root,'work','subscription-plans','test-job');await mkdir(dir,{recursive:true});
 const png=await sharp({create:{width:256,height:256,channels:3,background:'#edf0e7'}}).png().toBuffer();
 await writeFile(path.join(dir,'guide.png'),png);
 await writeFile(path.join(dir,'floor-0.json'),JSON.stringify({floor:0,layout:{rooms:[{id:'r1',label:'غرفة',polygon:[{x:0,y:0},{x:1,y:0},{x:1,y:1}]}]},evidence:[{sceneId:'s1'},{sceneId:'s2'}]}));
 return {root,dir,png,guide:path.join(dir,'guide.png')};
}
test('Gemini renders before metadata review and owns the actual output path',async t=>{
 const f=await fixture(t),calls:string[]=[];const secret=Buffer.from('synthetic-private');
 const transport={generateImage:(async options=>{calls.push('render');assert.equal(options.apiKey,secret);assert.ok(options.prompt.includes('s2'));return {png:f.png,width:256,height:256,text:'',sources:[]};}) as typeof geminiGenerateImage,
 structuredJson:(async options=>{calls.push('review');assert.equal(options.images?.[0].id,'generated-plan');assert.ok(options.prompt.includes('transcript-only'));return {data:{imagePath:'untrusted-path',ok:true},sources:[]};}) as typeof geminiStructuredJson};
 const provider=createGeminiPlanProvider(f.root,use=>use(secret),transport);
 const value=await provider.execute(f.dir,'unused',z.object({imagePath:z.string(),ok:z.boolean()}),'review-0',new AbortController().signal,[f.guide]) as {imagePath:string};
 assert.deepEqual(calls,['render','review']);assert.ok(value.imagePath.startsWith(provider.imageRoot+path.sep));assert.ok((await readFile(value.imagePath)).equals(f.png));
 const record=await readFile(path.join(f.dir,'review-0.gemini.json'),'utf8');assert.ok(!record.includes(secret.toString()));
});
test('all photo attachments reach Gemini JSON analysis with no source omission',async t=>{
 const f=await fixture(t);let count=0;
 const transport={generateImage:(async()=>{assert.fail('must not render');}) as typeof geminiGenerateImage,structuredJson:(async options=>{count=options.images?.length??0;return {data:{ok:true},sources:[]};}) as typeof geminiStructuredJson};
 const provider=createGeminiPlanProvider(f.root,use=>use(Buffer.from('synthetic-only')),transport);
 await provider.execute(f.dir,'inspect all',z.object({ok:z.boolean()}),'photo-batch-0',new AbortController().signal,Array.from({length:100},()=>f.guide));assert.equal(count,100);
});
test('out-of-job file access and pre-cancellation fail before the key is loaded',async t=>{
 const f=await fixture(t);let reads=0;const provider=createGeminiPlanProvider(f.root,async()=>{reads++;throw Error('must not read');});
 const outside=path.join(f.root,'outside.png');await writeFile(outside,f.png);
 await assert.rejects(provider.execute(f.dir,'inspect',z.object({}), 'photo-batch-0',new AbortController().signal,[outside]),/INVALID_GENERATED_PATH/);
 const abort=new AbortController();abort.abort();await assert.rejects(provider.execute(f.dir,'inspect',z.object({}),'photo-batch-0',abort.signal,[f.guide]));assert.equal(reads,0);
});
test('cancellation after rendering prevents saving or reviewing the generated image',async t=>{
 const f=await fixture(t),abort=new AbortController();let reviewed=false;
 const transport={generateImage:(async()=>{abort.abort();return {png:f.png,width:256,height:256,text:'',sources:[]};}) as typeof geminiGenerateImage,structuredJson:(async()=>{reviewed=true;return {data:{},sources:[]};}) as typeof geminiStructuredJson};
 const provider=createGeminiPlanProvider(f.root,use=>use(Buffer.from('synthetic-only')),transport);
 await assert.rejects(provider.execute(f.dir,'render',z.object({}),'review-0',abort.signal,[f.guide]));assert.equal(reviewed,false);
});
