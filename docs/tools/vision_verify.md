# vision_verify

> Check a screenshot/artifact against a stated goal with a vision-capable model and return a structured `{matches, summary, gaps}` verdict.

## Source
- Entry: `packages/coding-agent/src/tools/vision-verify.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/vision-verify.md`
- System prompt: `packages/coding-agent/src/prompts/tools/vision-verify-system.md`
- Key collaborators:
  - `packages/coding-agent/src/utils/image-loading.ts` — path resolution, type detection, size gate, optional resize.
  - `packages/coding-agent/src/utils/image-resize.ts` — downscale and recompress oversized images.
  - `packages/coding-agent/src/config/model-resolver.ts` — `getModelMatchPreferences`, `expandRoleAlias`, `resolveModelFromString`.
  - `packages/coding-agent/src/commit/utils.ts` — `extractTextContent`.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `goal` | `string` | Yes | What the UI/artifact should look like or achieve. |
| `screenshot` | `string` | Yes | Path to the current screenshot, an `Image #N` attachment label, or an `attachment://N` URI. |
| `baseline` | `string` | No | Path to a prior screenshot of the same view, for regression comparison. Accepts the same path/attachment forms as `screenshot`. |

## Outputs
The tool returns a single `AgentToolResult`:

- `content`: one text block, `[{ type: "text", text }]`, where `text` is a rendered verdict summary (`Matches: yes|no`, the model's `summary`, and a `Gaps:` bullet list when non-empty).
- `details`:
  - `model`: `<provider>/<id>` of the selected model.
  - `matches`: boolean verdict from the model.
  - `gaps`: array of specific observed differences from the goal (or from `baseline` when provided); empty when `matches` is true.

Model-visible output is single-shot, not streamed by this tool.

## Flow
1. `VisionVerifyTool.execute(...)` rejects immediately if `images.blockImages` is enabled in session settings.
2. It reads `session.modelRegistry`; missing registry, empty registry, missing API key, or unresolved model each raise `ToolError`.
3. Model selection tries, in order, `pi/vision`, `pi/default`, the active model string from the session, then `availableModels[0]`, exactly mirroring `inspect_image`'s resolution chain.
4. The chosen model must advertise `input.includes("image")`; otherwise execution fails before loading any file.
5. `screenshot` (and `baseline`, if given) are each resolved by `resolveVisionVerifyImageInput(...)`: an `Image #N` / `attachment://N` reference resolves against `session.getImageAttachments()`, otherwise the path is loaded via `loadImageInput(...)`.
6. If `baseline` is present, the user message content is `[{text: "Baseline (prior):"}, {image: baseline}, {text: "Current:"}, {image: current}, {text: "Goal: <goal>"}]`; otherwise it is `[{image: current}, {text: "Goal: <goal>"}]`.
7. `systemPrompt` is rendered from `packages/coding-agent/src/prompts/tools/vision-verify-system.md`, instructing the model to answer with only a JSON object `{matches, summary, gaps}`; telemetry is tagged with oneshot kind `vision_verify`.
8. If the model response stop reason is `error` or `aborted`, the tool maps that to `ToolError`.
9. `extractTextContent(...)` concatenates the assistant's text blocks; the tool fails if nothing remains.
10. The text is parsed as JSON (tolerating a JSON object embedded in surrounding text) and validated to match `{matches: boolean, summary: string, gaps: string[]}`. On parse failure or shape mismatch, the tool throws `ToolError` with the raw model text included in both the message and `context.rawResponse` — there is no silent unstructured fallback.
11. Success returns the rendered summary text plus `details`.

## Modes / Variants
- **Single-screenshot verification**: only `screenshot` is given; the model judges it against `goal` alone.
- **Baseline regression comparison**: `baseline` is given; both images are sent, baseline first, and the system prompt instructs the model to treat unintended divergence from baseline as a gap.
- **Attachment-reference input**: `screenshot`/`baseline` is an `Image #N` label or `attachment://N` URI instead of a filesystem path.
- **Unsupported/oversize image path**: same failure modes as `inspect_image` (`ImageInputTooLargeError` remapped to `ToolError`; unsupported file content raises `ToolError` before any model call).

## Side Effects
- Filesystem
  - Resolves and reads the target screenshot(s) from disk (unless resolved from an in-memory chat attachment).
- Network
  - Sends the final base64 image payload(s) plus goal text to the selected model through `instrumentedCompleteSimple(...)`.
- Session state
  - Reads session settings, active model preferences, cwd, model registry, and image attachments.
- Background work / cancellation
  - Passes the caller `AbortSignal` into `instrumentedCompleteSimple(...)`.

## Limits & Caps
- Supported detected input formats: `image/png`, `image/jpeg`, `image/gif`, `image/webp`, same as `inspect_image` / `loadImageInput(...)`.
- Upload input cap per image: `MAX_IMAGE_INPUT_BYTES = 20 * 1024 * 1024` bytes (20 MiB).
- Availability is gated by `vision_verify.enabled`, default `false`, in `packages/coding-agent/src/config/settings-schema.ts` / `packages/coding-agent/src/tools/index.ts` — identical gating shape to `inspect_image.enabled`.
- Auto-resize honors `images.autoResize`; WebP exclusion honors `webpExclusionForModel(model)`, same as `inspect_image`.

## Errors
- Settings gate:
  - `Image submission is disabled by settings (images.blockImages=true). Disable it to use vision_verify.`
- Model resolution / capability:
  - `Model registry is unavailable for vision_verify.`
  - `No models available for vision_verify.`
  - `Unable to resolve a model for vision_verify.`
  - `Resolved model <provider>/<id> does not support image input. Configure a vision-capable model for modelRoles.vision.`
  - `No API key available for <provider>/<id>. Configure credentials for this provider or choose another vision-capable model.`
- Input file:
  - `Image file too large: <size> exceeds <limit> limit.` from `ImageInputTooLargeError`, remapped to `ToolError`.
  - `vision_verify only supports PNG, JPEG, GIF, and WEBP files detected by file content (<label>="<path>").` when header sniffing fails, where `<label>` is `screenshot` or `baseline`.
  - Attachment resolution failures mirror `inspect_image`'s (`No image attachments are available…` / `Could not resolve image attachment…`).
- Model call:
  - `vision_verify request failed.` if the response stop reason is `error` without a provider message.
  - Provider `errorMessage` is passed through when present.
  - `vision_verify request aborted.` on aborted responses.
  - `vision_verify model returned no text output.` when the assistant message contains no text blocks after filtering.
- Structured-output parsing:
  - `vision_verify model response was not valid JSON. Raw response: <text>` when the response cannot be parsed as JSON.
  - `vision_verify model response did not match the expected {matches, summary, gaps} shape. Raw response: <text>` when parsed JSON is missing or mistypes a required field.

Failures surface as thrown `ToolError`s from `execute(...)`; the normal success return shape is not used for error reporting.

## Notes
- The tool schema is not marked strict (`strict = false`), matching `inspect_image`'s convention, but the arktype schema rejects unknown top-level keys via `"+": "reject"`.
- Unlike `inspect_image`, this tool never returns free text as its primary payload — the rendered `content` text is a deterministic re-rendering of the parsed `{matches, summary, gaps}` verdict, and a malformed model response is a hard failure rather than a fallback to raw text.
- No dedicated TUI renderer is registered for this tool; it renders via the generic tool-execution content/details display.
