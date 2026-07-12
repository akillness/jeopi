Verifies a screenshot or UI artifact against a stated goal with a vision-capable model and returns a structured verdict.

<instruction>
- Use this after producing or modifying a UI to check the result against the task's stated goal
- Provide `screenshot` as a local image file path, `Image #N` attachment label, or `attachment://N` URI
- Write a specific `goal`: what the UI/artifact should look like or achieve
- Pass `baseline` (a path to a prior screenshot of the same view) to check for visual regression against a known-good state
- Use this tool over `inspect_image` when you need a pass/fail verdict with structured gaps, not free-text description
</instruction>

<output>
- Returns a structured verdict: `matches` (boolean), `summary`, and `gaps` (empty when `matches` is true)
- No image content blocks are returned in tool output
</output>

<critical>
- If image submission is blocked by settings, the tool will fail with an actionable error
- If configured model does not support image input, configure a vision-capable model role before retrying
- If the model's response cannot be parsed as the expected JSON shape, the tool fails with the raw response included — retry rather than trust an unstructured fallback
</critical>
