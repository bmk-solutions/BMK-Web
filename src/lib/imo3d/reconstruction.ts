import { spawn } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import type {RoomProfile} from "./room-analysis";
import type {RoomObservation,RoomRelation} from "./room-semantics";
import type {RoomDoorwayCandidate} from "./model";

export type ReconstructionProgress = {
  event: "progress";
  stage: "features" | "matching" | "layout";
  completed: number;
  total: number;
  acceptedPairs?: number;
  sceneId?: string;
};
export type ReconstructionSceneInput = { id: string; path: string; floor: number };
export type ReconstructionScene = {
  id: string; floor: number; position: { x: number; y: number; z: number } | null;
  yaw: number; links: string[]; confidence: number; component: string;
  visualLinks?: {targetId:string;yaw:number}[];
  roomEnvelope?:{outline:{x:number;z:number}[];cameraHeight:1;ceilingAboveCamera:number;scale:"camera_height";classification:"estimated_room_envelope";confidence:number;evidence:Record<string,unknown>;warnings:string[]};
};
export type ReconstructedRoom={id:string;floor:number;component:string;frame:"component";scale:"camera_height";sceneIds:string[];representativeSceneId:string;outline:{x:number;z:number}[];ceilingHeight:number;ceilingAboveCamera:number;openings:number[];doorwayCandidates?:RoomDoorwayCandidate[];confidence:number;classification:"estimated_room_envelope";evidence:Record<string,unknown>};
export type ReconstructionPair = {
  a: string; b: string; matches: number; inliers: number; confidence: number;
  parallaxDegrees: number; residualDegrees: number; tiltDegrees: number;
  relativeYawDegrees: number; translationDirection: number[];
  kind: "visual_overlap"; walkability: "unverified";
};
export type ReconstructionResult = {
  version: 1;
  status: "ready" | "partial" | "insufficient_overlap";
  scale: "relative";
  scenes: ReconstructionScene[];
  pairs: ReconstructionPair[];
  components: {
    id: string; sceneIds: string[]; layout: "relative_reconstruction" | "topology_only";
    bearingErrorDegrees: number; sparsePoints: number[][];
    scaleBasis?:"camera_height"|"unscaled";floorAnchoredPairs?:number;
    rooms?:ReconstructedRoom[];
    surfaceCandidates: {
      a: { x: number; z: number }; b: { x: number; z: number }; confidence: number;
      supportPoints: number; kind: "vertical_surface"; classification: "unverified";
    }[];
  }[];
  warnings: string[];
  roomRelations?:RoomRelation[];
  roomObservations?:RoomObservation[];
  roomLayout?:{architectureDiagnostics?:{reason:string}[]};
  diagnostics: {
    imageCount: number; candidatePairs: number; geometricPairs: number; acceptedPairs: number;
    features: number[]; rejections: Record<string, number>; elapsedSeconds: number; method: string;
  };
};
type ReconstructionOptions = {
  scenes: ReconstructionSceneInput[];
  outputDir: string;
  /** Explicit private asset directories belonging to the current repository. */
  assetRoots?: string[];
  onProgress?: (progress: ReconstructionProgress) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  roomProfiles?:Record<string,RoomProfile>;
  roomObservations?:readonly RoomObservation[];
};

function isWithin(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function runtime() {
  let local: { python?: string; cvPath?: string } = {};
  try {
    local = JSON.parse(await readFile(path.join(process.cwd(), "work/reconstruction-runtime.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const python = process.env.IMO3D_PYTHON || local.python;
  if (!python) throw new Error("محرك تحليل الصور غير مهيأ. اضبط IMO3D_PYTHON وثبّت متطلبات عامل المعالجة.");
  return { python, cvPath: process.env.IMO3D_CV_PATH || local.cvPath || path.join(process.cwd(), "work/reconstruction-python") };
}

/** Runs in a dedicated worker process; the web request should enqueue this job. */
export async function runPanoramaReconstruction(options: ReconstructionOptions): Promise<ReconstructionResult> {
  if (options.scenes.length < 2 || options.scenes.length > 300) throw new Error("تحتاج المعالجة إلى صورتين على الأقل وبحد أقصى 300 صورة.");
  if (new Set(options.scenes.map(scene => scene.id)).size !== options.scenes.length) throw new Error("معرّفات اللقطات مكررة.");
  const { python, cvPath } = await runtime();
  const roots = await Promise.all((options.assetRoots ?? [
    path.join(process.cwd(), "public/imo3d/example"),
    process.env.IMO3D_DATA_DIR || path.join(process.cwd(), ".imo3d-data"),
  ]).map(async root => realpath(root)));
  const scenes = await Promise.all(options.scenes.map(async scene => {
    if (!/^[\w-]{1,80}$/.test(scene.id) || !Number.isInteger(scene.floor) || scene.floor < -10 || scene.floor > 200) throw new Error("بيانات لقطة غير صالحة.");
    const file = await realpath(scene.path);
    if (!roots.some(root => isWithin(root, file))) throw new Error("ملف المعالجة خارج مجلد الصور المعتمد.");
    return { id: scene.id, path: file, floor: scene.floor };
  }));
  if (options.signal?.aborted) throw new DOMException("Reconstruction cancelled", "AbortError");
  await mkdir(options.outputDir, { recursive: true });
  const input = path.join(options.outputDir, "input.json");
  const output = path.join(options.outputDir, "result.json");
  await writeFile(input, JSON.stringify({ scenes, outputDir: options.outputDir,featureCacheDir:path.join(process.cwd(),"work/reconstruction-feature-cache"),roomProfiles:options.roomProfiles,roomObservations:options.roomObservations }), "utf8");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(python, [path.join(process.cwd(), "scripts/imo3d-reconstruction.py"), "--input", input, "--output", output], {
      cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, IMO3D_CV_PATH: cvPath, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", OPENBLAS_NUM_THREADS: "2", OMP_NUM_THREADS: "2" },
    });
    let buffer = "", stderr = "", failure: Error | null = null, settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve();
    };
    const abort = () => {
      failure = new DOMException("Reconstruction cancelled", "AbortError");
      child.kill();
    };
    const timeout = setTimeout(() => {
      failure = new Error("انتهت مهلة المعالجة. جرّب مجموعة صور أصغر أو عامل معالجة أقوى.");
      child.kill();
    }, options.timeoutMs ?? 30 * 60_000);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 256_000) { failure = new Error("Invalid reconstruction worker output"); child.kill(); return; }
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line);
          if (event.event === "progress" && ["features", "matching", "layout"].includes(event.stage)
            && Number.isFinite(event.completed) && Number.isFinite(event.total)) options.onProgress?.(event);
          else if (event.event === "error") failure = new Error(String(event.message).slice(0, 1000));
        } catch { /* Worker logging is not allowed to crash the supervising queue. */ }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
    child.once("error", error => finish(error));
    child.once("close", code => finish(failure ?? (code === 0 ? undefined : new Error(stderr.includes("ModuleNotFoundError")
      ? "متطلبات محرك الصور غير مكتملة. ثبّت scripts/imo3d-reconstruction-requirements.txt في بيئة العامل."
      : "تعذرت معالجة الصور. راجع سجل عامل المعالجة وحاول مجددًا."))));
  });
  const result = JSON.parse(await readFile(output, "utf8")) as ReconstructionResult;
  if (result.version !== 1 || result.scale !== "relative" || !Array.isArray(result.scenes)
    || result.scenes.length !== scenes.length || result.scenes.some(scene => !scenes.some(input => input.id === scene.id))) {
    throw new Error("نتيجة محرك إعادة البناء غير صالحة.");
  }
  return result;
}
