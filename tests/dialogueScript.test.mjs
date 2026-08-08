/**
 * auditDialogueScript — flag a <d>[Language] words</d> tag whose words are
 * romanized Latin transcription of a non-Latin-scripted language.
 *
 * Measured: the SAME Hindi line written as romanized Latin
 * ("Aap kya padh rahi hain? Mujhe Delhi jaana hai.") got English phonetics
 * applied to tokens Latin cannot spell (padh, Delhi), where the identical line
 * in Devanagari was pronounced correctly, same seed, same everything else.
 *
 * Run: node tests/dialogueScript.test.mjs
 */
import assert from 'node:assert/strict';
import { auditDialogueScript } from '../dist/officialFormat.js';

let pass = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

console.log('auditDialogueScript');

t('romanized Hindi is flagged', () => {
  const prose = '[Shot 1] <Subject 1> (S1) says: <d>[Hindi] Aap kya padh rahi hain? Mujhe Delhi jaana hai.</d>';
  const r = auditDialogueScript(prose);
  assert.equal(r.length, 1);
  assert.match(r[0], /Hindi/);
  assert.match(r[0], /Aap kya padh rahi hain\?/);
});

t('Devanagari Hindi is clean', () => {
  const prose = '[Shot 1] <Subject 1> (S1) says: <d>[Hindi] आप क्या पढ़ रही हैं? मुझे दिल्ली जाना है।</d>';
  const r = auditDialogueScript(prose);
  assert.deepEqual(r, []);
});

t('romanized Kannada is flagged', () => {
  const prose = '[Shot 1] <Subject 1> (S1) says: <d>[Kannada] Neenu hegiddiya?</d>';
  const r = auditDialogueScript(prose);
  assert.equal(r.length, 1);
  assert.match(r[0], /Kannada/);
});

t('native Kannada is clean', () => {
  const prose = '[Shot 1] <Subject 1> (S1) says: <d>[Kannada] ನೀನು ಹೇಗಿದ್ದೀಯಾ?</d>';
  const r = auditDialogueScript(prose);
  assert.deepEqual(r, []);
});

t('English is never flagged', () => {
  const prose = '[Shot 1] <Subject 1> (S1) says: <d>[English] Whenever you are ready.</d>';
  const r = auditDialogueScript(prose);
  assert.deepEqual(r, []);
});

t('an unrecognised / Latin-scripted language (Spanish) is never flagged', () => {
  const prose = '[Shot 1] <Subject 1> (S1) says: <d>[Spanish] Buenos dias, como estas?</d>';
  const r = auditDialogueScript(prose);
  assert.deepEqual(r, []);
});

t('a Hindi line embedding Latin proper nouns is clean (false-positive guard)', () => {
  const prose = '[Shot 1] <Subject 1> (S1) says: <d>[Hindi] मुझे Delhi जाना है।</d>';
  const r = auditDialogueScript(prose);
  assert.deepEqual(r, [], 'one Devanagari character is enough to prove this is not a romanized line');
});

t('multiple <d> tags, only one romanized, reports exactly one finding', () => {
  const prose =
    '[Shot 1] <Subject 1> (S1) says: <d>[Hindi] आप क्या पढ़ रही हैं?</d> ' +
    '[Shot 2] At 00:04.000, <Subject 2> (S2) says: <d>[Hindi] Mujhe Delhi jaana hai.</d>';
  const r = auditDialogueScript(prose);
  assert.equal(r.length, 1);
  assert.match(r[0], /Mujhe Delhi jaana hai\./);
});

t('no <d> tags at all returns []', () => {
  const prose = '[Shot 1] <Subject 1> stands in the rain. The camera holds a Static Shot.';
  const r = auditDialogueScript(prose);
  assert.deepEqual(r, []);
});

t('language matching is case-insensitive: [hindi]', () => {
  const prose = '[Shot 1] <Subject 1> (S1) says: <d>[hindi] Aap kya padh rahi hain?</d>';
  const r = auditDialogueScript(prose);
  assert.equal(r.length, 1);
});

t('language matching is case-insensitive: [HINDI]', () => {
  const prose = '[Shot 1] <Subject 1> (S1) says: <d>[HINDI] Aap kya padh rahi hain?</d>';
  const r = auditDialogueScript(prose);
  assert.equal(r.length, 1);
});

console.log(`\n${pass} passed${process.exitCode ? ' — WITH FAILURES' : ''}`);
