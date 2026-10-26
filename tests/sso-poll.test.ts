import assert from "node:assert/strict";
import test from "node:test";
import { pollCliSso, verificationUrl, type CliSsoStart } from "../src/core.ts";

function start(): CliSsoStart {
	return {
		loginId: "cli-test",
		pollSecret: "secret",
		userCode: "AAAA-BBBB",
		verificationUri: "https://provider.girard-davila.net/verify?login_id=cli-test&user_code=AAAA-BBBB",
		expiresInSeconds: 600,
	};
}

const json = (o: unknown) =>
	new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });

test("pollCliSso: pending -> success returns the issued key", async () => {
	const realFetch = globalThis.fetch;
	const seen: { url: string; secret?: string }[] = [];
	let calls = 0;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		seen.push({ url, secret: (init?.headers as Record<string, string>)?.["poll-secret"] });
		calls += 1;
		if (calls < 3) return json({ status: "pending", error: null, user_code: "AAAA-BBBB" });
		return json({ status: "success", customer: "sub-1", key: "sk-issued" });
	}) as typeof fetch;
	try {
		const key = await pollCliSso("https://provider.girard-davila.net", start(), {
			intervalMs: 1,
			timeoutMs: 5000,
		});
		assert.equal(key, "sk-issued");
		assert.equal(calls, 3, "two pendings then success");
		for (const s of seen) {
			assert.ok(s.url.endsWith("/api/cli/poll/cli-test"), "polls /api/cli/poll/{login_id}");
			assert.equal(s.secret, "secret", "poll secret in the poll-secret header");
		}
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("pollCliSso: error status throws with the server message", async () => {
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async () =>
		json({ status: "error", error: "session expired" })) as typeof fetch;
	try {
		await assert.rejects(
			() => pollCliSso("https://provider.girard-davila.net", start(), { intervalMs: 1, timeoutMs: 5000 }),
			/SSO login failed: session expired/,
		);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("pollCliSso: 404 -> expired, 403 -> secret rejected (thrown immediately)", async () => {
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async () => new Response("no", { status: 404 })) as typeof fetch;
	await assert.rejects(
		() => pollCliSso("https://provider.girard-davila.net", start(), { intervalMs: 1, timeoutMs: 5000 }),
		/expired/,
	);
	globalThis.fetch = (async () => new Response("no", { status: 403 })) as typeof fetch;
	await assert.rejects(
		() => pollCliSso("https://provider.girard-davila.net", start(), { intervalMs: 1, timeoutMs: 5000 }),
		/secret rejected/,
	);
	globalThis.fetch = realFetch;
});

test("pollCliSso: transient network errors keep polling until success", async () => {
	const realFetch = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = (async () => {
		calls += 1;
		if (calls === 1) throw new TypeError("fetch failed");
		return json({ status: "success", key: "sk-after-blip" });
	}) as typeof fetch;
	try {
		const key = await pollCliSso("https://provider.girard-davila.net", start(), {
			intervalMs: 1,
			timeoutMs: 5000,
		});
		assert.equal(key, "sk-after-blip");
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("pollCliSso: aborted signal cancels the wait", async () => {
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async () => json({ status: "pending" })) as typeof fetch;
	const ac = new AbortController();
	const p = pollCliSso("https://provider.girard-davila.net", start(), {
		intervalMs: 1,
		timeoutMs: 5000,
		signal: ac.signal,
	});
	setTimeout(() => ac.abort(), 10);
	await assert.rejects(p, /cancelled/);
	globalThis.fetch = realFetch;
});

test("verificationUrl: prefers the gateway's complete URI, falls back to /verify", () => {
	const s = start();
	assert.equal(verificationUrl("https://provider.girard-davila.net", s), s.verificationUri);
	const bare = verificationUrl("https://provider.girard-davila.net", { ...s, verificationUri: undefined });
	assert.equal(
		bare,
		"https://provider.girard-davila.net/verify?login_id=cli-test&user_code=AAAA-BBBB",
	);
});
