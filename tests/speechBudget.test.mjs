/**
 * Clip length must hold the words that are actually spoken.
 *
 * Reported from a real film: an 11-word line in a 6.58s clip had its last words
 * cut off — sound running continuously to the final frame with no trailing
 * silence, which is the truncation signature the bundle documents. Three causes
 * compounded, and each is covered here.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { speechSecondsFor, WORDS_PER_SEC, TAIL_MARGIN_SEC } from '../dist/index.js';

const MERGED = ['Give it here, Vashti. The Rift has a claim on it.'];
const SPLIT = ['Give it here, Vashti.', 'The Rift has a claim on it.'];

test('two utterances cost the same whether merged into one line or split', () => {
  // CAUSE 1: the pause between sentences is spoken either way, but was only
  // charged when they happened to be separate array entries.
  assert.equal(speechSecondsFor(MERGED).toFixed(2), speechSecondsFor(SPLIT).toFixed(2));
});

test('the estimate leaves room after the last word', () => {
  // CAUSE 2: the fixed overhead covered lead-in AND tail together, and lead-in
  // alone was measured at 0.40-1.33s — leaving the tail at zero.
  const words = 11;
  assert.ok(speechSecondsFor(MERGED) >= words / WORDS_PER_SEC + TAIL_MARGIN_SEC);
});

test("the author's estimate raises the floor but can never lower it", () => {
  // CAUSE 3: 2.8 words/sec is a best case; a "slow pace, gravelly" voice runs
  // well under it, and only the author knows that.
  const base = speechSecondsFor(MERGED);
  assert.ok(speechSecondsFor(MERGED, 6.0) > base, 'a longer estimate wins');
  assert.equal(speechSecondsFor(MERGED, 0.5), base, 'a shorter one is ignored');
  assert.equal(speechSecondsFor(MERGED, 0), base);
  assert.equal(speechSecondsFor(MERGED, undefined), base);
  assert.equal(speechSecondsFor(MERGED, Number.NaN), base);
});

test('the reported failure would now be caught', () => {
  // 11 words in a 6.58s clip: the old estimate said 4.93s and let it through.
  assert.ok(speechSecondsFor(MERGED) > 4.93, 'old estimate was 4.93s');
  // and with a slow voice the author can push it past the clip, forcing a longer one
  assert.ok(speechSecondsFor(MERGED, 6.2) > 6.58);
});

test('silence costs nothing', () => {
  assert.equal(speechSecondsFor([]), 0 + speechSecondsFor([]));
  assert.ok(speechSecondsFor(['']) < speechSecondsFor(['One word.']));
});

test('non-Latin script is tokenised by whitespace like everything else', () => {
  const hindi = ['यह पंक्ति कहाँ है? मुझे दिखाई नहीं दे रही।'];
  assert.ok(speechSecondsFor(hindi) > TAIL_MARGIN_SEC);
});
