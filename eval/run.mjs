/**
 * Run illustrated_story_h3's scene_video_prompt contract against
 * deepseek/deepseek-v4-flash and grade the result against the OFFICIAL
 * MiniMax H3 full-reference guide.
 *
 * Two arms, because the bundle has a suspected context-wiring bug:
 *   asis    — the prompt exactly as llm.generate renders it today (only
 *             {{item_id}} substituted; no declared context input reaches
 *             the model, because the template interpolates none of them).
 *   ctx     — the same prompt with the six declared inputs appended the way
 *             every other prompt in this bundle interpolates them.
 *
 * Grading is not vibes: each output is compiled through the REAL runner
 * (dist/officialFormat.js -> compileStructuredScenePrompt with
 * strictPerformance + the section's entity allowlist) and then put through the
 * runner's own audits, plus guide checks the runner does not make.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import {
  compileStructuredScenePrompt,
  auditDetailedDescription,
  auditDialogueIntegrity,
  auditDialogueScript,
  repairH3Prose,
} from './h3dist/officialFormat.js';
import { SCENARIOS, CONTEXT } from './scenarios.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = resolve(process.env.HOME, '.kshana/bundles/illustrated_story_h3');
const OUT = resolve(HERE, 'out');
mkdirSync(OUT, { recursive: true });

// `fix` arm reads the patched pair written by fix.mjs; the other arms read the
// bundle as it stands on disk.
const PATCHED = process.env.H3_ARM === 'fix';
const TEMPLATE = readFileSync(
  PATCHED ? resolve(HERE, 'patched/scene_video_prompt.md') : resolve(BUNDLE, 'prompts/scene_video_prompt.md'),
  'utf-8',
);
const SCHEMA = JSON.parse(
  readFileSync(
    PATCHED ? resolve(HERE, 'patched/scene_video_prompt.schema.json') : resolve(BUNDLE, 'schemas/scene_video_prompt.schema.json'),
    'utf-8',
  ),
);

// ── env ────────────────────────────────────────────────────────────────
function loadEnv() {
  const raw = readFileSync(resolve(process.env.HOME, 'Projects/dhee-core/.env'), 'utf-8');
  const out = {};
  for (const line of raw.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}
const ENV = loadEnv();
// LOCAL by default is opt-in via H3_BASE: leaving the key unset is what marks a
// call local. Remote (OpenRouter) needs the heavy-tier key.
const BASE = process.env.H3_BASE || 'https://openrouter.ai/api/v1';
const IS_LOCAL = !/openrouter\.ai/.test(BASE);
const API_KEY = IS_LOCAL ? undefined : (ENV.LLM_TIER_HEAVY_API_KEY || ENV.OPENAI_API_KEY);
const MODEL = process.env.H3_MODEL || 'deepseek/deepseek-v4-flash';
// Local models are loaded one at a time and the gateway serialises across
// slots; the bundle runs this node at concurrency 5, so match that.
const CONCURRENCY = Number(process.env.H3_CONCURRENCY || (IS_LOCAL ? 2 : 5));

// ── the two prompt arms ────────────────────────────────────────────────
function renderAsIs(scenario) {
  // Exactly what substituteTemplate() does today: every {{var}} the template
  // names, resolved against ctx.inputs. The as-is template names only
  // {{item_id}}; the patched one names all six declared inputs too.
  const vars = { ...CONTEXT, item_id: scenario.id };
  return TEMPLATE.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_, name) => {
    if (!(name in vars)) throw new Error(`template names unprovided var ${name}`);
    const v = vars[name];
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
}

function renderWithContext(scenario) {
  // What the node's declared inputs WOULD look like appended, matching the
  // convention used by scene_detail.md / chapter_outline.md in this bundle.
  const j = (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  return [
    renderAsIs(scenario),
    '',
    '## Art style',
    '',
    j(CONTEXT.art_style),
    '',
    '## Story bible',
    '',
    j(CONTEXT.story_bible),
    '',
    '## Character state ledger',
    '',
    j(CONTEXT.character_state),
    '',
    '## Character acting profiles',
    '',
    j(CONTEXT.character_acting_profile),
    '',
    '## Narration',
    '',
    j(CONTEXT.narration),
    '',
    '## Scenes plan',
    '',
    j(CONTEXT.scenes_plan),
  ].join('\n');
}

// ── the call, matching llm.generate's structuredMode:'schema' ───────────
async function call(prompt, { attempt = 1, messages } = {}) {
  const body = {
    model: MODEL,
    messages: messages ?? [{ role: 'user', content: prompt }],
    max_tokens: 20000,
    // Mirrors dhee-core LLMClient.ts: reasoning variants otherwise spend the
    // whole budget on reasoning_content and return empty `content`. Ignored by
    // providers that do not understand it.
    chat_template_kwargs: { enable_thinking: false },
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'scene_video_prompt', strict: false, schema: SCHEMA },
    },
  };
  const t0 = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
  const json = JSON.parse(text);
  const msg = json.choices?.[0]?.message ?? {};
  // Same belt-and-suspenders fallback dhee-core uses when a thinking model
  // still empties `content`.
  const content = (msg.content && msg.content.length ? msg.content : (msg.reasoning_content ?? msg.reasoning ?? '')) || '';
  return { content, usage: json.usage, ms: Date.now() - t0, attempt };
}

function tryParse(raw) {
  let s = String(raw).trim();
  if (s.startsWith('```')) s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch (err) {
    const m = /position (\d+)/.exec(err.message);
    if (m) {
      try {
        return { ok: true, value: JSON.parse(s.slice(0, Number(m[1]))) };
      } catch { /* fall through */ }
    }
    return { ok: false, error: err.message };
  }
}

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const validate = ajv.compile(SCHEMA);

// ── guide checks the runner does NOT make ──────────────────────────────
const TASK_TYPES = [
  'keyframe completion', 'reference generation', 'video editing',
  'video continuation', 'audio reuse', 'audio reference',
];
const CUT_VERBS = /^(the (camera|shot) (cuts?|transitions?|changes?|switches)|the shot cuts)/i;
const SPEECH_VERBS =
  /\b(speaks?|speaking|spoke|says?|said|(?:her|his|their) voice|murmurs?|whispers?|shouts?|calls? out|announces?|utters?|replies|answers)\b/i;

function guideChecks(scene, compiled, scenario) {
  const notes = [];
  const dd = compiled.detailedDescription;

  // 1. style opening before [Shot 1] (ref guide 5.2)
  const beforeShot1 = dd.slice(0, dd.indexOf('[Shot 1]'));
  const looksLikeStyle = /\b(cinematic|live-action|gouache|animated|illustration|watercolor|painterly|film|style)\b/i.test(beforeShot1);
  if (!looksLikeStyle) {
    notes.push({
      sev: scene.style ? 'med' : 'high',
      code: scene.style ? 'style-authored-but-dropped' : 'no-style-opening',
      msg: scene.style
        ? `the model authored a style opening ("${scene.style.slice(0, 70)}...") but compileStructuredScenePrompt() has no case for it, so it never reaches the prompt — needs a one-line runner change`
        : `nothing before [Shot 1] establishes visual style (guide 5.2 requires 1-2 sentences); that slot instead holds: "${beforeShot1.trim().slice(0, 90)}..."`,
    });
  }

  // 2. task-type prefix must be from the closed set (ref guide 3)
  const pfx = /^\s*\[([^\]]+)\]/.exec(scene.summary || '');
  if (!pfx) {
    notes.push({ sev: 'high', code: 'no-task-prefix', msg: 'summary has no [task type] prefix' });
  } else {
    const parts = pfx[1].split('+').map((p) => p.trim());
    const bad = parts.filter((p) => !TASK_TYPES.includes(p));
    if (bad.length) {
      notes.push({ sev: 'med', code: 'bad-task-prefix', msg: `summary prefix uses non-official task type(s): ${bad.join(', ')}` });
    }
  }

  // 3. camera motion must read as natural English in the shot, not a label
  const labelled = [...dd.matchAll(/Camera:\s*([A-Z][A-Za-z ]+?)\./g)];
  if (labelled.length) {
    notes.push({
      sev: 'high',
      code: 'camera-as-label',
      msg: `${labelled.length} camera term(s) emitted as a stacked label ("Camera: ${labelled[0][1]}.") — base guide 4.3 requires natural English inside the shot`,
    });
  }
  // amplitude/speed are unrepresentable in the schema at all
  if (!/with (small|large) amplitude|at (slow|fast) speed/.test(dd)) {
    notes.push({
      sev: 'med',
      code: 'no-amplitude-speed',
      msg: 'no amplitude/speed modifier anywhere — the schema enum has no slot for the guide\'s other two camera dimensions',
    });
  }

  // 4. transition strings must grammatically continue "At MM:SS.mmm, ..."
  for (const [i, shot] of (scene.shots ?? []).entries()) {
    if (i === 0) continue;
    const t = (shot.transition ?? '').trim();
    if (!t) continue;
    if (!CUT_VERBS.test(t)) {
      notes.push({
        sev: 'med',
        code: 'transition-grammar',
        msg: `shots[${i}].transition does not begin with a documented cut phrase, so the marker reads "At MM:SS.mmm, ${t.slice(0, 55)}"`,
      });
    }
  }

  // 5. retention_analysis should carry the (appears in [Shot N]) clause (4.1)
  const ret = compiled.sections.find((s) => s.name === 'retention_analysis')?.body ?? '';
  if (!/\(appears in \[Shot/.test(ret)) {
    notes.push({
      sev: 'med',
      code: 'retention-no-shotlist',
      msg: 'retention_analysis omits the "(appears in [Shot N], ...)" clause the guide specifies, though shots[].subjectIds has the data',
    });
  }

  // 6. negatives are emitted as a bare noun list inside positive prose
  const neg = /Negative directions: ([^\n]+)/.exec(dd);
  if (neg) {
    const items = neg[1].split(';').map((s) => s.trim());
    const bareNouns = items.filter((s) => s.split(/\s+/).length <= 3 && !/\bno\b|\bnot\b|\bwithout\b|\bfree of\b|\bstays?\b/i.test(s));
    if (bareNouns.length) {
      notes.push({
        sev: 'med',
        code: 'negatives-as-nouns',
        msg: `${bareNouns.length}/${items.length} negatives are bare nouns in positive prose (e.g. "${bareNouns[0]}") — H3 has no negative conditioning, so these read as content to render`,
      });
    }
  }

  // 7. <scenetrans> / <cutoff> unrepresentable
  const crossing = (scenario.section.shots ?? []).some((s) => s.crossesCut);
  if (crossing && !/<scenetrans>/.test(dd)) {
    notes.push({
      sev: 'high',
      code: 'no-scenetrans',
      msg: 'the plan runs a line across a cut, which the guide requires <scenetrans> on both sides of — the schema has no field that can emit it',
    });
  }

  // 8. voiceover exact phrasing + lips-closed follow-up
  const vo = (scenario.section.shots ?? []).some((s) => s.voiceover);
  if (vo) {
    if (!/says in an off-screen voiceover/.test(dd)) {
      notes.push({ sev: 'high', code: 'no-vo-phrase', msg: 'plan marks a voiceover but the compiled prose lacks the guide\'s required exact phrase "says in an off-screen voiceover"' });
    }
    if (!/lips? (remain|stay)/i.test(dd)) {
      notes.push({ sev: 'med', code: 'no-lips-closed', msg: 'voiceover present with no lips-remain-closed statement (base guide 4.4 requires it immediately after the <d> block)' });
    }
  }

  // 9. silent scene must not describe speech
  if ((scene.spokenLines ?? []).length === 0) {
    const hit = SPEECH_VERBS.exec(dd);
    if (hit) {
      notes.push({ sev: 'high', code: 'speech-in-silent-scene', msg: `silent scene but prose contains speech verb "${hit[0]}" — H3 will synthesise voice-shaped noise` });
    }
  }

  // 10. id discipline against the section's real allowlist
  const allowed = new Set(scenario.expectedIds);
  const invented = (scene.references ?? []).map((r) => r.id).filter((id) => !allowed.has(id));
  if (invented.length) {
    notes.push({
      sev: 'critical',
      code: 'invented-ids',
      msg: `references use id(s) not in the section's entity allowlist: ${invented.join(', ')} (allowed: ${[...allowed].join(', ')})`,
    });
  }

  // 11. verbatim spokenLines fidelity vs the plan
  const planLines = (scenario.section.spokenLines ?? []);
  const got = scene.spokenLines ?? [];
  const missing = planLines.filter((l) => !got.includes(l));
  const extra = got.filter((l) => !planLines.includes(l));
  if (missing.length) notes.push({ sev: 'critical', code: 'line-not-verbatim', msg: `${missing.length} plan line(s) missing or altered: "${missing[0].slice(0, 50)}"` });
  if (extra.length) notes.push({ sev: 'high', code: 'line-invented', msg: `${extra.length} spokenLines entry not in the plan: "${extra[0].slice(0, 50)}"` });

  // 12. voicePrompt verbatim from the acting profile
  for (const vp of scene.performance?.voiceProfiles ?? []) {
    const prof = CONTEXT.character_acting_profile.find((p) => p.characterId === vp.subjectId);
    if (prof && vp.voicePrompt.trim() !== prof.voicePrompt.trim()) {
      notes.push({
        sev: 'high',
        code: 'voiceprompt-not-verbatim',
        msg: `voiceProfiles[${vp.subjectId}].voicePrompt is not a verbatim copy of the master profile`,
      });
    }
  }

  // 13. duration must sit on H3's 17k+5 frame grid at 24fps
  const frames = Math.round((scene.duration ?? 0) * 24);
  const onGrid = (frames - 5) % 17 === 0;
  if (!onGrid) {
    notes.push({ sev: 'low', code: 'off-grid-duration', msg: `duration ${scene.duration}s = ${frames}f, not on the 17k+5 grid (nearest legal: ${5 + 17 * Math.round((frames - 5) / 17)}f)` });
  }

  // 14. word count
  const words = dd.trim().split(/\s+/).length;
  if (words < 350) notes.push({ sev: words < 250 ? 'high' : 'med', code: 'thin-description', msg: `detailed_description is ${words} words (guide: 350-500 for a generation task)` });
  if (words > 700) notes.push({ sev: 'low', code: 'fat-description', msg: `detailed_description is ${words} words (guide: 350-500)` });

  // 15. budget respect
  const budget = scenario.section.budgetSec;
  if (scene.duration && Math.abs(scene.duration - budget) > 1.5) {
    notes.push({ sev: 'med', code: 'budget-drift', msg: `duration ${scene.duration}s vs plan budgetSec ${budget}s` });
  }
  return { notes, words };
}

// ── one scenario, one arm ──────────────────────────────────────────────
async function runOne(scenario, arm) {
  const prompt = arm === 'asis' ? renderAsIs(scenario) : renderWithContext(scenario);
  const rec = {
    scenario: scenario.id,
    label: scenario.label,
    arm,
    promptChars: prompt.length,
    attempts: [],
  };

  // Mirror llm.generate's conversational retry loop (up to 3 attempts).
  let messages = [{ role: 'user', content: prompt }];
  let scene = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let r;
    try {
      r = await call(prompt, { attempt, messages });
    } catch (err) {
      rec.attempts.push({ attempt, transportError: String(err.message).slice(0, 300) });
      break;
    }
    const parsed = tryParse(r.content);
    if (!parsed.ok) {
      rec.attempts.push({ attempt, ms: r.ms, usage: r.usage, parseError: parsed.error.slice(0, 200) });
      messages = [
        ...messages,
        { role: 'assistant', content: r.content },
        { role: 'user', content: `Your previous response did not parse as JSON. Error: ${parsed.error}. Return the JSON object ONLY, no preamble or markdown fences.` },
      ];
      continue;
    }
    const valid = validate(parsed.value);
    if (!valid) {
      const errs = (validate.errors ?? []).map((e) => `${e.instancePath || '<root>'} ${e.message}`).slice(0, 8).join('; ');
      rec.attempts.push({ attempt, ms: r.ms, usage: r.usage, schemaError: errs });
      messages = [
        ...messages,
        { role: 'assistant', content: r.content },
        { role: 'user', content: `Your previous response failed schema validation: ${errs}. Please re-emit the JSON object using ONLY values from the declared enums. Return the JSON object only, no preamble.` },
      ];
      continue;
    }
    rec.attempts.push({ attempt, ms: r.ms, usage: r.usage, ok: true });
    scene = parsed.value;
    break;
  }

  if (!scene) {
    rec.outcome = 'never-validated';
    return rec;
  }
  rec.scene = scene;

  // Compile through the REAL runner, with the section's entity allowlist.
  try {
    const compiled = compileStructuredScenePrompt(scene, {
      strictPerformance: true,
      expectedReferenceIds: scenario.expectedIds,
    });
    rec.outcome = 'compiled';
    rec.compiled = compiled.prompt;
    const planShots = (scenario.section.shots ?? []).map((s) => ({ dialogue: s.dialogue, speaker: s.speaker }));
    const repaired = repairH3Prose(compiled.detailedDescription, planShots);
    rec.repairNotes = repaired.notes;
    rec.runnerAudit = auditDetailedDescription(repaired.prose, {
      hasDialogue: /<d>/.test(repaired.prose) || planShots.some((s) => typeof s.dialogue === 'string'),
    });
    rec.dialogueIntegrity = auditDialogueIntegrity(repaired.prose, planShots);
    rec.scriptFindings = auditDialogueScript(repaired.prose);
    const g = guideChecks(scene, compiled, scenario);
    rec.guideNotes = g.notes;
    rec.words = g.words;
  } catch (err) {
    rec.outcome = 'compile-rejected';
    rec.compileError = String(err.message);
  }
  return rec;
}

// ── main ───────────────────────────────────────────────────────────────
const arms = (process.argv[2] || 'asis,ctx').split(',');
const only = process.argv[3];
const results = [];
for (const arm of arms) {
  const queue = SCENARIOS.filter((s) => !only || s.id === only);
  const done = [];
  // Bounded pool rather than Promise.all: a local llama.cpp gateway serialises
  // grammar-constrained decodes across slots, so unbounded fan-out just
  // lengthens every request instead of finishing sooner.
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (next < queue.length) {
        const i = next++;
        done[i] = await runOne(queue[i], arm);
      }
    }),
  );
  for (const d of done) {
    results.push(d);
    const tag = `${d.arm}/${d.scenario}`;
    console.log(`\n=== ${tag} — ${d.label}`);
    console.log(`    outcome: ${d.outcome}  attempts: ${d.attempts.length}  prompt: ${d.promptChars}c`);
    if (d.compileError) console.log(`    COMPILE REJECTED: ${d.compileError}`);
    for (const a of d.attempts) {
      if (a.schemaError) console.log(`    a${a.attempt} schema: ${a.schemaError.slice(0, 160)}`);
      if (a.parseError) console.log(`    a${a.attempt} parse: ${a.parseError.slice(0, 120)}`);
      if (a.transportError) console.log(`    a${a.attempt} transport: ${a.transportError}`);
    }
    for (const n of d.guideNotes ?? []) console.log(`    [${n.sev}] ${n.code}: ${n.msg}`);
    for (const n of d.runnerAudit ?? []) console.log(`    [runner] ${n}`);
    for (const n of d.dialogueIntegrity?.fatal ?? []) console.log(`    [FATAL] ${n}`);
    for (const n of d.dialogueIntegrity?.warnings ?? []) console.log(`    [warn] ${n}`);
    for (const n of d.scriptFindings ?? []) console.log(`    [script] ${n}`);
    for (const n of d.repairNotes ?? []) console.log(`    [repair] ${n}`);
  }
}
// Namespace by model AND by the scenario filter. Without this a single-scenario
// probe silently overwrote a full five-scenario result set for another model.
const slug = MODEL.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
const name = `results_${slug}_${arms.join('-')}${only ? `_${only}` : ''}.json`;
writeFileSync(resolve(OUT, name), JSON.stringify(results, null, 2));
console.log(`\nwrote out/${name}`);
