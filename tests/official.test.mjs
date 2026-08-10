/**
 * Official MiniMax H3 full-reference format — pure logic, no GPU.
 * Run: node tests/official.test.mjs
 */
import assert from 'node:assert/strict';
import {
  buildSubjectSections, remapSubjectLabels, assembleH3Prompt,
  auditDetailedDescription, H3_SECTION_ORDER, RETENTION_MARKERS, CAMERA_MOTIONS,
} from '../dist/index.js';

let pass = 0;
const t = (n, f) => { f(); pass++; console.log(`  ok  ${n}`); };

const REFS = [
  { appearsAs: 'the elderly hunched fisherwoman in a green sari', job: 'her face, build and wardrobe' },
  { appearsAs: 'a wide cane basket, weathered and shallow', job: "the basket's weave and size" },
  { appearsAs: 'the fish dock at first light', job: 'the location, its architecture and light' },
];

console.log('buildSubjectSections — plates are Subjects, images are provenance');
t('every plate becomes <Subject n> citing <Picture n>', () => {
  const { subjectDefinitions } = buildSubjectSections(REFS);
  assert.match(subjectDefinitions, /^<Subject 1> is the elderly hunched fisherwoman in a green sari in <Picture 1>\./m);
  assert.match(subjectDefinitions, /^<Subject 3> is the fish dock at first light in <Picture 3>\./m);
  assert.equal(subjectDefinitions.split('\n').length, 3);
});
t('the job becomes a "Follow it for" clause', () => {
  const { subjectDefinitions } = buildSubjectSections(REFS);
  assert.match(subjectDefinitions, /Follow it for her face, build and wardrobe\./);
});
t('retention_analysis is one fixed-marker line per subject', () => {
  const { retentionAnalysis } = buildSubjectSections(REFS);
  const lines = retentionAnalysis.split('\n');
  assert.equal(lines.length, 3);
  lines.forEach((l, i) => assert.match(l, new RegExp(`^<Subject ${i + 1}>: fully_preserved - `)));
});
t('an explicit marker overrides the default', () => {
  const { retentionAnalysis } = buildSubjectSections([{ appearsAs: 'a style', job: 'the grade', retention: 'weak_reference' }]);
  assert.match(retentionAnalysis, /^<Subject 1>: weak_reference - /);
});
t('a plate with no job still yields a usable line', () => {
  const { retentionAnalysis } = buildSubjectSections([{ appearsAs: 'a red door' }]);
  assert.match(retentionAnalysis, /a red door is retained exactly as shown\./);
});
t('every default marker is one of the guide\'s fixed values', () => {
  const { retentionAnalysis } = buildSubjectSections(REFS);
  for (const line of retentionAnalysis.split('\n')) {
    const m = /^<Subject \d+>: (\w+) - /.exec(line);
    assert.ok(RETENTION_MARKERS.includes(m[1]), `${m[1]} not a fixed marker`);
  }
});

console.log('remapSubjectLabels — labels follow the FINAL plate order');
t('no reorder means no change at all', () => {
  const r = remapSubjectLabels('<Subject 1> greets <Subject 2>.', [1, 2]);
  assert.equal(r.remapped, false);
  assert.equal(r.prose, '<Subject 1> greets <Subject 2>.');
});
t('a swap is applied once, not twice', () => {
  // authored [A,B]; final order put B first -> authoredIndexByFinalPos = [2,1]
  const r = remapSubjectLabels('<Subject 1> greets <Subject 2>.', [2, 1]);
  assert.equal(r.remapped, true);
  assert.equal(r.prose, '<Subject 2> greets <Subject 1>.');
});
t('location-last routing renumbers correctly', () => {
  // authored [char, location, object]; final [char, object, location] -> [1,3,2]
  const r = remapSubjectLabels('<Subject 1> at <Subject 2> holding <Subject 3>.', [1, 3, 2]);
  assert.equal(r.prose, '<Subject 1> at <Subject 3> holding <Subject 2>.');
});
t('Picture labels are remapped alongside Subject labels', () => {
  const r = remapSubjectLabels('shown in <Picture 2>', [2, 1]);
  assert.equal(r.prose, 'shown in <Picture 1>');
});
t('a dropped plate leaves its label untouched rather than mangling it', () => {
  const r = remapSubjectLabels('<Subject 1> and <Subject 9>.', [2, 1]);
  assert.match(r.prose, /<Subject 9>/);
});

console.log('assembleH3Prompt — six sections, fixed order');
const ASM = assembleH3Prompt({
  subjectDefinitions: '<Subject 1> is a woman in <Picture 1>.',
  summary: '[reference generation] She walks.',
  retentionAnalysis: '<Subject 1>: fully_preserved - her face.',
  detailedDescription: 'Cinematic style.\n[Shot 1] She walks.',
});
t('all six headings present in the documented order', () => {
  const idx = H3_SECTION_ORDER.map((h) => ASM.indexOf(`${h}:`));
  assert.ok(idx.every((i) => i >= 0), 'a section is missing');
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b), 'sections out of order');
});
t('subject_definitions comes BEFORE summary (runner interleaves)', () => {
  assert.ok(ASM.indexOf('subject_definitions:') < ASM.indexOf('summary:'));
});
t('retention_analysis sits between summary and detailed_description', () => {
  assert.ok(ASM.indexOf('summary:') < ASM.indexOf('retention_analysis:'));
  assert.ok(ASM.indexOf('retention_analysis:') < ASM.indexOf('detailed_description:'));
});
t('absent audio sections become N/A, not omitted headings', () => {
  assert.match(ASM, /overall_soundscape:\nN\/A/);
  assert.match(ASM, /non_diegetic_music:\nN\/A/);
});

console.log('auditDetailedDescription — advisory, matches the guide');
t('a clean description reports nothing', () => {
  const good = 'Cinematic style.\n[Shot 1] A wide of the dock, Static Shot.\n[Shot 2] At 00:04.000, the shot cuts to a close-up. ' + 'word '.repeat(300);
  assert.deepEqual(auditDetailedDescription(good, { hasDialogue: false }), []);
});
t('does NOT flag a correct [Shot 1] when the whole body is one line', () => {
  // Regression: `[^\n]*` used to run past [Shot 1] and match [Shot 2]'s cut time.
  const oneLine = 'Style opening. [Shot 1] A wide of the dock, Static Shot. [Shot 2] At 00:04.000, the shot cuts to a close-up. ' + 'word '.repeat(300);
  assert.ok(!auditDetailedDescription(oneLine, { hasDialogue: false }).some((n) => /Shot 1\] carries a timestamp/.test(n)));
});
t('flags missing controlled camera vocabulary', () => {
  const noVocab = 'Style. [Shot 1] In a static medium shot she waits. ' + 'word '.repeat(300);
  assert.ok(auditDetailedDescription(noVocab, { hasDialogue: false }).some((n) => /controlled camera-motion term/.test(n)));
});
t('flags a timestamp on [Shot 1]', () => {
  const bad = '[Shot 1] At 00:00.000, a wide. ' + 'word '.repeat(300);
  assert.ok(auditDetailedDescription(bad, { hasDialogue: false }).some((n) => /Shot 1\] carries a timestamp/.test(n)));
});
t('flags non-increasing cut times', () => {
  const bad = '[Shot 1] A. [Shot 2] At 00:05.000, B. [Shot 3] At 00:03.000, C. ' + 'word '.repeat(300);
  assert.ok(auditDetailedDescription(bad, { hasDialogue: false }).some((n) => /not strictly increasing/.test(n)));
});
t('flags a later shot with no cut time', () => {
  const bad = '[Shot 1] A. [Shot 2] B. ' + 'word '.repeat(300);
  assert.ok(auditDetailedDescription(bad, { hasDialogue: false }).some((n) => /cut time/.test(n)));
});
t('flags dialogue with no <d> block or no speaker id', () => {
  const bad = '[Shot 1] She speaks. ' + 'word '.repeat(300);
  const notes = auditDetailedDescription(bad, { hasDialogue: true });
  assert.ok(notes.some((n) => /<d>\[Language\]/.test(n)));
  assert.ok(notes.some((n) => /\(Sx\) speaker id/.test(n)));
});
t('accepts the documented dialogue form', () => {
  const good = '[Shot 1] Static Shot. <Subject 1> (S1) says: <d>[English] Hello.</d> ' + 'word '.repeat(300);
  assert.deepEqual(auditDetailedDescription(good, { hasDialogue: true }), []);
});
t('flags a description well under the 350-500 word range', () => {
  assert.ok(auditDetailedDescription('[Shot 1] Short.', { hasDialogue: false }).some((n) => /words/.test(n)));
});

console.log('CAMERA_MOTIONS — the controlled vocabulary is present');
t('carries the guide\'s motion types', () => {
  for (const m of ['Push In', 'Arc Shot', 'Truck Left', 'Static Shot', 'POV', 'Pedestal Up']) {
    assert.ok(CAMERA_MOTIONS.includes(m), `${m} missing`);
  }
});

console.log(`\n${pass} assertions passed.`);

// ── index-based references ─────────────────────────────────────────────────
{
  const { normalizeIndexedRefs } = await import('../dist/officialFormat.js');

  // A shot pointing at POSITIONS cannot invent or borrow an id, and cannot
  // address a character as scenery when the arrays are split.
  const doc = {
    references: [{ id: 'sereth_vale', type: 'character' }, { id: 'kael', type: 'character' }, { id: 'the_forge', type: 'location' }],
    shots: [{
      acting: [{ subjectRef: 0 }, { subjectRef: 1 }],
      sceneryRefs: [2],
      dialogue: [{ subjectRef: 0, exactWords: 'Hold it steady.' }],
    }],
    continuationAnchor: { characterPositions: [{ subjectRef: 1, where: 'at the anvil' }] },
  };
  const notes = normalizeIndexedRefs(doc);
  assert.deepEqual(doc.shots[0].acting.map((a) => a.subjectId), ['sereth_vale', 'kael']);
  assert.deepEqual(doc.shots[0].sceneryIds, ['the_forge']);
  assert.equal(doc.shots[0].dialogue[0].subjectId, 'sereth_vale');
  assert.equal(doc.continuationAnchor.characterPositions[0].subjectId, 'kael');
  assert.ok(notes.length >= 4);
  console.log('  ok indexed refs resolve to ids');

  // An out-of-range index fails HERE, naming what was available.
  assert.throws(
    () => normalizeIndexedRefs({ references: [{ id: 'a' }], shots: [{ sceneryRefs: [3] }] }),
    /out of range.*1 reference\(s\).*0\.\.0/s,
  );
  console.log('  ok out-of-range index names the available references');

  // A non-integer is rejected rather than coerced.
  assert.throws(() => normalizeIndexedRefs({ references: [{ id: 'a' }], shots: [{ sceneryRefs: ['a'] }] }), /must be an integer index/);
  console.log('  ok a string where an index belongs is rejected');

  // Legacy id-based documents pass through untouched — every project authored
  // before this exists on disk in that form.
  const legacy = { references: [{ id: 'a' }], shots: [{ acting: [{ subjectId: 'a' }], sceneryIds: ['a'] }] };
  assert.deepEqual(normalizeIndexedRefs(legacy), []);
  assert.equal(legacy.shots[0].acting[0].subjectId, 'a');
  console.log('  ok legacy id-based documents are untouched');

  // continuationFrom describes the PREVIOUS scene, whose cast this scene's
  // references[] does not describe — indexing it would be meaningless.
  const withFrom = { references: [{ id: 'a' }], shots: [], continuationFrom: { characterPositions: [{ subjectId: 'someone_else' }] } };
  normalizeIndexedRefs(withFrom);
  assert.equal(withFrom.continuationFrom.characterPositions[0].subjectId, 'someone_else');
  console.log('  ok continuationFrom is left alone');
}
