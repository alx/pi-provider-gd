/**
 * pi-provider-gd — pure, testable core for the native `gd` provider.
 *
 * No pi imports here: plain functions over explicit paths/URLs plus
 * injectable fetch/timeout knobs so tests run hermetically. `src/provider.ts`
 * composes these into a native pi `Provider`; `extensions/index.ts` just
 * registers it.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const PROVIDER_ID = "gd";
/** LiteLLM proxy — model calls, discovery, billing. */
export const BASE_URL = "https://api.girard-davila.net/api/llm";
/** Customer gateway — the CLI device flow (org-gxn.18.5) lives here, not on the proxy. */
export const PROVIDER_URL = "https://provider.girard-davila.net";
export const SSO_ENTRY_URL = PROVIDER_URL;

export const DEFAULT_DISCOVER_TIMEOUT_MS = 8000;
export const DEFAULT_SSO_START_TIMEOUT_MS = 8000;
export const DEFAULT_SSO_POLL_TIMEOUT_MS = 590_000; // cover the full 600s server expiry (slow Google login + consent must not outlast the poll)
export const DEFAULT_SSO_POLL_INTERVAL_MS = 3000;

export type Json = Record<string, unknown>;

/** Absolute path to the agent auth store (where pi keeps per-provider credentials). */
export function defaultAuthPath(): string {
	return path.join(os.homedir(), ".pi", "agent", "auth.json");
}

export function readJson(file: string): Json {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Json)
			: {};
	} catch {
		return {};
	}
}

/** The credential pi stores for the `gd` provider (one entry per provider id). */
export function getCredential(authPath: string, providerId: string): Json | undefined {
	const auth = readJson(authPath);
	const cred: unknown = auth[providerId];
	if (cred === null || typeof cred !== "object" || Array.isArray(cred)) return undefined;
	return cred as Json;
}

export function credentialKey(cred: Json | undefined): string | undefined {
	return cred && typeof cred.key === "string" && cred.key.length > 0 ? cred.key : undefined;
}

/**
 * Store the SSO-issued key in the agent auth store under the `gd` provider id.
 * Preserves other providers' entries; mode 0600.
 */
export function storeCredential(authPath: string, key: string, providerId: string = PROVIDER_ID): void {
	const auth = readJson(authPath);
	auth[providerId] = { type: "api_key", key };
	try {
		fs.mkdirSync(path.dirname(authPath), { recursive: true });
	} catch {
		/* best effort */
	}
	fs.writeFileSync(authPath, JSON.stringify(auth, null, 2) + "\n", { mode: 0o600 });
	try {
		fs.chmodSync(authPath, 0o600);
	} catch {
		/* best effort */
	}
}

/**
 * Fetch model ids from an OpenAI-compatible /v1/models endpoint.
 *
 * Throws a descriptive error on network failure or a non-OK response, so
 * callers can distinguish "the proxy lists no models" (200 + empty) from
 * "we could not reach the proxy" (which must surface, not hide). Returns
 * the unique id list on HTTP success (possibly empty).
 */
export async function fetchModelIdsChecked(
	baseUrl: string = BASE_URL,
	apiKey?: string,
	options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<string[]> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_DISCOVER_TIMEOUT_MS;
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	if (options.signal) {
		if (options.signal.aborted) throw new Error("model discovery aborted");
		options.signal.addEventListener("abort", onAbort, { once: true });
	}
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const headers: Record<string, string> = { Accept: "application/json" };
		if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
		let res: Response;
		try {
			res = await fetch(baseUrl + "/v1/models", { headers, signal: controller.signal });
		} catch (e) {
			throw new Error(
				`model discovery request failed for ${baseUrl}/v1/models (${describeFetchError(e)}); check network connectivity to the proxy — run /gd-doctor in pi for diagnosis and contact info`,
			);
		}
		if (!res.ok) {
			throw new Error(
				`model discovery rejected by proxy (HTTP ${res.status}); check the API key — run /gd-doctor in pi for diagnosis and contact info`,
			);
		}
		const body = (await res.json().catch(() => undefined)) as { data?: Array<{ id?: unknown }> } | undefined;
		const ids = Array.isArray(body?.data)
			? body.data.map((m) => m.id).filter((id): id is string => typeof id === "string" && id.length > 0)
			: [];
		return [...new Set(ids)];
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
	}
}

/**
 * Flatten a fetch failure into a single-line description, unwrapping the
 * undici `cause` chain (and AggregateError `errors`) so the real network
 * error (ENOTFOUND, ECONNREFUSED, UND_ERR_CONNECT_TIMEOUT, …) is visible
 * instead of the bare "fetch failed".
 */
function describeFetchError(e: unknown, depth = 0): string {
	if (depth > 4) return "…";
	if (e instanceof Error) {
		const errors = (e as { errors?: unknown[] }).errors;
		if (Array.isArray(errors) && errors.length > 0) {
			return errors.map((err) => describeFetchError(err, depth + 1)).join(" | ");
		}
		const code = (e as { code?: unknown }).code;
		const head = code ? `${e.message} [${String(code)}]` : e.message;
		const cause = (e as { cause?: unknown }).cause;
		return cause ? `${head}; cause: ${describeFetchError(cause, depth + 1)}` : head;
	}
	return String(e);
}

/** Fetch model ids from an OpenAI-compatible /v1/models endpoint. [] on any failure. */
export async function fetchModelIds(
	baseUrl: string = BASE_URL,
	apiKey?: string,
	options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<string[]> {
	try {
		return await fetchModelIdsChecked(baseUrl, apiKey, options);
	} catch {
		return [];
	}
}

export interface ModelLimits {
	maxInputTokens?: number;
	maxOutputTokens?: number;
}

/**
 * Reject non-positive / non-integer limit values that LiteLLM sometimes emits
 * (it reports `null` for aliases that lack a backing deployment).
 */
function positiveInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/**
 * Fetch per-model context/output limits from LiteLLM's `/model/info` endpoint.
 *
 * The OpenAI-compatible `/v1/models` payload only carries id/object/created/
 * owned_by, so a client cannot learn the real window from it. LiteLLM exposes
 * the authoritative numbers under `litellm_params.max_input_tokens` and
 * `litellm_params.max_output_tokens`. Keys are the deployment `model_name`
 * (which is also a callable `model` id). Aliases without their own deployment
 * are absent — callers should fall back to documented defaults. Returns {} on
 * any failure so discovery never blocks the provider from loading.
 */
export async function fetchModelLimits(
	baseUrl: string = BASE_URL,
	apiKey?: string,
	options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Record<string, ModelLimits>> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_DISCOVER_TIMEOUT_MS;
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	if (options.signal) {
		if (options.signal.aborted) return {};
		options.signal.addEventListener("abort", onAbort, { once: true });
	}
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const headers: Record<string, string> = { Accept: "application/json" };
		if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
		const res = await fetch(baseUrl + "/model/info", { headers, signal: controller.signal });
		if (!res.ok) return {};
		const body = (await res.json()) as {
			data?: Array<{ model_name?: unknown; litellm_params?: Record<string, unknown> }>;
		};
		const out: Record<string, ModelLimits> = {};
		for (const entry of Array.isArray(body.data) ? body.data : []) {
			const name = entry?.model_name;
			if (typeof name !== "string" || name.length === 0) continue;
			const params = entry.litellm_params ?? {};
			const maxInputTokens = positiveInt(params.max_input_tokens);
			const maxOutputTokens = positiveInt(params.max_output_tokens);
			if (maxInputTokens === undefined && maxOutputTokens === undefined) continue;
			out[name] = { maxInputTokens, maxOutputTokens };
		}
		return out;
	} catch {
		return {};
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
	}
}

export interface CliSsoStart {
	loginId: string;
	pollSecret: string;
	userCode: string;
	verificationUri?: string;
	expiresInSeconds: number;
}

/** POST /api/cli/start — opens the CLI device flow on the customer gateway (anonymous). */
export async function startCliSso(
	baseUrl: string = PROVIDER_URL,
	timeoutMs: number = DEFAULT_SSO_START_TIMEOUT_MS,
): Promise<CliSsoStart> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(baseUrl + "/api/cli/start", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "{}",
			signal: controller.signal,
		});
		if (res.status === 429) throw new Error("too many CLI login attempts from this address; wait an hour");
		if (!res.ok) throw new Error(`/api/cli/start failed (HTTP ${res.status})`);
		const data = (await res.json()) as {
			login_id?: unknown;
			poll_secret?: unknown;
			user_code?: unknown;
			verification_uri_complete?: unknown;
			expires_in?: unknown;
		};
		if (
			typeof data.login_id !== "string" ||
			data.login_id.length === 0 ||
			typeof data.poll_secret !== "string" ||
			data.poll_secret.length === 0
		) {
			throw new Error("/api/cli/start returned an unexpected response");
		}
		return {
			loginId: data.login_id,
			pollSecret: data.poll_secret,
			userCode: typeof data.user_code === "string" ? data.user_code : "",
			verificationUri:
				typeof data.verification_uri_complete === "string" &&
				data.verification_uri_complete.length > 0
					? data.verification_uri_complete
					: undefined,
			expiresInSeconds: typeof data.expires_in === "number" ? data.expires_in : 600,
		};
	} catch (e) {
		if (e instanceof Error && /api\/cli\/start|too many CLI login/.test(e.message)) throw e;
		throw new Error(`Could not start SSO against ${baseUrl}: ${e instanceof Error ? e.message : String(e)}`);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * The browser URL for the SSO login. The gateway always provides a complete
 * verification URI (login_id + user_code pre-filled); fall back to the bare
 * /verify path only if it is missing.
 */
export function verificationUrl(baseUrl: string, start: CliSsoStart): string {
	if (start.verificationUri) return start.verificationUri;
	const params = new URLSearchParams({ login_id: start.loginId });
	if (start.userCode) params.set("user_code", start.userCode);
	return `${baseUrl}/verify?${params}`;
}

export interface PollCliSsoOptions {
	timeoutMs?: number;
	intervalMs?: number;
	onTick?: (attempt: number) => void;
	signal?: AbortSignal;
}

/**
 * Poll GET /api/cli/poll/{login_id} on the customer gateway until the issued
 * key arrives. The poll secret goes in the `poll-secret` HEADER. Transient
 * network errors keep polling until the deadline; expiry/secret/server errors
 * are thrown immediately.
 */
export async function pollCliSso(
	baseUrl: string,
	start: CliSsoStart,
	options: PollCliSsoOptions = {},
): Promise<string> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_SSO_POLL_TIMEOUT_MS;
	const intervalMs = options.intervalMs ?? DEFAULT_SSO_POLL_INTERVAL_MS;
	const deadline = Date.now() + timeoutMs;
	let attempt = 0;
	while (Date.now() < deadline) {
		if (options.signal?.aborted) throw new Error("SSO login cancelled");
		attempt += 1;
		options.onTick?.(attempt);
		let data: { status?: unknown; key?: unknown; error?: unknown; customer?: unknown };
		try {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 8000);
			const res = await fetch(`${baseUrl}/api/cli/poll/${encodeURIComponent(start.loginId)}`, {
				headers: { "poll-secret": start.pollSecret },
				signal: controller.signal,
			});
			clearTimeout(timer);
			if (res.status === 404) throw new Error("SSO login expired; re-run the flow");
			if (res.status === 403) throw new Error("SSO polling secret rejected; re-run the flow");
			if (!res.ok) throw new Error(`SSO polling failed (HTTP ${res.status})`);
			data = (await res.json()) as typeof data;
		} catch (e) {
			if (e instanceof Error && /expired; re-run|secret rejected|login cancelled/.test(e.message)) throw e;
			// transient network/parse error: keep polling until the deadline
			await new Promise((resolve) => setTimeout(resolve, intervalMs));
			continue;
		}
		if (data.status === "success") {
			const key = typeof data.key === "string" ? data.key : "";
			if (key.length > 0) return key;
			throw new Error("SSO login succeeded but returned no key; re-run the flow");
		}
		if (data.status === "error") {
			throw new Error(`SSO login failed: ${typeof data.error === "string" ? data.error : "unknown error"}`);
		}
		// pending -> keep waiting for the browser half to finish
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	throw new Error(`SSO login timed out after ${Math.round(timeoutMs / 1000)}s`);
}
