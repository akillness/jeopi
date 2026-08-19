#!/usr/bin/env bash
# Shared apt hardening for CI steps that install packages on GitHub-hosted
# Linux runners.
#
# Why this is a library and not copy-pasted into each action: the unbounded
# `apt-get update` pattern existed independently in `setup-system-deps` and in
# `build-native`. Hardening only the first one still lost a release, because
# the second still hung on the same dead mirror. One implementation, two
# callers, no drift.
#
# Source it, then call `apt_harden_sources` once before `apt_try`:
#
#   . "${GITHUB_ACTION_PATH}/../apt-hardening.sh"
#   apt_harden_sources
#   apt_try "apt-get update" apt-get update
#   apt_try "apt-get install" apt-get install -y foo bar
#
# Callers are expected to run under `set -euo pipefail`; both functions are
# written to be safe under `-u` and to return (never `exit`) so the caller
# decides how a permanent failure is reported.

# Point apt away from the regionally flaky Azure mirror that the GitHub Ubuntu
# images pin. Observed failure: every `azure.archive.ubuntu.com` line came back
# `Ign:` and `apt-get update` then burned all three attempts (exit 124 each)
# without finishing, while `archive.ubuntu.com` stayed up.
#
# `grep -E` / `sed -E`, never BRE escapes: BSD tools silently treat `\?` as a
# literal and match nothing, so a BRE pattern here cannot be verified on a
# macOS dev box before it ships.
#
# No-op when the image is not using the Azure mirror.
apt_harden_sources() {
	local sources="/etc/apt/sources.list"
	local sources_dir="/etc/apt/sources.list.d/"

	if ! grep -rqE 'azure\.archive\.ubuntu\.com' "$sources" "$sources_dir" 2>/dev/null; then
		return 0
	fi

	echo "Repointing apt off the Azure mirror onto archive.ubuntu.com"
	sudo find "$sources" "$sources_dir" -type f \
		-exec sed -E -i 's|https?://azure\.archive\.ubuntu\.com/ubuntu|https://archive.ubuntu.com/ubuntu|g' {} +
}

# Run one apt command under a hard timeout, retrying transient failures.
#
# `timeout` is what makes a hung mirror observable at all: apt blocks
# indefinitely on a half-open connection and the step never returns. Without a
# bound, one wedged runner silently takes down a whole release chain (tag
# pushed, nothing shipped) because downstream publish jobs require every test
# job to report `success`.
#
# The failing status must be read inside `else` — after `fi` a failed `if`
# condition leaves `$?` as the compound statement's own 0, which would report
# every exhausted retry as success.
apt_try() {
	local label="$1"
	shift
	local attempt status

	for attempt in 1 2 3; do
		echo "::group::${label} (attempt ${attempt}/3)"
		if sudo timeout --signal=INT --kill-after=30s 5m "$@"; then
			echo "::endgroup::"
			return 0
		else
			status=$?
		fi
		echo "::endgroup::"
		echo "::warning::${label} failed (exit ${status}) on attempt ${attempt}/3"
		if [ "${attempt}" -eq 3 ]; then
			return "${status}"
		fi
		sleep $((attempt * 15))
	done
}
