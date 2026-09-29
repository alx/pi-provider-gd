/**
 * pi-provider-gd — one-command connect for api.girard-davila.net
 *
 * A thin preset layer over `pi-provider-litellm` (npm:pi-provider-litellm):
 * registers the endpoint as the named provider "gd" in Pi settings —
 * the LiteLLM machinery stays internal to the extension, the user sees one
 * Girard provider.
 *
 * Model names are DISCOVERED from the endpoint: /gd-register calls
 * `<baseUrl>/v1/models` (the LiteLLM proxy, which mirrors the alias llama.cpp
 * advertises, derived from the GGUF filename) with the stored API key and
 * prints the exact `gd/<model-id>` names to select. If the endpoint is
 * unreachable, a static fallback name is printed instead.
 *
 * Usage: /gd-register
 *
 * Requires: pi-provider-litellm installed and loaded in the same session.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BASE_URL = "https://api.girard-davila.net/api/llm";
const PROVIDER = "gd";
// Used only when the /v1/models call fails (endpoint offline, no key yet):
const FALLBACK_MODEL = "Qwen3.8-27B-i1-IQ4_XS-GGUF-Smaller";
const DISCOVER_TIMEOUT_MS = 8000;
// Command registered by pi-provider-litellm when it is loaded:
const PEER_COMMAND = "litellm-refresh";

const agentDir = path.join(os.homedir(), ".pi", "agent");
const settingsPath = path.join(agentDir, "settings.json");
const authPath = path.join(agentDir, "auth.json");

function readJson(file: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

/** Merge the gd provider definition into ~/.pi/agent/settings.json (never clobbers). */
function writeProviderSetting(): void {
	const settings = readJson(settingsPath);
	const litellm = (settings.litellm ??= {}) as Record<string, unknown>;
	const providers = (litellm.providers ??= {}) as Record<string, unknown>;
	const definition = (providers[PROVIDER] ??= {}) as Record<string, unknown>;
	definition.displayName = "Girard";
	definition.baseUrl = BASE_URL;
	fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}

function hasCredentialFor(): { present: boolean; root?: string; key?: string } {
	const auth = readJson(authPath);
	const cred: unknown = auth[PROVIDER];
	if (cred === null || typeof cred !== "object" || Array.isArray(cred)) return { present: false };
	const record = cred as Record<string, unknown>;
	if (record.type !== "oauth" && record.type !== "api_key") return { present: false };
	const env = record.env as Record<string, unknown> | undefined;
	const root =
		(typeof record.baseUrl === "string" && record.baseUrl) ||
		(env && typeof env.LITELLM_BASE_URL === "string" ? (env.LITELLM_BASE_URL as string) : undefined);
	const key = typeof record.key === "string" ? record.key : undefined;
	return { present: true, root, key };
}

/**
 * Fetch model ids from an OpenAI-compatible /v1/models endpoint.
 * Returns [] on any failure (caller falls back to FALLBACK_MODEL).
 */
async function fetchModelIds(baseUrl: string, apiKey?: string): Promise<string[]> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), DISCOVER_TIMEOUT_MS);
	try {
		const headers: Record<string, string> = { Accept: "application/json" };
		if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
		const res = await fetch(`${baseUrl}/v1/models`, { headers, signal: controller.signal });
		if (!res.ok) return [];
		const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
		const ids = Array.isArray(body.data)
			? body.data.map((m) => m.id).filter((id): id is string => typeof id === "string" && id.length > 0)
			: [];
		return [...new Set(ids)];
	} catch {
		return [];
	} finally {
		clearTimeout(timer);
	}
}

export default function gdExtension(pi: ExtensionAPI) {
	pi.registerCommand("gd-register", {
		description: "Connect api.girard-davila.net as the " + PROVIDER + " provider",
		handler: async (_args, ctx) => {
			const commands = pi.getCommands();
			if (!commands.some((c) => c.name === PEER_COMMAND)) {
				ctx.ui.notify(
					[
						"api.girard-davila.net connect: the LiteLLM provider extension is not loaded in this session.",
						"",
						"1) pi install npm:pi-provider-litellm",
						"2) restart pi",
						"3) run /gd-register again",
					].join("\n"),
					"error",
				);
				return;
			}

			writeProviderSetting();

			const lines: string[] = [
				`api.girard-davila.net connected (${BASE_URL})`,
				`Provider "${PROVIDER}" written to ~/.pi/agent/settings.json.`,
			];

			const cred = hasCredentialFor();
			const models = await fetchModelIds(BASE_URL, cred.key);
			if (models.length > 0) {
				lines.push(
					"",
					"Models on api.girard-davila.net (live from /v1/models):",
					...models.map((id) => `  /model ${PROVIDER}/${id}`),
				);
			} else if (cred.present && (cred.root === undefined || cred.root === BASE_URL)) {
				lines.push(
					"",
					"Credential present, but /v1/models was not reachable — select the model:",
					`  /model ${PROVIDER}/${FALLBACK_MODEL}`,
				);
			} else {
				lines.push(
					"",
					"No \u201c" + PROVIDER + "\u201d credential found. Add your endpoint API key to",
					`~/.pi/agent/auth.json, then restart pi:`,
					`  "${PROVIDER}": { "type": "api_key", "key": "sk-..." }`,
					`then select the model:  /model ${PROVIDER}/${FALLBACK_MODEL}`,
				);
				if (cred.root && cred.root !== BASE_URL) {
					lines.push("", `Note: existing credential points at ${cred.root}.`);
				}
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
