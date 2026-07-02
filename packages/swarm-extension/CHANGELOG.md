# Changelog

## [Unreleased]

### Fixed

- Fixed npm releases skipping `jeopi-swarm-extension`: the publish package list now includes the extension, and the release sync helper ignores private workspaces so only public package versions participate in lockstep publish checks.

## [15.9.0] - 2026-06-04

### Fixed

- Fixed swarm `/swarm run` failing with authStorage/modelRegistry identity error ([#1472](https://github.com/can1357/oh-my-pi/issues/1472))
