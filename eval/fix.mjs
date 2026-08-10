/**
 * Confirmation arm: apply the minimal bundle-layer patch set the review
 * recommends, to the schema and prompt ONLY (the real bundle is untouched),
 * and re-run the same five scenarios.
 *
 * The patch is deliberately small and all of it is enforceable by JSON Schema,
 * so llm.generate's OWN retry loop catches a violation at the authoring node
 * instead of the render node throwing hours later:
 *
 *   1. interpolate the six declared context inputs into the prompt   (the bug)
 *   2. shots[].acting -> required, minItems 1                        (4/5 failures)
 *   3. new required `style` field for the pre-[Shot 1] style opening (guide 5.2)
 *   4. appearsAs/job phrasing rules so the runner's sentence frames read
 *   5. transition -> required on shots after the first
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = resolve(process.env.HOME, '.kshana/bundles/illustrated_story_h3');
mkdirSync(resolve(HERE, 'patched'), { recursive: true });

// ── schema patch ───────────────────────────────────────────────────────
const schema = JSON.parse(
  readFileSync(resolve(BUNDLE, 'schemas/scene_video_prompt.schema.json'), 'utf-8'),
);

// (3) style opening
schema.required.splice(schema.required.indexOf('summary'), 0, 'style');
schema.properties.style = {
  type: 'string',
  minLength: 40,
  description:
    'One or two English sentences naming the visual style, copied from the supplied art style: medium, palette, light quality and finish. The runner emits this immediately BEFORE [Shot 1], which is where the official guide requires the style opening in full-reference mode. Do not describe action here.',
};

const shot = schema.properties.shots.items;
// (2) acting is mandatory wherever a character is on screen; the runner already
//     rejects a shot that omits it, so the schema must say so too.
shot.required.push('acting');
shot.properties.acting.minItems = 1;
shot.properties.acting.description =
  'REQUIRED. One entry for every character in subjectIds — the runner rejects the scene otherwise. A shot with no character at all still needs one entry naming the object or location subject it is about.';
// (5) transition on every shot after the first
shot.properties.transition.description =
  'REQUIRED on every shot after the first. Write it as a lower-case clause that grammatically continues "At 00:04.000, ..." and begins with one of: the shot cuts to, the camera cuts to, the shot transitions to, the shot changes to, the shot switches to. Say what new information the cut reveals. Omit only on the first shot.';
shot.properties.transition.pattern =
  '^(the (shot|camera) (cuts?|transitions?|changes?|switches) )';

// (4) phrasing the runner's sentence frames actually need
const ref = schema.properties.references.items;
ref.properties.appearsAs.description =
  'Short lower-case noun phrase describing the current visible reference, with NO trailing period and NO leading capital — the runner drops it into the frame "<Subject N> is ___ in <Picture N>.", so "an elderly woman in a green shawl" is correct and "Elderly woman in a green shawl." is not. Do not write a slot number.';
ref.properties.appearsAs.pattern = '^[^A-Z].*[^.]$';
ref.properties.job.description =
  'What this reference must control, as a lower-case noun phrase with NO trailing period and NO leading verb — the runner drops it into "Follow it for ___.", so "her posture, shawl and unfocused gaze" is correct and "Controls her posture." is not. Do not write a slot number.';
ref.properties.job.pattern = '^[^A-Z].*[^.]$';

writeFileSync(
  resolve(HERE, 'patched/scene_video_prompt.schema.json'),
  JSON.stringify(schema, null, 2),
);

// ── prompt patch ───────────────────────────────────────────────────────
let prompt = readFileSync(resolve(BUNDLE, 'prompts/scene_video_prompt.md'), 'utf-8');

// (1) THE BUG: the node declares six inputs and the template interpolates none.
//     Append them exactly the way every other prompt in this bundle does.
prompt += `

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
`;

// (3) tell the model about the new field, in the output-order list
prompt = prompt.replace(
  '2. `summary`',
  '2. `style`\n3. `summary`',
).replace(
  /^(\d+)\. `references`$/m,
  '4. `references`',
);
prompt += `
## Style opening

\`style\` is one or two English sentences naming the medium, palette, light
quality and finish, taken from the supplied art style. The runner emits it
immediately before \`[Shot 1]\`, which is the only place the official
full-reference guide allows the style opening. Do not put action in it.

## Acting is required on every shot

\`shots[].acting\` is REQUIRED, not optional. Every character in a shot's
\`subjectIds\` needs its own matching \`acting\` object in that same shot. A
scene that omits one is rejected before any render, so a missing entry costs the
whole run, not just this node.
`;

writeFileSync(resolve(HERE, 'patched/scene_video_prompt.md'), prompt);
console.log('wrote patched/ (schema + prompt)');
