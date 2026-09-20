type ProjectedPoint={x:number;y:number;inFront?:boolean};
/** Anchor a selectable label on the visible portion, even when endpoints leave the viewport. */
export function measurementLabelAnchor(a:ProjectedPoint,b:ProjectedPoint,width:number,height:number):{x:number;y:number}|null{
 if(!a.inFront||!b.inFront||width<=0||height<=0||![a.x,a.y,b.x,b.y,width,height].every(Number.isFinite))return null;
 const dx=b.x-a.x,dy=b.y-a.y;
 let start=0,end=1;
 for(const [p,q] of [[-dx,a.x],[dx,width-a.x],[-dy,a.y],[dy,height-a.y]]){
  if(p===0){if(q<0)return null;continue;}
  const t=q/p;
  if(p<0)start=Math.max(start,t);else end=Math.min(end,t);
  if(start>end)return null;
 }
 const t=(start+end)/2,marginX=Math.min(64,width/2),marginY=Math.min(28,height/2);
 return {x:Math.max(marginX,Math.min(width-marginX,a.x+dx*t)),y:Math.max(marginY,Math.min(height-marginY,a.y+dy*t))};
}

/** Separate overlapping values so every visible measurement can be selected. */
export function layoutMeasurementLabels<T extends {a:ProjectedPoint;b:ProjectedPoint}>(lines:T[],width:number,height:number){
 const placed:{x:number;y:number}[]=[];
 return lines.flatMap(line=>{
  const anchor=measurementLabelAnchor(line.a,line.b,width,height);if(!anchor)return [];
  let position=anchor;
  const marginX=Math.min(72,width/2),marginY=Math.min(28,height/2);
  const clamp=(x:number,y:number)=>({x:Math.max(marginX,Math.min(width-marginX,x)),y:Math.max(marginY,Math.min(height-marginY,y))});
  const free=(p:{x:number;y:number})=>placed.every(other=>Math.abs(other.x-p.x)>=144||Math.abs(other.y-p.y)>=46);
  if(!free(position)){
   search:for(let ring=1;ring<=12;ring++)for(const [dx,dy] of [[0,-ring*48],[0,ring*48],[-ring*148,0],[ring*148,0]]){
    const candidate=clamp(anchor.x+dx,anchor.y+dy);
    if(free(candidate)){position=candidate;break search;}
   }
  }
  placed.push(position);return [{line,anchor,position}];
 });
}
