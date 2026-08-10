/**
 * Five scenes_plan sections chosen to exercise the parts of
 * illustrated_story_h3's scene_video_prompt contract that can actually break:
 * native-script dialogue, a genuinely silent beat, reference crowding,
 * a single continuous take with voiceover, and a max-length dense multi-cut
 * with one line crossing a cut.
 *
 * Each scenario carries the FULL context the bundle declares as inputs
 * (scenes_plan / story_bible / character_state / character_acting_profile /
 * art_style / narration) so the harness can run both arms: the prompt exactly
 * as the bundle renders it today, and the prompt with that context appended.
 */

const ART_STYLE = `# Art style — "Unseeing Role"

Hand-painted gouache illustration with visible brush texture, muted
desaturated palette (dusty ochre, slate blue, faded terracotta), soft diffuse
light with no hard specular highlights. Cinematic 2.39:1 framing sensibility.
Skin rendered in warm mid-tones with cool shadow. No line art, no cel shading,
no digital gloss. Grain of hand-made paper visible in flat areas.`;

const BIBLE = {
  title: 'Unseeing Role',
  logline:
    'A veteran stage actress losing her sight rehearses the last role she will ever play, opposite the understudy who will replace her.',
  characters: [
    {
      id: 'meher',
      name: 'Meher Bharucha',
      description:
        'Actress, 61, tall and straight-backed, silver hair pinned severely, deep-set eyes that no longer focus, a dark green shawl she keeps re-settling on her shoulders.',
    },
    {
      id: 'lira',
      name: 'Lira Sen',
      description:
        'Understudy, 26, small and wiry, black hair cropped short, in a paint-stained grey rehearsal sweater, always holding a dog-eared script.',
    },
    {
      id: 'dhruv',
      name: 'Dhruv Kale',
      description:
        'Stage manager, 40s, heavy-set, headset around his neck, clipboard, permanently rolled shirtsleeves.',
    },
  ],
  objects: [
    {
      id: 'script_bundle',
      name: 'The annotated script',
      description:
        'A thick playscript, spine broken, margins dense with pencil, corners furred from handling.',
    },
    {
      id: 'brass_bell',
      name: "The prompter's bell",
      description:
        'A small tarnished brass handbell on a wooden base, kept at the downstage-left prompt desk.',
    },
  ],
  locations: [
    {
      id: 'rehearsal_stage',
      name: 'The bare rehearsal stage',
      description:
        'An empty proscenium stage, black-painted floor scuffed pale along the blocking lines, one bare work light on a stand, taped marks in faded yellow, the auditorium beyond it a flat void.',
    },
    {
      id: 'green_room',
      name: 'The green room',
      description:
        'A narrow windowless room, mirror wall with half the bulbs dead, two mismatched armchairs, a kettle, coats on hooks.',
    },
  ],
};

const ACTING_PROFILES = {
  meher: {
    characterId: 'meher',
    voicePrompt:
      'A 61-year-old woman with a trained stage contralto, low and resonant, precise consonants, unhurried phrasing with deliberate pauses mid-sentence, a faint Bombay-Parsi cadence, and a slight dry rasp on sustained vowels.',
    spine: 'To be seen as an artist rather than as a patient.',
    physicalSignature:
      'Weight settled back on the heels, chin level, hands finding surfaces before she trusts them, re-settling the shawl whenever she is thrown.',
    eyeLife:
      'Eyes travel toward sound rather than to a face; long slow blinks; no micro-saccades of visual search, so her gaze arrives half a beat late and slightly off-target.',
  },
  lira: {
    characterId: 'lira',
    voicePrompt:
      'A 26-year-old woman with a light, quick mid-range voice, breathy on onsets, a habit of ending statements slightly upward, clipped urban Indian English with fast unstressed syllables.',
    spine: 'To earn the part without being the one who takes it.',
    physicalSignature:
      'Forward on the balls of her feet, script held two-handed as a shield, rocks heel-to-toe when waiting, drops her shoulders the instant she is looked at.',
    eyeLife:
      'Rapid target changes, checks Meher then the floor then the script; blinks tight and often; eyes lead every thought before she speaks.',
  },
  dhruv: {
    characterId: 'dhruv',
    voicePrompt:
      'A man in his mid-40s with a heavy, flat baritone, low volume, entirely unhurried, minimal pitch movement, the voice of somebody who repeats instructions all day.',
    spine: 'To get the room to the end of the schedule.',
    physicalSignature:
      'Stands square with the clipboard against his sternum, moves only when he must, one hand permanently near the headset.',
    eyeLife:
      'Watches the clipboard, then the room, in that order; slow deliberate blinks; rarely holds a face for more than a beat.',
  },
};

const CHARACTER_STATE = {
  states: [
    {
      id: 'meher_shawl_slipped',
      characterId: 'meher',
      description:
        'The dark green shawl has slid off her left shoulder and she has not noticed; her hair has come loose at the temple.',
    },
    {
      id: 'lira_stage_blacks',
      characterId: 'lira',
      description:
        'Lira has changed out of the grey sweater into plain black stage blacks, sleeves pushed to the elbow.',
    },
  ],
};

const NARRATION =
  'The company had three days left. Nobody said the word "replacement", so it sat in the room like furniture.';

/**
 * One scenario = one section of a scenes_plan, plus the section-specific
 * entity allowlist the runner will enforce via expectedReferenceIds.
 */
export const SCENARIOS = [
  {
    id: 'scene_04_sec_1',
    label: 'A · two-hander, Hindi native script, multi-cut',
    why: 'Native-script dialogue for two voices across cuts; the case auditDialogueScript exists for.',
    expectedIds: ['meher', 'lira', 'script_bundle', 'rehearsal_stage'],
    section: {
      id: 'scene_04_sec_1',
      sceneId: 'scene_04',
      purpose:
        'Meher asks Lira to read the line she can no longer find on the page, and hears her own reading come back better.',
      budgetSec: 8.0,
      locationId: 'rehearsal_stage',
      entities: ['meher', 'lira', 'script_bundle', 'rehearsal_stage'],
      spokenLines: [
        'यह पंक्ति कहाँ है? मुझे दिखाई नहीं दे रही।',
        'तीसरे पन्ने पर, नीचे। मैं पढ़ूँ?',
      ],
      shots: [
        {
          id: 'scene_04_sec_1_shot_1',
          durationSec: 4.0,
          summary:
            'Meher at the taped mark, holding the open script at arm\'s length, tilting it toward the work light; she gives up and asks.',
          dialogue: 'यह पंक्ति कहाँ है? मुझे दिखाई नहीं दे रही।',
          speaker: 'meher',
        },
        {
          id: 'scene_04_sec_1_shot_2',
          durationSec: 4.0,
          summary:
            'Cut to Lira downstage, already three steps closer than she was, script open on her forearm, offering to read.',
          dialogue: 'तीसरे पन्ने पर, नीचे। मैं पढ़ूँ?',
          speaker: 'lira',
        },
      ],
    },
  },
  {
    id: 'scene_07_sec_2',
    label: 'B · genuinely silent beat, no dialogue',
    why: 'The speech-verb trap: an empty spokenLines must not produce prose that asserts speech, and voiceProfiles must be [].',
    expectedIds: ['meher', 'brass_bell', 'rehearsal_stage'],
    section: {
      id: 'scene_07_sec_2',
      sceneId: 'scene_07',
      purpose:
        'Alone after the company has gone, Meher finds the prompter\'s bell by touch and does not ring it.',
      budgetSec: 6.0,
      locationId: 'rehearsal_stage',
      entities: ['meher', 'brass_bell', 'rehearsal_stage'],
      spokenLines: [],
      shots: [
        {
          id: 'scene_07_sec_2_shot_1',
          durationSec: 3.5,
          summary:
            'Meher\'s hand travels along the edge of the prompt desk in the dark, finds the bell\'s wooden base, and stops.',
          dialogue: null,
          speaker: null,
        },
        {
          id: 'scene_07_sec_2_shot_2',
          durationSec: 2.5,
          summary:
            'Cut wide: she stands alone in the single work light, hand still on the bell, and lets it go without ringing it.',
          dialogue: null,
          speaker: null,
        },
      ],
    },
  },
  {
    id: 'scene_11_sec_1',
    label: 'C · crowded — 3 characters, 2 objects, location, one state plate',
    why: 'Reference ordering/crowding and per-shot acting for three characters at once.',
    expectedIds: [
      'meher',
      'lira',
      'dhruv',
      'script_bundle',
      'brass_bell',
      'rehearsal_stage',
    ],
    section: {
      id: 'scene_11_sec_1',
      sceneId: 'scene_11',
      purpose:
        'Dhruv calls the cue that hands Meher\'s entrance to Lira, and the room hears it happen.',
      budgetSec: 10.13,
      locationId: 'rehearsal_stage',
      entities: [
        'meher',
        'lira',
        'dhruv',
        'script_bundle',
        'brass_bell',
        'rehearsal_stage',
      ],
      stateIds: ['meher_shawl_slipped'],
      spokenLines: [
        'From the top of the scene. Understudy on.',
        'Not yet. Let me hear it once more.',
      ],
      shots: [
        {
          id: 'scene_11_sec_1_shot_1',
          durationSec: 3.5,
          summary:
            'Dhruv at the prompt desk with the clipboard and the bell, headset half on, calling the restart to the room.',
          dialogue: 'From the top of the scene. Understudy on.',
          speaker: 'dhruv',
        },
        {
          id: 'scene_11_sec_1_shot_2',
          durationSec: 3.5,
          summary:
            'Cut to Lira mid-stage, script coming up, taking half a step onto the mark that is not hers yet.',
          dialogue: null,
          speaker: null,
        },
        {
          id: 'scene_11_sec_1_shot_3',
          durationSec: 3.13,
          summary:
            'Cut to Meher at the edge of the light, shawl off one shoulder, stopping the room without raising her voice.',
          dialogue: 'Not yet. Let me hear it once more.',
          speaker: 'meher',
        },
      ],
    },
  },
  {
    id: 'scene_02_sec_1',
    label: 'D · single continuous take, English voiceover',
    why: 'continuous_moving with exactly one shot, plus a voiceover the guide gives a required exact phrasing for.',
    expectedIds: ['lira', 'script_bundle', 'green_room'],
    section: {
      id: 'scene_02_sec_1',
      sceneId: 'scene_02',
      purpose:
        'Lira, alone in the green room, admits to herself what she is rehearsing for.',
      budgetSec: 7.0,
      locationId: 'green_room',
      entities: ['lira', 'script_bundle', 'green_room'],
      spokenLines: [
        'I learned her part before anyone asked me to.',
      ],
      shots: [
        {
          id: 'scene_02_sec_1_shot_1',
          durationSec: 7.0,
          summary:
            'One unbroken move: Lira sits in the mismatched armchair under the half-dead mirror bulbs, script closed on her knees, and looks at her own reflection while the line plays over the picture in her own voice; her mouth does not move.',
          dialogue: 'I learned her part before anyone asked me to.',
          speaker: 'lira',
          voiceover: true,
        },
      ],
    },
  },
  {
    id: 'scene_19_sec_3',
    label: 'E · 15.08s dense multi-cut, one line crossing a cut',
    why: 'Timecode discipline at the ceiling, four cuts, and a line the plan deliberately runs across a cut boundary.',
    expectedIds: ['meher', 'lira', 'script_bundle', 'rehearsal_stage'],
    section: {
      id: 'scene_19_sec_3',
      sceneId: 'scene_19',
      purpose:
        'Meher gives Lira the shawl and the blocking in one continuous handover that the cuts keep interrupting.',
      budgetSec: 15.08,
      locationId: 'rehearsal_stage',
      entities: ['meher', 'lira', 'script_bundle', 'rehearsal_stage'],
      stateIds: ['lira_stage_blacks'],
      spokenLines: [
        'Take it. It sits better on you than it does on me.',
        'Three steps to the mark, then stop. Do not look for the light. It will find you.',
      ],
      shots: [
        {
          id: 'scene_19_sec_3_shot_1',
          durationSec: 4.0,
          summary:
            'Meher unwinds the dark green shawl from her shoulders and holds it out into empty air, roughly where she believes Lira is standing.',
          dialogue: 'Take it. It sits better on you than it does on me.',
          speaker: 'meher',
        },
        {
          id: 'scene_19_sec_3_shot_2',
          durationSec: 3.5,
          summary:
            'Cut tight to Lira\'s hands in stage blacks taking the shawl, one finger through a moth hole she has not seen before.',
          dialogue: null,
          speaker: null,
        },
        {
          id: 'scene_19_sec_3_shot_3',
          durationSec: 4.5,
          summary:
            'Cut to a two-shot as Meher walks the blocking with her hand on Lira\'s shoulder, speaking the instruction as they move; the line begins here.',
          dialogue:
            'Three steps to the mark, then stop. Do not look for the light. It will find you.',
          speaker: 'meher',
          crossesCut: true,
        },
        {
          id: 'scene_19_sec_3_shot_4',
          durationSec: 3.08,
          summary:
            'Cut to the taped mark on the black floor as two pairs of feet arrive on it, Meher\'s instruction still finishing over the picture.',
          dialogue: null,
          speaker: null,
        },
      ],
    },
  },
];

/** The whole scenes_plan the bundle would hand the node (all five sections). */
export const SCENES_PLAN = {
  sections: SCENARIOS.map((s) => s.section),
};

export const CONTEXT = {
  art_style: ART_STYLE,
  story_bible: BIBLE,
  character_state: CHARACTER_STATE,
  character_acting_profile: Object.values(ACTING_PROFILES),
  narration: NARRATION,
  scenes_plan: SCENES_PLAN,
};
