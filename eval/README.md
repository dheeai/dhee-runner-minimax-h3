# `illustrated_story_h3` · scene_video_prompt contract review + measured eval

> **This is the H3 scene-JSON VERIFIER, kept here so it can't be lost.** It was
> written in `dhee-cofounder/artifacts/h3-scene-schema-eval/` and moved into the
> runner repo because it imports this runner's own compiler and audits —
> mirroring `dhee-runner-remotion/eval/`. It grades a model's scene JSON with
> **no GPU and no render**: ajv → `compileStructuredScenePrompt` (hard gate) →
> the runner's audits → 15 severity-tagged guide checks in `guideChecks()`.
> That makes it a candidate programmatic reward for RL (GRPO) on a small local
> author model — see `dhee-cofounder/memory/h3-verifier-as-grpo-reward.md` for
> what has to be fixed first (context-wiring bug, hackable phrase-presence
> checks, per-check variance baseline).
>
> Setup changed with the move — `h3dist` now points at this repo's own build:
> ```
> ln -sfn ../dist h3dist
> ln -sfn ~/Projects/dhee-core/node_modules node_modules   # ajv
> ```
> The `Reproduce` section below is otherwise unchanged.

Reviewed the uncommitted structured rewrite of `scene_video_prompt` (prompt +
schema) in `~/.kshana/bundles/illustrated_story_h3`, checked it against the
verbatim official MiniMax H3 guides, then measured it by running the real
contract through `deepseek/deepseek-v4-flash` on five scenarios.

Date: 2026-08-08. Model: `deepseek/deepseek-v4-flash` via OpenRouter
(founder-authorised for this task). Grading is mechanical, not vibes: every
output is compiled through the **real runner**
(`dhee-runner-minimax-h3/dist/officialFormat.js` →
`compileStructuredScenePrompt` with `strictPerformance: true` and the section's
`expectedReferenceIds`) and then put through the runner's own audits
(`auditDetailedDescription`, `auditDialogueIntegrity`, `auditDialogueScript`,
`repairH3Prose`) plus guide checks the runner does not make.

## What is under review

The rewrite is **uncommitted WIP**. HEAD is v0.17.0; the working tree changes
`prompts/scene_video_prompt.md` (705 → 194 lines) and
`schemas/scene_video_prompt.schema.json` (+344 lines). It is an architecture
change, not a tweak:

| | HEAD (v0.17.0) | working tree |
|---|---|---|
| who writes the H3 prose | the model, directly | the runner, compiled from typed fields |
| prose floor | `detailedDescription.minLength: 1940` (≈500 words) | **none** |
| root fields | 9 | 12, incl. `shots[]`, `performance`, `negatives` |

The direction is right — every structural gate this bundle has added held,
while every prose rule drifted, which is the codebase's own documented
finding. But the rewrite dropped the one thing that was enforcing the guide's
350–500 word body, and introduced several new gaps.

## Reproduce

```
ln -sfn ~/.kshana/runners/dhee-runner-minimax-h3/dist h3dist   # the real compiler
ln -sfn ~/Projects/dhee-core/node_modules node_modules         # ajv
node fix.mjs                        # writes patched/ (schema + prompt)
node run.mjs asis                   # the bundle exactly as it stands
node run.mjs ctx                    # + the six declared context inputs
H3_ARM=fix node run.mjs fix         # + the recommended patch set
```

`scenarios.mjs` carries five sections of a synthetic `scenes_plan` plus the
full context the node declares. They were chosen to hit what can actually
break, not to be representative:

| | scenario | what it tests |
|---|---|---|
| A | two-hander, Hindi native script, multi-cut, 8s | `auditDialogueScript`; two voices across a cut |
| B | genuinely silent beat, `spokenLines: []`, 6s | the speech-verb trap; `voiceProfiles: []` |
| C | 3 characters + 2 objects + location + a state plate, 10.13s | reference crowding; acting for three at once |
| D | single continuous take, English voiceover, 7s | `continuous_moving`; voiceover phrasing |
| E | 15.08s, four cuts, one line crossing a cut | timecode discipline at the ceiling; `<scenetrans>` |

## Result 1 — the node's declared context never reaches the model

`prompts/scene_video_prompt.md` is the **only** prompt in this bundle that
interpolates none of its declared inputs. It names `{{item_id}}` and nothing
else, while the node declares six: `scenes_plan`, `story_bible`,
`character_state`, `character_acting_profile`, `art_style`, `narration`.

`llm.generate` sends **only the rendered template** — `substituteTemplate()`
resolves `{{var}}` against `ctx.inputs` and there is no auto-append of unused
inputs. So the model is instructed to "locate the current collection item
`{{item_id}}` in `scenes_plan.sections[]`" against a plan it was never shown,
and to copy `voicePrompt` verbatim from profiles it was never shown.

This is a regression introduced by the rewrite. Every earlier commit of this
file interpolated all six:

```
d29e7a5 2026-08-04 :: {{art_style}} {{character_state}} {{item_id}} {{narration}} {{scenes_plan}} {{story_bible}}
…all 8 commits identical…
working tree ::  {{item_id}}
```

Measured (`asis` arm, 5/5 scenarios): the model invents an entire film.

| scenario | what it authored |
|---|---|
| A | `references: [character, location]` — the literal type words as ids |
| B | a watchtower interior, `references: [S1, watchtower_interior]` |
| C | `references: [placeholder_error]`, `objective: "N/A"`, `obstacle: "Missing input"` |
| D | `character_01` alone in "an empty, featureless space" |
| E | "Kaelen Stanton" opening a utility knife in a `hyperloop_tunnel_contellation` |

4/5 were rejected by the render node's reference gate. The one that got
through produced a **61-word** description whose summary reads: *"A scene with
no defined subjects or spoken lines cannot be authored without the scene plan
entities, character profiles, and spoken lines."* The model diagnosed the bug
in its own output.

This is the unfixed remainder of **issue #5**. That issue diagnosed the
missing `{{item_id}}` token, which has since been added; the six missing
context interpolations — the dominant part — are still open, and they explain
#5's own evidence (`traveler`/`cliff`, `lab_room`, four byte-identical scenes)
exactly.

## Result 2 — `acting` is optional in the schema and mandatory in the runner

With context supplied (`ctx` arm), id discipline becomes perfect: 5/5 use only
allowlisted ids, lines are verbatim, `voicePrompt` copies are exact, Devanagari
survives, speaker ids are stable. The schema's core contract works.

But **4/5 still die at the render node**:

```
scene_07_sec_2  shots[0].acting is required for character subject(s): meher
scene_11_sec_1  shots[0].acting is required for character subject(s): dhruv
scene_02_sec_1  shots[0].acting is required for character subject(s): lira
scene_19_sec_3  shots[0].acting is required for character subject(s): meher
```

`shots[].acting` is **not** in the schema's `required` list, and its
description says "Environment-only shots may omit this field." But
`validateStructuredScenePerformance()` requires one entry per character
subject, and `bundle.json` sets `strictPerformance: true`, so it is always on.

The cost is not one node retrying. The gate lives in `comfy.minimax_h3_r2v`
(the `scene_clip` node), so:

1. the JSON is schema-valid → `llm.generate` writes the file and moves on;
2. its 3-attempt retry loop never sees the problem, because JSON Schema is the
   only thing it validates against;
3. the failure surfaces at `scene_clip`, after every anchor plate, state plate
   and screenplay node has already run.

Scenario B shows the model *knows* the field — it emitted `acting` on shot 1
and omitted it on shot 0. It is not ignorance, it is an unenforced rule, and
this bundle's own history says unenforced rules drift.

## Result 3 — 65% of what H3 reads is not renderable, and no style reaches it

The one scenario that compiled cleanly (A) is in
`out/compiled_scene_04.txt`. Word split of its `detailed_description`:

| | words | |
|---|---|---|
| `Performance objective / Obstacle / Stakes / …` block | 121 | before `[Shot 1]` |
| `<Subject N> Acting:` blocks | 118 | |
| `Voice identity for <Subject N>:` | 68 | |
| continuation anchor + negatives trailer | 92 | after the last shot |
| **non-visual metadata** | **399 (65%)** | |
| **actual shot description** | **214 (35%)** | ← what the guide budgets 350–500 for |

`auditDetailedDescription` sees 613 words and stays quiet. The visual body is
214 — right at the "measured outputs land near 200 and that is too thin" mark.
**The 1940-char floor that HEAD used to enforce is gone, and the label overhead
now hides its absence.** This is the single most consequential regression in
the rewrite.

Two guide violations compound it:

- **No style opening.** Ref guide 5.2: full-reference mode establishes style in
  one or two sentences *before* `[Shot 1]`. There is no `style` field anywhere
  in the schema, so that slot instead holds `Performance objective: … Obstacle:
  … Stakes: …`. `art_style` is a declared input of this node and the entire
  gouache / desaturated-palette / no-cel-shading specification reaches H3
  **not at all**.
- **The performance block is not filmable.** `objective`, `obstacle`, `stakes`,
  `subtext` are by construction not visible or audible, against the guide's
  "every detail should correspond to something visible or audible." They occupy
  the highest-leverage position in the prompt and displace the thing the guide
  puts there.

## Result 4 — runner sentence frames fight the schema's field descriptions

`buildSubjectSections()` writes `<Subject N> is ${appearsAs} in <Picture N>.`
and `Follow it for ${job}.`, but the schema describes `job` as "What this
reference must control … written as a concrete visual job", so the model writes
a verb phrase. Measured on scenario A: **24 double-periods, 3 broken `is
<Capital>` frames, 4 `Follow it for Controls…`**:

```
<Subject 1> is Tall, straight-backed woman in her sixties, … at arm's length. in <Picture 1>. Follow it for Controls Meher's posture, … toward the light..
```

Both runner-owned sections are ungrammatical for every reference in every
scene. Neither field says "lower-case noun phrase, no trailing period."

## Result 5 — smaller guide gaps, each confirmed by probe

| # | gap | evidence |
|---|---|---|
| 1 | camera emitted as a stacked label — `Camera: Static Shot.` — which base guide 4.3 explicitly forbids ("not stacked as separate labels at the end of a sentence") | 2/2 shots in A |
| 2 | amplitude and speed (`with small amplitude`, `at slow speed`) are unrepresentable: the schema has one enum where the guide has three dimensions. Both shots in A fell back to `Static Shot` in an 8s two-hander | 0 occurrences across all arms |
| 3 | `retention_analysis` omits the guide's `(appears in [Shot 1], [Shot 3])` clause though `shots[].subjectIds` has the data | all scenarios |
| 4 | `transition` is optional, so the runner's fallback `the shot cuts to a new view.` fires — a cut that reveals nothing, against "a cut should introduce new information" | A shot 2 |
| 5 | `<scenetrans>` / `<cutoff>` have no field, so a line crossing a cut cannot be marked | E, by construction |
| 6 | compound speaker id rejected — `speakerId` is `/^S\d+$/`, but guide 4.4 allows `(S1,S2)` for group speech | probe: `speakerId must look like S1` |
| 7 | voiceover has no representation: the compiler always writes `says ${delivery}:`, so the guide's required exact phrase `says in an off-screen voiceover` plus the lips-closed follow-up cannot be emitted | D |
| 8 | timeline holes and trailing time are legal: the validator only checks `startTime >= previousEnd`, never coverage | probe: shots at 0–2 and 6–9 of a 15.08s render accepted — 4.0s hole + 6.08s trailing, both undirected |
| 9 | `duration` is not constrained to H3's `17k+5` frame grid, and `snapH3Frames` silently rounds up — so authored timecodes drift from the rendered length, which v0.12.0 deliberately pinned `maxClipSec` to prevent | probe: 5s→124f, 11.11s→271f accepted |
| 10 | `duration.minimum: 5` is below H3's trained floor of 5.17s (124f) | probe |
| 11 | task-type prefix is a soft example ("such as `[reference generation]`") not the guide's closed set of six; for this graph it is always deterministically `[reference generation]` and is therefore runner-ownable | schema has no enum/pattern |

## What holds up well

- The typed-IR direction. `spokenLines` → per-shot `dialogue.exactWords` exact
  matching, the `speakerId`-cannot-change-subject rule, and the
  `expectedReferenceIds` allowlist are all structural, and all held.
- Native-script dialogue: 0 `auditDialogueScript` findings; Devanagari survived
  the whole round trip in A and C.
- Voice identity: `voiceProfiles` copied verbatim and emitted once before the
  subject's first line, exactly as guide 4.4 wants.
- `repairH3Prose` never had to fire — the compiled path cannot produce a
  missing `(Sx)` or a timestamped `[Shot 1]`, which is the structural fix
  working as designed.
- Negatives came out phrased as absences ("No extra people on stage") rather
  than a bare noun list, so the "H3 has no negative conditioning" risk did not
  materialise on this model.

## Result 6 — regex `pattern` constraints are the WRONG fix, measured

The first patch attempt added `pattern` constraints to force the phrasing the
runner's sentence frames need (`^[^A-Z].*[^.]$` on `appearsAs`/`job`, a cut-verb
pattern on `transition`). It backfired badly. Completion tokens per call:

| arm | prompt tokens | completion tokens | attempts |
|---|---|---|---|
| `ctx` (no patterns) | 5.3–7.5k | **1.1–4.1k** | 1/1 every scenario |
| `fix` (with patterns) | ~14k | **15–20k, hitting `max_tokens`** | up to 3, 3/5 never validated |

A 5–10× blow-up, and then a cascade: the model burns its budget reasoning about
the regex, gets truncated at `maxTokens: 20000`, fails validation, and
`llm.generate`'s conversational retry appends the whole 20k draft — so the
request doubles each round (27,964 → 46,335 → 69,226 total tokens on one
scenario) until OpenRouter drops the connection. This is exactly the failure the
bundle's own `_comment_own_shots_only` already documents: *"the conversational
retry is only free when the failed draft fits the remaining context."*

**So do not constrain the phrasing.** `appearsAs`/`job` capitalisation and
trailing periods are purely mechanical — lower-case the first character and
strip a trailing period **in the runner**, where it costs nothing. That is the
same reasoning `repairH3Prose` is built on.

## Result 7 — confirmation run (`fix2`): acting-required works; three new findings

Re-ran with the patterns dropped, keeping `acting` required + the `style` field.
Compile rate went **1/5 → 4/5**, and token use returned to normal (1 attempt for
3 of 5). The acting fix is confirmed.

The one remaining failure was a *content* error, not a contract one, and it is a
new instance of issue #3: in scenario D — Lira alone in the green room — the
model attributed Lira's voiceover line to `meher`, who is not in that section's
entities at all (`shots[0].dialogue[0].subjectId "meher" is unknown; expected
IDs: lira, script_bundle, green_room`). Cross-section leakage from the shared
`scenes_plan` survives even with correct context, so #3 is not fully closed by
fixing #5.

Three findings only this arm surfaced:

1. **`transition` grammar is a live defect, not a hypothetical.** Fired 3× — the
   model writes `Cut reveals Lira's readiness…`, so the compiled marker reads
   `At 00:03.500, Cut reveals Lira's readiness…`: capitalised mid-sentence and
   not one of the guide's documented cut phrases. Since a `pattern` is too
   expensive (Result 6), the runner should own this — emit `the shot cuts to`
   itself and append the authored transition as the reveal clause.
2. **The negatives risk is real, and run-to-run variable.** In the `ctx` arm
   deepseek phrased negatives as absences ("No extra people on stage"); in this
   arm it regressed to bare nouns — `Subtitles`, 5/5 on one scenario and 3/5 on
   another — dropped verbatim into positive prose in a graph with no negative
   conditioning. Earlier I recorded this as "did not materialise"; that was true
   of one arm only. It should be normalised into absence phrasing by the runner.
3. **The word count is uncontrolled in BOTH directions**, not merely low. Same
   contract, same model: 214 visual words on one scenario and 806 / 898 total on
   two others (`auditDetailedDescription` flagged the fat ones and stayed silent
   on the thin one, because it counts the metadata). There is no floor and no
   ceiling on the part that matters.

Quantified drift for finding #9, via `snapH3Frames`:

```
authored  5.00s -> 124f =  5.17s   drift +0.17s
authored  6.00s -> 158f =  6.58s   drift +0.58s
authored  7.00s -> 175f =  7.29s   drift +0.29s
authored  8.00s -> 192f =  8.00s   drift  0.00s
authored 11.11s -> 277f = 11.54s   drift +0.43s
authored 15.08s -> 362f = 15.08s   drift  0.00s
```

Both durations the model actually chose off-grid (6s, 7s) drift by 0.29–0.58s
against timecodes it authored believing the clip was shorter.

## Result 8 — three models, same contract

Re-ran the whole eval on two LOCAL models on the 5090 (`run_local.sh <slug>`).
`qwen-35b` matters most: the bundle's own comments record this node being
authored on it.

| model | arm | compiled | attempts | sum of call time | med prompt tok | med completion tok |
|---|---|---|---|---|---|---|
| deepseek-v4-flash | `asis` | 1/5 | 5 | 311 s | 2,217 | 939 |
| deepseek-v4-flash | `fix` (regex) | 2/5 | 10 | **2,604 s** | 10,704 | **20,000 (capped)** |
| deepseek-v4-flash | `fix2` | 4/5 | 8 | 629 s | 8,846 | 2,839 |
| thinkingcap-27b | `asis` | 3/5 | 5 | 50 s | 2,262 | 654 |
| thinkingcap-27b | `ctx` | 1/5 | 5 | 90 s | 5,532 | 1,453 |
| thinkingcap-27b | `fix2` | **5/5** | 5 | 117 s | 8,061 | 1,809 |
| qwen-35b | `asis` | 0/5 | 5 | 110 s | 2,262 | 1,601 |
| qwen-35b | `ctx` | 2/5 | 5 | 59 s | 5,532 | 1,714 |
| qwen-35b | `fix2` | 4/5 | 5 | 74 s | 8,061 | 1,854 |

Wall-clock for all three arms: **thinkingcap 2 m 27 s, qwen-35b 2 m 15 s,
deepseek-v4-flash ~59 min.** Local is ~25× faster end-to-end, and neither local
model needed a single retry in any arm.

Content fidelity on the `fix2` arm (ids in the section allowlist / spokenLines
verbatim / voicePrompt verbatim): thinkingcap 5/5 on all three, qwen 5/5 on all
three (its one rejection was an incomplete `acting` array, not a content error),
deepseek 4/5 (scenario D attributed Lira's line to `meher`).

**Every structural finding reproduced on all three models** — missing `acting`
in the `ctx` arm, no style opening, camera-as-label, no amplitude/speed,
`retention_analysis` without shot lists, no `<scenetrans>`, no voiceover phrase,
off-grid durations. That is the point of the exercise: these are properties of
the contract, not of a model.

### Two new failure modes only qwen-35b surfaced

Both are the **same class as the `acting` bug** — a rule the runner enforces
that JSON Schema structurally cannot:

1. **`ctx`/E:** `performance.voiceProfiles[1].subjectId "lira" is not a dialogue
   subject`. The runner requires voice profiles for *exactly* the dialogue
   subjects; qwen added one for a character who is visible but silent in that
   section. The schema can only say "an array of {subjectId, voicePrompt}".
2. **`fix2`/C:** `shots[2].acting is missing character subject(s): lira`. The
   `acting` array was *present* (so `required` + `minItems: 1` was satisfied)
   but covered only one of the shot's two characters.

**This refines the recommendation.** Making `acting` required catches the
dominant case — absent entirely, which was 4/5 on both deepseek and thinkingcap
— but cannot catch present-but-incomplete, because the real constraint ("one
entry per character in `subjectIds`", where character-ness lives in
`references[]`) is cross-field and outside JSON Schema's reach.

So the residual needs a structural answer, not a stricter schema. The cleanest
is to **remove the redundancy that lets the two fields disagree**: today a shot
declares its characters twice, in `subjectIds` and again in `acting[].subjectId`.
Derive one from the other — let `acting` be the authority for characters and
`subjectIds` carry only objects/locations — and "incomplete acting" stops being
representable at all. Same for `voiceProfiles`, which can be derived from the
shots' dialogue rather than authored alongside it.

## Result 9 — the `acting` fix APPLIED to the bundle, and what it did

Applied to the real bundle: `acting` added to `shots[].items.required` (no
`minItems` — see below), description rewritten, prompt updated with a countable
check. Re-ran the `ctx` arm against the live bundle files:

| model | before | after |
|---|---|---|
| thinkingcap-27b | 1/5 | **5/5**, all first attempt |
| qwen-35b | 2/5 | 3/5 |

**`minItems: 1` would have deadlocked.** The eval's own `fix.mjs` used it and
looked fine, because all 15 shots across the 5 scenarios contained a character.
But the runner rejects any `acting` entry whose subject is not a `character`
present in that shot, so an environment-only shot could satisfy neither the
schema nor the runner — no legal value exists. The bundle therefore gets
`required` WITHOUT `minItems`, and such a shot writes `"acting": []`. Caught by
reading the validator while applying the fix; **the eval did not catch it.**

### The fix introduced a new failure mode on qwen-35b

```
ctx/scene_04  shots[0].acting[1].subjectId "script_bundle" is not a character reference
```

Forced to emit `acting` on every shot, qwen filled it with an OBJECT. It had
previously just omitted the field. So the fix did not remove the defect on this
model, it **moved** it — from "absent" to "present but wrong". Both the schema
description and the prompt state twice that only characters get entries, and it
happened anyway, which is this bundle's own documented pattern: prose rules
drift, structural ones hold.

Net: clearly positive on thinkingcap, marginal on qwen, and it strengthens
rather than weakens the structural recommendation on issue #6 — the root problem
is that a shot declares its characters twice (`subjectIds` and
`acting[].subjectId`) with nothing keeping them in agreement. Until that
redundancy is removed, every schema-level patch just relocates the failure.

Minor, spotted in the same run: the runner's error message says "expected
character IDs from:" and then lists the whole allowlist including objects and
locations.

## Result 10 — the STRUCTURAL change, applied and measured

`acting[]` is now the shot's cast list (a character is in the shot iff they have
an entry) and `sceneryIds[]` carries objects and locations; `subjectIds` is
derived by the runner. `performance.voiceProfiles` is gone — `voicePrompt` rides
on the dialogue line. A new `offScreen` flag marks a speaker who is heard but
not seen.

| failure mode | before | after |
|---|---|---|
| character in shot, no acting entry | rejected at render (4/5 on 2 models) | **unrepresentable** |
| acting entry for a subject not in the shot | rejected at render | **unrepresentable** |
| voiceProfile for a silent character | rejected at render (qwen) | **unrepresentable** |
| voiceProfile missing for a speaker | rejected at render (qwen) | **unrepresentable** |
| acting entry naming an object | rejected at render (qwen) | still checked, now single-field |

`ctx` arm against the live bundle + rebuilt runner:

| model | original | after `required` | after structural |
|---|---|---|---|
| thinkingcap-27b | 1/5 | 5/5 | **5/5** |
| qwen-35b | 2/5 | 3/5 | **3/5** |

All 24 pre-existing runner tests pass unchanged (legacy `subjectIds` +
`voiceProfiles` documents still compile byte-identically), plus 14 new tests.

### Writing the tests found a hole that would have shipped

Once `acting` decides who is on screen, dropping an entry does not error — the
speaker simply becomes invisible, which renders as an off-screen voice. A
legitimate state, but it meant a FORGOTTEN entry would silently become a
voiceover instead of failing: a safety property the old shape had. Closed with
`offScreen`, which a speaker lacking an acting entry must set. As a side effect
this fixes review finding #7 — the runner now emits the guide's required exact
phrase `says in an off-screen voiceover`, plus the lips-remain-closed clause
when the speaker is visible but not speaking on camera. Neither was expressible
before.

### One regression, and one pre-existing gap surfacing

qwen's two remaining failures are a different class from before — no acting or
voiceProfile error survives on any model — but one of them is new:

- **`scene_02` (regression, caused by this change):** qwen dropped the
  `dialogue` array entirely while keeping the line in `spokenLines`. `dialogue`
  is optional per shot, and making `voicePrompt` required *inside* a dialogue
  object raised the cost of including one, so the model took the cheaper path.
  This scenario compiled before. n=1, on one model, and the runner catches it
  loudly with the exact line quoted — but it is a real consequence of requiring
  `voicePrompt` per line. If it recurs, relax the schema to not require
  `voicePrompt` and let the runner's existing "at least one line per speaker"
  check carry it.
- **`scene_19` (pre-existing, now visible):** qwen put a TRUNCATED copy of the
  same line in two consecutive shots — an attempt to express a line spanning a
  cut. That is exactly what `<scenetrans>` is for, and it is still
  unrepresentable (review finding #5). The scenario failed before too, for an
  unrelated reason, so the gap was merely hidden.

## Result 11 — the END-TO-END run, and why it mattered

Project `ember_wright` ("The Last Ember-Wright"), 4 sections × 8s = 32s, native
1344×768, both LLM tiers pinned to `thinkingcap-27b` on the 5090. Contract-level
work had validated the schema against three models; **actually running the
pipeline found three bugs in one attempt**, two of which were already written
down in this very document and not acted on.

### 1. GBNF blocker — hard-fails EVERY local run (new, issue #8)

`character_acting_profile.schema.json` carried
`"pattern": "^(?:\\S+\\s+){149,219}\\S+$"`. llama.cpp compiles
`response_format:json_schema` to a GBNF grammar and its converter rejects regex
shorthand classes, so every local run died at that node with
`400 Failed to initialize samplers: failed to parse grammar` — after the whole
planning phase had run.

Bisected against the live gateway: `\d`, `\w`, `\S`, `\s` all FAIL; `[^ ]`,
`[A-Za-z]`, `[^A-Z].*[^.]` all OK; `^(?:a){149,219}b$` OK. So it is the
shorthand class specifically, not the non-capturing group, the anchors, or the
large bound. Fixed by dropping the pattern (`minLength`/`maxLength` already
bound the field). Scanned every `pattern` in every bundle — this was the only
instance.

The nasty part: it is **invisible on OpenRouter**, whose structured-output path
accepts the pattern. A schema can be authored and tested remotely and then brick
every local run, against a standing LOCAL-FIRST default.

### 2. Issue #5, confirmed in production

The missing context interpolations produced a completely different film:
`library_interior`, `dust_motes`, `cliff_edge`, `storm_clouds`, `traveler`,
`cliff` — the last two being the exact example ids the prompt warns against
inventing. Fixed by interpolating the six declared inputs.

**This document had already diagnosed it, filed measured evidence on it, and
called it "the blocker" — and the pipeline was then run without fixing it.** The
eval predicted this exact output and a render cycle was spent re-learning it.

### 3. Issue #3, confirmed live and fixed structurally

With context supplied, `scene_1` — allowlist `vashti_oru, the_rift_forge,
the_last_ember` — authored `the_courier` and `iron_lantern` and claimed ALL
THREE of the film's spoken lines, duplicating scenes 2 and 3. Authored durations
inflated to 44.6s against a 32s plan. The render-side reference gate caught it
before any GPU time was spent.

Fixed the same way as the acting redundancy: not by asking harder, but by
removing what made it possible. `scene_detail` is now wired `scope: "matching"`
and the prompt interpolates ONLY that fragment — the whole `scenes_plan` is no
longer visible to the model, so cross-section leakage is not a thing it can
express. `duration` is pinned to the sum of the section's own planned shot
durations, now readable from the scoped fragment. `scenes_plan` stays declared
because it is the `itemSource` the walker fans out over.

Result after the fix, all four sections:

```
scene_1  8.00s/8s  refs=3  leak=none  lines=0/0
scene_2  8.00s/8s  refs=5  leak=none  lines=2/2
scene_3  8.00s/8s  refs=5  leak=none  lines=1/1
scene_4  8.00s/8s  refs=5  leak=none  lines=0/0
TOTAL 32.0s   ALL CLEAN
```

Zero leaked references, every duration exactly on budget and on the H3 frame
grid, every planned line owned by exactly one scene, `voicePrompt` on every
line — the structural change working on real data.

### The lesson

The three-model eval bought a correct contract and a fast regression harness.
It could not have found any of these three, because all three live in the wiring
between nodes rather than in the schema: a grammar-compilation failure, a
template that omits its inputs, and a scoping decision. **Contract-level
confidence is not pipeline-level confidence**, and the cheapest way to learn
that was to run the thing.

## Recommended patch set

Bundle layer:
1. interpolate the six declared context inputs — **the blocker** (issue #5)
2. `shots[].acting` → `required`, `minItems: 1` (issue #6). This is the one
   patch confirmed to work: it moves the failure from the render node, where the
   retry loop cannot see it, to the authoring node, where the loop repairs it —
   observed doing exactly that on scenario A, attempt 2 → 3.
3. new required `style` field for the pre-`[Shot 1]` opening (issue #7)
4. `transition` → required after the first shot, by **description only**, no
   `pattern` (see Result 6)
5. `duration` → `enum` of the 22 legal grid values (cheap; a closed enum costs
   nothing to satisfy, unlike a regex over free text)
6. restore a floor on the visual body — `minLength` on `composition` + `action`,
   since the old `detailedDescription.minLength` no longer exists

Runner layer (`officialFormat.ts` — issue dheeai/dhee-runner-minimax-h3#3):
7. emit `style` before `[Shot 1]`
8. normalise `appearsAs`/`job` into the sentence frames instead of demanding the
   model pre-format them
9. camera as natural English in the shot, plus optional amplitude/speed
10. add `(appears in [Shot N], …)` to `retention_analysis` from `subjectIds`
11. move the non-filmable half of `performance` out of `detailed_description`
12. accept `S1,S2`; add a voiceover form; add `<scenetrans>` / `<cutoff>`
13. require full timeline coverage, or state explicitly that holes are intended

Resolve `dheeai/dhee-runner-minimax-h3#2` (`H3_PROMPT_CHAR_LIMIT = 7000`) first
or alongside: the compiled prompt for the *thinnest* scenario measured is
already 6016 chars, so restoring the guide's word body will push typical scenes
past the limit, where `composePrompt` trims the tail — i.e. the audio sections.

## Filed

- `dheeai/dhee-bundle-illustrated-story-h3#5` — commented with measured evidence
  (existing issue, dominant half still open)
- `dheeai/dhee-bundle-illustrated-story-h3#6` — `acting` contract mismatch
- `dheeai/dhee-bundle-illustrated-story-h3#7` — dropped word floor + no style
- `dheeai/dhee-runner-minimax-h3#3` — seven guide divergences in `officialFormat`
