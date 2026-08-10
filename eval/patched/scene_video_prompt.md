# Structured MiniMax H3 scene authoring

Return one JSON object matching `schemas/scene_video_prompt.schema.json` exactly.
The runner, not this authoring pass, owns the final six-section H3 prose. Your
job is to author a small, typed scene plan that can be compiled deterministically.

Do not return Markdown, a prose blob, `detailedDescription`,
`subject_definitions`, `retention_analysis`, `<Picture N>` numbering, or any
field not named by the schema. Do not put subject-definition paragraphs inside
any string. The runner creates `<Subject N>` definitions from `references[]` in
their final routed order and remaps those labels if routing changes the order.

## Authoritative scene-reference guard

Before writing any field, locate the current collection item `{{item_id}}` in
`scenes_plan.sections[]` and derive the exact reference allowlist from that
section's `entities[]`. Copy ids only from that allowlist: every
`references[].id`, every `shots[].subjectIds[]` entry, and every dialogue
`subjectId` MUST be an id copied verbatim from the current section's entities.
Never borrow ids from examples, the story bible generally, another section, or
your own invention. If an entity from the current section is visible or takes
effect in the scene, include it in `references` and use that same id in the
relevant shot or dialogue subject field. Do not invent example ids such as
`traveler`, `cliff`, `S1`, `L1`, or `tech_01`; `S1`-style values are allowed only
as `speakerId` values when assigning a voice, never as reference or subject ids.

## Output fields

Write the fields in this order:

1. `spokenLines`
2. `style`
3. `summary`
4. `references`
4. `shots`
5. `overallSoundscape`
6. `nonDiegeticMusic`
7. `negatives`
8. `duration`
9. `purpose`
10. `shotStructure`
11. `performance`
12. optional `continuationAnchor`

`duration` is the length of this one H3 call, between 5 and 15.08 seconds.
Every shot must fit inside it. Set it from the actual action and dialogue, not
from a generic default.

`purpose` is one sentence naming the single story beat this scene lands.
`summary` is a short English paragraph beginning with a task-type prefix such as
`[reference generation]`; refer only to the subjects that the runner will
number, never to image slots.

## Exact dialogue contract

`spokenLines` is the scene's complete exact-word ledger. Find only the lines
owned by this scene in the supplied plan. Copy each line once, with its original
words, punctuation and native script. Use `[]` when nobody speaks. Store bare
words only: no `<d>` tags, no language labels, no speaker names.

Each spoken line must appear in exactly one shot's `dialogue` array. A dialogue
object has:

- `speakerId`: a stable id such as `S1`; the same voice keeps the same id across
  all shots.
- `subjectId`: the visible reference id that owns the voice.
- `language`: the language name for the H3 tag.
- `exactWords`: an exact character-for-character copy of one `spokenLines`
  entry. Never paraphrase, summarize, translate or add punctuation.
- `delivery`: the vocal delivery written outside the words, such as quietly,
  urgently or with a strained breath.

The runner emits the canonical form
`<Subject N> (Sx) says [delivery]: <d>[Language] exact words</d>`.
Do not author that markup yourself. A line that is not owned by one shot, a
speaker id that changes subject, or an exact-word mismatch is invalid.

For a non-Latin language, preserve the native script supplied by the plan. Do
not romanize it. Do not put dialogue, singing, voices, crowd calls or score in
`overallSoundscape`.

## ACTING contract

The supplied `character_acting_profile` collection contains one permanent
master profile per recurring character. Adapt those profiles into this scene;
never paste a whole master profile verbatim. For the root `performance`, state
the immediate objective as a verb aimed at a partner or concrete target, the
obstacle, the cost of failure, the physical business, the starting body state
and continuous eye life. Add subtext, status change and motivated distance when
they are present. Write behavior under pressure, not emotion labels.

Every shot whose `subjectIds` includes a character must contain at least one
matching `acting` object for that character. Each acting object names a concrete
`tactic`, observable behavior and visible beat change; include listening or
assessment behavior when another character acts or speaks. Use
`interruptedAction` when a physical task stops or changes at the beat. A shot
containing only locations or objects may omit `acting`. Keep the master voice
identity fixed; scene adaptation changes behavior, not the character's voice.

`performance.voiceProfiles` is required. Leave it as `[]` only when the scene
has no dialogue. For every subject that owns a dialogue line, add exactly one
`{ "subjectId", "voicePrompt" }` object and copy its `voicePrompt` verbatim exactly once from
that character's `character_acting_profile`; do not paraphrase, shorten,
reinterpret or invent it. Do not include voice profiles for silent, non-character
or otherwise unneeded subjects. The runner emits this fixed voice identity
outside `<d>` immediately before that subject's first dialogue only.

## References

`references` contains 1–9 visible plates for this scene, ordered by importance:
subjects first and the single location last when a location is present. Include
only references visible or taking effect in a shot. Every reference must be
used by at least one shot.

Each reference has:

- `id`: the exact plain story-bible id; never invent a state id.
- `type`: exactly `character`, `object` or `location`.
- `appearsAs`: a concise visual description of the current visible state.
- `job`: the concrete identity, prop or environment job this plate controls.
- optional `retention`: one official marker: `fully_preserved`,
  `partially_preserved`, `attribute_transfer` or `weak_reference`.

Do not write `<Subject N>`, `<Picture N>`, `Image 1`, or any slot number in
`appearsAs`, `job`, `summary`, or any other field. The runner assigns those
labels after reference routing.

## Shots

`shots` is an ordered list of time-bounded beats. Use one entry per meaningful
shot, not one entry per reference and not one entry per spoken line.

Every shot requires:

- `id`: stable shot id from the scene plan.
- `startTime`: seconds from scene start. The first shot is exactly `0`; later
  values are strictly increasing. The runner formats later values as
  `[Shot N] At MM:SS.mmm`.
- `endTime`: greater than `startTime` and no greater than `duration`.
- `composition`: framing, viewpoint, scale and where each visible subject is.
- `subjectIds`: the reference ids visible or taking effect in this shot.
- `action`: the state change, including what is true at the beginning and end.
- `cameraMotion`: exactly one controlled H3 term from the schema enum. Use
  `Static Shot` when the camera deliberately holds.
- `sound`: physical, shot-synchronous sound for this beat.
- optional `transition`: for later shots, say what the cut reveals and why the
  new information is different. Omit it on the first shot unless needed.
- optional `dialogue`: typed dialogue objects owned by this shot.

Choose `shotStructure` from the beat, not from a planner's shot count:

- `continuous_moving`: exactly one unbroken take in which the camera travels.
- `locked_single`: exactly one unbroken, deliberately static take for one held
  beat.
- `multi_cut`: at least two shots joined by distinct cut events.

Two characters talking is `multi_cut` by default so both faces can be shown.
Use `continuous_moving` only when one camera move genuinely travels between
them. The runner rejects a structure/count mismatch and all non-increasing or
out-of-bounds shot times.

For every shot, cover the visible composition, subject placement, environment
and light, physical state change, controlled camera term and physical sound.
Keep those facts in their typed fields; do not assemble them into a prose
paragraph for another model to parse.

## Audio sections and negatives

`overallSoundscape` is one short paragraph of scene-wide non-verbal ambience,
physical sounds and breathing. Use `N/A` only for genuine silence.

`nonDiegeticMusic` describes score the characters cannot hear: instrumentation,
speed, rhythm and dynamic change. Use `N/A` when there is no score.

`negatives` is an explicit list of things H3 must not generate, such as
subtitles, extra people, anachronistic props, soft dissolves or a redesigned
reference. The graph has no negative-conditioning input, so the runner writes
these directions into the compiled positive prompt.

`continuationAnchor` is optional. When present, state the end-of-scene
appearance, last action, environment/light and important prop state so a later
scene can continue cleanly. Omit it when no continuation is needed.

## Final checks before returning JSON

1. Every root field is allowed by the schema and there are no extra fields.
2. `spokenLines` contains only this scene's exact bare words.
3. Every spoken line is owned by exactly one typed shot dialogue object.
4. Every dialogue `exactWords` exactly matches its ledger entry.
5. Every `subjectId` and reference id is consistent.
6. Camera terms come directly from the enum.
7. The first shot starts at 0; later starts strictly increase; every end time
   fits inside `duration`.
8. `multi_cut` has at least two shots; either single-take value has exactly one.
9. No field contains subject-definition prose or reference slot numbering.


## Supplied context

### Art style

{{art_style}}

### Story bible

{{story_bible}}

### Character state ledger

{{character_state}}

### Character acting profiles

{{character_acting_profile}}

### Narration

{{narration}}

### Scenes plan

{{scenes_plan}}

## Style opening

`style` is one or two English sentences naming the medium, palette, light
quality and finish, taken from the supplied art style. The runner emits it
immediately before `[Shot 1]`, which is the only place the official
full-reference guide allows the style opening. Do not put action in it.

## Acting is required on every shot

`shots[].acting` is REQUIRED, not optional. Every character in a shot's
`subjectIds` needs its own matching `acting` object in that same shot. A
scene that omits one is rejected before any render, so a missing entry costs the
whole run, not just this node.
