/** Counts successful image inspection separately from shared-map registration. */
export function processingEvidenceCounts(result, total, sources = []) {
  const features = result.diagnostics?.features;
  // A zero-feature photo was inspected; a missing or malformed entry was not.
  const analyzedSceneIds = Array.isArray(features)
    ? result.scenes.filter((scene, index) => typeof scene.id === 'string'
      && Number.isInteger(features[index]) && features[index] >= 0).map(scene => scene.id).slice(0, total)
    : [];
  const analyzedPhotos = new Set(analyzedSceneIds).size;
  const analyzedIds = new Set(analyzedSceneIds);
  const analyzedSources = sources.filter(scene => analyzedIds.has(scene.id))
    .map(scene => ({id: scene.id, image: scene.image, floor: scene.floor}));
  const positioned = result.scenes.filter(scene => scene.position
    && ['x', 'y', 'z'].every(axis => Number.isFinite(scene.position[axis])));
  const frameCounts = new Map();
  for (const scene of positioned) {
    if (typeof scene.component === 'string') frameCounts.set(scene.component, (frameCounts.get(scene.component) ?? 0) + 1);
  }
  return {
    analyzedPhotos,
    analyzedSceneIds,
    analyzedSources,
    positionedLocalPhotos: positioned.length,
    independentFrames: [...frameCounts.values()].filter(count => count >= 2).length,
    unmatchedPhotos: total - positioned.length,
  };
}
