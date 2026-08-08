/**
 * The acting/scenery split: a shot no longer declares its characters twice.
 *
 * `acting[]` is the authority for who is in a shot and `sceneryIds[]` carries
 * the objects and locations; the visible reference list is derived from the two.
 * These tests pin the properties that motivated the change — each of the four
 * failure modes below was measured against a real model on the previous shape:
 *
 *   1. a character in the shot with no acting entry      (deepseek 4/5, thinkingcap 4/5)
 *   2. an acting entry for a subject not in the shot
 *   3. an acting entry naming an object                  (qwen-35b)
 *   4. voiceProfiles disagreeing with the dialogue       (qwen-35b, both directions)
 *
 * 1 and 2 are now UNREPRESENTABLE rather than merely rejected. 3 and 4 stay
 * checks, but each is now a single-field rule instead of a cross-field one.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compileStructuredScenePrompt, resolveShotSubjectIds } from '../dist/officialFormat.js';

const EXPECTED = ['maya', 'ferry_ticket', 'dock'];

/** A scene in the NEW shape: no `subjectIds`, no `performance.voiceProfiles`. */
function derivedScene() {
  return {
    spokenLines: ['Exact words.'],
    summary: '[reference generation] Maya reads the ticket on the dock and says one line before the boat departs.',
    references: [
      { id: 'maya', type: 'character', appearsAs: 'young woman in a blue coat', job: 'hold her face and wardrobe', retention: 'fully_preserved' },
      { id: 'ferry_ticket', type: 'object', appearsAs: 'a creased paper ferry ticket', job: 'hold the ticket print and creases', retention: 'fully_preserved' },
      { id: 'dock', type: 'location', appearsAs: 'misty harbor dock at dawn', job: 'hold the dock, fog and dawn light', retention: 'fully_preserved' },
    ],
    shots: [
      {
        id: 'shot-1',
        startTime: 0,
        endTime: 4,
        composition: 'Medium shot at the end of the dock.',
        acting: [{ subjectId: 'maya', tactic: 'confirm the departure time', observableBehavior: 'she tilts the ticket toward the light', beatChange: 'from searching the print to speaking' }],
        sceneryIds: ['ferry_ticket', 'dock'],
        action: 'Maya lifts the ticket, reads it, and speaks.',
        cameraMotion: 'Push In',
        sound: 'Wet footsteps and a low harbor bell.',
        dialogue: [{
          speakerId: 'S1', subjectId: 'maya', language: 'English',
          exactWords: 'Exact words.', delivery: 'quietly',
          voicePrompt: 'A young woman with a light, unhurried mid-range voice and clipped consonants.',
        }],
      },
      {
        id: 'shot-2',
        startTime: 4,
        endTime: 8,
        composition: 'Wide view of the empty dock.',
        acting: [],
        sceneryIds: ['dock'],
        action: 'The boat clears the pier and the dock stands empty.',
        cameraMotion: 'Tracking Shot',
        sound: 'Water churns against the hull and rope creaks.',
        transition: 'the shot cuts wider to reveal the widening distance.',
      },
    ],
    overallSoundscape: 'Water laps the pilings and rope creaks under tension.',
    nonDiegeticMusic: 'N/A',
    negatives: ['no on-screen text of any kind'],
    duration: 8,
    purpose: 'Maya learns the boat has already gone.',
    shotStructure: 'multi_cut',
    performance: {
      objective: 'to catch the last ferry',
      obstacle: 'it has already left',
      stakes: 'she loses the only crossing until morning',
      physicalBusiness: 'folding and refolding the ticket',
      bodyState: 'weight forward, shoulders high',
      eyeLife: 'eyes drop to the print, then lift to the water',
    },
  };
}

const compile = (scene) =>
  compileStructuredScenePrompt(scene, { strictPerformance: true, expectedReferenceIds: EXPECTED });

test('subjectIds is derived as characters-then-scenery', () => {
  assert.deepEqual(
    resolveShotSubjectIds(derivedScene().shots[0], 'shots[0]'),
    ['maya', 'ferry_ticket', 'dock'],
  );
});

test('a scene in the derived shape compiles, and numbers subjects from references', () => {
  const out = compile(derivedScene());
  assert.match(out.detailedDescription, /Visible subjects: <Subject 1>, <Subject 2>, <Subject 3>\./);
  assert.match(out.detailedDescription, /<Subject 1> \(S1\) says quietly: <d>\[English\] Exact words\.<\/d>/);
});

test('an environment-only shot needs no acting entry', () => {
  const scene = derivedScene();
  assert.deepEqual(resolveShotSubjectIds(scene.shots[1], 'shots[1]'), ['dock']);
  assert.doesNotThrow(() => compile(scene));
});

test('a speaker with no acting entry is rejected unless the line says it is off-screen', () => {
  const scene = derivedScene();
  scene.shots[0].acting = [];
  // `acting` is what puts a character on screen, so dropping it makes Maya
  // absent. That is a legal state (a voiceover) but it has to be declared —
  // otherwise a forgotten entry would silently become a disembodied voice.
  assert.throws(() => compile(scene), /speaks but is not in this shot's acting\[\]/);
});

test('an off-screen line compiles and uses the guide\'s exact voiceover phrase', () => {
  const scene = derivedScene();
  scene.shots[0].acting = [];
  scene.shots[0].dialogue[0].offScreen = true;
  const out = compile(scene);
  assert.match(out.detailedDescription, /\(S1\) says in an off-screen voiceover, quietly: <d>/);
  // Maya is not on screen here, so no lips-closed clause is owed.
  assert.doesNotMatch(out.detailedDescription, /lips remain/);
});

test('an on-screen speaker voicing over gets the lips-remain-closed statement', () => {
  const scene = derivedScene();
  scene.shots[0].dialogue[0].offScreen = true; // acting entry retained: she IS visible
  const out = compile(scene);
  assert.match(out.detailedDescription, /says in an off-screen voiceover, quietly: <d>\[English\] Exact words\.<\/d> while their lips remain completely closed\./);
});

test('an acting entry naming an object is rejected, and the message lists only characters', () => {
  const scene = derivedScene();
  scene.shots[0].sceneryIds = ['dock']; // free the ticket so the dedup check does not pre-empt
  scene.shots[0].acting.push({ subjectId: 'ferry_ticket', tactic: 't', observableBehavior: 'o', beatChange: 'b' });
  assert.throws(() => compile(scene), (err) => {
    assert.match(err.message, /"ferry_ticket" is a object, not a character/);
    assert.match(err.message, /Character IDs in this scene: maya/);
    return true;
  });
});

test('a character hidden in sceneryIds is rejected', () => {
  const scene = derivedScene();
  scene.shots[1].sceneryIds = ['maya', 'dock'];
  assert.throws(() => compile(scene), /"maya" is a character/);
});

test('the same id in both acting and sceneryIds is rejected', () => {
  const scene = derivedScene();
  scene.shots[0].sceneryIds = ['maya', 'dock'];
  assert.throws(() => compile(scene), /lists maya twice/);
});

test('a speaker with no voicePrompt on any line is rejected', () => {
  const scene = derivedScene();
  delete scene.shots[0].dialogue[0].voicePrompt;
  assert.throws(() => compile(scene), /voicePrompt on its first line; missing for: maya/);
});

test('voice identity is emitted once, from the line, before the first <d>', () => {
  const scene = derivedScene();
  const out = compile(scene);
  const hits = out.detailedDescription.match(/Voice identity for <Subject 1>:/g) ?? [];
  assert.equal(hits.length, 1);
});

test('a voiceProfile for a silent character is UNREPRESENTABLE — there is no scene-level list to put it in', () => {
  const scene = derivedScene();
  // The only place a voicePrompt can live is on a dialogue line, and a silent
  // character has none. Attaching one to another speaker's line cannot
  // misattribute it either: the runner keys it by that line's subjectId.
  scene.shots[0].dialogue[0].voicePrompt = 'A different voice entirely.';
  const out = compile(scene);
  assert.match(out.detailedDescription, /Voice identity for <Subject 1>: A different voice entirely\./);
});

test('legacy scenes that authored subjectIds and performance.voiceProfiles still compile', () => {
  const scene = derivedScene();
  // Rebuild the OLD shape from the new one.
  scene.shots[0].subjectIds = ['maya', 'ferry_ticket', 'dock'];
  scene.shots[1].subjectIds = ['dock'];
  const { voicePrompt } = scene.shots[0].dialogue[0];
  delete scene.shots[0].dialogue[0].voicePrompt;
  delete scene.shots[0].sceneryIds;
  delete scene.shots[1].sceneryIds;
  scene.performance.voiceProfiles = [{ subjectId: 'maya', voicePrompt }];
  const out = compile(scene);
  assert.match(out.detailedDescription, /Visible subjects: <Subject 1>, <Subject 2>, <Subject 3>\./);
  assert.match(out.detailedDescription, /Voice identity for <Subject 1>:/);
});

test('legacy shape still rejects a character whose acting entry is missing', () => {
  const scene = derivedScene();
  scene.shots[0].subjectIds = ['maya', 'ferry_ticket', 'dock'];
  scene.shots[0].acting = [];
  assert.throws(() => compile(scene), /acting is required for character subject\(s\): maya/);
});
