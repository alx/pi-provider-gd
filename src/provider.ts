/**
 * pi-provider-gd — native `gd` provider.
 *
 * Builds a self-contained pi Provider: OpenAI-compatible streaming against
 * the gd API at api.girard-davila.net/api/llm (infrastructure), dynamic model
 * discovery from /v1/models, and API-key login (the key is issued on the
 * customer portal, provider.girard-davila.net, after Google sign-in at
 * /auth/google). No pi-provider-litellm.
 *
 * Login is a pi auth flow (`auth.apiKey.login`), so the standard `/login gd`
 * selector drives it. pi persists the returned credential to the shared auth
 * store (auth.json) under the provider id automatically.
 */
import type {
	ApiKeyCredential,
	AuthCheck,
	AuthContext,
	AuthResult,
	AuthInteraction,
	Model,
	Provider,
} from "@earendil-works/pi-ai";
import { createProvider, openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import {
	BASE_URL,
	PROVIDER_ID,
	fetchModelIdsChecked,
	fetchModelLimits,
	type ModelLimits,
} from "./core.ts";

// Fallbacks used when the proxy does not report limits for a given id.
//
// /v1/models carries no limits (OpenAI schema: id/object/created/owned_by), so
// the provider asks LiteLLM's /model/info instead. That endpoint only lists
// real deployments, NOT aliases, so ids such as `qwen3.8-27b` may have no
// entry. For those we assume the backend's documented limits, which the proxy
// advertises for the underlying deployment: max_input_tokens 128000,
// max_output_tokens 8192. Undersizing maxTokens makes the model stop early and
// pi surface "Response was truncated before completion." on long answers.
export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_MAX_TOKENS = 8192;
export const ENV_API_KEY = "GD_API_KEY";
/**
 * Default model id for fresh sessions (option B self-heal). Override with
 * the GD_DEFAULT_MODEL env var; the extension validates the id against the
 * live /v1/models catalog and falls back to the first listed model.
 */
export const DEFAULT_MODEL_ID = "qwen3.8-primary";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Map a discovered model id to a Model object the pi runtime can stream. */
export function toModel(id: string, limits?: ModelLimits): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: PROVIDER_ID,
		baseUrl: BASE_URL + "/v1",
		reasoning: false,
		input: ["text"],
		cost: { ...ZERO_COST },
		contextWindow: limits?.maxInputTokens ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: limits?.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
	};
}

/**
 * Post-sign-in message shown in the login dialog right after the key is
 * accepted. Multi-line: the dialog's Text component renders \n as line
 * breaks. Invites the user to /model to pick a gd model.
 */
export const AFTER_SIGN_MESSAGE =
	"Signed in.\n" +
	"Run /model to select a gd model.";
/** How long the after-sign message stays on screen before the dialog closes. */
export const AFTER_SIGN_PAUSE_MS = 4000;

/** Sleep up to ms, resolving early when the login flow is aborted. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise<void>((resolve) => {
		if (signal?.aborted) return resolve();
		let t: ReturnType<typeof setTimeout>;
		const done = () => {
			clearTimeout(t);
			signal?.removeEventListener("abort", done);
			resolve();
		};
		t = setTimeout(done, ms);
		signal?.addEventListener("abort", done, { once: true });
	});
}

/**
 * Prompt for the API key issued after Google sign-in, pasted by the user.
 * The user signs in at https://provider.girard-davila.net/auth/google, then
 * copies the key from their dashboard and pastes it here. After the key is
 * accepted the dialog switches to a short multi-line after-sign message
 * (AFTER_SIGN_MESSAGE) inviting the user to /model.
 */
async function manualKeyLogin(interaction: AuthInteraction): Promise<ApiKeyCredential> {
	const key = (await interaction.prompt({
		type: "secret",
		message:
			"1) Sign in at https://provider.girard-davila.net/auth/google (Google).\n" +
			"2) Copy the API key from your dashboard and paste it here:",
		placeholder: "sk-...",
	})).trim();
	if (key.length === 0) throw new Error("API key is empty; login cancelled");
	interaction.notify({ type: "info", message: AFTER_SIGN_MESSAGE });
	// Keep the dialog open briefly so the message is readable before pi
	// stores the credential and closes the login screen.
	await pause(AFTER_SIGN_PAUSE_MS, interaction.signal);
	return { type: "api_key", key };
}

/**
 * Login flow for `/login gd` — API key only. The user signs in with Google
 * at https://provider.girard-davila.net/auth/google, then copies the issued
 * key from the dashboard and pastes it. No browser SSO from /login gd.
 */
export async function gdLogin(interaction: AuthInteraction): Promise<ApiKeyCredential> {
	return manualKeyLogin(interaction);
}

export interface GdProviderOptions {
	baseUrl?: string;
	discoverTimeoutMs?: number;
	authContext?: AuthContext;
}

/** Build the native `gd` provider. */
export function createGdProvider(options: GdProviderOptions = {}): Provider {
	const authContext: AuthContext | undefined = options.authContext;
	const env = async (name: string): Promise<string | undefined> => {
		if (authContext) return authContext.env(name);
		return process.env[name];
	};

	const apiKeyAuth: {
		name: string;
		login: typeof gdLogin;
		check: (input: { credential?: ApiKeyCredential }) => Promise<AuthCheck | undefined>;
		resolve: (input: { credential?: ApiKeyCredential }) => Promise<AuthResult | undefined>;
	} = {
		name: "provider.girard-davila.net API key",
		login: gdLogin,
		check: async ({ credential }) => {
			if (credential?.key) return { type: "api_key", source: "stored credential" };
			return (await env(ENV_API_KEY)) ? { type: "api_key", source: ENV_API_KEY } : undefined;
		},
		resolve: async ({ credential }: { credential?: ApiKeyCredential }) => {
			if (credential?.key) return { auth: { apiKey: credential.key }, source: "stored credential" };
			const fromEnv = await env(ENV_API_KEY);
			if (fromEnv) return { auth: { apiKey: fromEnv }, source: ENV_API_KEY };
			return undefined;
		},
	};

	const root = options.baseUrl ?? BASE_URL;
	return createProvider<"openai-completions">({
		id: PROVIDER_ID,
		name: "Girard-Davila.net provider",
		baseUrl: root,
		auth: { apiKey: apiKeyAuth },
		models: [],
		api: openAICompletionsApi(),
		async fetchModels(context) {
			const key = context.credential?.type === "api_key" ? context.credential.key : undefined;
			const discoverOptions = {
				timeoutMs: options.discoverTimeoutMs,
				signal: context.signal,
			};
			// Two independent lookups: the id list (/v1/models) and the real limits
			// (/model/info). Limits are best-effort — a failure there must not hide
			// the models, so it degrades to the documented defaults instead.
			// The id lookup is STRICT on purpose: a network/auth failure throws so
			// pi reports "model catalog could not be refreshed" instead of silently
			// publishing an empty catalog (which makes /model show nothing).
			const [ids, limits] = await Promise.all([
				fetchModelIdsChecked(root, key, discoverOptions),
				fetchModelLimits(root, key, discoverOptions),
			]);
			return ids.map((id) => toModel(id, limits[id]));
		},
	});
}
