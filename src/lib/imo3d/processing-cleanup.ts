import { lstat, readdir, realpath, rmdir, unlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { DatabaseSync } from "node:sqlite";

// Node 24 resolves this built-in at runtime. Resolving private job paths must
// not make their contents into assets through static node:path tracing.
const path: typeof import("node:path") = process.getBuiltinModule("node:path");

const jobIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const featurePattern = /^[0-9a-f]{64}\.npz$/;
const analysisCachePattern = /^[0-9a-f]{64}\.json$/;
const jointCachePattern = /^[0-9a-f]{64}\.(?:json|tmp)$/;
const jointGeometryPattern = /^(?:[0-9a-f]{64}-pitch-(?:neg30|pos30)\.npz(?:\.tmp)?|manifest\.json(?:\.tmp)?)$/;
const knownFiles = new Set(["input.json", "result.json", "result.tmp"]);
const roomAnalysisFiles = new Set(["room-analysis-input.json", "room-profiles.json", "room-vision.json", "photo-depth-input.json", "photo-depth.json"]);
const jointDepthFiles = new Set(["joint-depth-input.json", "joint-depth.json", "joint-depth.json.tmp"]);
const depthArchitectureFiles = new Set(["depth-architecture-input.json", "depth-architecture.json"]);
const texturedMeshFiles = new Set(["mesh-input.json", "mesh.glb", "mesh-metadata.json", "mesh.glb.tmp", "mesh-metadata.json.tmp"]);
type ArtifactGroup = "features" | "room-analysis" | "analysis-cache" | "boundaries" | "photo-depth" | "joint-attempt" | "joint-depth" | "joint-geometry" | "depth-architecture" | "textured-mesh";
const roomAnalysisDirectory = (name: string) => name.startsWith("room-analysis-") && jobIdPattern.test(name.slice("room-analysis-".length));
const jointDepthDirectory = (name: string) => name.startsWith("joint-depth-") && jobIdPattern.test(name.slice("joint-depth-".length));
const depthArchitectureDirectory = (name: string) => name.startsWith("depth-architecture-") && jobIdPattern.test(name.slice("depth-architecture-".length));
const texturedMeshDirectory = (name: string) => name.startsWith("textured-mesh-") && jobIdPattern.test(name.slice("textured-mesh-".length));
type CleanupResult = {
  removed: string[];
  missing: string[];
  skipped: string[];
  failed: { jobId: string; code: string }[];
};
const codeOf = (error: unknown) => String((error as NodeJS.ErrnoException)?.code ?? "CLEANUP_FAILED");
function samePath(first: string, second: string) { return path.relative(first, second) === ""; }
function within(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Fresh reference checks after a worker exits; cancellation alone is not deletion. */
export function unreferencedInputAssetFiles(database: DatabaseSync, dataDirectory: string, inputPaths: readonly string[]): string[] {
  const assetRoot = path.resolve(dataDirectory, "assets");
  const files = [...new Set(inputPaths.filter(file => samePath(path.dirname(path.resolve(file)), assetRoot))
    .map(file => path.basename(file)).filter(file => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/.test(file) && !file.includes("..")))];
  if (!files.length) return [];
  // Case-insensitive checks also protect two DB spellings of one Windows file.
  const referenced = database.prepare("SELECT 1 FROM assets WHERE file=? COLLATE NOCASE UNION ALL SELECT 1 FROM scene_originals WHERE file=? COLLATE NOCASE LIMIT 1");
  return files.filter(file => !referenced.get(file, file));
}

/** Reject junctions/symlinks before resolving or enumerating a directory. */
async function checkedDirectory(directory: string, expected: string, boundary: string): Promise<string | null> {
  const stat = await lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
  const resolved = await realpath(directory);
  return samePath(resolved, expected) && within(boundary, resolved) ? resolved : null;
}

/**
 * Remove only known reconstruction artifacts belonging to explicit deleted job
 * IDs. No recursive rm, no directory discovery across jobs, and no link targets.
 * Active workers retry this cleanup after their child exits when the job row has
 * been deleted; this handles locked files and paths recreated during cancellation.
 */
async function cleanupPass(dataDirectory: string, jobIds: readonly string[]): Promise<CleanupResult> {
  const result: CleanupResult = { removed: [], missing: [], skipped: [], failed: [] };
  const ids = [...new Set(jobIds)];
  const valid = ids.filter(id => jobIdPattern.test(id));
  result.skipped.push(...ids.filter(id => !jobIdPattern.test(id)));
  if (!valid.length) return result;
  let data: string, processing: string;
  try {
    const configured = path.resolve(dataDirectory), dataStat = await lstat(configured);
    if (dataStat.isSymbolicLink() || !dataStat.isDirectory()) { result.skipped.push(...valid); return result; }
    data = await realpath(configured);
    const expected = path.join(data, "processing");
    const checked = await checkedDirectory(expected, expected, data);
    if (!checked) { result.skipped.push(...valid); return result; }
    processing = checked;
  } catch (error) {
    if (codeOf(error) === "ENOENT") result.missing.push(...valid);
    else result.failed.push(...valid.map(jobId => ({ jobId, code: codeOf(error) })));
    return result;
  }
  for (const id of valid) {
    const directory = path.join(processing, id);
    let skipped = false;
    try {
      // Check the processing parent again for every job and immediately before
      // each file operation, since a running worker may recreate its job folder.
      const checkRoot = async () => Boolean(await checkedDirectory(processing, path.join(data, "processing"), data)
        && await checkedDirectory(directory, path.join(processing, id), processing));
      if (!await checkRoot()) { result.skipped.push(id); continue; }
      const removeFile = async (file: string, parent: string) => {
        try {
          if (!await checkRoot() || !await checkedDirectory(parent, parent, processing)) { skipped = true; return; }
          const stat = await lstat(file);
          if (stat.isSymbolicLink() || !stat.isFile()) { skipped = true; return; }
          const resolved = await realpath(file);
          if (!within(directory, resolved) || !samePath(resolved, file)) { skipped = true; return; }
          await unlink(file);
        } catch (error) { if (codeOf(error) !== "ENOENT") throw error; }
      };
      // This schema admits only the worker's finite directory structure. The
      // nested directories are analysis-cache/boundaries and photo-depth; arbitrary folders
      // and foreign files survive cleanup, even inside an otherwise valid job.
      const removeGroup = async (groupDirectory: string, group: ArtifactGroup): Promise<void> => {
        try {
          if (!await checkRoot() || !await checkedDirectory(groupDirectory, groupDirectory, directory)) { skipped = true; return; }
          for (const entry of await readdir(groupDirectory, { withFileTypes: true })) {
            const file = path.join(groupDirectory, entry.name);
            if (entry.isSymbolicLink()) { skipped = true; continue; }
            if (group === "joint-attempt" && entry.name === "joint-geometry" && entry.isDirectory()) {
              await removeGroup(file, "joint-geometry");
              continue;
            }
            if (group === "analysis-cache" && (entry.name === "boundaries" || entry.name === "photo-depth" || entry.name === "joint-depth") && entry.isDirectory()) {
              await removeGroup(file, entry.name);
              continue;
            }
            const known = group === "features" ? featurePattern.test(entry.name)
              : group === "room-analysis" ? roomAnalysisFiles.has(entry.name)
                : group === "joint-attempt" ? jointDepthFiles.has(entry.name)
                  : group === "joint-depth" ? jointCachePattern.test(entry.name)
                    : group === "joint-geometry" ? jointGeometryPattern.test(entry.name)
                    : group === "depth-architecture" ? depthArchitectureFiles.has(entry.name)
                      : group === "textured-mesh" ? texturedMeshFiles.has(entry.name)
                : analysisCachePattern.test(entry.name);
            if (!known || !entry.isFile()) { skipped = true; continue; }
            await removeFile(file, groupDirectory);
          }
          if (!await checkRoot() || !await checkedDirectory(groupDirectory, groupDirectory, directory)) { skipped = true; return; }
          try { await rmdir(groupDirectory); }
          catch (error) { if (!["ENOTEMPTY", "ENOENT"].includes(codeOf(error))) throw error; }
        } catch (error) { if (codeOf(error) !== "ENOENT") throw error; }
      };
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) { skipped = true; continue; }
        if (knownFiles.has(entry.name)) {
          await removeFile(file, directory);
        } else if (entry.name === "features" && entry.isDirectory()) {
          await removeGroup(file, "features");
        } else if (roomAnalysisDirectory(entry.name) && entry.isDirectory()) {
          await removeGroup(file, "room-analysis");
        } else if (jointDepthDirectory(entry.name) && entry.isDirectory()) {
          await removeGroup(file, "joint-attempt");
        } else if (depthArchitectureDirectory(entry.name) && entry.isDirectory()) {
          await removeGroup(file, "depth-architecture");
        } else if (texturedMeshDirectory(entry.name) && entry.isDirectory()) {
          await removeGroup(file, "textured-mesh");
        } else if (entry.name === "analysis-cache" && entry.isDirectory()) {
          await removeGroup(file, "analysis-cache");
        } else skipped = true;
      }
      if (!await checkRoot()) { result.skipped.push(id); continue; }
      try {
        await rmdir(directory);
        result.removed.push(id);
      } catch (error) {
        if (codeOf(error) === "ENOTEMPTY" && skipped) result.skipped.push(id);
        else throw error;
      }
    } catch (error) {
      if (codeOf(error) === "ENOENT") result.missing.push(id);
      else result.failed.push({ jobId: id, code: codeOf(error) });
    }
  }
  return result;
}

export async function cleanupProcessingArtifacts(dataDirectory: string, jobIds: readonly string[]): Promise<CleanupResult> {
  const result = await cleanupPass(dataDirectory, jobIds);
  // Windows can report EPERM while a concurrent cleaner still holds a directory
  // handle. Retry the entire validated pass, never an unchecked deletion path.
  for (let attempt = 0; attempt < 2; attempt++) {
    const retryIds = result.failed.filter(item => ["EPERM", "EBUSY", "ENOTEMPTY"].includes(item.code)).map(item => item.jobId);
    if (!retryIds.length) break;
    await delay(25 * (attempt + 1));
    const repeated = await cleanupPass(dataDirectory, retryIds), ids = new Set(retryIds);
    result.failed = result.failed.filter(item => !ids.has(item.jobId)).concat(repeated.failed);
    result.removed.push(...repeated.removed);
    result.missing.push(...repeated.missing);
    result.skipped.push(...repeated.skipped);
  }
  return result;
}
