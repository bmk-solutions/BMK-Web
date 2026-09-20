"""Offline spherical bundle adjustment. Produces a candidate, never publishes.
Camera-height/relative scale is preserved: no metric accuracy is asserted.
"""
import argparse, hashlib, importlib.util, json, os, sys
from pathlib import Path
import numpy as np
from scipy.optimize import least_squares
from scipy.sparse import lil_matrix


def world_rays(rays, yaw):
    c, s = np.cos(yaw), np.sin(yaw)
    return np.column_stack((c*rays[:,0]-s*rays[:,2], rays[:,1], s*rays[:,0]+c*rays[:,2]))


def triangulate(origins, rays):
    matrices=np.eye(3)[None]-rays[:,:,None]*rays[:,None,:]
    a=matrices.sum(axis=0)
    if np.linalg.cond(a)>1e6:return None
    point=np.linalg.solve(a,np.einsum('nij,nj->i',matrices,origins))
    delta=point-origins
    if np.any(np.einsum('ni,ni->n',delta,rays)<=.02):return None
    return point


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--reconstruction',required=True)
    parser.add_argument('--features',required=True)
    parser.add_argument('--output',required=True)
    parser.add_argument('--max-tracks',type=int,default=1600)
    parser.add_argument('--max-evaluations',type=int,default=600)
    args=parser.parse_args()
    root=Path(__file__).resolve().parents[1]
    output=Path(args.output).resolve()
    if not output.is_relative_to(root/'work'):raise ValueError('Isolated work output required')
    output.mkdir(parents=True,exist_ok=True)
    spec=importlib.util.spec_from_file_location('recon',root/'scripts/imo3d-reconstruction.py')
    recon=importlib.util.module_from_spec(spec);spec.loader.exec_module(recon)
    data=json.loads(Path(args.reconstruction).read_text(encoding='utf-8'))
    component=max(data['components'],key=lambda c:len(c['sceneIds']))
    ids=sorted(component['sceneIds']);indices={sid:i for i,sid in enumerate(ids)}
    scenes={s['id']:s for s in data['scenes']}
    features={};fingerprints={}
    for sid in ids:
        file=root/'.imo3d-data/assets'/f'{sid}.original.jpeg'
        fingerprint=hashlib.sha256(recon.FEATURE_VERSION.encode()+file.read_bytes()).hexdigest()
        fingerprints[sid]=fingerprint
        with np.load(Path(args.features)/f'{fingerprint}.npz',allow_pickle=False) as cached:
            features[sid]={key:cached[key] for key in ('points','bearings','descriptors','signature')}
    parents={}
    def find(a):
        parents.setdefault(a,a)
        if parents[a]!=a:parents[a]=find(parents[a])
        return parents[a]
    pairs=[p for p in data['pairs'] if p['a'] in indices and p['b'] in indices]
    evidence=output/'track-observations.json'
    cache_key=hashlib.sha256(json.dumps({'features':fingerprints,'pairs':[(p['a'],p['b']) for p in pairs]},sort_keys=True).encode()).hexdigest()
    cached=json.loads(evidence.read_text()) if evidence.exists() else None
    if isinstance(cached,dict) and cached.get('key')==cache_key:
        tracks=cached['tracks']
    else:
        for index,pair in enumerate(pairs):
            match,reason=recon.match_pair(features[pair['a']],features[pair['b']],np.random.default_rng(8000+index))
            if match is not None:
                for a,b in zip(match['_indices1'],match['_indices2']):
                    left,right=find((pair['a'],int(a))),find((pair['b'],int(b)))
                    if left!=right:parents[right]=left
            print(json.dumps({'stage':'tracks','completed':index+1,'total':len(pairs),'accepted':match is not None}),flush=True)
        groups={}
        for obs in list(parents):groups.setdefault(find(obs),[]).append(obs)
        tracks=[sorted(obs) for obs in groups.values() if len(obs)>=3 and len({n for n,_ in obs})==len(obs)]
        evidence.write_text(json.dumps({'key':cache_key,'tracks':tracks}),encoding='utf-8')
    cameras=np.array([[scenes[sid]['position']['x'],scenes[sid]['position']['z'],np.deg2rad(scenes[sid]['yaw'])] for sid in ids])
    origins=np.column_stack((cameras[:,0],np.zeros(len(ids)),cameras[:,1]))
    train=[];hold=[];points=[]
    # Held-out observations never enter triangulation, filtering, or fitting.
    for obs in sorted(tracks,key=lambda obs:(-len(obs),str(obs)))[:args.max_tracks]:
        obs=[(indices[sid],features[sid]['bearings'][int(feature)]) for sid,feature in obs]
        hold_index=int(hashlib.sha256(str([(i,r.tolist()) for i,r in obs]).encode()).hexdigest()[:8],16)%len(obs)
        withheld=[obs[hold_index]] if len(obs)>=4 else []
        fitting=[item for index,item in enumerate(obs) if not withheld or index!=hold_index]
        ci=np.array([i for i,_ in fitting]);local=np.array([r for _,r in fitting])
        rays=world_rays(local,cameras[ci,2]);point=triangulate(origins[ci],rays)
        if point is None:continue
        predicted=point-origins[ci];predicted/=np.linalg.norm(predicted,axis=1)[:,None]
        error=np.rad2deg(np.arccos(np.clip((predicted*rays).sum(axis=1),-1,1)))
        if np.max(error)>4:continue
        pi=len(points);points.append(point)
        train.extend((i,pi,r) for i,r in fitting);hold.extend((i,pi,r) for i,r in withheld)
    if len(points)<30 or len(hold)<20:raise ValueError('Insufficient multi-view validation tracks')
    points=np.array(points);ci=np.array([i for i,_,_ in train]);ti=np.array([i for _,i,_ in train]);rays=np.array([r for _,_,r in train])
    # Fix one camera and one nonzero baseline to remove similarity gauge.
    fixed=0;other=int(np.argmax(np.linalg.norm(origins-origins[fixed],axis=1)))
    baseline=float(np.linalg.norm(origins[other]-origins[fixed]))
    x0=np.r_[cameras.ravel(),points.ravel()];nc=cameras.size
    def decode(x):return x[:nc].reshape(-1,3),x[nc:].reshape(-1,3)
    def residual(x):
        cam,pts=decode(x);o=np.column_stack((cam[ci,0],np.zeros(len(ci)),cam[ci,1]))
        delta=pts[ti]-o;direction=delta/np.maximum(np.linalg.norm(delta,axis=1)[:,None],1e-9)
        angular=(direction-world_rays(rays,cam[ci,2])).ravel()
        return np.r_[angular,(cam[fixed]-cameras[fixed])*10,(np.linalg.norm(cam[other,:2]-cam[fixed,:2])-baseline)*10]
    sparsity=lil_matrix((len(train)*3+4,len(x0)),dtype=int)
    for i,(cam,track,_) in enumerate(train):
        sparsity[i*3:i*3+3,cam*3:cam*3+3]=1;sparsity[i*3:i*3+3,nc+track*3:nc+track*3+3]=1
    sparsity[-4:-1,fixed*3:fixed*3+3]=1;sparsity[-1,fixed*3:fixed*3+2]=1;sparsity[-1,other*3:other*3+2]=1
    print(json.dumps({'stage':'fit','cameras':len(ids),'tracks':len(points),'trainingObservations':len(train),'heldOutObservations':len(hold)}),flush=True)
    fit=least_squares(residual,x0,jac_sparsity=sparsity.tocsr(),loss='soft_l1',f_scale=.005,max_nfev=args.max_evaluations,x_scale='jac',verbose=0)
    def errors(x,observations):
        cam,pts=decode(x);a=np.array([i for i,_,_ in observations]);b=np.array([i for _,i,_ in observations]);local=np.array([r for _,_,r in observations])
        delta=pts[b]-np.column_stack((cam[a,0],np.zeros(len(a)),cam[a,1]));delta/=np.maximum(np.linalg.norm(delta,axis=1)[:,None],1e-9)
        e=np.rad2deg(np.arccos(np.clip((delta*world_rays(local,cam[a,2])).sum(axis=1),-1,1)))
        return {'medianDegrees':float(np.median(e)),'p90Degrees':float(np.quantile(e,.9)),'above5Degrees':int((e>5).sum())}
    before,after=errors(x0,hold),errors(fit.x,hold)
    accepted=bool(fit.success and after['medianDegrees']<before['medianDegrees']*.9 and after['p90Degrees']<=before['p90Degrees'] and after['above5Degrees']<=before['above5Degrees'])
    cam,pts=decode(fit.x)
    report={'status':'candidate' if accepted else 'rejected','appliedToTour':False,'metricCalibration':False,'solverConverged':bool(fit.success),'evaluations':fit.nfev,'termination':fit.message,'optimality':float(fit.optimality),'cameras':len(ids),'tracks':len(points),'heldOutObservations':len(hold),'cameraTrainingSupport':{sid:int((ci==i).sum()) for i,sid in enumerate(ids)},'unsupportedSceneIds':[sid for i,sid in enumerate(ids) if int((ci==i).sum())<6],'before':before,'after':after,'trainingBefore':errors(x0,train),'trainingAfter':errors(fit.x,train),'limitation':'Held-out feature agreement is not dense-surface or metric validation. Unobserved camera degrees of freedom remain unresolved.'}
    (output/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    (output/'candidate.json').write_text(json.dumps({'scale':'relative','scenes':[{'id':sid,'position':{'x':float(cam[i,0]),'y':0,'z':float(cam[i,1])},'yaw':float(np.rad2deg(cam[i,2]))} for i,sid in enumerate(ids)],'points':pts.tolist()}),encoding='utf-8')
    print(json.dumps(report),flush=True)

if __name__=='__main__':main()
