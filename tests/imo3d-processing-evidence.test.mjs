import {test} from 'node:test';
import assert from 'node:assert/strict';
import {processingEvidenceCounts} from '../scripts/lib/imo3d-processing-evidence.mjs';

test('all inspected photos remain counted when only some have a pose in independent frames', () => {
  const scenes = Array.from({length: 100}, (_, index) => ({
    id: String(index),
    position: index < 92 ? {x: index, y: 0, z: 0} : null,
    component: index < 72 ? 'main' : index < 90 ? 'other-room' : index < 92 ? 'pair' : `single-${index}`,
  }));
  assert.deepEqual(processingEvidenceCounts({scenes, diagnostics: {features: Array(100).fill(0)}}, 100), {
    analyzedPhotos: 100, analyzedSceneIds: scenes.map(scene => scene.id), analyzedSources: [], positionedLocalPhotos: 92, independentFrames: 3, unmatchedPhotos: 8,
  });
});

test('missing or malformed feature evidence never reports complete analysis', () => {
  const result = {scenes: [{id: 'one', position: null}, {id: 'two', position: {x: NaN, y: 0, z: 0}}], diagnostics: {features: [5, -1]}};
  assert.equal(processingEvidenceCounts(result, 2).analyzedPhotos, 1);
  assert.equal(processingEvidenceCounts(result, 2).positionedLocalPhotos, 0);
  assert.deepEqual(processingEvidenceCounts(result, 2).analyzedSceneIds, ['one']);
  delete result.diagnostics;
  assert.equal(processingEvidenceCounts(result, 2).analyzedPhotos, 0);
});

test('coverage stores exact public image and floor snapshots without private input paths', () => {
  const result = {scenes: [{id: 'one', position: null, path: 'C:/private/original.jpg'}], diagnostics: {features: [17]}};
  const sources = [{id: 'one', image: '/api/imo3d/assets/version-one', floor: 2, privatePath: 'C:/private/original.jpg'},
    {id: 'uninspected', image: '/api/imo3d/assets/other', floor: 2}];
  const summary = processingEvidenceCounts(result, 1, sources);
  assert.deepEqual(summary.analyzedSources, [{id: 'one', image: '/api/imo3d/assets/version-one', floor: 2}]);
  assert.ok(!JSON.stringify(summary).includes('private'));
});
