import { z } from "zod";

export const pointSchema = z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() });
export type Point = z.infer<typeof pointSchema>;
export const depthSchema = z.object({
  width: z.number().int().min(8).max(2048), height: z.number().int().min(4).max(1024),
  values: z.array(z.number().finite().min(0).max(1000)).max(2097152),
}).refine(d => d.values.length === d.width * d.height, "عدد قيم العمق لا يطابق الأبعاد");
export type Depth = z.infer<typeof depthSchema>;
/** Image-derived relative depth is for rendering only, never measurement or walls. */
export const displayDepthSchema = z.object({
  width: z.number().int().min(8).max(256), height: z.number().int().min(4).max(128),
  values: z.array(z.number().finite().min(0).max(20)).max(32768),
  confidence: z.number().finite().min(0).max(1), coverage: z.number().finite().min(0).max(1),
  source: z.enum(["monocular-multiview-floor-aligned","da3-base-pose-conditioned-multiview"]), units: z.literal("camera_height"), purpose: z.literal("display_only"),
}).refine(d => d.width === d.height * 2 && d.values.length === d.width * d.height
  && Math.abs(d.values.filter(value => value > 0).length / d.values.length - d.coverage) < 1 / d.values.length,
"بيانات عمق العرض لا تطابق الأبعاد والتغطية");
export type DisplayDepth = z.infer<typeof displayDepthSchema>;
const localAsset = z.string().max(512).refine(s => /^\/(?:imo3d\/example\/|api\/imo3d\/assets\/)[a-zA-Z0-9/_.-]+$/.test(s) && !s.includes(".."), "مسار صورة غير صالح");
export const roomKindSchema=z.enum(["bedroom","bathroom","kitchen","living","guest","dining","corridor","entrance","balcony","storage","unknown"]);
export type RoomKind=z.infer<typeof roomKindSchema>;
export const bathroomFixtureSchema=z.enum(["toilet","shower","bathtub","washbasin"]);
export const suggestedEnsuiteSchema=z.object({
  status:z.enum(["suggested","confirmed"]),confidence:z.number().finite().min(0).max(1),privacyConfidence:z.number().finite().min(0).max(1),
  doorwayVerified:z.boolean(),direct:z.boolean(),privateToFrom:z.boolean(),
  evidenceIds:z.array(z.string().min(1).max(160)).min(1).max(100),visibleFixtures:z.array(bathroomFixtureSchema).min(1).max(4),
  sceneIds:z.array(z.string().min(1).max(80)).min(1).max(100),
});
export const roomSemanticSchema=z.object({
  groupId:z.string().min(1).max(160),kind:roomKindSchema,confidence:z.number().finite().min(0).max(1),
  observedKind:roomKindSchema.optional(),observedConfidence:z.number().finite().min(0).max(1).optional(),
  nameSource:z.enum(["user","automatic","legacy"]),suggestedName:z.string().min(1).max(100),
  needsReview:z.boolean(),reviewFlags:z.array(z.string().max(80)).max(20),evidenceIds:z.array(z.string().min(1).max(160)).max(1000),
  ensuiteBathroomGroupIds:z.array(z.string().min(1).max(160)).max(100).optional(),
  suggestedEnsuite:suggestedEnsuiteSchema.optional(),
});
export type RoomSemantic=z.infer<typeof roomSemanticSchema>;
export const sceneSchema = z.object({
  presentation:z.object({image:localAsset,preview:localAsset,thumbnail:localAsset,width:z.number().int().positive(),height:z.number().int().positive()}).optional(),
  id: z.string().regex(/^[\w-]+$/).max(80), name: z.string().trim().min(1).max(100),
  room: z.string().trim().min(1).max(100), floor: z.number().int().min(-10).max(200),
  roomSemantic:roomSemanticSchema.optional(),
  image: localAsset, preview: localAsset, thumbnail: localAsset,
  detail: z.object({ image: localAsset, width: z.number().int().min(1).max(8192), height: z.number().int().min(1).max(8192) }).optional(),
  sourceName: z.string().max(200), position: pointSchema.nullable(), yaw: z.number().finite(),
  entryView:z.object({yaw:z.number().finite().min(-180).max(180),pitch:z.number().finite().min(-65).max(80),fov:z.number().finite().min(40).max(95)}).optional(),
  depth: depthSchema.optional(), displayDepth: displayDepthSchema.optional(), links: z.array(z.string().max(80)).max(200),
  manualLinks: z.array(z.object({ targetId: z.string().regex(/^[\w-]+$/).max(80), yaw: z.number().finite() })).max(200).refine(values => new Set(values.map(value => value.targetId)).size === values.length, "الروابط اليدوية مكررة").optional(),
  visualLinks: z.array(z.object({ targetId: z.string().regex(/^[\w-]+$/).max(80), yaw: z.number().finite() })).max(200).refine(values => new Set(values.map(value => value.targetId)).size === values.length, "الروابط البصرية مكررة").optional(),
  blockedLinks: z.array(z.string().regex(/^[\w-]+$/).max(80)).max(500).refine(values => new Set(values).size === values.length, "الروابط المحجوبة مكررة").optional(),
});
export type Scene = z.infer<typeof sceneSchema>;
export type Wall = { a: { x: number; z: number }; b: { x: number; z: number } };
export type RoomDoorwayCandidate={edge:number;offset:number;width:number;confidence:number;verified:false;pairedRoomId:string};
export type PlanRoom = {id:string;name:string;outline:{x:number;z:number}[];finish:"wood"|"tile"|"stone";openings:number[];doorwayCandidates?:RoomDoorwayCandidate[]};
export type SurfaceModel = {
  url:string;pointCount:number;floorHeight:number;source:"da3-base-pose-conditioned-multiview";units:"camera_height";
  cameras:{id:string;image:string;position:Point;yaw:number}[];
};
export type TexturedMesh = {
  url:string;byteLength:number;triangleCount:number;floorHeight:number;ceilingHeight:number;
  source:"local-room-depth-texture-v1";units:"camera_height";geometrySignature:string;
  cameras:{id:string;image:string;position:Point;yaw:number}[];
};
export type Plan = {
  architecture?: import("./architecture").Architecture;
  architectureReview?: "draft" | "reviewed";
  reviewStatus?:"rejected";
  floor: number; label: string; kind: "geometry" | "depth" | "path" | "estimated" | "missing";
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number };
  walls: Wall[]; image?: string; width?: number; height?: number;
  estimatedSurfaces?: (Wall & {confidence:number;supportPoints:number;kind:"vertical_surface";classification:"unverified"})[];
  scenePoints?: Record<string, { x: number; y: number }>;
  rotation?: number;
  authoredRooms?:PlanRoom[];
  authoredScale?:"metric"|"relative";
  generatedRooms?:PlanRoom[];
  generatedFrom?:{method:string;confidence:number;sceneIds:string[];scale:"camera_height";ceilingHeight?:number};
  surfaceModel?:SurfaceModel;
  texturedMesh?:TexturedMesh;
};
export type Tour = {
  photoEdits?:import("./photo-edits").PhotoEdit[];
  hotspots?:import("./hotspots").Hotspot[];
  id: string; title: string; projectId: string; published: boolean; revision: number;
  scenes: Scene[]; plans: Plan[]; updatedAt: string; createdAt: string;
  initialView?: { yaw: number; pitch: number };
  spatialSource?: "calibrated"|"images";
  spatialScale?: "metric"|"relative";
  /** Operator-recorded lens height, scoped to the captures present when saved.
   * Sets relative-depth scale only; does not certify inferred geometry. */
  measurementScale?: {heightMeters:number;source:"operator_measured";sceneIds:string[]};
  branding?: {name:string;logo?:string;accent:string;logoStyle?:"clean"|"original"};
  unit: { code: string; area: number | null; price: number | null; bedrooms: number | null; bathrooms: number | null };
  quality: { positioned: number; depthScenes: number; components: number; warnings: string[] };
};
export type Developer = {id:string;name:string;createdAt:string};
export type Project = { developerId?: string | null; id: string; name: string; location: string; createdAt: string };
export type Lead = { id: string; tourId: string; name: string; phone: string; note: string; createdAt: string };
export const unitSchema = z.object({
  code: z.string().max(80), area: z.number().positive().max(100000).nullable(),
  price: z.number().nonnegative().max(1e12).nullable(), bedrooms: z.number().int().min(0).max(100).nullable(),
  bathrooms: z.number().int().min(0).max(100).nullable(),
});
export const cameraBundleSchema = z.object({
  version: z.literal(1), units: z.literal("meters"),
  cameras: z.array(z.object({
    file: z.string().min(1).max(200), position: pointSchema, yaw: z.number().finite().default(0),
    floor: z.number().int().min(-10).max(200).default(0), room: z.string().max(100).optional(),
    depth: depthSchema.optional(),
  })).min(1).max(500),
});

export function roomFromFilename(name: string) {
  const normalized = name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ");
  const names: [RegExp, string][] = [
    [/kitchen|مطبخ/i, "المطبخ"], [/master|رئيسية/i, "غرفة النوم الرئيسية"],
    [/bedroom|bed room|نوم/i, "غرفة النوم"], [/living|lounge|معيشة|صالة/i, "غرفة المعيشة"],
    [/dining|طعام/i, "غرفة الطعام"], [/bath|wc|حمام/i, "دورة المياه"],
    [/entrance|entry|مدخل/i, "المدخل"], [/corridor|hallway|ممر/i, "الممر"],
    [/balcony|terrace|شرفة/i, "الشرفة"], [/majlis|مجلس/i, "المجلس"],
  ];
  return names.find(([pattern]) => pattern.test(normalized))?.[1] ?? "لقطات تحتاج تسمية";
}
