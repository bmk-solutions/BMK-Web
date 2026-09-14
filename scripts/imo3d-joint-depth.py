"""Offline pose-conditioned multiview surface estimates. Never metric depth."""
import argparse
import hashlib
import io
import json
import math
import os
import re
from pathlib import Path
import sys
import time
import zipfile

ROOT=Path(__file__).resolve().parents[1]
for name in ['reconstruction-python-verified','room-vision-python-verified','vlm-python-verified','layout-python-verified','joint-depth-python','da3-python']:
    sys.path.insert(0,str(ROOT/'work'/name))
os.environ['HF_HUB_OFFLINE']='1'
os.environ['TRANSFORMERS_OFFLINE']='1'
os.environ['HF_HUB_DISABLE_TELEMETRY']='1'
import numpy as np
import cv2
from PIL import Image

VERSION='joint-depth-da3-v1'
SOURCE='da3-base-pose-conditioned-multiview'
MODEL_SHA='e01067dc1659613083d9145a9a2547ccdbe6ccbbf83c4fe7b3e8a4e2bdae78b5'
WIDTH,HEIGHT,SIZE,FOV=128,64,378,100
MAX_POINTS=150000
LITERALS={'source':SOURCE,'units':'camera_height','purpose':'display_only'}
GEOMETRY_SOURCE='da3-validated-perspective-v1'
GEOMETRY_FILE_MAX=32*1024*1024
GEOMETRY_TOTAL_MAX=1024*1024*1024
GEOMETRY_BATCH_MAX=128
GEOMETRY_MANIFEST_MAX=512*1024
GEOMETRY_NAME=re.compile(r'^[a-f0-9]{64}-pitch-(neg30|pos30)\.npz$')


def geometry_arrays(views,results,pass_info):
    """Keep exact perspective sampling before panorama binning/subsampling.

    Raw depths are the model's z-depths; validated_depth is aligned z-depth in
    the registered camera-height frame. pixel_centers refer to the ORIGINAL
    378px calibration, avoiding a half-pixel error when retaining stride2 rays.
    """
    if not 2<=len(views)<=12 or len(results)!=len(views):raise ValueError('Invalid geometry view batch')
    ids=sorted({v['id'] for v in views})
    if not 2<=len(ids)<=3 or any(not isinstance(s,str) or not 1<=len(s)<=100 for s in ids):raise ValueError('Independent physical geometry cameras required')
    domains={(v['scene']['componentId'],v['scene']['floor']) for v in views}
    if len(domains)!=1:raise ValueError('Geometry cannot merge camera domains')
    scale,error=pass_info.get('poseScale'),pass_info.get('normalizedPoseError')
    if not finite(scale) or not .001<scale<1000 or not finite(error) or not 0<=error<=.18:raise ValueError('Accepted geometry pose alignment required')
    output={'raw_depth':[],'raw_confidence':[],'validated_depth':[],'validated_confidence':[],
            'valid_mask':[],'physical_support_bits':[],'world_to_camera':[],'scene_yaw':[]}
    for view,result in zip(views,results):
        if result['view'] is not view:raise ValueError('Geometry results do not match perspective views')
        raw=np.asarray(view['rawDepth'],dtype=np.float32);confidence=np.asarray(view['confidence'],dtype=np.float32)
        aligned=np.asarray(view['depth'],dtype=np.float32)
        mask=np.asarray(result['valid'],dtype=bool);quality=np.asarray(result['confidence'],dtype=np.float32)
        if any(a.shape!=(SIZE,SIZE) for a in [raw,confidence,aligned]) or mask.shape!=(189,189) or quality.shape!=mask.shape:raise ValueError('Unexpected native geometry dimensions')
        if not all(np.isfinite(a).all() for a in [raw,confidence,aligned,quality]):raise ValueError('Nonfinite geometry evidence')
        if np.any(quality<0) or np.any(quality>1):raise ValueError('Invalid validated geometry confidence')
        if not np.allclose(aligned,raw/scale,rtol=2e-6,atol=1e-6):raise ValueError('Geometry depth scale mismatch')
        bits=np.where(mask,1<<ids.index(view['id']),0).astype(np.uint8)
        other_votes=np.zeros(mask.shape,dtype=bool)
        for other,support in result['support'].items():
            if other not in ids or other==view['id']:raise ValueError('Invalid physical camera support')
            support=np.asarray(support,dtype=bool)
            if support.shape!=mask.shape:raise ValueError('Invalid geometry support grid')
            bits|=np.where(mask&support,1<<ids.index(other),0).astype(np.uint8);other_votes|=support
        if np.any(mask&~other_votes):raise ValueError('Unsupported pixels cannot be retained as validated geometry')
        ext=np.asarray(view['extrinsics'],dtype=np.float32)
        if ext.shape!=(4,4) or not np.isfinite(ext).all() or not np.allclose(ext[3],[0,0,0,1]):raise ValueError('Invalid supplied geometry transform')
        output['raw_depth'].append(raw);output['raw_confidence'].append(confidence)
        output['validated_depth'].append(np.where(mask,aligned[::2,::2],0))
        output['validated_confidence'].append(np.where(mask,quality,0));output['valid_mask'].append(mask.astype(np.uint8));output['physical_support_bits'].append(bits)
        output['world_to_camera'].append(ext);output['scene_yaw'].append(view['scene']['yaw'])
    output={key:np.asarray(value) for key,value in output.items()}
    domain=next(iter(domains))
    output.update(version=np.array(1,dtype=np.int32),source=np.asarray(GEOMETRY_SOURCE),units=np.asarray('camera_height'),scene_ids=np.asarray([v['id'] for v in views]),physical_scene_ids=np.asarray(ids),
                  component_id=np.asarray(domain[0]),floor=np.array(domain[1],dtype=np.int32),intrinsics=make_intrinsics(),
                  pixel_centers=np.arange(189,dtype=np.float32)*2+.5,pixel_stride=np.array(2,dtype=np.int32),
                  native_resolution=np.array([378,378],dtype=np.int32),pose_scale=np.array(scale,dtype=np.float64),normalized_pose_error=np.array(error,dtype=np.float64))
    for field,name,shape in [('modelInputExtrinsics','model_input_extrinsics',(4,4)),('predictedExtrinsics','predicted_extrinsics',(3,4)),('predictedIntrinsics','predicted_intrinsics',(3,3))]:
        if all(field in v for v in views):
            values=np.asarray([v[field] for v in views],dtype=np.float32)
            if values.shape!=(len(views),)+shape or not np.isfinite(values).all():raise ValueError('Invalid retained model transform')
            output[name]=values
    return output


class GeometryEvidenceWriter:
    """One private attempt; no paths, RGB copies or room outlines in archives."""
    def __init__(self,output_dir):
        self.directory=Path(output_dir)/'joint-geometry';self.files={};self.warnings=[]
        self._safe_directory()
        self.directory.mkdir(parents=True,exist_ok=True)

    def _safe_directory(self):
        root=ROOT.resolve();candidate=self.directory.absolute()
        if not candidate.resolve().is_relative_to(root):raise ValueError('Geometry evidence must remain inside BMK-Web')
        for item in [candidate,*candidate.parents]:
            if item==root.parent:break
            if item.is_symlink() or getattr(item,'is_junction',lambda:False)():raise ValueError('Geometry evidence cannot follow links')

    def _path(self,name):
        self._safe_directory()
        if not GEOMETRY_NAME.fullmatch(name):raise ValueError('Invalid geometry archive name')
        target=self.directory/name
        if target.is_symlink() or getattr(target,'is_junction',lambda:False)():raise ValueError('Geometry archive cannot be a link')
        return target

    def _capacity(self,record):
        previous=self.files.get(record['file'],{}).get('byteLength',0)
        if record['byteLength']>GEOMETRY_FILE_MAX or len(self.files)+(record['file'] not in self.files)>GEOMETRY_BATCH_MAX or sum(v['byteLength'] for v in self.files.values())-previous+record['byteLength']>GEOMETRY_TOTAL_MAX:raise ValueError('Private geometry evidence size budget reached')

    def write(self,key,pitch,views,results,pass_info):
        if pitch not in (-30,30) or not re.fullmatch('[a-f0-9]{64}',key):raise ValueError('Invalid geometry cache identity')
        name=key+('-pitch-neg30.npz' if pitch==-30 else '-pitch-pos30.npz');target=self._path(name)
        arrays=geometry_arrays(views,results,pass_info)
        if sum(a.nbytes for a in arrays.values())>GEOMETRY_FILE_MAX:raise ValueError('Uncompressed geometry exceeds archive limit')
        stream=io.BytesIO();np.savez_compressed(stream,**arrays);data=stream.getvalue()
        record={'file':name,'byteLength':len(data),'sha256':hashlib.sha256(data).hexdigest(),'viewCount':len(views),
                'sceneIds':sorted({v['id'] for v in views}),'componentId':views[0]['scene']['componentId'],'floor':views[0]['scene']['floor']}
        self._capacity(record);temporary=target.with_suffix('.npz.tmp')
        if temporary.is_symlink() or getattr(temporary,'is_junction',lambda:False)():raise ValueError('Geometry temporary file cannot be a link')
        temporary.write_bytes(data);self._safe_directory();self._path(name);temporary.replace(target)
        self.files[name]=record
        return record

    def verify(self,records,key,scene_ids,floor,component_id):
        """Legacy map-only caches and missing/truncated high-res files miss."""
        if not isinstance(records,list) or len(records)!=2:return False
        expected={key+'-pitch-neg30.npz',key+'-pitch-pos30.npz'}
        if {r.get('file') for r in records if isinstance(r,dict)}!=expected:return False
        try:
            for record in records:
                if set(record)!= {'file','byteLength','sha256','viewCount','sceneIds','componentId','floor'}:return False
                if record['sceneIds']!=sorted(scene_ids) or record['floor']!=floor or record['componentId']!=component_id or record['viewCount']!=len(scene_ids)*4:return False
                if not isinstance(record['byteLength'],int) or not 1<=record['byteLength']<=GEOMETRY_FILE_MAX or not re.fullmatch('[a-f0-9]{64}',record['sha256']):return False
                self._capacity(record);target=self._path(record['file'])
                if not target.is_file() or target.stat().st_size!=record['byteLength'] or file_hash(target)!=record['sha256']:return False
                with zipfile.ZipFile(target) as archive:
                    if sum(item.file_size for item in archive.infolist())>GEOMETRY_FILE_MAX:return False
                    if any('/' in item.filename or '\\' in item.filename or not item.filename.endswith('.npy') for item in archive.infolist()):return False
                with np.load(target,allow_pickle=False) as value:
                    count=record['viewCount']
                    required={'version','source','units','scene_ids','physical_scene_ids','component_id','floor','intrinsics','pixel_centers','pixel_stride','native_resolution','pose_scale','normalized_pose_error','raw_depth','raw_confidence','validated_depth','validated_confidence','valid_mask','physical_support_bits','world_to_camera','scene_yaw'}
                    optional={'model_input_extrinsics','predicted_extrinsics','predicted_intrinsics'}
                    if not required.issubset(value.files) or set(value.files)-required-optional:return False
                    if value['version'].item()!=1 or value['source'].item()!=GEOMETRY_SOURCE or value['units'].item()!='camera_height':return False
                    if value['raw_depth'].shape!=(count,378,378) or value['raw_confidence'].shape!=(count,378,378) or value['valid_mask'].shape!=(count,189,189) or value['validated_depth'].shape!=(count,189,189):return False
                    if value['physical_scene_ids'].tolist()!=sorted(scene_ids) or set(value['scene_ids'].tolist())!=set(scene_ids) or value['floor'].item()!=floor or value['component_id'].item()!=component_id:return False
                    if not np.array_equal(value['pixel_centers'],np.arange(189,dtype=np.float32)*2+.5) or not np.allclose(value['intrinsics'],make_intrinsics()):return False
            # Register only after BOTH pitch archives pass all checks.
            if sum(v['byteLength'] for v in self.files.values())+sum(r['byteLength'] for r in records if r['file'] not in self.files)>GEOMETRY_TOTAL_MAX:return False
            if len(set(self.files)|{r['file'] for r in records})>GEOMETRY_BATCH_MAX:return False
            self.files.update({r['file']:r for r in records});return True
        except (OSError,ValueError,TypeError,KeyError,zipfile.BadZipFile):return False

    def finalize(self,expected_batches):
        files=sorted(self.files.values(),key=lambda r:r['file'])
        status='complete' if len(files)==expected_batches and expected_batches>0 and not self.warnings else 'partial' if files else 'unavailable'
        manifest={'version':1,'source':GEOMETRY_SOURCE,'status':status,'files':files,'batchCount':len(files),
                  'viewCount':sum(r['viewCount'] for r in files),'totalBytes':sum(r['byteLength'] for r in files),'warnings':self.warnings[:128]}
        data=json.dumps(manifest,separators=(',',':')).encode()
        if len(data)>GEOMETRY_MANIFEST_MAX:raise ValueError('Geometry manifest exceeds size limit')
        self._safe_directory();target=self.directory/'manifest.json';temporary=self.directory/'manifest.json.tmp'
        if target.is_symlink() or temporary.is_symlink():raise ValueError('Geometry manifest cannot be a link')
        temporary.write_bytes(data);self._safe_directory();temporary.replace(target)
        return {key:value for key,value in manifest.items() if key!='files'}|{'manifest':'joint-geometry/manifest.json'}


def file_hash(path):
    digest=hashlib.sha256()
    with Path(path).open('rb') as file:
        for chunk in iter(lambda:file.read(1024*1024),b''):digest.update(chunk)
    return digest.hexdigest()


def progress(completed,total,message):
    print(json.dumps({'event':'progress','stage':'joint_depth','completed':completed,'total':total,'message':message}),flush=True)


def finite(value):
    return isinstance(value,(int,float)) and not isinstance(value,bool) and math.isfinite(value)


def validate_payload(payload):
    scenes=payload.get('scenes')
    if not isinstance(scenes,list) or not 2<=len(scenes)<=300:raise ValueError('Joint depth requires2..300registered panorama scenes')
    found=set()
    for scene in scenes:
        sid=scene.get('id');position=scene.get('position',{})
        if not isinstance(sid,str) or not 1<=len(sid)<=100 or sid in found:raise ValueError('Scene IDs must be unique nonempty strings')
        found.add(sid)
        if any(not finite(position.get(axis)) or abs(position[axis])>1000 for axis in ['x','y','z']):raise ValueError('Scene positions must be finite local camera-height coordinates')
        if not finite(scene.get('yaw')):raise ValueError('A registered scene yaw is required')
        if not isinstance(scene.get('componentId'),str) or not 1<=len(scene['componentId'])<=160:raise ValueError('A registered componentId is required')
        floor=scene.get('floor',0)
        if not isinstance(floor,int) or isinstance(floor,bool) or not -10<=floor<=200:raise ValueError('A valid floor index is required')
        scene['floor']=floor
        path=Path(scene.get('path','')).resolve()
        if not path.is_relative_to(ROOT.resolve()) or not path.is_file() or path.suffix.lower() not in {'.jpg','.jpeg','.png','.webp'}:raise ValueError('Panorama input must be a local image inside BMK-Web')
        scene['path']=str(path)
    links=payload.get('links')
    if not isinstance(links,list) or len(links)>30000:raise ValueError('Verified scene links are required')
    for link in links:
        if link.get('from') not in found or link.get('to') not in found:raise ValueError('Link references unknown scene')
    return scenes


def select_groups(scenes,links):
    """No semantic-label grouping or merging disconnected components."""
    by_id={scene['id']:scene for scene in scenes};adj={sid:set() for sid in by_id}
    for link in links:
        a,b=link['from'],link['to']
        if a!=b and by_id[a]['componentId']==by_id[b]['componentId'] and by_id[a].get('floor',0)==by_id[b].get('floor',0):
            adj[a].add(b);adj[b].add(a)
    groups=[];seen=set()
    for scene in scenes:
        sid=scene['id'];center=np.array([scene['position'][key] for key in ['x','y','z']])
        candidates=[]
        for other in adj[sid]:
            distance=float(np.linalg.norm(center-np.array([by_id[other]['position'][key] for key in ['x','y','z']])))
            if .08<distance<6:candidates.append((distance,other))
        if not candidates:continue
        picked=[sid]+[other for _,other in sorted(candidates)[:2]]
        key=tuple(sorted(picked))
        if key not in seen:seen.add(key);groups.append([by_id[item] for item in picked])
    return groups


def basis(heading,pitch):
    a,p=math.radians(heading),math.radians(pitch)
    forward=np.array([math.sin(a)*math.cos(p),math.sin(p),-math.cos(a)*math.cos(p)],np.float32)
    right=np.array([math.cos(a),0,math.sin(a)],np.float32)
    return np.stack([right,np.cross(forward,right),forward],1)


def orientation(yaw):
    a=math.radians(yaw);c,s=math.cos(a),math.sin(a)
    return np.array([[c,0,-s],[0,1,0],[s,0,c]],np.float32)


def make_intrinsics(size=SIZE):
    focal=size/(2*math.tan(math.radians(FOV/2)))
    return np.array([[focal,0,size/2],[0,focal,size/2],[0,0,1]],np.float32)


def rays_for(size=SIZE):
    grid=np.stack(np.meshgrid(np.arange(size,dtype=np.float32)+.5,np.arange(size,dtype=np.float32)+.5),-1)
    return np.concatenate([grid,np.ones((size,size,1),np.float32)],-1)@np.linalg.inv(make_intrinsics(size)).T


def pano_coordinates(local):
    norm=np.linalg.norm(local,axis=-1)
    return np.arctan2(local[...,0],-local[...,2])/(2*math.pi)+.5,.5-np.arcsin(np.clip(local[...,1]/np.maximum(norm,1e-6),-1,1))/math.pi


def render_views(group,pitch,images):
    q=rays_for();views=[]
    for scene in group:
        image=images[scene['id']];ori=orientation(scene['yaw']);center=np.array([scene['position'][key] for key in ['x','y','z']],np.float32)
        for heading in [0,90,180,270]:
            rotation=basis(heading,pitch);rays=q@rotation.T
            u,v=pano_coordinates(rays@ori)
            rgb=cv2.remap(image,(u*image.shape[1]-.5).astype(np.float32),(v*image.shape[0]-.5).astype(np.float32),cv2.INTER_LINEAR,borderMode=cv2.BORDER_WRAP)
            ext=np.eye(4,dtype=np.float32);ext[:3,:3]=rotation.T;ext[:3,3]=-rotation.T@center
            views.append({'id':scene['id'],'scene':scene,'image':rgb,'rotation':rotation,'center':center,'extrinsics':ext,'rays':rays,'heading':heading,'pitch':pitch})
    return views


def align_scale(known_ext,predicted_ext):
    ext=np.broadcast_to(np.eye(4),(len(predicted_ext),4,4)).copy();ext[:,:3]=predicted_ext[:,:3]
    known=np.linalg.inv(known_ext)[:,:3,3];pred=np.linalg.inv(ext)[:,:3,3]
    a=known-known.mean(0);b=pred-pred.mean(0)
    variance=float(np.mean(np.sum(a*a,axis=-1)))
    if variance<.001:raise ValueError('Camera baseline is too small for joint scale')
    u,sigma,vt=np.linalg.svd(b.T@a/len(a));sign=np.eye(3);sign[2,2]=np.sign(np.linalg.det(u@vt))
    rot=u@sign@vt;scale=float(np.sum(sigma*np.diag(sign))/variance)
    if not math.isfinite(scale) or not .001<scale<1000:raise ValueError('Invalid predicted camera scale')
    error=np.linalg.norm(b-scale*(a@rot.T),axis=-1)/scale
    normalized=float(np.median(error)/math.sqrt(variance))
    if normalized>.18 or np.quantile(error,.9)>.5:raise ValueError('Predicted camera positions disagree with registered input geometry')
    return scale,normalized


class Model:
    def __init__(self):
        import torch
        from safetensors.torch import load_file
        from omegaconf import OmegaConf
        from depth_anything_3.cfg import create_object
        model_dir=ROOT/'work/da3-model';path=model_dir/'model.safetensors'
        if not path.is_file() or file_hash(path)!=MODEL_SHA:raise ValueError('Pinned local DA3 BASE model is missing or checksum mismatched')
        torch.set_num_threads(min(6,os.cpu_count() or 4));self.torch=torch
        config=json.loads((model_dir/'config.json').read_text())
        self.net=create_object(OmegaConf.create(config['config'])).eval()
        weights={key.removeprefix('model.'):value for key,value in load_file(str(path)).items()}
        expected=self.net.state_dict()
        # Safetensors deduplicates shared LayerNorm tensors. Restore aliases only
        # when the architecture proves identical storage, never random weights.
        for key,value in expected.items():
            if key not in weights:
                donor=next((other for other in weights if other in expected and expected[other].data_ptr()==value.data_ptr()),None)
                if donor is None:raise ValueError('Missing local DA3 tensor: '+key)
                weights[key]=weights[donor]
        self.net.load_state_dict(weights,strict=True)

    def run(self,views,retain_raw=False):
        torch=self.torch
        images=np.stack([v['image'] for v in views]).astype(np.float32)/255
        images=(images-np.array([.485,.456,.406],np.float32))/np.array([.229,.224,.225],np.float32)
        ext=np.stack([v['extrinsics'] for v in views]);norm=ext@np.linalg.inv(ext[0])
        median=max(.1,float(np.median(np.linalg.norm(np.linalg.inv(norm)[:,:3,3],axis=-1))))
        norm[:,:3,3]/=median
        with torch.inference_mode():
            output=self.net(torch.from_numpy(images.transpose(0,3,1,2)[None]),torch.from_numpy(norm[None]),torch.from_numpy(np.repeat(make_intrinsics()[None,None],len(views),axis=1)),export_feat_layers=[],infer_gs=False)
        scale,error=align_scale(ext,output['extrinsics'][0].numpy())
        for i,view in enumerate(views):
            view['depth']=output['depth'][0,i].numpy().copy()/scale
            view['confidence']=output['depth_conf'][0,i].numpy().copy()
            if retain_raw:
                view['rawDepth']=output['depth'][0,i].numpy().copy()
                view['modelInputExtrinsics']=norm[i].copy()
                view['predictedExtrinsics']=output['extrinsics'][0,i].numpy().copy()
                view['predictedIntrinsics']=output['intrinsics'][0,i].numpy().copy()
        return {'poseScale':scale,'normalizedPoseError':error}


def bilinear(array,uv):
    return cv2.remap(array,uv[...,0].astype(np.float32),uv[...,1].astype(np.float32),cv2.INTER_LINEAR,borderMode=cv2.BORDER_CONSTANT)


def validate_surfaces(views):
    """Independent physical camera evidence; repeated crops never count twice."""
    q=rays_for()[::2,::2];K=make_intrinsics();results=[]
    for source in views:
        d=source['depth'][::2,::2];c=source['confidence'][::2,::2]
        points=(q*d[...,None])@source['rotation'].T+source['center']
        valid=np.isfinite(d)&(d>.12)&(d<15)&np.isfinite(c)&(c>=np.quantile(c,.12))
        valid[:2]=False;valid[-2:]=False;valid[:,:2]=False;valid[:,-2:]=False
        support={};errors={}
        for target in views:
            if target['id']==source['id']:continue
            local=(points-target['center'])@target['rotation'];z=local[...,2]
            pixels=local@K.T;uv=pixels[...,:2]/np.maximum(z[...,None],1e-6)-.5
            td=bilinear(target['depth'],uv)
            tc=bilinear(target['confidence'],uv)
            rel=np.abs(td-z)/np.maximum(np.maximum(td,z),.01)
            color=np.mean(np.abs(bilinear(target['image'],uv).astype(np.float32)-source['image'][::2,::2].astype(np.float32)),axis=-1)/255
            ok=valid&(z>.12)&(uv[...,0]>4)&(uv[...,0]<SIZE-5)&(uv[...,1]>4)&(uv[...,1]<SIZE-5)&(td>.12)&(tc>=np.quantile(target['confidence'],.12))&(rel<.085)&(color<.16)
            support[target['id']]=support.get(target['id'],np.zeros_like(valid))|ok
            score=np.where(ok,(1-rel/.085)*.7+(1-color/.16)*.3,0)
            errors[target['id']]=np.maximum(errors.get(target['id'],np.zeros_like(d)),score)
        votes=sum(support.values(),start=np.zeros_like(d,dtype=np.uint8))
        ok=valid&(votes>=1)
        scores=np.maximum.reduce(list(errors.values())) if errors else np.zeros_like(d)
        # Estimated confidence includes agreement, not a model probability.
        confidence=np.where(ok,np.clip(.55+.3*scores+.07*np.maximum(votes-1,0),0,.95),0)
        results.append({'view':source,'points':points,'valid':ok,'confidence':confidence,'support':support})
    return results


def pack_surfaces(results,profiles):
    depth_maps={};points=[]
    for result in results:
        view=result['view'];sid=view['id'];p=result['points'];mask=result['valid'];conf=result['confidence']
        delta=p-view['center'];radial=np.linalg.norm(delta,axis=-1)
        u,v=pano_coordinates(delta@orientation(view['scene']['yaw']))
        ix=np.minimum(WIDTH-1,np.floor((u%1)*WIDTH).astype(int));iy=np.clip(np.floor(v*HEIGHT).astype(int),0,HEIGHT-1)
        bucket=depth_maps.setdefault(sid,{'sums':np.zeros(WIDTH*HEIGHT),'weights':np.zeros(WIDTH*HEIGHT),'squares':np.zeros(WIDTH*HEIGHT)})
        flat=(iy*WIDTH+ix)[mask];weights=conf[mask]
        np.add.at(bucket['sums'],flat,radial[mask]*weights);np.add.at(bucket['weights'],flat,weights);np.add.at(bucket['squares'],flat,radial[mask]**2*weights)
        # Structured samples retain near-eye-level walls AND floor/ceiling; no
        # room polygon assumptions or automatic closure is applied here.
        subsample=np.zeros_like(mask);subsample[::3,::3]=True;selected=mask&subsample
        yy,xx=np.nonzero(selected);rgb=view['image'][::2,::2][selected]
        dy=np.gradient(p,axis=0);dx=np.gradient(p,axis=1);normals=np.cross(dx,dy);normals/=np.maximum(np.linalg.norm(normals,axis=-1,keepdims=True),1e-6)
        profile=profiles.get(sid,{}).get('floorBoundaryRadians')
        if isinstance(profile,list) and len(profile)>=32:
            angles=np.interp(u*len(profile),np.arange(len(profile)),profile,period=len(profile));floor_candidate=((v-.5)*math.pi>angles+.06)
        else:floor_candidate=np.zeros_like(mask)
        for n,(row,col) in enumerate(zip(yy,xx)):
            others=[other for other,good in result['support'].items() if good[row,col]]
            xyz=p[row,col];normal=normals[row,col]
            if not np.isfinite(xyz).all() or not np.isfinite(normal).all() or np.max(np.abs(xyz))>1000:continue
            floor_conf=float(conf[row,col])*max(0,1-abs(float(xyz[1])-view['center'][1]+1)/.2) if floor_candidate[row,col] and abs(normal[1])>.8 else 0.
            points.append({'x':round(float(xyz[0]),4),'y':round(float(xyz[1]),4),'z':round(float(xyz[2]),4),'r':int(rgb[n,0]),'g':int(rgb[n,1]),'b':int(rgb[n,2]),'confidence':round(float(conf[row,col]),3),'sceneIds':[sid]+others[:11],'normal':{'x':round(float(normal[0]),4),'y':round(float(normal[1]),4),'z':round(float(normal[2]),4)},'floorConfidence':round(float(floor_conf),3)})
    return depth_maps,points


def finish_depth(bucket):
    weights=bucket['weights'];values=bucket['sums']/np.maximum(weights,1e-6)
    variance=np.maximum(0,bucket['squares']/np.maximum(weights,1e-6)-values**2)
    valid=(weights>=.6)&np.isfinite(values)&(values>.12)&(values<20)&(np.sqrt(variance)<.1*np.maximum(values,.2))
    values=np.where(valid,values,0)
    return {'width':WIDTH,'height':HEIGHT,'values':np.round(values,4).tolist(),'confidence':round(float(min(.9,.60+.04*np.median(weights[valid]))) if valid.any() else 0,3),'coverage':round(float(valid.mean()),4),**LITERALS}


def cap_points(points,maximum=MAX_POINTS,scene_domains=None):
    """Spatially fuse duplicate observations while preserving verified support."""
    cells={}
    for point in points:
        domain=scene_domains.get(point['sceneIds'][0]) if scene_domains is not None else ('single-group',0)
        if domain is None or scene_domains is not None and any(scene_domains.get(sid)!=domain for sid in point['sceneIds']):continue
        key=(domain,)+tuple(round(point[axis]/.035) for axis in ['x','y','z'])
        old=cells.get(key)
        if old is None or point['confidence']>old['confidence']:cells[key]=point
    fused=list(cells.values())
    if len(fused)>maximum:
        # Deterministic evenly sampled spatial order avoids discarding later rooms.
        fused.sort(key=lambda p:(p['x'],p['z'],p['y']))
        fused=[fused[i] for i in np.linspace(0,len(fused)-1,maximum,dtype=int)]
    return fused


def cache_key(group,hashes,profiles):
    payload={'version':VERSION,'model':MODEL_SHA,'scenes':[{key:s.get(key) for key in ['id','position','yaw','componentId']}|{'floor':s.get('floor',0),'imageHash':hashes[s['id']],'profile':profiles.get(s['id'],{})} for s in group]}
    return hashlib.sha256(json.dumps(payload,sort_keys=True,separators=(',',':')).encode()).hexdigest()


def valid_cached_group(value,key,ids):
    if not isinstance(value,dict) or value.get('version')!=VERSION or value.get('cacheKey')!=key or not isinstance(value.get('depths'),dict) or set(value['depths'])!=set(ids):return False
    for depth in value['depths'].values():
        if not isinstance(depth,dict) or depth.get('width')!=WIDTH or depth.get('height')!=HEIGHT or any(depth.get(k)!=v for k,v in LITERALS.items()):return False
        values=depth.get('values')
        if not isinstance(values,list) or len(values)!=WIDTH*HEIGHT or any(not finite(v) or v<0 or v>20 for v in values):return False
        if any(not finite(depth.get(k)) or not 0<=depth[k]<=1 for k in ['confidence','coverage']):return False
    points=value.get('pointSamples')
    if not isinstance(points,list) or len(points)>MAX_POINTS:return False
    for point in points:
        if not isinstance(point,dict):return False
        if any(not finite(point.get(k)) or abs(point[k])>1000 for k in ['x','y','z']):return False
        if any(not finite(point.get(k)) or not 0<=point[k]<=255 for k in ['r','g','b']):return False
        if not finite(point.get('confidence')) or not 0<=point['confidence']<=1:return False
        evidence=point.get('sceneIds')
        if not isinstance(evidence,list) or not 2<=len(evidence)<=12 or any(not isinstance(sid,str) for sid in evidence) or len(set(evidence))!=len(evidence) or any(sid not in ids for sid in evidence):return False
        if not finite(point.get('floorConfidence')) or not 0<=point['floorConfidence']<=1:return False
        normal=point.get('normal',{})
        if not isinstance(normal,dict) or any(not finite(normal.get(axis)) or abs(normal[axis])>1.001 for axis in ['x','y','z']):return False
    return True


def run(payload,evidence_output_dir=None):
    scenes=validate_payload(payload);groups=select_groups(scenes,payload['links']);profiles=payload.get('roomProfiles',{})
    scene_domains={s['id']:(s['componentId'],s['floor']) for s in scenes}
    if not isinstance(profiles,dict):raise ValueError('roomProfiles must be an object')
    retain=payload.get('retainGeometryEvidence',False)
    if not isinstance(retain,bool):raise ValueError('retainGeometryEvidence must be boolean')
    if retain and evidence_output_dir is None:raise ValueError('Private geometry evidence output directory is required')
    evidence=GeometryEvidenceWriter(evidence_output_dir) if retain else None
    images={};hashes={scene['id']:file_hash(scene['path']) for scene in scenes}
    cache_root=Path(os.environ.get('IMO3D_ANALYSIS_CACHE_DIR',str(ROOT/'work/joint-depth-cache'))).resolve()
    if not cache_root.is_relative_to(ROOT.resolve()):raise ValueError('Joint cache must remain within BMK-Web')
    cache=cache_root/'joint-depth'
    if cache.is_symlink() or not cache.resolve().is_relative_to(cache_root):raise ValueError('Joint cache directory cannot be a link')
    cache.mkdir(parents=True,exist_ok=True)
    model=None;started=time.monotonic();warnings=[];all_points=[];fused={};done=set();diagnostics=[]
    progress(0,len(scenes),'Starting local joint surface reconstruction')
    for group in groups:
        if time.monotonic()-started>1200:warnings.append('Joint reconstruction reached its20minute processing bound');break
        key=cache_key(group,hashes,profiles);cache_path=cache/(key+'.json');result=None
        if cache_path.is_file() and not cache_path.is_symlink() and cache_path.stat().st_size<100_000_000:
            try:
                loaded=json.loads(cache_path.read_text())
                if valid_cached_group(loaded,key,{s['id'] for s in group}) and (evidence is None or evidence.verify(loaded.get('geometryEvidenceFiles'),key,{s['id'] for s in group},group[0]['floor'],group[0]['componentId'])):result=loaded
            except (OSError,ValueError,TypeError):pass
        if result is None:
            try:
                if model is None:model=Model()
                for scene in group:
                    if scene['id'] not in images:
                        with Image.open(scene['path']) as image:
                            image.draft('RGB',(4096,2048));image.thumbnail((4096,2048))
                            images[scene['id']]=np.array(image.convert('RGB'))
                buckets={};points=[];passes=[];geometry_files=[]
                for pitch in [-30,30]:
                    views=render_views(group,pitch,images);passes.append(model.run(views,retain_raw=True) if evidence is not None else model.run(views))
                    verified=validate_surfaces(views)
                    if evidence is not None:
                        try:geometry_files.append(evidence.write(key,pitch,views,verified,passes[-1]))
                        except (OSError,ValueError,TypeError,KeyError) as error:evidence.warnings.append('Geometry '+key+': '+str(error))
                    maps,samples=pack_surfaces(verified,profiles);points.extend(samples)
                    for sid,bucket in maps.items():
                        if sid not in buckets:buckets[sid]=bucket
                        else:
                            for field in bucket:buckets[sid][field]+=bucket[field]
                result={'version':VERSION,'cacheKey':key,'depths':{sid:finish_depth(bucket) for sid,bucket in buckets.items()},'pointSamples':cap_points(points),'passes':passes}
                if geometry_files:result['geometryEvidenceFiles']=geometry_files
                if not valid_cached_group(result,key,{s['id'] for s in group}):raise ValueError('Generated joint data failed validation')
                temporary=cache_path.with_suffix('.tmp')
                if temporary.is_symlink():raise ValueError('Joint cache temporary file cannot be a link')
                temporary.write_text(json.dumps(result,separators=(',',':')));temporary.replace(cache_path)
            except Exception as error:
                warnings.append('Joint group '+','.join(s['id'] for s in group)+': '+str(error));done.update(s['id'] for s in group)
                progress(len(done),len(scenes),'A joint group could not be verified');continue
        diagnostics.append({'sceneIds':[s['id'] for s in group],'passes':result.get('passes',[])})
        all_points.extend(result['pointSamples'])
        if len(all_points)>MAX_POINTS*2:all_points=cap_points(all_points,scene_domains=scene_domains)
        for sid,depth in result['depths'].items():
            values=np.array(depth['values']);weight=np.where(values>0,depth['confidence'],0)
            bucket=fused.setdefault(sid,{'sums':np.zeros(WIDTH*HEIGHT),'weights':np.zeros(WIDTH*HEIGHT),'squares':np.zeros(WIDTH*HEIGHT)})
            bucket['sums']+=values*weight;bucket['weights']+=weight;bucket['squares']+=values**2*weight
        done.update(s['id'] for s in group);progress(len(done),len(scenes),'Verified shared surfaces from neighboring panoramas')
        while len(images)>6:
            removable=next((sid for sid in images if sid not in {s['id'] for s in group}),None)
            if removable is None:break
            del images[removable]
    missing=[s['id'] for s in scenes if s['id'] not in fused]
    if missing:warnings.append(str(len(missing))+'panoramas have no jointly verified neighboring surface evidence')
    progress(len(scenes),len(scenes),'Local joint reconstruction finished')
    depths={sid:finish_depth(bucket) for sid,bucket in fused.items()}
    result={'version':1,'runtimeVersion':VERSION,**LITERALS,'depths':depths,'pointSamples':cap_points(all_points,scene_domains=scene_domains),'diagnostics':{'groups':diagnostics,'seconds':round(time.monotonic()-started,2),'posedScenes':len(scenes),'reconstructedScenes':len(depths),'missingSceneIds':missing},'warnings':warnings}
    if evidence is not None:result['geometryEvidence']=evidence.finalize(len(groups)*2)
    return result


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--input',required=True);parser.add_argument('--output',required=True);args=parser.parse_args()
    target=Path(args.output).resolve()
    if not target.is_relative_to(ROOT.resolve()):raise ValueError('Output must remain inside BMK-Web')
    input_path=Path(args.input).resolve()
    if not input_path.is_relative_to(ROOT.resolve()):raise ValueError('Input must remain inside BMK-Web')
    payload=json.loads(input_path.read_text(encoding='utf-8-sig'));result=run(payload,evidence_output_dir=target.parent)
    target.parent.mkdir(parents=True,exist_ok=True);temporary=target.with_suffix(target.suffix+'.tmp')
    temporary.write_text(json.dumps(result,separators=(',',':')));temporary.replace(target)


if __name__=='__main__':
    try:main()
    except Exception as error:
        print(json.dumps({'stage':'joint_depth','error':str(error)}),file=sys.stderr,flush=True);sys.exit(1)
