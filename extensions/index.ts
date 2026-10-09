/**
 * pi-provider-gd — self-contained native `gd` provider for api.girard-davila.net.
 *
 * Installing this package is the whole setup:
 *   pi install git:github.com/alx/pi-provider-gd
 *
 * It registers a native pi provider `gd` that streams OpenAI-compatible
 * requests to the endpoint and discovers models from /v1/models.
 *
 * After install:
 *   /login gd      — either paste an API key created at
 *                    https://api.girard-davila.net/api/llm/ui/ or sign in via
 *                    browser SSO (GitHub → issued key); the key is stored in
 *                    ~/.pi/agent/auth.json under "gd". No hand-editing, no
 *                    separate pi-provider-litellm install.
 *
 * Self-heal: a brand-new session that has no model selected yet is pointed at
 * the default gd model (GD_DEFAULT_MODEL env or DEFAULT_MODEL_ID, validated
 * against the live catalog) as soon as a credential exists — so after
 * install + /login gd the next session is immediately usable.
 *
 * /gd-doctor — diagnose credential + /v1/models reachability from inside pi
 * (pi's /model screen hides the underlying refresh error, so it shows the
 * exact reason a catalog refresh failed).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGdProvider, DEFAULT_MODEL_ID, ENV_API_KEY, toModel } from "../src/provider.ts";
import {
	BASE_URL,
	PROVIDER_ID,
	credentialKey,
	defaultAuthPath,
	fetchModelIds,
	fetchModelIdsChecked,
	getCredential,
} from "../src/core.ts";

const DEFAULT_MODEL_DISCOVER_TIMEOUT_MS = 4000;

export default function gdExtension(pi: ExtensionAPI) {
	pi.registerProvider(createGdProvider());

	/**
	 * Option B: land a model-less session on the default gd model.
	 * No-op when the session already has a model or no credential is stored.
	 */
	const ensureDefaultModel = (ctx: ExtensionContext) => {
		return (async () => {
			if (ctx.model) return; // session already has a model
			const storedKey = credentialKey(getCredential(defaultAuthPath(), PROVIDER_ID));
			const key = storedKey ?? process.env[ENV_API_KEY];
			if (!key) return; // not logged in; /login gd will guide the user
			// Best-effort catalog: [] on network failure, in which case we fall
			// back to the configured default id unvalidated.
			const ids = await fetchModelIds(BASE_URL, key, {
				timeoutMs: DEFAULT_MODEL_DISCOVER_TIMEOUT_MS,
			});
			const desired = process.env.GD_DEFAULT_MODEL ?? DEFAULT_MODEL_ID;
			const id = ids.includes(desired) ? desired : (ids[0] ?? desired);
			await pi.setModel(toModel(id));
		})().catch(() => {
			/* never break session start */
		});
	};

	pi.on("session_start", (_event, ctx) => {
		void ensureDefaultModel(ctx);
	});

	/**
	 * /gd-doctor — diagnose the gd provider from inside pi.
	 * pi's /model screen hides the underlying refresh error, so this reports
	 * the exact failure (credential state, network, HTTP status, model list).
	 */
	pi.registerCommand("gd-doctor", {
		description: `Diagnose the gd provider (credential + ${BASE_URL}/v1/models)`,
		async handler() {
			const lines: string[] = [];
			const storedKey = credentialKey(getCredential(defaultAuthPath(), PROVIDER_ID));
			const key = storedKey ?? process.env[ENV_API_KEY];
			lines.push(`gd-doctor — endpoint: ${BASE_URL}`);
			lines.push(
				`credential: ${key ? `found (${key.slice(0, 8)}…, from ${storedKey ? "auth.json" : ENV_API_KEY})` : "none — run /login gd"}`,
			);
			if (key) {
				try {
					const ids = await fetchModelIdsChecked(BASE_URL, key, { timeoutMs: 8000 });
					lines.push(`discovery: OK — ${ids.length} model(s): ${ids.join(", ")}`);
					const desired = process.env.GD_DEFAULT_MODEL ?? DEFAULT_MODEL_ID;
					lines.push(`default model would be: ${ids.includes(desired) ? desired : (ids[0] ?? desired)}`);
				} catch (e) {
					lines.push(`discovery FAILED: ${e instanceof Error ? e.message : String(e)}`);
					lines.push("If this is a network error, check connectivity from this machine, e.g.: curl -I " + BASE_URL + "/v1/models");
					lines.push("If the problem persists, contact the maintainer: Alexandre Girard <git@alexgirard.com> — please include this /gd-doctor output.");
				}
			}
			pi.sendMessage({ customType: "gd-doctor", content: lines.join("\n"), display: true });
		},
	});
}
