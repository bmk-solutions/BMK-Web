import {createHash} from 'node:crypto';
import {imageFingerprint} from './processing-jobs';

type CameraInput=Parameters<typeof imageFingerprint>[0];

/** A plan may only finish against the camera state it actually reviewed. */
export function assertPlanGeometryCurrent(source:CameraInput,current:CameraInput,processingActive:boolean){
 if(processingActive||imageFingerprint(source)!==imageFingerprint(current))throw Error('STALE_GEOMETRY');
}

/** Cached labels and audits belong to these exact PNG bytes, not a reusable path. */
export function planImageDigest(bytes:Uint8Array){return createHash('sha256').update(bytes).digest('hex');}
export function matchesPlanImageDigest(bytes:Uint8Array,digest:unknown){
 return typeof digest==='string'&&/^[a-f0-9]{64}$/.test(digest)&&planImageDigest(bytes)===digest;
}
