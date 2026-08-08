/**
 * Guide-conformance of the COMPILED prose.
 *
 * These pin the six divergences measured against the official MiniMax H3 guides
 * on real production output (ember_wright, four scenes, three models). Every one
 * of them was in the compiler, not the authoring model — the model's shot-level
 * direction was specific and filmable, and the wrapper around it was not:
 *
 *   - no style opening, and the slot the guide reserves for it (before
 *     [Shot 1]) occupied by non-filmable acting theory          4/4 scenes
 *   - camera emitted as a stacked label `Camera: Push In.`      8 instances
 *   - no amplitude/speed — one enum where the guide has three   4/4 scenes
 *   - retention_analysis missing `(appears in [Shot N])`        4/4 scenes
 *   - `At 00:04.000, The cut reveals …` (capital mid-sentence)  most scenes
 *   - negatives as a bare noun list inside POSITIVE prose       up to 6/6 items
 *
 * Plus the sentence-frame breakage: 24 double periods and 4 `Follow it for
 * <Capital>` in a single four-reference scene.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compileStructuredScenePrompt, buildSubjectSections } from '../dist/officialFormat.js';

const EXPECTED = ['maya', 'dock'];

function scene(extra = {}) {
  return {
    spokenLines: ['Exact words.'],
    style: 'Hand-painted gouache illustration with a muted, desaturated palette and soft directional light.',
    summary: '[reference generation] Maya waits on the dock as the boat departs.',
    references: [
      // Deliberately authored the way models actually write these: capitalised,
      // period-terminated, and (for `job`) a narrative role rather than a
      // visual one.
      { id: 'maya', type: 'character', appearsAs: 'Young woman in a blue coat.', job: 'Her face, coat and the copper pin.', retention: 'fully_preserved' },
      { id: 'dock', type: 'location', appearsAs: 'Misty harbor dock at dawn.', job: 'The dock, fog and dawn light.', retention: 'fully_preserved' },
    ],
    shots: [
      {
        id: 'shot-1', startTime: 0, endTime: 4,
        composition: 'Medium shot at the end of the dock.',
        acting: [{ subjectId: 'maya', tactic: 'wait', observableBehavior: 'she watches the water', beatChange: 'from stillness to speech' }],
        sceneryIds: ['dock'],
        action: 'Maya raises one hand.',
        cameraMotion: 'Push In', cameraAmplitude: 'small', cameraSpeed: 'slow',
        sound: 'Wet footsteps and a low bell.',
        dialogue: [{
          speakerId: 'S1', subjectId: 'maya', language: 'English',
          exactWords: 'Exact words.',
          delivery: 'defiant, gritty', // bare adjectives, as models write them
          voicePrompt: 'A woman in her thirties with a warm mid-range voice.',
        }],
      },
      {
        id: 'shot-2', startTime: 4, endTime: 8,
        composition: 'Wide view from the boat.',
        acting: [], sceneryIds: ['dock'],
        action: 'The boat clears the pier.',
        cameraMotion: 'Tracking Shot',
        sound: 'Water churns against the hull.',
        transition: 'The cut reveals the widening distance.', // capitalised, no cut verb
      },
    ],
    overallSoundscape: 'Water laps the pilings.',
    nonDiegeticMusic: 'N/A',
    negatives: ['subtitles', 'extra people'],
    duration: 8,
    purpose: 'Maya is left behind.',
    shotStructure: 'multi_cut',
    performance: {
      objective: 'to catch the last ferry',
      obstacle: 'it has already left',
      stakes: 'she loses the only crossing until morning',
      subtext: 'she knew it would go without her',
      statusDynamic: 'she stops asking and starts deciding',
      physicalBusiness: 'folding and refolding the ticket',
      bodyState: 'weight forward, shoulders high',
      eyeLife: 'eyes drop to the print, then lift to the water',
    },
    ...extra,
  };
}

const compile = (s = scene()) =>
  compileStructuredScenePrompt(s, { strictPerformance: true, expectedReferenceIds: EXPECTED });

test('the style opening is emitted BEFORE [Shot 1] (ref guide 5.2)', () => {
  const dd = compile().detailedDescription;
  const before = dd.slice(0, dd.indexOf('[Shot 1]'));
  assert.match(before, /Hand-painted gouache illustration/);
});

test('non-filmable performance fields never reach the renderer', () => {
  const dd = compile().detailedDescription;
  for (const gone of ['Performance objective', 'Obstacle:', 'Stakes:', 'Subtext:', 'Status dynamic:']) {
    assert.ok(!dd.includes(gone), `${gone} should not be sent to H3`);
  }
  // the observable half still is
  assert.match(dd, /Physical business: folding and refolding the ticket\./);
  assert.match(dd, /Eye life: eyes drop to the print/);
});

test('camera is natural English inside the shot, never a stacked label', () => {
  const dd = compile().detailedDescription;
  assert.ok(!/Camera: /.test(dd), 'the `Camera: X.` label form is what base guide 4.3 forbids');
  assert.match(dd, /The camera performs a Push In with small amplitude at slow speed\./);
  assert.match(dd, /The camera holds a Tracking Shot following the subject\./);
});

test('a cut marker grammatically continues "At MM:SS.mmm," and names the cut', () => {
  const dd = compile().detailedDescription;
  assert.ok(!/At 00:04\.000, The /.test(dd), 'capitalised mid-sentence');
  assert.match(dd, /\[Shot 2\] At 00:04\.000, the shot cuts to a new view — the cut reveals the widening distance\./);
});

test('an already well-formed transition is passed through untouched', () => {
  const s = scene();
  s.shots[1].transition = 'the shot cuts wider to reveal the empty pier';
  const dd = compile(s).detailedDescription;
  assert.match(dd, /At 00:04\.000, the shot cuts wider to reveal the empty pier\./);
  assert.ok(!dd.includes('new view —'));
});

test('subject sentence frames read correctly and carry no double periods', () => {
  const out = compile();
  const defs = out.sections.find((x) => x.name === 'subject_definitions').body;
  assert.match(defs, /<Subject 1> is young woman in a blue coat in <Picture 1>\. Follow it for her face, coat and the copper pin\./);
  assert.ok(!/\.\./.test(out.prompt), 'no double periods anywhere in the compiled prompt');
  assert.ok(!/ is [A-Z]/.test(defs), 'no capitalised fragment mid-sentence');
});

test('retention_analysis carries the (appears in [Shot N]) clause (ref guide 4.1)', () => {
  const ret = compile().sections.find((x) => x.name === 'retention_analysis').body;
  assert.match(ret, /<Subject 1> \(appears in \[Shot 1\]\): fully_preserved - /);
  assert.match(ret, /<Subject 2> \(appears in \[Shot 1\], \[Shot 2\]\): fully_preserved - /);
});

test('buildSubjectSections still works without a shot map (legacy callers)', () => {
  const { retentionAnalysis } = buildSubjectSections([{ appearsAs: 'a woman', job: 'her face' }]);
  assert.match(retentionAnalysis, /<Subject 1>: fully_preserved - her face\./);
});

test('negatives are stated as absence, not listed as nouns in positive prose', () => {
  const dd = compile().detailedDescription;
  assert.ok(!dd.includes('Negative directions:'), 'the bare noun list is what H3 reads as content');
  assert.match(dd, /The frame stays free of subtitles and extra people throughout\./);
});

test('an already-negated negative is not double-negated', () => {
  const s = scene({ negatives: ['no on-screen text', 'avoid lens flare'] });
  const dd = compile(s).detailedDescription;
  assert.match(dd, /The frame stays free of on-screen text and lens flare throughout\./);
});

test('a bare-adjective delivery becomes adverbial', () => {
  const dd = compile().detailedDescription;
  assert.match(dd, /says in a defiant, gritty tone: <d>/);
});

test('an already-adverbial delivery is left alone', () => {
  const s = scene();
  s.shots[0].dialogue[0].delivery = 'quietly';
  assert.match(compile(s).detailedDescription, /says quietly: <d>/);
  const s2 = scene();
  s2.shots[0].dialogue[0].delivery = 'with a strained breath';
  assert.match(compile(s2).detailedDescription, /says with a strained breath: <d>/);
});

test('style is optional — a scene without one still compiles', () => {
  const s = scene();
  delete s.style;
  const dd = compile(s).detailedDescription;
  assert.ok(dd.startsWith('Physical business:'), 'falls through to the filmable performance block');
});

test('camera amplitude and speed are optional and validated', () => {
  const s = scene();
  delete s.shots[0].cameraAmplitude;
  delete s.shots[0].cameraSpeed;
  assert.match(compile(s).detailedDescription, /The camera performs a Push In\./);
  const bad = scene();
  bad.shots[0].cameraAmplitude = 'medium';
  assert.throws(() => compile(bad), /cameraAmplitude must be 'small' or 'large'/);
});

test('a silent scene may ask for silence without tripping the dialogue audit', async () => {
  // Regression: the negatives sentence was reworded from `Negative directions: …`
  // to an absence statement, and the audit's strip pattern was left matching the
  // old form — so the next silent scene asking for "no murmurs, no whispers" was
  // rejected for asking. Both sides now share NEGATIVES_SENTENCE_PREFIX.
  const { auditDialogueIntegrity, NEGATIVES_SENTENCE_PREFIX } = await import('../dist/officialFormat.js');
  const prose = `[Shot 1] She stands still, her mask closed and unmoving.\n\n${NEGATIVES_SENTENCE_PREFIX}subtitles, murmurs, whispers, shouts and replies throughout.`;
  assert.deepEqual(auditDialogueIntegrity(prose, []).fatal, []);
});

test('the negatives sentence the compiler emits is the one the audit strips', () => {
  const s = scene({ negatives: ['whispers', 'shouting'], spokenLines: [] });
  s.shots[0].dialogue = [];
  s.shots[1].transition = 'the shot cuts wider';
  const dd = compile(s).detailedDescription;
  // it is present in what H3 receives …
  assert.match(dd, /The frame stays free of whispers and shouting throughout\./);
  // … and invisible to the speech-verb scan
  assert.deepEqual(compileStructuredScenePrompt(s, { strictPerformance: true, expectedReferenceIds: EXPECTED })
    .detailedDescription.includes('whispers'), true);
});
