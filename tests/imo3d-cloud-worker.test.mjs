import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {imageFingerprint} from '../src/lib/imo3d/processing-jobs.ts';
import {buildLocalInputPlan,createJobWorkspace,createWorkerTransport,hashBytes,pollCloudJobs,processCloudJob,runLocalReconstruction,seedLocalMirror,validateLocalResult,verifyDownloadedObject} from '../scripts/lib/imo3d-cloud-worker.mjs';

const owner='test-worker';
function fixture(){
  const scenes=['a','b'].map((id,index)=>({id:`scene-${id}`,name:`Scene ${id}`,room:`Room ${id}`,floor:0,image:`/api/imo3d/assets/asset-${id}`,preview:`/api/imo3d/assets/asset-${id}`,thumbnail:`/api/imo3d/assets/asset-${id}`,sourceName:`source-${id}.jpg`,position:{x:index,y:1.6,z:0},yaw:0,links:[`scene-${id==='a'?'b':'a'}`]}));
  const tour={id:'tour-test',projectId:'project-test',title:'Synthetic test',revision:4,published:false,createdAt:'2020-01-01T00:00:00.000Z',updatedAt:'2020-01-01T00:00:00.000Z',scenes,plans:[],unit:{code:'test',area:null,price:null,bedrooms:null,bathrooms:null},quality:{positioned:2,depthScenes:0,components:1,warnings:[]}};
  const blobs=new Map(),assets=scenes.map(scene=>{const bytes=Buffer.from(`synthetic-${scene.id}`),id=scene.image.split('/').at(-1),key=`inputs/${tour.id}/${id}.webp`;blobs.set(key,bytes);return{id,tour_id:tour.id,file:`${id}.webp`,mime:'image/webp',storage_key:key,sha256:hashBytes(bytes),byte_size:bytes.length};});
  const job={id:'job-test',tour_id:tour.id,status:'running',lease_owner:owner,lease_until:Date.now()+30000,cancel_requested:false,input_hash:imageFingerprint(scenes)};
  return {tour,assets,originals:[],blobs,job};
}
async function workspace(){const base=path.join(process.cwd(),'work','cloud-worker-tests');await mkdir(base,{recursive:true});return mkdtemp(path.join(base,'run-'));}
function harness(data,{lease=true,conflict=false}={}){
  const calls=[],uploads=[];
  const transport={
    async query(table){if(table==='tours')return[{payload:structuredClone(data.tour),revision:data.tour.revision,project_id:data.tour.projectId}];if(table==='assets')return data.assets;if(table==='scene_originals')return data.originals;throw Error('Unexpected table');},
    async rpc(name,args){calls.push({name,args});if(name==='heartbeat_job')return lease;if(name==='fail_job')return true;if(name==='claim_job')return data.job;if(name==='commit_job'){if(conflict){const error=Error('Conflict');error.code='40001';throw error;}return{...args.p_tour,revision:args.p_expected_revision+1};}throw Error('Unexpected RPC');},
    async download(key){const bytes=data.blobs.get(key);if(!bytes)throw Error('Missing test blob');return bytes;},
    async upload(key,bytes,mime){uploads.push({key,bytes:Buffer.from(bytes),mime});},
  };
  const executeLocal=async({directory,onProgress})=>{
    const local=new DatabaseSync(path.join(directory,'imo3d.sqlite'),{readOnly:true});
    try{const row=local.prepare('SELECT payload FROM tours WHERE id=?').get(data.tour.id);assert.deepEqual(JSON.parse(row.payload),data.tour);}finally{local.close();}
    for(const asset of data.assets)assert.deepEqual(await readFile(path.join(directory,'assets',asset.file)),data.blobs.get(asset.storage_key));
    onProgress(90,'Synthetic local result');
    return{tour:{...structuredClone(data.tour),revision:data.tour.revision+1},status:'review',stage:'Review result',result:{registered:2,total:2,links:1,components:1,scale:'relative'},warnings:[],assets:data.assets};
  };
  return {transport,calls,uploads,executeLocal};
}

test('input preparation falls back to the scoped image when no original was imported',()=>{
  const data=fixture(),input=buildLocalInputPlan(data.tour,data.assets,[]);
  assert.equal(input.downloads.length,2);assert.equal(input.originals.length,0);
  assert.deepEqual(input.tour,data.tour);assert.notEqual(input.tour,data.tour);
});

test('input preparation rejects cross-tour records, unsafe paths and filename collisions',()=>{
  const data=fixture();
  assert.throws(()=>buildLocalInputPlan(data.tour,[{...data.assets[0],tour_id:'other'},data.assets[1]],[]),/OWNERSHIP/);
  assert.throws(()=>buildLocalInputPlan(data.tour,[{...data.assets[0],file:'../source.sqlite'},data.assets[1]],[]),/PATH/);
  assert.throws(()=>buildLocalInputPlan(data.tour,[data.assets[0],{...data.assets[1],file:data.assets[0].file}],[]),/CONFLICTING_LOCAL_FILENAME/);
  assert.throws(()=>buildLocalInputPlan(data.tour,[{...data.assets[0],storage_key:'../private'},data.assets[1]],[]),/STORAGE_KEY/);
});

test('downloaded objects must match declared bytes and checksum',()=>{
  const data=fixture(),record=data.assets[0],bytes=data.blobs.get(record.storage_key);
  assert.doesNotThrow(()=>verifyDownloadedObject(bytes,record));
  assert.throws(()=>verifyDownloadedObject(bytes,{...record,byte_size:1}),/SIZE_MISMATCH/);
  assert.throws(()=>verifyDownloadedObject(bytes,{...record,sha256:'0'.repeat(64)}),/HASH_MISMATCH/);
});

test('each job attempt is isolated and existing mirror databases cannot be reseeded',async()=>{
  const root=await workspace(),data=fixture();
  const first=await createJobWorkspace(root,data.job.id),second=await createJobWorkspace(root,data.job.id);
  assert.notEqual(first,second);assert.ok(first.startsWith(path.join(root,'work','cloud-worker')+path.sep));
  seedLocalMirror(first,buildLocalInputPlan(data.tour,data.assets,[]),data.job);
  assert.throws(()=>seedLocalMirror(first,buildLocalInputPlan(data.tour,data.assets,[]),data.job),/NONEMPTY_MIRROR/);
  await assert.rejects(createJobWorkspace(root,'../escape'),/IDENTIFIER/);
});

test('a local processing result preserves source images and metadata',()=>{
  const data=fixture(),local={tour:structuredClone(data.tour),status:'review'};
  assert.doesNotThrow(()=>validateLocalResult(data.tour,local));
  local.tour.scenes[0].image='/api/imo3d/assets/other';assert.throws(()=>validateLocalResult(data.tour,local),/SOURCE_MEDIA/);
  local.tour=structuredClone(data.tour);local.tour.unit.price=100;assert.throws(()=>validateLocalResult(data.tour,local),/PROJECT_METADATA/);
});

test('processing reads a cloud copy and commits with lease, revision, hash and asset metadata atomically',async()=>{
  const root=await workspace(),data=fixture(),run=harness(data);
  await mkdir(path.join(root,'.imo3d-data'));await writeFile(path.join(root,'.imo3d-data','imo3d.sqlite'),'source-sentinel');
  const result=await processCloudJob({root,transport:run.transport,job:data.job,owner,signal:new AbortController().signal,executeLocal:async options=>{
    const local=await run.executeLocal(options);await writeFile(path.join(options.directory,'assets','new-model.surface.bin'),Buffer.from('model'));
    local.assets=[...local.assets,{id:'new-model',tour_id:data.tour.id,file:'new-model.surface.bin',mime:'application/octet-stream'}];return local;
  }});
  assert.equal(result.status,'committed');assert.equal(result.revision,data.tour.revision+1);
  const commit=run.calls.find(call=>call.name==='commit_job').args;
  assert.equal(commit.p_expected_revision,data.tour.revision);assert.equal(commit.p_input_hash,data.job.input_hash);assert.equal(commit.p_owner,owner);
  assert.equal(commit.p_assets.length,1);assert.equal(commit.p_assets[0].sha256,hashBytes(Buffer.from('model')));
  assert.equal(commit.p_status,'review');assert.equal(run.uploads.length,1);assert.ok(run.uploads[0].key.startsWith(`processing/${data.tour.id}/${data.job.id}/`));
  assert.equal(await readFile(path.join(root,'.imo3d-data','imo3d.sqlite'),'utf8'),'source-sentinel');
});

test('revision conflicts preserve cloud edits and never retry a stale result',async()=>{
  const root=await workspace(),data=fixture(),run=harness(data,{conflict:true});
  const result=await processCloudJob({root,transport:run.transport,job:data.job,owner,signal:new AbortController().signal,executeLocal:run.executeLocal});
  assert.equal(result.status,'stale');assert.equal(run.calls.filter(call=>call.name==='commit_job').length,1);
  const fail=run.calls.find(call=>call.name==='fail_job').args;assert.equal(fail.p_retry,false);assert.equal(fail.p_error,'STALE_PROCESSING_INPUT');
});

test('lost leases abort local processing before upload or commit',async()=>{
  const root=await workspace(),data=fixture(),run=harness(data,{lease:false});
  const result=await processCloudJob({root,transport:run.transport,job:data.job,owner,signal:new AbortController().signal,leaseOptions:{heartbeatMs:10},executeLocal:async({signal})=>{
    if(signal.aborted)throw signal.reason;
    await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  }});
  assert.equal(result.status,'lease_lost');assert.equal(run.uploads.length,0);assert.equal(run.calls.some(call=>call.name==='commit_job'||call.name==='fail_job'),false);
});

test('an outer stop cancels local work and requests a retry without committing',async()=>{
  const root=await workspace(),data=fixture(),run=harness(data),controller=new AbortController();
  const result=await processCloudJob({root,transport:run.transport,job:data.job,owner,signal:controller.signal,executeLocal:async({signal})=>{controller.abort(Error('stop'));signal.throwIfAborted();}});
  assert.equal(result.status,'stopped');assert.equal(run.calls.some(call=>call.name==='commit_job'),false);assert.equal(run.calls.find(call=>call.name==='fail_job').args.p_retry,true);
});

test('outward-only transport pins the Supabase origin, refuses redirects and never overwrites objects',async()=>{
  const calls=[];
  const transport=createWorkerTransport({url:'https://testproject.supabase.co',projectRef:'testproject',serviceRoleKey:'test-secret'},{fetchImpl:async(url,init)=>{calls.push({url,init});return new Response('{}',{status:200,headers:{'Content-Type':'application/json'}});}});
  await transport.upload('processing/test/model.bin',Buffer.from('test'),'application/octet-stream');
  assert.equal(calls[0].init.redirect,'error');assert.equal(calls[0].init.headers.get('x-upsert'),'false');assert.ok(calls[0].url.startsWith('https://testproject.storage.supabase.co/storage/'));
  assert.throws(()=>createWorkerTransport({url:'https://testproject.supabase.co',projectRef:'another',serviceRoleKey:'test'}),/PROJECT_MISMATCH/);
  await assert.rejects(transport.download('../other'),/STORAGE_KEY/);
  await transport.rpc('claim_job',{p_owner:'worker'});assert.ok(calls[1].url.startsWith('https://testproject.supabase.co/rest/'));
});

test('chunked downloads enforce the byte cap without trusting Content-Length',async()=>{
  let cancelled=false;
  const transport=createWorkerTransport({url:'https://testproject.supabase.co',serviceRoleKey:'test'},{fetchImpl:async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(4));controller.enqueue(new Uint8Array(4));},cancel(){cancelled=true;}}))});
  await assert.rejects(transport.download('test/object',{maxBytes:4}),/TOO_LARGE/);assert.equal(cancelled,true);
});

test('once mode claims only one scoped job and returns after processing',async()=>{
  const root=await workspace(),data=fixture(),run=harness(data),statuses=[];
  const result=await pollCloudJobs({root,transport:run.transport,signal:new AbortController().signal,once:true,owner,executeLocal:run.executeLocal,onStatus:status=>statuses.push(status)});
  assert.equal(result.processed,1);assert.equal(run.calls.filter(call=>call.name==='claim_job').length,1);assert.equal(statuses[0].status,'committed');
});

test('the subprocess receives only the isolated mirror and returns its saved result',async()=>{
  const root=await workspace(),data=fixture(),directory=await createJobWorkspace(root,data.job.id);
  seedLocalMirror(directory,buildLocalInputPlan(data.tour,data.assets,[]),data.job);
  await mkdir(path.join(root,'scripts'));
  await writeFile(path.join(root,'scripts','imo3d-worker.mjs'),`
    import {DatabaseSync} from 'node:sqlite';
    import path from 'node:path';
    if(process.env.SUPABASE_SERVICE_ROLE_KEY||process.env.OPENAI_API_KEY)throw Error('Cloud credentials reached the local pipeline');
    const db=new DatabaseSync(path.join(process.env.IMO3D_DATA_DIR,'imo3d.sqlite'));
    const row=db.prepare('SELECT payload FROM tours').get(),tour=JSON.parse(row.payload);tour.revision++;
    db.prepare('UPDATE tours SET payload=?,revision=?').run(JSON.stringify(tour),tour.revision);
    db.prepare("UPDATE processing_jobs SET status='review',progress=100,stage='Stub complete',result='{}'").run();
    db.close();console.log('Isolated child finished');
  `);
  const previous=process.env;
  try{
    process.env={...previous,SUPABASE_SERVICE_ROLE_KEY:'synthetic-test-key',OPENAI_API_KEY:'synthetic-openai-key'};
    const result=await runLocalReconstruction({root,directory,job:data.job,signal:new AbortController().signal,onProgress:()=>{}});
    assert.equal(result.status,'review');assert.equal(result.tour.revision,data.tour.revision+1);
    assert.match(await readFile(path.join(directory,'worker.log'),'utf8'),/Isolated child finished/);
  }finally{process.env=previous;}
});

test('cancelling the subprocess changes only its isolated queue and waits for exit',async()=>{
  const root=await workspace(),data=fixture(),directory=await createJobWorkspace(root,data.job.id);
  seedLocalMirror(directory,buildLocalInputPlan(data.tour,data.assets,[]),data.job);
  await mkdir(path.join(root,'scripts'));
  await writeFile(path.join(root,'scripts','imo3d-worker.mjs'),`
    import {DatabaseSync} from 'node:sqlite';import path from 'node:path';
    const db=new DatabaseSync(path.join(process.env.IMO3D_DATA_DIR,'imo3d.sqlite'));
    const poll=setInterval(()=>{if(db.prepare('SELECT cancel_requested FROM processing_jobs').get().cancel_requested){clearInterval(poll);db.close();}},10);
  `);
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(Error('Test stop')),100);
  try{await assert.rejects(runLocalReconstruction({root,directory,job:data.job,signal:controller.signal,onProgress:()=>{}}),/Test stop/);}finally{clearTimeout(timer);}
  const db=new DatabaseSync(path.join(directory,'imo3d.sqlite'),{readOnly:true});
  try{assert.equal(db.prepare('SELECT status FROM processing_jobs').get().status,'cancelled');}finally{db.close();}
});