# Changelog

## [Unreleased]

### Added

- Opt-in per-agent worktree isolation (`isolation: true` in the swarm YAML): each agent runs in its own git worktree, merging back after completion. Non-git workspaces fail the agent's iteration cleanly instead of silently falling back to shared-workspace execution.
- `--resume` CLI flag: reconstructs pipeline state from the persisted `pipeline.json` and continues from the last recorded iteration instead of restarting at 0, for a not-yet-completed prior run.

## [16.2.21] - 2026-07-02

### Fixed

- Fixed npm releases skipping `jeopi-swarm-extension`: the publish package list now includes the extension, and the release sync helper ignores private workspaces so only public package versions participate in lockstep publish checks.

## [15.9.0] - 2026-06-04

### Fixed

- Fixed swarm `/swarm run` failing with authStorage/modelRegistry identity error ([#1472](https://github.com/can1357/oh-my-pi/issues/1472))
