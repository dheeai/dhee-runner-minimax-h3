/**
 * Pure-logic tests for dhee-runner-minimax-h3 — no Comfy, no GPU, no fs.
 * Run: npm test
 */
import assert from 'node:assert/strict';
import * as h3Module from '../dist/index.js';
import {
  snapH3Frames, routeRefs, buildBindingClause, composePrompt, resolveSeconds, shotsForItem,
  planSheetExpansion, resolveGeometry, normalizePromptLayout,
  H3_MAX_REFS, H3_MIN_SECONDS, H3_MAX_SECONDS,
} from '../dist/index.js';

let pass = 0;
function t(name, fn) { fn(); pass++; console.log(`  ok  ${name}`); }

console.log('snapH3Frames — H3 lands on the 17k+5 grid');
t('every snapped length is ≡5 (mod 17)', () => {
  for (let s = 1; s <= 20; s += 0.25) {
    const f = snapH3Frames(s * 24);
    assert.equal(f % 17, 5 % 17, `frames ${f} for ${s}s is off-grid`);
  }
});
t('matches the stock ComfyUI template maths at the endpoints', () => {
  // template: max(5, round(a*24)) + (5 - (… % 17)) % 17
  assert.equal(snapH3Frames(5 * 24), 124);   // 5s  → 124f ≈ 5.17s
  assert.equal(snapH3Frames(15 * 24), 362);  // 15s → 362f ≈ 15.08s
});
t('rounds UP past a remainder above 5 instead of going negative', () => {
  // base%17 == 16 → naive JS (5-16)%17 = -11 would SHORTEN the clip
  const base = 16 + 17 * 3; // 67, 67%17 = 16
  const f = snapH3Frames(base);
  assert.ok(f > base, `expected round-up, got ${f} from ${base}`);
  assert.equal(f % 17, 5);
});
t('never returns below the 5-frame floor', () => {
  assert.equal(snapH3Frames(0), 5);
  assert.equal(snapH3Frames(-100), 5);
});

console.log('routeRefs — ordering, background-last, and the 9-ref cap');
const R = (id, type) => ({ id, type, path: `/p/${id}.png`, appearsAs: `${id} looks like this`, job: `the ${type}` });
t('location goes last, subjects keep authored order', () => {
  const { refs } = routeRefs([R('dock', 'location'), R('sakhubai', 'character'), R('basket', 'object')], new Set(['location']), 9);
  assert.deepEqual(refs.map((r) => r.id), ['sakhubai', 'basket', 'dock']);
});
t('caps at H3_MAX_REFS keeping the background slot', () => {
  const many = Array.from({ length: 12 }, (_, i) => R(`c${i}`, 'character')).concat([R('dock', 'location')]);
  const { refs, notes } = routeRefs(many, new Set(['location']), 99);
  assert.equal(refs.length, H3_MAX_REFS);
  assert.equal(refs.at(-1).id, 'dock');
  assert.ok(notes.some((n) => n.includes('capped')));
});
t('drops the LOWEST-priority subjects, not the first', () => {
  const many = Array.from({ length: 12 }, (_, i) => R(`c${i}`, 'character'));
  const { refs } = routeRefs(many, new Set(['location']), 9);
  assert.deepEqual(refs.map((r) => r.id), ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8']);
});
t('a subject-less all-location scene promotes leading plates to subject slots', () => {
  const { refs, notes } = routeRefs([R('a', 'location'), R('b', 'location'), R('c', 'location')], new Set(['location']), 9);
  assert.equal(refs.length, 3);
  assert.equal(refs.at(-1).id, 'c');
  assert.ok(notes.some((n) => n.includes('promoted')));
});
t('deduplicates by path (the same plate cited twice is one slot)', () => {
  const dup = { id: 'x', type: 'character', path: '/p/same.png' };
  const { refs } = routeRefs([dup, { ...dup, id: 'y' }], new Set(['location']), 9);
  assert.equal(refs.length, 1);
});
t('a single reference passes straight through, undeduplicated and unpadded', () => {
  const { refs } = routeRefs([R('solo', 'location')], new Set(['location']), 9);
  assert.deepEqual(refs.map((r) => r.id), ['solo']);
});

console.log('buildBindingClause — every reference gets a job');
t('numbers slots 1..N in final order and states each job', () => {
  const c = buildBindingClause([R('sakhubai', 'character'), R('dock', 'location')]);
  assert.match(c, /<Picture 1> — sakhubai looks like this\. Use it for the character\./);
  assert.match(c, /<Picture 2> — dock looks like this\. Use it for the location\./);
});
t('degrades gracefully when a reference has no job or no descriptor', () => {
  const c = buildBindingClause([{ id: 'a', type: 'character', path: '/a.png', appearsAs: 'a woman in green' }, { id: 'b', type: 'object', path: '/b.png' }]);
  assert.match(c, /<Picture 1> — a woman in green\. Preserve this appearance exactly\./);
  assert.match(c, /<Picture 2> — a reference plate/);
});
t('empty reference list yields no clause at all', () => {
  assert.equal(buildBindingClause([]), '');
});

console.log("composePrompt — H3's ~7,000-char window");
t('passes short prompts through untouched', () => {
  const { prompt, trimmed } = composePrompt('CLAUSE', 'prose');
  assert.equal(prompt, 'CLAUSE\n\nprose');
  assert.equal(trimmed, 0);
});
t('trims the PROSE tail, never the binding clause', () => {
  const clause = 'C'.repeat(100);
  const prose = 'P'.repeat(9000);
  const { prompt, trimmed } = composePrompt(clause, prose, 1000);
  assert.equal(prompt.length, 1000);
  assert.ok(prompt.startsWith(clause), 'binding clause must survive intact');
  assert.equal(trimmed, 100 + 2 + 9000 - 1000);
});

console.log('shotsForItem — one shot, or a whole section');
const plan = {
  shots: [
    { id: 'scene_1_shot_1', scene: 1, duration: 6 },
    { id: 'scene_1_shot_2', scene: 1, duration: 5 },
    { id: 'scene_2_shot_1', scene: 2, duration: 8 },
  ],
};
t('an exact shot id resolves to that one shot', () => {
  assert.deepEqual(shotsForItem(plan, 'scene_1_shot_2').map((s) => s.id), ['scene_1_shot_2']);
});
t('a section id resolves to every shot in that section', () => {
  assert.deepEqual(shotsForItem(plan, 'scene_1').map((s) => s.id), ['scene_1_shot_1', 'scene_1_shot_2']);
});
t('an unknown id resolves to nothing', () => {
  assert.deepEqual(shotsForItem(plan, 'scene_9'), []);
});

console.log('resolveSeconds — precedence and the 5..15s clamp');
t('the authored prompt duration wins over the plan', () => {
  const r = resolveSeconds(12, shotsForItem(plan, 'scene_1'), 10, H3_MIN_SECONDS, H3_MAX_SECONDS);
  assert.equal(r.seconds, 12);
  assert.equal(r.source, 'prompt');
});
t("a section's shot durations are SUMMED into one multi-cut clip", () => {
  const r = resolveSeconds(undefined, shotsForItem(plan, 'scene_1'), 10, H3_MIN_SECONDS, H3_MAX_SECONDS);
  assert.equal(r.seconds, 11); // 6 + 5
  assert.match(r.source, /sum of 2 shots/);
});
t('clamps a section longer than 15s down to the ceiling and flags it', () => {
  const long = { shots: [{ id: 'scene_3_shot_1', scene: 3, duration: 9 }, { id: 'scene_3_shot_2', scene: 3, duration: 14 }] };
  const r = resolveSeconds(undefined, shotsForItem(long, 'scene_3'), 10, H3_MIN_SECONDS, H3_MAX_SECONDS);
  assert.equal(r.seconds, 15);
  assert.equal(r.clamped, true);
});
t('clamps a too-short beat up to the 5s floor', () => {
  const tiny = { shots: [{ id: 'scene_4_shot_1', scene: 4, duration: 2 }] };
  const r = resolveSeconds(undefined, shotsForItem(tiny, 'scene_4'), 10, H3_MIN_SECONDS, H3_MAX_SECONDS);
  assert.equal(r.seconds, 5);
  assert.equal(r.clamped, true);
});
t('falls back to cfg.seconds when neither prompt nor plan says anything', () => {
  const r = resolveSeconds(undefined, [], 10, H3_MIN_SECONDS, H3_MAX_SECONDS);
  assert.equal(r.seconds, 10);
  assert.equal(r.source, 'fallback');
});

console.log('resolveSeconds — measured dialogue FLOOR (H3 stretches/compresses audio to fill the clip exactly)');
const DIALOGUE_12_WORDS = 'ek do teen char paanch che saat aath nau das gyarah barah';
t('the speech floor RAISES a too-short authored duration', () => {
  const withDialogue = { shots: [{ id: 'scene_5_shot_1', scene: 5, dialogue: DIALOGUE_12_WORDS }] };
  const r = resolveSeconds(4, shotsForItem(withDialogue, 'scene_5'), 10, H3_MIN_SECONDS, H3_MAX_SECONDS);
  // speechSecondsFor(12 words, 1 sentence) = 12/2.8 + 1.0 lead-in + 0.6 tail
  // ≈ 5.89s, bigger than the authored 4s. The tail margin was added after a
  // real film clipped its last words: the fixed overhead covered lead-in AND
  // tail together, and measured lead-in alone is 0.40-1.33s.
  const expected = 12 / 2.8 + 1.0 + 0.6;
  assert.ok(Math.abs(r.speechFloorSec - expected) < 1e-9, `got ${r.speechFloorSec}`);
  assert.ok(Math.abs(r.seconds - expected) < 1e-9);
  assert.match(r.source, /^prompt\+speechFloor\(5\.89s\)$/);
});
t('a longer authored duration is NOT shrunk by a smaller speech floor', () => {
  const withDialogue = { shots: [{ id: 'scene_5_shot_1', scene: 5, dialogue: DIALOGUE_12_WORDS }] };
  const r = resolveSeconds(12, shotsForItem(withDialogue, 'scene_5'), 10, H3_MIN_SECONDS, H3_MAX_SECONDS);
  assert.equal(r.seconds, 12);
  assert.equal(r.source, 'prompt'); // floor did not win — no +speechFloor suffix
  assert.ok(r.speechFloorSec < 12);
});
t('no dialogue on any plan shot leaves behaviour completely unchanged', () => {
  const noDialogue = { shots: [{ id: 'scene_6_shot_1', scene: 6, duration: 6 }] };
  const r = resolveSeconds(undefined, shotsForItem(noDialogue, 'scene_6'), 10, H3_MIN_SECONDS, H3_MAX_SECONDS);
  assert.equal(r.seconds, 6);
  assert.equal(r.source, 'plan');
  assert.equal(r.speechFloorSec, undefined);
});
t('a dialogue floor past the ceiling clamps to maxSeconds and is reported via speechFloorSec for the caller to warn on', () => {
  const fiftyWords = Array.from({ length: 50 }, (_, i) => `w${i}`).join(' ');
  const overflow = { shots: [{ id: 'scene_7_shot_1', scene: 7, dialogue: fiftyWords }] };
  const r = resolveSeconds(undefined, shotsForItem(overflow, 'scene_7'), 10, H3_MIN_SECONDS, H3_MAX_SECONDS);
  // 50/2.8 + 1.0 lead-in + 0.6 tail ≈ 19.46s — well past the 15.08s ceiling.
  assert.equal(r.seconds, H3_MAX_SECONDS);
  assert.equal(r.clamped, true);
  assert.ok(r.speechFloorSec > H3_MAX_SECONDS);
  assert.match(r.source, /speechFloor\(19\.46s\)/);
});

console.log('planSheetExpansion — contact sheets become separate single-view plates, within 9 slots');
t('the ordinary case: 1 character + object + location → 2 views, 4 slots', () => {
  const r = planSheetExpansion(1, 2, 2, 9);
  assert.deepEqual(r, { views: 2, total: 4, degraded: false });
});
t('3 characters + object + location still fits at 2 views each', () => {
  const r = planSheetExpansion(3, 2, 2, 9);
  assert.equal(r.views, 2);
  assert.equal(r.total, 8);
  assert.equal(r.degraded, false);
});
t('4 characters + a location is exactly 9 slots at 2 views — it fits, no degrade', () => {
  const r = planSheetExpansion(4, 1, 2, 9);
  assert.deepEqual(r, { views: 2, total: 9, degraded: false });
});
t('5 characters + a location degrades to 1 view each rather than dropping anyone', () => {
  const r = planSheetExpansion(5, 1, 2, 9);
  assert.equal(r.views, 1);
  assert.equal(r.total, 6);
  assert.equal(r.degraded, true);
});
t('never degrades below one view per subject, even when over budget', () => {
  const r = planSheetExpansion(12, 1, 3, 9);
  assert.equal(r.views, 1); // the plain maxRefs cap handles the rest
});
t('a scene with no sheet subjects is left alone', () => {
  const r = planSheetExpansion(0, 3, 2, 9);
  assert.equal(r.total, 3);
  assert.equal(r.degraded, false);
});

console.log('resolveGeometry — resolution is a per-project field, not a bundle constant');
t('a preset name wins over the node config', () => {
  const g = resolveGeometry('480p', 1344, 768);
  assert.deepEqual(g, { width: 832, height: 480, source: 'resolution:480p' });
});
t('preset lookup is case-insensitive and trims', () => {
  assert.equal(resolveGeometry('  720P ', 1344, 768).width, 1280);
});
t("'native' is H3's own geometry", () => {
  const g = resolveGeometry('native', 100, 100);
  assert.deepEqual([g.width, g.height], [1344, 768]);
});
t('an explicit <w>x<h> is accepted and snapped to /32', () => {
  const g = resolveGeometry('1000x600', 1344, 768);
  assert.deepEqual([g.width, g.height], [992, 608]);
});
t('unset falls back to the node config, snapped to /32', () => {
  // 720 is not a multiple of 32 (22.5x), so the config path rounds it to 736.
  // Presets are deliberately NOT snapped: '720p' stays a true 1280x720, which
  // is measured working against the node despite its declared step of 32.
  const g = resolveGeometry(undefined, 1280, 720);
  assert.deepEqual(g, { width: 1280, height: 736, source: 'config' });
  assert.deepEqual(resolveGeometry('720p', 1, 1), { width: 1280, height: 720, source: 'resolution:720p' });
});
t('a TYPO falls back to config rather than failing the render', () => {
  const g = resolveGeometry('48op', 1344, 768);
  assert.equal(g.source, 'config');
  assert.equal(g.width, 1344);
});
t('nothing at all yields H3 native', () => {
  const g = resolveGeometry(undefined, undefined, undefined);
  assert.deepEqual([g.width, g.height], [1344, 768]);
});

console.log('normalizePromptLayout — layout is code, not a prompt instruction');
const RUNON = 'Cinematic look, 50mm, natural grade.  Scene overview: A dock at dawn.  Storyboard, one continuous shot:  [0s-3s] Wide on the jetty.  [3s-7s] She walks.  [7s-10s] She stops.  Camera: One continuous shot, no cuts.  Lighting: Low dawn sun.  Audio: Gulls and water.  Performance: Weary but steady.  Do not include on-screen text.';
const HEADS = ['Scene overview','Storyboard','Camera','Lighting','Audio','Performance'];
const atStart = (t) => HEADS.filter((h) => new RegExp('^\\s*' + h, 'im').test(t)).length;

t('a zero-newline run-on gets every heading back on its own line', () => {
  assert.equal(RUNON.split('\n').length - 1, 0, 'fixture must be a single line');
  const out = normalizePromptLayout(RUNON);
  assert.equal(atStart(out), 6, 'all six headings should start a line');
});
t('carries the qualifier form "Storyboard, one continuous shot:"', () => {
  const out = normalizePromptLayout(RUNON);
  assert.match(out, /^Storyboard, one continuous shot:/m);
});
t('every timecoded block starts its own line', () => {
  const out = normalizePromptLayout(RUNON);
  assert.equal((out.match(/^\s*\[\s*\d/gm) || []).length, 3);
});
t('IDEMPOTENT — running it twice changes nothing', () => {
  const once = normalizePromptLayout(RUNON);
  assert.equal(normalizePromptLayout(once), once);
});
t('already-formatted prose is left alone', () => {
  const good = 'Look line.\n\nScene overview: A dock.\n\nStoryboard:\n\n[0s-5s] Wide.\n\nCamera: Locked.\n\nLighting: Dawn.\n\nAudio: Gulls.\n\nPerformance: Steady.\n\nDo not add text.';
  assert.equal(normalizePromptLayout(good), good);
});
t('collapses runs of 3+ newlines to a single blank line', () => {
  assert.equal(normalizePromptLayout('a\n\n\n\nb'), 'a\n\nb');
});
t('does not split a timecode that already starts a line', () => {
  const out = normalizePromptLayout('[0s-3s] One.\n\n[3s-6s] Two.');
  assert.equal((out.match(/^\s*\[/gm) || []).length, 2);
});

console.log('applyH3WorkflowContract — founder-tested MiniMaxH3Cache graph');
const applyH3WorkflowContract = h3Module.applyH3WorkflowContract ?? (() => undefined);
const canonicalGraph = () => ({
  unet: { class_type: 'UNETLoader', inputs: { unet_name: 'h3-int8.safetensors' } },
  patch: { class_type: 'PathchSageAttentionKJ', inputs: { sage_attention: 'auto', model: ['unet', 0] } },
  cache: {
    class_type: 'MiniMaxH3Cache',
    inputs: { resuse_threshold: 0.03, start_percent: 0.15, end_percent: 0.9, max_steps: 1, model: ['patch', 0] },
  },
  preview: { class_type: 'ModelPreviewOverrideKJ', inputs: { model: ['cache', 0] } },
  h3: {
    class_type: 'MiniMaxH3ReferenceToVideo',
    inputs: {
      prompt: 'literal template copy that must never reach H3',
      ref_image_0: ['oldFlat', 0],
      'ref_images.ref_image_1': ['oldDotted', 0],
    },
  },
  scheduler: { class_type: 'BasicScheduler', inputs: { scheduler: 'beta', steps: 99, model: ['patch', 0] } },
  sampler: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
  noise: { class_type: 'RandomNoise', inputs: { noise_seed: 1 } },
  output: { class_type: 'CreateVideo', inputs: { fps: 30 } },
});
const workflowOptions = (overrides = {}) => ({
  positive: 'the final dynamically authored prompt',
  referenceNames: ['uploaded-a.png', 'uploaded-b.png'],
  width: 864,
  height: 480,
  length: 124,
  refImageSize: 'match',
  steps: 20,
  samplerName: 'res_multistep',
  seed: 4242,
  fps: 24,
  itemId: 'hero',
  ...overrides,
});

t('direct H3 prompt injection replaces literal template copy', () => {
  const wf = canonicalGraph();
  applyH3WorkflowContract(wf, workflowOptions());
  assert.equal(wf.h3.inputs.prompt, 'the final dynamically authored prompt');
});
t('simple scheduler is the default for the canonical graph', () => {
  const wf = canonicalGraph();
  applyH3WorkflowContract(wf, workflowOptions());
  assert.equal(wf.scheduler.inputs.scheduler, 'simple');
  assert.equal(wf.scheduler.inputs.steps, 20);
});
t('MiniMaxH3Cache applies every supported override using its intentional resuse_threshold spelling', () => {
  const wf = canonicalGraph();
  applyH3WorkflowContract(wf, workflowOptions({
    cacheThreshold: 0.07,
    cacheStart: 0.2,
    cacheEnd: 0.8,
    cacheMaxSteps: 3,
  }));
  assert.equal(wf.cache.inputs.resuse_threshold, 0.07);
  assert.equal(wf.cache.inputs.start_percent, 0.2);
  assert.equal(wf.cache.inputs.end_percent, 0.8);
  assert.equal(wf.cache.inputs.max_steps, 3);
  assert.equal(wf.cache.inputs.reuse_threshold, undefined);
});
t('disabling MiniMaxH3Cache rewires its consumers and leaves PathchSageAttentionKJ untouched', () => {
  const wf = canonicalGraph();
  const originalPatch = structuredClone(wf.patch);
  applyH3WorkflowContract(wf, workflowOptions({ cacheEnabled: false }));
  assert.equal(wf.cache, undefined);
  assert.deepEqual(wf.preview.inputs.model, ['patch', 0]);
  assert.deepEqual(wf.patch, originalPatch);
});
t('flat reference inputs and dotted reference inputs are removed before dynamic dotted references are injected', () => {
  const wf = canonicalGraph();
  applyH3WorkflowContract(wf, workflowOptions());
  assert.equal(wf.h3.inputs.ref_image_0, undefined);
  assert.equal(wf.h3.inputs['ref_images.ref_image_1'][0], 'h3Ref1');
  assert.deepEqual(wf.h3.inputs['ref_images.ref_image_0'], ['h3Ref0', 0]);
  assert.deepEqual(wf.h3.inputs['ref_images.ref_image_1'], ['h3Ref1', 0]);
});
t('EasyCache compatibility is preserved while sharing the cache controls', () => {
  const wf = canonicalGraph();
  wf.cache.class_type = 'EasyCache';
  wf.cache.inputs = { reuse_threshold: 0.3, start_percent: 0.2, end_percent: 0.9, model: ['patch', 0] };
  applyH3WorkflowContract(wf, workflowOptions({ cacheThreshold: 0.4, cacheStart: 0.25, cacheEnd: 0.85 }));
  assert.equal(wf.cache.inputs.reuse_threshold, 0.4);
  assert.equal(wf.cache.inputs.start_percent, 0.25);
  assert.equal(wf.cache.inputs.end_percent, 0.85);
  assert.deepEqual(wf.cache.inputs.model, ['patch', 0]);
});

console.log(`\n${pass} assertions passed.`);
