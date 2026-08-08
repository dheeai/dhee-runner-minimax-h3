/**
 * Steps scale with what the scene asks for, floored at the turbo LoRA's count.
 *
 * 8 fixed steps was measured to attenuate generated audio ~15 dB and strip ~8 dB
 * of high-frequency detail, because the turbo sampler is distilled to 4
 * (dhee-bundle-illustrated-story-h3#10). 4 is therefore the floor and the
 * default; complexity buys more, up to 10.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stepsForSceneComplexity, RENDER_COMPLEXITY_LEVELS } from '../dist/officialFormat.js';

const scene = (shots, refs, duration, lines) => ({
  shots: Array.from({ length: shots }, (_, i) => ({ dialogue: i < lines ? [{}] : [] })),
  references: Array.from({ length: refs }),
  duration,
});

test('the simplest scene gets the floor, never less', () => {
  assert.equal(stepsForSceneComplexity(scene(1, 3, 8, 0)).steps, 4);
  assert.equal(stepsForSceneComplexity(scene(1, 1, 5, 0)).steps, 4);
});

test('the busiest scene gets the ceiling, never more', () => {
  assert.equal(stepsForSceneComplexity(scene(4, 9, 15.08, 3)).steps, 10);
  assert.equal(stepsForSceneComplexity(scene(9, 9, 15.08, 9)).steps, 10);
});

test('each dimension raises the complexity SCORE', () => {
  // With discrete tiers a single dimension may not cross a boundary on its own —
  // that is the point of tiers. The invariant worth pinning is that every
  // dimension is actually wired into the score.
  const base = stepsForSceneComplexity(scene(1, 3, 8, 0)).score;
  assert.ok(stepsForSceneComplexity(scene(3, 3, 8, 0)).score > base, 'cuts');
  assert.ok(stepsForSceneComplexity(scene(1, 7, 8, 0)).score > base, 'references');
  assert.ok(stepsForSceneComplexity(scene(1, 3, 8, 2)).score > base, 'dialogue');
  assert.ok(stepsForSceneComplexity(scene(1, 3, 15, 0)).score > base, 'duration');
});

test('steps land only on the 4/6/8/10 tiers, never between', () => {
  const allowed = new Set([4, 6, 8, 10]);
  for (let shots = 1; shots <= 5; shots += 1) {
    for (let refs = 1; refs <= 9; refs += 2) {
      for (const dur of [5, 8, 10.13, 15.08]) {
        for (let lines = 0; lines <= 3; lines += 1) {
          const { steps } = stepsForSceneComplexity(scene(shots, refs, dur, lines));
          assert.ok(allowed.has(steps), `got ${steps} for ${shots}/${refs}/${dur}/${lines}`);
        }
      }
    }
  }
});

test('the curve is monotonic in complexity', () => {
  const seq = [
    stepsForSceneComplexity(scene(1, 3, 8, 0)).steps,
    stepsForSceneComplexity(scene(2, 3, 8, 0)).steps,
    stepsForSceneComplexity(scene(2, 5, 8, 2)).steps,
    stepsForSceneComplexity(scene(3, 6, 10.13, 2)).steps,
    stepsForSceneComplexity(scene(4, 9, 15.08, 3)).steps,
  ];
  for (let i = 1; i < seq.length; i += 1) assert.ok(seq[i] >= seq[i - 1], `${seq}`);
});

test('custom bounds are honoured and never inverted', () => {
  assert.equal(stepsForSceneComplexity(scene(1, 3, 8, 0), 6, 6).steps, 6);
  assert.equal(stepsForSceneComplexity(scene(4, 9, 15, 3), 6, 6).steps, 6);
  // an inverted range collapses to the floor rather than throwing
  assert.equal(stepsForSceneComplexity(scene(4, 9, 15, 3), 8, 4).steps, 8);
});

test('a malformed or empty scene still yields the floor', () => {
  assert.equal(stepsForSceneComplexity({}).steps, 4);
  assert.equal(stepsForSceneComplexity({ shots: 'nope', references: null, duration: 'x' }).steps, 4);
});

// ── the authoring model's own judgement ──────────────────────────────────────
// The counters can only see scene SIZE. What costs sampling steps is scene
// DIFFICULTY, and only the model that wrote the shot list knows whether a single
// cut holds one woman at an anvil or forty skeletons overrunning a shield wall.

const withLevel = (level, s = scene(1, 3, 10, 0)) => ({ ...s, renderComplexity: level });

test('each authored level maps to its own tier', () => {
  assert.deepEqual(
    RENDER_COMPLEXITY_LEVELS.map((l) => stepsForSceneComplexity(withLevel(l)).steps),
    [4, 6, 8, 10],
  );
});

test('an authored level overrides the counters in BOTH directions', () => {
  // a one-cut horde shot the counters would have called trivial
  const up = stepsForSceneComplexity(withLevel('extreme', scene(1, 3, 10, 0)));
  assert.equal(up.steps, 10);
  assert.match(up.reason, /counters suggested 4/);

  // a sprawling but easy scene the counters would have called hard
  const down = stepsForSceneComplexity(withLevel('simple', scene(4, 9, 15.08, 3)));
  assert.equal(down.steps, 4);
  assert.match(down.reason, /counters suggested 10/);
});

test('agreement is not reported as a disagreement', () => {
  const r = stepsForSceneComplexity(withLevel('extreme', scene(4, 9, 15.08, 3)));
  assert.equal(r.steps, 10);
  assert.doesNotMatch(r.reason, /counters suggested/);
});

test('an absent or unrecognised level falls back to the counters', () => {
  const counters = stepsForSceneComplexity(scene(4, 6, 12, 0)).steps;
  assert.equal(stepsForSceneComplexity({ ...scene(4, 6, 12, 0), renderComplexity: undefined }).steps, counters);
  assert.equal(stepsForSceneComplexity({ ...scene(4, 6, 12, 0), renderComplexity: 'catastrophic' }).steps, counters);
  assert.equal(stepsForSceneComplexity({ ...scene(4, 6, 12, 0), renderComplexity: 42 }).steps, counters);
});

test('authored levels are case- and whitespace-tolerant', () => {
  assert.equal(stepsForSceneComplexity(withLevel('  Extreme ')).steps, 10);
});

test('an authored level still respects custom bounds', () => {
  assert.equal(stepsForSceneComplexity(withLevel('extreme'), 4, 6).steps, 6);
  assert.equal(stepsForSceneComplexity(withLevel('simple'), 6, 6).steps, 6);
});
