"""Conservative independent line fitting of local radial boundary evidence.

No camera graph, Manhattan axes, room templates or external model is used.
Success describes agreement with the input profile, not surveyed accuracy.
"""
import os
import sys
if os.environ.get('IMO3D_CV_PATH'):
    sys.path.insert(0, os.environ['IMO3D_CV_PATH'])
import numpy as np
import cv2


def _radii(poly, angles):
    edge = np.roll(poly, -1, axis=0) - poly
    rays = np.column_stack((np.sin(angles), -np.cos(angles)))
    cross = rays[:, None, 0] * edge[None, :, 1] - rays[:, None, 1] * edge[None, :, 0]
    with np.errstate(divide='ignore', invalid='ignore'):
        radius = (poly[:, 0] * edge[:, 1] - poly[:, 1] * edge[:, 0])[None, :] / cross
        fraction = (poly[None, :, 0] * rays[:, None, 1] - poly[None, :, 1] * rays[:, None, 0]) / cross
    valid = (np.abs(cross) > 1e-10) & (radius > 0) & (fraction >= -1e-7) & (fraction <= 1 + 1e-7)
    return np.min(np.where(valid, radius, np.inf), axis=1)


def _simple(poly):
    def cross(a, b, c):
        d, e = b-a, c-a
        return d[0]*e[1]-d[1]*e[0]
    for i, a in enumerate(poly):
        b = poly[(i+1) % len(poly)]
        if np.linalg.norm(b-a) < .08:
            return False
        for j in range(i+2, len(poly)):
            if i == 0 and j == len(poly)-1:
                continue
            c, d = poly[j], poly[(j+1) % len(poly)]
            if cross(a,b,c)*cross(a,b,d) <= 0 and cross(c,d,a)*cross(c,d,b) <= 0:
                if np.all(np.maximum(np.minimum(a,b),np.minimum(c,d)) <= np.minimum(np.maximum(a,b),np.maximum(c,d))+1e-9):
                    return False
    return abs(np.sum(poly[:,0]*np.roll(poly[:,1],-1)-poly[:,1]*np.roll(poly[:,0],-1))) > .02


def _line(samples):
    kept = samples
    for _ in range(3):
        center = np.mean(kept, axis=0)
        _, values, vectors = np.linalg.svd(kept-center, full_matrices=False)
        if len(values)<2 or values[0]<1e-6:
            return None
        normal = vectors[-1]
        offset = np.median(kept @ normal)
        error = np.abs(samples @ normal-offset)
        kept = samples[error <= max(.005, np.median(error)*3)]
        if len(kept)<4:
            return None
    return normal, offset


def fit(radii):
    """Return (Nx2 polygon, evidence) or None; validation uses withheld rays."""
    radii = np.asarray(radii, dtype=float)
    if radii.ndim != 1 or not 128 <= len(radii) <= 8192 or not np.all(np.isfinite(radii)) or np.any(radii <= .02):
        return None
    count = len(radii)
    angles = (np.arange(count)/count-.5)*2*np.pi
    points = np.column_stack((np.sin(angles)*radii,-np.cos(angles)*radii))
    candidates = []
    # Proposals use only even columns; odd columns never participate in fitting.
    train = np.arange(0,count,2)
    for fraction in (.006,.01,.016,.025,.04):
        tolerance = max(.012, np.median(radii)*fraction)
        raw = cv2.approxPolyDP(points[train].astype(np.float32),tolerance,True).reshape(-1,2)
        if not 3 <= len(raw) <= 24:
            continue
        nearest = [int(train[np.argmin(np.linalg.norm(points[train]-p,axis=1))]) for p in raw]
        lines, supported = [], []
        for i,start in enumerate(nearest):
            end = nearest[(i+1)%len(nearest)]
            members = np.arange(start,end if end>start else end+count)%count
            trim = max(1,len(members)//14)
            members = members[trim:-trim]
            members = members[members%2==0]
            if len(members)<6:
                break
            line = _line(points[members])
            if line is None:
                break
            lines.append(line)
            supported.append(members)
        if len(lines)!=len(raw):
            continue
        vertices=[]
        for i,(normal,offset) in enumerate(lines):
            previous,old=lines[i-1]
            matrix=np.array([previous,normal])
            if abs(np.linalg.det(matrix))<.08:
                break
            vertices.append(np.linalg.solve(matrix,[old,offset]))
        if len(vertices)!=len(raw):
            continue
        polygon=np.asarray(vertices)
        if not _simple(polygon) or np.max(np.linalg.norm(polygon-raw,axis=1))>max(.08,tolerance*4):
            continue
        predicted=_radii(polygon,angles)
        if not np.all(np.isfinite(predicted)):
            continue
        error=np.degrees(np.abs(np.arctan(1/predicted)-np.arctan(1/radii)))
        relative=np.abs(predicted-radii)/radii
        held=error[1::2]
        if np.quantile(held,.95)>1.5 or np.quantile(held,.99)>3 or np.mean(error<1.5)<.95 or np.quantile(relative,.95)>.1:
            continue
        # Every face must have support. A low aggregate error cannot hide an invented face.
        face_errors=[]
        for i,start in enumerate(nearest):
            end=nearest[(i+1)%len(nearest)]
            members=np.arange(start,end if end>start else end+count)%count
            face_errors.append(float(np.quantile(error[members],.9)))
        if max(face_errors)>2:
            continue
        # Curved outlines do not become architectural polygons merely by adding vertices.
        sharp=[]
        window=max(3,count//180)
        for index in nearest:
            a=points[index]-points[(index-window)%count]
            b=points[(index+window)%count]-points[index]
            cosine=np.dot(a,b)/max(1e-10,np.linalg.norm(a)*np.linalg.norm(b))
            sharp.append(np.degrees(np.arccos(np.clip(cosine,-1,1))))
        if np.mean(np.asarray(sharp)>10)<.65:
            continue
        evidence={'method':'independent-observed-line-fit','classification':'estimated_profile_geometry',
                  'heldOutP95Degrees':float(np.quantile(held,.95)),'heldOutP99Degrees':float(np.quantile(held,.99)),
                  'supportedRayFraction':float(np.mean(error<1.5)), 'worstFaceP90Degrees':max(face_errors),
                  'wallCount':len(polygon),'heldOutRays':len(held),'scale':'camera_height',
                  'limitation':'Profile agreement is not independent photographic or surveyed verification.'}
        candidates.append((float(np.quantile(held,.95))+.025*len(polygon),polygon,evidence))
    if not candidates:
        return None
    _,polygon,evidence=min(candidates,key=lambda item:item[0])
    return polygon,evidence
