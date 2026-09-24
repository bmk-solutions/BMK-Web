import type {Plan,Scene,TexturedMesh} from "./model";
import {storedAssetPath} from "./base-path.ts";

export const meshModelMime="model/gltf-binary";
export const maxMeshBytes=40*1024*1024,maxMeshTriangles=350_000,maxMeshTexels=16_777_216;
export const meshModelSource="local-room-depth-texture-v1" as const;
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
const integer=(v:unknown,min=0,max=Number.MAX_SAFE_INTEGER):v is number=>typeof v==="number"&&Number.isSafeInteger(v)&&v>=min&&v<=max;
const coordinate=(v:unknown):v is number=>typeof v==="number"&&Number.isFinite(v)&&Math.abs(v)<=1000;
function fail():never{throw new Error("Invalid or unsupported textured apartment model");}

/** Exact canonical geometry snapshot; room labels are deliberately excluded. */
export function meshGeometrySignature(plan:Pick<Plan,"floor"|"authoredRooms"|"generatedRooms"|"generatedFrom">):string{
  const rooms=plan.authoredRooms??plan.generatedRooms??[];
  return JSON.stringify({floor:plan.floor,ceilingHeight:plan.generatedFrom?.ceilingHeight??null,rooms:[...rooms].sort((a,b)=>a.id.localeCompare(b.id)).map(room=>({
    id:room.id,outline:room.outline.map(p=>[p.x,p.z]),openings:[...room.openings].sort((a,b)=>a-b),
    doors:(room.doorwayCandidates??[]).map(door=>[door.edge,door.offset,door.width,door.pairedRoomId]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),
  }))});
}
export function currentTexturedMesh(plan:Plan,scenes:readonly Scene[]):TexturedMesh|undefined{
  const model=plan.texturedMesh;
  if(!model||model.source!==meshModelSource||model.units!=="camera_height"||!/^\/api\/imo3d\/assets\/[\w-]{1,80}$/.test(storedAssetPath(model.url))||
    !integer(model.byteLength,32,maxMeshBytes)||!integer(model.triangleCount,1,maxMeshTriangles)||!coordinate(model.floorHeight)||
    !coordinate(model.ceilingHeight)||model.ceilingHeight<=0||model.ceilingHeight>10||typeof model.geometrySignature!=="string"||model.geometrySignature.length>250000||
    !(plan.authoredRooms??plan.generatedRooms)?.length||model.geometrySignature!==meshGeometrySignature(plan)||
    !Array.isArray(model.cameras)||model.cameras.length<2||model.cameras.length>300||model.cameras.some(camera=>!record(camera))||new Set(model.cameras.map(c=>c.id)).size!==model.cameras.length)return;
  const byId=new Map(scenes.map(scene=>[scene.id,scene]));
  for(const camera of model.cameras){const scene=byId.get(camera.id);if(!scene||scene.floor!==plan.floor||scene.image!==camera.image||!scene.position||!record(camera.position)||
    ![camera.position.x,camera.position.y,camera.position.z,camera.yaw].every(coordinate)||scene.yaw!==camera.yaw||
    (["x","y","z"] as const).some(axis=>scene.position![axis]!==camera.position[axis]))return;}
  return model;
}

function imageSize(bytes:Uint8Array,mime:unknown):[number,number]{
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(mime==="image/png"){
    if(bytes.length<33||view.getUint32(0)!==0x89504e47||view.getUint32(4)!==0x0d0a1a0a||view.getUint32(8)!==13||view.getUint32(12)!==0x49484452)fail();
    return[view.getUint32(16),view.getUint32(20)];
  }
  if(mime!=="image/jpeg"||bytes.length<4||view.getUint16(0)!==0xffd8)fail();
  for(let offset=2,segments=0;offset+4<=bytes.length&&segments++<10000;){
    if(bytes[offset++]!==255)fail();while(bytes[offset]===255)offset++;
    const marker=bytes[offset++];if(marker===0xd9||marker===0xda)break;
    if(marker===0x01||marker>=0xd0&&marker<=0xd7)continue;
    if(offset+2>bytes.length)fail();const length=view.getUint16(offset);if(length<2||offset+length>bytes.length)fail();
    if([0xc0,0xc1,0xc2].includes(marker)){if(length<8)fail();return[view.getUint16(offset+5),view.getUint16(offset+3)];}offset+=length;
  }return fail();
}

export type TexturedMeshStats={byteLength:number;triangleCount:number;vertexCount:number;textureCount:number;texels:number;bounds:{min:{x:number;y:number;z:number};max:{x:number;y:number;z:number}}};
/** Validate a deliberately small static glTF subset before any loader allocates images or follows references. */
export function validateTexturedMeshGlb(buffer:ArrayBuffer,metadata?:Pick<TexturedMesh,"byteLength"|"triangleCount">):TexturedMeshStats{
  if(buffer.byteLength<32||buffer.byteLength>maxMeshBytes)fail();
  const view=new DataView(buffer);if(view.getUint32(0,true)!==0x46546c67||view.getUint32(4,true)!==2||view.getUint32(8,true)!==buffer.byteLength)fail();
  const jsonLength=view.getUint32(12,true);if(!integer(jsonLength,2,2*1024*1024)||jsonLength%4||20+jsonLength+8>buffer.byteLength||view.getUint32(16,true)!==0x4e4f534a)fail();
  const binHeader=20+jsonLength,binLength=view.getUint32(binHeader,true),binStart=binHeader+8;
  if(view.getUint32(binHeader+4,true)!==0x004e4942||binLength%4||binStart+binLength!==buffer.byteLength)fail();
  const raw:unknown=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(new Uint8Array(buffer,20,jsonLength)));
  if(!record(raw)||!record(raw.asset)||raw.asset.version!=="2.0")fail();
  // Forbid URI-bearing resources and extension handlers anywhere in the graph.
  const queue:unknown[]=[raw];let visited=0;
  while(queue.length){if(++visited>100000)fail();const item=queue.pop();if(Array.isArray(item)){queue.push(...item);continue;}if(record(item))for(const [key,value] of Object.entries(item)){
    if(["uri","extensions","extensionsUsed","extensionsRequired","sparse","animations","skins","cameras","targets"].includes(key))fail();
    if(value&&typeof value==="object")queue.push(value);
  }}
  const array=(value:unknown,max:number,min=1):Record<string,unknown>[]=>{if(!Array.isArray(value)||value.length<min||value.length>max||!value.every(record))return fail();return value;};
  const buffers=array(raw.buffers,1);if(buffers.length!==1||!integer(buffers[0].byteLength,1,binLength)||binLength-buffers[0].byteLength>3)fail();
  const views=array(raw.bufferViews,5000),accessors=array(raw.accessors,5000),images=array(raw.images,256),textures=array(raw.textures,256),materials=array(raw.materials,1000),meshes=array(raw.meshes,1000),nodes=array(raw.nodes,1000),scenes=array(raw.scenes,1);
  for(const item of views){if(item.buffer!==0||!integer(item.byteOffset??0,0,binLength)||!integer(item.byteLength,1,binLength)||Number(item.byteOffset??0)+item.byteLength>Number(buffers[0].byteLength)||item.byteStride!==undefined&&!integer(item.byteStride,4,252))fail();}
  const reference=(value:unknown,list:unknown[])=>integer(value,0,list.length-1)?value:fail();
  const descriptor=(index:unknown)=>{
    const accessor=accessors[reference(index,accessors)],item=views[reference(accessor.bufferView,views)];
    const components=accessor.type==="SCALAR"?1:accessor.type==="VEC2"?2:accessor.type==="VEC3"?3:fail();
    const bytes=accessor.componentType===5126||accessor.componentType===5125?4:accessor.componentType===5123?2:fail();
    const stride=Number(item.byteStride??bytes*components),offset=Number(accessor.byteOffset??0);
    if(!integer(accessor.count,1,maxMeshTriangles*3)||!integer(offset,0,binLength)||offset%bytes||stride%bytes||stride<bytes*components||offset+(accessor.count-1)*stride+bytes*components>Number(item.byteLength)||accessor.normalized)fail();
    const start=binStart+Number(item.byteOffset??0)+offset;if(start%bytes)fail();
    return{accessor,components,bytes,stride,start,count:accessor.count};
  };
  // Check every declared accessor, including unused resources.
  accessors.forEach((_,index)=>descriptor(index));
  let texels=0;
  for(const image of images){const item=views[reference(image.bufferView,views)];if(item.byteStride!==undefined)fail();const [width,height]=imageSize(new Uint8Array(buffer,binStart+Number(item.byteOffset??0),Number(item.byteLength)),image.mimeType);
    if(!integer(width,1,8192)||!integer(height,1,8192)||(texels+=width*height)>maxMeshTexels)fail();}
  const samplers=raw.samplers===undefined?[]:array(raw.samplers,256,0);
  for(const texture of textures){reference(texture.source,images);if(texture.sampler!==undefined)reference(texture.sampler,samplers);}
  for(const sampler of samplers){if(sampler.magFilter!==undefined&&![9728,9729].includes(Number(sampler.magFilter))||sampler.minFilter!==undefined&&![9728,9729,9984,9985,9986,9987].includes(Number(sampler.minFilter))||[sampler.wrapS,sampler.wrapT].some(v=>v!==undefined&&![33071,33648,10497].includes(Number(v))))fail();}
  for(const material of materials){
    if(!record(material.pbrMetallicRoughness)||!record(material.pbrMetallicRoughness.baseColorTexture)||material.normalTexture||material.occlusionTexture||material.emissiveTexture||material.alphaMode&&material.alphaMode!=="OPAQUE")fail();
    reference(material.pbrMetallicRoughness.baseColorTexture.index,textures);if(material.pbrMetallicRoughness.baseColorTexture.texCoord!==undefined&&material.pbrMetallicRoughness.baseColorTexture.texCoord!==0)fail();
  }
  let triangleCount=0,vertexCount=0;
  const bounds={min:{x:Infinity,y:Infinity,z:Infinity},max:{x:-Infinity,y:-Infinity,z:-Infinity}};
  const primitiveCounts:number[]=[];
  for(const mesh of meshes){let meshTriangles=0;for(const primitive of array(mesh.primitives,1000)){
    if(primitive.mode!==undefined&&primitive.mode!==4||!record(primitive.attributes)||Object.keys(primitive.attributes).some(key=>!["POSITION","NORMAL","TEXCOORD_0"].includes(key)))fail();
    reference(primitive.material,materials);const positions=descriptor(primitive.attributes.POSITION),uv=descriptor(primitive.attributes.TEXCOORD_0),indices=descriptor(primitive.indices);
    if(positions.components!==3||positions.accessor.componentType!==5126||uv.components!==2||uv.accessor.componentType!==5126||uv.count!==positions.count||indices.components!==1||![5123,5125].includes(Number(indices.accessor.componentType))||indices.count%3)fail();
    meshTriangles+=indices.count/3;vertexCount+=positions.count;if(meshTriangles>maxMeshTriangles||vertexCount>maxMeshTriangles*3)fail();
    for(let i=0;i<positions.count;i++)for(const [axis,key] of (["x","y","z"] as const).entries()){const v=view.getFloat32(positions.start+i*positions.stride+axis*4,true);if(!coordinate(v))fail();bounds.min[key]=Math.min(bounds.min[key],v);bounds.max[key]=Math.max(bounds.max[key],v);}
    for(let i=0;i<uv.count;i++)for(let axis=0;axis<2;axis++){const v=view.getFloat32(uv.start+i*uv.stride+axis*4,true);if(!Number.isFinite(v)||Math.abs(v)>1000)fail();}
    for(let i=0;i<indices.count;i++){const index=indices.bytes===2?view.getUint16(indices.start+i*indices.stride,true):view.getUint32(indices.start+i*indices.stride,true);if(index>=positions.count)fail();}
    if(primitive.attributes.NORMAL!==undefined){const normals=descriptor(primitive.attributes.NORMAL);if(normals.count!==positions.count||normals.components!==3||normals.accessor.componentType!==5126)fail();for(let i=0;i<normals.count;i++)for(let axis=0;axis<3;axis++){const v=view.getFloat32(normals.start+i*normals.stride+axis*4,true);if(!Number.isFinite(v)||Math.abs(v)>1.01)fail();}}
  }primitiveCounts.push(meshTriangles);}
  // The generator emits flat identity mesh nodes. Reject instancing, transforms
  // and recursive graphs so a small file cannot multiply rendering resources.
  if(raw.scene!==undefined&&raw.scene!==0||!Array.isArray(scenes[0].nodes)||scenes[0].nodes.length!==nodes.length||new Set(scenes[0].nodes).size!==nodes.length)fail();
  const used=new Set<number>();for(const index of scenes[0].nodes){const node=nodes[reference(index,nodes)];if(["children","matrix","translation","rotation","scale","weights"].some(key=>node[key]!==undefined))fail();const mesh=reference(node.mesh,meshes);if(used.has(mesh))fail();used.add(mesh);triangleCount+=primitiveCounts[mesh];}
  if(used.size!==meshes.length||triangleCount<1||triangleCount>maxMeshTriangles||metadata&&(metadata.byteLength!==buffer.byteLength||metadata.triangleCount!==triangleCount))fail();
  return{byteLength:buffer.byteLength,triangleCount,vertexCount,textureCount:images.length,texels,bounds};
}
