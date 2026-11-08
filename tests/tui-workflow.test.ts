/**
 * TUI workflow tests — verify the exact strings the terminal renders:
 *
 * A) During sign-in (/login gd): the fake AuthInteraction plays the role of
 *    pi's login dialog. We assert the secret prompt the dialog shows (multi-line)
 *    and the after-sign info message the dialog switches to (multi-line, invites
 *    /model), plus the returned credential.
 *
 * B) Inside gd-footer: the same chain the extension's tick runs —
 *    readFooterKeys → collectGdStatus → formatGdStatus → the line passed to
 *    ctx.ui.setStatus — asserted end to end, including the dashboard key name.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import { AFTER_SIGN_MESSAGE, AFTER_SIGN_PAUSE_MS, gdLogin } from "../src/provider.ts";
import { collectGdStatus, formatGdStatus, readFooterKeys } from "../src/gpu-status.ts";

const SIGNIN_PROMPT =
	"1) Sign in at https://provider.girard-davila.net/auth/google (Google).\n" +
	"2) Copy the API key from your dashboard and paste it here:";

test("signin TUI: dialog shows the exact 2-line prompt, then the 2-line after-sign message", async () => {
	const prompts: AuthPrompt[] = [];
	const events: AuthEvent[] = [];
	const controller = new AbortController();
	const interaction: AuthInteraction = {
		signal: controller.signal,
		prompt: async (p) => {
			prompts.push(p);
			// Simulate the dialog closing right after the user submits, so the
			// after-sign hold exits early instead of blocking the test 4 s.
			controller.abort();
			return "  sk-test  ";
		},
		notify: (e) => {
			events.push(e);
		},
	};
	const started = Date.now();
	const cred = await gdLogin(interaction);
	const elapsed = Date.now() - started;

	// What the dialog prompts with.
	assert.equal(prompts.length, 1);
	assert.ok(prompts[0].type === "secret", `expected secret prompt, got ${JSON.stringify(prompts[0])}`);
	if (prompts[0].type === "secret") {
		assert.equal(prompts[0].message, SIGNIN_PROMPT);
		assert.ok(prompts[0].message.includes("\n"), "sign-in prompt must be multi-line for the TUI");
		assert.equal(prompts[0].placeholder, "sk-...");
	}

	// What the dialog switches to after the key is accepted.
	assert.equal(events.length, 1);
	assert.deepEqual(events[0], { type: "info", message: AFTER_SIGN_MESSAGE });

	// The credential pi stores is the trimmed key.
	assert.deepEqual(cred, { type: "api_key", key: "sk-test" });

	// The aborted flow must not sit out the full after-sign hold.
	assert.ok(elapsed < AFTER_SIGN_PAUSE_MS / 2, `after-sign hold should be skipped on abort, took ${elapsed}ms`);
});

test("after-sign TUI message: exactly two lines and invites /model", () => {
	const lines = AFTER_SIGN_MESSAGE.split("\n");
	assert.equal(lines.length, 2);
	assert.equal(lines[0], "Signed in.");
	assert.match(AFTER_SIGN_MESSAGE, /\/model/);
});

test("signin TUI: empty key cancels before any after-sign message", async () => {
	const events: AuthEvent[] = [];
	const interaction: AuthInteraction = {
		prompt: async () => "   ",
		notify: (e) => {
			events.push(e);
		},
	};
	await assert.rejects(gdLogin(interaction), /API key is empty/);
	assert.equal(events.length, 0, "no after-sign message on cancelled login");
});

// ---------------------------------------------------------------------------
// gd-footer TUI — the chain tickGpuStatus runs, end to end.
// ---------------------------------------------------------------------------

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

function stubFetch(routes: Record<string, unknown>): () => void {
	const real = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const s = String(input);
		for (const [match, body] of Object.entries(routes)) {
			if (s.includes(match)) {
				return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
			}
		}
		throw new Error("unexpected url " + s);
	}) as typeof fetch;
	return () => {
		globalThis.fetch = real;
	};
}

test("gd-footer TUI: config.env keys → collect → format → the line pi renders", async () => {
	const envFile = path.join(os.tmpdir(), `gd-wf-env-${Date.now()}`);
	fs.writeFileSync(envFile, "LITELLM_OPS_KEY=lk_test\nVAST_API_KEY=vk_test\n");
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "gd-wf-state-"));
	fs.mkdirSync(path.join(home, "state"), { recursive: true });
	const restore = stubFetch({
		"/key/info": { info: { key_alias: "pi-relax", max_budget: 5, spend: 1.25 } },
		"/users/current": { balance: 2.5, credit: 2.68 },
		"/instances/": { success: true, instances: [{ id: 11, cur_state: "running", dph_total: 0.3 }] },
	});
	try {
		const keys = readFooterKeys(envFile);
		assert.deepEqual(keys, { opsKey: "lk_test", vastKey: "vk_test" });

		const data = await collectGdStatus({
			opsKey: keys.opsKey,
			vastKey: keys.vastKey,
			gdKey: "sk-customer",
			stateHome: home,
		});
		const line = formatGdStatus(data);
		const plain = stripAnsi(line);

		// The dashboard key name comes first, then the ledger (5 − 1.25),
		// one ● for the running instance, then its burn — no error marker.
		assert.ok(plain.startsWith("pi-relax "), plain);
		assert.ok(plain.includes("3.75€"), plain);
		assert.ok(plain.includes("●"), plain);
		assert.ok(plain.includes("0.30€/h"), plain);
		assert.ok(!plain.includes("!"), plain);
		// Untracked instance = starting → grey dot.
		assert.ok(line.includes("\x1b[38;5;245m●\x1b[0m"), line);
	} finally {
		restore();
		fs.rmSync(envFile, { force: true });
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("gd-footer TUI: without VAST key the line is just name + ledger", async () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "gd-wf-state2-"));
	const restore = stubFetch({
		"/key/info": { info: { key_alias: "pi-relax", max_budget: 5, spend: 1.25 } },
	});
	try {
		const data = await collectGdStatus({ opsKey: "lk", vastKey: null, gdKey: "sk-customer", stateHome: home });
		assert.equal(data.alias, "pi-relax");
		assert.equal(stripAnsi(formatGdStatus(data)), "pi-relax 3.75€");
	} finally {
		restore();
		fs.rmSync(home, { recursive: true, force: true });
	}
});
