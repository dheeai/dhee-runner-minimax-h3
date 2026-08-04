/**
 * repairH3Prose — inject missing (Sx) ids and strip a timestamped [Shot 1].
 *
 * Both defects are things the prompt has demanded in its terminal position through
 * several revisions and deepseek-v4-flash-0731 still gets wrong: 4 of 6 measured
 * outputs contained ZERO (Sx) anywhere while naming the speaker and delivery
 * perfectly. Both are exactly repairable from the prose plus the plan, so they are
 * repaired rather than requested.
 *
 * Run: node tests/repairH3Prose.test.mjs
 */
import assert from 'node:assert/strict';
import { repairH3Prose } from '../dist/officialFormat.js';

let pass = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

console.log('repairH3Prose');

t('injects (Sx) after the nearest <Subject N> — the documented shape', () => {
  const prose = '[Shot 1] <Subject 1> stands still. Meher\'s voice is flat as she says: <d>[English] Again. From the top.</d>';
  const r = repairH3Prose(prose, [{ dialogue: 'Again. From the top.', speaker: 'meher_zaidi' }]);
  assert.match(r.prose, /<Subject 1> \(S1\) stands still/);
  assert.match(r.prose, /<d>\[English\] Again\. From the top\.<\/d>/, 'the line itself is untouched');
  assert.ok(r.notes.some((n) => /injected 1 missing/.test(n)));
});

t('leaves an already-tagged line alone (idempotent)', () => {
  const prose = '[Shot 1] <Subject 2> (S1) says: <d>[English] Hello.</d>';
  const r = repairH3Prose(prose, [{ dialogue: 'Hello.', speaker: 'ira' }]);
  assert.equal(r.prose, prose, 'no change');
  assert.equal(r.notes.length, 0);
});

t('running twice changes nothing the second time', () => {
  const prose = '[Shot 1] <Subject 1> looks up and says: <d>[English] Hello.</d>';
  const once = repairH3Prose(prose, [{ dialogue: 'Hello.', speaker: 'ira' }]).prose;
  const twice = repairH3Prose(once, [{ dialogue: 'Hello.', speaker: 'ira' }]).prose;
  assert.equal(twice, once);
});

t('SAME speaker keeps the SAME id across lines', () => {
  const prose =
    '[Shot 1] <Subject 1> says: <d>[English] First line.</d> ' +
    '[Shot 2] At 00:04.000, <Subject 1> says: <d>[English] Second line.</d>';
  const r = repairH3Prose(prose, [
    { dialogue: 'First line.', speaker: 'ira' },
    { dialogue: 'Second line.', speaker: 'ira' },
  ]);
  const ids = [...r.prose.matchAll(/\(S(\d+)\)/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['1', '1'], 'one speaker, one id');
});

t('DIFFERENT speakers get different ids, numbered in spoken order', () => {
  const prose =
    '[Shot 1] <Subject 1> says: <d>[English] Whenever you are ready.</d> ' +
    '[Shot 2] At 00:04.000, <Subject 2> replies: <d>[English] Thank you.</d>';
  const r = repairH3Prose(prose, [
    { dialogue: 'Whenever you are ready.', speaker: 'meher' },
    { dialogue: 'Thank you.', speaker: 'ira' },
  ]);
  assert.match(r.prose, /<Subject 1> \(S1\)/);
  assert.match(r.prose, /<Subject 2> \(S2\)/);
});

t('an id earlier in the scene does NOT satisfy a later untagged line', () => {
  // The id must be in the clause leading up to ITS OWN tag. Searching the whole
  // preceding text would let one (S1) mask every later missing id.
  const prose =
    '[Shot 1] <Subject 1> (S1) says: <d>[English] First.</d> ' +
    'Then <Subject 2> answers: <d>[English] Second.</d>';
  const r = repairH3Prose(prose, [
    { dialogue: 'First.', speaker: 'a' },
    { dialogue: 'Second.', speaker: 'b' },
  ]);
  assert.match(r.prose, /<Subject 2> \(S2\) answers/, 'second line got its own id');
});

t('no <Subject N> to hang it on — prefixes the tag', () => {
  const prose = '[Shot 1] A voice from the doorway: <d>[English] Ira Kulkarni.</d>';
  const r = repairH3Prose(prose, [{ dialogue: 'Ira Kulkarni.', speaker: 'receptionist' }]);
  assert.match(r.prose, /\(S1\) <d>\[English\] Ira Kulkarni\.<\/d>/);
});

t('strips a cut time from [Shot 1]', () => {
  const prose = '[Shot 1] At 00:00.000, the camera holds a Static Shot. [Shot 2] At 00:04.500, it cuts.';
  const r = repairH3Prose(prose, []);
  assert.match(r.prose, /\[Shot 1\] the camera holds/);
  assert.match(r.prose, /\[Shot 2\] At 00:04\.500/, 'later shots keep theirs');
  assert.ok(r.notes.some((n) => /stripped the cut time/.test(n)));
});

t('leaves a correct [Shot 1] untouched', () => {
  const prose = '[Shot 1] The camera holds a Static Shot. [Shot 2] At 00:04.500, it cuts.';
  const r = repairH3Prose(prose, []);
  assert.equal(r.prose, prose);
});

t('both repairs at once', () => {
  const prose = '[Shot 1] At 00:00.000, <Subject 1> says: <d>[English] Hello.</d>';
  const r = repairH3Prose(prose, [{ dialogue: 'Hello.', speaker: 'ira' }]);
  assert.match(r.prose, /\[Shot 1\] <Subject 1> \(S1\) says/);
  assert.equal(r.notes.length, 2);
});

t('MULTIPLE injections do not corrupt each other (offset safety)', () => {
  // Applying edits front-to-back would shift every later offset. Three tags with
  // no ids is the case that would silently mangle the text.
  const prose =
    '[Shot 1] <Subject 1> says: <d>[English] One.</d> ' +
    '<Subject 2> says: <d>[English] Two.</d> ' +
    '<Subject 3> says: <d>[English] Three.</d>';
  const r = repairH3Prose(prose, [
    { dialogue: 'One.', speaker: 'a' }, { dialogue: 'Two.', speaker: 'b' }, { dialogue: 'Three.', speaker: 'c' },
  ]);
  assert.match(r.prose, /<Subject 1> \(S1\) says: <d>\[English\] One\.<\/d>/);
  assert.match(r.prose, /<Subject 2> \(S2\) says: <d>\[English\] Two\.<\/d>/);
  assert.match(r.prose, /<Subject 3> \(S3\) says: <d>\[English\] Three\.<\/d>/);
  assert.equal((r.prose.match(/<d>/g) || []).length, 3, 'no tag lost or duplicated');
});

t('no dialogue at all — nothing changes, no notes', () => {
  const prose = '[Shot 1] <Subject 1> stands in the rain. The camera holds a Static Shot.';
  const r = repairH3Prose(prose, []);
  assert.equal(r.prose, prose);
  assert.equal(r.notes.length, 0);
});

t('falls back to the <Subject N> as identity when the plan has no speaker', () => {
  const prose = '[Shot 1] <Subject 1> says: <d>[English] A.</d> <Subject 1> says: <d>[English] B.</d>';
  const r = repairH3Prose(prose, [{ dialogue: 'A.' }, { dialogue: 'B.' }]);
  const ids = [...r.prose.matchAll(/\(S(\d+)\)/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['1', '1'], 'same <Subject N> means same voice');
});

t('inserts a missing [Shot N] on a cut the prose already timed', () => {
  const prose = '[Shot 1] She sits still, the hum the only noise. At 00:04.000, the shot cuts to a wide of the room.';
  const r = repairH3Prose(prose, []);
  assert.match(r.prose, /\[Shot 2\] At 00:04\.000, the shot cuts to/, 'marker inserted before the cut time');
  assert.match(r.prose, /^\[Shot 1\] She sits still/, '[Shot 1] untouched');
  assert.ok(r.notes.some((n) => /inserted 1 missing \[Shot N\]/.test(n)));
});

t('numbers multiple unmarked cuts in text order', () => {
  const prose = '[Shot 1] A. At 00:03.000, the camera cuts to B. At 00:06.000, the shot transitions to C.';
  const r = repairH3Prose(prose, []);
  assert.match(r.prose, /\[Shot 2\] At 00:03\.000/);
  assert.match(r.prose, /\[Shot 3\] At 00:06\.000/);
});

t('does NOT double-mark a cut that already has its marker', () => {
  const prose = '[Shot 1] A. [Shot 2] At 00:04.000, the shot cuts to B.';
  const r = repairH3Prose(prose, []);
  assert.equal(r.prose, prose);
  assert.equal(r.notes.length, 0);
});

t('ignores a bare time that is not a cut', () => {
  const prose = '[Shot 1] The clock on the wall reads At 10:30.000 in faded paint. Static Shot throughout.';
  const r = repairH3Prose(prose, []);
  assert.equal(r.prose, prose, 'no cut verb follows, so no marker invented');
});
console.log(`\n${pass} passed${process.exitCode ? ' — WITH FAILURES' : ''}`);
