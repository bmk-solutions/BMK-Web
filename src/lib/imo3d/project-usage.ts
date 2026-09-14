import type { DatabaseSync } from "node:sqlite";
import { lstat, realpath } from "node:fs/promises";
// Private runtime paths must not enter the Next build's asset tracing graph.
const path: typeof import("node:path") = process.getBuiltinModule("node:path");

export type ProjectUsage = {
  projectId: string; measuredAt: string;
  storage: { bytes: number; fileBytes: number; brandingBytes: number; files: number; missingFiles: number; unreadableFiles: number };
  processing: { jobs: number; statuses: Record<string, number>; elapsedSeconds: number; elapsedBasis: "created-to-last-update"; timedJobs: number; unknownDurationJobs: number };
  transfer: { bytes: null };
};
const safeFile = (filename: string) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/.test(filename) && !filename.includes("..");
const within = (root: string, candidate: string) => { const relative = path.relative(root, candidate); return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };

/** Count only the requesting project's explicitly referenced private files and branding blobs. */
export async function projectUsage(database: DatabaseSync, dataDir: string, projectId: string): Promise<ProjectUsage | null> {
  if (!database.prepare("SELECT 1 FROM projects WHERE id=?").get(projectId)) return null;
  const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => String(row.name)));
  const filenames = new Set<string>();
  for (const table of ["assets", "scene_originals"] as const) if (tables.has(table)) {
    for (const row of database.prepare(`SELECT owned.file FROM ${table} owned JOIN tours tour ON tour.id=owned.tour_id WHERE tour.project_id=?`).all(projectId)) filenames.add(String(row.file));
  }
  const storage: ProjectUsage["storage"] = { bytes: 0, fileBytes: 0, brandingBytes: 0, files: 0, missingFiles: 0, unreadableFiles: 0 };
  if (tables.has("project_brand_assets")) storage.brandingBytes = Number(database.prepare("SELECT COALESCE(SUM(length(bytes)),0) AS bytes FROM project_brand_assets WHERE project_id=?").get(projectId)?.bytes ?? 0);
  const root = path.resolve(dataDir), assets = path.join(root, "assets");
  let canonicalAssets: string | null = null;
  try {
    const rootStat = await lstat(root), assetsStat = await lstat(assets);
    if (rootStat.isDirectory() && !rootStat.isSymbolicLink() && assetsStat.isDirectory() && !assetsStat.isSymbolicLink()) {
      const canonicalRoot = await realpath(root), resolved = await realpath(assets);
      if (within(canonicalRoot, resolved)) canonicalAssets = resolved;
    }
    if (!canonicalAssets) storage.unreadableFiles = filenames.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") storage.missingFiles = filenames.size;
    else storage.unreadableFiles = filenames.size;
  }
  if (canonicalAssets) for (const filename of filenames) {
    if (!safeFile(filename)) { storage.unreadableFiles++; continue; }
    try {
      const parent = await lstat(assets);
      if (!parent.isDirectory() || parent.isSymbolicLink() || path.relative(canonicalAssets, await realpath(assets)) !== "") { storage.unreadableFiles++; continue; }
      const file = path.join(assets, filename), stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || path.relative(canonicalAssets, path.dirname(await realpath(file))) !== "") { storage.unreadableFiles++; continue; }
      storage.fileBytes += stat.size; storage.files++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") storage.missingFiles++; else storage.unreadableFiles++;
    }
  }
  storage.bytes = storage.fileBytes + storage.brandingBytes;
  const processing: ProjectUsage["processing"] = { jobs: 0, statuses: Object.fromEntries(["queued", "running", "completed", "review", "failed", "cancelled", "stale"].map(status => [status, 0])), elapsedSeconds: 0, elapsedBasis: "created-to-last-update", timedJobs: 0, unknownDurationJobs: 0 };
  if (tables.has("processing_jobs")) {
    const jobs = database.prepare("SELECT job.status,job.created_at,job.updated_at FROM processing_jobs job JOIN tours tour ON tour.id=job.tour_id WHERE tour.project_id=?").all(projectId);
    processing.jobs = jobs.length;
    for (const job of jobs) {
      const status = String(job.status);
      if (Object.hasOwn(processing.statuses, status)) processing.statuses[status]++;
      if (status === "queued" || status === "running") continue;
      const elapsed = Date.parse(String(job.updated_at)) - Date.parse(String(job.created_at));
      if (Number.isFinite(elapsed) && elapsed >= 0) { processing.elapsedSeconds += elapsed / 1000; processing.timedJobs++; }
      else processing.unknownDurationJobs++;
    }
  }
  return { projectId, measuredAt: new Date().toISOString(), storage, processing, transfer: { bytes: null } };
}
