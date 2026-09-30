/**
 * pi-provider-gd — native `gd` provider.
 *
 * Builds a self-contained pi Provider: OpenAI-compatible streaming against
 * api.girard-davila.net, dynamic model discovery from /v1/models, and SSO
 * browser login via the LiteLLM CLI-SSO endpoint. No pi-provider-litellm.
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
	fetchModelIds,
	pollCliSso,
	startCliSso,
	verificationUrl,
} from "./core.ts";

export const DEFAULT_CONTEXT_WINDOW = 32_768;
export const DEFAULT_MAX_TOKENS = 4096;
export const ENV_API_KEY = "GD_API_KEY";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Map a discovered model id to a Model object the pi runtime can stream. */
export function toModel(id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: PROVIDER_ID,
		baseUrl: BASE_URL + "/v1",
		reasoning: false,
		input: ["text"],
		cost: { ...ZERO_COST },
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
	};
}

/**
 * SSO browser login, driven through pi's standard auth interaction callbacks.
 * Returns the credential to store; pi persists it for the provider id.
 */
export async function ssoLogin(interaction: AuthInteraction): Promise<ApiKeyCredential> {
	const start = await startCliSso(BASE_URL);
	const url = verificationUrl(BASE_URL, start);

	interaction.notify({
		type: "info",
		message: `Sign in with GitHub to ${new URL(BASE_URL).hostname} in the browser.`,
		links: [{ url, label: "Open login page" }],
	});
	if (start.userCode) {
		interaction.notify({
			type: "device_code",
			userCode: start.userCode,
			verificationUri: url,
			expiresInSeconds: start.expiresInSeconds,
		});
	} else {
		interaction.notify({ type: "auth_url", url });
	}
	interaction.notify({
		type: "progress",
		message: `Waiting for the key to be issued (login expires in ${start.expiresInSeconds}s)…`,
	});

	const key = await pollCliSso(BASE_URL, start, { signal: interaction.signal });
	return { type: "api_key", key };
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
		login: typeof ssoLogin;
		check: (input: { credential?: ApiKeyCredential }) => Promise<AuthCheck | undefined>;
		resolve: (input: { credential?: ApiKeyCredential }) => Promise<AuthResult | undefined>;
	} = {
		name: "api.girard-davila.net API key",
		login: ssoLogin,
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
		name: "Girard",
		baseUrl: root,
		auth: { apiKey: apiKeyAuth },
		models: [],
		api: openAICompletionsApi(),
		async fetchModels(context) {
			const key = context.credential?.type === "api_key" ? context.credential.key : undefined;
			const ids = await fetchModelIds(root, key, {
				timeoutMs: options.discoverTimeoutMs,
				signal: context.signal,
			});
			return ids.map(toModel);
		},
	});
}
