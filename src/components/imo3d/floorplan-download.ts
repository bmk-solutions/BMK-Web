/** Local rasterization of the self-contained architectural SVG, never of the viewer canvas. */
export async function floorPlanSvgToPng(svg:string,signal?:AbortSignal):Promise<Blob>{
  const image=new Image(),url=URL.createObjectURL(new Blob([svg],{type:"image/svg+xml;charset=utf-8"}));
  let canvas:HTMLCanvasElement|undefined;
  try{
    await new Promise<void>((resolve,reject)=>{
      let settled=false;
      const finish=(error?:Error)=>{if(settled)return;settled=true;window.clearTimeout(timer);signal?.removeEventListener("abort",abort);image.onload=null;image.onerror=null;if(error)reject(error);else resolve();};
      const abort=()=>finish(new DOMException("أُلغي تجهيز المخطط.","AbortError"));
      const timer=window.setTimeout(()=>finish(new Error("استغرق تجهيز الصورة وقتًا أطول من المتوقع. جرّب تنزيل SVG.")),15000);
      image.onload=()=>finish();image.onerror=()=>finish(new Error("تعذر تحويل المخطط إلى صورة. يمكنك تنزيل SVG."));
      signal?.addEventListener("abort",abort,{once:true});
      if(signal?.aborted)abort();else image.src=url;
    });
    if(signal?.aborted)throw new DOMException("أُلغي تجهيز المخطط.","AbortError");
    const width=image.naturalWidth,height=image.naturalHeight;
    if(!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0)throw new Error("أبعاد المخطط غير صالحة للتنزيل.");
    // A bounded 2× drawing stays crisp without allocating a huge mobile canvas.
    const scale=Math.min(2,4096/Math.max(width,height),Math.sqrt(12_000_000/(width*height)));
    canvas=document.createElement("canvas");canvas.width=Math.max(1,Math.round(width*scale));canvas.height=Math.max(1,Math.round(height*scale));
    const context=canvas.getContext("2d");if(!context)throw new Error("هذا المتصفح لا يستطيع تجهيز PNG. استخدم SVG.");
    context.fillStyle="#ffffff";context.fillRect(0,0,canvas.width,canvas.height);context.drawImage(image,0,0,canvas.width,canvas.height);
    return await new Promise<Blob>((resolve,reject)=>canvas!.toBlob(blob=>{
      if(signal?.aborted)reject(new DOMException("أُلغي تجهيز المخطط.","AbortError"));
      else if(blob)resolve(blob);else reject(new Error("تعذر تجهيز ملف PNG. يمكنك تنزيل SVG."));
    },"image/png"));
  }finally{
    image.src="";URL.revokeObjectURL(url);
    if(canvas){canvas.width=0;canvas.height=0;}
  }
}

export function saveFloorPlanBlob(blob:Blob,filename:string){
  const url=URL.createObjectURL(blob),anchor=document.createElement("a");
  try{anchor.href=url;anchor.download=filename;anchor.hidden=true;document.body.append(anchor);anchor.click();}
  finally{anchor.remove();window.setTimeout(()=>URL.revokeObjectURL(url),1000);}
}
