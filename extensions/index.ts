/**
 * pi-provider-girard — one-command connect for api.girard-davila.net
 *
 * A thin preset layer over `pi-provider-litellm` (npm:pi-provider-litellm):
 * writes the proxy base URL into Pi settings so `/login litellm` (SSO) has
 * nothing to fill in, then walks you to the coding model.
 *
 * Usage: /girard
 *
 * Requires: pi-provider-litellm installed and loaded in the same session.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BASE_URL = "https://api.girard-davila.net/api/llm";
const MODEL = "litellm/qwen3.8-coder";
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

/** Merge the preset base URL into ~/.pi/agent/settings.json (never clobbers). */
function writeBaseUrlSetting(): void {
	const settings = readJson(settingsPath);
	const litellm = (settings.litellm ??= {}) as Record<string, unknown>;
	const providers = (litellm.providers ??= {}) as Record<string, unknown>;
	const definition = (providers.litellm ??= {}) as Record<string, unknown>;
	definition.baseUrl = BASE_URL;
	fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}

function hasCredentialFor(): { present: boolean; root?: string } {
	const auth = readJson(authPath);
	const cred: unknown = auth["litellm"];
	if (cred === null || typeof cred !== "object" || Array.isArray(cred)) return { present: false };
	const record = cred as Record<string, unknown>;
	if (record.type !== "oauth" && record.type !== "api_key") return { present: false };
	const root = typeof record.baseUrl === "string" ? record.baseUrl : undefined;
	return { present: true, root };
}

export default function girardExtension(pi: ExtensionAPI) {
	pi.registerCommand("girard", {
		description: "Connect to api.girard-davila.net (LiteLLM SSO preset for this endpoint)",
		handler: async (_args, ctx) => {
			const commands = pi.getCommands();
			if (!commands.some((c) => c.name === PEER_COMMAND)) {
				ctx.ui.notify(
					[
						"api.girard-davila.net connect: the LiteLLM provider extension is not loaded in this session.",
						"",
						"1) pi install npm:pi-provider-litellm",
						"2) restart pi",
						"3) run /girard again",
					].join("\n"),
					"error",
				);
				return;
			}

			writeBaseUrlSetting();

			const lines: string[] = [
				`api.girard-davila.net connected (${BASE_URL})`,
				"Base URL written to ~/.pi/agent/settings.json (litellm default provider).",
			];

			const cred = hasCredentialFor();
			if (cred.present && (cred.root === undefined || cred.root === BASE_URL)) {
				lines.push("", `Already logged in. Select the model:`);
				lines.push(`  /model ${MODEL}`);
			} else {
				lines.push(
					"",
					"Next: sign in (GitHub SSO, opens your browser)",
					"  /login litellm        →  “Sign in with LiteLLM SSO”",
					`  ${BASE_URL} is offered as the proxy URL`,
					"then select the model:",
					`  /model ${MODEL}`,
				);
				if (cred.root && cred.root !== BASE_URL) {
					lines.push(
						"",
						`Note: existing credential points at ${cred.root} — re-login will re-target this endpoint.`,
					);
				}
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
