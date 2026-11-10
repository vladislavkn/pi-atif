/**
 * pi-atif: saves the session log as an ATIF trajectory after every agent run and on exit.
 * `/atif [path]` exports on demand.
 *
 * Output: $PI_ATIF_DIR (default ~/.pi/agent/atif)/<session-dir>/<session-name>/trajectory.json,
 * with images in images/ next to it.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir, VERSION } from "@earendil-works/pi-coding-agent";
import { toAtif } from "./atif.ts";

function defaultPath({ sessionManager: sm }: ExtensionContext): string {
	const base = process.env.PI_ATIF_DIR || join(getAgentDir(), "atif");
	const file = sm.getSessionFile();
	if (!file) return join(base, "ephemeral", sm.getSessionId(), "trajectory.json");
	return join(base, basename(dirname(file)), basename(file, ".jsonl"), "trajectory.json");
}

function save(ctx: ExtensionContext, target = defaultPath(ctx)): number {
	const sm = ctx.sessionManager;
	const entries = sm.getBranch();
	if (!entries.some((e) => e.type === "message" && e.message.role !== "system")) return 0;

	const file = resolve(ctx.cwd, target);
	const dir = dirname(file);
	mkdirSync(dir, { recursive: true });

	const trajectory = toAtif(sm.getHeader(), entries, {
		agentVersion: VERSION,
		sessionFile: sm.getSessionFile(),
		sessionName: sm.getSessionName(),
		saveImage(data, mimeType) {
			const bytes = Buffer.from(data, "base64");
			const name = `${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}.${mimeType.split("/")[1]}`;
			const path = join(dir, "images", name);
			if (!existsSync(path)) {
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, bytes);
			}
			return `images/${name}`;
		},
	});

	// Write-then-rename so readers never see a half-written file.
	writeFileSync(`${file}.tmp`, JSON.stringify(trajectory, null, 2));
	renameSync(`${file}.tmp`, file);
	return trajectory.steps.length;
}

export default function (pi: ExtensionAPI) {
	const autoSave = (_event: unknown, ctx: ExtensionContext) => {
		try {
			save(ctx);
		} catch (err) {
			ctx.ui.notify(`ATIF export failed: ${(err as Error).message}`, "error");
		}
	};
	pi.on("agent_settled", autoSave);
	pi.on("session_shutdown", autoSave);

	pi.registerCommand("atif", {
		description: "Export this session as an ATIF trajectory: /atif [output.json]",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const target = args.trim() || defaultPath(ctx);
			const steps = save(ctx, target);
			ctx.ui.notify(steps ? `ATIF: wrote ${steps} steps to ${resolve(ctx.cwd, target)}` : "ATIF: nothing to export yet", "info");
		},
	});
}
