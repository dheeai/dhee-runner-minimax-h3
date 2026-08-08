/**
 * The continuity ledger: the inherited boundary reaches the render, and the
 * end-state anchor does NOT.
 *
 * Background: `continuationAnchor` used to be a free-prose string emitted into
 * the prose of the scene that wrote it — the one scene that could not use it.
 * Nothing read it, so every scene was authored blind to its predecessor. The
 * shipped saas_bahu_test film ended scene 1 with the tea poured and steaming
 * and opened scene 2 asserting the cups were not yet visible.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compileStructuredScenePrompt,
  validateStructuredScenePerformance,
} from '../dist/officialFormat.js';

const LEDGER = () => ({
  fixedLandmarks: [
    { name: 'the gas stove', screenPosition: 'in the left third against the back wall' },
    { name: 'the wooden table', screenPosition: 'across the centre-bottom foreground' },
  ],
  characterPositions: [
    { subjectId: 'sudha', screenPosition: 'in the left third', facing: 'three-quarters away from camera', pose: 'standing at the stove, palm flat on the counter' },
  ],
  offStage: [
    { subjectId: 'rina', where: 'in the unlit hallway beyond the doorway', reason: 'she has not come in yet' },
  ],
  lightingBaseline: 'a hard cool tubelight from directly overhead with a warm stove flame on the left',
  propStates: [{ name: 'the two tea cups', state: 'both poured and steaming, on the table' }],
});

const scene = (extra = {}) => ({
  spokenLines: [],
  style: 'Cinematic photoreal film still.',
  summary: '[reference generation] A woman waits in a kitchen.',
  references: [
    { id: 'sudha', type: 'character', appearsAs: 'a woman of 48', job: 'her face', retention: 'fully_preserved' },
    { id: 'rina', type: 'character', appearsAs: 'a woman of 28', job: 'her face', retention: 'fully_preserved' },
    { id: 'kitchen', type: 'location', appearsAs: 'a cramped kitchen', job: 'the layout', retention: 'fully_preserved' },
  ],
  shots: [{
    id: 's1', startTime: 0, endTime: 8,
    composition: 'Medium wide on the kitchen.',
    acting: [{ subjectId: 'sudha', tactic: 'wait', observableBehavior: 'stands still', beatChange: 'none' }],
    sceneryIds: ['kitchen'],
    action: 'She waits.',
    cameraMotion: 'Static Shot',
    sound: 'A tubelight hums.',
    dialogue: [],
  }],
  overallSoundscape: 'A tubelight hums.',
  nonDiegeticMusic: 'N/A',
  negatives: ['subtitles'],
  duration: 8,
  speechSeconds: 0,
  purpose: 'To wait.',
  shotStructure: 'locked_single',
  renderComplexity: 'simple',
  performance: {
    objective: 'wait', obstacle: 'time', stakes: 'none',
    physicalBusiness: 'standing', bodyState: 'rigid', eyeLife: 'fixed',
  },
  ...extra,
});

const body = (value) => {
  const { sections } = compileStructuredScenePrompt(value, { expectedReferenceIds: ['sudha', 'rina', 'kitchen'] });
  return sections.find((s) => s.name === 'detailed_description').body;
};

test('continuationFrom is compiled into directed prose before the first shot', () => {
  const text = body(scene({ continuationFrom: LEDGER() }));
  const opening = text.indexOf('The scene opens on exactly this state');
  assert.ok(opening > -1, 'the inherited boundary should be stated');
  assert.ok(opening < text.indexOf('[Shot 1]'), 'it must come before the first shot marker');

  // every field reaches the render
  assert.match(text, /the gas stove in the left third against the back wall/);
  assert.match(text, /the wooden table across the centre-bottom foreground/);
  assert.match(text, /sudha is in the left third, three-quarters away from camera/);
  assert.match(text, /rina is not in frame/);
  assert.match(text, /hard cool tubelight from directly overhead/);
  assert.match(text, /the two tea cups: both poured and steaming/);
});

test('no key:value labels are introduced — the ledger becomes prose', () => {
  const text = body(scene({ continuationFrom: LEDGER() }));
  for (const label of ['fixedLandmarks', 'characterPositions', 'lightingBaseline', 'offStage', 'propStates']) {
    assert.ok(!text.includes(label), `${label} leaked into the description as a label`);
  }
});

test('continuationAnchor is NOT emitted — it describes a state after the clip ends', () => {
  const text = body(scene({ continuationAnchor: LEDGER() }));
  assert.ok(!text.includes('Continuation anchor'), 'the old metadata label must be gone');
  assert.ok(!text.includes('both poured and steaming'), 'the end state must not be rendered into this scene');
});

test('a hard cut is stated as a break instead of asserting continuity', () => {
  const text = body(scene({ continuationFrom: { ...LEDGER(), hardCut: 'two hours later, the same kitchen' } }));
  assert.match(text, /After a deliberate break — two hours later/);
});

test('the first scene of a film compiles unchanged', () => {
  const text = body(scene());
  assert.ok(!text.includes('The scene opens on exactly this state'));
  assert.ok(!text.includes('After a deliberate break'));
  assert.match(text, /\[Shot 1\]/);
});

test('a landmark without a screen position is rejected — that IS the defect', () => {
  assert.throws(
    () => body(scene({ continuationFrom: { ...LEDGER(), fixedLandmarks: [{ name: 'the stove' }] } })),
    /fixedLandmarks\[0\]\.screenPosition must be a non-empty string/,
  );
});

test('an empty landmark list is rejected', () => {
  assert.throws(
    () => body(scene({ continuationFrom: { ...LEDGER(), fixedLandmarks: [] } })),
    /fixedLandmarks must have at least one entry/,
  );
});

test('continuationFrom may name someone who is NOT in this scene — they left', () => {
  // The inherited boundary is the PREVIOUS scene's end state. A woman at a
  // window in scene 1 is legitimately named there and absent from scene 2.
  // Rejecting it failed a real film on
  // `continuationFrom.characterPositions[0].subjectId "meera" is unknown`.
  assert.doesNotThrow(() => validateStructuredScenePerformance(
    scene({ continuationFrom: { ...LEDGER(), characterPositions: [
      { subjectId: 'meera', screenPosition: 'at the window', facing: 'away', pose: 'standing' },
    ] } }),
    ['sudha', 'rina', 'kitchen'], true,
  ));
});

test('a departed character is not DESCRIBED as visible, or H3 would invent one', () => {
  const text = body(scene({ continuationFrom: { ...LEDGER(), characterPositions: [
    ...LEDGER().characterPositions,
    { subjectId: 'meera', screenPosition: 'at the window', facing: 'away', pose: 'standing' },
  ] } }));
  assert.match(text, /sudha is in the left third/);
  assert.ok(!text.includes('meera is at the window'), 'someone with no plate must not be staged');
});

test('continuationAnchor DOES still reject an unknown subject — it is this scene', () => {
  assert.throws(
    () => validateStructuredScenePerformance(
      scene({ continuationAnchor: { ...LEDGER(), characterPositions: [{ subjectId: 'ghost', screenPosition: 'left', facing: 'camera', pose: 'standing' }] } }),
      ['sudha', 'rina', 'kitchen'], true,
    ),
    /continuationAnchor\.characterPositions\[0\]\.subjectId "ghost" is unknown/,
  );
});

test('an off-stage entry describing speech is rejected before it reaches the audit', () => {
  assert.throws(
    () => validateStructuredScenePerformance(
      scene({ continuationFrom: { ...LEDGER(), offStage: [{ subjectId: 'rina', where: 'in the hallway', reason: 'she calls out to her' }] } }),
      ['sudha', 'rina', 'kitchen'], true,
    ),
    /describes speech \("calls"\), which synthesises voice with no words/,
  );
});

test('a legitimate off-stage reason passes', () => {
  assert.doesNotThrow(() => validateStructuredScenePerformance(
    scene({ continuationFrom: LEDGER() }), ['sudha', 'rina', 'kitchen'], true,
  ));
});

test('offStage may name someone NOT in references — that is the whole point', () => {
  // An off-stage character has no plate and no reference entry. Validating this
  // against references[] made the field unusable for the case it exists for:
  // cold_plate scene 1 could not declare the daughter downstairs, so scene 2
  // staged her already in the doorway instead of arriving.
  assert.doesNotThrow(() => validateStructuredScenePerformance(
    scene({ continuationAnchor: { ...LEDGER(), offStage: [{ subjectId: 'nisha', where: 'one flight down in the stairwell', reason: 'she has not come up yet' }] } }),
    ['sudha', 'rina', 'kitchen'], true,
  ));
});

test('a legacy string continuationAnchor is now rejected rather than silently emitted', () => {
  assert.throws(
    () => body(scene({ continuationAnchor: 'She stands at the stove.' })),
    /continuationAnchor must be an object when supplied/,
  );
});

// ── founder rule, measured 2026-08-08 ───────────────────────────────────────
// A clip with no words must have no score: H3 makes one audio track, and with
// nothing vocal to anchor, a score request returns voice-shaped gibberish.

test('a scene with no dialogue is forced to N/A score', () => {
  const { sections } = compileStructuredScenePrompt(
    scene({ nonDiegeticMusic: 'Low sustained strings, slow, swelling at the end.' }),
    { expectedReferenceIds: ['sudha', 'rina', 'kitchen'] },
  );
  assert.equal(sections.find((s) => s.name === 'non_diegetic_music').body, 'N/A');
});

test('a scene WITH dialogue keeps its score', () => {
  const withLine = scene({
    spokenLines: ['क्या आप जागी हुई हैं?'],
    nonDiegeticMusic: 'Low sustained strings, slow, swelling at the end.',
    shots: [{
      id: 's1', startTime: 0, endTime: 8,
      composition: 'Medium wide on the kitchen.',
      acting: [{ subjectId: 'sudha', tactic: 'ask', observableBehavior: 'turns', beatChange: 'none' }],
      sceneryIds: ['kitchen'],
      action: 'She speaks.',
      cameraMotion: 'Static Shot',
      sound: 'A tubelight hums.',
      dialogue: [{
        speakerId: 'S1', subjectId: 'sudha', language: 'Hindi',
        exactWords: 'क्या आप जागी हुई हैं?', delivery: 'flat',
        voicePrompt: 'a low flat unhurried chest-register voice',
      }],
    }],
  });
  const { sections } = compileStructuredScenePrompt(withLine, { expectedReferenceIds: ['sudha', 'rina', 'kitchen'] });
  assert.match(sections.find((s) => s.name === 'non_diegetic_music').body, /Low sustained strings/);
});

test('an already-N/A score is left alone', () => {
  const { sections } = compileStructuredScenePrompt(scene(), { expectedReferenceIds: ['sudha', 'rina', 'kitchen'] });
  assert.equal(sections.find((s) => s.name === 'non_diegetic_music').body, 'N/A');
});

// ── derived arrivals ────────────────────────────────────────────────────────
// offStage was left empty by the author on every scene of the first real run,
// no matter how the prompt was worded. But the answer is implied by a field the
// author DOES fill: a character acting in this scene who is absent from
// continuationFrom.characterPositions was not in the room when it opened.

const twoHander = (extra = {}) => scene({
  shots: [{
    id: 's1', startTime: 0, endTime: 8,
    composition: 'Wide on the kitchen.',
    acting: [
      { subjectId: 'sudha', tactic: 'wait', observableBehavior: 'stands', beatChange: 'none' },
      { subjectId: 'rina', tactic: 'enter', observableBehavior: 'steps in', beatChange: 'arrives' },
    ],
    sceneryIds: ['kitchen'],
    action: 'One waits, one comes in.',
    cameraMotion: 'Static Shot',
    sound: 'A tubelight hums.',
    dialogue: [],
  }],
  ...extra,
});

const bodyWithPrior = (value, previousSectionEntities) => {
  const { sections } = compileStructuredScenePrompt(value, {
    expectedReferenceIds: ['sudha', 'rina', 'kitchen'], previousSectionEntities,
  });
  return sections.find((s) => s.name === 'detailed_description').body;
};

test('a character absent from the previous section is ordered to be seen arriving', () => {
  const text = bodyWithPrior(twoHander({ continuationFrom: LEDGER() }), ['sudha', 'kitchen']);
  assert.match(text, /rina is not in the room as the scene opens/);
  assert.match(text, /must SHOW them come in/);
  assert.ok(text.indexOf('not in the room') < text.indexOf('[Shot 1]'), 'must land before the first shot');
});

test('no arrival is claimed for someone already in the previous section', () => {
  // The false positive that shipped: cold_plate scene 3 had the same cast as
  // scene 2, but a mis-copied ledger made the runner order a second entrance.
  const text = bodyWithPrior(twoHander({ continuationFrom: LEDGER() }), ['sudha', 'rina', 'kitchen']);
  assert.ok(!text.includes('not in the room as the scene opens'), 'nobody needs to arrive here');
});

test('the derivation needs neither offStage nor continuationFrom', () => {
  const text = bodyWithPrior(twoHander(), ['sudha', 'kitchen']);
  assert.match(text, /rina is not in the room as the scene opens/);
});

test('the first scene of a film gets no arrival directive', () => {
  const text = body(twoHander());   // no previousSectionEntities at all
  assert.ok(!text.includes('not in the room as the scene opens'));
});
