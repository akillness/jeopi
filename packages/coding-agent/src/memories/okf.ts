/**
 * Open Knowledge Format (OKF v0.1) support for jeopi memory documents.
 *
 * OKF (https://github.com/google/open-knowledge-format — the format jeo-skills'
 * `okf` skill validates and consumes) stores knowledge atoms as
 * YAML-frontmatter Markdown: required `type` / `title` / `description`,
 * optional `resource` / `tags` / `timestamp`. jeopi's local memory backend
 * writes its artifacts (`MEMORY.md`, `memory_summary.md`, `raw_memories.md`,
 * `rollout_summaries/*.md`, `learned.md`) as OKF atoms so any OKF consumer can
 * read a jeopi memory root as a knowledge bundle.
 *
 * Prompt-injection read paths strip the frontmatter via
 * {@link stripOkfFrontmatter} so the model-facing text stays unchanged;
 * legacy files without frontmatter pass through verbatim.
 */
import { YAML } from "bun";

/** OKF v0.1 frontmatter fields. Only `type`/`title`/`description` are required. */
export interface OkfFields {
	type: string;
	title: string;
	description: string;
	resource?: string;
	tags?: readonly string[];
	/** ISO 8601 datetime, e.g. `2026-07-02T10:00:00Z`. */
	timestamp?: string;
	/** Producer-specific extension fields (e.g. `thread_id`). */
	extra?: Record<string, string | number>;
}

const FENCE = "---";

function yamlScalar(value: string | number): string {
	if (typeof value === "number") return String(value);
	return JSON.stringify(value);
}

/** Render an OKF atom: YAML frontmatter followed by the markdown body. */
export function renderOkfDocument(fields: OkfFields, body: string): string {
	const lines: string[] = [FENCE];
	lines.push(`type: ${yamlScalar(fields.type)}`);
	lines.push(`title: ${yamlScalar(fields.title)}`);
	lines.push(`description: ${yamlScalar(fields.description)}`);
	if (fields.resource) lines.push(`resource: ${yamlScalar(fields.resource)}`);
	if (fields.tags?.length) lines.push(`tags: [${fields.tags.join(", ")}]`);
	if (fields.timestamp) lines.push(`timestamp: ${fields.timestamp}`);
	for (const [key, value] of Object.entries(fields.extra ?? {})) {
		lines.push(`${key}: ${yamlScalar(value)}`);
	}
	lines.push(FENCE, "");
	const trimmedBody = body.trim();
	return trimmedBody ? `${lines.join("\n")}\n${trimmedBody}\n` : `${lines.join("\n")}`;
}

/** Locate the closing fence line of a leading frontmatter block, or -1. */
function findFrontmatterEnd(lines: string[]): number {
	if (lines[0]?.trim() !== FENCE) return -1;
	for (let index = 1; index < lines.length; index++) {
		if (lines[index].trim() === FENCE) return index;
	}
	return -1;
}

/** Parsed frontmatter (undefined when absent/unparseable) plus the body. */
export interface OkfDocumentParts {
	frontmatter: Record<string, unknown> | undefined;
	body: string;
}

/**
 * Split an OKF document into frontmatter and body. Tolerant by design: text
 * without a leading fence (legacy jeopi memory files, hand-edited files)
 * returns the whole text as body with `frontmatter: undefined`, and a
 * malformed YAML block still strips so prompt paths never leak fences.
 */
export function parseOkfDocument(text: string): OkfDocumentParts {
	const lines = text.split("\n");
	const end = findFrontmatterEnd(lines);
	if (end === -1) return { frontmatter: undefined, body: text };
	const body = lines.slice(end + 1).join("\n");
	let frontmatter: Record<string, unknown> | undefined;
	try {
		const parsed = YAML.parse(lines.slice(1, end).join("\n"));
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
			frontmatter = parsed as Record<string, unknown>;
		}
	} catch {
		// Malformed YAML — treat as fenceless body strip.
	}
	return { frontmatter, body };
}

/** Body of an OKF document with any leading frontmatter removed. */
export function stripOkfFrontmatter(text: string): string {
	return parseOkfDocument(text).body;
}

/**
 * Validate a document against the OKF v0.1 rules the jeo-skills `okf` linter
 * enforces: a leading `---` fence, a closing fence, and non-empty
 * `type` / `title` / `description` fields. Returns an empty array when valid.
 */
export function validateOkfDocument(text: string): string[] {
	const errors: string[] = [];
	const lines = text.split("\n");
	if (lines[0]?.trim() !== FENCE) {
		return ["missing leading frontmatter fence (---)"];
	}
	const end = findFrontmatterEnd(lines);
	if (end === -1) {
		return ["unclosed frontmatter"];
	}
	const { frontmatter } = parseOkfDocument(text);
	if (!frontmatter) {
		return ["frontmatter is not a YAML mapping"];
	}
	for (const field of ["type", "title", "description"] as const) {
		const value = frontmatter[field];
		if (typeof value !== "string" || value.trim() === "") {
			errors.push(`missing required field '${field}'`);
		}
	}
	return errors;
}

/** Format a unix-seconds timestamp as the ISO 8601 string OKF expects. */
export function okfTimestamp(unixSeconds: number = Math.floor(Date.now() / 1000)): string {
	return new Date(unixSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}
