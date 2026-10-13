/**
 * gd overflow GPU (VAST) deployment logic for pi.
 *
 * The heavy lifting is the existing `vast/` Python setup (scripts.launch /
 * scripts.teardown) living next to the api.girard-davila.net repo; this module
 * only orchestrates it from pi:
 *
 *   1. check the gd VAST user's money (balance + signup credit, one field each —
 *      `balance` alone underreports; see org-2r21)
 *   2. reuse a running instance, or launch one and wait until the model is loaded
 *   3. hand the model id back so the session can be pointed at the group that
 *      now includes the GPU row (launch.py already PATCHes the litellm row)
 *
 * Pure helpers are exported separately so tests can cover them without VAST.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const VAST_API_BASE = "https://console.vast.ai/api/v0";
export const DEFAULT_VAST_HOME = path.join(os.homedir(), "code", "api.girard-davila.net", "vast");
export const ENV_VAST_HOME = "GD_VAST_HOME";
export const ENV_MIN_BALANCE = "GD_GPU_MIN_BALANCE";
export const DEFAULT_MIN_BALANCE = 1.0;

/** Default model id the session switches to: the group containing the -vast row. */
export const GPU_MODEL_ID = "qwen3.8-primary";

export interface VastAccount {
	balance: number;
	credit: number;
}

export interface BalanceDecision {
	ok: boolean;
	total: number;
	floor: number;
	reason: string;
}

/**
 * Money check: VAST keeps `balance` (top-ups) and `credit` (signup credit) in
 * SEPARATE fields; either can pay. Refuse only when the sum is below floor.
 */
export function decideBalance(balance: number, credit: number, floor: number): BalanceDecision {
	const total = roundCents(balance + credit);
	if (total < floor) {
		return {
			ok: false,
			total,
			floor,
			reason: `gd VAST money is $${balance.toFixed(2)} balance + $${credit.toFixed(2)} credit = $${total.toFixed(2)}, below the $${floor.toFixed(2)} floor — top up the gd VAST account first`,
		};
	}
	return { ok: true, total, floor, reason: `$${total.toFixed(2)} available (balance $${balance.toFixed(2)} + credit $${credit.toFixed(2)})` };
}

export interface RunningInstance {
	id: number;
	state: string;
	dph?: number;
}

export interface GpuState {
	instance_id?: number;
	api_base?: string;
	api_key?: string;
	hourly_rate?: number;
	gpu?: string;
	model?: string;
	launched_at?: string;
}

export type ReuseDecision =
	| { kind: "none" }
	| { kind: "reuse"; instance: RunningInstance; state: GpuState }
	| { kind: "conflict"; reason: string };

/**
 * Idempotency: if a VAST instance is already running, do not bill a second one.
 * - running + local state file → reuse it (launch.py left it ready)
 * - running + no state file    → conflict: someone launched it outside this flow
 */
export function decideReuse(running: RunningInstance[], state: GpuState | null): ReuseDecision {
	if (running.length === 0) return { kind: "none" };
	if (state) {
		const match = running.find((i) => i.id === state.instance_id);
		if (match) return { kind: "reuse", instance: match, state };
	}
	const ids = running.map((i) => i.id).join(", ");
	return {
		kind: "conflict",
		reason: `VAST instance(s) ${ids} already running but no matching local state (state/current.json) — run /teardown-gpu first, then retry`,
	};
}

/** Minimal KEY=VALUE parser for the vast config.env (no shell sourcing). */
export function parseEnvFile(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
	}
	return out;
}

export function roundCents(n: number): number {
	return Math.round(n * 100) / 100;
}

export function vastHome(): string {
	return process.env[ENV_VAST_HOME] ?? DEFAULT_VAST_HOME;
}

export function minBalanceFloor(): number {
	const raw = process.env[ENV_MIN_BALANCE];
	const n = raw === undefined ? NaN : Number.parseFloat(raw);
	return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MIN_BALANCE;
}

function vastGet<T>(apiBase: string, endpoint: string, apiKey: string): Promise<T> {
	const url = `${apiBase}${endpoint}`;
	return new Promise<T>((resolve, reject) => {
		fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } })
			.then(async (res) => {
				const body: unknown = await res.json().catch(() => ({}));
				if (!res.ok) {
					const msg = body && typeof body === "object" && "detail" in body ? String((body as Record<string, unknown>).detail) : `HTTP ${res.status}`;
					reject(new Error(`VAST ${endpoint} failed: ${msg}`));
					return;
				}
				resolve(body as T);
			})
			.catch((e) => reject(e instanceof Error ? e : new Error(String(e))));
	});
}

export interface DeployResult {
	status: "ready";
	reused: boolean;
	instance_id: number;
	model: string;
	api_base?: string;
	hourly_rate?: number;
	gpu?: string;
	balance_note: string;
}

export interface LauncherSpec {
	file: string;
	args: string[];
	cwd: string;
	/** Extra env merged over process.env for the child. */
	env?: Record<string, string>;
}

export interface DeployOptions {
	/** Max $/hr cap passed to scripts.launch --price (offer cap). */
	maxPrice?: number;
	/** GPU tier passed to scripts.launch --tier. Omitted -> launch.py falls back to $VAST_TIER, then standard. */
	tier?: "standard" | "premium";
	/** Model id from vast/models.json passed to scripts.launch --model (org-or6b.8). Omitted -> manifest default (qwen3.8). */
	model?: string;
	apiBase?: string;
	/**
	 * Test-only: allow non-datacenter hosts (VAST_ALLOW_NON_DATACENTER=1).
	 * Never for production slow mode.
	 */
	allowHome?: boolean;
	/** /gd-gpu-off [id]: destroy this specific instance (scripts.teardown --id). */
	instanceId?: number;
	/** Test hook: run the launcher with this command instead of python. */
	launcher?: LauncherSpec;
	log?: (line: string) => void;
	signal?: AbortSignal;
}

/** Read the gd VAST account (balance + credit). */
export async function fetchGdAccount(vastHomeDir: string, apiKey: string, apiBase = VAST_API_BASE): Promise<VastAccount> {
	const user = await vastGet<Record<string, unknown>>(apiBase, "/users/current", apiKey);
	return { balance: Number(user.balance ?? 0), credit: Number(user.credit ?? 0) };
}

/**
 * Instances in a usable state (assigned & running).
 * Uses the v1 paged endpoint (GET, JSON-encoded query args) — the legacy
 * v0 `/instances/current/` 400s without the SDK's POST body.
 */
export async function fetchRunningInstances(apiKey: string, apiBase = VAST_API_BASE): Promise<RunningInstance[]> {
	const q = new URLSearchParams();
	q.set("select_filters", JSON.stringify({}));
	q.set("order_by", JSON.stringify([{ col: "id", dir: "asc" }]));
	q.set("limit", "25");
	const host = apiBase.replace(/\/api\/v\d+$/, "");
	const url = `${host}/api/v1/instances/?${q.toString()}`;
	const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
	const data = (await res.json()) as { instances?: Array<Record<string, unknown>> };
	if (!res.ok) throw new Error(`VAST /instances/ failed: HTTP ${res.status}`);
	return (data.instances ?? []).flatMap((row) => {
		if (row.cur_state !== "running") return [];
		return [{ id: Number(row.id), state: String(row.cur_state), dph: row.dph_total === undefined ? undefined : Number(row.dph_total) }];
	});
}

export function readGpuState(vastHomeDir: string): GpuState | null {
	try {
		return JSON.parse(fs.readFileSync(path.join(vastHomeDir, "state", "current.json"), "utf-8")) as GpuState;
	} catch {
		return null;
	}
}

function runLauncher(launcher: LauncherSpec, signal: AbortSignal | undefined, onProgress: (line: string) => void): Promise<{ code: number; tail: string }> {
	return new Promise((resolve) => {
		const child = spawn(launcher.file, launcher.args, {
			cwd: launcher.cwd,
			env: launcher.env ? { ...process.env, ...launcher.env } : process.env,
		});
		let buf = "";
		const pipe = (data: Buffer) => {
			buf += data.toString();
			// keep only the last chunk for progress + error reporting
			if (buf.length > 8000) buf = buf.slice(-8000);
			onProgress(buf.split("\n").filter(Boolean).pop() ?? "");
		};
		child.stdout.on("data", pipe);
		child.stderr.on("data", pipe);
		const onAbort = () => child.kill("SIGTERM");
		if (signal) {
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
		child.on("error", (e: Error) => resolve({ code: -1, tail: `launcher failed to start: ${e.message}` }));
		child.on("close", (code: number | null) => {
			signal?.removeEventListener("abort", onAbort);
			resolve({ code: code ?? -1, tail: buf.split("\n").filter(Boolean).slice(-25).join("\n") });
		});
	});
}

/**
 * Deploy (or reuse) the gd overflow GPU. Throws with a human-readable reason
 * on failure; resolves with the ready instance + model on success.
 * Takes 10–20 min on a cold launch (model download) — callers must not race it.
 */
export async function deployGpu(opts: DeployOptions = {}): Promise<DeployResult> {
	const home = vastHome();
	if (!fs.existsSync(path.join(home, "scripts", "launch.py"))) {
		throw new Error(`VAST home not found at ${home} (set ${ENV_VAST_HOME}) — scripts/launch.py missing`);
	}
	const env = parseEnvFile(fs.readFileSync(path.join(home, "config.env"), "utf-8"));
	const apiKey = env["VAST_API_KEY"];
	if (!apiKey) throw new Error(`VAST_API_KEY missing from ${path.join(home, "config.env")}`);

	const log = opts.log ?? (() => {});
	const account = await fetchGdAccount(home, apiKey);
	const floor = minBalanceFloor();
	const decision = decideBalance(account.balance, account.credit, floor);
	if (!decision.ok) throw new Error(decision.reason);
	log(`balance ok: ${decision.reason}`);

	const running = await fetchRunningInstances(apiKey);
	const state = readGpuState(home);
	const reuse = decideReuse(running, state);
	if (reuse.kind === "reuse") {
		log(`reusing running instance ${reuse.instance.id} (no new billing started)`);
		return {
			status: "ready",
			reused: true,
			instance_id: reuse.instance.id,
			model: reuse.state.model ?? GPU_MODEL_ID,
			api_base: reuse.state.api_base,
			hourly_rate: reuse.instance.dph ?? reuse.state.hourly_rate,
			gpu: reuse.state.gpu,
			balance_note: decision.reason,
		};
	}
	if (reuse.kind === "conflict") throw new Error(reuse.reason);

	const py = path.join(home, ".venv", "bin", "python");
	const args = ["-m", "scripts.launch", "--yes"];
	if (opts.maxPrice !== undefined && opts.maxPrice > 0) args.push("--price", String(opts.maxPrice));
	if (opts.tier) args.push("--tier", opts.tier);
	if (opts.model) args.push("--model", opts.model);
	if (opts.allowHome) log("WARNING: --home-ok — non-datacenter hosts ALLOWED (test only, never for production)");
	const launcher = opts.launcher ?? {
		file: py,
		args,
		cwd: home,
		...(opts.allowHome ? { env: { VAST_ALLOW_NON_DATACENTER: "1" } } : {}),
	};

	const { code, tail } = await runLauncher(launcher, opts.signal, (line) => log(line));

	if (code !== 0) {
		throw new Error(`scripts.launch exited ${code}:\n${tail}`);
	}
	const readyState = readGpuState(home);
	if (!readyState?.api_base) throw new Error("launch.py exited 0 but state/current.json has no api_base — refusing to report READY");
	return {
		status: "ready",
		reused: false,
		instance_id: readyState.instance_id ?? -1,
		model: readyState.model ?? GPU_MODEL_ID,
		api_base: readyState.api_base,
		hourly_rate: readyState.hourly_rate,
		gpu: readyState.gpu,
		balance_note: decision.reason,
	};
}

/** Tear down the running VAST instance (stops billing; launch.py's counterpart). */
/**
 * Pure arg parser for `/gd-gpu-on [params]`.
 * Tokens: `--price <max $/hr>` (offer cap), `--home-ok` (test: allow
 * non-datacenter hosts), `[standard|premium]` (tier), and a bare model id
 * (org-or6b.8 — any other positional is the vast/models.json model id, e.g.
 * `llama8`). Everything else is an error (explicit > clever).
 */
export function parseGpuOnArgs(args: string): { maxPrice?: number; homeOk: boolean; tier?: "standard" | "premium"; model?: string; error?: string } {
	const out: { maxPrice?: number; homeOk: boolean; tier?: "standard" | "premium"; model?: string; error?: string } = { homeOk: false };
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (t === "--price") {
			const v = Number(tokens[++i]);
			if (!Number.isFinite(v) || v <= 0) return { homeOk: false, error: `--price needs a positive number, got ${tokens[i] ?? "(nothing)"}` };
			out.maxPrice = v;
		} else if (t === "--home-ok") {
			out.homeOk = true;
		} else if (t === "standard" || t === "premium") {
			if (out.tier) return { homeOk: false, error: `tier given twice (${out.tier}, ${t}) — pass exactly one of: standard | premium` };
			out.tier = t;
		} else if (t === "--model") {
			const m = tokens[++i];
			if (!m) return { homeOk: false, error: `--model needs a model id, got (nothing)` };
			if (out.model) return { homeOk: false, error: `model given twice (${out.model}, ${m}) — pass exactly one` };
			out.model = m;
		} else if (/^[a-z0-9][a-z0-9._-]*$/i.test(t) && t.length >= 2) {
			// bare token = model id (org-or6b.8). Kept conservative so a typo
			// like `--price` without a value still errors loudly.
			if (out.model) return { homeOk: false, error: `model given twice (${out.model}, ${t}) — pass exactly one` };
			out.model = t;
		} else {
			return { homeOk: false, error: `unknown parameter ${t} — supported: [standard|premium], [model], --price <max $/hr>, --home-ok` };
		}
	}
	return out;
}

export async function teardownGpu(opts: DeployOptions = {}): Promise<{ ok: boolean; tail: string }> {
	const home = vastHome();
	const args = ["-m", "scripts.teardown", "--yes"];
	if (opts.instanceId !== undefined) args.push("--id", String(opts.instanceId));
	const launcher = opts.launcher ?? { file: path.join(home, ".venv", "bin", "python"), args, cwd: home };
	const log = opts.log ?? (() => {});
	const { code, tail } = await runLauncher(launcher, opts.signal, (line) => log(line));
	return { ok: code === 0, tail };
}
