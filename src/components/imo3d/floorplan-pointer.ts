type PointerSample={pointerId:number;clientX:number;clientY:number;button:number};

/** A selection must be one stationary pointer, even when move events are lost. */
export class FloorPlanPointerGesture{
  private active=new Set<number>();
  private candidate:{id:number;x:number;y:number;dragged:boolean}|null=null;
  down(event:PointerSample){
    if(event.button!==0)return;
    this.active.add(event.pointerId);
    this.candidate=this.active.size===1?{id:event.pointerId,x:event.clientX,y:event.clientY,dragged:false}:null;
  }
  move(event:PointerSample){const down=this.candidate;if(down&&event.pointerId===down.id&&Math.hypot(event.clientX-down.x,event.clientY-down.y)>5)down.dragged=true;}
  up(event:PointerSample){
    const down=this.candidate;this.active.delete(event.pointerId);this.candidate=null;
    return this.active.size===0&&event.button===0&&!!down&&down.id===event.pointerId&&!down.dragged&&Math.hypot(event.clientX-down.x,event.clientY-down.y)<=5;
  }
  cancel(){this.active.clear();this.candidate=null;}
}
