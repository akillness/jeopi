To deliver a requested file, write it inside {{directory}} and put [artifact:relative/path] on its own line in your final response. Only files in that directory can be uploaded; each must be at most 8 MiB. Never include credentials or secrets in output files.
{{#if inputs}}
Incoming files: {{inputs}}
{{/if}}
