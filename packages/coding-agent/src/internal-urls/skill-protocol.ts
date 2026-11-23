/**
 * Protocol handler for skill:// URLs.
 *
 * Resolves skill names to their SKILL.md files or relative paths within skill directories.
 *
 * URL forms:
 * - skill:// - Lists all installed non-hidden skills
 * - skill://?q=<keywords>&limit=<n> - Searches installed skills by name and description
 * - skill://<name> - Reads SKILL.md
 * - skill://<name>/<path> - Reads relative path within skill's baseDir
 */
import type * as fsTypes from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "jeopi-utils";
import { compareSkillOrder } from "../discovery/helpers";
import { getActiveSkills, type Skill } from "../extensibility/skills";
import { buildDirectoryResource } from "./filesystem-resource";
import type { InternalResource, InternalUrl, ProtocolHandler, ResolveContext, UrlCompletion } from "./types";

const DEFAULT_SEARCH_LIMIT = 50;
const LISTING_DESCRIPTION_MAX_CHARS = 120;
const UNKNOWN_SKILL_LIST_THRESHOLD = 50;
const UNKNOWN_SKILL_PREVIEW_COUNT = 30;

function formatSkillDescription(text: string, maxChars = 0): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (maxChars <= 0 || normalized.length <= maxChars) return normalized;
	if (maxChars === 1) return "…";
	return `${normalized.slice(0, maxChars - 1).trimEnd()}…`;
}

function scoreSkillMatch(skill: Skill, queryLower: string, tokens: readonly string[]): number {
	const nameLower = skill.name.toLowerCase();
	if (skill.hide === true && nameLower !== queryLower) {
		return 0;
	}

	const descLower = formatSkillDescription(skill.description ?? "").toLowerCase();
	let score = 0;

	if (nameLower === queryLower) {
		score += 100;
	} else if (nameLower.startsWith(queryLower)) {
		score += 50;
	} else if (nameLower.includes(queryLower)) {
		score += 25;
	}

	if (descLower.includes(queryLower)) {
		score += 10;
	}

	let matchedTokens = 0;
	for (const token of tokens) {
		let tokenMatched = false;
		if (nameLower === token) {
			score += 30;
			tokenMatched = true;
		} else if (nameLower.startsWith(token) || nameLower.includes(`-${token}`) || nameLower.includes(`_${token}`)) {
			score += 18;
			tokenMatched = true;
		} else if (nameLower.includes(token)) {
			score += 12;
			tokenMatched = true;
		}

		if (descLower.includes(token)) {
			score += 4;
			tokenMatched = true;
		}

		if (tokenMatched) {
			matchedTokens += 1;
		}
	}

	if (tokens.length > 1 && matchedTokens === tokens.length) {
		score += 20;
	}

	return score;
}

function resolveSkillIndex(url: InternalUrl, skills: readonly Skill[]): InternalResource {
	const query = url.searchParams?.get("q")?.trim() ?? "";
	const rawLimit = url.searchParams?.get("limit")?.trim();
	const parsedLimit = rawLimit ? Number.parseInt(rawLimit, 10) : Number.NaN;
	const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : undefined;

	if (query.length > 0) {
		const searchLimit = limit ?? DEFAULT_SEARCH_LIMIT;
		const queryLower = query.toLowerCase();
		const tokens = queryLower.split(/\s+/).filter(Boolean);
		const matches: Array<{ skill: Skill; score: number }> = [];

		for (const skill of skills) {
			const score = scoreSkillMatch(skill, queryLower, tokens);
			if (score > 0) {
				matches.push({ skill, score });
			}
		}

		matches.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score;
			return compareSkillOrder(a.skill.name, a.skill.filePath ?? "", b.skill.name, b.skill.filePath ?? "");
		});

		let content: string;
		if (matches.length === 0) {
			content = `# Skills matching "${query}" (0 matches)\n\nNo skills matched "${query}". Read \`skill://\` to list all installed skills.\n`;
		} else {
			const shown = matches.slice(0, searchLimit);
			const countLabel =
				shown.length === matches.length
					? `${matches.length} ${matches.length === 1 ? "match" : "matches"}`
					: `showing ${shown.length} of ${matches.length} matches`;
			const lines = shown.map(({ skill }) => {
				const desc = formatSkillDescription(skill.description ?? "");
				return desc ? `- ${skill.name}: ${desc}` : `- ${skill.name}`;
			});
			content = `# Skills matching "${query}" (${countLabel})\n\n${lines.join("\n")}\n\nRead \`skill://<name>\` to load a skill.\n`;
		}

		return {
			url: url.href,
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
			notes: [],
		};
	}

	const visible = skills
		.filter(skill => skill.hide !== true)
		.sort((a, b) => compareSkillOrder(a.name, a.filePath ?? "", b.name, b.filePath ?? ""));
	const shown = limit !== undefined ? visible.slice(0, limit) : visible;
	const header =
		shown.length === visible.length
			? `# Installed Skills (${visible.length})`
			: `# Installed Skills (showing ${shown.length} of ${visible.length})`;
	const lines = shown.map(skill => {
		const desc = formatSkillDescription(skill.description ?? "", LISTING_DESCRIPTION_MAX_CHARS);
		return desc ? `- ${skill.name}: ${desc}` : `- ${skill.name}`;
	});
	const body = lines.length > 0 ? `${lines.join("\n")}\n` : "_No skills installed._\n";
	const content = `${header}\n\nUse \`skill://?q=<keywords>\` to search or \`skill://<name>\` to read a skill.\n\n${body}`;

	return {
		url: url.href,
		content,
		contentType: "text/markdown",
		size: Buffer.byteLength(content, "utf-8"),
		notes: [],
	};
}

function getContentType(filePath: string): InternalResource["contentType"] {
	const ext = path.extname(filePath).toLowerCase();
	if (ext === ".md") return "text/markdown";
	return "text/plain";
}

/**
 * Validate that a path is safe (no traversal, no absolute paths).
 */
export function validateRelativePath(relativePath: string): void {
	if (path.isAbsolute(relativePath)) {
		throw new Error("Absolute paths are not allowed in skill:// URLs");
	}

	const normalized = path.normalize(relativePath);
	if (normalized.startsWith("..") || normalized.includes("/../") || normalized.includes("/..")) {
		throw new Error("Path traversal (..) is not allowed in skill:// URLs");
	}
}

/**
 * Handler for skill:// URLs.
 */
export class SkillProtocolHandler implements ProtocolHandler {
	readonly scheme = "skill";
	readonly immutable = true;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const skills = context?.skills ?? getActiveSkills();

		const skillName = url.rawHost || url.hostname;
		if (!skillName) {
			return resolveSkillIndex(url, skills);
		}

		const skill = skills.find(s => s.name === skillName);
		if (!skill) {
			const available = skills.map(s => s.name);
			const availableStr =
				available.length === 0
					? "none"
					: available.length > UNKNOWN_SKILL_LIST_THRESHOLD
						? `${available.slice(0, UNKNOWN_SKILL_PREVIEW_COUNT).join(", ")} ... (${available.length} total; read skill://?q=<query> to search)`
						: available.join(", ");
			throw new Error(`Unknown skill: ${skillName}\nAvailable: ${availableStr}`);
		}

		let targetPath: string;
		const urlPath = url.pathname;
		const hasRelativePath = urlPath && urlPath !== "/" && urlPath !== "";

		if (hasRelativePath) {
			const relativePath = decodeURIComponent(urlPath.slice(1));
			validateRelativePath(relativePath);
			targetPath = path.join(skill.baseDir, relativePath);

			const resolvedPath = path.resolve(targetPath);
			const resolvedBaseDir = path.resolve(skill.baseDir);
			if (!resolvedPath.startsWith(resolvedBaseDir + path.sep) && resolvedPath !== resolvedBaseDir) {
				throw new Error("Path traversal is not allowed");
			}
		} else {
			targetPath = context?.pathOnly === true ? skill.baseDir : skill.filePath;
		}

		let stats: fsTypes.Stats;
		try {
			stats = await fs.stat(targetPath);
		} catch (error) {
			if (isEnoent(error)) {
				throw new Error(`File not found: ${targetPath}`);
			}
			throw error;
		}

		if (stats.isDirectory()) {
			return buildDirectoryResource(url.href, targetPath);
		}
		if (!stats.isFile()) {
			throw new Error(`skill:// URL must resolve to a file or directory: ${url.href}`);
		}

		const content = await Bun.file(targetPath).text();
		return {
			url: url.href,
			content,
			contentType: getContentType(targetPath),
			size: Buffer.byteLength(content, "utf-8"),
			sourcePath: targetPath,
			notes: [],
		};
	}

	async complete(): Promise<UrlCompletion[]> {
		return getActiveSkills().map(skill => ({
			value: skill.name,
			...(skill.description ? { description: skill.description } : {}),
		}));
	}
}
