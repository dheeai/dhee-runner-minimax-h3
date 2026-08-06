export interface AuthoredDialogueInput {
  prose: string;
  spokenLines: unknown;
  language: unknown;
  subjectNumber?: number;
  speakerNumber?: number;
}

export interface AuthoredDialogueResult {
  prose: string;
  injected: boolean;
  canonicalLine?: string;
}

/**
 * Bridge an authored structured-dialogue field into the prose H3 actually sees.
 *
 * JSON-schema authoring can require both `spokenLines` and
 * `detailedDescription`, but it cannot require the model to copy one field into
 * the other. The renderer consumes prose, so an explicitly configured spoken
 * line is inserted mechanically when the model omitted every `<d>` tag. This is
 * deliberately opt-in at the runner config boundary; legacy bundles that do not
 * name a spoken-lines field are unchanged.
 */
export function injectAuthoredDialogue(input: AuthoredDialogueInput): AuthoredDialogueResult {
  const prose = String(input.prose ?? '').trim();
  if (/<d>\[[^\]]+\][\s\S]*?<\/d>/.test(prose)) {
    return { prose, injected: false };
  }

  const lines = Array.isArray(input.spokenLines)
    ? input.spokenLines.filter((line): line is string => (
        typeof line === 'string' && line.trim().length > 0
      ))
    : [];
  if (lines.length !== 1) {
    throw new Error(`expected exactly one non-empty authored spoken line, got ${lines.length}`);
  }

  const language = typeof input.language === 'string' ? input.language.trim() : '';
  if (!language) throw new Error('authored spoken line requires a non-empty language');

  const subjectNumber = Math.max(1, Math.round(input.subjectNumber ?? 1));
  const speakerNumber = Math.max(1, Math.round(input.speakerNumber ?? 1));
  const canonicalLine = `<Subject ${subjectNumber}> (S${speakerNumber}) says: <d>[${language}] ${lines[0]!.trim()}</d>`;

  const shotOne = /\[Shot 1\]/;
  const injectedProse = shotOne.test(prose)
    ? prose.replace(shotOne, (marker) => `${marker} ${canonicalLine}`)
    : `${canonicalLine}\n\n${prose}`.trim();

  return { prose: injectedProse, injected: true, canonicalLine };
}
