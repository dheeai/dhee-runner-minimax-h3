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
  /** reference id; split sheet views arrive as `<id>#v0`, `<id>#v1` of ONE subject */
  id?: string;
  /** short visual descriptor, e.g. "the elderly hunched fisherwoman in a green sari" */
  appearsAs?: string;
  /** what this plate is for, completing "Follow it for ___" */
  job?: string;
  /** how faithfully it is held; anchor plates are fully_preserved by definition */
  retention?: RetentionMarker;
}

export type CameraMotion = (typeof CAMERA_MOTIONS)[number];
export type StructuredShotStructure = 'continuous_moving' | 'locked_single' | 'multi_cut';

/** A typed line owned by exactly one structured shot. */
export interface StructuredDialogue {
  speakerId: string;
  subjectId: string;
  language: string;
  exactWords: string;
  delivery: string;
  /**
   * The speaker's fixed vocal identity, copied from character_acting_profile.
   *
   * Lives ON THE LINE rather than in a scene-level `performance.voiceProfiles`
   * list. That list had to agree with the dialogue exactly — one profile per
   * speaking subject, none for anyone else — and models broke it in both
   * directions (a profile for a visible-but-silent character; a missing profile
   * for a speaker). Attaching it to the line makes both states unrepresentable.
   * Only the FIRST occurrence per subject is emitted; later repeats are ignored.
   */
  voicePrompt?: string;
  /**
   * The speaker is heard but not seen in this shot.
   *
   * Required whenever the speaker has no `acting` entry here, because `acting`
   * is what puts a character on screen. Without this flag a FORGOTTEN acting
   * entry would silently become an off-screen voice instead of an error — the
   * one safety property the acting/scenery split would otherwise have lost.
   *
   * It also supplies what the base guide (4.4) demands and the old shape could
   * not express: the exact phrase `says in an off-screen voiceover`, plus the
   * lips-remain-closed statement when the speaker is visible but not speaking
   * on camera.
   */
  offScreen?: boolean;
}

export interface StructuredShotActing {
  subjectId: string;
  tactic: string;
  observableBehavior: string;
  beatChange: string;
  reaction?: string;
  assessmentMoment?: string;
  interruptedAction?: string;
}

export interface StructuredVoiceProfile {
  subjectId: string;
  voicePrompt: string;
}

export interface StructuredScenePerformance {
  objective: string;
  obstacle: string;
  stakes: string;
  physicalBusiness: string;
  bodyState: string;
  eyeLife: string;
  subtext?: string;
  statusDynamic?: string;
  proxemics?: string;
  /** LEGACY. New scenes carry `voicePrompt` on the dialogue line instead. */
  voiceProfiles?: StructuredVoiceProfile[];
}

/** A reference in the author's stable order, before runner routing/remapping. */
export interface StructuredSceneReference extends SubjectRef {
  id: string;
  type: 'character' | 'object' | 'location';
  appearsAs: string;
  job: string;
}

/** One time-bounded beat that the compiler turns into one H3 shot block. */
export interface StructuredSceneShot {
  id: string;
  startTime: number;
  endTime: number;
  composition: string;
  /**
   * Every reference visible in this shot, in emission order: the characters
   * (from `acting`) followed by the scenery (from `sceneryIds`).
   *
   * DERIVED, not authored. A shot used to declare its characters twice — here
   * and again in `acting[].subjectId` — with nothing keeping the two in
   * agreement, which produced two measured failure classes: a character present
   * with no acting entry, and an acting entry for a subject not in the shot.
   * Deriving the list makes both unrepresentable. Legacy documents that still
   * carry an authored `subjectIds` are honoured as-is.
   */
  subjectIds: string[];
  /** Objects and locations visible in this shot. Characters never appear here. */
  sceneryIds?: string[];
  action: string;
  cameraMotion: CameraMotion;
  /** Base guide 4.3's second camera dimension. Omit for medium. */
  cameraAmplitude?: 'small' | 'large';
  /** Base guide 4.3's third camera dimension. Omit for normal. */
  cameraSpeed?: 'slow' | 'fast';
  sound: string;
  transition?: string;
  dialogue?: StructuredDialogue[];
  /** The characters in this shot, one entry each. Empty for a shot with none. */
  acting?: StructuredShotActing[];
}

/** The strict intermediate representation authored by the illustrated-story bundle. */
export interface StructuredScenePrompt {
  spokenLines: string[];
  /**
   * One or two sentences of visual style, emitted immediately BEFORE [Shot 1].
   *
   * Ref guide 5.2 lists this as a full-reference-mode DIFFERENCE from T2VA: the
   * style opening goes before the first shot marker, not after it. The schema
   * had no field for it at all, so the bundle's `art_style` — an input this node
   * declares — reached the renderer not at all, and the slot the guide reserves
   * for style was occupied by acting-theory metadata instead.
   */
  style?: string;
  summary: string;
  references: StructuredSceneReference[];
  shots: StructuredSceneShot[];
  overallSoundscape: string;
  nonDiegeticMusic: string;
  negatives: string[];
  duration: number;
  purpose: string;
  shotStructure: StructuredShotStructure;
  performance?: StructuredScenePerformance;
  /**
   * The state this scene ENDS in, for the next scene to open on.
   *
   * Was a free-prose string, and was emitted into the prose of the scene that
   * WROTE it — the one scene that cannot benefit from it. Nothing read it, so
   * every scene was authored blind to its predecessor and the film accumulated
   * prop-state contradictions, missing entrances and a set that moved between
   * cuts. Now a structured ledger, and NOT emitted into this scene's prose at
   * all: it describes a state after the clip ends, and the shots already show it.
   */
  continuationAnchor?: ContinuityLedger;
  /**
   * The state this scene OPENS on, inherited from the previous scene's
   * `continuationAnchor`. Absent on the first scene of a film.
   */
  continuationFrom?: ContinuationFrom;
}

/**
 * A scene boundary as a checkable ledger rather than a sentence.
 *
 * The four fields are MiniMax's own (`3d-animation-short-generator`'s shot-table
 * spec: Fixed Landmarks / Character Positions / Exited Character Status /
 * Lighting Baseline), plus prop state, which is what the shipped soap actually
 * contradicted itself on — scene 1 ended with the tea poured and steaming and
 * scene 2 opened asserting the cups were not yet visible.
 *
 * Screen positions are the point. "the stove is in the kitchen" is not a
 * landmark entry; "the stove is in the left third against the back wall" is,
 * because only the second survives being handed to the next render.
 */
export interface ContinuityLedger {
  /** Fixed set features and where they sit ON SCREEN. At least one. */
  fixedLandmarks: { name: string; screenPosition: string }[];
  /** Everyone visible at the boundary: where in frame, facing, and pose. */
  characterPositions: { subjectId: string; screenPosition: string; facing: string; pose: string }[];
  /** Everyone off-screen at the boundary, with where they are and why. */
  offStage?: { subjectId: string; where: string; reason: string }[];
  /** Inherited key/fill/rim, plus any modifier in force at the boundary. */
  lightingBaseline: string;
  /** Handled props and their state — poured, moved, held, set down. */
  propStates?: { name: string; state: string }[];
}

export interface ContinuationFrom extends ContinuityLedger {
  /**
   * Set ONLY when this scene deliberately breaks from the previous one — a time
   * skip, a new location, a reset. Discontinuity is legitimate; undeclared
   * discontinuity is the defect. When present the compiled opening states the
   * break instead of asserting continuity.
   */
  hardCut?: string;
}

export interface StructuredSceneCompileOptions {
  strictPerformance?: boolean;
  expectedReferenceIds?: readonly string[];
  /**
   * Entities of the section immediately before this one, from the shot plan.
   * A character acting in this scene who is not in that list was not in the
   * film's world when the scene opened, and must be seen to arrive.
   */
  previousSectionEntities?: readonly string[];
}

export interface CompiledH3Section {
  name: (typeof H3_SECTION_ORDER)[number];
  body: string;
}

export interface CompiledStructuredScenePrompt {
  sections: CompiledH3Section[];
  prompt: string;
  detailedDescription: string;
}

const STRUCTURED_MIN_SECONDS = 5;
const STRUCTURED_MAX_SECONDS = 15.08;
const STRUCTURED_REFERENCE_TYPES = new Set(['character', 'object', 'location']);
const STRUCTURED_SHOT_STRUCTURES = new Set<StructuredShotStructure>([
  'continuous_moving',
  'locked_single',
  'multi_cut',
]);

/**
 * The one place a shot's visible-reference list is decided.
 *
 * NEW SHAPE: `acting[]` is the authority for who is in the shot (one entry per
 * character) and `sceneryIds[]` carries the objects and locations. The visible
 * list is the concatenation, characters first — which is also the order the
 * compiler wants, since `<Subject N>` numbering follows the reference list and
 * people matter more than props.
 *
 * LEGACY SHAPE: an authored `subjectIds` wins outright, so scenes already on
 * disk from before this change keep compiling byte-identically. New authoring
 * cannot produce it — the bundle schema sets `additionalProperties: false` and
 * no longer declares the field.
 *
 * Both callers (`validateStructuredScene` and
 * `validateStructuredScenePerformance`) go through here, so the two can never
 * disagree about who is in a shot — which is exactly the bug class this
 * replaces.
 */
export function resolveShotSubjectIds(shot: Record<string, unknown>, path: string): string[] {
  const authored = shot['subjectIds'];
  if (authored !== undefined) {
    if (!Array.isArray(authored) || authored.length < 1) {
      throw new Error(`${path}.subjectIds must contain at least one reference id`);
    }
    return authored.map((id, i) => structuredText(id, `${path}.subjectIds[${i}]`));
  }

  const rawActing = shot['acting'];
  if (rawActing !== undefined && !Array.isArray(rawActing)) {
    throw new Error(`${path}.acting must be an array when supplied`);
  }
  const characterIds = (rawActing ?? []).map((entry, i) => {
    const record = structuredRecord(entry);
    return structuredText(record['subjectId'], `${path}.acting[${i}].subjectId`);
  });

  const rawScenery = shot['sceneryIds'];
  if (rawScenery !== undefined && !Array.isArray(rawScenery)) {
    throw new Error(`${path}.sceneryIds must be an array when supplied`);
  }
  const sceneryIds = (rawScenery ?? []).map((id, i) => structuredText(id, `${path}.sceneryIds[${i}]`));

  const resolved = [...characterIds, ...sceneryIds];
  if (resolved.length < 1) {
    throw new Error(
      `${path} has no visible references: give it at least one acting entry (a character) or one sceneryIds entry (an object or location)`,
    );
  }
  const seen = new Set<string>();
  for (const id of resolved) {
    if (seen.has(id)) throw new Error(`${path} lists ${id} twice across acting and sceneryIds`);
    seen.add(id);
  }
  return resolved;
}

function structuredRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('structured scene must be an object');
  }
  return value as Record<string, unknown>;
}

function structuredText(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function structuredNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
  return value;
}

function formatStructuredTime(seconds: number): string {
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const remainder = whole % 60;
  const milliseconds = Math.round((seconds - whole) * 1000);
  const carry = milliseconds === 1000 ? 1 : 0;
  const ms = milliseconds === 1000 ? 0 : milliseconds;
  return `${String(minutes + Math.floor((remainder + carry) / 60)).padStart(2, '0')}:${String((remainder + carry) % 60).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

function validateStructuredScene(scene: unknown): StructuredScenePrompt {
  const root = structuredRecord(scene);
  const duration = structuredNumber(root['duration'], 'duration');
  if (duration < STRUCTURED_MIN_SECONDS || duration > STRUCTURED_MAX_SECONDS) {
    throw new Error(`duration must be between ${STRUCTURED_MIN_SECONDS} and ${STRUCTURED_MAX_SECONDS} seconds`);
  }

  const rawSpokenLines = root['spokenLines'];
  if (!Array.isArray(rawSpokenLines)) throw new Error('spokenLines must be an array');
  const spokenLines = rawSpokenLines.map((line, index) => structuredText(line, `spokenLines[${index}]`));

  const styleValue = root['style'];
  if (styleValue !== undefined && (typeof styleValue !== 'string' || !styleValue.trim())) {
    throw new Error('style must be a non-empty string when supplied');
  }
  const summary = structuredText(root['summary'], 'summary');
  const overallSoundscape = structuredText(root['overallSoundscape'], 'overallSoundscape');
  const nonDiegeticMusic = structuredText(root['nonDiegeticMusic'], 'nonDiegeticMusic');
  const purpose = structuredText(root['purpose'], 'purpose');
  const rawShotStructure = structuredText(root['shotStructure'], 'shotStructure') as StructuredShotStructure;
  if (!STRUCTURED_SHOT_STRUCTURES.has(rawShotStructure)) {
    throw new Error(`shotStructure must be one of ${[...STRUCTURED_SHOT_STRUCTURES].join(', ')}`);
  }

  const rawNegatives = root['negatives'];
  if (!Array.isArray(rawNegatives)) throw new Error('negatives must be an array');
  const negatives = rawNegatives.map((negative, index) => structuredText(negative, `negatives[${index}]`));

  const rawReferences = root['references'];
  if (!Array.isArray(rawReferences) || rawReferences.length < 1 || rawReferences.length > 9) {
    throw new Error('references must contain between 1 and 9 entries');
  }
  const referenceIds = new Set<string>();
  const references: StructuredSceneReference[] = rawReferences.map((value, index) => {
    const ref = structuredRecord(value);
    const path = `references[${index}]`;
    const id = structuredText(ref['id'], `${path}.id`);
    if (referenceIds.has(id)) throw new Error(`${path}.id duplicates ${id}`);
    referenceIds.add(id);
    const type = structuredText(ref['type'], `${path}.type`) as StructuredSceneReference['type'];
    if (!STRUCTURED_REFERENCE_TYPES.has(type)) {
      throw new Error(`${path}.type must be character, object, or location`);
    }
    const appearsAs = structuredText(ref['appearsAs'], `${path}.appearsAs`);
    const job = structuredText(ref['job'], `${path}.job`);
    const retentionValue = ref['retention'];
    if (retentionValue !== undefined && (typeof retentionValue !== 'string' || !RETENTION_MARKERS.includes(retentionValue as RetentionMarker))) {
      throw new Error(`${path}.retention must use an official retention marker`);
    }
    return {
      id,
      type,
      appearsAs,
      job,
      retention: retentionValue as RetentionMarker | undefined,
    };
  });

  const rawShots = root['shots'];
  if (!Array.isArray(rawShots) || rawShots.length < 1) throw new Error('shots must contain at least one entry');
  if (rawShotStructure === 'multi_cut' && rawShots.length < 2) {
    throw new Error('multi_cut scenes require at least two shots');
  }
  if (rawShotStructure !== 'multi_cut' && rawShots.length !== 1) {
    throw new Error(`${rawShotStructure} scenes require exactly one shot`);
  }

  const spokenCounts = new Map<string, number>();
  for (const line of spokenLines) spokenCounts.set(line, (spokenCounts.get(line) ?? 0) + 1);
  const speakerSubjects = new Map<string, string>();
  let previousStart = -1;
  let previousEnd = 0;
  const shots: StructuredSceneShot[] = rawShots.map((value, index) => {
    const shot = structuredRecord(value);
    const path = `shots[${index}]`;
    const id = structuredText(shot['id'], `${path}.id`);
    const startTime = structuredNumber(shot['startTime'], `${path}.startTime`);
    const endTime = structuredNumber(shot['endTime'], `${path}.endTime`);
    if (index === 0 && startTime !== 0) throw new Error('the first shot must start at 0 seconds');
    if (startTime <= previousStart) throw new Error('shot start times must be strictly increasing');
    if (startTime < 0 || endTime <= startTime || endTime > duration) {
      throw new Error(`${path} is outside the scene duration bounds`);
    }
    if (index > 0 && startTime < previousEnd) {
      throw new Error(`${path} overlaps the previous shot interval`);
    }
    previousStart = startTime;
    previousEnd = endTime;
    const composition = structuredText(shot['composition'], `${path}.composition`);
    const action = structuredText(shot['action'], `${path}.action`);
    const cameraMotion = structuredText(shot['cameraMotion'], `${path}.cameraMotion`) as CameraMotion;
    if (!CAMERA_MOTIONS.includes(cameraMotion)) {
      throw new Error(`${path}.cameraMotion must use a controlled H3 camera vocabulary term`);
    }
    const amplitudeValue = shot['cameraAmplitude'];
    if (amplitudeValue !== undefined && amplitudeValue !== 'small' && amplitudeValue !== 'large') {
      throw new Error(`${path}.cameraAmplitude must be 'small' or 'large' when supplied`);
    }
    const speedValue = shot['cameraSpeed'];
    if (speedValue !== undefined && speedValue !== 'slow' && speedValue !== 'fast') {
      throw new Error(`${path}.cameraSpeed must be 'slow' or 'fast' when supplied`);
    }
    const sound = structuredText(shot['sound'], `${path}.sound`);
    const subjectIds = resolveShotSubjectIds(shot, path);
    for (const idValue of subjectIds) {
      if (!referenceIds.has(idValue)) throw new Error(`${path} references unknown id ${idValue}`);
    }

    const transitionValue = shot['transition'];
    if (transitionValue !== undefined && typeof transitionValue !== 'string') {
      throw new Error(`${path}.transition must be a string when supplied`);
    }
    const rawDialogue = shot['dialogue'];
    if (rawDialogue !== undefined && !Array.isArray(rawDialogue)) {
      throw new Error(`${path}.dialogue must be an array when supplied`);
    }
    const dialogue: StructuredDialogue[] | undefined = rawDialogue === undefined
      ? undefined
      : (rawDialogue as unknown[]).map((value, dialogueIndex) => {
        const line = structuredRecord(value);
        const linePath = `${path}.dialogue[${dialogueIndex}]`;
        const speakerId = structuredText(line['speakerId'], `${linePath}.speakerId`);
        if (!/^S\d+$/.test(speakerId)) throw new Error(`${linePath}.speakerId must look like S1`);
        const subjectId = structuredText(line['subjectId'], `${linePath}.subjectId`);
        if (!referenceIds.has(subjectId)) throw new Error(`${linePath}.subjectId references unknown id ${subjectId}`);
        const knownSubject = speakerSubjects.get(speakerId);
        if (knownSubject && knownSubject !== subjectId) {
          throw new Error(`${linePath}.speakerId ${speakerId} changes subject ownership`);
        }
        speakerSubjects.set(speakerId, subjectId);
        const language = structuredText(line['language'], `${linePath}.language`);
        const exactWords = structuredText(line['exactWords'], `${linePath}.exactWords`);
        const delivery = structuredText(line['delivery'], `${linePath}.delivery`);
        const available = spokenCounts.get(exactWords) ?? 0;
        if (available < 1) throw new Error(`${linePath}.exactWords must match an exact spokenLines entry`);
        spokenCounts.set(exactWords, available - 1);
        const voicePromptValue = line['voicePrompt'];
        if (voicePromptValue !== undefined && (typeof voicePromptValue !== 'string' || !voicePromptValue.trim())) {
          throw new Error(`${linePath}.voicePrompt must be a non-empty string when supplied`);
        }
        const offScreenValue = line['offScreen'];
        if (offScreenValue !== undefined && typeof offScreenValue !== 'boolean') {
          throw new Error(`${linePath}.offScreen must be a boolean when supplied`);
        }
        return {
          speakerId,
          subjectId,
          language,
          exactWords,
          delivery,
          voicePrompt: voicePromptValue as string | undefined,
          offScreen: offScreenValue as boolean | undefined,
        };
      });

    const remaining = [...spokenCounts.entries()].filter(([, count]) => count > 0);
    if (index === rawShots.length - 1 && remaining.length) {
      throw new Error(`spokenLines has dialogue without exact shot ownership: ${remaining.map(([line]) => line).join(' | ')}`);
    }
    return {
      id,
      startTime,
      endTime,
      composition,
      subjectIds,
      action,
      cameraMotion,
      cameraAmplitude: amplitudeValue as 'small' | 'large' | undefined,
      cameraSpeed: speedValue as 'slow' | 'fast' | undefined,
      sound,
      transition: transitionValue as string | undefined,
      dialogue,
      acting: Array.isArray(shot['acting']) ? shot['acting'] as StructuredShotActing[] : undefined,
    };
  });

  const performanceValue = root['performance'];
  const continuationAnchorValue = parseContinuityLedger(root['continuationAnchor'], 'continuationAnchor');
  const continuationFromValue = parseContinuityLedger(root['continuationFrom'], 'continuationFrom') as
    | ContinuationFrom
    | undefined;
  if (continuationFromValue) {
    const hardCut = (root['continuationFrom'] as Record<string, unknown>)['hardCut'];
    if (hardCut !== undefined) {
      if (typeof hardCut !== 'string' || !hardCut.trim()) {
        throw new Error('continuationFrom.hardCut must be a non-empty string when supplied');
      }
      continuationFromValue.hardCut = hardCut.trim();
    }
  }
  return {
    spokenLines,
    style: styleValue as string | undefined,
    summary,
    references,
    shots,
    overallSoundscape,
    nonDiegeticMusic,
    negatives,
    duration,
    purpose,
    shotStructure: rawShotStructure,
    performance: performanceValue as StructuredScenePerformance | undefined,
    continuationAnchor: continuationAnchorValue,
    continuationFrom: continuationFromValue,
  };
}

/**
 * Parse a continuity ledger, rejecting the shapes that would compile to nothing.
 *
 * A ledger whose landmarks have no screen position is the defect it exists to
 * prevent, so an entry missing `screenPosition` is an error rather than a field
 * quietly dropped — the whole point is that "left third" survives to the next
 * render and "in the kitchen" does not.
 */
function parseContinuityLedger(raw: unknown, field: string): ContinuityLedger | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${field} must be an object when supplied`);
  }
  const src = raw as Record<string, unknown>;

  const str = (v: unknown, path: string): string => {
    if (typeof v !== 'string' || !v.trim()) throw new Error(`${field}.${path} must be a non-empty string`);
    return v.trim();
  };
  const list = (v: unknown, path: string, required: boolean): Record<string, unknown>[] => {
    if (v === undefined || v === null) {
      if (required) throw new Error(`${field}.${path} is required`);
      return [];
    }
    if (!Array.isArray(v)) throw new Error(`${field}.${path} must be an array`);
    return v.map((entry, i) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new Error(`${field}.${path}[${i}] must be an object`);
      }
      return entry as Record<string, unknown>;
    });
  };

  const fixedLandmarks = list(src['fixedLandmarks'], 'fixedLandmarks', true).map((e, i) => ({
    name: str(e['name'], `fixedLandmarks[${i}].name`),
    screenPosition: str(e['screenPosition'], `fixedLandmarks[${i}].screenPosition`),
  }));
  if (!fixedLandmarks.length) throw new Error(`${field}.fixedLandmarks must have at least one entry`);

  const characterPositions = list(src['characterPositions'], 'characterPositions', true).map((e, i) => ({
    subjectId: str(e['subjectId'], `characterPositions[${i}].subjectId`),
    screenPosition: str(e['screenPosition'], `characterPositions[${i}].screenPosition`),
    facing: str(e['facing'], `characterPositions[${i}].facing`),
    pose: str(e['pose'], `characterPositions[${i}].pose`),
  }));

  const offStage = list(src['offStage'], 'offStage', false).map((e, i) => ({
    subjectId: str(e['subjectId'], `offStage[${i}].subjectId`),
    where: str(e['where'], `offStage[${i}].where`),
    reason: str(e['reason'], `offStage[${i}].reason`),
  }));

  const propStates = list(src['propStates'], 'propStates', false).map((e, i) => ({
    name: str(e['name'], `propStates[${i}].name`),
    state: str(e['state'], `propStates[${i}].state`),
  }));

  return {
    fixedLandmarks,
    characterPositions,
    lightingBaseline: str(src['lightingBaseline'], 'lightingBaseline'),
    ...(offStage.length ? { offStage } : {}),
    ...(propStates.length ? { propStates } : {}),
  };
}

/**
 * Compile the inherited boundary into DIRECTED PROSE, not labels.
 *
 * `key: value` pairs would land in the description as more of the non-visual
 * metadata that already crowds out the visual budget, so every field becomes a
 * clause H3 can render. The opening is placed after the style sentence and
 * before the first shot marker, which is where the hand-authored probe put it.
 *
 * Off-stage characters are stated as position and reason ONLY. No speech verb
 * may appear: "she calls from the hallway" with no <d> tag is exactly the
 * fatal `auditDialogueIntegrity` exists to catch, and this compiler must not be
 * the thing that introduces it.
 */
/**
 * Who was NOT in the film's world when this scene opened.
 *
 * Taken from the PLAN — the previous section's entity list — not from anything
 * a model authored. `offStage` was meant to carry this and the author left it
 * empty in every scene of the first real end-to-end run, however the prompt was
 * worded. `continuationFrom.characterPositions` carries it too, and scene 3 of
 * that run got it wrong by copying the previous scene's `continuationFrom`
 * instead of its `continuationAnchor`, which would have made a character who had
 * already arrived walk in twice.
 *
 * The plan is authored once, upstream, and is the same artifact the film's
 * pacing was built from. It cannot disagree with itself.
 */
function deriveArrivals(value: StructuredScenePrompt, previousEntities: readonly string[]): string[] {
  const wasPresent = new Set(previousEntities);
  const characterIds = new Set(
    value.references.filter((ref) => ref.type === 'character').map((ref) => ref.id),
  );
  const acting = new Set<string>();
  for (const shot of value.shots ?? []) {
    for (const entry of shot.acting ?? []) {
      if (characterIds.has(entry.subjectId)) acting.add(entry.subjectId);
    }
  }
  return [...acting].filter((id) => !wasPresent.has(id));
}

function compileContinuationFrom(from: ContinuationFrom, presentIds?: ReadonlySet<string>): string {
  const landmarks = from.fixedLandmarks
    .map((l) => `${l.name} ${l.screenPosition}`)
    .join(', ');
  // Drop anyone the inherited boundary lists who is not in THIS scene. They
  // were in the room when the previous scene ended and have since left; saying
  // "X is in the left third" would put a character on screen that this scene
  // has no plate for, and H3 would invent one.
  const people = from.characterPositions
    .filter((c) => !presentIds || presentIds.has(c.subjectId))
    .map((c) => `${c.subjectId} is ${c.screenPosition}, ${c.facing}, ${c.pose}`)
    .join('; ');
  const away = (from.offStage ?? [])
    .map((o) => `${o.subjectId} is not in frame — ${o.where}, ${o.reason}`)
    .join('; ');
  const props = (from.propStates ?? [])
    .map((p) => `${p.name}: ${p.state}`)
    .join('; ');

  // The lead is deliberately NEUTRAL about a previous clip. H3 has never seen
  // one — it renders this call and nothing else — so "this continues from the
  // previous scene" spends words telling it about something it cannot use, and
  // is a small lie on the film's first scene, which authors populate anyway.
  // What earns its place is the STATE. A hard cut keeps its clause because the
  // time or place shift is real information about what to render.
  const lead = from.hardCut
    ? `After a deliberate break — ${inlineFragment(from.hardCut)} — the scene opens on exactly this state:`
    : 'The scene opens on exactly this state:';

  const clauses = [
    `the set is fixed with ${landmarks}`,
    `the light is ${inlineFragment(from.lightingBaseline)}`,
    people,
    away,
    props ? `Prop state at the opening — ${props}` : '',
  ].filter(Boolean);

  return tidyPeriods(`${lead} ${clauses.join('. ')}.`);
}

const PERFORMANCE_REQUIRED_FIELDS = [
  'objective',
  'obstacle',
  'stakes',
  'physicalBusiness',
  'bodyState',
  'eyeLife',
] as const;

const PERFORMANCE_OPTIONAL_FIELDS = [
  'subtext',
  'statusDynamic',
  'proxemics',
] as const;

const VOICE_PROFILE_REQUIRED_FIELDS = [
  'subjectId',
  'voicePrompt',
] as const;

const ACTING_REQUIRED_FIELDS = [
  'subjectId',
  'tactic',
  'observableBehavior',
  'beatChange',
] as const;

function performancePathText(value: unknown, path: string): string {
  return structuredText(value, path);
}

/**
 * Validate the scene-level and per-shot ACTING contract before reference
 * resolution or any ComfyUI request. `expectedReferenceIds` is the section's
 * authoritative entity allowlist; an empty list falls back to the scene's own
 * declarations for legacy callers that do not have the plan available.
 */
export function validateStructuredScenePerformance(
  scene: unknown,
  expectedReferenceIds: readonly string[],
  strict: boolean,
): string[] {
  const notes: string[] = [];
  if (!strict) return notes;
  const root = structuredRecord(scene);
  const rawReferences = root['references'];
  if (!Array.isArray(rawReferences)) throw new Error('references must be an array before performance validation');

  const references = rawReferences.map((value, index) => {
    const ref = structuredRecord(value);
    return {
      id: performancePathText(ref['id'], `references[${index}].id`),
      type: performancePathText(ref['type'], `references[${index}].type`),
    };
  });
  const sceneRefById = new Map(references.map((ref) => [ref.id, ref]));
  const expectedDisplay = [...new Set(
    (expectedReferenceIds.length ? expectedReferenceIds : references.map((ref) => ref.id))
      .map((id) => String(id).trim()).filter(Boolean),
  )];
  const expected = new Set(expectedDisplay);
  const expectedIds = expectedDisplay.length ? expectedDisplay.join(', ') : '(none)';

  const rawPerformance = root['performance'];
  if (!rawPerformance || typeof rawPerformance !== 'object' || Array.isArray(rawPerformance)) {
    throw new Error('performance is required when strict performance mode is enabled');
  }
  const performance = rawPerformance as Record<string, unknown>;
  for (const field of PERFORMANCE_REQUIRED_FIELDS) {
    performancePathText(performance[field], `performance.${field}`);
  }
  for (const field of PERFORMANCE_OPTIONAL_FIELDS) {
    if (performance[field] !== undefined) performancePathText(performance[field], `performance.${field}`);
  }

  const rawShots = root['shots'];
  if (!Array.isArray(rawShots)) throw new Error('shots must be an array before performance validation');
  const dialogueSubjectIds = new Set<string>();
  const inlineVoicePrompts = new Set<string>();
  rawShots.forEach((rawShot, shotIndex) => {
    const shot = structuredRecord(rawShot);
    const rawDialogue = shot['dialogue'];
    if (rawDialogue !== undefined && !Array.isArray(rawDialogue)) {
      throw new Error(`shots[${shotIndex}].dialogue must be an array when supplied`);
    }
    (rawDialogue ?? []).forEach((rawLine, dialogueIndex) => {
      const line = structuredRecord(rawLine);
      const subjectId = performancePathText(
        line['subjectId'],
        `shots[${shotIndex}].dialogue[${dialogueIndex}].subjectId`,
      );
      // An OFF-SCREEN voice has no visual and therefore no plate, so the
      // speaker legitimately is not among this scene's references. The vocal
      // identity below is still required — that is what stops H3 picking a
      // voice at random — but the plate checks do not apply.
      //
      // This is the SECOND validator that enforced the same rule (the first is
      // validateStructuredSceneReferences in index.ts). Fixing one left the
      // other rejecting the identical line, which is why a finished 8-scene
      // film died twice on scene_8's off-screen "Sereth."
      const offScreen = line['offScreen'] === true;
      if (!offScreen) {
        if (!expected.has(subjectId)) {
          throw new Error(`shots[${shotIndex}].dialogue[${dialogueIndex}].subjectId "${subjectId}" is unknown; expected IDs: ${expectedIds}`);
        }
        const ref = sceneRefById.get(subjectId);
        if (!ref) {
          throw new Error(`shots[${shotIndex}].dialogue[${dialogueIndex}].subjectId "${subjectId}" is not declared in references; expected IDs: ${expectedIds}`);
        }
        if (ref.type !== 'character') {
          throw new Error(`shots[${shotIndex}].dialogue[${dialogueIndex}].subjectId "${subjectId}" is not a character reference`);
        }
      }
      dialogueSubjectIds.add(subjectId);
      if (line['voicePrompt'] !== undefined) {
        performancePathText(
          line['voicePrompt'],
          `shots[${shotIndex}].dialogue[${dialogueIndex}].voicePrompt`,
        );
        inlineVoicePrompts.add(subjectId);
      }
    });
  });

  // Voice identity comes from the LINE (new shape) or from a scene-level
  // `performance.voiceProfiles` list (legacy). The list had to agree with the
  // dialogue exactly and models broke it both ways — a profile for a
  // visible-but-silent character, and a missing profile for a speaker. On the
  // line, neither state can be expressed. The legacy path is kept so scenes
  // already on disk still validate.
  const rawVoiceProfiles = performance['voiceProfiles'];
  const usingInlineVoicePrompts = rawVoiceProfiles === undefined;
  if (usingInlineVoicePrompts) {
    const missingInline = [...dialogueSubjectIds].filter((id) => !inlineVoicePrompts.has(id));
    if (missingInline.length) {
      throw new Error(
        `every speaking subject needs a voicePrompt on its first line; missing for: ${missingInline.join(', ')}`,
      );
    }
  } else {
    if (!Array.isArray(rawVoiceProfiles)) {
      throw new Error('performance.voiceProfiles must be an array when supplied');
    }
    const voiceProfileBySubject = new Map<string, StructuredVoiceProfile>();
    rawVoiceProfiles.forEach((rawProfile, profileIndex) => {
      const profile = structuredRecord(rawProfile);
      const path = `performance.voiceProfiles[${profileIndex}]`;
      for (const field of VOICE_PROFILE_REQUIRED_FIELDS) performancePathText(profile[field], `${path}.${field}`);
      const subjectId = profile['subjectId'] as string;
      if (voiceProfileBySubject.has(subjectId)) {
        throw new Error(`${path}.subjectId duplicates ${subjectId} in performance.voiceProfiles`);
      }
      if (!expected.has(subjectId)) {
        throw new Error(`${path}.subjectId "${subjectId}" is unknown; expected IDs: ${expectedIds}`);
      }
      const ref = sceneRefById.get(subjectId);
      if (!ref) {
        throw new Error(`${path}.subjectId "${subjectId}" is not declared in references; expected IDs: ${expectedIds}`);
      }
      if (ref.type !== 'character') {
        throw new Error(`${path}.subjectId "${subjectId}" is a non-character reference and not a dialogue subject`);
      }
      if (!dialogueSubjectIds.has(subjectId)) {
        throw new Error(`${path}.subjectId "${subjectId}" is not a dialogue subject`);
      }
      voiceProfileBySubject.set(subjectId, {
        subjectId,
        voicePrompt: profile['voicePrompt'] as string,
      });
    });
    const missingVoiceProfiles = [...dialogueSubjectIds].filter((subjectId) => !voiceProfileBySubject.has(subjectId));
    if (missingVoiceProfiles.length) {
      throw new Error(`performance.voiceProfiles is missing dialogue subject(s): ${missingVoiceProfiles.join(', ')}`);
    }
  }

  rawShots.forEach((rawShot, shotIndex) => {
    const shot = structuredRecord(rawShot);
    const subjectIds = resolveShotSubjectIds(shot, `shots[${shotIndex}]`);
    const characterIds = subjectIds.filter((id) => sceneRefById.get(id)?.type === 'character');
    const rawActing = shot['acting'];
    if (rawActing !== undefined && !Array.isArray(rawActing)) {
      throw new Error(`shots[${shotIndex}].acting must be an array when supplied`);
    }
    const isLegacyShot = shot['subjectIds'] !== undefined;

    // A character filed under `sceneryIds` is a BACKGROUND PRESENCE, not an
    // error. The acting/scenery split assumes every character is a performer,
    // and a collective is not: an advancing rank of skeletons a hundred feet
    // away, a crowd behind a barrier, a body on the floor. Measured on a real
    // film — a horde typed `character` in the bible was filed as scenery by the
    // scene author, which is the right reading, and the render was rejected for
    // it, killing a 60s battle.
    //
    // So they stay visible and are simply exempt from the per-character acting
    // requirement below. Filing a LEAD this way silently costs its acting
    // direction, which is why it is logged rather than accepted quietly.
    const backgroundCharacters = new Set<string>();
    if (!isLegacyShot && Array.isArray(shot['sceneryIds'])) {
      shot['sceneryIds'].forEach((id) => {
        const ref = sceneRefById.get(String(id));
        if (ref?.type === 'character') backgroundCharacters.add(String(id));
      });
    }

    // LEGACY ONLY. In the derived shape `characterIds` comes from `acting`
    // itself, so "a character in the shot with no acting entry" is not a state
    // that can be expressed — gating on the legacy shape keeps this from
    // pre-empting the more specific errors above and below.
    if (isLegacyShot && characterIds.length && (!Array.isArray(rawActing) || rawActing.length === 0)) {
      throw new Error(`shots[${shotIndex}].acting is required for character subject(s): ${characterIds.join(', ')}`);
    }
    const actingBySubject = new Set<string>();
    (rawActing ?? []).forEach((rawActingItem, actingIndex) => {
      const acting = structuredRecord(rawActingItem);
      const path = `shots[${shotIndex}].acting[${actingIndex}]`;
      for (const field of ACTING_REQUIRED_FIELDS) performancePathText(acting[field], `${path}.${field}`);
      for (const field of ['reaction', 'assessmentMoment', 'interruptedAction'] as const) {
        if (acting[field] !== undefined) performancePathText(acting[field], `${path}.${field}`);
      }
      const subjectId = acting['subjectId'] as string;
      if (!expected.has(subjectId)) {
        throw new Error(`${path}.subjectId "${subjectId}" is unknown; expected IDs: ${expectedIds}`);
      }
      const ref = sceneRefById.get(subjectId);
      if (!ref) {
        throw new Error(`${path}.subjectId "${subjectId}" is not declared in references; expected IDs: ${expectedIds}`);
      }
      if (ref.type !== 'character') {
        // List only the CHARACTERS. This used to print the whole allowlist
        // under the words "expected character IDs from:", so the message named
        // the very objects and locations it was rejecting.
        const characterOptions = references.filter((r) => r.type === 'character').map((r) => r.id);
        throw new Error(
          `${path}.subjectId "${subjectId}" is a ${ref.type}, not a character — put objects and locations in sceneryIds. ` +
            `Character IDs in this scene: ${characterOptions.length ? characterOptions.join(', ') : '(none)'}`,
        );
      }
      if (!subjectIds.includes(subjectId)) {
        throw new Error(`${path}.subjectId "${subjectId}" is not present in this shot's subjectIds`);
      }
      if (actingBySubject.has(subjectId)) {
        throw new Error(`${path}.subjectId duplicates ${subjectId} in the same shot`);
      }
      actingBySubject.add(subjectId);
    });
    const missing = characterIds.filter((id) => !actingBySubject.has(id) && !backgroundCharacters.has(id));
    if (missing.length) {
      throw new Error(`shots[${shotIndex}].acting is missing character subject(s): ${missing.join(', ')}`);
    }
    if (backgroundCharacters.size) {
      notes.push(
        `shots[${shotIndex}]: ${[...backgroundCharacters].join(', ')} appear(s) as background presence (filed in sceneryIds, no acting direction)`,
      );
    }

    // A speaker with no acting entry is not on screen in this shot. That is a
    // legal thing to want (a voiceover), but it must be SAID — otherwise a
    // forgotten acting entry silently turns a character into a disembodied
    // voice, which is the one failure the derived shape would not catch.
    if (!isLegacyShot) {
      (shot['dialogue'] as unknown[] | undefined ?? []).forEach((rawLine, dialogueIndex) => {
        const line = structuredRecord(rawLine);
        const subjectId = String(line['subjectId'] ?? '');
        if (actingBySubject.has(subjectId)) return;
        if (line['offScreen'] !== true) {
          throw new Error(
            `shots[${shotIndex}].dialogue[${dialogueIndex}] subject "${subjectId}" speaks but is not in this shot's acting[], so nothing puts them on screen. ` +
              `Add an acting entry for them, or set offScreen: true if the line is meant to be an off-screen voiceover.`,
          );
        }
      });
    }
  });

  // `continuationAnchor` describes the state THIS scene ends in, so everyone
  // visible in it is in this scene and must have a plate. Checked.
  //
  // `continuationFrom` is NOT checked, and neither is either ledger's
  // `offStage`. The inherited boundary is the PREVIOUS scene's end state, which
  // routinely names someone who then leaves — a woman at a window in scene 1
  // who is not in scene 2 at all. Rejecting that failed a real film on
  // `continuationFrom.characterPositions[0].subjectId "meera" is unknown`,
  // which is the same mistake `offStage` validation made: treating a boundary
  // ledger as if it described this scene's cast. It does not.
  {
    const anchor = root['continuationAnchor'];
    if (anchor && typeof anchor === 'object' && !Array.isArray(anchor)) {
      const rawPositions = (anchor as Record<string, unknown>)['characterPositions'];
      if (Array.isArray(rawPositions)) {
        rawPositions.forEach((rawEntry, index) => {
          const entry = structuredRecord(rawEntry);
          const subjectId = performancePathText(
            entry['subjectId'],
            `continuationAnchor.characterPositions[${index}].subjectId`,
          );
          if (!expected.has(subjectId)) {
            throw new Error(
              `continuationAnchor.characterPositions[${index}].subjectId "${subjectId}" is unknown; expected IDs: ${expectedIds}`,
            );
          }
        });
      }
    }
  }

  // An off-stage entry that describes someone SPEAKING is the exact fatal
  // auditDialogueIntegrity catches downstream — "she calls from the hallway"
  // with no <d> tag synthesises voice-shaped noise. Caught here so the message
  // names the field instead of the compiled prose.
  const from = root['continuationFrom'];
  if (from && typeof from === 'object' && !Array.isArray(from)) {
    const offStage = (from as Record<string, unknown>)['offStage'];
    if (Array.isArray(offStage)) {
      offStage.forEach((rawEntry, index) => {
        const entry = structuredRecord(rawEntry);
        const text = `${entry['where'] ?? ''} ${entry['reason'] ?? ''}`;
        const verb = LEDGER_SPEECH_VERBS.find((v) => new RegExp(`\\b${v}\\b`, 'i').test(text));
        if (verb) {
          throw new Error(
            `continuationFrom.offStage[${index}] describes speech ("${verb}"), which synthesises voice with no words. ` +
              `State only where the subject is and why they are off screen.`,
          );
        }
      });
    }
  }
  return notes;
}

/**
 * A scene with no words gets NO score (founder rule, measured 2026-08-08).
 *
 * H3 synthesises ONE audio track for the whole clip. With no `<d>` anywhere,
 * the vocal channel has nothing to anchor to, and a `non_diegetic_music`
 * request comes back as gibberish — sung or muttered voice-shaped noise laid
 * over the music. It is the same failure mode as describing speech without
 * supplying the words, arriving from the other direction.
 *
 * Coerced here rather than rejected. The defect is mechanical and so is the
 * fix, and failing the run would cost a whole authoring round-trip to change
 * one field — the same reasoning that makes `repairH3Prose` a repair and
 * `auditDialogueIntegrity` a rejection. A wordless scene that wants mood puts
 * it in `overall_soundscape` as physical sound, or gets scored in the edit.
 */
function silenceScoreWithoutDialogue(value: StructuredScenePrompt): string {
  const music = (value.nonDiegeticMusic ?? '').trim();
  if (!music || /^n\/?a\.?$/i.test(music)) return 'N/A';
  const hasDialogue =
    (value.spokenLines ?? []).some((line) => String(line ?? '').trim()) ||
    (value.shots ?? []).some((shot) => (shot.dialogue ?? []).some((line) => String(line?.exactWords ?? '').trim()));
  return hasDialogue ? music : 'N/A';
}

/**
 * Speech verbs forbidden in an off-stage ledger entry. Deliberately the plain
 * forms only — this is a guard against describing an unvoiced line, not a
 * general prose filter, and a false positive here blocks a legitimate scene.
 */
const LEDGER_SPEECH_VERBS = [
  'says', 'said', 'speaks', 'speaking', 'shouts', 'shouting', 'calls', 'calling',
  'whispers', 'whispering', 'murmurs', 'murmuring', 'replies', 'replying',
  'asks', 'asking', 'answers', 'answering', 'voice',
] as const;

function compileStructuredActing(
  acting: StructuredShotActing,
  subjectIndexById: Map<string, number>,
): string {
  const subjectIndex = subjectIndexById.get(acting.subjectId);
  if (!subjectIndex) throw new Error(`acting subject ${acting.subjectId} is not in references`);
  return [
    `<Subject ${subjectIndex}> Acting:`,
    `Tactic: ${acting.tactic}.`,
    `Observable behavior: ${acting.observableBehavior}.`,
    `Beat change: ${acting.beatChange}.`,
    acting.reaction ? `Reaction: ${acting.reaction}.` : '',
    acting.assessmentMoment ? `Assessment moment: ${acting.assessmentMoment}.` : '',
    acting.interruptedAction ? `Interrupted action: ${acting.interruptedAction}.` : '',
  ].filter(Boolean).join(' ');
}

/**
 * Lower-case a leading capital and drop a trailing period, so an authored
 * fragment drops cleanly into a sentence frame.
 *
 * The frames read `<Subject N> is ___ in <Picture N>.` and `Follow it for ___.`,
 * but the fields feeding them are described as standalone answers, so models
 * write "Tall, narrow figure …" and "The defiant smith …". Measured on one
 * four-reference scene: 24 double periods, 3 broken `is <Capital>` frames, 4
 * `Follow it for <Capital>` — in EVERY reference of EVERY scene. Constraining
 * the model instead was tried and measured 5-10x completion tokens plus a retry
 * cascade, so this is normalised here where it is free.
 *
 * An ALL-CAPS or acronym-initial fragment is left alone (`ID reference shoot`),
 * since lower-casing it would be wrong.
 */
function inlineFragment(text: string): string {
  const trimmed = text.trim().replace(/\.+$/, '');
  if (!trimmed) return '';
  const isAcronymStart = /^[A-Z]{2,}/.test(trimmed);
  return isAcronymStart ? trimmed : trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
}

/** Collapse `..` left over from a fragment that already ended in a period. */
function tidyPeriods(text: string): string {
  return text.replace(/\.{2,}(?!\.)/g, '.').replace(/\.\s*\./g, '.');
}

/**
 * Only the FILMABLE half of `performance` reaches H3.
 *
 * `objective`, `obstacle`, `stakes`, `subtext` and `statusDynamic` are by
 * construction not visible or audible — they are why the character acts, not
 * what the camera sees — and the ref guide is explicit that every detail should
 * correspond to something visible or audible, and that the description must not
 * decay into plot summary. Measured on a real film: this block was 121 words of
 * a 332-word description, sitting in the highest-leverage position in the
 * prompt (before [Shot 1]) where the guide puts the STYLE sentence.
 *
 * They still earn their place in the schema — they are what makes the per-shot
 * `acting` adaptations coherent — they just are not sent to the renderer.
 */
function compileStructuredPerformance(performance: StructuredScenePerformance): string {
  return [
    `Physical business: ${performance.physicalBusiness}.`,
    `Body state: ${performance.bodyState}.`,
    `Eye life: ${performance.eyeLife}.`,
    performance.proxemics ? `Proxemics: ${performance.proxemics}.` : '',
  ].filter(Boolean).map((s) => tidyPeriods(s)).join(' ');
}

/**
 * Camera motion as natural English inside the shot, not a stacked label.
 *
 * Base guide 4.3: "Camera motion should be written as a natural English action
 * within the shot, rather than stacked as separate labels at the end of a
 * sentence", and our own measurements note that "in a static medium shot" does
 * not register as `Static Shot`. The compiler emitted `Camera: Push In.` —
 * exactly the forbidden form — in every shot of every scene.
 *
 * The controlled term is preserved verbatim inside the sentence, which is what
 * H3 is trained on; only the framing around it changes.
 */
const CAMERA_PHRASING: Record<CameraMotion, string> = {
  'Zoom In': 'The camera performs a Zoom In',
  'Zoom Out': 'The camera performs a Zoom Out',
  'Push In': 'The camera performs a Push In',
  'Pull Out': 'The camera performs a Pull Out',
  'Pan Left': 'The camera performs a Pan Left',
  'Pan Right': 'The camera performs a Pan Right',
  'Truck Left': 'The camera performs a Truck Left',
  'Truck Right': 'The camera performs a Truck Right',
  'Tilt Up': 'The camera performs a Tilt Up',
  'Tilt Down': 'The camera performs a Tilt Down',
  'Pedestal Up': 'The camera performs a Pedestal Up',
  'Pedestal Down': 'The camera performs a Pedestal Down',
  'Arc Shot': 'The camera holds an Arc Shot around the subject',
  'Tracking Shot': 'The camera holds a Tracking Shot following the subject',
  'Static Shot': 'The camera holds a Static Shot',
  'Shake Slightly': 'The camera holds the frame and Shake Slightly',
  'Shake Strongly': 'The camera holds the frame and Shake Strongly',
  'POV': 'The shot is a POV from the subject',
  'Roll Clockwise': 'The camera performs a Roll Clockwise',
  'Roll Counterclockwise': 'The camera performs a Roll Counterclockwise',
};

function compileCameraMotion(shot: StructuredSceneShot): string {
  const base = CAMERA_PHRASING[shot.cameraMotion] ?? `The camera holds a ${shot.cameraMotion}`;
  const amplitude = shot.cameraAmplitude ? ` with ${shot.cameraAmplitude} amplitude` : '';
  const speed = shot.cameraSpeed ? ` at ${shot.cameraSpeed} speed` : '';
  return `${base}${amplitude}${speed}.`;
}

/**
 * A cut marker that grammatically continues `At MM:SS.mmm, `.
 *
 * The authored `transition` is a standalone sentence, so it arrives capitalised
 * and often without a documented cut verb — producing `At 00:04.000, The cut
 * reveals …`. Measured on real output: capitalised mid-sentence in most scenes,
 * and missing the cut phrase entirely in several. A `pattern` was tried and
 * measured a 5-10x token blow-up, so it is repaired here instead.
 */
const CUT_PHRASE = /^the (shot|camera) (cuts?|transitions?|changes?|switches)\b/i;

function compileCutMarker(index: number, shot: StructuredSceneShot, time: string): string {
  const authored = inlineFragment(shot.transition ?? '');
  if (!authored) return `[Shot ${index + 1}] At ${time}, the shot cuts to a new view.`;
  if (CUT_PHRASE.test(authored)) return `[Shot ${index + 1}] At ${time}, ${authored}.`;
  // The author described what the cut REVEALS but not that it is a cut; supply
  // the documented verb and keep their reveal as the clause it introduces.
  return `[Shot ${index + 1}] At ${time}, the shot cuts to a new view — ${authored}.`;
}

/**
 * Negatives as statements of ABSENCE rather than a semicolon list of nouns.
 *
 * The ref2va graph is guidance-distilled and has no negative-conditioning input,
 * so whatever is written here is read as positive prose. `Negative directions:
 * subtitles; extra people; Vashti flinching.` therefore hands H3 the word
 * "subtitles" and the image of "Vashti flinching" as things to render. Measured
 * across models: 6/6 negatives came out as bare nouns on some runs and as
 * absence phrases on others, so the phrasing cannot be left to the author.
 */
/**
 * The one phrasing of the negatives sentence, shared with the dialogue audit.
 *
 * These two MUST agree: the audit scans the description for speech verbs, and a
 * silent scene legitimately asks for "no murmurs, no whispers". When the
 * negatives sentence was reworded from `Negative directions: …` to an absence
 * statement, the audit's strip pattern was left matching the old form — and the
 * next silent scene was rejected for asking for silence. A shared constant is
 * what stops that happening again.
 */
export const NEGATIVES_SENTENCE_PREFIX = 'The frame stays free of ';

function compileNegatives(negatives: string[]): string {
  const items = negatives
    .map((n) => inlineFragment(n))
    .filter(Boolean)
    .map((n) => n.replace(/^(no|not|never|avoid|without)\s+/i, ''));
  if (!items.length) return '';
  const list = items.length === 1
    ? items[0]!
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]!}`;
  return tidyPeriods(`${NEGATIVES_SENTENCE_PREFIX}${list} throughout.`);
}

function compileStructuredDialogue(
  line: StructuredDialogue,
  subjectIndexById: Map<string, number>,
  visibleInShot: boolean,
): string {
  const subjectIndex = subjectIndexById.get(line.subjectId);
  if (!subjectIndex) throw new Error(`dialogue subject ${line.subjectId} is not in references`);
  const tag = `<d>[${line.language}] ${line.exactWords}</d>`;
  // `says ${delivery}` needs an adverbial. Models supply bare adjectives
  // ("defiant, gritty"), which reads as `says defiant, gritty:`. Adjective-only
  // deliveries are wrapped; anything already adverbial ("quietly", "with a
  // strained breath", "in an even tone") is left untouched.
  const d = line.delivery.trim().replace(/^,\s*/, '');
  const adverbial = /\b\w+ly\b|^(with|in|through|under|as|while|after|before|at)\b/i.test(d)
    ? d
    : `in a ${d} tone`;
  if (!line.offScreen) {
    return `<Subject ${subjectIndex}> (${line.speakerId}) says ${adverbial}: ${tag}`;
  }
  // Base guide 4.4: voiceover uses this EXACT phrase, and when the speaker is
  // also on screen the lips-closed statement follows immediately after the tag.
  const lead = `<Subject ${subjectIndex}> (${line.speakerId}) says in an off-screen voiceover, ${adverbial}: ${tag}`;
  return visibleInShot ? `${lead} while their lips remain completely closed.` : lead;
}

/** Compile the strict scene IR into the existing canonical six-section H3 prompt. */
export function compileStructuredScenePrompt(
  scene: unknown,
  options: StructuredSceneCompileOptions = {},
): CompiledStructuredScenePrompt {
  if (options.strictPerformance) {
    validateStructuredScenePerformance(scene, options.expectedReferenceIds ?? [], true);
  }
  const value = validateStructuredScene(scene);
  const subjectIndexById = new Map(value.references.map((reference, index) => [reference.id, index + 1]));
  const shotsBySubjectIndex = new Map<number, number[]>();
  value.shots.forEach((shot, shotIdx) => {
    for (const id of shot.subjectIds) {
      const n = subjectIndexById.get(id);
      if (!n) continue;
      const list = shotsBySubjectIndex.get(n) ?? [];
      if (!list.includes(shotIdx + 1)) list.push(shotIdx + 1);
      shotsBySubjectIndex.set(n, list);
    }
  });
  const subjectSections = buildSubjectSections(value.references, shotsBySubjectIndex);
  // Voice identity: prefer the per-line `voicePrompt` (new shape), falling back
  // to the scene-level list (legacy). First occurrence per subject wins, which
  // is also the only one emitted.
  const voiceProfileBySubject = new Map<string, StructuredVoiceProfile>();
  if (options.strictPerformance) {
    for (const shot of value.shots) {
      for (const line of shot.dialogue ?? []) {
        if (line.voicePrompt && !voiceProfileBySubject.has(line.subjectId)) {
          voiceProfileBySubject.set(line.subjectId, {
            subjectId: line.subjectId,
            voicePrompt: line.voicePrompt,
          });
        }
      }
    }
    for (const profile of value.performance?.voiceProfiles ?? []) {
      if (!voiceProfileBySubject.has(profile.subjectId)) voiceProfileBySubject.set(profile.subjectId, profile);
    }
  }
  const emittedVoiceProfiles = new Set<string>();
  const shotDescription = value.shots.map((shot, index) => {
    const marker = index === 0
      ? '[Shot 1]'
      : compileCutMarker(index, shot, formatStructuredTime(shot.startTime));
    const visibleSubjects = shot.subjectIds
      .map((subjectId) => `<Subject ${subjectIndexById.get(subjectId)!}>`)
      .join(', ');
    const dialogue = (shot.dialogue ?? [])
      .map((line) => {
        const voiceIdentity = options.strictPerformance && !emittedVoiceProfiles.has(line.subjectId)
          ? (() => {
            const profile = voiceProfileBySubject.get(line.subjectId);
            if (!profile) throw new Error(`missing voice profile for dialogue subject ${line.subjectId}`);
            emittedVoiceProfiles.add(line.subjectId);
            return `Voice identity for <Subject ${subjectIndexById.get(line.subjectId)!}>: ${profile.voicePrompt}`;
          })()
          : '';
        const visibleInShot = shot.subjectIds.includes(line.subjectId);
        return [voiceIdentity, compileStructuredDialogue(line, subjectIndexById, visibleInShot)]
          .filter(Boolean).join(' ');
      })
      .join(' ');
    const acting = options.strictPerformance
      ? (shot.acting ?? [])
        .map((entry) => compileStructuredActing(entry, subjectIndexById))
        .join(' ')
      : '';
    return [
      marker,
      shot.composition,
      `Visible subjects: ${visibleSubjects}.`,
      `Action: ${shot.action}`,
      compileCameraMotion(shot),
      `Sound: ${shot.sound}.`,
      acting,
      dialogue,
    ].filter(Boolean).map((part) => tidyPeriods(part)).join(' ');
  }).join('\n\n');
  const performance = options.strictPerformance && value.performance
    ? compileStructuredPerformance(value.performance)
    : '';
  // `continuationAnchor` is deliberately NOT compiled. It describes the state
  // this scene ends in, for the NEXT scene to open on — a state after the clip
  // is over. Emitting it here (as `Continuation anchor: …`) put a metadata label
  // in the visual budget and told H3 to render something past its own last
  // frame, in the one scene that could never benefit from it.
  const trailer = compileNegatives(value.negatives);
  // Ref guide 5.2: in full-reference mode the style opening comes BEFORE the
  // first shot marker. It leads the description; the filmable half of
  // `performance` follows it, and the non-filmable half is not emitted at all.
  const styleOpening = value.style ? tidyPeriods(value.style.trim().replace(/\.*$/, '.')) : '';
  // The inherited boundary sits between the style sentence and the first shot —
  // the placement the hand-authored probe used, and the last thing H3 reads
  // before it starts staging [Shot 1].
  const sceneReferenceIds = new Set((value.references ?? []).map((ref) => ref.id));
  let continuationOpening = value.continuationFrom
    ? compileContinuationFrom(value.continuationFrom, sceneReferenceIds)
    : '';
  // A character acting in this scene who was not in the previous section must be
  // SEEN TO ENTER. Independent of continuationFrom, because the plan knows this
  // and the author does not reliably. Phrased non-vocally: an arrival described
  // with a voice and no words is the speech-shaped-noise fatal.
  const arrivals = options.previousSectionEntities
    ? deriveArrivals(value, options.previousSectionEntities)
    : [];
  if (arrivals.length) {
    const who = arrivals.join(' and ');
    const plural = arrivals.length > 1;
    const directive = tidyPeriods(
      `${who} ${plural ? 'are' : 'is'} not in the room as the scene opens. ` +
        `The scene must SHOW ${plural ? 'them' : 'them'} come in — entering frame, stepping through a ` +
        `doorway, or arriving into the light — before anything else happens with ${plural ? 'them' : 'them'}. ` +
        `${plural ? 'They are' : 'They are'} never simply present in the first frame.`,
    );
    continuationOpening = continuationOpening ? `${continuationOpening} ${directive}` : directive;
  }
  const detailedDescription = [styleOpening, continuationOpening, performance, shotDescription, trailer]
    .filter(Boolean).join('\n\n');

  const sections = [
    { name: 'subject_definitions', body: subjectSections.subjectDefinitions },
    { name: 'summary', body: value.summary },
    { name: 'retention_analysis', body: subjectSections.retentionAnalysis },
    { name: 'detailed_description', body: detailedDescription },
    { name: 'overall_soundscape', body: value.overallSoundscape },
    { name: 'non_diegetic_music', body: silenceScoreWithoutDialogue(value) },
  ] as CompiledH3Section[];
  return {
    sections,
    prompt: assembleH3Prompt({
      subjectDefinitions: subjectSections.subjectDefinitions,
      summary: value.summary,
      retentionAnalysis: subjectSections.retentionAnalysis,
      detailedDescription,
      overallSoundscape: value.overallSoundscape,
      nonDiegeticMusic: value.nonDiegeticMusic,
    }),
    detailedDescription,
  };
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
export function buildSubjectSections(
  refs: SubjectRef[],
  shotsBySubjectIndex?: Map<number, number[]>,
): {
  subjectDefinitions: string;
  retentionAnalysis: string;
  /** 0-based ref index -> 1-based <Subject N>. Several refs may share a subject. */
  subjectIndexByRef: number[];
} {
  // GROUP BY IDENTITY, not by image slot. A multi-view identity sheet is split
  // into separate reference images (`sudha#v0`, `sudha#v1`) because H3 reads a
  // contact sheet as scenery — but those are two PICTURES of ONE subject, and
  // emitting one <Subject N> per picture told H3 there were two women in a
  // saree. It rendered two. Reported on a real film: a scene written for one
  // character came back with two people in frame.
  //
  // The guide is explicit that this is the supported shape: "One subject may be
  // defined by multiple reference assets", written as a single subject citing
  // each asset. Grouping also realigns the numbering — <Subject N> in the
  // description is built from the AUTHORED references (one per character), so
  // once expansion added a second picture the two lists disagreed about who
  // Subject 2 was.
  const groups: Array<{ base: string; pictures: number[]; ref: SubjectRef }> = [];
  const subjectIndexByRef: number[] = [];
  refs.forEach((r, i) => {
    const base = String(r.id ?? `\u0000${i}`).replace(/#v\d+$/, '');
    const last = groups[groups.length - 1];
    if (last && last.base === base) last.pictures.push(i + 1);
    else groups.push({ base, pictures: [i + 1], ref: r });
    subjectIndexByRef[i] = groups.length;
  });

  const defs: string[] = [];
  const rets: string[] = [];
  groups.forEach((g, gi) => {
    const n = gi + 1;
    // "(view 1)" is a crop artefact, not part of what the subject looks like
    const what = inlineFragment((g.ref.appearsAs ?? '').replace(/\s*\(view \d+\)\s*$/i, '')) || 'the referenced subject';
    const job = inlineFragment(g.ref.job ?? '');
    const marker: RetentionMarker = g.ref.retention ?? 'fully_preserved';
    const pics = g.pictures.map((p) => `<Picture ${p}>`);
    const cited = pics.length === 1
      ? pics[0]!
      : `${pics.slice(0, -1).join(', ')} and ${pics[pics.length - 1]!}`;
    const same = pics.length > 1 ? ' They are the same subject seen from different angles, not separate characters.' : '';
    defs.push(tidyPeriods(`<Subject ${n}> is ${what} in ${cited}.${job ? ` Follow it for ${job}.` : ''}${same}`));
    const shots = shotsBySubjectIndex?.get(n) ?? [];
    const where = shots.length ? ` (appears in ${shots.map((x) => `[Shot ${x}]`).join(', ')})` : '';
    rets.push(tidyPeriods(`<Subject ${n}>${where}: ${marker} - ${job || `${what} is retained exactly as shown`}.`));
  });
  return { subjectDefinitions: defs.join('\n'), retentionAnalysis: rets.join('\n'), subjectIndexByRef };
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
  // The compiled prose ends with a negatives sentence, which is a list of things
  // that must NOT happen. Scanning it for speech verbs turns a correct
  // instruction into a fatal: a silent scene that asks for "no whispering, no
  // shouting" reads as three separate claims that someone speaks. Measured on
  // ember_wright scene_4 TWICE — once with the old `Negative directions:` form,
  // and again after the sentence was reworded here without updating the strip.
  // Hence NEGATIVES_SENTENCE_PREFIX, shared with the compiler.
  //
  // (The sentence is still sent to H3; a negative that names a speech act is
  // its own prompt-quality hazard, but not a reason to block a render.)
  const escapedPrefix = NEGATIVES_SENTENCE_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const described = prose
    .replace(new RegExp(`^${escapedPrefix}[^\n]*$`, 'gm'), '')
    .replace(/^Negative directions:[^\n]*$/gm, '');
  const assigned = planShots.map((s) => normLine(s.dialogue)).filter(Boolean);

  const fatal: string[] = [];
  const warnings: string[] = [];

  const verbs = [...new Set((described.match(SPEECH_VERBS) || []).map((v) => v.toLowerCase()))];
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
 * Language name (lower-cased) -> the Unicode script block its words should contain.
 *
 * The ranges are the first and last code point of each script's Unicode block,
 * written as literal characters — a block's endpoints are usually unassigned or
 * combining marks, so they look like blanks or stray accents here rather than
 * letters. That is expected; the label above each line is what identifies the
 * block. Keep this file UTF-8: re-encoding it would quietly widen or collapse
 * these classes, and a silently-broken class makes the gate fail open.
 */
const SCRIPT_BY_LANGUAGE: Record<string, RegExp> = {
  // Devanagari
  hindi: /[ऀ-ॿ]/, marathi: /[ऀ-ॿ]/, nepali: /[ऀ-ॿ]/,
  sanskrit: /[ऀ-ॿ]/, konkani: /[ऀ-ॿ]/,
  // Bengali
  bengali: /[ঀ-৿]/, bangla: /[ঀ-৿]/, assamese: /[ঀ-৿]/,
  // Gurmukhi
  punjabi: /[਀-੿]/, gurmukhi: /[਀-੿]/,
  // Gujarati
  gujarati: /[઀-૿]/,
  // Odia
  odia: /[଀-୿]/, oriya: /[଀-୿]/,
  // Tamil
  tamil: /[஀-௿]/,
  // Telugu
  telugu: /[ఀ-౿]/,
  // Kannada
  kannada: /[ಀ-೿]/,
  // Malayalam
  malayalam: /[ഀ-ൿ]/,
  // Sinhala
  sinhala: /[඀-෿]/,
  // Arabic, plus the Arabic Supplement block that carries Urdu/Pashto-specific letters
  urdu: /[؀-ۿݐ-ݿ]/, arabic: /[؀-ۿݐ-ݿ]/,
  persian: /[؀-ۿݐ-ݿ]/, farsi: /[؀-ۿݐ-ݿ]/,
  pashto: /[؀-ۿݐ-ݿ]/,
  // Hebrew
  hebrew: /[֐-׿]/,
  // Greek
  greek: /[Ͱ-Ͽ]/,
  // Cyrillic
  russian: /[Ѐ-ӿ]/, ukrainian: /[Ѐ-ӿ]/,
  bulgarian: /[Ѐ-ӿ]/, serbian: /[Ѐ-ӿ]/,
  // Thai
  thai: /[฀-๿]/,
  // CJK Unified Ideographs
  chinese: /[一-鿿]/, mandarin: /[一-鿿]/, cantonese: /[一-鿿]/,
  // Japanese: hiragana/katakana, or kanji
  japanese: /[぀-ヿ一-鿿]/,
  // Korean: Hangul syllables, or Jamo
  korean: /[가-힣ᄀ-ᇿ]/,
};

/**
 * Flag a `<d>[Language] words</d>` tag whose words are romanized Latin transcription
 * of a non-Latin-scripted language, instead of the language's own script.
 *
 * A seed-matched A/B render just measured what that costs: the SAME Hindi line
 * written as romanized Latin (`Aap kya padh rahi hain? Mujhe Delhi jaana hai.`) came
 * out with H3 applying ENGLISH PHONETICS to tokens Latin cannot spell — `padh` got
 * an English *d* instead of the retroflex ढ़, `Delhi` came out anglicised. The
 * identical line in Devanagari (`आप क्या पढ़ रही हैं? मुझे दिल्ली जाना है।`) was
 * pronounced correctly throughout, same seed, same everything else. H3 reads the
 * text phonetically off the script it's actually written in, so a romanized
 * transcription of a script-based language is not "the same words, easier to type"
 * — it is words in a spelling system that cannot represent its own sounds.
 *
 * The test is deliberately weak: "contains at least one character of the expected
 * script", never "is entirely that script". A Hindi line legitimately embeds Latin
 * proper nouns and English loanwords (`मुझे Delhi जाना है।`), so requiring purity
 * would flag correct lines. One native-script character is enough to prove the line
 * was actually written in it rather than transliterated.
 *
 * Why structural and not a prompt rule: every prose dialogue rule tried on this
 * bundle has drifted, and this one is exactly checkable — the language name is
 * right there in the tag, and its script is a fixed Unicode range — so a rule the
 * model keeps breaking does not belong in a prompt.
 */
export function auditDialogueScript(prose: string): string[] {
  const findings: string[] = [];
  for (const m of prose.matchAll(/<d>\[([^\]]*)\]([\s\S]*?)<\/d>/g)) {
    const language = m[1]!.trim().toLowerCase();
    const words = m[2]!;
    const script = SCRIPT_BY_LANGUAGE[language];
    if (!script) continue;
    if (!script.test(words)) {
      const quote = words.trim().slice(0, 60);
      findings.push(
        `romanized ${m[1]!.trim()} in <d>[${m[1]!.trim()}]…</d> — "${quote}" contains no native script; ` +
          'H3 will apply English phonetics and mispronounce it',
      );
    }
  }
  return findings;
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

/**
 * Sampler steps scaled to how much the scene is actually asking for.
 *
 * The turbo LoRA is distilled to a low step count, and driving it at a fixed 8
 * was measured to cost real quality: feeding 8 sigmas to the 4-step
 * MiniMaxH3TurboSampler attenuates the generated audio by ~15 dB and strips
 * ~8 dB of high-frequency detail (dhee-bundle-illustrated-story-h3#10). So 4 is
 * the floor AND the default — but a 15s four-cut scene with two speakers and
 * nine plates is not the same problem as an 8s locked single, and the extra
 * steps are cheap next to a re-render.
 *
 * The score is deliberately made of things the scene already declares, so no
 * new authored field is needed and nothing can disagree with the render:
 *
 *   cuts        one shot is a held beat; four cuts is four compositions to resolve
 *   references  every extra plate is more identity to hold simultaneously
 *   dialogue    lip-sync and voice are the parts that punish a short schedule
 *   duration    more frames to keep coherent
 *
 * Returns `minSteps` for the simplest scene and `maxSteps` for the busiest, on
 * discrete tiers (4/6/8/10 by default), so a caller that wants a fixed count
 * just sets `steps` instead.
 */
export const RENDER_COMPLEXITY_LEVELS = ['simple', 'moderate', 'complex', 'extreme'] as const;
export type RenderComplexity = (typeof RENDER_COMPLEXITY_LEVELS)[number];

export interface SceneComplexityInput {
  shots?: unknown;
  references?: unknown;
  duration?: unknown;
  /** The authoring model's own judgement of how hard this scene is to RENDER. */
  renderComplexity?: unknown;
}

export function stepsForSceneComplexity(
  scene: SceneComplexityInput,
  minSteps = 4,
  maxSteps = 10,
): { steps: number; score: number; reason: string } {
  const lo = Math.max(1, Math.round(minSteps));
  const hi = Math.max(lo, Math.round(maxSteps));

  // Discrete tiers, not a continuous ramp: a sampler schedule is not a dial you
  // nudge by one, and tiers keep the choice legible in a run log.
  const tiers: number[] = [];
  for (let v = lo; v <= hi; v += 2) tiers.push(v);
  if (tiers[tiers.length - 1] !== hi) tiers.push(hi);

  const shots = Array.isArray(scene.shots) ? scene.shots : [];
  const refs = Array.isArray(scene.references) ? scene.references : [];
  const duration = typeof scene.duration === 'number' ? scene.duration : 0;
  const dialogueLines = shots.reduce((n, s) => {
    const d = (s as { dialogue?: unknown })?.dialogue;
    return n + (Array.isArray(d) ? d.length : 0);
  }, 0);

  const cutScore = Math.min(3, Math.max(0, shots.length - 1));
  const refScore = refs.length >= 7 ? 3 : refs.length >= 5 ? 2 : refs.length >= 4 ? 1 : 0;
  const dialogueScore = Math.min(3, dialogueLines);
  const lengthScore = duration > 12 ? 3 : duration > 10 ? 2 : duration > 8 ? 1 : 0;
  const score = cutScore + refScore + dialogueScore + lengthScore;

  const band = 13 / tiers.length;
  const derivedIndex = Math.min(tiers.length - 1, Math.floor(Math.min(score, 12) / band));

  // The AUTHORING MODEL'S judgement wins when it supplied one. It wrote the shot
  // list, so it knows things the counters above cannot see: how many figures are
  // moving, whether there is fire and smoke, how fast the motion is, how much
  // fine texture has to survive being moved. Counting cuts and references is a
  // proxy for scene SIZE; what costs sampling steps is scene DIFFICULTY, and a
  // single-cut shot of a horde overrunning a line scores identically to a single
  // -cut shot of a woman at an anvil under the counters alone.
  const authored = typeof scene.renderComplexity === 'string'
    ? scene.renderComplexity.trim().toLowerCase()
    : undefined;
  const authoredIndex = authored ? RENDER_COMPLEXITY_LEVELS.indexOf(authored as RenderComplexity) : -1;

  const useAuthored = authoredIndex >= 0;
  const index = useAuthored
    ? Math.min(tiers.length - 1, Math.round((authoredIndex / (RENDER_COMPLEXITY_LEVELS.length - 1)) * (tiers.length - 1)))
    : derivedIndex;
  const steps = tiers[index]!;

  const counters = `${shots.length} cut(s), ${refs.length} ref(s), ${dialogueLines} line(s), ${duration}s → score ${score}/12`;
  // Surface BOTH when they disagree, so a model that marks everything "extreme"
  // to be safe — or misses a genuinely hard scene — is visible in the run log
  // rather than silently doubling or halving GPU time.
  const disagree = useAuthored && tiers[derivedIndex] !== steps;
  const reason = useAuthored
    ? `authored "${authored}" → ${steps} of [${tiers.join(', ')}]${disagree ? ` (counters suggested ${tiers[derivedIndex]}: ${counters})` : ''}`
    : `${counters} → ${steps} of [${tiers.join(', ')}]`;
  return { steps, score, reason };
}
