<system-notice type="interrupted-thinking">
{{#if reasoning}}
Your previous turn was cut off before you finished. Below is your unfinished internal work state — use it silently to resume; do not quote, repeat, or restate it back.
- Continue the user's task from the relevant unfinished point.
------
{{reasoning}}
{{else}}
Your previous turn was interrupted. Continue the user's task using the visible conversation and tool results.
{{/if}}
</system-notice>
