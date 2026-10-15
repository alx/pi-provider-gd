import assert from "node:assert/strict";
import test from "node:test";
import { BURN_TIME_HOURS, DEFAULT_DAY_HOURS, collectGdStatus, computeBurnAlerts, dayHours, formatGdStatus, parseUtcZ, readFooterKeys, readGdKey } from "../src/gpu-status.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("formatGdStatus: available = budget - spend", () => {
	assert.equal(formatGdStatus({ money: { budget: 10, spend: 1.78 } }), "8.22€");
});

test("formatGdStatus: no budget → grey -spend", () => {
	const out = formatGdStatus({ money: { budget: null, spend: 0.5 } });
	assert.ok(out.includes("-0.50€"), out);
	assert.ok(out.includes("\x1b[38;5;245m"), "expected grey");
});

test("formatGdStatus: gpus → one ● each + summed burn", () => {
	const out = formatGdStatus({ gpus: [{ dph: 0.23, state: "ready" }, { dph: 0.45, state: "starting" }] });
	assert.equal((out.match(/●/g) ?? []).length, 2, out);
	assert.ok(out.includes("0.68€/h"), out);
	assert.ok(out.includes("\x1b[32m"), "ready = green");
	assert.ok(out.includes("\x1b[38;5;245m"), "starting = grey");
});

test("formatGdStatus: apiError → red !", () => {
	const out = formatGdStatus({ apiError: "boom" });
	assert.ok(out.includes("\x1b[31m!\x1b[0m"), out);
});

test("formatGdStatus: apiError with gpus appends ! after burn", () => {
	const out = formatGdStatus({ gpus: [{ dph: 0.2, state: "ready" }], apiError: "boom" });
	assert.ok(out.endsWith("\x1b[31m!\x1b[0m"), out);
});

test("formatGdStatus: low budget (<10%) → red", () => {
	const out = formatGdStatus({ money: { budget: 10, spend: 9.5 } });
	assert.ok(out.includes("\x1b[31m0.50€\x1b[0m"), out);
});

test("readGdKey: reads gd key from auth store", () => {
	const f = path.join(os.tmpdir(), `gd-auth-${Date.now()}.json`);
	fs.writeFileSync(f, JSON.stringify({ gd: { type: "api_key", key: "sk-test" } }));
	assert.equal(readGdKey(f), "sk-test");
	fs.writeFileSync(f, JSON.stringify({}));
	assert.equal(readGdKey(f), null);
	fs.rmSync(f);
});

test("readFooterKeys: parses ops + vast keys from config.env", () => {
	const f = path.join(os.tmpdir(), `gd-env-${Date.now()}`);
	fs.writeFileSync(f, "# comment\nVAST_API_KEY=vk_abc\nLITELLM_OPS_KEY=lk_123\n");
	assert.deepEqual(readFooterKeys(f), { opsKey: "lk_123", vastKey: "vk_abc" });
	fs.rmSync(f);
	assert.deepEqual(readFooterKeys(path.join(os.tmpdir(), "definitely-missing-gd-env")), { opsKey: null, vastKey: null });
});

test("collectGdStatus: maps state instance_id → ready, others starting", async () => {
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const s = String(input);
		if (s.includes("/key/info")) {
			return new Response(JSON.stringify({ info: { key_alias: "pi-relax", max_budget: 5, spend: 1.25 } }), { headers: { "content-type": "application/json" } });
		}
		if (s.includes("/users/current")) {
			return new Response(JSON.stringify({ balance: 2.5, credit: 2.68 }), { headers: { "content-type": "application/json" } });
		}
		if (s.includes("/instances/")) {
			return new Response(JSON.stringify({ success: true, instances: [{ id: 11, cur_state: "running", dph_total: 0.3 }, { id: 12, cur_state: "running", dph_total: 0.4 }] }), { headers: { "content-type": "application/json" } });
		}
		throw new Error("unexpected url " + s);
	}) as typeof fetch;
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "gd-state-"));
	const home = path.join(stateDir, "vast");
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(path.join(home, "state"), { recursive: true });
	// org-or6b.19: state carries the burn-alert inputs (rate + launch time)
	fs.writeFileSync(path.join(home, "state", "current.json"), JSON.stringify({ instance_id: 11, hourly_rate: 0.25, launched_at: "2026-10-13T08:38:30Z" }));
	try {
		const data = await collectGdStatus({
			opsKey: "lk",
			gdKey: "sk",
			vastKey: "vk",
			stateHome: home,
		});
		assert.deepEqual(data.money, { budget: 5, spend: 1.25 });
		const launched = Date.parse("2026-10-13T08:38:30Z");
		assert.deepEqual(data.gpus, [
			{ dph: 0.3, state: "ready", hourlyRate: 0.25, launchedAt: launched },
			{ dph: 0.4, state: "starting", hourlyRate: 0.4, launchedAt: undefined },
		]);
		assert.equal(data.vastUsd, 5.18);
		assert.equal(data.apiError, null);
	} finally {
		globalThis.fetch = realFetch;
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// Burn alerts (org-or6b.19): computeBurnAlerts + footer rendering
// ---------------------------------------------------------------------------

const NOW = Date.parse("2026-10-13T12:00:00Z");
const HOUR = 3.6e6;

function timeInput(hoursAgo: number): Parameters<typeof computeBurnAlerts>[0] {
	return { gpus: [{ dph: 0.68, state: "ready", hourlyRate: 0.68, launchedAt: NOW - hoursAgo * HOUR }] };
}

test("burn alerts: nothing → none", () => {
	assert.deepEqual(computeBurnAlerts({}, NOW, 8), []);
	assert.deepEqual(computeBurnAlerts({ gpus: [] }, NOW, 8), []);
});

test("burn alerts: TIME fires at >= BURN_TIME_HOURS, holds below", () => {
	assert.equal(BURN_TIME_HOURS, 3);
	assert.deepEqual(computeBurnAlerts(timeInput(BURN_TIME_HOURS - 0.1), NOW, 8), []);
	const at3 = computeBurnAlerts(timeInput(BURN_TIME_HOURS), NOW, 8);
	assert.equal(at3.length, 1, JSON.stringify(at3));
	assert.equal(at3[0].kind, "time");
	assert.ok(Math.abs(at3[0].value - BURN_TIME_HOURS) < 1e-9);
	assert.ok(at3[0].detail.includes("3.0h"), at3[0].detail);
	const at4 = computeBurnAlerts(timeInput(4), NOW, 8);
	assert.equal(at4.length, 1);
	assert.equal(at4[0].kind, "time");
	assert.ok(Math.abs(at4[0].value - 4) < 1e-9);
});

test("burn alerts: RUNWAY fires when VAST money < 1 day of work", () => {
	// burn 0.68/h x 8h day = $5.44/day; $5.00 left = 0.92 day → alert
	const in1 = { gpus: [{ dph: 0.68, state: "ready" as const }], vastUsd: 5.0 };
	const a = computeBurnAlerts(in1, NOW, 8);
	assert.equal(a.length, 1, JSON.stringify(a));
	assert.equal(a[0].kind, "runway");
	assert.ok(Math.abs(a[0].value - 5.0 / (0.68 * 8)) < 1e-9);
	// plenty left → no alert
	assert.deepEqual(computeBurnAlerts({ ...in1, vastUsd: 50 }, NOW, 8), []);
});

test("burn alerts: RUNWAY guards (no money data / zero burn)", () => {
	// null/undefined vastUsd = unknown → never guess
	assert.deepEqual(computeBurnAlerts({ gpus: [{ dph: 0.68, state: "ready" as const }], vastUsd: null }, NOW, 8), []);
	assert.deepEqual(computeBurnAlerts({ gpus: [{ dph: 0.68, state: "ready" as const }] }, NOW, 8), []);
	// zero burn (no gpus) → division guard
	assert.deepEqual(computeBurnAlerts({ vastUsd: 0.1 }, NOW, 8), []);
});

test("burn alerts: both thresholds can fire together", () => {
	const a = computeBurnAlerts(timeInput(5), NOW, 8);
	const in2 = { ...timeInput(5), vastUsd: 1.0 };
	const both = computeBurnAlerts(in2, NOW, 8);
	assert.equal(a.length, 1);
	assert.equal(both.length, 2, JSON.stringify(both));
	assert.deepEqual(both.map((x) => x.kind).sort(), ["runway", "time"]);
});

test("formatGdStatus: alerts → red burn + ⏱/⚠ cluster", () => {
	const out = formatGdStatus(timeInput(4), { nowMs: NOW, dayHours: 8 });
	assert.ok(out.includes("\x1b[31m"), "expected red")
	assert.ok(out.includes("⏱4.0h"), out);
	assert.ok(!out.includes("⚠"), out);
	const runway = formatGdStatus({ gpus: [{ dph: 0.68, state: "ready" }], vastUsd: 1.0 }, { nowMs: NOW, dayHours: 8 });
	assert.ok(runway.includes("⚠"), runway);
	// 1.0 / (0.68*8) day = 0.184 day = 1.5h of work
	assert.ok(runway.includes("⚠1.5h"), runway);
	// no alert inputs → plain rendering (backwards compatible)
	const clean = formatGdStatus({ gpus: [{ dph: 0.68, state: "ready" }] }, { nowMs: NOW, dayHours: 8 });
	assert.ok(!clean.includes("⏱") && !clean.includes("⚠"), clean);
	assert.ok(!clean.includes("\x1b[31m"), clean);
});

test("burn alerts: CREDIT fires when token budget low or exhausted (org-wfx.4)", () => {
	// spend >= budget → remaining <= 0 → alert, /gd-pay hint
	const out = computeBurnAlerts({ money: { budget: 1.11, spend: 1.11 } }, NOW, 8);
	assert.equal(out.length, 1, JSON.stringify(out));
	assert.equal(out[0].kind, "credit");
	assert.ok(Math.abs(out[0].value) < 1e-9);
	assert.ok(out[0].detail.includes("/gd-pay"), out[0].detail);
	// just under the 0.02€ threshold: 1.00 - 0.99 = 0.01 → alert
	const low = computeBurnAlerts({ money: { budget: 1, spend: 0.99 } }, NOW, 8);
	assert.equal(low.length, 1, JSON.stringify(low));
	assert.equal(low[0].kind, "credit");
	// comfortably above → none
	assert.deepEqual(computeBurnAlerts({ money: { budget: 1, spend: 0.5 } }, NOW, 8), []);
	// no budget set → credit concept doesn't apply
	assert.deepEqual(computeBurnAlerts({ money: { budget: null, spend: 9 } }, NOW, 8), []);
	// no money data → none
	assert.deepEqual(computeBurnAlerts({}, NOW, 8), []);
});

test("formatGdStatus: credit alert renders red ⚠x.xx€ even with no GPUs (org-wfx.4)", () => {
	// 1.11 - 1.10 = 0.01 < 0.02 → money part red 0.01€ + credit marker
	const out = formatGdStatus({ money: { budget: 1.11, spend: 1.1 } }, { nowMs: NOW, dayHours: 8 });
	assert.ok(out.includes("⚠0.01€"), out);
	assert.ok(out.includes("\x1b[31m"), "expected red");
	// coexists with the GPU burn cluster
	const withGpu = formatGdStatus(
		{ money: { budget: 0.5, spend: 0.5 }, gpus: [{ dph: 0.68, state: "ready" }] },
		{ nowMs: NOW, dayHours: 8 },
	);
	assert.ok(withGpu.includes("⚠0.00€"), withGpu);
	// healthy budget → no credit marker
	const ok = formatGdStatus({ money: { budget: 10, spend: 1 } }, { nowMs: NOW, dayHours: 8 });
	assert.ok(!ok.includes("⚠"), ok);
});

test("dayHours(): default 8, env override, junk falls back", () => {
	const saved = process.env.GD_DAY_HOURS;
	try {
		delete process.env.GD_DAY_HOURS;
		assert.equal(dayHours(), DEFAULT_DAY_HOURS);
		process.env.GD_DAY_HOURS = "12";
		assert.equal(dayHours(), 12);
		process.env.GD_DAY_HOURS = "junk";
		assert.equal(dayHours(), DEFAULT_DAY_HOURS);
		process.env.GD_DAY_HOURS = "0";
		assert.equal(dayHours(), DEFAULT_DAY_HOURS);
	} finally {
		if (saved === undefined) delete process.env.GD_DAY_HOURS;
		else process.env.GD_DAY_HOURS = saved;
	}
});

test("parseUtcZ(): launch.py timestamps → epoch ms, junk → undefined", () => {
	assert.equal(parseUtcZ("2026-10-13T08:38:30Z"), Date.parse("2026-10-13T08:38:30Z"));
	assert.equal(parseUtcZ(undefined), undefined);
	assert.equal(parseUtcZ("not-a-time"), undefined);
});

// ---- Readiness colors (org-or6b.22): waiting/starting/ready/error ----

async function fakeGdStatus(home: string, instances: Array<{ id: number; dph: number }>) {
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const s = String(input);
		if (s.includes("/instances/")) {
			return new Response(JSON.stringify({ success: true, instances: instances.map((i) => ({ id: i.id, cur_state: "running", dph_total: i.dph })) }), { headers: { "content-type": "application/json" } });
		}
		if (s.includes("/users/current")) {
			return new Response(JSON.stringify({ balance: 1, credit: 1 }), { headers: { "content-type": "application/json" } });
		}
		throw new Error("unexpected url " + s);
	}) as typeof fetch;
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "gd-state-"));
	const vastHome = path.join(stateDir, "vast");
	fs.mkdirSync(path.join(vastHome, "state"), { recursive: true });
	try {
		await fs.writeFileSync(path.join(vastHome, "state", "x"), ""); // ensure dir exists
	} catch { /* noop */ }
	return { realFetch, stateDir, vastHome };
}

test("formatGdStatus: waiting → yellow, error → red", () => {
	const out = formatGdStatus({ gpus: [
		{ dph: 0, state: "waiting" },
		{ dph: 0.3, state: "error", error: "no DC offers" },
	] });
	assert.ok(out.includes("\x1b[33m"), "waiting should be yellow");
	assert.ok(out.includes("\x1b[31m"), "error should be red");
});

test("collectGdStatus: fresh launching marker + no instance → waiting dot", async () => {
	const { realFetch, stateDir, vastHome } = await fakeGdStatus("", []);
	fs.writeFileSync(path.join(vastHome, "state", "launching.json"), JSON.stringify({ model: "qwen3.8", tier: "standard", started_at: "2026-10-13T09:00:00Z" }));
	try {
		const t = Date.parse("2026-10-13T09:05:00Z"); // 5 min later
		const data = await collectGdStatus({ vastKey: "vk", stateHome: vastHome, nowMs: t });
		assert.deepEqual(data.gpus, [{ dph: 0, state: "waiting" }]);
	} finally {
		globalThis.fetch = realFetch;
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});

test("collectGdStatus: stale launching marker → no dot", async () => {
	const { realFetch, stateDir, vastHome } = await fakeGdStatus("", []);
	fs.writeFileSync(path.join(vastHome, "state", "launching.json"), JSON.stringify({ model: "qwen3.8", tier: "standard", started_at: "2026-10-13T08:00:00Z" }));
	try {
		const t = Date.parse("2026-10-13T09:05:00Z"); // 65 min later (> 30 min)
		const data = await collectGdStatus({ vastKey: "vk", stateHome: vastHome, nowMs: t });
		assert.deepEqual(data.gpus, []);
	} finally {
		globalThis.fetch = realFetch;
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});

test("collectGdStatus: fresh failure (no instance) → synthetic red dot", async () => {
	const { realFetch, stateDir, vastHome } = await fakeGdStatus("", []);
	fs.writeFileSync(path.join(vastHome, "state", "last_failure.json"), JSON.stringify({ instance_id: null, error: "no DC sm_86 offers", at: "2026-10-13T09:00:00Z" }));
	try {
		const t = Date.parse("2026-10-13T09:10:00Z");
		const data = await collectGdStatus({ vastKey: "vk", stateHome: vastHome, nowMs: t });
		assert.deepEqual(data.gpus, [{ dph: 0, state: "error", error: "no DC sm_86 offers" }]);
	} finally {
		globalThis.fetch = realFetch;
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});

test("collectGdStatus: failure instance still running → orphan red (no synthetic)", async () => {
	const { realFetch, stateDir, vastHome } = await fakeGdStatus("", [{ id: 55, dph: 0.2 }]);
	fs.writeFileSync(path.join(vastHome, "state", "last_failure.json"), JSON.stringify({ instance_id: 55, error: "model never appeared", at: "2026-10-13T09:00:00Z" }));
	try {
		const t = Date.parse("2026-10-13T09:10:00Z");
		const data = await collectGdStatus({ vastKey: "vk", stateHome: vastHome, nowMs: t });
		assert.equal(data.gpus!.length, 1);
		assert.equal(data.gpus![0].state, "error");
		assert.equal(data.gpus![0].error, "model never appeared");
		assert.equal(data.gpus![0].dph, 0.2);
	} finally {
		globalThis.fetch = realFetch;
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});

test("collectGdStatus: stale failure marker → not red", async () => {
	const { realFetch, stateDir, vastHome } = await fakeGdStatus("", [{ id: 60, dph: 0.2 }]);
	fs.writeFileSync(path.join(vastHome, "state", "last_failure.json"), JSON.stringify({ instance_id: 60, error: "old", at: "2026-10-13T06:00:00Z" }));
	try {
		const t = Date.parse("2026-10-13T09:10:00Z"); // > 2h later
		const data = await collectGdStatus({ vastKey: "vk", stateHome: vastHome, nowMs: t });
		assert.deepEqual(data.gpus, [{ dph: 0.2, state: "starting", hourlyRate: 0.2, launchedAt: undefined }]);
	} finally {
		globalThis.fetch = realFetch;
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});
