/**
 * Laya decision engine for pi.
 *
 * Registers the `laya_decide` tool, which asks a Laya HTTP server (`POST /v1/systemone`)
 * typed questions about a piece of text, and the `/laya` command to check or configure it.
 *
 * Configuration, highest precedence first:
 *   - LAYA_API_URL / LAYA_API_KEY environment variables
 *   - <agent-dir>/laya.json: {"url": "https://laya.example.com", "apiKey": "..."}  (written by /laya setup)
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";

const REQUEST_TIMEOUT_MS = 60_000;
const BUSY_RETRIES = 3;
const MODELS = ["english", "multilingual", "typed-decisions"] as const;

// ---------------------------------------------------------------- configuration

interface StoredConfig {
	url?: string;
	apiKey?: string;
}

interface LayaConfig {
	url: string;
	apiKey?: string;
	urlSource: string;
	keySource: string;
}

const StoredConfigSchema = Type.Object({
	url: Type.Optional(Type.String()),
	apiKey: Type.Optional(Type.String()),
});

function configPath(): string {
	return join(getAgentDir(), "laya.json");
}

async function readStoredConfig(): Promise<StoredConfig> {
	let raw: string;
	try {
		raw = await readFile(configPath(), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
	const parsed: unknown = JSON.parse(raw);
	if (!Value.Check(StoredConfigSchema, parsed)) {
		throw new Error(`${configPath()} must be {"url": "...", "apiKey": "..."} with string values`);
	}
	return { url: parsed.url?.trim() || undefined, apiKey: parsed.apiKey?.trim() || undefined };
}

async function loadConfig(): Promise<LayaConfig> {
	const stored = await readStoredConfig();
	const envUrl = process.env.LAYA_API_URL?.trim();
	const envKey = process.env.LAYA_API_KEY?.trim();
	const url = envUrl || stored.url;
	if (!url) {
		throw new Error(
			`Laya is not configured. Run /laya setup, set LAYA_API_URL (and LAYA_API_KEY), ` +
				`or write {"url": "...", "apiKey": "..."} to ${configPath()}.`,
		);
	}
	return {
		url: url.replace(/\/+$/, ""),
		apiKey: envKey || stored.apiKey,
		urlSource: envUrl ? "LAYA_API_URL" : configPath(),
		keySource: envKey ? "LAYA_API_KEY" : stored.apiKey ? configPath() : "not set",
	};
}

// ---------------------------------------------------------------- HTTP

const LabelSchema = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]);
const Probabilities = Type.Record(Type.String(), Type.Number());
const LowConfidence = Type.Optional(Type.Boolean());

const AnswerSchema = Type.Union([
	Type.Object({
		type: Type.Literal("choice"),
		choice: LabelSchema,
		probabilities: Probabilities,
		answer_confidence: Type.Number(),
		low_confidence: LowConfidence,
	}),
	Type.Object({
		type: Type.Literal("score"),
		score: Type.Number(),
		probabilities: Probabilities,
		legend: Type.Record(Type.String(), Type.String()),
		low_confidence: LowConfidence,
	}),
	Type.Object({ type: Type.Literal("noul"), noul: Type.Number(), low_confidence: LowConfidence }),
]);

const DecisionResponseSchema = Type.Object({
	answers: Type.Record(Type.String(), AnswerSchema),
	routing: Type.Optional(Type.Object({ model: Type.Optional(Type.String()), reason: Type.Optional(Type.String()) })),
	usage: Type.Optional(
		Type.Object({ truncated: Type.Optional(Type.Boolean()), state_tokens_dropped: Type.Optional(Type.Number()) }),
	),
});

const HealthResponseSchema = Type.Object({
	status: Type.Optional(Type.String()),
	loaded: Type.Optional(Type.Array(Type.String())),
	device: Type.Optional(Type.String()),
});

/**
 * Call the Laya server and validate the JSON body against `schema`.
 * Retries a 503 ("busy") after its Retry-After, up to BUSY_RETRIES times.
 */
async function layaRequest<T extends TSchema>(
	config: LayaConfig,
	path: string,
	schema: T,
	body: unknown,
	signal: AbortSignal | undefined,
): Promise<{ json: Static<T>; headers: Headers }> {
	const headers: Record<string, string> = { accept: "application/json" };
	if (body !== undefined) headers["content-type"] = "application/json";
	if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;

	for (let attempt = 0; ; attempt++) {
		const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
		const response = await fetch(config.url + path, {
			method: body === undefined ? "GET" : "POST",
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
		const text = await response.text();
		let json: unknown;
		try {
			json = text ? JSON.parse(text) : undefined;
		} catch {
			// Non-JSON bodies come from a proxy in front of Laya; reported below by status.
		}
		if (response.ok) {
			if (!Value.Check(schema, json)) {
				throw new Error(`unexpected response from ${config.url}${path}: ${text.slice(0, 200)}`);
			}
			return { json, headers: response.headers };
		}

		if (response.status === 503 && attempt < BUSY_RETRIES) {
			const retryAfter = Number(response.headers.get("retry-after"));
			await sleep((retryAfter > 0 ? retryAfter : 1) * 1000, undefined, { signal });
			continue;
		}
		const rawDetail = json && typeof json === "object" && "detail" in json ? json.detail : undefined;
		const detail =
			typeof rawDetail === "string"
				? rawDetail
				: rawDetail !== undefined
					? JSON.stringify(rawDetail)
					: text.slice(0, 200) || response.statusText;
		if (response.status === 401) throw new Error(`Laya rejected the API key (401: ${detail}). Check it with /laya.`);
		if (response.status === 503) throw new Error(`Laya is busy (503 after ${BUSY_RETRIES} retries): ${detail}`);
		throw new Error(`Laya returned ${response.status}: ${detail}`);
	}
}

// ---------------------------------------------------------------- tool

const OptionSchema = Type.Object({
	label: Type.String({ description: "Answer label, returned exactly as written" }),
	description: Type.Optional(
		Type.String({
			description:
				"choice only: what this option means. Laya reads it, so a concrete description improves accuracy.",
		}),
	),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for this question, e.g. 'department'" }),
	type: StringEnum(["choice", "score", "yes_no"] as const, {
		description:
			"choice: pick one option. score: position on an ordered scale. yes_no: probability that the answer is yes.",
	}),
	question: Type.String({ description: "The question, e.g. 'Which team should handle this ticket?'" }),
	options: Type.Optional(
		Type.Array(OptionSchema, {
			description:
				"choice: the candidate answers (2-100, 20 or fewer works best). " +
				"score: the levels in order from lowest to highest (descriptions are ignored). Omit for yes_no.",
		}),
	),
});

const parameters = Type.Object({
	state: Type.String({
		description:
			"The text the questions are about: a message, ticket, log excerpt, document or conversation. " +
			"Pass the full relevant text; Laya cannot see anything else.",
	}),
	questions: Type.Array(QuestionSchema, {
		minItems: 1,
		maxItems: 64,
		description: "All questions about this text; they are answered together in one pass.",
	}),
	model: Type.Optional(
		StringEnum(MODELS, {
			description:
				"Force a checkpoint. Omit to let Laya choose from the text (english, or multilingual for other languages).",
		}),
	),
	lang: Type.Optional(
		Type.String({ description: "Language code of the text if known (e.g. 'en', 'fr'); routes to the right model" }),
	),
	min_confidence: Type.Optional(
		Type.Number({
			minimum: 0,
			maximum: 1,
			description: "Flag answers whose confidence is below this value as low_confidence",
		}),
	),
});

function toLayaQuestions(questions: Static<typeof parameters>["questions"]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const q of questions) {
		const id = q.id.trim();
		if (!id) throw new Error("every question needs a non-empty id");
		if (id in out) throw new Error(`duplicate question id '${id}'`);
		if (q.type === "yes_no") {
			out[id] = { type: "noul", instructions: q.question };
			continue;
		}
		const options = q.options ?? [];
		if (options.length < 2) throw new Error(`question '${id}' (${q.type}) needs at least 2 options`);
		const labels = options.map((o) => o.label);
		if (new Set(labels).size !== labels.length) throw new Error(`question '${id}' has duplicate option labels`);
		out[id] =
			q.type === "choice"
				? {
						type: "choice",
						instructions: q.question,
						criteria: Object.fromEntries(options.map((o) => [o.label, o.description?.trim() || null])),
					}
				: { type: "score", instructions: q.question, criteria: labels };
	}
	return out;
}

const pct = (p: number) => `${(p * 100).toFixed(1)}%`;

function formatAnswer(id: string, answer: Static<typeof AnswerSchema> | undefined): string {
	if (!answer) return `- ${id}: (no answer returned)`;
	const flag = answer.low_confidence ? " [LOW CONFIDENCE]" : "";
	const ranked = answer.type === "noul" ? [] : Object.entries(answer.probabilities).sort((a, b) => b[1] - a[1]);
	switch (answer.type) {
		case "noul":
			return `- ${id} (yes/no): P(yes) = ${pct(answer.noul)}${flag}`;
		case "choice": {
			const others = ranked
				.filter(([label]) => label !== String(answer.choice))
				.slice(0, 3)
				.map(([label, p]) => `${label} ${pct(p)}`)
				.join(", ");
			return `- ${id} (choice): ${answer.choice} ${pct(answer.answer_confidence)}${others ? `; others: ${others}` : ""}${flag}`;
		}
		case "score": {
			const [topLevel, topP] = ranked[0] ?? ["?", 0];
			const maxLevel = Object.keys(answer.legend).length - 1;
			return (
				`- ${id} (score): ${answer.score.toFixed(2)} on a 0-${maxLevel} scale; ` +
				`most likely "${answer.legend[topLevel] ?? topLevel}" ${pct(topP)}${flag}`
			);
		}
	}
}

const layaDecide = defineTool({
	name: "laya_decide",
	label: "Laya",
	description:
		"Ask Laya, a fast local decision model, typed questions about a piece of text. " +
		"Supports choice (pick one option), score (ordered scale) and yes_no questions, all answered in one call, " +
		"and returns probabilities for every answer. Use it to classify, triage, route or score text " +
		"(support tickets, messages, logs, documents) consistently, instead of judging by eye.",
	promptSnippet: "Classify, route or score text with typed choice/score/yes_no questions and get probabilities.",
	promptGuidelines: [
		"Use laya_decide to classify, triage or score text; put every question about one text in a single call.",
		"For laya_decide choice questions, give each option a concrete description, keep to about 20 options, and avoid negated wording ('not X'), which Laya handles poorly.",
		"Treat laya_decide answers marked LOW CONFIDENCE, or choices below about 60%, as uncertain, and say so.",
	],
	parameters,
	annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },

	async execute(_toolCallId, params, signal) {
		const config = await loadConfig();
		const body: Record<string, unknown> = { state: params.state, questions: toLayaQuestions(params.questions) };
		if (params.model) body.model = params.model;
		if (params.lang) body.lang = params.lang;
		if (params.min_confidence !== undefined) body.min_confidence = params.min_confidence;

		const { json, headers } = await layaRequest(config, "/v1/systemone", DecisionResponseSchema, body, signal);
		const inferenceMs = headers.get("x-inference-time-ms");
		const lines = [
			`Laya answers (model: ${json.routing?.model ?? "?"}${json.routing?.reason ? ` - ${json.routing.reason}` : ""}${
				inferenceMs ? `, ${Math.round(Number(inferenceMs))} ms` : ""
			}):`,
			...params.questions.map((q) => formatAnswer(q.id.trim(), json.answers[q.id.trim()])),
		];
		if (json.usage?.truncated) {
			lines.push(
				`Note: the text was truncated (${json.usage.state_tokens_dropped ?? "some"} tokens dropped); ` +
					"answers only reflect the part Laya read.",
			);
		}
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { url: config.url, routing: json.routing, answers: json.answers, usage: json.usage, inferenceMs },
		};
	},
});

// ---------------------------------------------------------------- command

async function showStatus(notify: (message: string, type?: "info" | "warning" | "error") => void): Promise<void> {
	let config: LayaConfig;
	try {
		config = await loadConfig();
	} catch (error) {
		notify((error as Error).message, "warning");
		return;
	}
	const key = config.apiKey;
	const masked = !key ? "(none)" : key.length <= 8 ? "****" : `${key.slice(0, 4)}…${key.slice(-4)}`;
	const header = `Laya: ${config.url} (from ${config.urlSource}), key ${masked} (${config.keySource})`;
	try {
		const { json } = await layaRequest(config, "/health", HealthResponseSchema, undefined, undefined);
		notify(
			`${header}\nhealth: ${json.status ?? "?"}, models loaded: ${json.loaded?.join(", ") || "none"}, device: ${json.device ?? "?"}`,
			"info",
		);
	} catch (error) {
		notify(`${header}\nhealth check failed: ${(error as Error).message}`, "error");
	}
}

export default function layaExtension(pi: ExtensionAPI) {
	pi.registerTool(layaDecide);

	pi.registerCommand("laya", {
		description: "Laya decision engine: show status (default) or `setup` the API URL and key",
		getArgumentCompletions: (prefix) => {
			const items = ["status", "setup"].filter((s) => s.startsWith(prefix));
			return items.length > 0 ? items.map((s) => ({ value: s, label: s })) : null;
		},
		handler: async (args, ctx) => {
			const notify = ctx.ui.notify.bind(ctx.ui);
			const sub = args.trim();
			if (sub === "" || sub === "status") return showStatus(notify);
			if (sub !== "setup") {
				notify(`Unknown argument '${sub}'. Use /laya or /laya setup.`, "warning");
				return;
			}
			if (!ctx.hasUI) {
				notify(`No interactive UI: edit ${configPath()} or set LAYA_API_URL / LAYA_API_KEY.`, "warning");
				return;
			}
			const stored = await readStoredConfig();
			const url = (await ctx.ui.input("Laya API URL", stored.url ?? "https://laya.example.com"))?.trim();
			if (url === undefined) return;
			const apiKey = (
				await ctx.ui.input("Laya API key", stored.apiKey ? "leave empty to keep the current key" : "Bearer token")
			)?.trim();
			if (apiKey === undefined) return;

			const path = configPath();
			await mkdir(dirname(path), { recursive: true });
			const config: StoredConfig = { url: url || stored.url, apiKey: apiKey || stored.apiKey };
			await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
			await chmod(path, 0o600); // writeFile's mode applies only when it creates the file
			notify(`Saved ${path}`, "info");
			await showStatus(notify);
		},
	});
}
