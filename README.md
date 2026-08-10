# dhee-runner-minimax-h3

`comfy.minimax_h3_r2v` — MiniMax **H3** (Hailuo 03) reference-to-video, run
locally through ComfyUI's `MiniMaxH3ReferenceToVideo` node.

One call renders **one clip of up to ~15 seconds at 24fps with native stereo
audio — containing several CUTS**. That last part is the reason this runner
exists alongside `comfy.ltx_msr`: MSR renders one continuous take per call and
the film is assembled by concatenating them, so every cut in the finished film
is a seam between two independent generations. H3 renders a whole *scene* —
its coverage, its whip pans, its hard cuts on impact, its ambient bed and
foley and dialogue — in a single pass, internally consistent by construction.

## What the model wants, and where this runner enforces it

These come from MiniMax/fal/Comfy's own H3 guidance. The runner implements the
mechanical half so a bundle only has to write prose.

| H3 rule | Where it lives |
|---|---|
| **Every reference gets an explicit job.** "Use Image 1 for the talent; Image 2 for the bag" measurably beats handing it images and a description. | `buildBindingClause()` — the runner composes the `<Picture N> — <appearsAs>. Use it for <job>.` block itself and prepends it. It *must* be built here: the authoring model cannot know the final slot order, because state substitution, background-last routing and the ref cap all run after the prompt is written. |
| **Timecoded shot list** for anything longer than one beat. | The bundle's prompt template. The runner just guarantees the clip is long enough to hold it. |
| **Audio is directed, not inherited.** | The bundle's prompt template; the graph decodes an audio latent natively. |
| **Negatives go in the prompt prose.** | Structural: the H3 ref2va graph is guidance-distilled (`BasicGuider`, no CFG), so there is **no negative conditioning input at all**. A bundle that tries to wire one is wiring nothing. |
| **5–15s, on the 17k+5 frame grid.** | `snapH3Frames()`. Confirmed against the node's own schema: `length` is `min 5, max 3600, step 17`, tooltip *"124 = ~5s, trained range is ~124-362"*. |
| **Up to 9 reference images.** | `routeRefs()`, cap `H3_MAX_REFS = 9` (MSR's is 5). |
| **Native geometry 768 short edge, capped 768×1344.** | Defaults `width: 1344, height: 768`, snapped to /32 — matching the node's own defaults. |
| **Founder-tested fast compute recipe.** | The canonical graph uses the pruned INT8 model, `PathchSageAttentionKJ`, `MiniMaxH3Cache`, `res_multistep` and `simple`. The runner defaults to `scheduler: simple` and preserves older EasyCache workflows. |
| **~7,000-character prompt window.** | `composePrompt()` trims the *prose* tail if needed and never the binding clause. |

The runner assigns the finished prompt directly to
`MiniMaxH3ReferenceToVideo.inputs.prompt` after loading the graph. This is
deliberate: an exported workflow containing literal example copy cannot bypass
dynamic prompt injection merely because it omitted the `__POS__` placeholder.

## The one structural assumption, and its proof

The H3 node's reference group is a `COMFY_AUTOGROW_V3` input
(`prefix: "ref_image_"`, `min: 0, max: 9`). In API format that is expressed as
**dotted keys** on the node — `ref_images.ref_image_0`, `…_1`, … — each
pointing at a `LoadImage`. The runner discards whatever the bundle's graph
shipped and rebuilds exactly as many as the item resolved.

Verified against a live box in
`dhee-cofounder/artifacts/h3-r2v-probe` (see its `out/preflight.json` for the
node schema as the box actually reports it).

## Config

Required: `outputPath`, `workflowPath`. Everything else has a working default.

```jsonc
{
  "tool": "comfy.minimax_h3_r2v",
  "config": {
    "outputPath": "assets/videos/scenes/{{item_id}}.mp4",
    "workflowPath": "workflows/minimax_h3_r2v.json",
    "endpoint": "self.local",

    "promptInput": "scene_video_prompt",   // JSON doc or text
    "promptField": "videoPrompt",
    "spokenLinesField": "spokenLines",
    "dialogueLanguageInput": "language",
    "durationField": "duration",           // seconds, authored by the prompt stage
    "bindingClause": true,                 // prepend the <Picture N> job clause

    "referenceInputs": {                   // references[].type -> scope:'all' collection
      "character": "character_anchor_image",
      "object":    "object_anchor_image",
      "location":  "location_anchor_image"
    },
    "statePlanInput":   "character_states_plan",
    "stateImagesInput": "character_state_image",
    "voiceProfileInput": "character_acting_profile", // scope:'all'; overwrites a mismatched dialogue voicePrompt with the profile's, logs the mismatch (#10)
    "bgTypes": ["location"],               // moved LAST
    "maxRefs": 9,

    "shotPlanInput": "scenes_plan",        // section item -> SUM of its shots' durations
    "seconds": 12, "minSeconds": 5, "maxSeconds": 15, "fps": 24,

    "width": 1344, "height": 768, "refImageSize": "match",
    "steps": 20, "samplerName": "res_multistep", "scheduler": "simple", "seed": 42,
    "cache": true,
    "cacheThreshold": 0.03, "cacheStart": 0.15,
    "cacheEnd": 0.9, "cacheMaxSteps": 1,
    "padStart": 0, "padEnd": 0, "timeoutMinutes": 45
  }
}
```

When `spokenLinesField` is configured, the named prompt-document field must
contain exactly one non-empty line. If the authored prose omitted every `<d>`
block, the runner inserts that line as the canonical
`<Subject 1> (S1) says: <d>[Language] exact words</d>` clause before prompt
auditing and before the Comfy workflow is built. `dialogueLanguageInput` names
the project input supplying `Language`; `dialogueLanguage` is a literal fallback.
This closes the JSON-schema gap where an author can emit the exact line in one
field yet fail to duplicate it into the prose the renderer consumes.

### Cache compatibility

The canonical graph contains `MiniMaxH3Cache`. Its node schema intentionally
spells the threshold input `resuse_threshold`; the runner preserves that exact
spelling. `cacheThreshold`, `cacheStart`, `cacheEnd` and `cacheMaxSteps` override
`resuse_threshold`, `start_percent`, `end_percent` and `max_steps` respectively.
Set `cache: false` to remove the cache and rewire each downstream model consumer
to the cache's upstream model. The upstream `PathchSageAttentionKJ` node is left
unchanged.

Older graphs containing `EasyCache` remain supported. The legacy
`easyCache`, `easyCacheThreshold`, `easyCacheStart`, `easyCacheEnd` and
`easyCacheMaxSteps` config keys remain aliases for the neutral `cache*` controls.

### Duration precedence

1. the prompt document's own `duration` — the scene prompt wrote the timecoded
   shot list, so it owns its length;
2. the shot plan — this item's own `duration`, or, when the item is a
   **section** (`scene_3`), the **sum** of `scene_3_shot_*` durations, which is
   exactly the screen time the planner budgeted for that beat;
3. `cfg.seconds`.

Then clamped to 5–15s (logged when it clamps) and snapped to the frame grid.

### Item granularity

The runner does not care whether the collection iterates shots or sections.
`shotsForItem()` resolves an exact shot id, else every `<itemId>_shot_*` row,
else every row whose `scene` matches `scene_<N>`. A section item merges its
shots' character states in order, **last wins** — one render can only hold one
plate per character, so a mid-scene appearance change is carried by the prose
and the plate shows the state the scene ends in.

### The `<Picture N>` clause vs. the prose

The authored prose must contain **no slot numbers at all** — no "Image 1", no
"Picture 2". Two competing numbering schemes in one prompt is the fastest way
to break identity. The prose re-describes subjects by appearance; the runner
supplies the numbers.

## Reference plate ordering

Subjects keep their authored most-important-first order; anything whose type is
in `bgTypes` moves last. H3 has no documented ordering requirement — the
background goes last so the binding clause reads as a coherent brief, and so a
bundle can swap between this runner and `comfy.ltx_msr` without re-authoring
its `references[]`. A subject-less all-location scene promotes its leading
plates into subject slots rather than collapsing into one background.

## Not yet wired

The node also accepts `ref_videos` (≤3, 2–15s each, for motion/camera/
performance transfer), `ref_video_audios` and `ref_audios` (≤3, for voice
cloning) as autogrow groups, cited in the prompt as `<Video N>` / `<Audio N>`.
This runner only wires `ref_images`. Adding the others is the same dotted-key
mechanism.

## Tests

`npm test` runs pure-logic tests (no GPU, no Comfy): frame-grid snapping,
reference routing/capping/promotion, binding-clause composition, prompt
trimming, section-vs-shot resolution and the duration clamp.

End-to-end validation lives in `dhee-cofounder/artifacts/h3-r2v-probe`.
