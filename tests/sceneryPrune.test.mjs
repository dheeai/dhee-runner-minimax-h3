/**
 * A background prop the section is not licensed to show is DROPPED, not fatal.
 *
 * Measured on a real film: a section's prose read "Vashti does not look at the
 * lantern" — a rhetorical mention, so the lantern was correctly absent from that
 * section's entities — and the scene author staged it anyway. A prompt rule
 * saying the allowlist wins was added and did not hold. Losing a background prop
 * costs a prop; failing costs the render and every scene after it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pruneUnlicensedScenery, validateStructuredSceneReferences } from '../dist/index.js';

const ALLOWED = ['vashti_oru', 'the_courier', 'the_forge', 'the_last_ember'];
const scene = () => ({
  references: [{ id: 'vashti_oru' }, { id: 'the_courier' }, { id: 'the_forge' }],
  shots: [
    { sceneryIds: ['the_forge', 'the_last_ember', 'iron_lantern'], acting: [{ subjectId: 'vashti_oru' }] },
    { sceneryIds: ['the_forge'], acting: [] },
  ],
});

test('an unlicensed scenery id is removed and reported', () => {
  const s = scene();
  const dropped = pruneUnlicensedScenery(s, ALLOWED);
  assert.deepEqual(s.shots[0].sceneryIds, ['the_forge', 'the_last_ember']);
  assert.equal(dropped.length, 1);
  assert.match(dropped[0], /iron_lantern/);
});

test('licensed scenery is untouched', () => {
  const s = scene();
  pruneUnlicensedScenery(s, ALLOWED);
  assert.deepEqual(s.shots[1].sceneryIds, ['the_forge']);
});

test('after pruning, the scene passes reference validation', () => {
  const s = scene();
  pruneUnlicensedScenery(s, ALLOWED);
  assert.doesNotThrow(() => validateStructuredSceneReferences(s, ALLOWED));
});

test('an unlicensed PROP plate is dropped from references, not fatal', () => {
  // The same id was already being pruned from sceneryIds and then hard-failing
  // one line later from references[] — a prop the plan licensed for an earlier
  // section, staged again by the author of a later one.
  const s = {
    references: [
      { id: 'vashti_oru', type: 'character' },
      { id: 'the_forge', type: 'location' },
      { id: 'iron_lantern', type: 'object' },
    ],
    shots: [{ sceneryIds: ['the_forge', 'iron_lantern'], acting: [{ subjectId: 'vashti_oru' }] }],
  };
  const dropped = pruneUnlicensedScenery(s, ALLOWED);
  assert.deepEqual(s.references.map((r) => r.id), ['vashti_oru', 'the_forge']);
  assert.deepEqual(s.shots[0].sceneryIds, ['the_forge']);
  assert.match(dropped.join(' | '), /references\[2\]\.id="iron_lantern"/);
  assert.doesNotThrow(() => validateStructuredSceneReferences(s, ALLOWED));
});

test('a prop plate something ACTS or SPEAKS as is identity — still fatal', () => {
  for (const shot of [
    { sceneryIds: [], acting: [{ subjectId: 'iron_lantern' }] },
    { sceneryIds: [], acting: [], dialogue: [{ subjectId: 'iron_lantern' }] },
  ]) {
    const s = { references: [{ id: 'vashti_oru', type: 'character' }, { id: 'iron_lantern', type: 'object' }], shots: [shot] };
    pruneUnlicensedScenery(s, ALLOWED);
    assert.equal(s.references.length, 2);
    assert.throws(() => validateStructuredSceneReferences(s, ALLOWED), /iron_lantern/);
  }
});

test('an unlicensed CHARACTER plate is never pruned — it changes who is in the film', () => {
  const s = {
    references: [{ id: 'vashti_oru', type: 'character' }, { id: 'a_stranger', type: 'character' }],
    shots: [{ sceneryIds: [], acting: [{ subjectId: 'vashti_oru' }] }],
  };
  pruneUnlicensedScenery(s, ALLOWED);
  assert.equal(s.references.length, 2);
  assert.throws(() => validateStructuredSceneReferences(s, ALLOWED), /a_stranger/);
});

test('the LAST plate is never pruned — a scene with zero references cannot render', () => {
  const s = { references: [{ id: 'iron_lantern', type: 'object' }], shots: [{ sceneryIds: [], acting: [] }] };
  const dropped = pruneUnlicensedScenery(s, ALLOWED);
  assert.equal(s.references.length, 1);
  assert.deepEqual(dropped, []);
  assert.throws(() => validateStructuredSceneReferences(s, ALLOWED), /iron_lantern/);
});

test('identity-critical ids still hard-fail — they are not scenery', () => {
  const s = scene();
  s.references.push({ id: 'a_stranger' });
  pruneUnlicensedScenery(s, ALLOWED);
  assert.throws(() => validateStructuredSceneReferences(s, ALLOWED), /a_stranger/);

  const s2 = scene();
  s2.shots[0].acting = [{ subjectId: 'a_stranger' }];
  pruneUnlicensedScenery(s2, ALLOWED);
  assert.throws(() => validateStructuredSceneReferences(s2, ALLOWED), /a_stranger/);

  const s3 = scene();
  s3.shots[0].dialogue = [{ subjectId: 'a_stranger' }];
  pruneUnlicensedScenery(s3, ALLOWED);
  assert.throws(() => validateStructuredSceneReferences(s3, ALLOWED), /a_stranger/);
});

test('an empty allowlist prunes nothing (legacy callers without a plan)', () => {
  const s = scene();
  assert.deepEqual(pruneUnlicensedScenery(s, []), []);
  assert.equal(s.shots[0].sceneryIds.length, 3);
});
