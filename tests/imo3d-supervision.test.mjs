import {test} from 'node:test';
import assert from 'node:assert/strict';
import {superviseWorker} from '../scripts/lib/imo3d-supervision.mjs';

test('worker recovers from crash with bounded retries and stops without another launch',async()=>{
 const controller=new AbortController(),waits=[];let calls=0;
 await superviseWorker({signal:controller.signal,now:()=>0,run:async()=>{calls++;throw Error('offline');},wait:async ms=>{waits.push(ms);if(waits.length===8)controller.abort();}});
 assert.equal(calls,8);assert.deepEqual(waits,[2000,4000,8000,16000,32000,60000,60000,60000]);
});
test('shutdown during active worker never restarts it',async()=>{
 const controller=new AbortController();let waits=0;
 await superviseWorker({signal:controller.signal,run:async()=>controller.abort(),wait:async()=>{waits++;}});
 assert.equal(waits,0);
});
test('stable worker resets restart backoff',async()=>{
 const controller=new AbortController(),waits=[];let time=0,calls=0;
 await superviseWorker({signal:controller.signal,now:()=>time,run:async()=>{if(++calls===3)time+=60000;},wait:async ms=>{waits.push(ms);if(waits.length===3)controller.abort();}});
 assert.deepEqual(waits,[2000,4000,2000]);
});
