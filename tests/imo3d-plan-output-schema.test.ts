import assert from 'node:assert/strict';
import {test} from 'node:test';
import {z} from 'zod';
import {floorplanLayoutSchema,floorplanLayoutOutputSchema} from '../src/lib/imo3d/openai-floorplan-pipeline';
import {subscriptionAnalysisSchema,subscriptionReviewSchema,subscriptionReviewOutputSchema,layoutRepairSchema} from '../src/lib/imo3d/subscription-plan-worker';

type JsonObject={properties?:Record<string,JsonObject>;items?:JsonObject;required?:string[];enum?:string[]};
function openingSchema(schema:z.ZodType,nested=false){
 const json=z.toJSONSchema(schema) as JsonObject;
 const layout=nested?json.properties!.floors.items!.properties!.layout:json;
 return layout.properties!.openings.items!;
}
const layout={rooms:[{id:'r',label:'Room',evidenceSceneIds:['a'],polygon:[{x:.1,y:.1},{x:.9,y:.1},{x:.9,y:.9},{x:.1,y:.9}],uncertainty:'Estimated'}],openings:[{id:'d',roomId:'r',otherRoomId:null,kind:'door',edgeIndex:0,offset:.2,width:.2,evidenceSceneIds:['a'],uncertainty:'Unseen destination'}],uncertainties:['Not surveyed']};
const base={floor:0,geometryBasis:'image-supported',geometryExplanation:'Observed relative arrangement, not surveyed',layout,audit:{verdict:'consistent',reviewedSceneIds:['a'],issues:[],limitations:['Not surveyed']}};

test('every fresh layout and recovery model schema requires explicit leaf state',()=>{
 for(const [schema,nested] of [[floorplanLayoutOutputSchema,false],[layoutRepairSchema,true],[subscriptionReviewOutputSchema,true]] as const){
  const opening=openingSchema(schema,nested);
  assert.ok(opening.required?.includes('leafState'));
  assert.deepEqual(opening.properties!.leafState.enum,['open','closed','unknown']);
  assert.deepEqual([...opening.required!].sort(),Object.keys(opening.properties!).sort(),'strict provider objects require all properties');
 }
});

test('stored analyses and reviews retain legacy absent leaf observations',()=>{
 assert.equal(floorplanLayoutSchema.parse(layout).openings[0].leafState,undefined);
 const evidence=[{sceneId:'a',roomCategory:'other',visibleEvidence:['Door'],openings:[],distinctiveFeatures:[],uncertainties:[]}];
 assert.equal(subscriptionAnalysisSchema.parse({floors:[{...base,evidence}]}).floors[0].layout.openings[0].leafState,undefined);
 assert.equal(subscriptionReviewSchema.parse({floors:[{...base,evidenceCorrections:[]}]}).floors[0].layout.openings[0].leafState,undefined);
 assert.throws(()=>floorplanLayoutOutputSchema.parse(layout));
 assert.throws(()=>layoutRepairSchema.parse({floors:[base]}));
 assert.throws(()=>subscriptionReviewOutputSchema.parse({floors:[{...base,evidenceCorrections:[]}]}));
});

test('fresh outputs explicitly distinguish unknown destinations from observed open leaves',()=>{
 const fresh={...base,layout:{...layout,openings:layout.openings.map(o=>({...o,leafState:'open'}))}};
 const synthesized=layoutRepairSchema.parse({floors:[fresh]});
 const recovered=subscriptionReviewOutputSchema.parse({floors:[{...fresh,evidenceCorrections:[]}]});
 for(const result of [synthesized,recovered]){
  assert.equal(result.floors[0].layout.openings[0].otherRoomId,null);
  assert.equal(result.floors[0].layout.openings[0].leafState,'open');
 }
});
