import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as h3 from '../dist/index.js';

const { compileStructuredScenePrompt } = h3;

function validScene() {
  return {
    spokenLines: ['Exact words.'],
    summary: '[reference generation] Two subjects meet at the dock and exchange one exact line before the boat departs.',
    references: [
      {
        id: 'maya',
        type: 'character',
        appearsAs: 'young woman in a blue coat',
        job: 'hold her face, wardrobe and identity across every cut',
        retention: 'fully_preserved',
      },
      {
        id: 'dock',
        type: 'location',
        appearsAs: 'misty harbor dock at dawn',
        job: 'hold the dock architecture, fog and dawn light',
        retention: 'fully_preserved',
      },
    ],
    shots: [
      {
        id: 'shot-1',
        startTime: 0,
        endTime: 4,
        composition: 'Medium two-shot at the end of the dock.',
        subjectIds: ['maya', 'dock'],
        action: 'Maya raises one hand and turns toward the departing boat.',
        cameraMotion: 'Push In',
        sound: 'Wet footsteps and a low bell from the harbor.',
        dialogue: [
          {
            speakerId: 'S1',
            subjectId: 'maya',
            language: 'English',
            exactWords: 'Exact words.',
            delivery: 'quietly',
          },
        ],
      },
      {
        id: 'shot-2',
        startTime: 4,
        endTime: 8,
        composition: 'Wide view looking back from the boat toward the dock.',
        subjectIds: ['maya', 'dock'],
        action: 'The boat clears the pier while Maya lowers her hand and remains still.',
        cameraMotion: 'Tracking Shot',
        sound: 'Water churns against the hull and rope creaks.',
        transition: 'The shot cuts wider to reveal the widening distance.',
      },
    ],
    overallSoundscape: 'Water laps against the pilings, footsteps cross wet boards, and rope creaks under tension.',
    nonDiegeticMusic: 'N/A',
    negatives: ['no subtitles', 'no extra people'],
    duration: 8,
    purpose: 'Maya lets the boat leave.',
    shotStructure: 'multi_cut',
  };
}

function sceneWithShotTimes(times) {
  const scene = validScene();
  scene.shots = scene.shots.map((shot, index) => ({
    ...shot,
    startTime: times[index],
  }));
  return scene;
}

function sceneWithMismatchedDialogue() {
  const scene = validScene();
  scene.shots[0].dialogue[0].exactWords = 'Rewritten words.';
  return scene;
}

test('structured scene compiles to canonical H3 sections', () => {
  const result = compileStructuredScenePrompt(validScene());

  assert.deepEqual(result.sections.map((section) => section.name), [
    'subject_definitions',
    'summary',
    'retention_analysis',
    'detailed_description',
    'overall_soundscape',
    'non_diegetic_music',
  ]);
  assert.match(result.sections[3].body, /\[Shot 1\]/);
  assert.match(result.sections[3].body, /\[Shot 2\] At 00:04\.000/);
  assert.match(result.sections[3].body, /<d>\[English\] Exact words\.<\/d>/);
  assert.match(result.sections[3].body, /The frame stays free of subtitles and extra people throughout\./);
  assert.equal(result.prompt, [
    'subject_definitions:',
    result.sections[0].body,
    '',
    'summary:',
    result.sections[1].body,
    '',
    'retention_analysis:',
    result.sections[2].body,
    '',
    'detailed_description:',
    result.sections[3].body,
    '',
    'overall_soundscape:',
    result.sections[4].body,
    '',
    'non_diegetic_music:',
    result.sections[5].body,
  ].join('\n'));
});

test('compiler rejects non-increasing shot times', () => {
  assert.throws(
    () => compileStructuredScenePrompt(sceneWithShotTimes([0, 0])),
    /increasing/,
  );
});

test('compiler rejects dialogue whose exact words do not match the shot text', () => {
  assert.throws(
    () => compileStructuredScenePrompt(sceneWithMismatchedDialogue()),
    /exact/,
  );
});

test('compiler rejects controlled-camera vocabulary outside the H3 enum', () => {
  const scene = validScene();
  scene.shots[0].cameraMotion = 'Dolly Somewhere';
  assert.throws(() => compileStructuredScenePrompt(scene), /camera/i);
});

test('compiler rejects a shot that ends after the scene duration', () => {
  const scene = validScene();
  scene.shots[1].endTime = 9;
  assert.throws(() => compileStructuredScenePrompt(scene), /duration|bounds/i);
});

test('compiler rejects overlapping shot intervals', () => {
  const scene = validScene();
  scene.shots[0].endTime = 5;
  assert.throws(() => compileStructuredScenePrompt(scene), /overlap|bounds/i);
});

test('runner rejects prompt references and subject owners outside declared scene references', () => {
  const scene = validScene();
  scene.references[0].id = 'traveler_1';
  scene.shots[0].subjectIds[0] = 'traveler_1';
  scene.shots[0].dialogue[0].subjectId = 'traveler_1';

  assert.equal(typeof h3.validateStructuredSceneReferences, 'function');
  assert.throws(
    () => h3.validateStructuredSceneReferences(scene, ['elara', 'oakhaven_canal_district']),
    /unknown.*traveler_1.*expected.*elara.*oakhaven_canal_district/is,
  );
});

test('structured mode keeps legacy detailedDescription documents on the migration path', () => {
  assert.equal(
    typeof h3.shouldCompileStructuredPrompt,
    'function',
  );
  assert.equal(
    h3.shouldCompileStructuredPrompt({ detailedDescription: 'legacy prose' }, 'structured'),
    false,
  );
  assert.equal(
    h3.shouldCompileStructuredPrompt({ references: [], shots: [], shotStructure: 'multi_cut' }, 'legacy'),
    true,
  );
});

function sceneWithPerformance() {
  const scene = validScene();
  scene.performance = {
    objective: 'Make the witness admit what he saw.',
    obstacle: 'He protects himself by looking past her.',
    stakes: 'If he leaves silent, the evidence disappears with him.',
    physicalBusiness: 'She folds and refolds a wet rope while questioning him.',
    bodyState: 'Low center of gravity, controlled breath, shoulders held square.',
    eyeLife: 'Her gaze tracks his eyes with small saccades and deliberate blinks.',
    subtext: 'She asks for truth while testing whether he can be trusted.',
    statusDynamic: 'She starts deferential and quietly takes the higher position.',
    proxemics: 'She closes from social distance toward personal distance, then lets him retreat.',
    voiceProfiles: [{
      subjectId: 'maya',
      voicePrompt: 'A woman in her thirties with a warm mid-range voice; measured and clear under pressure.',
    }],
  };
  scene.shots[0].acting = [{
    subjectId: 'maya',
    tactic: 'press',
    observableBehavior: 'She counts the witness\'s breaths while her thumb rubs the coat seam.',
    beatChange: 'Her polite smile stops when the witness looks away.',
    reaction: 'She answers the look before the line ends.',
    assessmentMoment: 'A brief stillness as she decides whether to accuse him.',
    interruptedAction: 'Her hand stops halfway to the departing rope.',
  }];
  scene.shots[1].acting = [{
    subjectId: 'maya',
    tactic: 'withhold',
    observableBehavior: 'She lowers her hand and watches the empty space where the witness stood.',
    beatChange: 'Her shoulders settle after the boat pulls away.',
  }];
  return scene;
}

test('strict performance rejects a character-visible shot without acting', () => {
  const scene = sceneWithPerformance();
  delete scene.shots[0].acting;
  assert.equal(typeof h3.validateStructuredScenePerformance, 'function');
  assert.throws(
    () => h3.validateStructuredScenePerformance(scene, ['maya', 'dock'], true),
    /acting.*maya/i,
  );
});

test('strict performance rejects an acting subject outside the shot and allowlist', () => {
  const scene = sceneWithPerformance();
  scene.shots[0].acting[0].subjectId = 'traveler_1';
  assert.throws(
    () => h3.validateStructuredScenePerformance(scene, ['maya', 'dock'], true),
    /acting.*traveler_1.*expected.*maya.*dock/is,
  );
});

test('strict performance rejects empty root performance placeholders', () => {
  const scene = sceneWithPerformance();
  scene.performance.objective = '   ';
  assert.throws(
    () => h3.validateStructuredScenePerformance(scene, ['maya', 'dock'], true),
    /performance\.objective/i,
  );
});

test('strict performance rejects missing voice profile for a dialogue subject', () => {
  const scene = sceneWithPerformance();
  scene.performance.voiceProfiles = [];
  assert.throws(
    () => h3.validateStructuredScenePerformance(scene, ['maya', 'dock'], true),
    /voiceProfiles.*maya/i,
  );
});

test('strict performance rejects duplicate voice profiles', () => {
  const scene = sceneWithPerformance();
  scene.performance.voiceProfiles.push({
    subjectId: 'maya',
    voicePrompt: 'A duplicate voice identity.',
  });
  assert.throws(
    () => h3.validateStructuredScenePerformance(scene, ['maya', 'dock'], true),
    /voiceProfiles.*duplicate.*maya/i,
  );
});

test('strict performance rejects unknown voice profiles', () => {
  const scene = sceneWithPerformance();
  scene.performance.voiceProfiles = [{
    subjectId: 'traveler_1',
    voicePrompt: 'An invented voice identity.',
  }];
  assert.throws(
    () => h3.validateStructuredScenePerformance(scene, ['maya', 'dock'], true),
    /voiceProfiles.*traveler_1.*expected.*maya.*dock/is,
  );
});

test('strict performance rejects unneeded non-dialogue voice profiles', () => {
  const scene = sceneWithPerformance();
  scene.performance.voiceProfiles = [{
    subjectId: 'dock',
    voicePrompt: 'A location cannot own a voice.',
  }];
  assert.throws(
    () => h3.validateStructuredScenePerformance(scene, ['maya', 'dock'], true),
    /voiceProfiles.*dock.*dialogue subject|non-character/i,
  );
});

test('strict performance allows an empty voice profile list for a silent scene', () => {
  const scene = sceneWithPerformance();
  scene.spokenLines = [];
  for (const shot of scene.shots) delete shot.dialogue;
  scene.performance.voiceProfiles = [];
  assert.doesNotThrow(() => h3.validateStructuredScenePerformance(scene, ['maya', 'dock'], true));
});

test('behavior-rich performance compiles into observable H3 action prose', () => {
  const result = h3.compileStructuredScenePrompt(sceneWithPerformance(), { strictPerformance: true });
  assert.match(result.detailedDescription, /Physical business: She folds and refolds a wet rope while questioning him\./);
  assert.match(result.detailedDescription, /Tactic: press\. Observable behavior: She counts the witness's breaths/);
  assert.match(result.detailedDescription, /Assessment moment: A brief stillness/);
  assert.match(result.detailedDescription, /Voice identity for <Subject 1>: A woman in her thirties with a warm mid-range voice; measured and clear under pressure\./);
  assert.equal((result.detailedDescription.match(/Voice identity for <Subject 1>/g) ?? []).length, 1);
  assert.ok(result.detailedDescription.indexOf('Voice identity for <Subject 1>') < result.detailedDescription.indexOf('<d>[English] Exact words.</d>'));
  assert.doesNotMatch(result.detailedDescription, /performance\.|observableBehavior|beatChange/);
});
