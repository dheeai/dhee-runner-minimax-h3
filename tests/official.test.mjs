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

// ── reference dedupe (#19) ──────────────────────────────────────────────────
{
  const { dedupeSceneReferences, normalizeIndexedRefs } = await import('../dist/officialFormat.js');

  // Measured shape: scene_1 padded 9 slots for 2 subjects, alternating.
  const padded = {
    references: [
      { id: 'narrator', type: 'character', appearsAs: 'a' }, // 0 survivor
      { id: 'keerti', type: 'character', appearsAs: 'b' },    // 1 survivor
      { id: 'narrator', type: 'character', appearsAs: 'a2' }, // 2 -> 0
      { id: 'keerti', type: 'character', appearsAs: 'b2' },   // 3 -> 1
      { id: 'narrator', type: 'character', appearsAs: 'a3' }, // 4 -> 0
    ],
    shots: [{
      acting: [{ subjectRef: 0 }, { subjectRef: 3 }],
      sceneryRefs: [4],
      dialogue: [{ subjectRef: 2, exactWords: 'x' }],
    }],
    continuationAnchor: { characterPositions: [{ subjectRef: 3, where: 'left' }] },
  };
  const dedupeNotes = dedupeSceneReferences(padded);
  assert.equal(padded.references.length, 2, 'padded duplicates must collapse to the distinct set');
  assert.deepEqual(padded.references.map((r) => r.id), ['narrator', 'keerti']);
  assert.ok(dedupeNotes.length >= 1, 'must report what collapsed');
  assert.match(dedupeNotes.join(' '), /narrator.*collapsed to slot 0/);
  assert.match(dedupeNotes.join(' '), /keerti.*collapsed to slot 1/);
  // Every raw index pointer must be REMAPPED to the survivor's new position,
  // not left dangling at a position that no longer exists.
  assert.equal(padded.shots[0].acting[0].subjectRef, 0);
  assert.equal(padded.shots[0].acting[1].subjectRef, 1, 'old index 3 (keerti duplicate) must remap to keerti\'s new slot 1');
  assert.equal(padded.shots[0].sceneryRefs[0], 0, 'old index 4 (narrator duplicate) must remap to narrator\'s new slot 0');
  assert.equal(padded.shots[0].dialogue[0].subjectRef, 0, 'old index 2 (narrator duplicate) must remap to narrator\'s new slot 0');
  assert.equal(padded.continuationAnchor.characterPositions[0].subjectRef, 1);
  // The remapped indexes must still resolve correctly through normalizeIndexedRefs.
  normalizeIndexedRefs(padded);
  assert.equal(padded.shots[0].acting[1].subjectId, 'keerti');
  assert.equal(padded.shots[0].dialogue[0].subjectId, 'narrator');
  console.log('  ok padded references collapse to the distinct set with every pointer remapped');

  // A scene with no duplicates is left untouched — no notes, no rewrite.
  const clean = { references: [{ id: 'a' }, { id: 'b' }], shots: [{ acting: [{ subjectRef: 1 }] }] };
  const cleanRefsBefore = clean.references;
  assert.deepEqual(dedupeSceneReferences(clean), []);
  assert.equal(clean.references, cleanRefsBefore, 'must not reallocate the array when nothing collapsed');
  assert.equal(clean.shots[0].acting[0].subjectRef, 1);
  console.log('  ok a scene with distinct ids is left untouched');
}

// ── voice-profile enforcement (#10) ─────────────────────────────────────────
{
  const { applyVoiceProfileOverrides } = await import('../dist/officialFormat.js');

  // Measured shape: S1 (the father) carries the wrong character's voice on
  // some lines and an appearance description (not a voice) on another.
  const scene = {
    shots: [
      {
        dialogue: [
          { subjectId: 'father', speakerId: 'S1', voicePrompt: 'Mid-20s Indian female, warm and melodic timbre.' }, // wrong character's voice
          { subjectId: 'father', speakerId: 'S1', voicePrompt: 'Middle-aged/elderly male, frail, pale, graying/balding.' }, // appearance, not voice
          { subjectId: 'father', speakerId: 'S1', voicePrompt: 'Middle-aged male, frail but calm, warm and steady tone.' }, // correct profile, verbatim
        ],
      },
    ],
  };
  const profiles = { father: 'Middle-aged male, frail but calm, warm and steady tone.' };
  const notes = applyVoiceProfileOverrides(scene, profiles);
  assert.equal(scene.shots[0].dialogue[0].voicePrompt, profiles.father, 'the wrong-character voice must be overwritten with the canonical profile');
  assert.equal(scene.shots[0].dialogue[1].voicePrompt, profiles.father, 'the appearance description must be overwritten with the canonical profile');
  assert.equal(scene.shots[0].dialogue[2].voicePrompt, profiles.father, 'the already-correct line is left byte-identical');
  assert.equal(notes.filter((n) => n.includes('did not match')).length, 2, 'exactly the two mismatched lines are reported, not the correct one');
  console.log('  ok a wrong or appearance-only voicePrompt is repaired from character_acting_profile, logged, not thrown');

  // No profile available (e.g. a genuinely unplated off-screen speaker in a
  // bundle that still allows one): a string with no vocal descriptor is
  // flagged, a real voice description is left alone and unflagged.
  const noProfile = {
    shots: [{ dialogue: [
      { subjectId: 'ghost_voice', speakerId: 'S2', voicePrompt: 'pale, graying/balding' },
      { subjectId: 'ghost_voice2', speakerId: 'S3', voicePrompt: 'A gravelly, low baritone with a slow, deliberate pace.' },
    ] }],
  };
  const notes2 = applyVoiceProfileOverrides(noProfile, undefined);
  assert.equal(noProfile.shots[0].dialogue[0].voicePrompt, 'pale, graying/balding', 'nothing to repair FROM, so the string is left as-is');
  assert.ok(notes2.some((n) => n.includes('no vocal descriptor')), 'an appearance-shaped string with no profile to fix it from is still flagged');
  assert.ok(!notes2.some((n) => n.includes('ghost_voice2')), 'a real vocal description is not flagged');
  console.log('  ok an appearance-shaped voicePrompt with no profile to repair from is flagged, not silently accepted');

  // Same speakerId, two different final voices in one scene — a fixed voice
  // must stay fixed. (Can only happen when no profile exists to force them
  // identical, e.g. two different subjects sharing a speakerId by author error.)
  const splitIdentity = {
    shots: [{ dialogue: [
      { subjectId: 'x', speakerId: 'S1', voicePrompt: 'A deep resonant bass.' },
      { subjectId: 'x', speakerId: 'S1', voicePrompt: 'A high melodic soprano.' },
    ] }],
  };
  const notes3 = applyVoiceProfileOverrides(splitIdentity, undefined);
  assert.ok(notes3.some((n) => n.includes('two different voice identities')), 'one speakerId drifting to two voices in one scene must be reported');
  console.log('  ok one speakerId carrying two voice identities in a scene is reported');
}
