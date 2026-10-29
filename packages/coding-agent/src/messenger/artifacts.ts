import * as fsConstants from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { prompt } from "jeopi-utils";
import artifactPrompt from "../prompts/system/messenger-artifacts.md" with { type: "text" };
import { messengerConversationKey } from "./gateway";
import type { MessengerMessage } from "./types";

const MAX_ARTIFACT_SIZE = 8 * 1024 * 1024;
const MAX_ARTIFACTS = 10;

export function messengerArtifactDirectory(root: string, message: MessengerMessage): string {
	const route = new Bun.CryptoHasher("sha256").update(messengerConversationKey(message)).digest("hex");
	return path.join(root, route);
}

export async function prepareMessengerArtifactDirectory(root: string, message: MessengerMessage): Promise<string> {
	const rootStat = await fs.lstat(root);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Invalid artifact directory");
	const directory = messengerArtifactDirectory(root, message);
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	const stat = await fs.lstat(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid artifact directory");
	return directory;
}

async function withAbort<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) throw new Error("Attachment download aborted");
	const stopped = Promise.withResolvers<never>();
	const abort = (): void => stopped.reject(new Error("Attachment download aborted"));
	signal.addEventListener("abort", abort, { once: true });
	try {
		return await Promise.race([operation(), stopped.promise]);
	} finally {
		signal.removeEventListener("abort", abort);
	}
}

export async function downloadMessengerAttachments(
	directory: string,
	message: MessengerMessage,
	signal: AbortSignal,
	fetchImpl: typeof fetch = fetch,
	timeoutMs = 30_000,
): Promise<string[]> {
	const attachments = message.attachments ?? [];
	if (attachments.length > 5) throw new Error("Too many attachments");
	const paths: string[] = [];
	for (const [index, attachment] of attachments.entries()) {
		const url = new URL(attachment.url);
		if (
			url.protocol !== "https:" ||
			url.hostname !== "cdn.discordapp.com" ||
			url.port ||
			url.username ||
			url.password ||
			!url.pathname.startsWith("/attachments/")
		)
			throw new Error("Invalid attachment URL");
		if (!Number.isSafeInteger(attachment.size) || attachment.size < 0 || attachment.size > MAX_ARTIFACT_SIZE)
			throw new Error("Invalid attachment size");
		const downloadSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
		const response = await withAbort(
			() => fetchImpl(url, { signal: downloadSignal, redirect: "error" }),
			downloadSignal,
		);
		if (!response.ok || !response.body) throw new Error("Attachment download failed");
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		try {
			while (true) {
				const { done, value } = await withAbort(() => reader.read(), downloadSignal);
				if (done) break;
				size += value.byteLength;
				if (size > MAX_ARTIFACT_SIZE || size > attachment.size) throw new Error("Attachment exceeds declared size");
				chunks.push(value);
			}
		} finally {
			void reader.cancel().catch(() => {});
		}
		if (size !== attachment.size) throw new Error("Attachment size mismatch");
		const safeName =
			path
				.basename(attachment.filename)
				.replace(/[^a-zA-Z0-9._-]/gu, "_")
				.slice(0, 100) || "attachment";
		const id = new Bun.CryptoHasher("sha256").update(message.messageId).digest("hex");
		const file = path.join(directory, `input-${id}-${index}-${safeName}`);
		await fs.writeFile(file, Buffer.concat(chunks), { flag: "wx", mode: 0o600 });
		paths.push(file);
	}
	return paths;
}

export async function messengerArtifactPrompt(
	root: string | undefined,
	message: MessengerMessage,
	signal: AbortSignal,
): Promise<string> {
	if (!root) {
		if (message.attachments?.length) throw new Error("Discord attachments are not enabled");
		return "";
	}
	const directory = await prepareMessengerArtifactDirectory(root, message);
	const inputs = await downloadMessengerAttachments(directory, message, signal);
	return prompt.render(artifactPrompt, { directory, inputs: inputs.join(", ") });
}

export async function readMessengerArtifacts(
	root: string,
	message: MessengerMessage,
	text: string,
): Promise<{
	text: string;
	files: { name: string; data: Uint8Array }[];
}> {
	const names: string[] = [];
	const cleaned = text
		.replace(/^\s*\[artifact:([^\]\r\n]+)\]\s*$/gmu, (_match, name: string) => {
			names.push(name);
			return "";
		})
		.trim();
	if (names.length > MAX_ARTIFACTS) throw new Error("Too many output files");
	if (!names.length) return { text, files: [] };
	const directory = await prepareMessengerArtifactDirectory(root, message);
	const files: { name: string; data: Uint8Array }[] = [];
	for (const name of names) {
		if (
			!name ||
			path.isAbsolute(name) ||
			name.includes("\\") ||
			name.split("/").some(part => !part || part === "." || part === "..")
		) {
			throw new Error("Invalid output file path");
		}
		let current = path.resolve(directory);
		for (const part of name.split("/")) {
			current = path.join(current, part);
			const entry = await fs.lstat(current);
			if (entry.isSymbolicLink()) throw new Error("Output file symlinks are not allowed");
		}
		if (!(await fs.lstat(current)).isFile()) throw new Error("Output file is not a regular file");
		const handle = await fs.open(
			current,
			fsConstants.constants.O_RDONLY | fsConstants.constants.O_NOFOLLOW | fsConstants.constants.O_NONBLOCK,
		);
		try {
			const stat = await handle.stat();
			if (!stat.isFile() || stat.size > MAX_ARTIFACT_SIZE)
				throw new Error("Output file is invalid or exceeds 8 MiB");
			const data = Buffer.alloc(stat.size + 1);
			let offset = 0;
			while (offset < data.length) {
				const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
				if (!bytesRead) break;
				offset += bytesRead;
			}
			if (offset !== stat.size) throw new Error("Output file changed while being read");
			files.push({ name: path.basename(name), data: data.subarray(0, offset) });
		} finally {
			await handle.close();
		}
	}
	return { text: cleaned, files };
}
