/**
 * dhee-runner-minimax-h3 — `comfy.minimax_h3_r2v`
 *
 * MiniMax H3 (Hailuo 03) Reference-to-Video, run locally through ComfyUI's
 * `MiniMaxH3ReferenceToVideo` node. One call renders ONE clip of up to ~15
 * seconds, at 24fps, with NATIVE stereo audio — and, crucially, that one clip
 * can contain SEVERAL CUTS. That is the whole reason this runner exists next
 * to `comfy.ltx_msr`: MSR renders one continuous shot per call and the film is
 * assembled by concatenating them, whereas H3 renders a whole SCENE — cuts,
 * whip pans, title cards, sound design and all — in a single generation.
 *
 * What the model actually wants (from MiniMax/fal/Comfy's own H3 guidance, all
 * of which this runner encodes so the bundle doesn't have to):
 *
 *   1. EVERY REFERENCE GETS A JOB. "Use <Picture 1> for the talent; <Picture 2>
 *      for the bag; <Picture 3> for the location" beats handing it three images
 *      and a description. The authoring model cannot know which slot a plate
 *      lands in (this runner decides the order), so the runner BUILDS that
 *      binding clause deterministically from each reference's `appearsAs` +
 *      `job` and prepends it to the authored prose. The prose itself must never
 *      mention slot numbers.
 *   2. A TIMED SHOT LIST for anything longer than one beat — `[0-2 seconds] …
 *      [2-4 seconds] …`. That is the bundle's prompt template's job; this
 *      runner just makes sure the clip is long enough to hold it.
 *   3. AUDIO IS DIRECTED, NOT INHERITED. The graph decodes an audio latent
 *      natively, so the prompt carries the sound design and any dialogue.
 *   4. NEGATIVES GO IN THE PROMPT. This graph is guidance-distilled
 *      (`BasicGuider`, no CFG) — there is NO negative conditioning input. "No
 *      soft dissolves", "no on-screen subtitles" are written as prose.
 *
 * Hard numbers, all enforced here:
 *   • up to 9 reference images (vs MSR's 5)
 *   • 5s..15s, 24fps, on H3's 17k+5 frame grid (5, 22, 39 … 362)
 *   • native resolution is 768px on the short edge, capped 768x1344, /32
 *   • `ref_image_size`: "match" (fast) or "max" (stronger identity, slower)
 *   • `res_multistep` + the `simple` scheduler is the founder-tested fast
 *     workflow used by the canonical INT8 + MiniMaxH3Cache graph
 *
 * PURE TS + ffmpeg. The diffusion graph is the BUNDLE's (cfg.workflowPath,
 * API-format); runtime values are injected by placeholder (`__POS__`) and by
 * node class_type. SDK-firewall clean: only @dheeai/runner-sdk plus the
 * vendored, dependency-free ComfyClient and ffmpeg helpers.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, basename } from 'node:path';

import { defineRunner, resolveEndpointUrl, retryTransient } from '@dheeai/runner-sdk';
import type { RunnerContext, RunnerDescription, RunnerManifest, RunnerResult } from '@dheeai/runner-sdk';

import { ComfyClient } from './comfyClient.js';
import { ff, probeSize } from './ffmpeg.js';
import { injectAuthoredDialogue } from './dialogueInjection.js';
import { normalizeIndexedRefs, dedupeSceneReferences, applyVoiceProfileOverrides, stepsForSceneComplexity, buildSubjectSections, remapSubjectLabels, assembleH3Prompt, auditDetailedDescription, auditDialogueIntegrity, auditDialogueScript, repairH3Prose, compileStructuredScenePrompt, validateStructuredScenePerformance } from './officialFormat.js';

export * from './dialogueInjection.js';
export * from './officialFormat.js';

const IMAGE_RE = /\.(png|jpe?g|webp)$/i;
const TEXT_RE = /\.(md|txt|json)$/i;

/** H3 hard limits (MiniMax H3 / Hailuo 03, reference-to-video endpoint). */
export const H3_MAX_REFS = 9;
export const H3_MIN_SECONDS = 5;
export const H3_MAX_SECONDS = 15;
export const H3_FPS = 24;
/** Prompts run to ~7,000 characters; past that the tail is at risk. */
export const H3_PROMPT_CHAR_LIMIT = 7000;

// ── measured H3 clip-duration model ─────────────────────────────────────────
// Duplicated verbatim in dhee-runner-story-chapters/src/chapterMerge.ts (that
// repo's `mergeSections` applies the SAME speechSecondsFor to the UPSTREAM
// `budgetSec` an LLM authors shot durations against) — this ecosystem
// deliberately does not cross-import between runner packages, so keep both
// copies of these constants and this function in sync by hand.
//
// Measured 2026-08-04 across 7 H3 renders (1280x720, seed 4242, Hindi): H3
// generates audio from the prompt and stretches/compresses the spoken line to
// fill the clip — leadInSilence + speechSpan ≈ clipLength, exactly, every
// time. Natural pace, taken from the longest (least padding-distorted) line:
// ~2.8 words/second. Fixed overhead ~1.0s (lead-in + tail).
export const WORDS_PER_SEC = 2.8;
export const FIXED_OVERHEAD_SEC = 1.0;
export const INTER_LINE_GAP_SEC = 0.35;
/**
 * Breathing room after the last word.
 *
 * FIXED_OVERHEAD_SEC covers lead-in AND tail together, but lead-in alone was
 * measured at 0.40-1.33s depending on where the <d> tag sits — which can leave
 * the tail at zero and the last word landing on the final frame. Reported from a
 * real film: an 11-word line in a 6.58s clip, sound running continuously to the
 * last frame with no trailing silence. This is the margin that stops that.
 */
export const TAIL_MARGIN_SEC = 0.6;

/**
 * Seconds of SPOKEN dialogue a beat needs: word-paced duration plus fixed
 * lead-in/tail overhead plus a gap between separate utterances. `lines` is
 * whitespace-tokenized (works for Devanagari — Hindi uses spaces). Duplicated
 * in dhee-runner-story-chapters/src/chapterMerge.ts — keep both in sync.
 */
export function speechSecondsFor(lines: string[], authoredSeconds?: number): number {
  const texts = lines.map((line) => String(line ?? '').trim()).filter(Boolean);
  const words = texts.reduce((sum, line) => sum + line.split(/\s+/).filter(Boolean).length, 0);

  // Count SENTENCES, not array entries. A scene author may put two utterances in
  // one `spokenLines` string ("Give it here, Vashti. The Rift has a claim on
  // it.") — the pause between them is spoken either way, so paying for it only
  // when they happen to be separate array entries under-budgets the clip.
  const sentences = texts.reduce((n, line) => {
    const parts = line.split(/[.!?]+[\s"'\u2019\u201d]*/).filter((p) => p.trim().length);
    return n + Math.max(1, parts.length);
  }, 0);

  const heuristic = words / WORDS_PER_SEC
    + FIXED_OVERHEAD_SEC
    + TAIL_MARGIN_SEC
    + Math.max(0, sentences - 1) * INTER_LINE_GAP_SEC;

  // The AUTHORING MODEL'S estimate wins when it is LONGER. It knows things the
  // constant cannot: the delivery it wrote ("cold, imperative"), the voice
  // profile's pace ("slow pace, gravelly"), and where it intends pauses. 2.8
  // words/sec was measured off the least padding-distorted line — a best case —
  // so a slow, deliberate voice runs well under it. Only ever raises the floor:
  // a model that under-estimates cannot squeeze the words.
  const authored = typeof authoredSeconds === 'number' && Number.isFinite(authoredSeconds) && authoredSeconds > 0
    ? authoredSeconds + TAIL_MARGIN_SEC
    : 0;
  return Math.max(heuristic, authored);
}

export type Workflow = Record<string, { class_type?: string; inputs?: Record<string, unknown> }>;

export interface H3WorkflowContractOptions {
  positive: string;
  referenceNames: string[];
  width: number;
  height: number;
  length: number;
  refImageSize: string;
  steps: number;
  samplerName: string;
  scheduler?: string;
  seed: number;
  fps: number;
  itemId: string;
  cacheEnabled?: boolean;
  cacheThreshold?: number;
  cacheStart?: number;
  cacheEnd?: number;
  cacheMaxSteps?: number;
}

export interface H3WorkflowContractResult {
  scheduler: string;
  cacheLog?: string;
}

/** Apply dynamic values to a canonical MiniMaxH3Cache or legacy EasyCache graph. */
export function applyH3WorkflowContract(
  wf: Workflow,
  options: H3WorkflowContractOptions,
): H3WorkflowContractResult {
  const {
    positive, referenceNames, width, height, length, refImageSize, steps,
    samplerName, seed, fps, itemId,
  } = options;
  const scheduler = options.scheduler ?? 'simple';

  const r2vId = Object.keys(wf).find((key) => wf[key]?.class_type === 'MiniMaxH3ReferenceToVideo');
  if (!r2vId) throw new Error('workflow has no MiniMaxH3ReferenceToVideo node');
  const r2vInputs = wf[r2vId]!.inputs ?? (wf[r2vId]!.inputs = {});

  // The final authored prompt owns this input even when an exported graph
  // contains literal example copy instead of the __POS__ placeholder.
  r2vInputs['prompt'] = positive;

  // Comfy exports the autogrow group in both flat and dotted forms. Remove both
  // before rebuilding it so no template reference can leak into a render.
  for (const key of Object.keys(r2vInputs)) {
    if (key.startsWith('ref_images.') || /^ref_image_\d+$/.test(key)) delete r2vInputs[key];
  }
  for (let i = 0; i < referenceNames.length; i++) {
    const loadId = `h3Ref${i}`;
    wf[loadId] = { class_type: 'LoadImage', inputs: { image: referenceNames[i]! } };
    r2vInputs[`ref_images.ref_image_${i}`] = [loadId, 0];
  }
  r2vInputs['width'] = width;
  r2vInputs['height'] = height;
  r2vInputs['length'] = length;
  r2vInputs['ref_image_size'] = refImageSize;

  const cacheId = Object.keys(wf).find((key) => {
    const classType = wf[key]?.class_type;
    return classType === 'MiniMaxH3Cache' || classType === 'EasyCache';
  });
  let cacheLog: string | undefined;
  if (cacheId) {
    const cacheNode = wf[cacheId]!;
    const cacheClass = cacheNode.class_type!;
    if (options.cacheEnabled === false) {
      const upstream = cacheNode.inputs?.['model'];
      delete wf[cacheId];
      for (const node of Object.values(wf)) {
        for (const [key, value] of Object.entries(node.inputs ?? {})) {
          if (Array.isArray(value) && value[0] === cacheId) node.inputs![key] = upstream;
        }
      }
      cacheLog = `${cacheClass} removed (cache:false)`;
    } else {
      const inputs = cacheNode.inputs ?? (cacheNode.inputs = {});
      const thresholdKey = cacheClass === 'MiniMaxH3Cache' ? 'resuse_threshold' : 'reuse_threshold';
      if (options.cacheThreshold !== undefined) inputs[thresholdKey] = options.cacheThreshold;
      if (options.cacheStart !== undefined) inputs['start_percent'] = options.cacheStart;
      if (options.cacheEnd !== undefined) inputs['end_percent'] = options.cacheEnd;
      if (cacheClass === 'MiniMaxH3Cache' && options.cacheMaxSteps !== undefined) inputs['max_steps'] = options.cacheMaxSteps;
      cacheLog = `${cacheClass} on (reuse ${inputs[thresholdKey]}, ${inputs['start_percent']}-${inputs['end_percent']}` +
        (cacheClass === 'MiniMaxH3Cache' ? `, max_steps ${inputs['max_steps']})` : ')');
    }
  }

  for (const key of Object.keys(wf)) {
    const classType = wf[key]?.class_type;
    if (classType === 'ResolutionSelector' || classType === 'ComfyMathExpression' || classType === 'PrimitiveFloat') delete wf[key];
  }

  for (const node of Object.values(wf)) {
    const inputs = node.inputs ?? (node.inputs = {});
    for (const [key, value] of Object.entries(inputs)) {
      if (value === '__POS__') inputs[key] = positive;
    }
    switch (node.class_type) {
      case 'RandomNoise': inputs['noise_seed'] = seed; break;
      case 'BasicScheduler': inputs['steps'] = steps; inputs['scheduler'] = scheduler; break;
      case 'KSamplerSelect': inputs['sampler_name'] = samplerName; break;
      case 'CreateVideo': inputs['fps'] = fps; break;
      case 'SaveVideo': inputs['filename_prefix'] = `h3_${itemId.replace(/[^a-zA-Z0-9_]/g, '_')}`; break;
      default: break;
    }
  }

  return { scheduler, cacheLog };
}

// ── small shared helpers (kept local — the SDK firewall forbids core imports) ──
function rs(o: Record<string, unknown>, k: string): string | undefined {
  const v = o[k]; return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
function rn(o: Record<string, unknown>, k: string): number | undefined {
  const v = o[k]; return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function rb(o: Record<string, unknown>, k: string): boolean | undefined {
  const v = o[k]; return typeof v === 'boolean' ? v : undefined;
}
function snap32(x: number): number { return Math.max(32, Math.round(x / 32) * 32); }
function msg(e: unknown): string { return e instanceof Error ? e.message : String(e); }
function hashStr(s: string): number { let h = 0; for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; return Math.abs(h); }

function projAbs(projectDir: string, p: string): string | null {
  if (isAbsolute(p)) return null;
  const root = resolve(projectDir); const abs = resolve(root, p); const rel = relative(root, abs);
  return rel.startsWith('..') || isAbsolute(rel) ? null : abs;
}

function readText(ctx: RunnerContext, key: string | undefined): string | undefined {
  if (!key) return undefined;
  const v = ctx.inputs[key];
  if (typeof v === 'string') {
    if (TEXT_RE.test(v) && existsSync(v)) { try { return readFileSync(v, 'utf-8').trim(); } catch { /* */ } }
    return v.trim();
  }
  return undefined;
}

/**
 * The entities of the section immediately BEFORE this one, from the shot plan.
 *
 * This is how the runner knows who was already in the film's world when a scene
 * opens, and it is deliberately taken from the PLAN rather than from anything a
 * model authored. `continuationFrom.characterPositions` carries the same
 * information in principle, but on the first real end-to-end run scene 3 copied
 * scene 2's `continuationFrom` instead of its `continuationAnchor`, dropping a
 * character who had already arrived — and the runner then ordered her to arrive
 * a second time. The plan cannot make that mistake.
 *
 * Returns undefined for the first section, which has no predecessor, and for a
 * plan whose sections cannot be located — in both cases no arrival is claimed,
 * which is the safe direction to fail.
 */
function previousSectionEntities(plan: unknown, itemId: string | undefined): string[] | undefined {
  if (!itemId || !plan || typeof plan !== 'object') return undefined;
  const sections = (plan as Record<string, unknown>)['sections'];
  if (!Array.isArray(sections)) return undefined;
  const index = sections.findIndex((s) => (s as Record<string, unknown> | undefined)?.['id'] === itemId);
  if (index <= 0) return undefined;
  const prior = sections[index - 1] as Record<string, unknown> | undefined;
  const entities = prior?.['entities'];
  if (!Array.isArray(entities)) return undefined;
  return entities.map((e) => String(e ?? '').trim()).filter(Boolean);
}

function readJsonInput(ctx: RunnerContext, key: string | undefined): unknown {
  if (!key) return undefined;
  const v = ctx.inputs[key];
  if (v && typeof v === 'object') return v;
  const txt = readText(ctx, key);
  if (txt) { try { return JSON.parse(txt); } catch { /* not JSON */ } }
  return undefined;
}

/**
 * A scope:'all' collection map ({ itemId -> imagePath }), filtered to readable
 * images — OR, when `ctx.inputs[key]` is a single STRING path (a STAGE node's
 * output, not a collection), a one-entry map keyed by the input id itself.
 *
 * A stage node's output arrives in ctx.inputs as a plain string, not an
 * `{ itemId: path }` object, so without this a stage-shaped reference (e.g.
 * `referenceInputs: { character: "host_frame" }` pointing at a
 * `comfy.image_edit` stage) resolved to undefined every time, refs fell
 * through to explicitRefImages (which has no appearsAs/job), and
 * buildBindingClause degraded to its generic fallback line. The consequence,
 * spelled out because it is the non-obvious part: when a bundle wires a stage
 * this way, the authored `references[].id` must be the literal INPUT/NODE ID
 * ("host_frame"), never a story-bible id — there is no other key to look up.
 */
function collectionMap(ctx: RunnerContext, key: string | undefined): Record<string, string> | undefined {
  if (!key) return undefined;
  const v = ctx.inputs[key];
  if (typeof v === 'string') {
    return v.trim() && IMAGE_RE.test(v) && existsSync(v) ? { [key]: v } : undefined;
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, p] of Object.entries(v as Record<string, unknown>)) {
    if (typeof p === 'string' && IMAGE_RE.test(p) && existsSync(p)) out[k] = p;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * A `scope:'all'` collection map of `character_acting_profile` outputs
 * ({ characterId -> JSON file path }), reduced to just the fixed vocal
 * identity ({ characterId -> voicePrompt }).
 *
 * The collection's item ids ARE `references[].id` (both key off the same
 * story-bible character id), so no separate id-matching pass is needed — the
 * map key is already the `subjectId` `applyVoiceProfileOverrides` looks up.
 */
function voiceProfileMap(ctx: RunnerContext, key: string | undefined): Record<string, string> | undefined {
  if (!key) return undefined;
  const v = ctx.inputs[key];
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [characterId, pathOrContent] of Object.entries(v as Record<string, unknown>)) {
    try {
      const parsed = typeof pathOrContent === 'object' && pathOrContent
        ? pathOrContent as Record<string, unknown>
        : typeof pathOrContent === 'string'
          ? (JSON.parse(existsSync(pathOrContent) ? readFileSync(pathOrContent, 'utf-8') : pathOrContent) as Record<string, unknown>)
          : undefined;
      const voicePrompt = parsed?.['voicePrompt'];
      if (typeof voicePrompt === 'string' && voicePrompt.trim()) out[characterId] = voicePrompt.trim();
    } catch { /* unreadable/invalid profile — leave this character's voicePrompt unoverridden */ }
  }
  return Object.keys(out).length ? out : undefined;
}

/** Case-insensitive lookup in a collection map. */
function pickFrom(map: Record<string, string> | undefined, id: string): string | undefined {
  if (!map) return undefined;
  return map[id]
    ?? map[id.toLowerCase()]
    ?? Object.entries(map).find(([k]) => k.toLowerCase() === id.toLowerCase())?.[1];
}

/**
 * Named resolution presets, and a `<w>x<h>` escape hatch.
 *
 * Resolution is the one H3 setting an operator genuinely wants to vary PER
 * PROJECT rather than per bundle: cost scales as roughly pixels^1.3 (measured —
 * 832x480 renders a 5s clip in 55s where 1344x768 takes 205s), so you author
 * and iterate cheap and render the final cut at native. Baking it into the
 * bundle's runner config would force every project to share one answer.
 *
 * So the bundle declares a `resolution` PROJECT FIELD and points the runner at
 * it with `resolutionInput`. Declared project fields are merged into every
 * runner's ctx.inputs, which is the sanctioned way for a runner to read a
 * per-project value — no engine change, no config templating.
 *
 * 'native' is H3's own geometry: 768 on the short edge, capped 768x1344.
 */
const RESOLUTION_PRESETS: Record<string, [number, number]> = {
  '480p': [832, 480],
  '540p': [960, 544],
  '720p': [1280, 720],
  '768p': [1344, 768],
  native: [1344, 768],
};

/**
 * Resolve width/height for this render. Precedence: the project's `resolution`
 * field (preset name or `<w>x<h>`), then the node's own width/height config,
 * then H3's native geometry. Always snapped to /32, which the node requires.
 */
export function resolveGeometry(
  resolutionValue: unknown,
  cfgWidth: number | undefined,
  cfgHeight: number | undefined,
): { width: number; height: number; source: string } {
  const snap = (x: number) => Math.max(32, Math.round(x / 32) * 32);
  // `pnpm dhee new --resolution 540` and the desktop's own resolution control
  // both write a NUMBER (540), not the preset string ('540p') this used to
  // require. A number failed the typeof check, fell through to the node's
  // config, and the operator's choice was silently discarded — measured on a
  // real project: project.json said 540 and every clip rendered at 1344x768,
  // ~2.4x the pixels and cost, with nothing in the log saying so. Worse, that
  // is also the geometry that took ComfyUI down on the heaviest clip of the
  // film. Coerce a bare number (or a bare numeric string) to its preset by
  // SHORT EDGE, which is how every one of these presets is named.
  const coerced = typeof resolutionValue === 'number' && Number.isFinite(resolutionValue)
    ? `${Math.round(resolutionValue)}p`
    : typeof resolutionValue === 'string' && /^\s*\d{3,4}\s*$/.test(resolutionValue)
      ? `${resolutionValue.trim()}p`
      : resolutionValue;
  if (typeof coerced === 'string' && coerced.trim()) {
    const v = coerced.trim().toLowerCase();
    const preset = RESOLUTION_PRESETS[v];
    if (preset) return { width: preset[0], height: preset[1], source: `resolution:${v}` };
    const m = /^(\d{2,5})\s*[x×]\s*(\d{2,5})$/.exec(v);
    if (m) return { width: snap(Number(m[1])), height: snap(Number(m[2])), source: `resolution:${v}` };
    // An unrecognised value falls through to config rather than failing the
    // render — a typo in a project field should not lose a whole scene.
  }
  return { width: snap(cfgWidth ?? 1344), height: snap(cfgHeight ?? 768), source: 'config' };
}

/**
 * Snap a raw frame count onto H3's latent-temporal grid: valid lengths are
 * `17k + 5` (5, 22, 39, 56 … 362). This is the same arithmetic the stock
 * ComfyUI template performs in its `ComfyMathExpression` node
 * (`max(5, round(a*24)) + (5 - (… % 17)) % 17`), reimplemented with a TRUE
 * modulo so a remainder above 5 rounds UP to the next block rather than going
 * negative. 15s at 24fps → 360 raw → 362 frames (≈15.08s).
 */
export function snapH3Frames(frames: number): number {
  const base = Math.max(5, Math.round(frames));
  return base + (((5 - (base % 17)) % 17) + 17) % 17;
}

/**
 * Single-GPU lane swap (mirrors dhee-core's gpuCoordinator): when the local LLM
 * shares the GPU with ComfyUI, unload its models before a render so the LLM
 * doesn't evict / OOM the video model. Opt-in via DHEE_SINGLE_GPU=1.
 * Best-effort, never throws.
 */
async function unloadLocalLlmForRender(comfyBaseUrl: string, log: (m: string) => void): Promise<void> {
  const v = process.env['DHEE_SINGLE_GPU'];
  if (v !== '1' && v !== 'true') return;
  let base: string | null = null;
  const explicit = process.env['DHEE_LOCAL_LLM_URL'];
  if (explicit) base = explicit.replace(/\/+$/, '').replace(/\/v1$/, '');
  else { try { const u = new URL(comfyBaseUrl); base = `${u.protocol}//${u.hostname}:8080`; } catch { return; } }
  try {
    const res = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(8000) });
    const data = (await res.json()) as { data?: Array<{ id?: string; status?: { value?: string } }> };
    const loaded = (data.data ?? []).filter((m) => m.status?.value === 'loaded' && m.id).map((m) => m.id!);
    for (const id of loaded) {
      log(`gpu-swap: unloading local LLM "${id}" at ${base} before render`);
      await fetch(`${base}/models/unload`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: id }), signal: AbortSignal.timeout(15000) }).catch(() => {});
    }
  } catch { /* best-effort */ }
}

// ══════════════════════════════════════════════════════════════════════════
// Prompt assembly
// ══════════════════════════════════════════════════════════════════════════

export interface H3Ref {
  /** 1-based position in the authored references[] — lets the runner remap
   *  <Subject N> labels when routing changes the final order. */
  authoredIndex?: number;
  /** story-bible id, for logging + state substitution */
  id: string;
  /** 'character' | 'object' | 'location' | … — routes to a reference collection */
  type: string;
  /** short visual descriptor of what the plate shows */
  appearsAs?: string;
  /** what this reference is FOR in this clip (H3's highest-leverage instruction) */
  job?: string;
  /** absolute path to the resolved plate */
  path: string;
}

/**
 * Build the `<Picture N>` reference-binding clause — H3's single
 * highest-leverage prompting habit ("assign a job to every reference").
 *
 * It has to be built HERE and not by the authoring model, because the authoring
 * model does not know the final slot order: state substitution, background-last
 * routing and the maxRefs cap all happen in this runner, after the prompt was
 * written. So the bundle's schema asks for `appearsAs` + `job` per reference in
 * prose, and this function turns the resolved, ordered list into the tags the
 * model reads. The prose is written with NO slot numbers in it at all.
 */
export function buildBindingClause(refs: H3Ref[]): string {
  if (!refs.length) return '';
  const lines = refs.map((r, i) => {
    const what = (r.appearsAs ?? '').trim();
    const job = (r.job ?? '').trim();
    const tag = `<Picture ${i + 1}>`;
    if (what && job) return `${tag} — ${what}. Use it for ${job}`;
    if (what) return `${tag} — ${what}. Preserve this appearance exactly`;
    if (job) return `${tag} — use it for ${job}`;
    return `${tag} — a reference plate for this scene; preserve its appearance exactly`;
  });
  return [
    'REFERENCES — each one has a single job, and every one of them must be honoured:',
    ...lines.map((l) => `${l}.`),
    'Hold these identities, wardrobes, props and locations consistent through every cut below; do not redesign them between cuts.',
  ].join('\n');
}

/**
 * The literal headings the scene skeleton asks for, in order. Used only for
 * LAYOUT normalisation — never to validate content.
 */
const PROMPT_HEADINGS = ['Scene overview', 'Storyboard', 'Camera', 'Lighting', 'Audio', 'Performance'];

/**
 * Put the authored prompt's blocks back on their own lines.
 *
 * WHY THIS IS IN CODE AND NOT IN THE PROMPT. The scene template gives the model a
 * skeleton with headings and blank lines between blocks, and models emit that
 * layout INCONSISTENTLY inside a JSON string. Measured on one deepseek-v4-flash
 * run over two scenes with the identical template: scene_2 came back with 21
 * newlines and every heading at line start, while scene_1 came back with ZERO
 * newlines -- all six headings and every timecode block run together in a single
 * paragraph separated by double spaces. Same model, same call, same prompt.
 *
 * The content was complete in both. Only the whitespace differed. That is
 * mechanical formatting, so it belongs here rather than in an instruction the
 * model follows half the time -- the same reasoning that puts the '<Picture N>'
 * binding clause in the runner instead of asking the author to number slots.
 *
 * Idempotent: prose that already has its blank lines is returned unchanged
 * (bar collapsing runs of 3+ newlines to 2).
 */
export function normalizePromptLayout(prose: string): string {
  let out = prose.replace(/\r\n?/g, '\n');
  // Each heading starts its own block. Only rewrite when the heading is NOT
  // already at the start of a line, so an already-formatted prompt is untouched.
  for (const h of PROMPT_HEADINGS) {
    // The heading may carry a qualifier before its colon -- the skeleton asks for
    // "Storyboard, one continuous shot:" as well as a bare "Storyboard:" -- so
    // allow anything up to the colon that is not a newline or another colon.
    out = out.replace(
      new RegExp(`([^\\n])[ \\t]*(${h}[^\\n:]{0,40}:)`, 'g'),
      (_m, before: string, head: string) => `${before}\n\n${head}`,
    );
  }
  // Every timecoded block starts its own line: [0s-3s], [0-3 seconds], [3.2s-6.8s].
  out = out.replace(/([^\n])[ \t]*(\[\s*\d+(?:\.\d+)?\s*s?\s*[-–—]\s*\d+(?:\.\d+)?\s*s?\s*(?:seconds?)?\s*\])/g,
    (_m, before: string, tc: string) => `${before}\n\n${tc}`);
  return out.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim();
}

/**
 * Compose the final prompt string sent to the model: the binding clause, then
 * the authored multi-cut prose. Trimmed to H3's ~7,000-character context so a
 * long scene never silently loses its tail — and if it must trim, it trims the
 * PROSE, never the binding clause (dropping a reference's job is worse than
 * dropping the last few words of sound design).
 */
export function composePrompt(bindingClause: string, prose: string, limit = H3_PROMPT_CHAR_LIMIT): { prompt: string; trimmed: number } {
  const head = bindingClause ? `${bindingClause}\n\n` : '';
  const full = `${head}${prose}`;
  if (full.length <= limit) return { prompt: full, trimmed: 0 };
  const room = Math.max(0, limit - head.length);
  return { prompt: `${head}${prose.slice(0, room)}`, trimmed: full.length - limit };
}

/**
 * Reference types that name a PROP or a BACKGROUND rather than a performer.
 * A plate of one of these carries no identity: losing it costs a prop, not a
 * character. Anything else — `character`, or a reference that declares no type
 * at all — is treated as identity and left for the hard gate below.
 */
const PROP_REFERENCE_TYPES = new Set(['object', 'prop', 'location', 'setting', 'environment']);

/** Every id the shots actually put on screen as a performer or a speaker. */
function citedSubjectIds(shots: unknown): Set<string> {
  const cited = new Set<string>();
  if (!Array.isArray(shots)) return cited;
  for (const rawShot of shots) {
    if (!rawShot || typeof rawShot !== 'object' || Array.isArray(rawShot)) continue;
    const shot = rawShot as Record<string, unknown>;
    for (const key of ['acting', 'dialogue']) {
      const rows = shot[key];
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
        const id = (row as Record<string, unknown>)['subjectId'];
        if (typeof id === 'string' && id.trim()) cited.add(id.trim().toLowerCase());
      }
    }
    const subjectIds = shot['subjectIds'];
    if (Array.isArray(subjectIds)) {
      for (const id of subjectIds) if (typeof id === 'string' && id.trim()) cited.add(id.trim().toLowerCase());
    }
  }
  return cited;
}

/**
 * Drop scenery the section is not licensed to show, instead of failing the run.
 *
 * Scenery is the ONE place where a stray id is harmless to remove: it names
 * objects and locations in the background, so losing one costs a prop, while
 * failing costs the whole render — and every scene after it.
 *
 * Measured twice on a real film: a section's prose said "Vashti does not look at
 * the lantern", the lantern was legitimately absent from that section's entity
 * allowlist (it is a rhetorical mention, not a staged prop), and the scene author
 * staged it anyway. A prompt rule telling the author that the allowlist wins was
 * added and did NOT hold — which is this bundle's own repeated finding: prose
 * rules drift, structural ones hold.
 *
 * Scenery lives in TWO places, so both are pruned:
 *   1. `shots[].sceneryIds[]` — the per-cut background list, and
 *   2. `references[]` entries whose `type` is a PROP type and whose id no shot
 *      cites as a performer or speaker.
 * Pruning only (1) was inconsistent — the SAME unlicensed prop was quietly
 * dropped from the shot and then hard-failed one line later from `references`:
 *
 *   ✗ scene_clip[scene_4]: unknown references[2].id="chocolate_bar";
 *     expected IDs: megha, thatha, thatha_cottage_interior
 *
 * — a prop the plan licensed for an EARLIER section, staged again by the author
 * of a later one. Dropping its plate changes no identity, because nothing in the
 * scene acts or speaks as it.
 *
 * Everything else still hard-fails. A `character` reference, a reference with no
 * declared type, a prop id some shot cites as a performer, dialogue `subjectId`
 * and `acting[].subjectId` are identity-critical — silently dropping one of those
 * would change who is in the film, so those are worth stopping for. The last
 * reference is never pruned either: a scene left with zero plates cannot render,
 * and the hard gate's message names the offending id, which an empty
 * `references[]` error would not.
 *
 * Returns the ids it removed so the caller can log them; a silent drop would just
 * be a quieter version of the bug.
 */
export function pruneUnlicensedScenery(scene: unknown, expectedIds: readonly string[]): string[] {
  if (!scene || typeof scene !== 'object' || Array.isArray(scene)) return [];
  const root = scene as Record<string, unknown>;
  const expected = new Set(expectedIds.map((id) => String(id).trim().toLowerCase()).filter(Boolean));
  if (!expected.size) return [];
  const dropped: string[] = [];

  const references = root['references'];
  if (Array.isArray(references) && references.length) {
    const cited = citedSubjectIds(root['shots']);
    const removed: string[] = [];
    const kept = references.filter((rawRef, index) => {
      if (!rawRef || typeof rawRef !== 'object' || Array.isArray(rawRef)) return true;
      const ref = rawRef as Record<string, unknown>;
      const id = typeof ref['id'] === 'string' ? ref['id'].trim() : '';
      if (!id || expected.has(id.toLowerCase())) return true;
      const type = typeof ref['type'] === 'string' ? ref['type'].trim().toLowerCase() : '';
      if (!PROP_REFERENCE_TYPES.has(type)) return true;
      if (cited.has(id.toLowerCase())) return true;
      removed.push(`references[${index}].id="${id}"`);
      return false;
    });
    if (removed.length && kept.length) {
      root['references'] = kept;
      dropped.push(...removed);
    }
  }

  const shots = root['shots'];
  if (Array.isArray(shots)) {
    shots.forEach((rawShot, index) => {
      if (!rawShot || typeof rawShot !== 'object' || Array.isArray(rawShot)) return;
      const shot = rawShot as Record<string, unknown>;
      const scenery = shot['sceneryIds'];
      if (!Array.isArray(scenery)) return;
      const kept = scenery.filter((id) => {
        const ok = typeof id === 'string' && expected.has(id.trim().toLowerCase());
        if (!ok && typeof id === 'string') dropped.push(`shots[${index}].sceneryIds="${id}"`);
        return ok;
      });
      if (kept.length !== scenery.length) shot['sceneryIds'] = kept;
    });
  }

  return dropped;
}

/**
 * Reject structured prompt references that cannot belong to this scene.
 *
 * The authoring schema can validate shape but cannot see the per-scene entity
 * list supplied by `scenes_plan`. Keep this check pure so it can run before any
 * reference image is loaded or any ComfyUI request is queued. `expectedIds` is
 * the authoritative scene-level inventory, not the whole story-bible map.
 *
 * Runs AFTER `pruneUnlicensedScenery`, which has already removed the stray ids
 * that cost only a prop — so everything still standing here is identity.
 */
export function validateStructuredSceneReferences(scene: unknown, expectedIds: readonly string[]): void {
  if (!scene || typeof scene !== 'object' || Array.isArray(scene)) return;
  const root = scene as Record<string, unknown>;
  const expectedDisplay = [...new Set(expectedIds.map((id) => String(id).trim()).filter(Boolean))];
  const expected = new Set(expectedDisplay.map((id) => id.toLowerCase()));
  const unknown: string[] = [];
  const add = (path: string, value: unknown) => {
    if (typeof value !== 'string' || !value.trim()) return;
    const id = value.trim();
    if (!expected.has(id.toLowerCase())) unknown.push(`${path}="${id}"`);
  };

  const references = root['references'];
  if (Array.isArray(references)) {
    references.forEach((reference, index) => {
      if (reference && typeof reference === 'object' && !Array.isArray(reference)) {
        add(`references[${index}].id`, (reference as Record<string, unknown>)['id']);
      }
    });
  }

  const shots = root['shots'];
  if (Array.isArray(shots)) {
    shots.forEach((shot, shotIndex) => {
      if (!shot || typeof shot !== 'object' || Array.isArray(shot)) return;
      const shotRecord = shot as Record<string, unknown>;
      // A shot's visible references live in `subjectIds` (legacy) or, since the
      // acting/scenery split, in `acting[].subjectId` + `sceneryIds[]`. Walk all
      // three so an invented id is caught here whichever shape produced it.
      const subjectIds = shotRecord['subjectIds'];
      if (Array.isArray(subjectIds)) {
        subjectIds.forEach((subjectId, subjectIndex) => {
          add(`shots[${shotIndex}].subjectIds[${subjectIndex}]`, subjectId);
        });
      }
      // sceneryIds is deliberately NOT checked here — pruneUnlicensedScenery()
      // has already removed anything unlicensed, because a stray background prop
      // is worth dropping, not worth killing a run for.
      const acting = shotRecord['acting'];
      if (Array.isArray(acting)) {
        acting.forEach((entry, actingIndex) => {
          if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
            add(`shots[${shotIndex}].acting[${actingIndex}].subjectId`, (entry as Record<string, unknown>)['subjectId']);
          }
        });
      }
      const dialogue = shotRecord['dialogue'];
      if (Array.isArray(dialogue)) {
        dialogue.forEach((line, lineIndex) => {
          if (!line || typeof line !== 'object' || Array.isArray(line)) return;
          // An OFF-SCREEN voice has no visual, so it needs no reference plate —
          // that is the entire point of `offScreen: true`, and the acting checks
          // already honour it. Demanding the speaker be a licensed visible
          // reference killed a finished film on its LAST scene:
          //
          //   ✗ scene_clip[scene_8]: unknown
          //     shots[2].dialogue[0].subjectId="ash_sworn_captain";
          //     expected IDs: sereth_vale, kael, deep_quarries, sereth_sword
          //
          // — a single word ("Sereth.") called from off screen by a pursuer who
          // is deliberately not in the room. `auditDialogueIntegrity` still
          // requires the words and the vocal identity, so an off-screen line
          // cannot become voice-shaped noise; it simply needs no plate.
          if ((line as Record<string, unknown>)['offScreen'] === true) return;
          add(`shots[${shotIndex}].dialogue[${lineIndex}].subjectId`, (line as Record<string, unknown>)['subjectId']);
        });
      }
    });
  }

  if (unknown.length) {
    throw new Error(
      `structured scene reference validation failed: unknown ${unknown.join(', ')}; ` +
      `expected IDs: ${expectedDisplay.length ? expectedDisplay.join(', ') : '(none)'}`,
    );
  }
}

/** Decide whether a prompt document should enter the structured compiler path. */
export function shouldCompileStructuredPrompt(promptDoc: unknown, structuredMode?: string): boolean {
  if (!promptDoc || typeof promptDoc !== 'object' || Array.isArray(promptDoc)) return false;
  const doc = promptDoc as Record<string, unknown>;
  const autoStructured = Array.isArray(doc['references']) && Array.isArray(doc['shots']) && doc['shotStructure'] !== undefined;
  if (autoStructured) return true;
  const modeRequestsStructured = structuredMode === 'structured' || structuredMode === 'schema';
  // Current bundles enable the mode flag, but historical documents may still
  // carry a legacy detailedDescription. Keep those documents readable.
  return modeRequestsStructured && !(typeof doc['detailedDescription'] === 'string' && doc['detailedDescription'].trim());
}

// ══════════════════════════════════════════════════════════════════════════
// Reference routing
// ══════════════════════════════════════════════════════════════════════════

/**
 * Order and cap the resolved references. Subjects keep their authored
 * most-important-first order; anything whose type is in `bgTypes` (default
 * `location`) is moved LAST, so the binding clause reads
 * "…<Picture 3> — the dock at dawn. Use it for the location and light."
 *
 * Unlike LTX MSR, H3 has no documented ordering requirement — the background
 * still goes last purely so the clause reads as a coherent brief and so a
 * bundle can swap between the two renderers without re-authoring its
 * `references[]`. The cap is 9 (H3's real limit), not MSR's 5.
 *
 * When a scene declares only locations and no subjects (a pure establishing
 * beat), the leading locations are promoted into subject slots so a 3-plate
 * landscape scene doesn't collapse into one background.
 */
export function routeRefs(resolved: H3Ref[], bgTypes: Set<string>, maxRefs: number): { refs: H3Ref[]; notes: string[] } {
  const notes: string[] = [];
  const seen = new Set<string>();
  const subjects: H3Ref[] = [];
  const backgrounds: H3Ref[] = [];
  for (const r of resolved) {
    if (seen.has(r.path)) continue;
    seen.add(r.path);
    (bgTypes.has(r.type) ? backgrounds : subjects).push(r);
  }

  let subj = subjects, bg = backgrounds;
  if (subj.length === 0 && bg.length >= 2) {
    subj = bg.slice(0, bg.length - 1);
    bg = bg.slice(bg.length - 1);
    notes.push(`no subjects resolved — promoted ${subj.length} location plate(s) to subject slots (last kept as background)`);
  }

  const cap = Math.max(1, Math.min(H3_MAX_REFS, Math.round(maxRefs)));
  const bgKeep = bg.slice(0, 1);
  const keep = Math.max(1, cap - bgKeep.length);
  if (subj.length > keep) {
    notes.push(`capped ${subj.length}→${keep} subjects (maxRefs ${cap})`);
    subj = subj.slice(0, keep);
  }
  const refs = [...subj, ...bgKeep];
  if (!refs.length) notes.push('0 references resolved — this item declared none that could be found');
  return { refs, notes };
}

/**
 * Decide how many single-view plates each character gets, given the slot budget.
 *
 * WHY THIS EXISTS — the finding that motivated it:
 *
 * `illustrated_story_msr` renders each character anchor as a MULTI-VIEW CONTACT
 * SHEET: one 1536x864 image holding four 384x864 panels of the same person
 * (front full-body, profile, three-quarter, medium close-up) on a plain
 * backdrop. LTX MSR wants that, and the bundle builds it deliberately.
 *
 * H3 does NOT. It reads `<Picture N>` as a literal photograph, so handed a
 * contact sheet it sees "four people standing against a beige wall" and RENDERS
 * THAT LAYOUT INTO THE OUTPUT FRAME — measured in
 * `dhee-cofounder/artifacts/h3-r2v-probe` cell A, where the bottom ~40% of every
 * frame is a reproduction of the sheet with the composed scene squeezed into the
 * top band. It is neither a passthrough (mid-frame SSIM to the plate: 0.38) nor
 * leaked guide frames (the clip was exactly its requested 124 frames) — the
 * model composed an original scene AND painted the sheet in as scenery.
 *
 * The fix uses H3's own affordance: it takes NINE reference slots, so a
 * character never needs compressing into one tiled image. `sheetPanels` tells
 * the runner the character plates ARE N-panel sheets; it crops them and sends
 * the picked panels as SEPARATE references — strictly more usable information
 * than one sheet downscaled into a single slot.
 *
 * The budget is the interesting part. Expansion multiplies subjects, so a
 * three-character scene at 2 views each is already 6 slots before the object and
 * the location. This walks the views-per-character down (never below 1) until
 * the expanded set fits, so a crowded scene degrades to one view each rather
 * than silently dropping a character.
 */
export function planSheetExpansion(
  characterCount: number,
  otherCount: number,
  wantViews: number,
  maxRefs: number,
): { views: number; total: number; degraded: boolean } {
  const cap = Math.max(1, Math.min(H3_MAX_REFS, Math.round(maxRefs)));
  const want = Math.max(1, Math.round(wantViews));
  if (characterCount === 0) return { views: want, total: otherCount, degraded: false };
  let views = want;
  while (views > 1 && characterCount * views + otherCount > cap) views--;
  return { views, total: characterCount * views + otherCount, degraded: views < want };
}

/**
 * Crop `pick` panels out of an N-panel horizontal contact sheet and return them
 * as separate references, in place of the sheet. Panels are equal-width slices
 * across the full height, matching how the bundle lays its identity sheets out.
 *
 * Falls back to the original sheet for any reference whose size cannot be probed
 * or whose crop fails — a slightly-wrong reference beats dropping the character.
 */
async function expandSheetRefs(
  refs: H3Ref[],
  opts: { panels: number; pick: number[]; views: number; scratchDir: string; sheetTypes: Set<string> },
  log: (m: string) => void,
  signal?: AbortSignal,
): Promise<{ refs: H3Ref[]; notes: string[] }> {
  const notes: string[] = [];
  if (opts.panels < 2) return { refs, notes };
  await mkdir(opts.scratchDir, { recursive: true });

  const out: H3Ref[] = [];
  for (const r of refs) {
    if (!opts.sheetTypes.has(r.type)) { out.push(r); continue; }
    const size = await probeSize(r.path, signal);
    if (!size || size.w < opts.panels * 32) {
      notes.push(`${r.id}: not splittable (size ${size ? `${size.w}x${size.h}` : 'unknown'}) — sent whole`);
      out.push(r);
      continue;
    }
    const panelW = Math.floor(size.w / opts.panels);
    const wanted = opts.pick.filter((i) => i >= 0 && i < opts.panels).slice(0, opts.views);
    const idxs = wanted.length ? wanted : [0];
    const made: H3Ref[] = [];
    for (const i of idxs) {
      const dest = join(opts.scratchDir, `${r.id.replace(/[^a-zA-Z0-9_-]/g, '_')}_v${i}.png`);
      const res = await ff(['-y', '-i', r.path, '-vf', `crop=${panelW}:${size.h}:${i * panelW}:0`, '-frames:v', '1', dest], signal);
      if (!res.ok || !existsSync(dest)) { notes.push(`${r.id}: panel ${i} crop failed`); continue; }
      made.push({
        ...r,
        id: `${r.id}#v${i}`,
        path: dest,
        appearsAs: r.appearsAs ? `${r.appearsAs} (view ${made.length + 1})` : undefined,
      });
    }
    if (!made.length) { notes.push(`${r.id}: every panel crop failed — sent the whole sheet`); out.push(r); continue; }
    notes.push(`${r.id}: sheet split into ${made.length} view(s) [${idxs.join(',')}]`);
    out.push(...made);
  }
  if (notes.length) log(`comfy.minimax_h3_r2v: ${notes.join('; ')}`);
  return { refs: out, notes };
}

interface ShotRow { id?: string; scene?: number; duration?: number; speaker?: string | null; dialogue?: string | null }
interface ShotPlanSection { id?: string; entities?: unknown; references?: unknown }
interface ShotPlan { shots?: ShotRow[]; sections?: ShotPlanSection[]; entities?: unknown; references?: unknown }

function readShotPlan(ctx: RunnerContext, cfg: Record<string, unknown>): ShotPlan | undefined {
  const plan = readJsonInput(ctx, rs(cfg, 'shotPlanInput'));
  return plan && typeof plan === 'object' ? (plan as ShotPlan) : undefined;
}

/** Shot rows belonging to `itemId` — either the one shot with that id, or (when
 *  the item is a SECTION like `scene_3`) every `scene_3_shot_*` row. */
export function shotsForItem(plan: ShotPlan | undefined, itemId: string): ShotRow[] {
  const shots = Array.isArray(plan?.shots) ? plan!.shots! : [];
  if (!itemId) return [];
  const exact = shots.find((s) => s?.id === itemId);
  if (exact) return [exact];
  const prefix = `${itemId}_shot_`;
  const byPrefix = shots.filter((s) => typeof s?.id === 'string' && s.id.startsWith(prefix));
  if (byPrefix.length) return byPrefix;
  const m = /^scene_(\d+)$/.exec(itemId);
  if (m) {
    const n = Number(m[1]);
    return shots.filter((s) => s?.scene === n);
  }
  return [];
}

/**
 * Derive the authoritative reference inventory for one scene before resolving
 * image files. `scenes_plan.sections[].entities` is preferred because it is
 * per-scene; the reference-input collection keys are a fallback for bundles
 * that do not pass the complete plan into the render node.
 */
/**
 * Give a section a LOCATION when the planner licensed it none.
 *
 * Every scene happens somewhere, and H3 needs a background plate — the bundle
 * routes exactly one, chosen by `bgTypes: ['location']`. But `section.entities`
 * is authored per scene, and a model writing a tight close-up ("the flame
 * passes across") reasonably lists only the people and the prop. The scene then
 * has no background at all, and the scene author — who can see the prose and
 * knows the scene is on the steps — cites the location anyway and the run dies:
 *
 *   ✗ scene_clip[scene_4]: unknown references[3].id="shiokaze_steps";
 *     expected IDs: hina, lantern_spirit, oil_lamp
 *
 * Relaxing the check would let the scene render with no background. Instead the
 * location is INHERITED from the nearest preceding section that has one, which
 * is both what continuity wants and what the prose meant. Falls back to the
 * next following section, then to the film's only location.
 *
 * Deliberately narrow: it fires ONLY when the section licenses no location at
 * all. A section that names one keeps exactly what it named, so this cannot
 * smuggle a second background in.
 */
function backfillSectionLocation(
  ctx: RunnerContext,
  cfg: Record<string, unknown>,
  plan: ShotPlan | undefined,
  itemId: string,
  ids: string[],
): string[] {
  const bgTypes = Array.isArray(cfg['bgTypes']) ? (cfg['bgTypes'] as unknown[]).map(String) : ['location'];
  const refInputs = cfg['referenceInputs'];
  if (!refInputs || typeof refInputs !== 'object' || Array.isArray(refInputs)) return ids;
  const knownLocations = new Set<string>();
  for (const type of bgTypes) {
    const inputId = (refInputs as Record<string, unknown>)[type];
    if (typeof inputId !== 'string') continue;
    const value = ctx.inputs[inputId];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const id of Object.keys(value as Record<string, unknown>)) knownLocations.add(id);
    }
  }
  if (!knownLocations.size) return ids;
  if (ids.some((id) => knownLocations.has(id))) return ids;

  const sections = plan?.sections ?? [];
  const here = sections.findIndex((s) => s?.id === itemId);
  const locationOf = (i: number): string | undefined => {
    const raw = sections[i] as { entities?: unknown; references?: unknown } | undefined;
    const list = raw && (Array.isArray(raw.entities) ? raw.entities : raw.references);
    if (!Array.isArray(list)) return undefined;
    for (const v of list) {
      const id = typeof v === 'string' ? v : undefined;
      if (id && knownLocations.has(id.trim())) return id.trim();
    }
    return undefined;
  };
  let inherited: string | undefined;
  for (let i = here - 1; i >= 0 && !inherited; i -= 1) inherited = locationOf(i);
  for (let i = here + 1; i < sections.length && !inherited; i += 1) inherited = locationOf(i);
  if (!inherited && knownLocations.size === 1) [inherited] = [...knownLocations];
  if (!inherited) return ids;
  ctx.log(`comfy.minimax_h3_r2v: ${itemId}: no location in this section's entities — inherited '${inherited}' so the scene has a background`);
  return [...ids, inherited];
}

function expectedSceneReferenceIds(
  ctx: RunnerContext,
  cfg: Record<string, unknown>,
  plan: ShotPlan | undefined,
  itemId: string,
): string[] | undefined {
  const section = plan?.sections?.find((candidate) => candidate?.id === itemId);
  const sectionValues = section && (Array.isArray(section.entities) ? section.entities : section.references);
  if (Array.isArray(sectionValues)) {
    const ids = sectionValues.flatMap((value) => {
      if (typeof value === 'string') return [value];
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const id = (value as Record<string, unknown>)['id'];
        return typeof id === 'string' ? [id] : [];
      }
      return [];
    }).map((id) => id.trim()).filter(Boolean);
    return [...new Set(backfillSectionLocation(ctx, cfg, plan, itemId, ids))];
  }

  const rootValues = plan && (Array.isArray(plan.entities) ? plan.entities : plan.references);
  if (Array.isArray(rootValues)) {
    const ids = rootValues.flatMap((value) => {
      if (typeof value === 'string') return [value];
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const id = (value as Record<string, unknown>)['id'];
        return typeof id === 'string' ? [id] : [];
      }
      return [];
    }).map((id) => id.trim()).filter(Boolean);
    if (ids.length) return [...new Set(ids)];
  }

  const refInputs = cfg['referenceInputs'];
  if (!refInputs || typeof refInputs !== 'object' || Array.isArray(refInputs)) return undefined;
  const ids = new Set<string>();
  for (const rawInput of Object.values(refInputs as Record<string, unknown>)) {
    const inputIds = Array.isArray(rawInput) ? rawInput : [rawInput];
    for (const rawId of inputIds) {
      if (typeof rawId !== 'string' || !rawId.trim()) continue;
      const value = ctx.inputs[rawId];
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const id of Object.keys(value as Record<string, unknown>)) ids.add(id);
      } else if (typeof value === 'string' && value.trim()) {
        // Stage outputs are keyed by their input id, as collectionMap() does.
        ids.add(rawId);
      }
    }
  }
  return ids.size ? [...ids] : undefined;
}

/**
 * How many seconds this clip runs, in precedence order:
 *   1. the authored prompt document's own `duration` (the scene prompt owns its
 *      pacing — it wrote the timecoded shot list, so it knows how long it is),
 *   2. the shot plan: this item's own duration, or the SUM of its section's
 *      shots when the item is a section (that sum is exactly the screen time
 *      the planner budgeted for the beat — H3 now renders it as one multi-cut
 *      clip instead of N concatenated ones),
 *   3. `cfg.seconds`, else `cfg.length / fps`.
 *
 * BEFORE the final clamp, a deterministic dialogue FLOOR is applied: H3
 * generates audio from the prompt and stretches/compresses the spoken line to
 * fill exactly the clip (measured 2026-08-04 across 7 H3 renders — see
 * `speechSecondsFor` above), so an authored/plan/fallback duration shorter
 * than what the dialogue actually needs would either pad dead air or truncate
 * the line. `planShots[].dialogue` (the same field `auditDialogueIntegrity`
 * reads) is measured via `speechSecondsFor`, and `raw` is raised to that floor
 * when the floor is larger — never shrunk, only raised. `source` gets a
 * `+speechFloor(Ns)` suffix when the floor is what won, so run.log shows why a
 * clip got longer. Always clamped to the caller's `minSeconds..maxSeconds`
 * window; when the dialogue floor itself exceeds `maxSeconds`, that section
 * cannot hold its dialogue as one H3 clip — `speechFloorSec` is still
 * returned so the caller can log a loud warning (the render proceeds at the
 * clamp regardless; a fatal here would kill a whole run for something only an
 * upstream re-plan can fix).
 */
export function resolveSeconds(
  authored: number | undefined,
  planShots: ShotRow[],
  fallbackSeconds: number,
  minSeconds: number,
  maxSeconds: number,
  sceneSpokenLines?: unknown,
  authoredSpeechSeconds?: number,
): { seconds: number; source: string; clamped: boolean; speechFloorSec?: number } {
  // The SCENE's own ledger beats the plan's when present: `spokenLines` is the
  // exact-word list the render will actually speak, and the scene author may
  // legitimately have merged, split or re-punctuated what the plan proposed.
  const sceneLines = Array.isArray(sceneSpokenLines)
    ? sceneSpokenLines.map((l) => String(l ?? '').trim()).filter(Boolean)
    : [];
  let raw: number | undefined = undefined;
  let source = 'fallback';
  if (typeof authored === 'number' && Number.isFinite(authored) && authored > 0) { raw = authored; source = 'prompt'; }
  if (raw === undefined && planShots.length) {
    const sum = planShots.reduce((a, s) => a + (typeof s?.duration === 'number' && Number.isFinite(s.duration) && s.duration > 0 ? s.duration : 0), 0);
    if (sum > 0) { raw = sum; source = planShots.length > 1 ? `plan(sum of ${planShots.length} shots)` : 'plan'; }
  }
  if (raw === undefined) raw = fallbackSeconds;

  const planLines = planShots
    .map((s) => (typeof s?.dialogue === 'string' ? s.dialogue.trim() : ''))
    .filter((l) => l.length > 0);
  const dialogueLines = sceneLines.length ? sceneLines : planLines;
  let speechFloorSec: number | undefined;
  if (dialogueLines.length) {
    speechFloorSec = speechSecondsFor(dialogueLines, authoredSpeechSeconds);
    if (speechFloorSec > raw) {
      raw = speechFloorSec;
      source = `${source}+speechFloor(${speechFloorSec.toFixed(2)}s)`;
    }
  }

  const seconds = Math.min(maxSeconds, Math.max(minSeconds, raw));
  return { seconds, source, clamped: Math.abs(seconds - raw) > 1e-6, speechFloorSec };
}

/**
 * Resolve this item's ordered references from the prompt document's
 * `references[]`, substituting a character's per-state EDITED plate when the
 * state ledger says this beat is in a changed state.
 *
 * The state plan is keyed `byShot[shotId][characterId] -> stateId`. When the
 * item is a whole SECTION there is no `byShot[scene_3]` entry, so the states of
 * the section's own shots are merged in shot order and the LAST one wins — the
 * scene ends in the state its final shot is in, and a mid-scene change is
 * carried by the prose rather than by two different plates of one character
 * (H3 renders the whole scene in one pass, so it can only hold one plate per
 * character).
 */
/**
 * Operator-supplied reference plates, pinned onto EVERY clip.
 *
 * `referenceInputs` resolves the prompt's own `references[]` by id, which means a
 * plate only reaches a clip if the authoring model chose to cite it. That is right
 * for generated anchors — the model knows which characters are in its scene — but
 * wrong for a real photograph the operator hands the bundle: "use this actress's
 * actual face" is not a per-scene creative decision, it is a constraint on the
 * whole film, and the model has no way to know the input exists.
 *
 * So these bypass `references[]` entirely and are PREPENDED to the resolved list.
 * Prepending is what makes them override rather than merely add: routeRefs dedupes
 * by path, splits on bgTypes, and keeps only the FIRST background — so a pinned
 * `location` photo displaces the generated location plate, and pinned `character`
 * photos take the earliest subject slots and therefore survive the maxRefs cap and
 * get the lowest `<Subject N>` numbers. No change to routeRefs was needed.
 *
 * Each entry needs `appearsAs` and `job` because H3's highest-leverage instruction
 * is what a plate is FOR, and an operator photo has no story-bible entry to borrow
 * that from. A missing file is skipped with a note rather than failing: these
 * inputs are optional by design, and an absent photo should just mean "use the
 * generated anchors", not "halt the film".
 */
/**
 * Which reference types count as BACKGROUND (kept last, and only one survives).
 * Shared so the pinned-plate merge classifies with the SAME set resolveRefs uses —
 * otherwise a bundle overriding `bgTypes` would have it apply to routed refs but
 * not pinned ones, and a pinned location photo would be routed as a subject.
 */
function bgTypesOf(cfg: Record<string, unknown>): Set<string> {
  const rawBg = cfg['bgTypes'];
  return new Set(
    (Array.isArray(rawBg) ? rawBg.filter((t): t is string => typeof t === 'string') : ['location', 'setting'])
      .map((t) => t.toLowerCase()),
  );
}

interface PinnedRefSpec {
  input?: unknown;
  type?: unknown;
  appearsAs?: unknown;
  job?: unknown;
}

function pinnedRefs(ctx: RunnerContext, cfg: Record<string, unknown>): { refs: H3Ref[]; notes: string[] } {
  const raw = cfg['pinnedRefs'];
  if (!Array.isArray(raw) || !raw.length) return { refs: [], notes: [] };
  const refs: H3Ref[] = [];
  const notes: string[] = [];
  for (const entry of raw as PinnedRefSpec[]) {
    const key = typeof entry?.input === 'string' ? entry.input.trim() : '';
    if (!key) continue;
    const v = ctx.inputs[key];
    // A declared file input arrives as a plain string path. Anything else (an
    // unsupplied optional input is undefined/null) simply means "not provided".
    if (typeof v !== 'string' || !v.trim()) continue;
    if (!IMAGE_RE.test(v) || !existsSync(v)) {
      notes.push(`pinned '${key}' skipped (not a readable image: ${v})`);
      continue;
    }
    refs.push({
      id: key,
      type: typeof entry.type === 'string' && entry.type.trim() ? entry.type.trim() : 'character',
      appearsAs: typeof entry.appearsAs === 'string' ? entry.appearsAs : undefined,
      job: typeof entry.job === 'string' ? entry.job : undefined,
      path: v,
    });
  }
  if (refs.length) notes.push(`pinned ${refs.length} operator plate(s): ${refs.map((r) => `${r.id}[${r.type}]`).join(', ')}`);
  return { refs, notes };
}

function resolveRefs(ctx: RunnerContext, cfg: Record<string, unknown>, planShots: ShotRow[]): { refs: H3Ref[]; notes: string[] } {
  const refInputs = cfg['referenceInputs'];
  if (!refInputs || typeof refInputs !== 'object' || Array.isArray(refInputs)) return { refs: [], notes: [] };
  const typeToInput = refInputs as Record<string, string | string[]>;
  if (!Object.keys(typeToInput).length) return { refs: [], notes: [] };

  /**
   * Resolve one type to a MERGED collection map across every input id listed
   * for it. Array order is precedence — the first id's entries win, a later
   * id in the list never shadows an earlier one — so a bundle can list a
   * single-image stage alongside a real scope:'all' anchor collection under
   * the same reference type without one clobbering the other.
   */
  const mapForType = (type: string): Record<string, string> | undefined => {
    const ids = typeToInput[type];
    const list = Array.isArray(ids) ? ids : ids ? [ids] : [];
    let merged: Record<string, string> | undefined;
    for (const id of list) {
      const m = collectionMap(ctx, id);
      if (!m) continue;
      merged = merged ? { ...m, ...merged } : { ...m };
    }
    return merged;
  };

  const promptDoc = readJsonInput(ctx, rs(cfg, 'promptInput')) as { references?: H3Ref[] } | undefined;
  const declared = Array.isArray(promptDoc?.references) ? promptDoc!.references! : [];
  if (!declared.length) return { refs: [], notes: [] };

  const statePlan = readJsonInput(ctx, rs(cfg, 'statePlanInput')) as
    { byShot?: Record<string, Record<string, string>> } | undefined;
  const stateImages = collectionMap(ctx, rs(cfg, 'stateImagesInput'));
  const byShot = statePlan?.byShot ?? {};
  const itemId = ctx.itemId ?? '';
  let byChar: Record<string, string> = byShot[itemId] ?? {};
  if (!byShot[itemId] && planShots.length) {
    // section item: merge its shots' states in order, last wins.
    byChar = {};
    for (const s of planShots) {
      const row = s?.id ? byShot[s.id] : undefined;
      if (row) Object.assign(byChar, row);
    }
  }

  const bgTypes = bgTypesOf(cfg);

  const resolved: H3Ref[] = [];
  const notes: string[] = [];
  for (const r of declared) {
    const id = typeof r?.id === 'string' ? r.id.trim() : '';
    const type = typeof r?.type === 'string' ? r.type.trim().toLowerCase() : '';
    if (!id || !type) continue;

    let picked: string | undefined;
    if (type === 'character') {
      const stateId = byChar[id] ?? pickFrom(byChar, id);
      if (stateId) {
        picked = pickFrom(stateImages, stateId);
        if (picked) notes.push(`${id}→state:${stateId}`);
      }
    }
    if (!picked) {
      picked = pickFrom(mapForType(type), id);
      if (picked) notes.push(`${id}→anchor`);
    }
    if (!picked) { notes.push(`${id}(${type}) UNRESOLVED`); continue; }
    resolved.push({
      id, type, path: picked, authoredIndex: resolved.length + 1,
      appearsAs: typeof r?.appearsAs === 'string' ? r.appearsAs : undefined,
      job: typeof r?.job === 'string' ? r.job : undefined,
    });
  }

  const routed = routeRefs(resolved, bgTypes, rn(cfg, 'maxRefs') ?? H3_MAX_REFS);
  return { refs: routed.refs, notes: [...notes, ...routed.notes] };
}

/** Explicit ordered reference paths from cfg.refImages (project dir, then bundle dir). */
function explicitRefImages(ctx: RunnerContext, cfg: Record<string, unknown>): H3Ref[] {
  const list = cfg['refImages'];
  if (!Array.isArray(list) || list.length === 0) return [];
  const out: H3Ref[] = [];
  for (const raw of list) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const p = raw.trim();
    const candidates: string[] = [];
    if (isAbsolute(p)) candidates.push(p);
    else {
      const inProj = projAbs(ctx.projectDir, p);
      if (inProj) candidates.push(inProj);
      if (ctx.bundleDir) candidates.push(resolve(ctx.bundleDir, p));
    }
    const hit = candidates.find((c) => existsSync(c) && IMAGE_RE.test(c));
    if (hit) out.push({ id: basename(hit), type: 'image', path: hit });
    else ctx.log(`comfy.minimax_h3_r2v: refImages entry not found / not an image: ${p}`);
  }
  return out;
}

/** Resolve the prose from a prompt input that may be text or a JSON document. */
function resolvePromptText(ctx: RunnerContext, cfg: Record<string, unknown>): string | undefined {
  const key = rs(cfg, 'promptInput');
  if (!key) return undefined;
  const named = rs(cfg, 'promptField');
  const fields = named ? [named] : ['videoPrompt', 'prompt', 'imagePrompt', 'text'];
  const v = ctx.inputs[key];
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const rec = v as Record<string, unknown>;
    for (const f of fields) { const s = rec[f]; if (typeof s === 'string' && s.trim()) return s.trim(); }
    return undefined;
  }
  const txt = readText(ctx, key);
  if (!txt) return undefined;
  if (txt.startsWith('{')) {
    try {
      const rec = JSON.parse(txt) as Record<string, unknown>;
      for (const f of fields) { const s = rec[f]; if (typeof s === 'string' && s.trim()) return s.trim(); }
    } catch { /* not JSON after all */ }
  }
  return txt;
}

/**
 * Pad a rendered AV clip with a HELD frame + silence at head and/or tail, so a
 * line of dialogue isn't cut off the instant the clip ends and concatenated
 * scenes get breathing room. No-op when both pads are ≤0. Returns false on
 * ffmpeg failure (caller keeps the unpadded clip rather than dropping the scene).
 */
async function padClip(path: string, padStart: number, padEnd: number, signal?: AbortSignal): Promise<boolean> {
  const ps = Math.max(0, padStart), pe = Math.max(0, padEnd);
  if (ps <= 0 && pe <= 0) return true;
  const tmp = `${path}.pad.mp4`;
  const vf = `tpad=start_duration=${ps.toFixed(3)}:start_mode=clone:stop_duration=${pe.toFixed(3)}:stop_mode=clone`;
  const af = `adelay=${Math.round(ps * 1000)}:all=1,apad=pad_dur=${pe.toFixed(3)}`;
  const r = await ff(['-y', '-i', path, '-vf', vf, '-af', af, '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', tmp], signal);
  if (!r.ok || !existsSync(tmp)) return false;
  try { const { renameSync } = await import('node:fs'); renameSync(tmp, path); return true; } catch { return false; }
}

// ══════════════════════════════════════════════════════════════════════════
// Runner — comfy.minimax_h3_r2v
// ══════════════════════════════════════════════════════════════════════════
const H3_MANIFEST: RunnerManifest = {
  tool: 'comfy.minimax_h3_r2v',
  version: '0.3.2',
  engineCompat: '>=0.1.0',
  credentials: [],
  displayName: 'MiniMax H3 Reference-to-Video (multi-cut AV clip)',
  description: 'Render ONE clip of up to 15s at 24fps with native stereo audio and SEVERAL CUTS inside it, from up to 9 reference plates, via ComfyUI\'s MiniMaxH3ReferenceToVideo node. Builds the <Picture N> reference-binding clause deterministically from each reference\'s appearsAs/job, snaps duration to the 17k+5 frame grid, and substitutes per-state character plates the way comfy.ltx_msr does.',
  entry: 'dist/index.js',
  permissions: {
    network: ['<comfy-endpoint-host>'], filesystem: 'project', subprocess: true,
    env: ['DHEE_FFMPEG', 'DHEE_FFPROBE', 'COMFYUI_BASE_URL', 'ENDPOINT_self_local', 'DHEE_SINGLE_GPU', 'DHEE_LOCAL_LLM_URL'],
  },
};

const H3_DESC: RunnerDescription = {
  id: 'comfy.minimax_h3_r2v',
  displayName: 'MiniMax H3 R2V',
  description: 'MiniMax H3 (Hailuo 03) reference-to-video: one multi-cut clip up to 15s with native synced stereo audio, from up to 9 reference images.',
  capabilities: ['comfyui', 'video', 'audio', 'multi-cut', 'multi-subject-reference', 'character-consistency'],
  modalities: { input: ['image', 'text'], output: ['video'] },
  costHint: 'local_gpu',
  configSchema: {
    type: 'object',
    required: ['outputPath', 'workflowPath'],
    properties: {
      outputPath: { type: 'string' },
      workflowPath: { type: 'string', description: 'API-format H3 graph in the bundle. Must contain MiniMaxH3ReferenceToVideo; its ref_images.* inputs are rebuilt by this runner.' },
      endpoint: { type: 'string', description: 'Comfy endpoint label (default self.local).' },

      promptInput: { type: 'string', description: 'Input id of the authored prompt document (JSON) or text. JSON is read via promptField.' },
      promptField: { type: 'string', description: "Prose field on a JSON promptInput (default: tries videoPrompt, prompt, imagePrompt, text)." },
      structuredMode: { type: 'string', enum: ['legacy', 'structured', 'schema'], description: "Compile a structured scene JSON object into the canonical six-section H3 prompt before render. The runner also auto-detects a document containing references, shots and shotStructure." },
      strictPerformance: { type: 'boolean', description: 'Require the ACTING performance root and one matching observable adaptation for every character-visible shot before any reference resolution or ComfyUI request.' },
      spokenLinesField: { type: 'string', description: "Optional array field on the authored prompt document containing exactly one verbatim spoken line. When configured and detailedDescription contains no <d> block, the runner deterministically inserts `<Subject 1> (S1) says: <d>[Language] exact words</d>` before auditing and rendering." },
      dialogueLanguageInput: { type: 'string', description: 'Project input id holding the language label used by spokenLinesField injection (for example `language`).' },
      dialogueLanguage: { type: 'string', description: 'Literal fallback language label for spokenLinesField injection when dialogueLanguageInput is unset or empty.' },
      prompt: { type: 'string', description: 'Literal prose, overriding promptInput. Mostly for probes.' },
      durationField: { type: 'string', description: "Numeric seconds field on the prompt document (default 'duration'). Highest-precedence duration source — the scene prompt wrote the timecoded shot list, so it owns its own length." },
      bindingClause: { type: 'boolean', description: "Prepend the deterministic '<Picture N> — <appearsAs>. Use it for <job>' clause (default true). H3's single highest-leverage instruction; turn it off only when the prose already carries its own slot assignments." },

      referenceInputs: { type: 'object', description: "PER-ITEM routing. Maps a references[].type -> a scope:'all' collection input id (or an ARRAY of input ids, merged in order — first id's entries win), e.g. { character: 'character_anchor_image', object: 'object_anchor_image', location: 'location_anchor_image' }. Resolves the prompt document's references[] by id, in authored order. An entry may ALSO point at a STAGE node (a plain string path in ctx.inputs, not a collection map) — e.g. { character: 'host_frame' } where host_frame is a comfy.image_edit stage's output. In that case the runner treats it as a one-entry map keyed by the input id itself, which means the authored references[].id for that type MUST be the literal INPUT/NODE ID ('host_frame'), never a story-bible id — there is no other key to resolve against." },
      pinnedRefs: { type: 'array', items: { type: 'object' }, description: "Operator-supplied plates pinned onto EVERY clip, bypassing the prompt's references[] entirely: [{ input, type, appearsAs, job }]. `input` is a declared bundle input id holding a single image path (kind:'file'); `type` routes it like any other reference ('character' | 'object' | 'location'). Use this for a real photograph the operator hands the bundle — an actress's actual face, a real location — which is a constraint on the whole film rather than a per-scene choice the authoring model could know to cite. Pinned plates are PREPENDED before routing, which is what makes them OVERRIDE the generated anchors: routeRefs dedupes by path, keeps only the first background (so a pinned location displaces the generated one) and fills subject slots in order (so pinned characters survive the maxRefs cap and take the lowest <Subject N> numbers). An unsupplied or unreadable input is skipped with a note, never a failure — these are optional by design and an absent photo means 'use the generated anchors'." },
      refImages: { type: 'array', items: { type: 'string' }, description: 'Explicit ORDERED reference paths (subjects first, location LAST), relative to the project then the bundle. Used when referenceInputs resolves nothing.' },
      statePlanInput: { type: 'string', description: 'plan.character_states output. byShot[shotId][characterId] -> stateId picks each character\'s appearance state; for a SECTION item the states of its own shots are merged in order, last wins.' },
      voiceProfileInput: { type: 'string', description: "scope='all' collection input id of character_acting_profile outputs ({ characterId -> JSON path }, keyed by the same id as references[].id). When set, the runner overwrites any dialogue line's voicePrompt that does not match that character's profile verbatim — logging the mismatch rather than failing the render — instead of trusting whatever the authoring model wrote per line (#10: a fixed per-character fact, demonstrably not copied correctly across many lines)." },
      stateImagesInput: { type: 'string', description: "scope='all' map of EDITED per-state character images ({ stateId: path }). Falls back to the base anchor when a state has no image." },
      bgTypes: { type: 'array', items: { type: 'string' }, description: "references[].type values treated as background/scene and moved LAST. Default ['location','setting']." },
      maxRefs: { type: 'integer', description: 'Cap on total references, 1..9 (H3 supports 9). Background keeps its slot; lowest-priority subjects drop first. Default 9.' },

      sheetPanels: { type: 'integer', description: "N if the character plates are N-panel horizontal multi-view identity SHEETS (illustrated_story_* renders 4). Default 0 = off. H3 reads a reference as a literal photograph, so a contact sheet gets RENDERED INTO THE FRAME as several people against a backdrop (measured: h3-r2v-probe cell A). Setting this makes the runner crop the sheet and send the picked panels as separate references, which is what H3's 9 slots are for." },
      sheetTypes: { type: 'array', items: { type: 'string' }, description: "references[].type values whose plates are sheets. Default ['character']." },
      sheetPick: { type: 'array', items: { type: 'integer' }, description: 'Panel indices to use, in order, 0-based left to right. Default [0, sheetPanels-1] — the first full-body view and the close-up, the two most informative panels of the standard layout.' },
      viewsPerCharacter: { type: 'integer', description: 'How many panels to send per sheet subject (default 2). Walked down automatically, never below 1, when the expanded set would overflow maxRefs — so a crowded scene degrades to one view each rather than dropping a character.' },

      shotPlanInput: { type: 'string', description: 'Shot-plan JSON input id. For a shot item, that shot\'s duration; for a SECTION item, the SUM of the section\'s shots\' durations.' },
      seconds: { type: 'number', description: 'Fallback clip seconds when nothing else resolves (default 10).' },
      minSeconds: { type: 'number', description: "H3's floor, default 5." },
      maxSeconds: { type: 'number', description: "H3's ceiling, default 15." },
      fps: { type: 'number', description: 'Default 24 — H3 is a 24fps model; changing this changes only the frame math, not the output rate.' },

      width: { type: 'integer', description: 'Default 1344. H3 renders natively at 768 on the short edge, capped 768x1344, snapped to /32. Overridden by resolutionInput when the project sets it.' },
      height: { type: 'integer', description: 'Default 768.' },
      resolutionInput: { type: 'string', description: "Input id of a PROJECT FIELD holding the render resolution — a preset ('480p', '540p', '720p', '768p', 'native') or an explicit '<w>x<h>'. Takes precedence over width/height so an operator can author cheap and render the final cut at native without editing the bundle; cost scales as ~pixels^1.3, so 480p is ~3.7x faster than native. An unrecognised value falls back to width/height rather than failing the render." },
      refImageSize: { type: 'string', enum: ['match', 'max'], description: "'match' scales references to the generation resolution (faster); 'max' preserves up to 2048px short edge (stronger identity, slower). Default 'match'." },
      steps: { type: 'integer', description: 'Fixed sampler steps. Omit (or set stepsAuto) to scale with scene complexity between minSteps and maxSteps. The turbo LoRA is distilled to a low step count — 8 was measured to attenuate generated audio ~15 dB.' },
      stepsInput: { type: 'string', description: "Input id of a PROJECT FIELD holding the step count — a number, or 'auto' to scale with scene complexity. Takes precedence over steps/stepsAuto so an operator can pin a count for one project without editing the bundle. An unrecognised value falls back to the config." },
      stepsAuto: { type: 'boolean', description: 'Scale steps with scene complexity (cuts, references, dialogue lines, duration) between minSteps and maxSteps. Default true when `steps` is not set.' },
      minSteps: { type: 'integer', description: 'Floor for auto steps. Default 4 — the turbo LoRA\'s distilled step count.' },
      maxSteps: { type: 'integer', description: 'Ceiling for auto steps. Default 10.' },
      samplerName: { type: 'string', description: "Default 'res_multistep'." },
      scheduler: { type: 'string', description: "Default 'simple' — the founder-tested scheduler for the canonical INT8 + MiniMaxH3Cache graph." },
      seed: { type: 'integer', description: 'Base seed; the per-item seed is derived from it + the item id so a rerun is stable but scenes differ.' },

      cache: { type: 'boolean', description: 'Keep a MiniMaxH3Cache or legacy EasyCache node when present (default true). false removes it and rewires downstream model consumers to its upstream model.' },
      cacheThreshold: { type: 'number', description: 'Cache threshold override. Writes MiniMaxH3Cache.resuse_threshold (intentional node spelling) or legacy EasyCache.reuse_threshold.' },
      cacheStart: { type: 'number', description: 'Cache start_percent override.' },
      cacheEnd: { type: 'number', description: 'Cache end_percent override.' },
      cacheMaxSteps: { type: 'integer', description: 'MiniMaxH3Cache max_steps override.' },
      easyCache: { type: 'boolean', description: 'Legacy alias for cache.' },
      easyCacheThreshold: { type: 'number', description: 'Legacy alias for cacheThreshold.' },
      easyCacheStart: { type: 'number', description: 'Legacy alias for cacheStart.' },
      easyCacheEnd: { type: 'number', description: 'Legacy alias for cacheEnd.' },
      easyCacheMaxSteps: { type: 'integer', description: 'Legacy alias for cacheMaxSteps.' },

      padStart: { type: 'number', description: 'Seconds of held frame + silence prepended (default 0).' },
      padEnd: { type: 'number', description: 'Seconds of held frame + silence appended (default 0).' },
      timeoutMinutes: { type: 'number', description: 'Comfy queue timeout, default 45.' },
    },
    additionalProperties: true,
  },
};

/**
 * Stop an INVENTED description from arguing with a real photograph.
 *
 * When an operator supplies a photo for a character, the plate is theirs — but
 * the story bible has already invented an appearance for that character from
 * the prose, and that description reaches H3 as `references[].appearsAs`. So
 * H3 is handed a photograph AND a confident paragraph describing a different
 * woman's hair, skin and clothing. They do not cancel out; they blend into a
 * third person.
 *
 * Measured on the first desktop run: a supplied photo of Meera arrived
 * alongside the bible's "pale complexion, oval face, long black hair pulled
 * back loosely, simple white cotton kurta".
 *
 * So for a photographed character, `appearsAs` is replaced with a statement
 * that defers to the image. `job` is left alone — it says which FEATURES to
 * follow, which is still exactly what we want.
 */
function deferAppearanceToPhoto(
  promptDoc: Record<string, unknown>,
  cfg: Record<string, unknown>,
  ctx: RunnerContext,
  log: (m: string) => void,
): void {
  const pairs = Array.isArray(cfg['castPhotoInputs'])
    ? (cfg['castPhotoInputs'] as Array<Record<string, unknown>>)
    : [];
  if (!pairs.length) return;
  const refs = promptDoc['references'];
  if (!Array.isArray(refs)) return;

  const named: string[] = [];
  for (const pair of pairs) {
    const photoInput = typeof pair['photoInput'] === 'string' ? pair['photoInput'] : '';
    const nameInput = typeof pair['nameInput'] === 'string' ? pair['nameInput'] : '';
    if (!photoInput || !nameInput) continue;
    const photo = ctx.inputs[photoInput];
    const typed = ctx.inputs[nameInput];
    if (typeof photo !== 'string' || !photo) continue;
    if (typeof typed !== 'string' || !typed.trim()) continue;
    named.push(typed.trim());
  }
  if (!named.length) return;

  for (const raw of refs) {
    if (!raw || typeof raw !== 'object') continue;
    const ref = raw as Record<string, unknown>;
    const id = typeof ref['id'] === 'string' ? ref['id'] : '';
    if (!id || ref['type'] !== 'character') continue;
    const match = named.find((n) => castNameMatchesRefId(n, id));
    if (!match) continue;
    ref['appearsAs'] = `${match}, exactly as photographed — their face, hair, colouring and clothing are taken from the image and not from any description`;
    log(`${id}: appearance deferred to the supplied photo of "${match}"`);
  }
}

/** Token-containment match, mirroring dhee-runner-image-edit's castNameMatchesItem. */
function castNameMatchesRefId(typedName: string, refId: string): boolean {
  const tokens = (v: string): string[] => v.toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean);
  const typed = tokens(typedName);
  if (!typed.length) return false;
  const idTokens = new Set(tokens(refId));
  if (!idTokens.size) return false;
  return typed.every((t) => idTokens.has(t));
}

async function runH3(ctx: RunnerContext): Promise<RunnerResult> {
  const cfg = ctx.node.runner.config as Record<string, unknown>;
  const tag = (m: string) => `comfy.minimax_h3_r2v: ${m}`;
  const itemId = ctx.itemId ?? 'clip';

  const outputPath = rs(cfg, 'outputPath');
  if (!outputPath) return { ok: false, error: tag('missing outputPath') };
  const outAbs = projAbs(ctx.projectDir, outputPath);
  if (!outAbs) return { ok: false, error: tag(`outputPath escapes project: ${outputPath}`) };

  const workflowPath = rs(cfg, 'workflowPath');
  if (!workflowPath) return { ok: false, error: tag('missing workflowPath') };
  if (!ctx.bundleDir) return { ok: false, error: tag('ctx.bundleDir required') };
  const wfAbs = join(ctx.bundleDir, workflowPath);
  if (!existsSync(wfAbs)) return { ok: false, error: tag(`workflow not found: ${workflowPath}`) };

  // ── duration ──
  const plan = readShotPlan(ctx, cfg);
  const planShots = shotsForItem(plan, itemId);
  const promptDoc = readJsonInput(ctx, rs(cfg, 'promptInput')) as Record<string, unknown> | undefined;
  const structuredMode = rs(cfg, 'structuredMode');
  const useStructuredPrompt = shouldCompileStructuredPrompt(promptDoc, structuredMode);
  if (promptDoc && useStructuredPrompt) {
    // Collapse padded/duplicate references[] ids FIRST — before anything reads
    // an index. See dedupeSceneReferences' own doc for why this must precede
    // normalizeIndexedRefs rather than follow it: it keeps "every index is in
    // range AND names something declared exactly once" true for every reader
    // downstream instead of just the last one.
    const dedupeNotes = dedupeSceneReferences(promptDoc);
    if (dedupeNotes.length) ctx.log(tag(`${itemId}: ${dedupeNotes.join('; ')}`));
    // Rewrite index-based reference pointers into the id form every validator
    // and the compiler already speak. Done FIRST so nothing downstream needs to
    // know which form the author used — and so an out-of-range index fails here,
    // naming the index and the references actually available, rather than
    // surfacing later as a mysterious unknown id.
    const refNotes = normalizeIndexedRefs(promptDoc);
    if (refNotes.length) ctx.log(tag(`${itemId}: resolved ${refNotes.length} indexed reference(s)`));
    // Overwrite a wrong/invented/appearance-not-voice voicePrompt with the
    // character's own character_acting_profile identity. Needs subjectId
    // resolved (just above), and must run before compileStructuredScenePrompt
    // bakes whatever string is on the line into the H3 prose.
    const voiceNotes = applyVoiceProfileOverrides(promptDoc, voiceProfileMap(ctx, rs(cfg, 'voiceProfileInput')));
    for (const note of voiceNotes) ctx.log(tag(`${itemId}: WARNING — ${note}`));
    const expectedIds = expectedSceneReferenceIds(ctx, cfg, plan, itemId);
    if (expectedIds) {
      const pruned = pruneUnlicensedScenery(promptDoc, expectedIds);
      if (pruned.length) {
        ctx.log(tag(`${itemId}: dropped ${pruned.length} unlicensed scenery id(s) not in this section's entities — ${pruned.join(', ')}`));
      }
      validateStructuredSceneReferences(promptDoc, expectedIds);
    }
    const perfNotes = validateStructuredScenePerformance(promptDoc, expectedIds ?? [], rb(cfg, 'strictPerformance') ?? false);
    for (const note of perfNotes) ctx.log(tag(`${itemId}: ${note}`));
  }
  if (promptDoc && useStructuredPrompt) {
    deferAppearanceToPhoto(promptDoc, cfg, ctx, (m) => ctx.log(tag(`${itemId}: ${m}`)));
  }

  const authored = promptDoc ? rn(promptDoc, rs(cfg, 'durationField') ?? 'duration') : undefined;
  const fps = rn(cfg, 'fps') ?? H3_FPS;
  const maxSeconds = rn(cfg, 'maxSeconds') ?? H3_MAX_SECONDS;
  const { seconds, source, clamped, speechFloorSec } = resolveSeconds(
    authored, planShots,
    rn(cfg, 'seconds') ?? 10,
    rn(cfg, 'minSeconds') ?? H3_MIN_SECONDS,
    maxSeconds,
    (promptDoc as Record<string, unknown> | undefined)?.['spokenLines'],
    rn((promptDoc ?? {}) as Record<string, unknown>, 'speechSeconds'),
  );
  const LEN = snapH3Frames(seconds * fps);
  if (clamped) ctx.log(tag(`${itemId}: duration clamped to ${seconds}s (H3 renders 5–15s per call; the planner asked for more or less)`));
  if (speechFloorSec !== undefined && speechFloorSec > maxSeconds) {
    ctx.log(
      tag(
        `${itemId}: WARNING — dialogue needs ${speechFloorSec.toFixed(2)}s but the configured ceiling is ${maxSeconds}s — ` +
          'clamped to the ceiling and the render will proceed there, but this beat cannot hold its dialogue as one H3 ' +
          'clip; it needs an upstream re-plan (split the dialogue or the section), not a bigger clip.',
      ),
    );
  }

  // ── references ──
  // Pinned operator plates go FIRST: routeRefs keeps only the first background and
  // fills subject slots in order, so leading with them is what makes an operator
  // photo override a generated anchor rather than queue behind it.
  const pinned = pinnedRefs(ctx, cfg);
  const routed = resolveRefs(ctx, cfg, planShots);
  const allNotes = [...pinned.notes, ...routed.notes];
  if (allNotes.length) ctx.log(tag(`${itemId} refs: ${allNotes.join(', ')}`));
  let refs = pinned.refs.length || routed.refs.length
    ? routeRefs([...pinned.refs, ...routed.refs], bgTypesOf(cfg), rn(cfg, 'maxRefs') ?? H3_MAX_REFS).refs
    : explicitRefImages(ctx, cfg).slice(0, H3_MAX_REFS);
  if (refs.length < 1) return { ok: false, error: tag(`need ≥1 reference image, got 0 for ${itemId}`) };

  // ── split multi-view identity SHEETS into separate single-view plates ──
  // H3 renders a contact sheet as scenery instead of reading it as one subject
  // (see planSheetExpansion). Opt-in via cfg.sheetPanels, because only the
  // bundle knows whether its character plates are sheets.
  const sheetPanels = Math.round(rn(cfg, 'sheetPanels') ?? 0);
  if (sheetPanels >= 2) {
    const rawSheetTypes = cfg['sheetTypes'];
    const sheetTypes = new Set(
      (Array.isArray(rawSheetTypes) ? rawSheetTypes.filter((t): t is string => typeof t === 'string') : ['character'])
        .map((t) => t.toLowerCase()),
    );
    const rawPick = cfg['sheetPick'];
    const pick = Array.isArray(rawPick) && rawPick.length
      ? rawPick.filter((n): n is number => typeof n === 'number').map((n) => Math.round(n))
      : [0, sheetPanels - 1];
    const characterCount = refs.filter((r) => sheetTypes.has(r.type)).length;
    const otherCount = refs.length - characterCount;
    const plan2 = planSheetExpansion(characterCount, otherCount, rn(cfg, 'viewsPerCharacter') ?? 2, rn(cfg, 'maxRefs') ?? H3_MAX_REFS);
    if (plan2.degraded) ctx.log(tag(`${itemId}: ${characterCount} sheet subject(s) + ${otherCount} other ref(s) would overflow ${H3_MAX_REFS} slots — down to ${plan2.views} view(s) per subject`));
    const expanded = await expandSheetRefs(refs, {
      panels: sheetPanels, pick, views: plan2.views,
      scratchDir: join(ctx.projectDir, '.h3_ref_views'),
      sheetTypes,
    }, ctx.log, ctx.signal);
    refs = expanded.refs.slice(0, Math.max(1, Math.min(H3_MAX_REFS, Math.round(rn(cfg, 'maxRefs') ?? H3_MAX_REFS))));
  }

  // ── prompt ──
  const compiledStructured = useStructuredPrompt && promptDoc
    ? compileStructuredScenePrompt(promptDoc, {
      strictPerformance: rb(cfg, 'strictPerformance') ?? false,
      expectedReferenceIds: expectedSceneReferenceIds(ctx, cfg, plan, itemId),
      previousSectionEntities: previousSectionEntities(plan, itemId),
    })
    : undefined;
  const proseRaw = compiledStructured?.detailedDescription ?? rs(cfg, 'prompt') ?? resolvePromptText(ctx, cfg);
  if (!proseRaw) return { ok: false, error: tag('no prompt resolved') };
  const prose = normalizePromptLayout(proseRaw);
  const wantClause = rb(cfg, 'bindingClause') ?? true;

  // ── official six-section assembly ──
  // When the prompt document carries the four model-authored sections, build the
  // real MiniMax full-reference format: the runner injects subject_definitions
  // and retention_analysis at their fixed positions (both are functions of the
  // FINAL reference order, which the author cannot know) and remaps any
  // <Subject N>/<Picture N> the author wrote if routing changed that order.
  // Otherwise fall back to legacy single-prose + <Picture N> clause so existing
  // bundles keep working unchanged.
  const doc = promptDoc ?? {};
  const detailed = compiledStructured?.detailedDescription ?? rs(doc, 'detailedDescription');
  let positive: string;
  let trimmed = 0;
  if (wantClause && detailed) {
    const { subjectDefinitions, retentionAnalysis } = buildSubjectSections(refs);
    const authoredOrder = refs.map((r) => (typeof r.authoredIndex === 'number' ? r.authoredIndex : 0));
    let renderDetailed = detailed;
    const spokenLinesField = rs(cfg, 'spokenLinesField');
    if (spokenLinesField) {
      const languageInput = rs(cfg, 'dialogueLanguageInput');
      const languageValue = languageInput ? ctx.inputs[languageInput] : undefined;
      const injected = injectAuthoredDialogue({
        prose: renderDetailed,
        spokenLines: doc[spokenLinesField],
        language: typeof languageValue === 'string' && languageValue.trim()
          ? languageValue
          : rs(cfg, 'dialogueLanguage'),
      });
      renderDetailed = injected.prose;
      if (injected.injected) {
        ctx.log(tag(`${itemId} format repair: injected authored '${spokenLinesField}' as canonical H3 dialogue`));
      }
    }
    const remap = remapSubjectLabels(renderDetailed, authoredOrder);
    if (remap.remapped) ctx.log(tag(`${itemId}: remapped <Subject N> labels — routing reordered the plates`));

    // ── mechanical format repairs, before the audit ──
    // Ordered deliberately: repair FIRST so the audit and the dialogue gate below
    // judge the text that is actually SENT, not the model's draft. Auditing first
    // would report failures we then silently fixed, and the gate would reject
    // renders that are fine. Only the in-flight prompt is repaired; the stored
    // prompts/scenes/*.json keeps the raw output, so how often the model gets it
    // right on its own stays measurable.
    const repaired = repairH3Prose(remap.prose, planShots as Array<{ dialogue?: unknown; speaker?: unknown }>);
    for (const n of repaired.notes) ctx.log(tag(`${itemId} format repair: ${n}`));
    const assembled = assembleH3Prompt({
      subjectDefinitions,
      summary: rs(doc, 'summary') ?? '[reference generation] ' + (rs(doc, 'purpose') ?? 'Reference-guided scene.'),
      retentionAnalysis,
      detailedDescription: repaired.prose,
      overallSoundscape: rs(doc, 'overallSoundscape'),
      nonDiegeticMusic: rs(doc, 'nonDiegeticMusic'),
    });
    const notes = auditDetailedDescription(repaired.prose, { hasDialogue: /<d>/.test(repaired.prose) || planShots.some((x) => typeof (x as { dialogue?: string }).dialogue === 'string') });
    if (notes.length) ctx.log(tag(`${itemId} prompt audit: ${notes.join('; ')}`));

    // ── dialogue integrity gate ──
    // Checked BEFORE dispatching to Comfy, because the fatal case guarantees an
    // unusable clip and there is no point paying for the render. `allowGarbledAudio`
    // exists as an escape hatch, not an invitation: set it only to reproduce the
    // defect deliberately.
    const integrity = auditDialogueIntegrity(repaired.prose, planShots as Array<{ dialogue?: unknown }>);
    for (const w of integrity.warnings) ctx.log(tag(`${itemId} DIALOGUE WARNING: ${w}`));
    const scriptFindings = auditDialogueScript(repaired.prose);
    const fatal = [...integrity.fatal, ...scriptFindings];
    if (fatal.length) {
      const msg = `${itemId}: ${fatal.join('; ')}`;
      if (rb(cfg, 'allowGarbledAudio') === true) {
        ctx.log(tag(`${itemId} DIALOGUE FATAL (overridden by allowGarbledAudio): ${fatal.join('; ')}`));
      } else {
        throw new Error(
          `comfy.minimax_h3_r2v: ${msg}. Either supply the line in a <d>[Language] ...</d> tag with an (Sx) ` +
            'speaker id, written in that language\'s own native script (not romanized Latin), or rewrite the ' +
            'description as physical action (breath, movement, stillness) so nothing claims to speak. Set ' +
            'allowGarbledAudio:true to render anyway.',
        );
      }
    }
    const composed = composePrompt('', assembled);
    positive = composed.prompt; trimmed = composed.trimmed;
  } else {
    const clause = wantClause ? buildBindingClause(refs) : '';
    const composed = composePrompt(clause, prose);
    positive = composed.prompt; trimmed = composed.trimmed;
  }
  if (trimmed > 0) ctx.log(tag(`${itemId}: prompt exceeded H3's ~${H3_PROMPT_CHAR_LIMIT}-char window — trimmed ${trimmed} chars off the prose tail`));

  // ── geometry / sampler ──
  const resKey = rs(cfg, 'resolutionInput');
  const geom = resolveGeometry(resKey ? ctx.inputs[resKey] : undefined, rn(cfg, 'width'), rn(cfg, 'height'));
  const W = geom.width;
  const He = geom.height;
  if (geom.source !== 'config') ctx.log(tag(`${itemId}: ${W}x${He} from project ${geom.source}`));
  const refImageSize = rs(cfg, 'refImageSize') ?? 'match';
  // Steps: fixed when the bundle says so, otherwise scaled to what the scene is
  // actually asking for. Default floor 4 — the turbo LoRA's distilled count, and
  // the fix for the ~15 dB audio attenuation that 8 sigmas caused (#10).
  // A project field wins over the bundle default, the same way resolution does:
  // an operator pinning "8" for one film should not have to edit a bundle every
  // other project shares.
  const stepsKey = rs(cfg, 'stepsInput');
  const projectSteps = stepsKey ? ctx.inputs[stepsKey] : undefined;
  const projectStepsNum = typeof projectSteps === 'number'
    ? projectSteps
    : (typeof projectSteps === 'string' && /^\d+$/.test(projectSteps.trim()) ? Number(projectSteps.trim()) : undefined);
  const projectStepsAuto = typeof projectSteps === 'string' && projectSteps.trim().toLowerCase() === 'auto';

  const fixedSteps = projectStepsNum ?? rn(cfg, 'steps');
  const stepsAuto = projectStepsAuto
    || (projectStepsNum === undefined && (rb(cfg, 'stepsAuto') ?? fixedSteps === undefined));
  const minSteps = Math.max(1, Math.round(rn(cfg, 'minSteps') ?? 4));
  const maxSteps = Math.max(minSteps, Math.round(rn(cfg, 'maxSteps') ?? 10));
  let stepsReason = 'fixed';
  let steps: number;
  if (stepsAuto) {
    const scaled = stepsForSceneComplexity(
      (promptDoc ?? {}) as Record<string, unknown>,
      minSteps,
      maxSteps,
    );
    steps = scaled.steps;
    stepsReason = `auto ${minSteps}-${maxSteps}${projectStepsAuto ? ` from project ${stepsKey}` : ''}: ${scaled.reason}`;
  } else {
    steps = Math.max(1, Math.round(fixedSteps ?? 4));
    stepsReason = projectStepsNum !== undefined ? `fixed from project ${stepsKey}` : 'fixed';
  }
  const samplerName = rs(cfg, 'samplerName') ?? 'res_multistep';
  const scheduler = rs(cfg, 'scheduler') ?? 'simple';
  const baseSeed = Math.round(rn(cfg, 'seed') ?? 42);
  const usedSeed = (baseSeed + hashStr(itemId)) % 2_000_000_000;

  const endpointLabel = rs(cfg, 'endpoint') ?? 'self.local';
  const baseUrl = resolveEndpointUrl(endpointLabel);
  if (!baseUrl) return { ok: false, error: tag(`no Comfy endpoint for "${endpointLabel}"`) };

  const client = new ComfyClient(baseUrl);
  await unloadLocalLlmForRender(baseUrl, ctx.log);

  const names: string[] = [];
  for (let i = 0; i < refs.length; i++) {
    try { names.push((await retryTransient(() => client.uploadFile(refs[i]!.path), { signal: ctx.signal, log: ctx.log, label: `h3 upload ref ${i + 1}` })).name); }
    catch (e) { return { ok: false, error: tag(`reference upload failed (${basename(refs[i]!.path)}): ${msg(e)}`) }; }
  }

  let wf: Workflow;
  try { wf = JSON.parse(readFileSync(wfAbs, 'utf-8')) as Workflow; }
  catch (e) { return { ok: false, error: tag(`failed to read workflow: ${msg(e)}`) }; }
  // Drop non-node keys (a top-level "_comment" string) — Comfy treats every key
  // as a node and a bare string breaks the node iteration below.
  for (const k of Object.keys(wf)) {
    const v = wf[k] as unknown;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) delete wf[k];
  }

  if (!Object.values(wf).some((node) => node.class_type === 'MiniMaxH3ReferenceToVideo')) {
    return { ok: false, error: tag(`workflow ${basename(workflowPath)} has no MiniMaxH3ReferenceToVideo node`) };
  }
  const contract = applyH3WorkflowContract(wf, {
    positive,
    referenceNames: names,
    width: W,
    height: He,
    length: LEN,
    refImageSize,
    steps,
    samplerName,
    scheduler,
    seed: usedSeed,
    fps,
    itemId,
    cacheEnabled: rb(cfg, 'cache') ?? rb(cfg, 'easyCache'),
    cacheThreshold: rn(cfg, 'cacheThreshold') ?? rn(cfg, 'easyCacheThreshold'),
    cacheStart: rn(cfg, 'cacheStart') ?? rn(cfg, 'easyCacheStart'),
    cacheEnd: rn(cfg, 'cacheEnd') ?? rn(cfg, 'easyCacheEnd'),
    cacheMaxSteps: rn(cfg, 'cacheMaxSteps') ?? rn(cfg, 'easyCacheMaxSteps'),
  });
  if (contract.cacheLog) ctx.log(tag(`${itemId}: ${contract.cacheLog}`));
  const leftover = Object.values(wf).flatMap((n) => Object.values(n.inputs ?? {}).filter((v): v is string => typeof v === 'string' && /^__[A-Z0-9_]+__$/.test(v)));
  if (leftover.length) return { ok: false, error: tag(`unfilled placeholders: ${[...new Set(leftover)].join(', ')}`) };

  ctx.log(tag(`${itemId} — ${refs.length} ref(s) [${refs.map((r) => r.id).join(', ')}], ${W}x${He}, ${LEN}f (${(LEN / fps).toFixed(2)}s from ${source}), ${samplerName}/${scheduler} ${steps} steps (${stepsReason}), seed ${usedSeed}, on ${baseUrl}`));

  await mkdir(dirname(outAbs), { recursive: true });
  const timeoutMs = Math.max(1, rn(cfg, 'timeoutMinutes') ?? 45) * 60_000;
  let outputs;
  try { outputs = await retryTransient(() => client.run(wf as unknown as Record<string, unknown>, { signal: ctx.signal, timeoutMs }), { signal: ctx.signal, log: ctx.log, label: 'h3 queue' }); }
  catch (e) { return { ok: false, error: tag(`comfy run failed: ${msg(e)}`) }; }
  const picked = outputs.find((o) => /\.(mp4|webm|mov)$/i.test(o.filename)) ?? outputs[0];
  if (!picked) return { ok: false, error: tag('Comfy returned no outputs') };
  try { await retryTransient(() => client.download(picked, outAbs), { signal: ctx.signal, log: ctx.log, label: 'h3 download' }); }
  catch (e) { return { ok: false, error: tag(`download failed: ${msg(e)}`) }; }

  const padStart = rn(cfg, 'padStart') ?? 0;
  const padEnd = rn(cfg, 'padEnd') ?? 0;
  if (padStart > 0 || padEnd > 0) {
    const ok = await padClip(outAbs, padStart, padEnd, ctx.signal);
    ctx.log(tag(ok ? `${itemId} padded +${padStart}s/+${padEnd}s (head/tail)` : `${itemId} pad failed — keeping unpadded`));
  }

  ctx.log(tag(`wrote ${outputPath}`));
  const meta = {
    tool: 'comfy.minimax_h3_r2v', endpoint: endpointLabel, length: LEN, seconds: LEN / fps, durationSource: source,
    refs: refs.map((r) => ({ id: r.id, type: r.type, file: basename(r.path) })),
    width: W, height: He, refImageSize, steps, sampler: samplerName, scheduler, seed: usedSeed,
    promptChars: positive.length, promptTrimmed: trimmed, bindingClause: wantClause,
    comfyOutput: picked.filename, workflow: basename(workflowPath),
  };
  return { ok: true, outputPath, outputs: [{ path: outputPath, kind: 'video', metadata: meta }], metadata: meta };
}

export const h3Runner = defineRunner({ describe: () => H3_DESC, run: runH3 });

export const runners = [
  { manifest: H3_MANIFEST, runner: h3Runner },
];
