import type {Scene,Tour} from './model';

/** Keep the bottom of the entire viewport above the tripod, including zoom-out. */
export function constrainedView(pitch:number,fov:number){
 const zoom=Number.isFinite(fov)?Math.max(40,Math.min(95,fov)):74;
 const minPitch=(-65+zoom/2)*Math.PI/180;
 return {fov:zoom,pitch:Math.max(minPitch,Math.min(80*Math.PI/180,Number.isFinite(pitch)?pitch:0))};
}
export function sceneEntryView(scene:Scene){
 if(!scene.entryView)return undefined;
 return {yaw:(scene.yaw+scene.entryView.yaw)*Math.PI/180,...constrainedView(scene.entryView.pitch*Math.PI/180,scene.entryView.fov)};
}
/** The angle is local to this panorama, so re-estimating camera yaw keeps the chosen view. */
export function applyEntryView(tour:Tour,input:{sceneId:string;view:NonNullable<Scene['entryView']>|null}):Scene[]{
 const target=tour.scenes.find(scene=>scene.id===input.sceneId);
 if(!target)throw Error('اللقطة غير موجودة في هذه الجولة.');
 const sameRoom=(scene:Scene)=>scene.floor===target.floor&&(target.roomSemantic?scene.roomSemantic?.groupId===target.roomSemantic.groupId:target.room&&target.room!=='لقطات تحتاج تسمية'?!scene.roomSemantic&&scene.room===target.room:scene.id===target.id);
 return tour.scenes.map(scene=>scene.id===target.id?{...scene,entryView:input.view??undefined}:input.view&&sameRoom(scene)&&scene.entryView?{...scene,entryView:undefined}:scene);
}
