import assert from "node:assert/strict";
import test from "node:test";
import { collectGdStatus, formatGdStatus, readFooterKeys, readGdKey } from "../src/gpu-status.ts";
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
		if (s.includes("/instances/")) {
			return new Response(JSON.stringify({ success: true, instances: [{ id: 11, cur_state: "running", dph_total: 0.3 }, { id: 12, cur_state: "running", dph_total: 0.4 }] }), { headers: { "content-type": "application/json" } });
		}
		throw new Error("unexpected url " + s);
	}) as typeof fetch;
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "gd-state-"));
	const home = path.join(stateDir, "vast");
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(path.join(home, "state"), { recursive: true });
	fs.writeFileSync(path.join(home, "state", "current.json"), JSON.stringify({ instance_id: 11 }));
	try {
		const data = await collectGdStatus({
			opsKey: "lk",
			gdKey: "sk",
			vastKey: "vk",
			stateHome: home,
		});
		assert.deepEqual(data.money, { budget: 5, spend: 1.25 });
		assert.deepEqual(data.gpus, [{ dph: 0.3, state: "ready" }, { dph: 0.4, state: "starting" }]);
		assert.equal(data.apiError, null);
	} finally {
		globalThis.fetch = realFetch;
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});
