/** Retry a stopped worker with bounded backoff. Do not retry after shutdown. */
export async function superviseWorker({run,wait,signal,onStatus=()=>{},now=Date.now}){
  let failures=0;
  while(!signal.aborted){
    const started=now();
    try{await run(signal);}catch{if(signal.aborted)break;}
    if(signal.aborted)break;
    failures=now()-started>=60000?1:failures+1;
    const retryMs=Math.min(60000,2000*2**Math.min(failures-1,5));
    onStatus({status:'restarting',retryMs});
    try{await wait(retryMs,signal);}catch(error){if(!signal.aborted)throw error;}
  }
}
