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
 * Repair the two mechanical H3-format defects authoring models reliably produce.
 *
 * Both are things the guide requires, the prompt has demanded in its strongest
 * (terminal) position through several revisions, and the model still gets wrong —
 * and both are exactly repairable from the text plus the plan, with no judgement:
 *
 *   MISSING (Sx)  H3 needs a stable speaker id on the speaker before each spoken
 *                 line: `<Subject 2> (S1) says: <d>[English] ...</d>`. Without it
 *                 H3 has words and no voice to attach them to. Measured on
 *                 deepseek-v4-flash-0731: 4 of 6 outputs contained ZERO `(Sx)`
 *                 anywhere, while otherwise naming the speaker and the delivery
 *                 perfectly ("Meher's voice is flat and commanding as she says:").
 *                 The information is all there; only the token is missing.
 *
 *   TIMESTAMPED [Shot 1]  The first shot must carry no cut time — `At MM:SS.mmm`
 *                 belongs on [Shot 2] onward. A run that had just been taught to
 *                 emit the marker started emitting `[Shot 1] At 00:00.000`.
 *
 * Why repair rather than keep asking: every PROSE rule tried on this bundle has
 * drifted, including two attempts at these very two, one of which made compliance
 * WORSE by displacing a working rule out of the terminal position. Every
 * STRUCTURAL fix has held. A rule that is regex-checkable and mechanically
 * satisfiable does not belong in a prompt.
 *
 * Speaker identity comes from the plan where possible: the shot whose `dialogue`
 * matches this line names its `speaker`, so the same character keeps the same
 * `(Sx)` across every line in the scene — which is what H3 needs and what a
 * per-line guess would get wrong. Falling back to the nearest preceding
 * `<Subject N>` keeps it working when the plan has no speaker recorded.
 *
 * Insertion goes after the nearest preceding `<Subject N>`, producing the exact
 * documented shape. Only if there is no such label does it prepend `(Sx) ` to the
 * tag itself — less elegant, still correct.
 */
export function repairH3Prose(
  prose: string,
  planShots: Array<{ dialogue?: unknown; speaker?: unknown }>,
): { prose: string; notes: string[] } {
  const notes: string[] = [];
  let out = prose;

  // ── 1. a declared cut with no [Shot N] marker gets one ──
  // Models write the transition correctly but omit the bracket marker: "…the only
  // other noise. At 00:04.000, the shot cuts to a wide…". H3 is trained on the
  // markers, and without one the audit also (correctly) sees that cut time as
  // belonging to [Shot 1], which is a second, spurious-looking failure from the
  // same root cause. The model has already committed to a cut AND a time here, so
  // inserting the marker adds no information it did not supply — it only supplies
  // the token. Numbering continues from however many markers already exist.
  const cutRe = /(?<!\[Shot \d{1,2}\]\s{0,3})\bAt\s+\d{2}:\d{2}\.\d{3}\s*,?\s*(?=the\s+(?:shot|camera)\s+(?:cuts?|transitions?|switches)\b)/g;
  const unmarked = [...out.matchAll(cutRe)];
  if (unmarked.length) {
    const highest = [...out.matchAll(/\[Shot (\d{1,2})\]/g)].reduce((mx, m) => Math.max(mx, Number(m[1])), 0);
    // Number in TEXT order (first unmarked cut gets the lowest number), then apply
    // back-to-front so each insertion cannot shift the offsets still pending.
    const planned = unmarked.map((m, i) => ({ at: m.index!, num: highest + 1 + i }));
    for (const e of [...planned].reverse()) {
      out = `${out.slice(0, e.at)}[Shot ${e.num}] ${out.slice(e.at)}`;
    }
    notes.push(`inserted ${planned.length} missing [Shot N] marker(s) on cuts the prose already timed`);
  }

  // ── 2. [Shot 1] must not carry a cut time ──
  const shot1Re = /(\[Shot 1\])\s*(?:At\s+\d{2}:\d{2}\.\d{3}\s*,?\s*)/;
  if (shot1Re.test(out)) {
    out = out.replace(shot1Re, '$1 ');
    notes.push('stripped the cut time from [Shot 1] (only later shots carry one)');
  }

  // ── 2. every <d> needs an (Sx) on its speaker ──
  const norm = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  /** line -> speaker id, from the plan, so ids stay stable per character. */
  const speakerOfLine = new Map<string, string>();
  for (const s of planShots) {
    const line = norm(s.dialogue);
    const who = String(s.speaker ?? '').trim();
    if (line && who) speakerOfLine.set(line, who);
  }

  /** speaker key -> assigned Sx number, first speaker to appear becomes S1. */
  const sxOf = new Map<string, number>();
  const sxFor = (key: string) => {
    if (!sxOf.has(key)) sxOf.set(key, sxOf.size + 1);
    return sxOf.get(key)!;
  };

  // Pre-seed ids in the order lines are SPOKEN, so S1 is the first voice heard
  // rather than whichever tag happened to be repaired first.
  for (const m of out.matchAll(/<d>\[[^\]]*\]([\s\S]*?)<\/d>/g)) {
    const key = speakerOfLine.get(norm(m[1]));
    if (key) sxFor(key);
  }

  // Collected as {offset, text} then applied from the END backwards, so each
  // insertion cannot shift the offsets of the ones still to be applied. Mutating
  // the string inside a String.replace callback does NOT work — replace operates
  // on the snapshot taken at call time, so those writes are silently discarded.
  const edits: Array<{ at: number; text: string }> = [];
  let injected = 0;

  for (const m of out.matchAll(/<d>\[[^\]]*\]([\s\S]*?)<\/d>/g)) {
    const offset = m.index!;
    const before = out.slice(0, offset);
    // Already tagged? The id must sit in the clause leading up to THIS tag, not
    // anywhere earlier in the scene — bound the search at the previous </d>.
    const prevEnd = before.lastIndexOf('</d>');
    const clauseStart = prevEnd >= 0 ? prevEnd + '</d>'.length : 0;
    const clause = before.slice(clauseStart);
    if (/\(S\d+(?:,S\d+)*\)/.test(clause)) continue;

    const subj = [...clause.matchAll(/<Subject (\d+)>/g)].pop();
    const key = speakerOfLine.get(norm(m[1])) ?? (subj ? `subject_${subj[1]}` : `line_${injected}`);
    const sx = `(S${sxFor(key)})`;
    injected++;

    if (subj) {
      // after that <Subject N>, giving the documented `<Subject 2> (S1) says: <d>…`
      edits.push({ at: clauseStart + subj.index! + subj[0].length, text: ` ${sx}` });
    } else {
      // no label to hang it on — prefix the tag itself
      edits.push({ at: offset, text: `${sx} ` });
    }
  }

  for (const e of edits.sort((a, b) => b.at - a.at)) {
    out = `${out.slice(0, e.at)}${e.text}${out.slice(e.at)}`;
  }

  if (injected) {
    notes.push(
      `injected ${injected} missing (Sx) speaker id(s) across ${sxOf.size} speaker(s) — ` +
        'H3 cannot attach a voice to a line without one',
    );
  }
  return { prose: out, notes };
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

/** Speech verbs that commit H3 to generating a voice. */
const SPEECH_VERBS =
  /\b(speaks?|speaking|spoke|says?|said|delivers? (?:her|his|their) lines?|(?:her|his|their) voice|murmurs?|whispers?|shouts?|calls? out|announces?|utters?|replies|answers)\b/gi;

const normLine = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

export interface DialogueIntegrity {
  /** Prose asserts speech but supplies no words — H3 will emit voice-shaped noise. */
  fatal: string[];
  /** Lines the plan assigned to this section that never reached the prose. */
  warnings: string[];
}

/**
 * Gate the two ways dialogue silently goes wrong before a clip is rendered.
 *
 * H3 builds its audio track from the prompt text, which makes one failure mode
 * catastrophic and invisible: prose that says someone SPEAKS while supplying no
 * words. H3 duly synthesises a voice saying nothing — voice-shaped noise that
 * sounds like a corrupted file. The JSON validates, the render succeeds, and the
 * clip is unusable. Confirmed on a measured 35-section film: one scene asserted
 * speech three times with zero `<d>` tags, and re-rendering it with the line
 * supplied — same seed, geometry, model, steps, references — produced clean
 * intelligible speech. Resolution, step count, the pruned model and EasyCache were
 * each falsified first, all failing identically because they rendered the same text.
 *
 * The second mode is quieter: a line the PLAN assigned to this section never
 * reaches the prose at all, so the film simply loses that dialogue. That happened
 * because the outline had assigned one short line to two sections and one of those
 * sections' beats had nothing to do with it, so the authoring pass dropped it.
 *
 * These are graded deliberately, because they differ in what they cost:
 *
 *   fatal    — speech described with no words. The clip is GUARANTEED unusable, so
 *              rendering it wastes GPU. Worth stopping for.
 *   warning  — an assigned line missing while nothing claims to speak. The clip is
 *              fine, the film is just missing a line. Not worth killing a long run.
 *
 * Both are exact string comparisons on data the runner already holds, which is the
 * point: three separate PROSE rules about dialogue drifted on this bundle within
 * hours, and a rule the model keeps breaking that is precisely checkable does not
 * belong in a prompt.
 */
export function auditDialogueIntegrity(
  prose: string,
  planShots: Array<{ dialogue?: unknown }>,
): DialogueIntegrity {
  const spoken = new Set(
    [...prose.matchAll(/<d>\[[^\]]*\]([\s\S]*?)<\/d>/g)].map((m) => normLine(m[1])).filter(Boolean),
  );
  const assigned = planShots.map((s) => normLine(s.dialogue)).filter(Boolean);

  const fatal: string[] = [];
  const warnings: string[] = [];

  const verbs = [...new Set((prose.match(SPEECH_VERBS) || []).map((v) => v.toLowerCase()))];
  if (spoken.size === 0 && verbs.length > 0) {
    fatal.push(
      `prose describes speech (${verbs.slice(0, 4).map((v) => `"${v}"`).join(', ')}) but contains NO <d>[Language] ...</d> ` +
        'words — H3 will synthesise a voice with nothing to say and the audio will be garbled',
    );
  }

  for (const line of new Set(assigned)) {
    if (!spoken.has(line)) {
      warnings.push(`plan line never reached the prompt: "${line.slice(0, 60)}"`);
    }
  }
  return { fatal, warnings };
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
