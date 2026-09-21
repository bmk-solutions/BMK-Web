// Perspective patch in/out of an equirectangular panorama. Angles are local to
// the source image, so edits never alter its compass, dimensions or camera pose.
type Raster={data:Uint8Array;width:number;height:number};
type Region={yaw:number;pitch:number;fov:number};
function basis(r:Region){const y=r.yaw*Math.PI/180,p=r.pitch*Math.PI/180;return{forward:[Math.sin(y)*Math.cos(p),Math.sin(p),-Math.cos(y)*Math.cos(p)],right:[Math.cos(y),0,Math.sin(y)],up:[-Math.sin(y)*Math.sin(p),Math.cos(p),Math.cos(y)*Math.sin(p)],t:Math.tan(r.fov*Math.PI/360)};}
function sample(im:Raster,x:number,y:number,c:number,wrap=false){x=wrap?((x%im.width)+im.width)%im.width:Math.max(0,Math.min(im.width-1,x));y=Math.max(0,Math.min(im.height-1,y));const x0=Math.floor(x),y0=Math.floor(y),x1=wrap?(x0+1)%im.width:Math.min(im.width-1,x0+1),y1=Math.min(im.height-1,y0+1),a=x-x0,b=y-y0;return(1-b)*((1-a)*im.data[(y0*im.width+x0)*3+c]+a*im.data[(y0*im.width+x1)*3+c])+b*((1-a)*im.data[(y1*im.width+x0)*3+c]+a*im.data[(y1*im.width+x1)*3+c]);}
export function extractPhotoPatch(im:Raster,r:Region,size=1024):Raster{
 const b=basis(r),data=new Uint8Array(size*size*3);
 for(let y=0;y<size;y++)for(let x=0;x<size;x++){const u=(2*(x+.5)/size-1)*b.t,v=(1-2*(y+.5)/size)*b.t,d=b.forward.map((f,i)=>f+u*b.right[i]+v*b.up[i]),len=Math.hypot(...d),px=(.5+Math.atan2(d[0],-d[2])/(2*Math.PI))*im.width-.5,py=(.5-Math.asin(d[1]/len)/Math.PI)*im.height-.5;for(let c=0;c<3;c++)data[(y*size+x)*3+c]=Math.round(sample(im,px,py,c,true));}
 return{data,width:size,height:size};
}
export function compositePhotoPatch(im:Raster,patch:Raster,r:Region):Raster{
 const b=basis(r),data=new Uint8Array(im.data);
 for(let y=0;y<im.height;y++){const pitch=(.5-(y+.5)/im.height)*Math.PI,cp=Math.cos(pitch),sp=Math.sin(pitch);for(let x=0;x<im.width;x++){
  const yaw=((x+.5)/im.width-.5)*2*Math.PI,d=[Math.sin(yaw)*cp,sp,-Math.cos(yaw)*cp],dot=(v:number[])=>d.reduce((sum,n,i)=>sum+n*v[i],0),depth=dot(b.forward);if(depth<=0)continue;
  const u=dot(b.right)/(depth*b.t),v=dot(b.up)/(depth*b.t),radius=Math.hypot(u,v);if(radius>=.9)continue;
  const alpha=Math.min(1,(.9-radius)/.12),px=(u+1)*patch.width/2-.5,py=(1-v)*patch.height/2-.5;
  for(let c=0;c<3;c++){const index=(y*im.width+x)*3+c;data[index]=Math.round(data[index]*(1-alpha)+sample(patch,px,py,c)*alpha);}
 }}return{...im,data};
}
