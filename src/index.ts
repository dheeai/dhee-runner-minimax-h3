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
 *   • `res_multistep` + a `beta`/`normal` scheduler is the reference-heavy
 *     recommendation; `simple` is what the stock template ships
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
import { buildSubjectSections, remapSubjectLabels, assembleH3Prompt, auditDetailedDescription, auditDialogueIntegrity, repairH3Prose } from './officialFormat.js';

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

type Workflow = Record<string, { class_type?: string; inputs?: Record<string, unknown> }>;

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
  if (typeof resolutionValue === 'string' && resolutionValue.trim()) {
    const v = resolutionValue.trim().toLowerCase();
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

interface ShotRow { id?: string; scene?: number; duration?: number; speaker?: string | null }
interface ShotPlan { shots?: ShotRow[]; sections?: Array<{ id?: string }> }

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
 * How many seconds this clip runs, in precedence order:
 *   1. the authored prompt document's own `duration` (the scene prompt owns its
 *      pacing — it wrote the timecoded shot list, so it knows how long it is),
 *   2. the shot plan: this item's own duration, or the SUM of its section's
 *      shots when the item is a section (that sum is exactly the screen time
 *      the planner budgeted for the beat — H3 now renders it as one multi-cut
 *      clip instead of N concatenated ones),
 *   3. `cfg.seconds`, else `cfg.length / fps`.
 * Always clamped to H3's 5..15s window.
 */
export function resolveSeconds(
  authored: number | undefined,
  planShots: ShotRow[],
  fallbackSeconds: number,
  minSeconds: number,
  maxSeconds: number,
): { seconds: number; source: string; clamped: boolean } {
  let raw: number | undefined = undefined;
  let source = 'fallback';
  if (typeof authored === 'number' && Number.isFinite(authored) && authored > 0) { raw = authored; source = 'prompt'; }
  if (raw === undefined && planShots.length) {
    const sum = planShots.reduce((a, s) => a + (typeof s?.duration === 'number' && Number.isFinite(s.duration) && s.duration > 0 ? s.duration : 0), 0);
    if (sum > 0) { raw = sum; source = planShots.length > 1 ? `plan(sum of ${planShots.length} shots)` : 'plan'; }
  }
  if (raw === undefined) raw = fallbackSeconds;
  const seconds = Math.min(maxSeconds, Math.max(minSeconds, raw));
  return { seconds, source, clamped: Math.abs(seconds - raw) > 1e-6 };
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
  version: '0.3.1',
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
      steps: { type: 'integer', description: 'Sampler steps, default 20 (stock template).' },
      samplerName: { type: 'string', description: "Default 'res_multistep'." },
      scheduler: { type: 'string', description: "Default 'beta' — Comfy's own recommendation over 'simple' for reference-heavy prompts." },
      seed: { type: 'integer', description: 'Base seed; the per-item seed is derived from it + the item id so a rerun is stable but scenes differ.' },

      easyCache: { type: 'boolean', description: "Keep the graph's EasyCache node (default true when the graph has one). false removes it and rewires consumers back to the raw model, so the pass can be A/B'd for its quality cost without editing the workflow. EasyCache skips low-change transformer evaluations, which is the only lever that reduces the number of steps actually computed -- and the one most likely to erode fine identity detail." },
      easyCacheThreshold: { type: 'number', description: "EasyCache reuse_threshold. Higher skips more steps and degrades more. The shipped graph uses 0.3." },
      easyCacheStart: { type: 'number', description: 'EasyCache start_percent (default in the graph: 0.2). Caching before this fraction of sampling is skipped, since the early high-noise steps set composition.' },
      easyCacheEnd: { type: 'number', description: 'EasyCache end_percent (default in the graph: 0.9).' },

      padStart: { type: 'number', description: 'Seconds of held frame + silence prepended (default 0).' },
      padEnd: { type: 'number', description: 'Seconds of held frame + silence appended (default 0).' },
      timeoutMinutes: { type: 'number', description: 'Comfy queue timeout, default 45.' },
    },
    additionalProperties: true,
  },
};

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
  const authored = promptDoc ? rn(promptDoc, rs(cfg, 'durationField') ?? 'duration') : undefined;
  const fps = rn(cfg, 'fps') ?? H3_FPS;
  const { seconds, source, clamped } = resolveSeconds(
    authored, planShots,
    rn(cfg, 'seconds') ?? 10,
    rn(cfg, 'minSeconds') ?? H3_MIN_SECONDS,
    rn(cfg, 'maxSeconds') ?? H3_MAX_SECONDS,
  );
  const LEN = snapH3Frames(seconds * fps);
  if (clamped) ctx.log(tag(`${itemId}: duration clamped to ${seconds}s (H3 renders 5–15s per call; the planner asked for more or less)`));

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
  const proseRaw = rs(cfg, 'prompt') ?? resolvePromptText(ctx, cfg);
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
  const detailed = rs(doc, 'detailedDescription');
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
    if (integrity.fatal.length) {
      const msg = `${itemId}: ${integrity.fatal.join('; ')}`;
      if (rb(cfg, 'allowGarbledAudio') === true) {
        ctx.log(tag(`${itemId} DIALOGUE FATAL (overridden by allowGarbledAudio): ${integrity.fatal.join('; ')}`));
      } else {
        throw new Error(
          `comfy.minimax_h3_r2v: ${msg}. Either supply the line in a <d>[Language] ...</d> tag with an (Sx) ` +
            'speaker id, or rewrite the description as physical action (breath, movement, stillness) so nothing ' +
            'claims to speak. Set allowGarbledAudio:true to render anyway.',
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
  const steps = Math.max(1, Math.round(rn(cfg, 'steps') ?? 20));
  const samplerName = rs(cfg, 'samplerName') ?? 'res_multistep';
  const scheduler = rs(cfg, 'scheduler') ?? 'beta';
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

  // Locate the H3 node by class_type — the bundle is free to name it anything.
  const r2vId = Object.keys(wf).find((k) => wf[k]?.class_type === 'MiniMaxH3ReferenceToVideo');
  if (!r2vId) return { ok: false, error: tag(`workflow ${basename(workflowPath)} has no MiniMaxH3ReferenceToVideo node`) };
  const r2v = wf[r2vId]!;
  r2v.inputs = r2v.inputs ?? {};

  // Rebuild the dynamic reference-image group. Comfy's API format expresses the
  // node's dynamic input group as dotted keys `ref_images.ref_image_<N>`, each
  // pointing at a LoadImage. Drop whatever the template shipped and wire exactly
  // as many as this item resolved.
  // Strip BOTH serialisations of the autogrow group before rebuilding it. The
  // dotted 'ref_images.ref_image_<N>' form is what our graphs use and what is
  // proven to render; the FLAT 'ref_image_<N>' form appears in graphs exported
  // from the Comfy UI. Deleting only the dotted form left a flat key behind
  // pointing at the template's placeholder LoadImage, so a stale example image
  // was silently sent as an extra reference alongside the real plates.
  for (const k of Object.keys(r2v.inputs)) {
    if (k.startsWith('ref_images.') || /^ref_image_\d+$/.test(k)) delete r2v.inputs[k];
  }
  for (let i = 0; i < names.length; i++) {
    const loadId = `h3Ref${i}`;
    wf[loadId] = { class_type: 'LoadImage', inputs: { image: names[i]! } };
    r2v.inputs[`ref_images.ref_image_${i}`] = [loadId, 0];
  }
  r2v.inputs['width'] = W;
  r2v.inputs['height'] = He;
  r2v.inputs['length'] = LEN;
  r2v.inputs['ref_image_size'] = refImageSize;

  // ── EasyCache ──
  // It skips transformer evaluations whose inter-timestep change is under
  // reuse_threshold, so it removes WORK rather than making work faster — the only
  // lever that touches H3's dominant cost (step count). It is also the one that
  // can erode fine identity detail, which is the axis H3 is chosen for, so it must
  // be switchable without editing the graph: easyCache:false removes the node and
  // rewires every consumer back to the raw model.
  const cacheId = Object.keys(wf).find((k) => wf[k]?.class_type === 'EasyCache');
  if (cacheId) {
    const wantCache = rb(cfg, 'easyCache') ?? true;
    if (!wantCache) {
      const upstream = wf[cacheId]!.inputs?.['model'];
      delete wf[cacheId];
      for (const node of Object.values(wf)) {
        for (const [k, v] of Object.entries(node.inputs ?? {})) {
          if (Array.isArray(v) && v[0] === cacheId) node.inputs![k] = upstream as unknown as never;
        }
      }
      ctx.log(tag(`${itemId}: EasyCache removed (easyCache:false)`));
    } else {
      const ci = wf[cacheId]!.inputs ?? (wf[cacheId]!.inputs = {});
      const th = rn(cfg, 'easyCacheThreshold'); if (th !== undefined) ci['reuse_threshold'] = th;
      const st = rn(cfg, 'easyCacheStart'); if (st !== undefined) ci['start_percent'] = st;
      const en = rn(cfg, 'easyCacheEnd'); if (en !== undefined) ci['end_percent'] = en;
      ctx.log(tag(`${itemId}: EasyCache on (reuse ${ci['reuse_threshold']}, ${ci['start_percent']}-${ci['end_percent']})`));
    }
  }

  // Orphan the template's resolution/length helper nodes if it shipped any —
  // they are now unreferenced, and Comfy errors on nodes whose outputs go
  // nowhere only if they are required, so simply drop the well-known ones.
  for (const k of Object.keys(wf)) {
    const ct = wf[k]?.class_type;
    if (ct === 'ResolutionSelector' || ct === 'ComfyMathExpression' || ct === 'PrimitiveFloat') delete wf[k];
  }

  // Scalars + prompt by placeholder and by class_type.
  for (const node of Object.values(wf)) {
    const ins = node.inputs ?? (node.inputs = {});
    for (const [k, v] of Object.entries(ins)) {
      if (v === '__POS__') ins[k] = positive;
    }
    switch (node.class_type) {
      case 'RandomNoise': ins['noise_seed'] = usedSeed; break;
      case 'BasicScheduler': ins['steps'] = steps; ins['scheduler'] = scheduler; break;
      case 'KSamplerSelect': ins['sampler_name'] = samplerName; break;
      case 'CreateVideo': ins['fps'] = fps; break;
      case 'SaveVideo': ins['filename_prefix'] = `h3_${itemId.replace(/[^a-zA-Z0-9_]/g, '_')}`; break;
      default: break;
    }
  }
  const leftover = Object.values(wf).flatMap((n) => Object.values(n.inputs ?? {}).filter((v): v is string => typeof v === 'string' && /^__[A-Z0-9_]+__$/.test(v)));
  if (leftover.length) return { ok: false, error: tag(`unfilled placeholders: ${[...new Set(leftover)].join(', ')}`) };

  ctx.log(tag(`${itemId} — ${refs.length} ref(s) [${refs.map((r) => r.id).join(', ')}], ${W}x${He}, ${LEN}f (${(LEN / fps).toFixed(2)}s from ${source}), ${samplerName}/${scheduler} ${steps} steps, seed ${usedSeed}, on ${baseUrl}`));

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
