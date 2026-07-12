Capture a reusable lesson into long-term memory, and optionally mint or enhance a managed skill in the same call.

Use after solving something whose insight will pay off again: a non-obvious fix, a project convention you had to discover, a workflow that worked.

Provide the optional `skill` object when the lesson is a repeatable *procedure* worth codifying as a `SKILL.md` (not just a fact). Managed skills are written to an isolated directory (`~/.jeopi/agent/managed-skills`) and are surfaced like normal skills next session. They NEVER touch user-authored skills. Frontmatter is generated from `name` and `description`.

Capture sparingly and specifically. One strong, reusable lesson beats several vague ones.

Set `verified: true` when you independently re-checked the claim against the repo — you ran a command, read a file, or ran a test that directly confirmed it — and pass a short `evidence` string naming that check (e.g. "ran `bun test src/foo.test.ts`, all 12 pass" or "read `package.json:12`, confirms dependency pin"). Leave `verified` unset (the default) for a hypothesis or pattern you noticed but did not independently confirm.
