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
