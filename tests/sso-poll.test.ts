import assert from "node:assert/strict";
import test from "node:test";
import { parseCliSsoTeams, pollCliSso, type CliSsoStart } from "../src/core.ts";

// ---- parseCliSsoTeams ----------------------------------------------------

test("parseCliSsoTeams: builds from team_details (alias + models)", () => {
	const teams = parseCliSsoTeams(
		[
			{ team_id: "t1", team_alias: "public-customer", team_models: ["deepseek-v4.1-flash"] },
			{ team_id: "t2", team_alias: null, team_models: ["qwen3.8-primary"] },
		],
		["t1", "t2"],
	);
	assert.deepEqual(teams, [
		{ id: "t1", label: "public-customer", description: "deepseek-v4.1-flash" },
		{ id: "t2", label: "t2", description: "qwen3.8-primary" },
	]);
});

test("parseCliSsoTeams: falls back to raw ids", () => {
	assert.deepEqual(parseCliSsoTeams(undefined, ["a", "b"]), [
		{ id: "a", label: "a", description: undefined },
		{ id: "b", label: "b", description: undefined },
	]);
	assert.deepEqual(parseCliSsoTeams(undefined, undefined), []);
});

// ---- pollCliSso team-selection flow --------------------------------------

function start(): CliSsoStart {
	return { loginId: "cli-test", pollSecret: "secret", userCode: "AAAA-BBBB", expiresInSeconds: 600 };
}

test("pollCliSso: multi-team -> selectTeam -> re-poll with team_id -> key", async () => {
	const realFetch = globalThis.fetch;
	const urls: string[] = [];
	let readyReturned = false;
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url = String(input);
		urls.push(url);
		const json = (o: unknown) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
		if (url.includes("team_id=t2")) {
			return json({ status: "ready", key: "sk-issued", team_id: "t2" });
		}
		if (!readyReturned) {
			readyReturned = true;
			return json({ status: "pending" });
		}
		// first "ready" without a key: team selection required
		return json({
			status: "ready",
			requires_team_selection: true,
			teams: ["t1", "t2"],
			team_details: [
				{ team_id: "t1", team_alias: "public-customer", team_models: ["deepseek-v4.1-flash"] },
				{ team_id: "t2", team_alias: "internal", team_models: ["qwen3.8-primary"] },
			],
		});
	}) as typeof fetch;

	let pickedOptions: { id: string; label: string }[] = [];
	try {
		const key = await pollCliSso("https://x/api/llm", start(), {
			intervalMs: 1,
			timeoutMs: 5000,
			selectTeam: async (teams) => {
				pickedOptions = teams.map((t) => ({ id: t.id, label: t.label }));
				return "t2";
			},
		});
		assert.equal(key, "sk-issued");
		assert.deepEqual(pickedOptions, [
			{ id: "t1", label: "public-customer" },
			{ id: "t2", label: "internal" },
		]);
		assert.ok(urls.some((u) => u.includes("team_id=t2")), "must re-poll with the chosen team_id");
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("pollCliSso: single-team returns key directly (no selection)", async () => {
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(JSON.stringify({ status: "ready", key: "sk-one" }), {
			headers: { "content-type": "application/json" },
		})) as typeof fetch;
	let selectCalled = false;
	try {
		const key = await pollCliSso("https://x/api/llm", start(), {
			intervalMs: 1,
			timeoutMs: 5000,
			selectTeam: async () => {
				selectCalled = true;
				return undefined;
			},
		});
		assert.equal(key, "sk-one");
		assert.equal(selectCalled, false);
	} finally {
		globalThis.fetch = realFetch;
	}
});
