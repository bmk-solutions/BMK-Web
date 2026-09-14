import { lstat, realpath, unlink } from "node:fs/promises";
// Resolve private runtime data without tracing its contents into build assets.
const path: typeof import("node:path") = process.getBuiltinModule("node:path");
import { setTimeout as delay } from "node:timers/promises";

const isWithin = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

/** Remove only explicitly owned, flat private asset files after DB commit. */
export async function cleanupPrivateAssetFiles(dataDir: string, filenames: readonly string[]): Promise<{ failed: string[] }> {
  const unique = [...new Set(filenames)], failed: string[] = [];
  if (!unique.length) return { failed };
  const assetRoot = path.resolve(dataDir, "assets");
  let canonicalAssets: string;
  try {
    const dataStat = await lstat(dataDir), assetsStat = await lstat(assetRoot);
    if (dataStat.isSymbolicLink() || !dataStat.isDirectory() || assetsStat.isSymbolicLink() || !assetsStat.isDirectory()) return { failed: unique };
    const canonicalData = await realpath(dataDir);
    canonicalAssets = await realpath(assetRoot);
    if (!isWithin(canonicalData, canonicalAssets)) return { failed: unique };
  } catch (error) {
    return { failed: (error as NodeJS.ErrnoException).code === "ENOENT" ? [] : unique };
  }
  for (const filename of unique) {
    // No absolute paths, separators, alternate streams, nested directories, or traversal.
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/.test(filename) || filename.includes("..")) { failed.push(filename); continue; }
    const candidate = path.resolve(assetRoot, filename);
    if (path.dirname(candidate) !== assetRoot) { failed.push(filename); continue; }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // A cancellation cleaner may overlap a worker on Windows. Revalidate
        // both parents and the file for every retry, including junction swaps.
        const dataStat = await lstat(dataDir), assetsStat = await lstat(assetRoot);
        if (dataStat.isSymbolicLink() || !dataStat.isDirectory() || assetsStat.isSymbolicLink() || !assetsStat.isDirectory() ||
          path.relative(canonicalAssets, await realpath(assetRoot)) !== "" || !isWithin(await realpath(dataDir), canonicalAssets)) { failed.push(filename); break; }
        const stat = await lstat(candidate);
        if (!stat.isFile() || stat.isSymbolicLink()) { failed.push(filename); break; }
        const canonicalFile = await realpath(candidate);
        if (path.relative(canonicalAssets, path.dirname(canonicalFile)) !== "") { failed.push(filename); break; }
        await unlink(candidate);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") break;
        if (attempt < 2 && (code === "EPERM" || code === "EBUSY")) { await delay(25 * (attempt + 1)); continue; }
        failed.push(filename); break;
      }
    }
  }
  return { failed };
}
