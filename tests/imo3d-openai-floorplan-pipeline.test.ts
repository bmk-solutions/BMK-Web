import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {runOpenAIFloorplanPipeline,validateFloorplanLayout,renderFloorplanLayoutSVG,type FloorplanLayout} from '../src/lib/imo3d/openai-floorplan-pipeline';

async function fixture() {
  const dir=await mkdtemp(path.resolve('work/openai-floorplan-test-'));
  const original=await sharp({create:{width:100,height:50,channels:3,background:'#dedede'}}).jpeg().toBuffer();
  const file=path.join(dir,'original.jpg'); await writeFile(file,original);
  const png=await sharp({create:{width:20,height:20,channels:3,background:'#ffffff'}}).png().toBuffer();
  return {dir,original,file,png};
}
function mock(png:Buffer,auditIds=['a','b']) {
  const calls:Record<string,unknown>[]=[];
  const fetchImpl:typeof fetch=async(url,init)=>{
    assert.equal(url,'https://api.openai.com/v1/responses');
    assert.equal(init?.redirect,'error');
    assert.equal((init?.headers as Record<string,string>).Authorization,'Bearer test-key');
    const body=JSON.parse(String(init?.body)); calls.push(body);
    assert.equal(body.store,false);
    let output;
    if(body.tools) output=[{type:'image_generation_call',result:png.toString('base64')}];
    else {
      const analysis=body.text.format.name==='scene_evidence';
      const sceneId=/scene ([^. ]+)/.exec(body.input[0].content[0].text)?.[1];
      const layout=body.text.format.name==='floorplan_layout';
      const layoutIds=layout?JSON.parse(/Scene IDs: (\[[^\]]*\])/.exec(body.input[0].content[0].text)![1]):[];
      const value=analysis?{sceneId,roomCategory:'unknown',visibleEvidence:['wall'],openings:[],distinctiveFeatures:[],uncertainties:['unobserved adjacency']}:layout?{rooms:[{id:'one',label:'غرفة',evidenceSceneIds:layoutIds,polygon:[{x:.1,y:.1},{x:.9,y:.1},{x:.9,y:.9},{x:.1,y:.9}],uncertainty:'Estimated geometry'}],openings:[],uncertainties:['Not surveyed']}:{verdict:'inconclusive',reviewedSceneIds:auditIds,issues:[],limitations:['Not surveyed']};
      output=[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}];
    }
    return Response.json({status:'completed',output});
  };
  return {fetchImpl,calls};
}
test('analyzes every original, merges each floor, audits coverage and reuses completed requests',async()=>{
  const f=await fixture(),m=mock(f.png),stages:string[]=[];
  const options={scenes:['a','b'].map(id=>({id,floor:0,path:f.file})),outputDir:f.dir,apiKey:'test-key',fetchImpl:m.fetchImpl,onProgress:(p:{stage:string})=>{stages.push(p.stage);}};
  const result=await runOpenAIFloorplanPipeline(options);
  assert.equal(result.status,'draft'); assert.equal(result.sceneCount,2);
  assert.deepEqual(result.floors[0].sceneIds,['a','b']);
  assert.equal(m.calls.length,5);
  assert.deepEqual(m.calls[3].tool_choice,{type:'image_generation'});
  assert.ok(stages.indexOf('layout')<stages.indexOf('generation'));
  assert.ok((await readFile(result.floors[0].guidePath)).length>0);
  assert.ok(JSON.parse(await readFile(result.floors[0].layoutPath,'utf8')).rooms.length);
  assert.equal(result.floors[0].audit.verdict,'inconclusive');
  assert.deepEqual(await readFile(f.file),f.original);
  await runOpenAIFloorplanPipeline(options);
  assert.equal(m.calls.length,5,'cache avoids duplicate paid calls');
  assert.equal(stages.at(-1),'complete');
});
test('missing audit scene prevents successful result',async()=>{
  const f=await fixture(),m=mock(f.png,['a']);
  await assert.rejects(runOpenAIFloorplanPipeline({scenes:['a','b'].map(id=>({id,floor:0,path:f.file})),outputDir:f.dir,apiKey:'test-key',fetchImpl:m.fetchImpl}),/omitted scene/);
  await assert.rejects(readFile(path.join(f.dir,'result.json')));
});
test('separate floors have separate generation and evidence',async()=>{
  const f=await fixture(),a=mock(f.png,['a']),b=mock(f.png,['b']);
  const fetchImpl:typeof fetch=(url,init)=>{
    const body=JSON.parse(String(init?.body));
    const isB=/scene b\.|floor 2|\["b"\]/.test(body.input[0].content[0].text);
    return (isB?b:a).fetchImpl(url,init);
  };
  const result=await runOpenAIFloorplanPipeline({scenes:[{id:'a',floor:-1,path:f.file},{id:'b',floor:2,path:f.file}],outputDir:f.dir,apiKey:'test-key',fetchImpl});
  assert.equal(result.floors[0].floor,-1);
  assert.equal(result.floors[1].floor,2);
  assert.deepEqual(result.floors.map(floor=>floor.sceneIds),[['a'],['b']]);
  assert.notEqual(result.floors[0].imagePath,result.floors[1].imagePath);
});
test('rejects invalid input and aborted jobs before network use',async()=>{
  const f=await fixture();let calls=0;
  const base={scenes:[{id:'a',floor:0,path:f.file}],outputDir:f.dir,apiKey:'test-key',fetchImpl:(async()=>{calls++;throw new Error('unexpected');}) as typeof fetch};
  await assert.rejects(runOpenAIFloorplanPipeline({...base,apiKey:''}),/KEY/);
  await assert.rejects(runOpenAIFloorplanPipeline({...base,scenes:[...base.scenes,...base.scenes]}),/unique/);
  await assert.rejects(runOpenAIFloorplanPipeline({...base,signal:AbortSignal.abort()}));
  assert.equal(calls,0);
});
test('provider failures are not retried or copied into logs containing secrets',async()=>{
  const f=await fixture();let calls=0;
  await assert.rejects(runOpenAIFloorplanPipeline({scenes:[{id:'a',floor:0,path:f.file}],outputDir:f.dir,apiKey:'test-key',fetchImpl:async()=>{calls++;return new Response('private provider details',{status:429});}}),/^Error: OpenAI floorplan request failed \(HTTP 429\)\.$/);
  assert.equal(calls,1);
});

function adjacentRooms():FloorplanLayout{return {
 rooms:[{id:'left',label:'الصالة',evidenceSceneIds:['a'],polygon:[{x:.1,y:.1},{x:.5,y:.1},{x:.5,y:.9},{x:.1,y:.9}],uncertainty:''},{id:'right',label:'المطبخ',evidenceSceneIds:['b'],polygon:[{x:.5,y:.1},{x:.9,y:.1},{x:.9,y:.9},{x:.5,y:.9}],uncertainty:''}],
 openings:[{id:'door',roomId:'left',otherRoomId:'right',kind:'door',edgeIndex:1,offset:.4,width:.2,evidenceSceneIds:['a','b'],uncertainty:''}],uncertainties:['Uncalibrated dimensions'],
};}
test('layout rejects unaccounted scenes and invented evidence',()=>{
 assert.throws(()=>validateFloorplanLayout(adjacentRooms(),['a','b','c']),/omitted scene/);
 const wrong=adjacentRooms();wrong.rooms[0].evidenceSceneIds=['invented'];
 assert.throws(()=>validateFloorplanLayout(wrong,['a','b']),/unknown.*scene/);
 const opening=adjacentRooms();opening.openings[0].evidenceSceneIds=['invented'];
 assert.throws(()=>validateFloorplanLayout(opening,['a','b']),/unknown.*scene/);
});
test('layout rejects dangling room references and openings contradicting adjacency',()=>{
 const wrong=adjacentRooms();wrong.openings[0].otherRoomId='missing';
 assert.throws(()=>validateFloorplanLayout(wrong,['a','b']),/unknown.*room/);
 const edge=adjacentRooms();edge.openings[0].edgeIndex=0;
 assert.throws(()=>validateFloorplanLayout(edge,['a','b']),/shared wall/);
 const outside=adjacentRooms();outside.openings[0].offset=.9;
 assert.throws(()=>validateFloorplanLayout(outside,['a','b']),/valid wall/);
 const duplicate=adjacentRooms();duplicate.rooms[1].id='left';
 assert.throws(()=>validateFloorplanLayout(duplicate,['a','b']),/duplicate room/);
});
test('unknown geometry stays unresolved and overlapping rooms are rejected',()=>{
 const unknown=adjacentRooms();unknown.rooms[1].polygon=null;unknown.rooms[1].uncertainty='No location evidence';unknown.openings=[];
 const valid=validateFloorplanLayout(unknown,['a','b']);assert.match(renderFloorplanLayoutSVG(valid),/geometry unresolved/);
 unknown.rooms[1].uncertainty='';assert.throws(()=>validateFloorplanLayout(unknown,['a','b']),/explicit uncertainty/);
 const overlap=adjacentRooms();overlap.rooms[1].polygon=overlap.rooms[0].polygon;
 assert.throws(()=>validateFloorplanLayout(overlap,['a','b']),/interiors overlap/);
});
test('deterministic guide cuts a real door gap through both shared wall strokes',async()=>{
 const layout=validateFloorplanLayout(adjacentRooms(),['a','b']);
 const svg=renderFloorplanLayoutSVG(layout);assert.equal(svg,renderFloorplanLayoutSVG(layout));
 const {data,info}=await sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer({resolveWithObject:true});
 assert.ok(data[(580*info.width+580)*info.channels]>200,'door midpoint is open');
 assert.ok(data[(300*info.width+580)*info.channels]<100,'shared wall outside door remains solid');
 assert.ok(!svg.includes('Al Hamra'));
});

test('image guide uses continuous uncertain walls without sealing real door gaps',async()=>{
 const layout=adjacentRooms();layout.rooms.forEach(room=>{room.uncertainty='Estimated wall boundary';});
 const review=renderFloorplanLayoutSVG(layout),solid=renderFloorplanLayoutSVG(layout,{solidWalls:true});
 assert.match(review,/stroke-dasharray="16 7"/);assert.match(review,/Dashed walls = uncertain/);
 assert.ok(!solid.includes('stroke-dasharray'));assert.ok(!solid.includes('Dashed walls'));
 assert.match(solid,/NOT SURVEYED.*Estimated geometry.*No metric scale/);
 const {data,info}=await sharp(Buffer.from(solid)).removeAlpha().raw().toBuffer({resolveWithObject:true});
 const pixel=(x:number,y:number)=>data[(y*info.width+x)*info.channels];
 for(let y=210;y<390;y++)assert.ok(pixel(580,y)<100,'wall outside doorway remains continuous at every pixel');
 assert.ok(pixel(580,580)>200,'actual doorway remains open');
 assert.equal(renderFloorplanLayoutSVG(layout),review,'image mode does not modify review data or later exports');
});

test('opening cut cannot erase an unrelated parallel wall only 10px away',async()=>{
 const layout=adjacentRooms();
 layout.rooms[1].polygon=[{x:.51,y:.1},{x:.91,y:.1},{x:.91,y:.9},{x:.51,y:.9}];
 layout.openings[0].otherRoomId=null;
 validateFloorplanLayout(layout,['a','b']);
 const {data,info}=await sharp(Buffer.from(renderFloorplanLayoutSVG(layout,{solidWalls:true}))).removeAlpha().raw().toBuffer({resolveWithObject:true});
 const pixel=(x:number,y:number)=>data[(y*info.width+x)*info.channels];
 assert.ok(pixel(580,580)>200,'the hosted doorway is open');
 // The prior global 20px mask erased x=585..589 of this 10px wall.
 for(let x=586;x<=593;x++)assert.ok(pixel(x,580)<100,`unrelated wall remains intact at x=${x}`);
});

test('closed unknown doorway guide retains observed leaves and only opens confirmed room routes',async()=>{
 const layout=adjacentRooms();
 layout.openings.push({id:'unseen',roomId:'left',otherRoomId:null,kind:'door',edgeIndex:3,offset:.4,width:.2,evidenceSceneIds:['a'],uncertainty:'Destination cannot be seen'});
 const before=JSON.stringify(layout),review=renderFloorplanLayoutSVG(layout);
 const svg=renderFloorplanLayoutSVG(layout,{solidWalls:true,unknownDoorways:'closed'});
 const {data,info}=await sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer({resolveWithObject:true});
 const pixel=(x:number,y:number)=>[...data.subarray((y*info.width+x)*info.channels,(y*info.width+x)*info.channels+3)];
 assert.deepEqual(pixel(180,580),[139,119,98],'unknown destination is represented as a closed wood leaf');
 assert.deepEqual(pixel(176,580),[53,59,56],'closed observation retains its surrounding wall');
 assert.ok(pixel(580,580)[0]>200,'confirmed inter-room door still cuts both wall strokes');
 assert.deepEqual(pixel(580,300),[53,59,56],'remaining shared wall stays solid');
 const legacy=await sharp(Buffer.from(review)).removeAlpha().raw().toBuffer();
 assert.ok(legacy[(580*info.width+180)*info.channels]>200,'default review representation is unchanged');
 assert.equal(JSON.stringify(layout),before,'conservative guide does not rewrite unknown topology');
 assert.equal(renderFloorplanLayoutSVG(layout),review);
});
