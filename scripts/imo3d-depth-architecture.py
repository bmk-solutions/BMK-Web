"""Architectural candidates from independently reprojected multi-camera depth.

Input pointSamples use BMK world coordinates (+Y up), camera-height units and
sceneIds containing only distinct physical cameras that verified each sample.
These are estimated surface/visibility constraints, never surveyed wall geometry.
The module does not load a neural model, read images, or mutate a saved tour.
"""
from __future__ import annotations
import argparse
import json
import math
import os
from pathlib import Path
import sys

if os.environ.get("IMO3D_CV_PATH"):
    sys.path.insert(0, os.environ["IMO3D_CV_PATH"])
import numpy as np
from scipy.spatial import cKDTree


def prepare_samples(samples, scenes, voxel=.025):
    known = {scene["id"] for scene in scenes}
    cells = {}
    rejected = 0
    for sample in samples:
        point = np.asarray([sample.get(k, math.nan) for k in ("x", "y", "z")], dtype=float)
        cameras = set(sample.get("sceneIds", [])) & known
        confidence = sample.get("confidence", 0)
        if not np.all(np.isfinite(point)) or not math.isfinite(confidence) or not .5 <= confidence <= 1 or len(cameras) < 2:
            rejected += 1
            continue
        key = tuple(np.floor(point / voxel).astype(np.int64))
        cell = cells.setdefault(key, {"points": [], "cameras": set(), "confidence": [], "normals": []})
        cell["points"].append(point); cell["cameras"].update(cameras); cell["confidence"].append(confidence)
        normal=sample.get("normal")
        if normal:
            vector=np.asarray([normal.get(k,math.nan) for k in ("x","y","z")],dtype=float)
            if np.all(np.isfinite(vector)) and .8<np.linalg.norm(vector)<1.2:
                if cell["normals"] and np.dot(vector,cell["normals"][0])<0:vector=-vector
                cell["normals"].append(vector)
    values = list(cells.values())
    points = np.asarray([np.median(cell["points"], axis=0) for cell in values], dtype=float).reshape(-1, 3)
    normals=np.asarray([np.median(cell["normals"],axis=0) if cell["normals"] else [math.nan]*3 for cell in values]).reshape(-1,3)
    return points, [cell["cameras"] for cell in values], np.asarray([np.median(cell["confidence"]) for cell in values]), rejected, normals


def surface_normals(points, radius=.16):
    """Local PCA excludes isolated points and corners from plane voting."""
    if len(points) < 12:
        return np.zeros_like(points), np.zeros(len(points), dtype=bool)
    distance, index = cKDTree(points).query(points, k=min(20, len(points)))
    local = points[index]
    centered = local - local.mean(axis=1, keepdims=True)
    covariance = np.einsum("nki,nkj->nij", centered, centered) / local.shape[1]
    eigenvalues, eigenvectors = np.linalg.eigh(covariance)
    planar = (distance[:, -1] < radius) & (eigenvalues[:, 1] > 1e-6) & (eigenvalues[:, 0] / np.maximum(1e-9, eigenvalues.sum(axis=1)) < .035)
    return eigenvectors[:, :, 0], planar


def infer_floor(points, normals, planar, camera_height):
    # Camera-height scale provides a loose search band, not a forced floor.
    candidates = planar & (np.abs(normals[:, 1]) > .94) & (points[:, 1] > camera_height - 1.5) & (points[:, 1] < camera_height - .55)
    values = points[candidates, 1]
    if len(values) < 30:
        return None
    edges = np.arange(camera_height - 1.5, camera_height - .5, .035)
    histogram, _ = np.histogram(values, edges)
    best = int(np.argmax(histogram)); center = (edges[best] + edges[best + 1]) / 2
    consensus = values[np.abs(values - center) < .065]
    if len(consensus) < 30:
        return None
    height = float(np.median(consensus)); residual = float(np.median(np.abs(consensus - height)))
    return {"height": height, "confidence": round(min(.95, len(consensus) / 200) / (1 + residual * 8), 4), "supportPoints": len(consensus), "residual": residual}


def fit_wall_planes(points, cameras, confidence, normals, planar, floor_height, seed=739):
    """Fit observed vertical planes with broad height support; never fill gaps."""
    candidates = np.flatnonzero(planar & (np.abs(normals[:, 1]) < .3) & (points[:, 1] > floor_height + .12) & (points[:, 1] < floor_height + 2.8))
    remaining = candidates.copy(); output = []; rng = np.random.default_rng(seed)
    for _ in range(20):
        if len(remaining) < 60:
            break
        cloud = points[remaining]; best = None; best_score = 0
        for picked in rng.choice(len(remaining), min(160, len(remaining)), replace=False):
            normal = normals[remaining[picked], [0, 2]]; normal = normal / np.linalg.norm(normal)
            offset = float(cloud[picked, [0, 2]] @ normal)
            distance = np.abs(cloud[:, [0, 2]] @ normal - offset)
            orientation = np.abs(normals[remaining][:, [0, 2]] @ normal)
            mask = (distance < .055) & (orientation > .9)
            if mask.sum() < 60:
                continue
            support = cloud[mask]; heights = np.quantile(support[:, 1], [.05, .95])
            if heights[0] > floor_height + .48 or heights[1] < floor_height + 1.25 or heights[1] - heights[0] < .85:
                continue
            score = float(confidence[remaining[mask]].sum())
            if score > best_score:
                best, best_score = mask, score
        if best is None:
            break
        chosen = remaining[best]; horizontal = points[chosen][:, [0, 2]]
        origin = np.median(horizontal, axis=0)
        _, _, vectors = np.linalg.svd(horizontal - origin, full_matrices=False)
        tangent = vectors[0]; normal = np.asarray([-tangent[1], tangent[0]])
        if normal[0] < 0 or normal[0] == 0 and normal[1] < 0:
            normal *= -1; tangent *= -1
        offset = float(np.median(horizontal @ normal))
        distance = np.abs(points[remaining][:, [0, 2]] @ normal - offset)
        mask = (distance < .055) & (np.abs(normals[remaining][:, [0, 2]] @ normal) > .9)
        chosen = remaining[mask]; support = points[chosen]; projection = support[:, [0, 2]] @ tangent
        order = np.argsort(projection)
        parts = np.split(order, np.flatnonzero(np.diff(projection[order]) > .22) + 1)
        segments = []
        for part in parts:
            if len(part) < 35:
                continue
            start, end = np.quantile(projection[part], [.02, .98])
            heights = np.quantile(support[part, 1], [.05, .95])
            ids = set().union(*(cameras[i] for i in chosen[part]))
            if end - start < .35 or len(ids) < 2 or heights[0] > floor_height + .48 or heights[1] < floor_height + 1.25 or heights[1] - heights[0] < .85:
                continue
            a, b = normal * offset + tangent * start, normal * offset + tangent * end
            segments.append({"a": {"x": float(a[0]), "z": float(a[1])}, "b": {"x": float(b[0]), "z": float(b[1])}, "heightRange": heights.tolist(), "supportPoints": len(part), "supportCameras": sorted(ids)})
        if segments:
            residual = float(np.median(np.abs(support[:, [0, 2]] @ normal - offset)))
            output.append({"id": "wall-" + str(len(output) + 1), "normal": {"x": float(normal[0]), "z": float(normal[1])}, "offset": offset,
                           "segments": segments, "heightRange": np.quantile(support[:, 1], [.05, .95]).tolist(),
                           "supportCameras": sorted(set().union(*(cameras[i] for i in chosen))), "supportPoints": len(chosen), "residual": residual,
                           "_supportCoordinates":support,"_supportCameraSets":[cameras[i] for i in chosen],
                           "confidence": round(min(.92, .65 + len(chosen) / 10000) / (1 + residual * 4), 4)})
        remaining = remaining[~mask]
    return output


def infer_openings(walls, points, cameras, scenes, floor_height):
    """Positive free-space rays are required; missing wall samples prove nothing."""
    centers = {scene["id"]: np.asarray([scene["position"][k] for k in ("x", "y", "z")]) for scene in scenes if scene.get("position")}
    openings = []
    for wall in walls:
        normal = np.asarray([wall["normal"]["x"], wall["normal"]["z"]]); tangent = np.asarray([-normal[1], normal[0]])
        intervals = sorted([sorted([np.asarray([segment[p]["x"], segment[p]["z"]]) @ tangent for p in ("a", "b")]) for segment in wall["segments"]])
        # A void must be bounded by actual support on both sides of this plane.
        for left, right in zip(intervals, intervals[1:]):
            start, end = left[1], right[0]
            if not .1 < end - start < 1.6:
                continue
            crossings = []
            for scene_id, center in centers.items():
                selected = np.asarray([scene_id in ids for ids in cameras])
                delta = points - center
                denominator = delta[:, [0, 2]] @ normal
                fraction = (wall["offset"] - center[[0, 2]] @ normal) / np.where(np.abs(denominator) > 1e-8, denominator, np.nan)
                hit = center + fraction[:, None] * delta
                along = hit[:, [0, 2]] @ tangent
                keep = selected & (fraction > .03) & (fraction < .97) & (np.abs(denominator) > .2) & (along > start) & (along < end) & (hit[:, 1] > floor_height + .12) & (hit[:, 1] < floor_height + 1.4)
                crossings.extend((float(t), float(y), scene_id) for t, y in zip(along[keep], hit[keep, 1]))
            ids = {hit[2] for hit in crossings}
            if len(crossings) < 30 or len(ids) < 2:
                continue
            observed = np.asarray([hit[:2] for hit in crossings]); heights = np.quantile(observed[:, 1], [.05, .95]); bounds = np.quantile(observed[:, 0], [.05, .95])
            if heights[0] > floor_height + .6 or heights[1] - heights[0] < .5 or bounds[1] - bounds[0] < .1:
                continue
            a, b = normal * wall["offset"] + tangent * bounds[0], normal * wall["offset"] + tangent * bounds[1]
            openings.append({"wallId": wall["id"], "a": {"x": float(a[0]), "z": float(a[1])}, "b": {"x": float(b[0]), "z": float(b[1])}, "heightRange": heights.tolist(),
                             "supportCameras": sorted(ids), "supportRays": len(crossings), "source": "observed_free_space", "verified": False, "widthInterpretation": "visible_span_lower_bound"})
    return openings


def observed_room_cycles(walls, max_corner_extension=.18, camera_centers=None):
    """Close only degree-two cycles of observed segments, not their convex hull."""
    segments = [(wall["id"], segment) for wall in walls for segment in wall["segments"]]
    endpoints = [np.asarray([segment[end]["x"], segment[end]["z"]]) for _, segment in segments for end in ("a", "b")]
    links = {}; joins = {}
    for i in range(len(segments)):
        a, b = endpoints[2*i:2*i+2]; u = b-a
        for j in range(i + 1, len(segments)):
            c, d = endpoints[2*j:2*j+2]; v = d-c
            matrix = np.column_stack([u, -v])
            if abs(np.linalg.det(matrix)) / max(1e-9, np.linalg.norm(u)*np.linalg.norm(v)) < .45:
                continue
            solution = np.linalg.solve(matrix, c-a); intersection = a+solution[0]*u
            first = min(range(2), key=lambda k: np.linalg.norm(intersection-endpoints[2*i+k])); second = min(range(2), key=lambda k: np.linalg.norm(intersection-endpoints[2*j+k]))
            x, y = 2*i+first, 2*j+second
            if max(np.linalg.norm(intersection-endpoints[x]), np.linalg.norm(intersection-endpoints[y])) <= max_corner_extension:
                links.setdefault(x, []).append(y); links.setdefault(y, []).append(x); joins[(min(x,y),max(x,y))] = intersection
    visited = set(); outlines = []
    for initial in range(len(segments)):
        if initial in visited:
            continue
        edge = 2*initial; current = edge; order = []; used = set(); polygon = []
        while current//2 not in used:
            used.add(current//2); order.append(current//2)
            outgoing = current ^ 1
            if len(links.get(outgoing, [])) != 1:
                break
            following = links[outgoing][0]
            if len(links.get(following, [])) != 1:
                break
            polygon.append(joins[(min(outgoing,following),max(outgoing,following))]); current = following
            if current == edge:
                if len(order) >= 3:
                    area = abs(sum(polygon[(i+1)%len(polygon)][0]*polygon[i][1]-polygon[(i+1)%len(polygon)][1]*polygon[i][0] for i in range(len(polygon))))/2
                    crossing = False
                    cross = lambda a,b,c: (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])
                    for i,a in enumerate(polygon):
                        b=polygon[(i+1)%len(polygon)]
                        for j in range(i+2,len(polygon)):
                            if i==0 and j==len(polygon)-1:continue
                            c,d=polygon[j],polygon[(j+1)%len(polygon)]
                            crossing |= cross(a,b,c)*cross(a,b,d)<0 and cross(c,d,a)*cross(c,d,b)<0
                    def contains(point):
                        inside=False
                        for i,a in enumerate(polygon):
                            b=polygon[(i+1)%len(polygon)]
                            if (a[1]>point[1])!=(b[1]>point[1]) and point[0]<(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0]:inside=not inside
                        return inside
                    inhabited=camera_centers is None or any(contains(center) for center in camera_centers)
                    if area > .2 and not crossing and inhabited:
                        outlines.append({"outline": [{"x":float(p[0]),"z":float(p[1])} for p in polygon], "wallIds": [segments[i][0] for i in order], "areaCameraHeightSquared": float(area), "confidence": "estimated", "cornerTolerance": max_corner_extension})
                visited.update(used); break
    return outlines


def polygon_area(polygon):
    return abs(float(np.sum(polygon[:,0]*np.roll(polygon[:,1],-1)-polygon[:,1]*np.roll(polygon[:,0],-1))))/2


def polygon_contains(point, polygon):
    inside=False
    for i,a in enumerate(polygon):
        b=polygon[(i+1)%len(polygon)]
        if (a[1]>point[1])!=(b[1]>point[1]) and point[0]<(b[0]-a[0])*(point[1]-a[1])/(b[1]-a[1])+a[0]:inside=not inside
    return inside


def simple_polygon(polygon):
    if not 3<=len(polygon)<=80 or not np.all(np.isfinite(polygon)) or polygon_area(polygon)<.05:return False
    cross=lambda a,b,c:(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])
    for i,a in enumerate(polygon):
        b=polygon[(i+1)%len(polygon)]
        if np.linalg.norm(a-b)<.01:return False
        for j in range(i+2,len(polygon)):
            if i==0 and j==len(polygon)-1:continue
            c,d=polygon[j],polygon[(j+1)%len(polygon)]
            if cross(a,b,c)*cross(a,b,d)<=0 and cross(c,d,a)*cross(c,d,b)<=0 and max(min(a[0],b[0]),min(c[0],d[0]))<=min(max(a[0],b[0]),max(c[0],d[0])) and max(min(a[1],b[1]),min(c[1],d[1]))<=min(max(a[1],b[1]),max(c[1],d[1])):return False
    return True


def refine_room_outlines(prior_rooms, walls, scenes, max_shift=.2):
    """Propose bounded line corrections to existing image-derived boundaries.

    Unsupported edge lines and all indices survive; this does not create a room,
    infer missing corners, or replace an authored plan. Proposals require two
    nonparallel observed planes and an actual reduction in wall-fit residual.
    """
    proposals=[];rejections=[]
    centers=[np.asarray([scene['position']['x'],scene['position']['z']]) for scene in scenes if scene.get('position')]
    for room in prior_rooms:
        if room.get('authored') or room.get('source')=='authored':
            rejections.append({'roomId':room['id'],'reason':'authored_state_preserved'});continue
        polygon=np.asarray([[p['x'],p['z']] for p in room['outline']],dtype=float)
        if not simple_polygon(polygon):
            rejections.append({'roomId':room['id'],'reason':'invalid_prior_outline'});continue
        lines=[];matches=[];contained=[point for point in centers if polygon_contains(point,polygon)]
        for i,a in enumerate(polygon):
            b=polygon[(i+1)%len(polygon)];length=np.linalg.norm(b-a);tangent=(b-a)/length;normal=np.asarray([-tangent[1],tangent[0]]);offset=float(a@normal)
            lines.append((normal,offset));options=[]
            if length<.35:continue
            for wall in walls:
                if wall['supportPoints']<300 or wall['residual']>.035 or len(wall['supportCameras'])<2:continue
                candidate=np.asarray([wall['normal']['x'],wall['normal']['z']]);distance=float(wall['offset'])
                if candidate@normal<0:candidate=-candidate;distance=-distance
                angle=math.degrees(math.acos(float(np.clip(candidate@normal,-1,1))))
                displacement=abs(float(((a+b)/2)@candidate-distance))
                if angle>8 or displacement>max_shift:continue
                sample=[];covered=[]
                for segment in wall['segments']:
                    start=np.asarray([segment['a']['x'],segment['a']['z']]);end=np.asarray([segment['b']['x'],segment['b']['z']])
                    lo,hi=sorted([float((start-a)@tangent),float((end-a)@tangent)])
                    lo,hi=max(0.,lo),min(length,hi)
                    if hi>lo:
                        covered.append((lo,hi));sample.extend(start+(end-start)*t for t in np.linspace(0,1,20) if 0<=(start+(end-start)*t-a)@tangent<=length)
                if not sample:continue
                covered.sort();extent=0.;cursor=0.
                for lo,hi in covered:extent+=max(0.,hi-max(lo,cursor));cursor=max(cursor,hi)
                if extent/length<.55:continue
                support_points=wall['supportPoints'];support_cameras=wall['supportCameras']
                if '_supportCoordinates' in wall:
                    coordinates=wall['_supportCoordinates'];horizontal=coordinates[:,[0,2]];along=(horizontal-a)@tangent
                    mask=(along>=0)&(along<=length)
                    if mask.sum()<60:continue
                    heights=np.quantile(coordinates[mask,1],[.05,.95])
                    if heights[1]-heights[0]<.85:continue
                    sample=horizontal[mask];support_points=int(mask.sum());support_cameras=sorted(set().union(*(wall['_supportCameraSets'][i] for i in np.flatnonzero(mask))))
                    before=float(np.median(np.abs(sample@normal-offset)));after=float(np.median(np.abs(sample@candidate-distance)))
                else:
                    before=float(np.median(np.abs(np.asarray(sample)@normal-offset)));after=float(wall['residual'])
                if before<after+.015 or after>before*.7:continue
                options.append({'edge':i,'normal':candidate,'offset':distance,'wallId':wall['id'],'coverage':extent/length,'beforeResidual':before,'afterResidual':after,'supportPoints':support_points,'supportCameras':support_cameras,'score':extent/length*support_points/(1+angle+displacement*10)})
            if options:matches.append(max(options,key=lambda value:value['score']))
        def solve(changes):
            selected=dict((change['edge'],change) for change in changes);vertices=[]
            for i in range(len(polygon)):
                indices=[(i-1)%len(polygon),i]
                equations=[(selected[j]['normal'],selected[j]['offset']) if j in selected else lines[j] for j in indices]
                matrix=np.asarray([equation[0] for equation in equations]);rhs=np.asarray([equation[1] for equation in equations])
                if abs(np.linalg.det(matrix))<1e-5:
                    if any(j in selected for j in indices):return None,'unstable_parallel_corner'
                    vertices.append(polygon[i]);continue
                vertices.append(np.linalg.solve(matrix,rhs))
            value=np.asarray(vertices)
            if not simple_polygon(value):return None,'invalid_polygon'
            if np.max(np.linalg.norm(value-polygon,axis=1))>max_shift:return None,'corner_shift_exceeds_limit'
            if not .9<polygon_area(value)/polygon_area(polygon)<1.1:return None,'area_change_exceeds_limit'
            if any(not polygon_contains(point,value) for point in contained):return None,'camera_containment_lost'
            return value,None
        chosen=[];updated=polygon;rejected_edges=[]
        for match in sorted(matches,key=lambda value:-value['score']):
            candidate,reason=solve([*chosen,match])
            if candidate is not None:chosen.append(match);updated=candidate
            else:rejected_edges.append({'edge':match['edge'],'reason':reason})
        independent=any(abs(a['normal']@b['normal'])<.7 for i,a in enumerate(chosen) for b in chosen[i+1:])
        if not independent:
            rejections.append({'roomId':room['id'],'reason':'insufficient_independent_bounded_wall_support','matchedEdges':[m['edge'] for m in matches],'retainedEdges':[m['edge'] for m in chosen],'rejectedEdges':rejected_edges});continue
        # Neighbor interiors are protected conservatively with a dense local
        # occupancy comparison; no new overlap above one grid-cell tolerance.
        overlap_increase=0.
        for other in prior_rooms:
            if other['id']==room['id']:continue
            accepted_other=next((proposal for proposal in proposals if proposal['id']==other['id']),other)
            neighbour=np.asarray([[p['x'],p['z']] for p in accepted_other['outline']],dtype=float)
            low=np.maximum(np.minimum(polygon.min(0),updated.min(0)),neighbour.min(0));high=np.minimum(np.maximum(polygon.max(0),updated.max(0)),neighbour.max(0))
            if np.any(high<=low):continue
            spacing=max(.02,float(np.max(high-low))/180)
            grid=np.array(np.meshgrid(np.arange(low[0],high[0],spacing)+spacing/2,np.arange(low[1],high[1],spacing)+spacing/2)).reshape(2,-1).T
            increase=sum(polygon_contains(point,neighbour) and polygon_contains(point,updated) and not polygon_contains(point,polygon) for point in grid)*spacing**2
            overlap_increase=max(overlap_increase,increase)
        if overlap_increase>.025:
            rejections.append({'roomId':room['id'],'reason':'new_neighbour_overlap','estimatedOverlapIncrease':overlap_increase});continue
        proposals.append({**room,'outline':[{'x':float(p[0]),'z':float(p[1])} for p in updated],
                          'refinement':{'source':'image_outline_refined_by_multiview_depth','units':'camera_height','verified':False,'previousOutline':room['outline'],'maxCornerShift':float(np.max(np.linalg.norm(updated-polygon,axis=1))),'areaRatio':polygon_area(updated)/polygon_area(polygon),'cameraContainmentPreserved':True,'doorEdgeIndicesPreserved':True,'unchangedEdgeLines':[i for i in range(len(polygon)) if i not in {m['edge'] for m in chosen}],
                                        'supportedEdgeChanges':[{k:v for k,v in change.items() if k not in ['normal','offset','score']} for change in chosen],'rejectedEdgeChanges':rejected_edges,'estimatedNewOverlap':overlap_increase}})
    return proposals,rejections


def reconstruct_architecture(payload):
    scenes = [scene for scene in payload.get("scenes", []) if scene.get("position")]
    if len(payload.get("pointSamples", [])) > 150000:
        raise ValueError("Architectural input exceeds the bounded 150000-point contract")
    if len({scene.get("floor",0) for scene in scenes})>1 or len({scene.get("componentId") for scene in scenes if scene.get("componentId")})>1:
        raise ValueError("Independent floors or coordinate components cannot be merged")
    points, cameras, confidence, rejected, supplied_normals = prepare_samples(payload.get("pointSamples", []), scenes)
    if len(points) < 100 or len({scene["id"] for scene in scenes}) < 2:
        return {"version": 1, "units": "camera_height", "status": "insufficient_support", "wallPlanes": [], "openings": [], "roomOutlines": [], "diagnostics": {"supportedPoints": len(points), "rejectedPoints": rejected}}
    normals, planar = surface_normals(points)
    supplied=np.all(np.isfinite(supplied_normals),axis=1)
    normals[supplied]=supplied_normals[supplied]/np.linalg.norm(supplied_normals[supplied],axis=1,keepdims=True)
    planar|=supplied
    camera_height = float(np.median([scene["position"]["y"] for scene in scenes]))
    floor = infer_floor(points, normals, planar, camera_height)
    if floor is None:
        return {"version": 1, "units": "camera_height", "status": "unresolved_floor", "wallPlanes": [], "openings": [], "roomOutlines": [], "diagnostics": {"supportedPoints": len(points), "rejectedPoints": rejected}}
    walls = fit_wall_planes(points, cameras, confidence, normals, planar, floor["height"])
    openings = infer_openings(walls, points, cameras, scenes, floor["height"])
    outlines = observed_room_cycles(walls, camera_centers=[np.asarray([scene["position"]["x"],scene["position"]["z"]]) for scene in scenes])
    proposals,proposal_rejections=refine_room_outlines(payload.get('priorRooms',[]),walls,scenes)
    public_walls=[{key:value for key,value in wall.items() if not key.startswith('_')} for wall in walls]
    return {"version": 1, "units": "camera_height", "status": "estimated" if outlines else "partial", "floor": floor, "wallPlanes": public_walls, "openings": openings, "roomOutlines": outlines,"proposedRooms":proposals,"proposalRejections":proposal_rejections,
            "diagnostics": {"supportedPoints": len(points), "rejectedPoints": rejected, "planarPoints": int(planar.sum()), "verticalPlanarPoints": int((planar & (np.abs(normals[:,1]) < .3)).sum()), "wallSegments": sum(len(wall["segments"]) for wall in walls)},
            "limitations": ["Depth consensus is estimated, not surveyed geometry.", "Tall furniture, glazing and closed doors may remain unclassified surfaces.", "No closure is invented across unsupported gaps; openings require observed free-space rays."]}


if __name__ == "__main__":
    parser=argparse.ArgumentParser();parser.add_argument("--input",required=True);parser.add_argument("--output",required=True);args=parser.parse_args()
    result=reconstruct_architecture(json.loads(Path(args.input).read_text(encoding="utf-8-sig")))
    Path(args.output).write_text(json.dumps(result,allow_nan=False),encoding="utf-8")
