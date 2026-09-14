"""Create a review-only approximate room plan, preserving image-derived topology.

Uses existing reconstructed rooms and per-view boundary estimates. Never joins
components, manufactures openings, or claims surveyed dimensions.
"""
import argparse, importlib.util, json, os, sys
from pathlib import Path
if os.environ.get('IMO3D_CV_PATH'):
    sys.path.insert(0,os.environ['IMO3D_CV_PATH'])
import numpy as np
import cv2
spec=importlib.util.spec_from_file_location('wall_fit',Path(__file__).with_name('imo3d-wall-fit.py'))
wall=importlib.util.module_from_spec(spec);spec.loader.exec_module(wall)


def points(outline):
    return np.asarray([[p['x'],p['z']] for p in outline],dtype=float)


def area(poly):
    return abs(np.sum(poly[:,0]*np.roll(poly[:,1],-1)-poly[:,1]*np.roll(poly[:,0],-1)))/2


def overlap(first,second):
    low=np.minimum(first.min(axis=0),second.min(axis=0));high=np.maximum(first.max(axis=0),second.max(axis=0))
    cell=max(.0125,float(np.max(high-low))/600)
    shape=tuple((np.ceil((high-low)/cell).astype(int)+3)[::-1])
    masks=[]
    for poly in (first,second):
        mask=np.zeros(shape,dtype=np.uint8)
        cv2.fillPoly(mask,[np.rint((poly-low)/cell).astype(np.int32)],1);masks.append(mask)
    return float(np.count_nonzero(masks[0]&masks[1]))*cell*cell


def world_envelope(scene):
    p=scene['position'];yaw=np.radians(scene.get('yaw',0));rotation=np.array([[np.cos(yaw),-np.sin(yaw)],[np.sin(yaw),np.cos(yaw)]])
    return points(scene['roomEnvelope']['outline'])@rotation.T+np.array([p['x'],p['z']])


def build(data):
    by_id={s['id']:s for s in data['scenes']};angles=(np.arange(720)/720-.5)*2*np.pi
    output=[]
    for room in data.get('roomLayout',{}).get('rooms',[]):
        original=points(room['outline']);members=[by_id[i] for i in room['sceneIds'] if by_id.get(i,{}).get('position') and by_id.get(i,{}).get('roomEnvelope')]
        observations=[]
        for s in members:
            origin=np.array([s['position']['x'],s['position']['z']]);observed=wall._radii(world_envelope(s)-origin,angles)
            baseline=wall._radii(original-origin,angles)
            if np.all(np.isfinite(observed)) and np.all(np.isfinite(baseline)):
                observations.append((s,origin,observed,float(np.quantile(np.degrees(np.abs(np.arctan(1/baseline)-np.arctan(1/observed))),.9))))
        def compare(poly):
            deviations=[];profile=[]
            for _,origin,observed,base_error in observations:
                predicted=wall._radii(poly-origin,angles)
                baseline=wall._radii(original-origin,angles)
                if not np.all(np.isfinite(predicted)):return None
                deviations.append(float(np.quantile(np.degrees(np.abs(np.arctan(1/predicted)-np.arctan(1/baseline))),.95)))
                profile.append(float(np.quantile(np.degrees(np.abs(np.arctan(1/predicted)-np.arctan(1/observed))),.9))-base_error)
            if not deviations:return None
            if max(deviations)>1.5 or max(profile)>1.0 or abs(area(poly)/max(1e-9,area(original))-1)>.1:return None
            for other in data.get('roomLayout',{}).get('rooms',[]):
                if other['id']==room['id'] or other['component']!=room['component'] or other['floor']!=room['floor']:continue
                neighbor=points(other['outline'])
                if overlap(poly,neighbor)-overlap(original,neighbor)>.02*min(area(original),area(neighbor)):return None
            return deviations,profile
        candidates=[(len(original),0.,original,'retained-observed-boundary',None)]
        for tolerance in (.02,.04,.06,.08,.1,.14):
            poly=cv2.approxPolyDP(original.astype(np.float32),tolerance,True).reshape(-1,2).astype(float)
            if len(poly)>=len(original) or not wall._simple(poly):continue
            result=compare(poly)
            if result:candidates.append((len(poly),max(result[0]),poly,'multi-view-checked-contour-simplification',result))
        for s in members:
            if not s['roomEnvelope'].get('evidence',{}).get('regularized'):continue
            poly=world_envelope(s)
            if len(poly)>=len(original) or not wall._simple(poly):continue
            result=compare(poly)
            if result:candidates.append((len(poly),max(result[0]),poly,'multi-view-checked-representative-footprint',result))
        _,_,selected,method,validation=min(candidates,key=lambda row:(row[0],row[1]))
        output.append({**room,'outline':[{'x':round(float(p[0]),6),'z':round(float(p[1]),6)} for p in selected],
            'classification':'approximate_photo_derived_room','candidateEvidence':{'method':method,'originalVertices':len(original),'candidateVertices':len(selected),'comparedViewCount':len(observations),'maxViewBoundaryChangeP95Degrees':max(validation[0]) if validation else 0.,'maxProfileResidualIncreaseP90Degrees':max(validation[1]) if validation else 0.,'areaChangeFraction':float(area(selected)/max(1e-9,area(original))-1),'limitations':['Input view boundaries and camera poses are estimated; agreement is not surveyed accuracy.','Walls shared between rooms and openings remain unverified.']}})
        if method!='retained-observed-boundary':
            # These records refer to old polygon edge indices. Carrying them
            # forward would silently put doors on different walls.
            output[-1]['openings']=[]
            output[-1]['doorwayCandidates']=[]
            output[-1]['openingReview']={'status':'pending','reason':'outline_changed_requires_image_supported_reprojection'}
    originals={r['id']:r for r in data.get('roomLayout',{}).get('rooms',[])}
    # Validate combined changes, not only one proposal against unchanged peers.
    # Reverting cannot loop indefinitely: each iteration removes a proposal.
    for _ in range(len(output)):
        reverted=False
        for i,room in enumerate(output):
            for j in range(i+1,len(output)):
                other=output[j]
                if room['component']!=other['component'] or room['floor']!=other['floor']:continue
                first,second=points(room['outline']),points(other['outline'])
                old_first,old_second=points(originals[room['id']]['outline']),points(originals[other['id']]['outline'])
                if overlap(first,second)-overlap(old_first,old_second)<=.02*min(area(old_first),area(old_second)):continue
                changed=[k for k in (i,j) if output[k]['candidateEvidence']['method']!='retained-observed-boundary']
                if not changed:continue
                target=changed[-1];current=output[target];original=originals[current['id']]
                evidence={**current['candidateEvidence'],'method':'retained-observed-boundary','candidateVertices':len(original['outline']),'areaChangeFraction':0.,'maxViewBoundaryChangeP95Degrees':0.,'maxProfileResidualIncreaseP90Degrees':0.,'rejectedProposalReason':'combined_neighbor_overlap'}
                output[target]={**original,'classification':'approximate_photo_derived_room','candidateEvidence':evidence}
                reverted=True;break
            if reverted:break
        if not reverted:break
    unresolved=[s['id'] for s in data['scenes'] if not s.get('position') or not any(s['id'] in r['sceneIds'] for r in output)]
    return {'version':1,'classification':'approximate_photo_derived_plan','status':'review_required','architecturalAcceptance':False,'scale':'camera_height','rooms':output,'relations':data.get('roomLayout',{}).get('relations',[]),'components':[{k:c.get(k) for k in ['id','sceneIds','layout','scaleBasis']} for c in data.get('components',[])],'unresolvedSceneIds':unresolved,'limitations':['No measured accuracy percentage is available.','Separate components retain separate coordinate frames and must not be overlaid.','No doors, hidden walls or metric dimensions are invented.']}


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--input',required=True);parser.add_argument('--output',required=True);args=parser.parse_args()
    data=json.loads(Path(args.input).read_text(encoding='utf-8-sig'));result=build(data)
    Path(args.output).write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'rooms':len(result['rooms']),'originalVertices':sum(r['candidateEvidence']['originalVertices'] for r in result['rooms']),'candidateVertices':sum(len(r['outline']) for r in result['rooms']),'unresolvedSceneIds':result['unresolvedSceneIds']},ensure_ascii=False))
