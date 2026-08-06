import assert from 'node:assert/strict';
import test from 'node:test';

import * as h3 from '../dist/index.js';

const VEYRA_HOOK = {
  spokenLines: [
    'Why does my lip colour always look tired before I do?',
  ],
  detailedDescription: [
    'Vertical 9:16 smartphone aesthetic with warm vanity light.',
    '[Shot 1] <Subject 1> catches her reflection and notices her dry-looking lips. She speaks directly to the lens in a conversational tone.',
    '[Shot 2] At 00:04.500, the shot cuts to the capped product on the vanity.',
  ].join('\n\n'),
};

const VEYRA_APPLICATION = {
  spokenLines: [
    'One swipe. Coffee check, daylight check—and it still feels like my lips.',
  ],
  detailedDescription: [
    'Vertical 9:16 smartphone aesthetic with warm vanity light shifting to daylight.',
    '[Shot 1] The shot opens on the creator applying one clean swipe. The camera performs a slow Push In.',
    '[Shot 2] At 00:05.500, the shot cuts to a coffee check by the window.',
    '[Shot 3] At 00:10.000, the shot cuts to a tighter frame on her face as she speaks her impression. She tilts her head slightly, her eyes conveying quiet confidence. Her delivery is conversational and grounded.',
    '[Shot 4] At 00:13.500, the shot holds on her smiling face.',
  ].join('\n\n'),
};

test('maps the authored spokenLines field into the exact canonical H3 render prose', () => {
  const injectAuthoredDialogue = h3.injectAuthoredDialogue;
  const result = typeof injectAuthoredDialogue === 'function'
    ? injectAuthoredDialogue({
        prose: VEYRA_HOOK.detailedDescription,
        spokenLines: VEYRA_HOOK.spokenLines,
        language: 'English',
      })
    : { prose: '' };

  assert.match(
    result.prose,
    /<Subject 1> \(S1\) says: <d>\[English\] Why does my lip colour always look tired before I do\?<\/d>/,
  );
});

test('does not duplicate an already canonical line', () => {
  const injectAuthoredDialogue = h3.injectAuthoredDialogue;
  const canonical = '<Subject 1> (S1) says: <d>[English] Hello.</d>';
  const result = typeof injectAuthoredDialogue === 'function'
    ? injectAuthoredDialogue({
        prose: `[Shot 1] ${canonical} The camera holds a Static Shot.`,
        spokenLines: ['Hello.'],
        language: 'English',
      })
    : { prose: '' };

  assert.equal(result.prose.split(canonical).length - 1, 1);
});

test('replaces the Veyra application speech cue in Shot 3 instead of speaking at Shot 1', () => {
  const result = h3.injectAuthoredDialogue({
    prose: VEYRA_APPLICATION.detailedDescription,
    spokenLines: VEYRA_APPLICATION.spokenLines,
    language: 'English',
  });
  const shot1 = result.prose.slice(
    result.prose.indexOf('[Shot 1]'),
    result.prose.indexOf('[Shot 2]'),
  );
  const shot3 = result.prose.slice(
    result.prose.indexOf('[Shot 3]'),
    result.prose.indexOf('[Shot 4]'),
  );

  assert.doesNotMatch(shot1, /<d>/, 'the intended line must not be moved to local 0s');
  assert.match(
    shot3,
    /<Subject 1> \(S1\) says: <d>\[English\] One swipe\. Coffee check, daylight check—and it still feels like my lips\.<\/d>/,
  );
  assert.doesNotMatch(result.prose, /speaks her impression/i, 'the stale speech cue would trigger a second voice');
  assert.equal((result.prose.match(/<d>/g) ?? []).length, 1);
});

test('falls back to immediately after Shot 1 only when no authored speech cue exists', () => {
  const result = h3.injectAuthoredDialogue({
    prose: '[Shot 1] She opens the tube. [Shot 2] At 00:05.000, the shot cuts to the product.',
    spokenLines: ['This is the one.'],
    language: 'English',
  });

  assert.match(
    result.prose,
    /^\[Shot 1\] <Subject 1> \(S1\) says: <d>\[English\] This is the one\.<\/d>/,
  );
  assert.equal((result.prose.match(/<d>/g) ?? []).length, 1);
});
