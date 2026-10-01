/**
 * Tests for the pi-provider-gd core logic (src/core.ts).
 *
 * Run with: node --test tests/   (Node >= 24: native TS type-stripping)
 * CI: .github/workflows/ci.yml runs the same thing on every commit.
 *
 * The network boundary is stubbed by replacing globalThis.fetch, so the whole
 * suite is hermetic and fast — no real calls to api.girard-davila.net.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	BASE_URL,
	PROVIDER_ID,
	credentialKey,
	fetchModelIds,
	fetchModelLimits,
	getCredential,
	pollCliSso,
	readJson,
	startCliSso,
	storeCredential,
	verificationUrl,
	type CliSsoStart,
} from "../src/core.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

/** A fresh temp auth.json path. */
function tmpAuthPath(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-provider-gd-test-"));
	tmpDirs.push(dir);
	return path.join(dir, "auth.json");
}

function tmpFile(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-provider-gd-test-"));
	tmpDirs.push(dir);
	return path.join(dir, "data.json");
}

function restoreGlobals(): void {
	globalThis.fetch = realFetch;
}
const realFetch = globalThis.fetch;

/** Replace global fetch with a handler; returns the handler's call log. */
function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): {
	calls: Array<{ url: string; init?: RequestInit }>;
} {
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
		calls.push({ url, init });
		return await handler(url, init);
	}) as unknown as typeof fetch;
	return { calls };
}

test.afterEach(() => {
	restoreGlobals();
	for (const dir of tmpDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// readJson
// ---------------------------------------------------------------------------

test("readJson: returns {} for a missing file", () => {
	assert.deepEqual(readJson(tmpFile()), {});
});

test("readJson: returns {} for invalid JSON and arrays (defensive)", () => {
	const p = tmpFile();
	fs.writeFileSync(p, "{ not json");
	assert.deepEqual(readJson(p), {});
	fs.writeFileSync(p, "[1,2,3]");
	assert.deepEqual(readJson(p), {});
});

test("readJson: parses an object file", () => {
	const p = tmpFile();
	fs.writeFileSync(p, JSON.stringify({ a: 1 }));
	assert.deepEqual(readJson(p), { a: 1 });
});

// ---------------------------------------------------------------------------
// credential read/store (auth.json, keyed by provider id)
// ---------------------------------------------------------------------------

test("getCredential: undefined for missing auth.json / missing provider", () => {
	const p = tmpAuthPath();
	assert.equal(getCredential(p, PROVIDER_ID), undefined);
	fs.writeFileSync(p, JSON.stringify({ openrouter: { type: "api_key", key: "sk-x" } }));
	assert.equal(getCredential(p, PROVIDER_ID), undefined);
});

test("getCredential: returns the stored record and ignores non-objects", () => {
	const p = tmpAuthPath();
	fs.writeFileSync(p, JSON.stringify({
		[PROVIDER_ID]: { type: "api_key", key: "sk-abc" },
		openrouter: "not-an-object",
	}));
	assert.deepEqual(getCredential(p, PROVIDER_ID), { type: "api_key", key: "sk-abc" });
	assert.equal(getCredential(p, "openrouter"), undefined);
});

test("credentialKey: extracts key / rejects empty & non-strings", () => {
	assert.equal(credentialKey({ key: "sk-abc" }), "sk-abc");
	assert.equal(credentialKey({ key: "" }), undefined);
	assert.equal(credentialKey({ key: 42 }), undefined);
	assert.equal(credentialKey(undefined), undefined);
});

test("storeCredential: writes the provider api_key credential at 0600", () => {
	const p = tmpAuthPath();
	fs.writeFileSync(p, JSON.stringify({ openrouter: { type: "api_key", key: "sk-or" } }));
	storeCredential(p, "sk-new");
	const raw = JSON.parse(fs.readFileSync(p, "utf8"));
	assert.deepEqual(raw[PROVIDER_ID], { type: "api_key", key: "sk-new" });
	assert.equal(raw.openrouter.key, "sk-or", "other providers preserved");
	const mode = (fs.statSync(p).mode & 0o777).toString(8);
	assert.equal(mode, "600");
});

test("storeCredential: overwrites a stale credential", () => {
	const p = tmpAuthPath();
	fs.writeFileSync(p, JSON.stringify({ [PROVIDER_ID]: { type: "api_key", key: "sk-old" } }));
	storeCredential(p, "sk-new");
	const raw = JSON.parse(fs.readFileSync(p, "utf8"));
	assert.equal(raw[PROVIDER_ID].key, "sk-new");
});

// ---------------------------------------------------------------------------
// fetchModelIds
// ---------------------------------------------------------------------------

test("fetchModelIds: dedupes and filters ids from /v1/models", async () => {
	const { calls } = mockFetch(async (url) => {
		assert.equal(url, `${BASE_URL}/v1/models`);
		return new Response(JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }, { id: "m1" }, { id: "" }, { no: "id" }] }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	});
	const ids = await fetchModelIds(BASE_URL, "sk-abc");
	assert.deepEqual(ids, ["m1", "m2"]);
	const headers = calls[0].init?.headers as Record<string, string>;
	assert.equal(headers.Authorization, "Bearer sk-abc");
});

test("fetchModelIds: no key → no Authorization header", async () => {
	mockFetch(async () => new Response(JSON.stringify({ data: [{ id: "m1" }] }), { status: 200 }));
	const ids = await fetchModelIds(BASE_URL);
	assert.deepEqual(ids, ["m1"]);
});

test("fetchModelIds: honours an external abort signal", async () => {
	const { calls } = mockFetch(async () => {
		throw new Error("should have been aborted");
	});
	const controller = new AbortController();
	controller.abort();
	const ids = await fetchModelIds(BASE_URL, "sk-x", { signal: controller.signal });
	assert.deepEqual(ids, []);
	assert.equal(calls.length, 0);
});

test("fetchModelIds: returns [] on HTTP error", async () => {
	mockFetch(async () => new Response("boom", { status: 500 }));
	assert.deepEqual(await fetchModelIds(BASE_URL), []);
});

test("fetchModelIds: returns [] on unparseable body", async () => {
	mockFetch(async () => new Response("not json", { status: 200 }));
	assert.deepEqual(await fetchModelIds(BASE_URL), []);
});

test("fetchModelIds: returns [] on network failure", async () => {
	globalThis.fetch = (async () => {
		throw new Error("network down");
	}) as unknown as typeof fetch;
	assert.deepEqual(await fetchModelIds(BASE_URL), []);
});

// ---------------------------------------------------------------------------
// fetchModelLimits: real limits come from /model/info, not /v1/models
// ---------------------------------------------------------------------------

test("fetchModelLimits: reads litellm_params limits keyed by model_name", async () => {
	const { calls } = mockFetch(async (url) => {
		assert.equal(url, `${BASE_URL}/model/info`);
		return new Response(
			JSON.stringify({
				data: [
					{
						model_name: "Qwen3.8-27B-i1-IQ4_XS-GGUF-Smaller",
						litellm_params: { max_input_tokens: 128000, max_output_tokens: 8192 },
					},
				],
			}),
			{ status: 200 },
		);
	});
	const limits = await fetchModelLimits(BASE_URL, "sk-abc");
	assert.deepEqual(limits["Qwen3.8-27B-i1-IQ4_XS-GGUF-Smaller"], {
		maxInputTokens: 128000,
		maxOutputTokens: 8192,
	});
	const headers = calls[0].init?.headers as Record<string, string>;
	assert.equal(headers.Authorization, "Bearer sk-abc");
});

test("fetchModelLimits: skips null/zero/non-numeric limits (LiteLLM emits null for aliases)", async () => {
	mockFetch(
		async () =>
			new Response(
				JSON.stringify({
					data: [
						{ model_name: "alias-no-limits", litellm_params: { max_input_tokens: null, max_output_tokens: null } },
						{ model_name: "zero", litellm_params: { max_input_tokens: 0, max_output_tokens: 0 } },
						{ model_name: "strings", litellm_params: { max_input_tokens: "128000", max_output_tokens: "8192" } },
					],
				}),
				{ status: 200 },
			),
	);
	const limits = await fetchModelLimits(BASE_URL);
	assert.deepEqual(limits, {});
});

test("fetchModelLimits: returns {} on HTTP error / bad body / network failure", async () => {
	mockFetch(async () => new Response("boom", { status: 500 }));
	assert.deepEqual(await fetchModelLimits(BASE_URL), {});
	mockFetch(async () => new Response("not json", { status: 200 }));
	assert.deepEqual(await fetchModelLimits(BASE_URL), {});
	globalThis.fetch = (async () => {
		throw new Error("network down");
	}) as unknown as typeof fetch;
	assert.deepEqual(await fetchModelLimits(BASE_URL), {});
});

test("fetchModelLimits: honours an external abort signal", async () => {
	const { calls } = mockFetch(async () => {
		throw new Error("should have been aborted");
	});
	const controller = new AbortController();
	controller.abort();
	assert.deepEqual(await fetchModelLimits(BASE_URL, "sk-x", { signal: controller.signal }), {});
	assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// SSO: startCliSso
// ---------------------------------------------------------------------------

const SSO_RESPONSE: Record<string, unknown> = {
	login_id: "cli-abc123",
	poll_secret: "secret-poll",
	user_code: "ABCD-EFGH",
	expires_in: 600,
};

test("startCliSso: parses a valid /sso/cli/start response", async () => {
	const { calls } = mockFetch(async (url, init) => {
		assert.equal(url, `${BASE_URL}/sso/cli/start`);
		assert.equal(init?.method, "POST");
		return new Response(JSON.stringify(SSO_RESPONSE), { status: 200 });
	});
	const start = await startCliSso(BASE_URL);
	assert.equal(start.loginId, "cli-abc123");
	assert.equal(start.pollSecret, "secret-poll");
	assert.equal(start.userCode, "ABCD-EFGH");
	assert.equal(start.expiresInSeconds, 600);
	assert.equal(start.verificationUri, undefined);
	assert.equal(calls.length, 1);
});

test("startCliSso: keeps verification_uri_complete when provided", async () => {
	mockFetch(async () =>
		new Response(JSON.stringify({ ...SSO_RESPONSE, verification_uri_complete: "https://proxy/sso/key/generate?x=1" }), { status: 200 }));
	const start = await startCliSso(BASE_URL);
	assert.equal(start.verificationUri, "https://proxy/sso/key/generate?x=1");
});

test("startCliSso: throws on HTTP error", async () => {
	mockFetch(async () => new Response("nope", { status: 500 }));
	await assert.rejects(() => startCliSso(BASE_URL), /500/);
});

test("startCliSso: throws on malformed body (missing login_id/poll_secret)", async () => {
	mockFetch(async () => new Response(JSON.stringify({ user_code: "AB" }), { status: 200 }));
	await assert.rejects(() => startCliSso(BASE_URL), /unexpected response/);
});

test("startCliSso: wraps network failure in a descriptive error", async () => {
	globalThis.fetch = (async () => {
		throw new Error("ECONNREFUSED");
	}) as unknown as typeof fetch;
	await assert.rejects(() => startCliSso(BASE_URL), /Could not start SSO/);
});

// ---------------------------------------------------------------------------
// SSO: verificationUrl
// ---------------------------------------------------------------------------

test("verificationUrl: prefers the proxy's verification_uri_complete", () => {
	const start: CliSsoStart = { loginId: "cli-x", pollSecret: "s", userCode: "", verificationUri: "https://v.example/u", expiresInSeconds: 600 };
	assert.equal(verificationUrl(BASE_URL, start), "https://v.example/u");
});

test("verificationUrl: falls back to /sso/key/generate?source=litellm-cli&key=<login_id>", () => {
	const start: CliSsoStart = { loginId: "cli-x", pollSecret: "s", userCode: "", expiresInSeconds: 600 };
	assert.equal(
		verificationUrl(BASE_URL, start),
		`${BASE_URL}/sso/key/generate?${new URLSearchParams({ source: "litellm-cli", key: "cli-x" })}`,
	);
});

// ---------------------------------------------------------------------------
// SSO: pollCliSso
// ---------------------------------------------------------------------------

const START: CliSsoStart = { loginId: "cli-abc123", pollSecret: "secret-poll", userCode: "ABCD-EFGH", expiresInSeconds: 600 };

test("pollCliSso: polls until ready and returns the key (secret in HEADER, not query)", async () => {
	const { calls } = mockFetch(async (url, init) => {
		assert.equal(url, `${BASE_URL}/sso/cli/poll/cli-abc123`);
		const headers = init?.headers as Record<string, string>;
		assert.equal(headers["x-litellm-cli-poll-secret"], "secret-poll");
		if (calls.length < 2) return new Response(JSON.stringify({ status: "pending" }), { status: 200 });
		return new Response(JSON.stringify({ status: "ready", key: "sk-issued", user_id: "alx" }), { status: 200 });
	});
	const key = await pollCliSso(BASE_URL, START, { timeoutMs: 5000, intervalMs: 10 });
	assert.equal(key, "sk-issued");
	assert.equal(calls.length, 2);
});

test("pollCliSso: 400 (expired/invalid login) fails fast", async () => {
	mockFetch(async () => new Response("bad request", { status: 400 }));
	await assert.rejects(
		() => pollCliSso(BASE_URL, START, { timeoutMs: 5000, intervalMs: 10 }),
		/expired or is invalid/,
	);
});

test("pollCliSso: 500 is transient — keeps polling until success", async () => {
	let seen = 0;
	mockFetch(async () => {
		seen += 1;
		if (seen === 1) return new Response("boom", { status: 500 });
		return new Response(JSON.stringify({ status: "ready", key: "sk-after-500" }), { status: 200 });
	});
	const key = await pollCliSso(BASE_URL, START, { timeoutMs: 5000, intervalMs: 10 });
	assert.equal(key, "sk-after-500");
	assert.ok(seen >= 2, "must have retried after the 500");
});

test("pollCliSso: honours an external abort signal", async () => {
	const { calls } = mockFetch(async () => new Response(JSON.stringify({ status: "pending" }), { status: 200 }));
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		() => pollCliSso(BASE_URL, START, { timeoutMs: 5000, intervalMs: 10, signal: controller.signal }),
		/cancelled/,
	);
	assert.equal(calls.length, 0);
});

test("pollCliSso: times out after timeoutMs when still pending", async () => {
	mockFetch(async () => new Response(JSON.stringify({ status: "pending" }), { status: 200 }));
	const started = Date.now();
	await assert.rejects(
		() => pollCliSso(BASE_URL, START, { timeoutMs: 300, intervalMs: 20 }),
		/timed out/,
	);
	assert.ok(Date.now() - started >= 250, "should have waited for the deadline");
});

test("pollCliSso: onTick reports each attempt", async () => {
	let seen = 0;
	mockFetch(async () => {
		seen += 1;
		return seen < 2
			? new Response(JSON.stringify({ status: "pending" }), { status: 200 })
			: new Response(JSON.stringify({ status: "ready", key: "sk-k" }), { status: 200 });
	});
	const attempts: number[] = [];
	await pollCliSso(BASE_URL, START, { timeoutMs: 5000, intervalMs: 5, onTick: (n) => attempts.push(n) });
	assert.deepEqual(attempts, [1, 2]);
});
