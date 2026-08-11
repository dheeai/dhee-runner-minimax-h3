/**
 * The render-time contract, exposed for AUTHORING time.
 *
 * WHY. Everything this module calls already ran inside `comfy.minimax_h3_r2v`
 * — one node too late. By then `scene_video_prompt` has succeeded, its JSON is
 * written and cached, and the model that could fix a bad document is no longer
 * in any conversation. So a scene whose shot times overlap, or whose dialogue
 * quotes a line absent from `spokenLines`, killed a run that had already spent
 * GPU-hours. That is the whole of issues #6, #17 and #18 in the bundle repo, and
 * the reason a run "always fails on one thing or another".
 *
 * Point `llm.generate`'s `cfg.validateWith` at this module and the SAME checks
 * run the moment the document is authored, where a complaint is just another
 * retry with feedback — free, instant, no GPU. Roughly a third of the runner's
 * ~36 failure modes are cross-field rules that no JSON Schema can express, so
 * this is the only layer that can catch them early.
 *
 * The point is emphatically NOT to write a second validator. It is to run the
 * FIRST one earlier. If these ever diverge, the bug is back — so this module
 * must never grow rules of its own, only call the render path's.
 */
import {
  dedupeSceneReferences,
  normalizeIndexedRefs,
  validateStructuredScenePerformance,
  compileStructuredScenePrompt,
} from './officialFormat.js';
import { shouldCompileStructuredPrompt } from './index.js';

/**
 * `llm.generate` calls this with the parsed scene document.
 * Returns nothing when the document will render; a message when it will not.
 *
 * The document is CLONED first. The render path's helpers rewrite the document
 * in place (index pointers become ids, duplicate references collapse) and the
 * authoring node must write exactly what the model produced — the runner will
 * redo those rewrites itself at render time.
 */
export function validate(value: unknown): string | undefined {
  // Only structured documents have a contract to check. A legacy prose document
  // takes a different render path, so silently pass it rather than inventing a
  // failure the renderer would never raise.
  if (!shouldCompileStructuredPrompt(value, 'structured')) return undefined;

  const doc = structuredClone(value) as Record<string, unknown>;
  try {
    dedupeSceneReferences(doc);
    // Bounds-checks every `subjectRef`/`sceneryRefs` index against references[]
    // and resolves it to an id — an out-of-range pointer fails HERE, naming the
    // index and what was available, which is a hint a model can act on.
    normalizeIndexedRefs(doc);
    const expectedIds = (Array.isArray(doc['references']) ? doc['references'] : [])
      .map((r) => (r as Record<string, unknown>)?.['id'])
      .filter((id): id is string => typeof id === 'string');
    // NOT validateStructuredSceneReferences: that one checks ids against the
    // section's LICENSED entities, which live in a sibling plan artifact the
    // authoring node does not read. `cfg.perItemEnums` already constrains those
    // same ids at generation time, so nothing is lost by leaving it to render.
    validateStructuredScenePerformance(doc, expectedIds, true);
    compileStructuredScenePrompt(doc, {
      strictPerformance: true,
      expectedReferenceIds: expectedIds,
    });
  } catch (error) {
    return (error as Error).message;
  }
  return undefined;
}
