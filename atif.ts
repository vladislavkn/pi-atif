/**
 * Converts the entries of a pi session branch into an ATIF trajectory.
 * Spec: https://github.com/harbor-framework/harbor/blob/main/rfcs/0001-trajectory-format.md
 */

import type { SessionEntry, SessionHeader } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent, Usage } from "@earendil-works/pi-ai";

type Extra = Record<string, unknown>;
type ContentPart = { type: "text"; text: string } | { type: "image"; source: { media_type: string; path: string } };
type Content = string | ContentPart[];

export interface Step {
	step_id: number;
	timestamp: string;
	source: "system" | "user" | "agent";
	message: Content;
	model_name?: string;
	reasoning_effort?: string;
	reasoning_content?: string;
	tool_calls?: { tool_call_id: string; function_name: string; arguments: Extra }[];
	observation?: { results: { source_call_id?: string; content: Content; extra?: Extra }[] };
	metrics?: { prompt_tokens: number; completion_tokens: number; cached_tokens: number; cost_usd: number; extra?: Extra };
	llm_call_count?: number;
	extra?: Extra;
}

export interface Trajectory {
	schema_version: "ATIF-v1.8";
	session_id?: string;
	agent: { name: string; version: string; model_name?: string; tool_definitions?: unknown[] };
	steps: Step[];
	notes: string;
	final_metrics: Extra;
	extra?: Extra;
}

export interface ConvertOptions {
	agentVersion: string;
	sessionFile?: string;
	sessionName?: string;
	/** Store an image and return its path relative to the trajectory file. */
	saveImage: (data: string, mimeType: string) => string;
}

const ATIF_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

export function toAtif(header: SessionHeader | null, entries: SessionEntry[], opts: ConvertOptions): Trajectory {
	const steps: Step[] = [];
	const stepByEntry = new Map<string, Step>();
	const stepByToolCall = new Map<string, Step>();
	const tools = new Map<string, { name: string; description?: string; parameters?: unknown }>();
	const total = { prompt: 0, completion: 0, cached: 0, cacheWrite: 0, cost: 0, otherCost: 0 };
	let thinkingLevel: string | undefined;

	const add = (entry: SessionEntry, step: Omit<Step, "step_id" | "timestamp">) => {
		const full: Step = { step_id: steps.length + 1, timestamp: entry.timestamp, ...step };
		full.extra = { ...full.extra, pi: { entry_id: entry.id, ...(full.extra?.pi as Extra) } };
		steps.push(full);
		stepByEntry.set(entry.id, full);
		return full;
	};
	const content = (c: string | (TextContent | ImageContent)[]) => toContent(c, opts.saveImage);

	for (const entry of entries) {
		switch (entry.type) {
			case "thinking_level_change":
				thinkingLevel = entry.thinkingLevel;
				break;

			case "usage": // e.g. cache warming: costs money, but is not part of the conversation
				total.otherCost += entry.usage.cost.total;
				break;

			case "custom_message": // extension-injected context, sent to the model as a user message
				add(entry, {
					source: "user",
					message: content(entry.content),
					extra: { pi: { role: "custom", custom_type: entry.customType } },
				});
				break;

			case "compaction":
				total.otherCost += entry.usage?.cost.total ?? 0;
				add(entry, {
					source: "system",
					message: "Context compaction performed",
					observation: { results: [{ content: entry.summary }] },
					extra: {
						// pi keeps the entries from firstKeptEntryId on, so prior context is truncated, not replaced.
						context_management: {
							type: "compaction",
							boundary: entry.firstKeptEntryId === entry.id ? "replace" : "truncate",
						},
						pi: { first_kept_entry_id: entry.firstKeptEntryId, tokens_before: entry.tokensBefore },
					},
				});
				break;

			case "branch_summary":
				total.otherCost += entry.usage?.cost.total ?? 0;
				add(entry, {
					source: "system",
					message: "Branch summary injected",
					observation: { results: [{ content: entry.summary }] },
					extra: { context_management: { type: "injection", boundary: "append" } },
				});
				break;

			case "context_edit": {
				// Only affects what the model sees from now on; annotate the edited step.
				const target = stepByEntry.get(entry.targetId);
				if (target) {
					(target.extra!.pi as Extra).context_edit = entry.replacement
						? { replacement: content(entry.replacement.content as TextContent[]) }
						: { omitted: true };
				}
				break;
			}

			case "message": {
				const msg = entry.message;
				switch (msg.role) {
					case "system":
						for (const tool of msg.toolsAdded ?? []) tools.set(tool.name, tool);
						add(entry, {
							source: "system",
							// pi stores the prompt as named sections; later system messages patch them.
							message: [textOf(msg.content), ...Object.values(msg.sections ?? {})].filter(Boolean).join("\n\n"),
							extra: {
								pi: {
									sections: Object.keys(msg.sections ?? {}),
									tools_added: msg.toolsAdded?.map((t) => t.name),
									tools_removed: msg.toolsRemoved?.map((t) => t.name),
								},
							},
						});
						break;

					case "user":
						add(entry, { source: "user", message: content(msg.content) });
						break;

					case "assistant": {
						const toolCalls = msg.content.flatMap((b) =>
							b.type === "toolCall" ? [{ tool_call_id: b.id, function_name: b.name, arguments: b.arguments ?? {} }] : [],
						);
						const thinking = msg.content.flatMap((b) => (b.type === "thinking" && b.thinking ? [b.thinking] : []));
						const metrics = toMetrics(msg.usage);
						total.prompt += metrics.prompt_tokens;
						total.completion += metrics.completion_tokens;
						total.cached += metrics.cached_tokens;
						total.cacheWrite += msg.usage.cacheWrite;
						total.cost += metrics.cost_usd;

						const step = add(entry, {
							source: "agent",
							model_name: msg.responseModel ?? msg.model,
							reasoning_effort: msg.thinkingLevel ?? thinkingLevel,
							message: textOf(msg.content),
							reasoning_content: thinking.join("\n") || undefined,
							tool_calls: toolCalls.length ? toolCalls : undefined,
							metrics,
							llm_call_count: 1,
							extra: {
								pi: { provider: msg.provider, stop_reason: msg.stopReason, error_message: msg.errorMessage },
							},
						});
						for (const call of toolCalls) stepByToolCall.set(call.tool_call_id, step);
						break;
					}

					case "toolResult": {
						// Attach to the agent step that made the call (always earlier on the same branch).
						const step = stepByToolCall.get(msg.toolCallId);
						if (!step) break;
						total.otherCost += msg.usage?.cost.total ?? 0;
						(step.observation ??= { results: [] }).results.push({
							source_call_id: msg.toolCallId,
							content: content(msg.content),
							extra: { tool_name: msg.toolName, is_error: msg.isError || undefined },
						});
						break;
					}

					case "bashExecution": // user `!cmd`
						add(entry, {
							source: "user",
							message: `$ ${msg.command}\n${msg.output}`,
							extra: {
								pi: { role: "bashExecution", exit_code: msg.exitCode, excluded_from_context: msg.excludeFromContext },
							},
						});
						break;

					default: // roles added by other extensions
						add(entry, {
							source: "user",
							message: "content" in msg ? content(msg.content as string) : "",
							extra: { pi: { role: msg.role } },
						});
				}
				break;
			}

			// model_change, custom, label, session_info: no conversation content
		}
	}

	return {
		schema_version: "ATIF-v1.8",
		session_id: header?.id,
		agent: {
			name: "pi",
			version: opts.agentVersion,
			model_name: steps.find((s) => s.source === "agent")?.model_name,
			tool_definitions: tools.size
				? [...tools.values()].map(({ name, description, parameters }) => ({
						type: "function",
						function: { name, description, parameters },
					}))
				: undefined,
		},
		steps,
		notes:
			"Exported from the active branch of a pi session. One agent step per LLM call; tool results are observations of the step that called them.",
		final_metrics: {
			total_prompt_tokens: total.prompt,
			total_completion_tokens: total.completion,
			total_cached_tokens: total.cached,
			total_cost_usd: round(total.cost + total.otherCost),
			total_steps: steps.length,
			extra: {
				cache_creation_input_tokens: total.cacheWrite,
				// summaries, cache warming, nested model calls of tools
				non_step_cost_usd: round(total.otherCost),
			},
		},
		extra: {
			pi: { cwd: header?.cwd, session_file: opts.sessionFile, session_name: opts.sessionName },
		},
	};
}

function toMetrics(u: Usage): NonNullable<Step["metrics"]> {
	return {
		// ATIF counts cached tokens as part of the prompt; pi reports them separately.
		prompt_tokens: u.input + u.cacheRead + u.cacheWrite,
		completion_tokens: u.output,
		cached_tokens: u.cacheRead,
		cost_usd: u.cost.total,
		extra: u.cacheWrite || u.reasoning ? { cache_creation_input_tokens: u.cacheWrite, reasoning_tokens: u.reasoning } : undefined,
	};
}

function textOf(c: string | { type: string }[]): string {
	if (typeof c === "string") return c;
	return c.flatMap((b) => (b.type === "text" ? [(b as TextContent).text] : [])).join("\n");
}

/** Plain string unless images are present; images become file references. */
function toContent(c: string | (TextContent | ImageContent)[], saveImage: ConvertOptions["saveImage"]): Content {
	if (typeof c === "string" || !c.some((b) => b.type === "image")) return textOf(c);
	return c.map((b): ContentPart => {
		if (b.type === "text") return { type: "text", text: b.text };
		if (!ATIF_IMAGE_TYPES.includes(b.mimeType)) return { type: "text", text: `[image omitted: ${b.mimeType}]` };
		return { type: "image", source: { media_type: b.mimeType, path: saveImage(b.data, b.mimeType) } };
	});
}

const round = (n: number) => Math.round(n * 1e8) / 1e8;
