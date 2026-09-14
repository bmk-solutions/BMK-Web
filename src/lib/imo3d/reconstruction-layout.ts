import type { Plan, PlanRoom, Scene } from "./model";
import type { ReconstructionResult } from "./reconstruction";
import {apartmentWalls,validateRoom} from "./boundary-shapes.ts";

type LayoutScene = Pick<Scene, "id" | "floor" | "position">&Partial<Pick<Scene,"room"|"roomSemantic">>;
type LayoutResult = Pick<ReconstructionResult, "scenes" | "components">;

/** Authored frames and explicit floor review decisions survive automatic reconstruction. */
export function preserveAuthoredFloorState(currentScenes: readonly Scene[], currentPlans: readonly Plan[], proposedScenes: Scene[], proposedPlans: Plan[]) {
  const protectedFloors = new Set(currentPlans.filter(plan => plan.authoredRooms?.length || plan.architecture).map(plan => plan.floor));
  const rejectedFloors = new Set(currentPlans.filter(plan => plan.reviewStatus === "rejected").map(plan => plan.floor));
  const current = new Map(currentScenes.map(scene => [scene.id, scene]));
  const scenes = proposedScenes.map(proposed => {
    const saved = current.get(proposed.id);
    if (!saved || !protectedFloors.has(saved.floor)) return proposed;
    if (proposed.visualLinks === undefined) return saved;
    return { ...saved,...(saved.image === proposed.image && "displayDepth" in proposed ? {displayDepth:proposed.displayDepth} : {}),...(proposed.roomSemantic?{room:proposed.room,name:proposed.name,roomSemantic:proposed.roomSemantic}:{}), visualLinks: proposed.visualLinks.filter(link => saved.links.includes(link.targetId))
      .map(link => ({ ...link, yaw: ((link.yaw + saved.yaw - proposed.yaw) % 360 + 360) % 360 })) };
  });
  // Re-running the same estimator is not a review or acceptance of its geometry.
  const plans = [...proposedPlans.filter(plan => !protectedFloors.has(plan.floor)).map(plan => rejectedFloors.has(plan.floor) ? {...plan, reviewStatus: "rejected" as const} : plan),
    ...currentPlans.filter(plan => protectedFloors.has(plan.floor))].sort((a, b) => a.floor - b.floor);
  return { scenes, plans, protectedFloors };
}

/** Independent components have no shared scale or origin, even on the same floor. */
export function selectLargestConnectedComponents(scenes: readonly LayoutScene[], result: LayoutResult): Set<string> {
  const source = new Map(scenes.map(scene => [scene.id, scene]));
  const reconstructed = new Map(result.scenes.map(scene => [scene.id, scene]));
  const placed = new Set<string>();
  for (const floor of new Set(scenes.map(scene => scene.floor))) {
    const candidates = result.components.map(component => ({
      id: component.id,
      members: [...new Set(component.sceneIds)].filter(id => {
        const input = source.get(id), value = reconstructed.get(id);
        return input?.floor === floor && value?.floor === floor && value.position !== null
          && [value.position.x, value.position.y, value.position.z].every(Number.isFinite);
      }),
    })).filter(component => component.members.length >= 2)
      .sort((a, b) => b.members.length - a.members.length || a.id.localeCompare(b.id));
    for (const id of candidates[0]?.members ?? []) placed.add(id);
  }
  // Return a selection, never a filtered scene list: unplaced rooms remain usable
  // through direct panorama handover and may connect after a later image upload.
  return placed;
}

/** Builds the drawing in exactly the selected camera component's coordinate frame. */
export function buildEstimatedPlans(scenes: readonly LayoutScene[], result: LayoutResult): Plan[] {
  const selected = selectLargestConnectedComponents(scenes, result);
  return [...new Set(scenes.map(scene => scene.floor))].sort((a, b) => a - b).map(floor => {
    const posed = scenes.filter(scene => scene.floor === floor && selected.has(scene.id) && scene.position);
    const ids = new Set(posed.map(scene => scene.id));
    const components=result.components.filter(component=>component.sceneIds.some(id=>ids.has(id)));
    const surfaces = components
      .flatMap(component => component.surfaceCandidates ?? [])
      .filter(surface => [surface.a.x, surface.a.z, surface.b.x, surface.b.z, surface.confidence].every(Number.isFinite))
      .map(surface => ({ ...surface, a: { ...surface.a }, b: { ...surface.b } }));
    const candidates=components.filter(component=>component.scaleBasis==="camera_height").flatMap(component=>(component.rooms??[]).filter(room=>room.component===component.id&&room.frame==="component"&&room.scale==="camera_height"&&room.floor===floor&&room.sceneIds.length>0&&room.sceneIds.every(id=>ids.has(id))));
    const generatedRooms:PlanRoom[]=[],evidence:typeof candidates=[];
    const used=new Set<string>();
    for(const candidate of candidates){
      if(!Number.isFinite(candidate.confidence)||candidate.confidence<0||candidate.confidence>1||candidate.outline.length<3||candidate.outline.length>80||candidate.outline.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.z)||Math.abs(p.x)>10000||Math.abs(p.z)>10000))continue;
      const members=posed.filter(scene=>candidate.sceneIds.includes(scene.id));
      const counts=new Map<string,number>();for(const scene of members)if(scene.roomSemantic)counts.set(scene.roomSemantic.groupId,(counts.get(scene.roomSemantic.groupId)??0)+1);
      const groupId=[...counts].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))[0]?.[0];
      const representative=members.find(scene=>scene.roomSemantic?.groupId===groupId)??members.find(scene=>scene.id===candidate.representativeSceneId)??members[0];
      const id=groupId??candidate.id;if(used.has(id)||!/^room-[\w@-]{1,155}$/.test(id))continue;
      const kind=representative?.roomSemantic?.kind;
      const room:PlanRoom={id,name:representative?.room??`مساحة ${generatedRooms.length+1}`,outline:candidate.outline.map(p=>({...p})),finish:kind==="bathroom"||kind==="kitchen"?"tile":"stone",openings:[...(candidate.openings??[])],...(candidate.doorwayCandidates?.length?{doorwayCandidates:candidate.doorwayCandidates.map(door=>({...door}))}:{})};
      try{validateRoom(room);}catch{continue;}
      generatedRooms.push(room);evidence.push(candidate);used.add(id);
    }
    const boundaryPoints=generatedRooms.flatMap(room=>room.outline);
    const xs = [...posed.map(scene => scene.position!.x), ...boundaryPoints.map(p=>p.x), ...(!generatedRooms.length?surfaces.flatMap(surface => [surface.a.x, surface.b.x]):[])];
    const zs = [...posed.map(scene => scene.position!.z), ...boundaryPoints.map(p=>p.z), ...(!generatedRooms.length?surfaces.flatMap(surface => [surface.a.z, surface.b.z]):[])];
    return {
      floor, label: floor === 0 ? "الدور الأرضي" : `الدور ${floor}`,
      kind: posed.length ? "estimated" : "missing", walls: generatedRooms.length?apartmentWalls(generatedRooms):[], estimatedSurfaces: generatedRooms.length?[]:surfaces,
      ...(generatedRooms.length?{generatedRooms,generatedFrom:{method:"horizonnet-multiview-room-boundaries",confidence:evidence.reduce((sum,room)=>sum+room.confidence,0)/evidence.length,sceneIds:[...new Set(evidence.flatMap(room=>room.sceneIds))],scale:"camera_height" as const,ceilingHeight:evidence.map(room=>room.ceilingHeight).filter(value=>Number.isFinite(value)&&value>.2&&value<20).sort((a,b)=>a-b)[Math.floor(evidence.length/2)]}}:{}),
      bounds: {
        minX: (xs.length ? Math.min(...xs) : 0) - .5,
        maxX: (xs.length ? Math.max(...xs) : 1) + .5,
        minZ: (zs.length ? Math.min(...zs) : 0) - .5,
        maxZ: (zs.length ? Math.max(...zs) : 1) + .5,
      },
    };
  });
}
