/**
 * The official MiniMax H3 full-reference prompt format.
 *
 * Source: MiniMaxAI/MiniMax-H3 `docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md` plus
 * `docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md` for the shared shot, camera,
 * speaker and audio rules.
 *
 * This replaced an earlier `<Picture N>` binding clause built from third-party
 * write-ups, which used the WRONG LABEL. The official guide reserves
 * `<Picture N>` for an image acting as a concrete frame anchor — first frame,
 * keyframe, last frame, composition anchor — and says plainly: "If an image is
 * used only to define a character, scene, costume, or style, do not create a
 * standalone picture entry." Reusable visible content is `<Subject N>`, with the
 * source image cited INSIDE the subject definition. Our anchor plates are
 * exactly that case, so every plate is a Subject whose provenance is a Picture.
 *
 * A full-reference prompt has six sections in fixed order. The RUNNER owns two,
 * because both are pure functions of the resolved reference list and its final
 * ordering — neither of which the authoring model can know:
 *
 *   subject_definitions   <- runner
 *   summary               <- model
 *   retention_analysis    <- runner
 *   detailed_description  <- model
 *   overall_soundscape    <- model
 *   non_diegetic_music    <- model
 *
 * Note that `subject_definitions` PRECEDES `summary`, so the runner interleaves
 * rather than merely prepending. That is why the model authors four separate
 * fields instead of one assembled blob.
 */

/** Section order for a full-reference (reference-to-video) prompt. */
export const H3_SECTION_ORDER = [
  'subject_definitions',
  'summary',
  'retention_analysis',
  'detailed_description',
  'overall_soundscape',
  'non_diegetic_music',
] as const;

/** Fixed English relationship markers for visible content (ref guide 4.1). */
export const RETENTION_MARKERS = [
  'fully_preserved',
  'partially_preserved',
  'attribute_transfer',
  'weak_reference',
] as const;
export type RetentionMarker = (typeof RETENTION_MARKERS)[number];

/**
 * Controlled camera-motion vocabulary (base guide 4.3). Kept here so a bundle's
 * prompt template and any QA check share one list rather than drifting.
 * Amplitude and speed are optional and omitted when medium/normal.
 */
export const CAMERA_MOTIONS = [
  'Zoom In', 'Zoom Out', 'Push In', 'Pull Out', 'Pan Left', 'Pan Right',
  'Truck Left', 'Truck Right', 'Tilt Up', 'Tilt Down', 'Pedestal Up', 'Pedestal Down',
  'Arc Shot', 'Tracking Shot', 'Static Shot', 'Shake Slightly', 'Shake Strongly',
  'POV', 'Roll Clockwise', 'Roll Counterclockwise',
] as const;

export interface SubjectRef {
  /** short visual descriptor, e.g. "the elderly hunched fisherwoman in a green sari" */
  appearsAs?: string;
  /** what this plate is for, completing "Follow it for ___" */
  job?: string;
  /** how faithfully it is held; anchor plates are fully_preserved by definition */
  retention?: RetentionMarker;
}

/**
 * Emit `subject_definitions` and `retention_analysis` from the resolved plates.
 *
 * One `<Subject n>` per plate citing `<Picture n>` as provenance, numbered by
 * FINAL order — so subjects-first / location-last routing and the nine-reference
 * cap are already applied. Entries default to `fully_preserved`, because the
 * whole purpose of an anchor plate is that the identity does not drift; a bundle
 * wanting a looser relationship states it per reference rather than having this
 * infer one.
 */
export function buildSubjectSections(refs: SubjectRef[]): {
  subjectDefinitions: string;
  retentionAnalysis: string;
} {
  const defs: string[] = [];
  const rets: string[] = [];
  refs.forEach((r, i) => {
    const n = i + 1;
    const what = (r.appearsAs ?? '').trim() || 'the referenced subject';
    const job = (r.job ?? '').trim();
    const marker: RetentionMarker = r.retention ?? 'fully_preserved';
    defs.push(`<Subject ${n}> is ${what} in <Picture ${n}>.${job ? ` Follow it for ${job}.` : ''}`);
    rets.push(`<Subject ${n}>: ${marker} - ${job || `${what} is retained exactly as shown`}.`);
  });
  return { subjectDefinitions: defs.join('\n'), retentionAnalysis: rets.join('\n') };
}

/**
 * Renumber `<Subject N>` / `<Picture N>` tokens when the runner's final ordering
 * differs from the order the model listed its references in.
 *
 * The model is told to author `references[]` already in final order (subjects
 * first, the single location last) and to cite `<Subject 1..N>` to match. When
 * routing or the nine-reference cap reorders anyway, its labels would point at
 * the wrong plate and silently swap who is who — so remap instead of hoping.
 *
 * `authoredIndexByFinalPos[i]` is the ORIGINAL 1-based index of the plate now at
 * final position `i`. No sentinel is needed: `String.replace` with a callback
 * visits each match once and never re-scans what it wrote, so a swap chain like
 * 1->2, 2->1 cannot double-apply.
 */
export function remapSubjectLabels(
  prose: string,
  authoredIndexByFinalPos: number[],
): { prose: string; remapped: boolean } {
  const toFinal = new Map<number, number>();
  authoredIndexByFinalPos.forEach((authored, idx) => toFinal.set(authored, idx + 1));
  let needed = false;
  for (const [authored, final] of toFinal) if (authored !== final) needed = true;
  if (!needed) return { prose, remapped: false };
  const out = prose.replace(/<(Subject|Picture)\s+(\d+)>/g, (whole, kind: string, num: string) => {
    const to = toFinal.get(Number(num));
    return to === undefined ? whole : `<${kind} ${to}>`;
  });
  return { prose: out, remapped: true };
}

/**
 * Assemble the six-section prompt. Model-authored sections go in verbatim; the
 * runner's two are injected at their fixed positions. An absent audio section
 * becomes `N/A`, which is what the guide asks for rather than dropping the
 * heading.
 */
export function assembleH3Prompt(parts: {
  subjectDefinitions: string;
  summary: string;
  retentionAnalysis: string;
  detailedDescription: string;
  overallSoundscape?: string;
  nonDiegeticMusic?: string;
}): string {
  const block = (name: string, body: string) => `${name}:\n${body.trim()}`;
  return [
    block('subject_definitions', parts.subjectDefinitions),
    block('summary', parts.summary),
    block('retention_analysis', parts.retentionAnalysis),
    block('detailed_description', parts.detailedDescription),
    block('overall_soundscape', (parts.overallSoundscape || 'N/A').trim()),
    block('non_diegetic_music', (parts.nonDiegeticMusic || 'N/A').trim()),
  ].join('\n\n');
}

/**
 * Cheap structural check on an authored `detailed_description`, for logging only.
 *
 * Deliberately advisory: a scene should not fail to render because a heading is
 * phrased oddly. It reports what the guide actually requires and lets the
 * operator see drift in the run log.
 */
export function auditDetailedDescription(text: string, opts: { hasDialogue: boolean }): string[] {
  const notes: string[] = [];
  if (!/\[Shot 1\]/.test(text)) notes.push('no [Shot 1] marker');
  // Bound the lookahead at the NEXT shot marker, not at a newline. The whole
  // description is often a single line, so `[^\n]*` ran forward and matched the
  // legitimate "At MM:SS.mmm" belonging to [Shot 2] -- flagging a correctly
  // formatted [Shot 1] as broken. Caught on a real g4-meromero output.
  const shot1 = /\[Shot 1\]([\s\S]*?)(?=\[Shot \d+\]|$)/.exec(text);
  if (shot1 && /\bAt \d{2}:\d{2}\.\d{3}/.test(shot1[1]!)) {
    notes.push('[Shot 1] carries a timestamp (it must not)');
  }
  const later = [...text.matchAll(/\[Shot (\d+)\]\s*At (\d{2}):(\d{2})\.(\d{3})/g)];
  const bare = [...text.matchAll(/\[Shot (\d+)\]/g)].length;
  if (bare > 1 && later.length !== bare - 1) {
    notes.push(`${bare - 1} shot(s) after the first, but ${later.length} carry an "At MM:SS.mmm" cut time`);
  }
  let prev = -1;
  for (const m of later) {
    const t = Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
    if (t <= prev) notes.push(`cut time ${m[2]}:${m[3]}.${m[4]} is not strictly increasing`);
    prev = t;
  }
  if (opts.hasDialogue) {
    if (!/<d>\[[^\]]+\]/.test(text)) notes.push('scene has authored dialogue but no <d>[Language] ...</d> block');
    if (!/\(S\d+(?:,S\d+)*\)/.test(text)) notes.push('dialogue present but no (Sx) speaker id');
  }
  const motions = [
    'Zoom In', 'Zoom Out', 'Push In', 'Pull Out', 'Pan Left', 'Pan Right',
    'Truck Left', 'Truck Right', 'Tilt Up', 'Tilt Down', 'Pedestal Up', 'Pedestal Down',
    'Arc Shot', 'Tracking Shot', 'Static Shot', 'Shake Slightly', 'Shake Strongly',
    'POV', 'Roll Clockwise', 'Roll Counterclockwise',
  ];
  if (!motions.some((m) => text.includes(m))) {
    notes.push('no controlled camera-motion term (Push In / Arc Shot / Static Shot / ...) — H3 is trained on this vocabulary');
  }
  const words = text.trim().split(/\s+/).length;
  if (words < 250) notes.push(`detailed_description is ${words} words (guide: normally 350-500)`);
  if (words > 700) notes.push(`detailed_description is ${words} words (guide: normally 350-500)`);
  return notes;
}
