/**
 * Tests for the gd VAST GPU deployment logic (src/gpu.ts).
 *
 * Run with: node --test tests/   (Node >= 24: native TS type-stripping)
 * Network boundary stubbed via globalThis.fetch — hermetic, no VAST calls.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
	decideBalance,
	decideReuse,
	fetchGdAccount,
	fetchRunningInstances,
	parseEnvFile,
	minBalanceFloor,
	roundCents,
	GPU_MODEL_ID,
	ENV_MIN_BALANCE,
} from "../src/gpu.ts";

test("decideBalance: balance and credit are SEPARATE fields and both count", () => {
	// The 2026-10-11 marker run: balance $0.00 but $8.40 signup credit — paying.
	const ok = decideBalance(0, 8.4, 1);
	assert.equal(ok.ok, true);
	assert.equal(ok.total, 8.4);

	// Sum crosses the floor from both sides.
	assert.equal(decideBalance(0.5, 0.6, 1).ok, true);
	assert.equal(decideBalance(0.4, 0.5, 1).ok, false);
});

test("decideBalance: below floor gives a human-readable reason", () => {
	const d = decideBalance(0, 0.2, 1);
	assert.equal(d.ok, false);
	assert.match(d.reason, /below the \$1\.00 floor/);
	assert.match(d.reason, /credit/);
});

test("decideReuse: no running instances → none", () => {
	assert.deepEqual(decideReuse([], null), { kind: "none" });
});

test("decideReuse: running instance + matching state → reuse (idempotent)", () => {
	const running = [{ id: 55443055, state: "running", dph: 0.23 }];
	const state = { instance_id: 55443055, api_base: "1.2.3.4:50624", model: "qwen3.8" };
	const d = decideReuse(running, state);
	assert.equal(d.kind, "reuse");
	if (d.kind === "reuse") assert.equal(d.instance.id, 55443055);
});

test("decideReuse: running instance without state → conflict (manual launch)", () => {
	const d = decideReuse([{ id: 7, state: "running" }], null);
	assert.equal(d.kind, "conflict");
	if (d.kind === "conflict") assert.match(d.reason, /teardown-gpu/);
});

test("parseEnvFile: KEY=VALUE with comments and blanks; no shell expansion", () => {
	const env = parseEnvFile("# c\n\nVAST_API_KEY=abc123\nOTHER = spaced \n# VAST_API_KEY=commented\n");
	assert.equal(env["VAST_API_KEY"], "abc123");
	assert.equal(env["OTHER"], "spaced");
	assert.equal(Object.keys(env).length, 2);
});

test("minBalanceFloor: default 1.00, env override, garbage → default", () => {
	const saved = process.env[ENV_MIN_BALANCE];
	try {
		delete process.env[ENV_MIN_BALANCE];
		assert.equal(minBalanceFloor(), 1);
		process.env[ENV_MIN_BALANCE] = "2.5";
		assert.equal(minBalanceFloor(), 2.5);
		process.env[ENV_MIN_BALANCE] = "garbage";
		assert.equal(minBalanceFloor(), 1);
	} finally {
		if (saved === undefined) delete process.env[ENV_MIN_BALANCE];
		else process.env[ENV_MIN_BALANCE] = saved;
	}
});

test("roundCents: money math stays sane", () => {
	assert.equal(roundCents(8.21860507824), 8.22);
	assert.equal(roundCents(0.1 + 0.2), 0.3);
});

test("fetchGdAccount: reads balance + credit from /users/current", async () => {
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		assert.match(String(input), /\/users\/current$/);
		return new Response(JSON.stringify({ balance: 0, credit: 8.4, can_pay: true }), {
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
	try {
		const acct = await fetchGdAccount("/nonexistent", "key");
		assert.deepEqual(acct, { balance: 0, credit: 8.4 });
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("fetchGdAccount: API error surfaces the detail", async () => {
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(JSON.stringify({ detail: "invalid API key" }), { status: 401, headers: { "content-type": "application/json" } })) as typeof fetch;
	try {
		await assert.rejects(fetchGdAccount("/nonexistent", "bad"), /invalid API key/);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("fetchRunningInstances: v1 endpoint, only cur_state=running rows come back", async () => {
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		assert.match(String(input), /\/api\/v1\/instances\//);
		return new Response(
			JSON.stringify({
				success: true,
				instances: [
					{ id: 1, cur_state: "running", dph_total: 0.23 },
					{ id: 2, cur_state: "assigned", dph_total: 0.5 },
				],
			}),
			{ headers: { "content-type": "application/json" } },
		);}) as typeof fetch;
	try {
		const rows = await fetchRunningInstances("key");
		assert.deepEqual(rows, [{ id: 1, state: "running", dph: 0.23 }]);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("GPU_MODEL_ID is the group that carries the -vast overflow row", () => {
	assert.equal(GPU_MODEL_ID, "qwen3.8-primary");
});

import { parseGpuOnArgs } from "../src/gpu.ts";

test("parseGpuOnArgs: empty → defaults", () => {
	assert.deepEqual(parseGpuOnArgs(""), { homeOk: false });
});

test("parseGpuOnArgs: --price + --home-ok", () => {
	const r = parseGpuOnArgs("--price 0.25 --home-ok");
	assert.equal(r.maxPrice, 0.25);
	assert.equal(r.homeOk, true);
	assert.equal(r.error, undefined);
});

test("parseGpuOnArgs: bad price → error", () => {
	assert.ok(parseGpuOnArgs("--price abc").error);
	assert.ok(parseGpuOnArgs("--price -1").error);
	assert.ok(parseGpuOnArgs("--price").error);
});

test("parseGpuOnArgs: unknown flag → error", () => {
	assert.ok(parseGpuOnArgs("--bogus").error);
});

test("parseGpuOnArgs: bare token = model id (org-or6b.8)", () => {
	// bare positionals are model ids, validated by launch.py (exit 2, no
	// billing) — a typo'd model surfaces launch.py's 'unknown model' error.
	const a = parseGpuOnArgs("llama8");
	assert.equal(a.model, "llama8");
	assert.equal(a.error, undefined);
	const b = parseGpuOnArgs("qwen3.8");
	assert.equal(b.model, "qwen3.8");
	const c = parseGpuOnArgs("premium llama8");
	assert.equal(c.tier, "premium");
	assert.equal(c.model, "llama8");
	const d = parseGpuOnArgs("standard llama8 --price 0.4");
	assert.equal(d.tier, "standard");
	assert.equal(d.model, "llama8");
	assert.equal(d.maxPrice, 0.4);
	assert.ok(parseGpuOnArgs("llama8 qwen3.8").error); // two models
	assert.ok(parseGpuOnArgs("llama8 --model qwen3.8").error); // model twice
	const e = parseGpuOnArgs("--model llama8");
	assert.equal(e.model, "llama8");
	assert.ok(parseGpuOnArgs("--model").error);
});

test("parseGpuOnArgs: tier token", () => {
	assert.deepEqual(parseGpuOnArgs("premium"), { homeOk: false, tier: "premium" });
	assert.deepEqual(parseGpuOnArgs("standard --price 1"), { homeOk: false, tier: "standard", maxPrice: 1 });
	assert.ok(parseGpuOnArgs("premium standard").error);
});
