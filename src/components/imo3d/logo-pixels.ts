export type LogoCrop={x:number;y:number;width:number;height:number;removedBackground:boolean;monochrome:boolean;hasTransparentBorder:boolean};
/** Remove only near-white pixels connected to the outside, leaving white holes/details intact. */
export function prepareLogoPixels(rgba:Uint8ClampedArray,width:number,height:number,clean=true):LogoCrop{
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width*height>1_048_576||rgba.length!==width*height*4)throw Error("Invalid logo raster");
  let removedBackground=false;
  const opaqueBorder=Array.from({length:width},(_,x)=>[x,(height-1)*width+x]).flat().concat(Array.from({length:height},(_,y)=>[y*width,y*width+width-1]).flat()).every(p=>rgba[p*4+3]>250);
  if(clean&&opaqueBorder){
    const seen=new Uint8Array(width*height),queue=new Int32Array(width*height);let head=0,tail=0;
    const candidate=(p:number)=>{const i=p*4;return rgba[i+3]<12||Math.min(rgba[i],rgba[i+1],rgba[i+2])>=235&&Math.max(rgba[i],rgba[i+1],rgba[i+2])-Math.min(rgba[i],rgba[i+1],rgba[i+2])<18;};
    const push=(p:number)=>{if(!seen[p]&&candidate(p)){seen[p]=1;queue[tail++]=p;}};
    for(let x=0;x<width;x++){push(x);push((height-1)*width+x);}for(let y=0;y<height;y++){push(y*width);push(y*width+width-1);}
    while(head<tail){const p=queue[head++],x=p%width,y=Math.floor(p/width);if(x)push(p-1);if(x+1<width)push(p+1);if(y)push(p-width);if(y+1<height)push(p+width);}
    // Commit the display-only mask only if a foreground survives. An all-white
    // mark must remain visible instead of being mistaken entirely for background.
    let hasForeground=false;
    for(let p=0;p<width*height&&!hasForeground;p++)hasForeground=!seen[p]&&rgba[p*4+3]>=24;
    if(hasForeground)for(let n=0;n<tail;n++){const i=queue[n]*4+3;if(rgba[i]>0)removedBackground=true;rgba[i]=0;}
  }
  let minX=width,maxX=-1,minY=height,maxY=-1,colored=0,visible=0;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=(y*width+x)*4;if(rgba[i+3]<24)continue;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);visible++;if(Math.max(rgba[i],rgba[i+1],rgba[i+2])-Math.min(rgba[i],rgba[i+1],rgba[i+2])>8)colored++;}
  let hasTransparentBorder=false;
  for(let x=0;x<width&&!hasTransparentBorder;x++)hasTransparentBorder=rgba[x*4+3]<24||rgba[((height-1)*width+x)*4+3]<24;
  for(let y=0;y<height&&!hasTransparentBorder;y++)hasTransparentBorder=rgba[y*width*4+3]<24||rgba[(y*width+width-1)*4+3]<24;
  if(maxX<minX)return{x:0,y:0,width,height,removedBackground:false,monochrome:false,hasTransparentBorder};
  const padding=Math.max(1,Math.ceil(Math.max(maxX-minX,maxY-minY)*.025));minX=Math.max(0,minX-padding);minY=Math.max(0,minY-padding);maxX=Math.min(width-1,maxX+padding);maxY=Math.min(height-1,maxY+padding);
  // Even a small or muted colored accent belongs to the brand. Only neutral
  // artwork may use the optional white presentation on the dark viewer header.
  return{x:minX,y:minY,width:maxX-minX+1,height:maxY-minY+1,removedBackground,monochrome:visible>0&&colored===0,hasTransparentBorder};
}
