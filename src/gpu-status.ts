import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BASE_URL } from "./core.ts";
import { fetchGdAccount, fetchRunningInstances, parseEnvFile, readGpuState, roundCents, vastHome } from "./gpu.ts";

// ---------------------------------------------------------------------------
// Ledger (api.girard-davila.net) — the money shown in the footer comes from
// the LiteLLM ledger of the gd customer key, NOT from raw VAST funds:
//   available = max_budget - spend        (when a budget is set)
//   spent     = -spend                   (when no budget: shown as -x.xx€)
// Source: GET {proxy}/key/info?key=<gd key>  (auth: LITELLM_OPS_KEY)
// ---------------------------------------------------------------------------

export interface LedgerInfo {
	alias: string | null;
	maxBudget: number | null;
	spend: number;
}

const ANS = {
	grey: (s: string) => `\x1b[38;5;245m${s}\x1b[0m`,
	green: (s: string) => `\x1b[32m${s}\x1b[0m`,
	red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

/** Read the gd customer key from the pi agent auth store. */
export function readGdKey(authPath: string = path.join(os.homedir(), ".pi", "agent", "auth.json")): string | null {
	try {
		const auth = JSON.parse(fs.readFileSync(authPath, "utf8")) as Record<string, { key?: string }>;
		const k = auth["gd"]?.key;
		return typeof k === "string" && k.length > 0 ? k : null;
	} catch {
		return null;
	}
}

export async function fetchLedger(opsKey: string, gdKey: string, baseUrl: string = BASE_URL): Promise<LedgerInfo> {
	const url = `${baseUrl}/key/info?key=${encodeURIComponent(gdKey)}`;
	const res = await fetch(url, { headers: { Authorization: `Bearer ${opsKey}` } });
	if (!res.ok) throw new Error(`ledger /key/info failed: HTTP ${res.status}`);
	const data = (await res.json()) as { info?: { key_alias?: string; max_budget?: number | null; spend?: number } };
	const info = data.info ?? {};
	return {
		alias: info.key_alias ?? null,
		maxBudget: info.max_budget === null || info.max_budget === undefined ? null : Number(info.max_budget),
		spend: Number(info.spend ?? 0),
	};
}

export type GpuDotState = "starting" | "ready" | "error";
export interface GpuDot {
	dph: number;
	state: GpuDotState;
	/** $/hr for this instance (state hourly_rate, else dph_total). */
	hourlyRate?: number;
	/** Epoch ms when this instance started billing (state/current.json launched_at). */
	launchedAt?: number;
}

export interface GdStatusInput {
	/**
	 * Ledger money: null = unknown/error.
	 * budget null = no budget set (show spend as -x.xx€); else show max(0, budget - spend).
	 */
	money?: { budget: number | null; spend: number } | null;
	gpus?: GpuDot[];
	/**
	 * Remaining gd VAST account money (balance + credit, the same total
	 * decideBalance uses) in USD. null = unknown/error.
	 */
	vastUsd?: number | null;
	/** Last fetch error, if any (stale data may still be shown). */
	apiError?: string | null;
}

// ---------------------------------------------------------------------------
// Burn alerts (org-or6b.19, decision (c) of org-or6b.2 — FINAL):
//   (1) TIME:    >= 3h rented (uptime from state launched_at)
//   (2) RUNWAY:  remaining VAST money / (burn x GD_DAY_HOURS) < 1 day of work
// GD_DAY_HOURS = active hours per workday, default 8, env-overridable.
// ---------------------------------------------------------------------------

export const BURN_TIME_HOURS = 3;
export const ENV_GD_DAY_HOURS = "GD_DAY_HOURS";
export const DEFAULT_DAY_HOURS = 8;

/** GD_DAY_HOURS from env (default 8, positive-number validated). */
export function dayHours(): number {
	const raw = process.env[ENV_GD_DAY_HOURS];
	const n = raw === undefined ? NaN : Number.parseFloat(raw);
	return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAY_HOURS;
}

/** Parse launch.py state 'launched_at' (UTC 'YYYY-MM-DDTHH:MM:SSZ') to epoch ms. */
export function parseUtcZ(s: string | undefined): number | undefined {
	if (!s) return undefined;
	const t = Date.parse(s);
	return Number.isFinite(t) ? t : undefined;
}

export interface BurnAlert {
	kind: "time" | "runway";
	/** time: hours rented; runway: days of work remaining (< 1). */
	value: number;
	detail: string;
}

/**
 * Pure evaluation of the two burn thresholds (org-or6b.19). Read-only —
 * the footer never tears anything down; it only makes the burn visible.
 */
export function computeBurnAlerts(input: GdStatusInput, nowMs: number, dayH: number): BurnAlert[] {
	const alerts: BurnAlert[] = [];
	const gpus = input.gpus ?? [];
	let maxHours = 0;
	for (const g of gpus) {
		if (g.launchedAt === undefined) continue;
		const hours = (nowMs - g.launchedAt) / 3.6e6;
		if (hours > maxHours) maxHours = hours;
	}
	const burn = gpus.reduce((s, g) => s + (Number.isFinite(g.dph) ? g.dph : 0), 0);
	if (maxHours >= BURN_TIME_HOURS) {
		alerts.push({
			kind: "time",
			value: maxHours,
			detail: `${maxHours.toFixed(1)}h rented (~$${(burn * maxHours).toFixed(2)} at current burn)`,
		});
	}
	if (input.vastUsd !== null && input.vastUsd !== undefined && burn > 0 && dayH > 0) {
		const days = input.vastUsd / (burn * dayH);
		if (days < 1) {
			alerts.push({
				kind: "runway",
				value: days,
				detail: `$${input.vastUsd.toFixed(2)} VAST left ≈ ${Math.max(0, days * dayH).toFixed(1)}h of work (${dayH}h-day budget)`,
			});
		}
	}
	return alerts;
}

const euro = (n: number) => `${(Math.round(n * 100) / 100).toFixed(2)}€`;

/**
 * Render the footer value: `8.22€ ●● 0.68€/h`
 *  - money: available (budget - spend) as `x.xx€`, red when < 10% of budget;
 *    no budget -> spend so far as `-x.xx€` (grey).
 *  - one ● per running VAST instance: grey=starting, green=ready, red=error.
 *  - burn: summed dph, only when at least one GPU is running; RED when a burn
 *    alert (org-or6b.19) is active, followed by the alert cluster:
 *    red `⏱x.xh` (>= 3h rented) and/or red `⚠x.xh` (VAST runway < 1 day of work).
 *  - apiError: red `!` (stale data, if any, still shown).
 */
export interface GdFormatOptions {
	/** Injection point for tests; defaults to Date.now(). */
	nowMs?: number;
	/** Workday length in hours for the runway threshold; defaults to dayHours(). */
	dayHours?: number;
}

export function formatGdStatus(input: GdStatusInput, opts: GdFormatOptions = {}): string {
	const nowMs = opts.nowMs ?? Date.now();
	const dayH = opts.dayHours ?? dayHours();
	const alerts = computeBurnAlerts(input, nowMs, dayH);
	const parts: string[] = [];
	const m = input.money ?? null;
	if (m) {
		if (m.budget !== null) {
			const available = Math.max(0, m.budget - m.spend);
			const low = available < 0.1 * m.budget;
			parts.push(low ? ANS.red(euro(available)) : euro(available));
		} else {
			parts.push(ANS.grey(`-${euro(m.spend)}`));
		}
	}
	const gpus = input.gpus ?? [];
	if (gpus.length > 0) {
		let run = "";
		let last: GpuDotState | "" = "";
		const flush = () => {
			if (run) {
				const c = last === "ready" ? ANS.green : last === "error" ? ANS.red : ANS.grey;
				parts.push(c(run));
				run = "";
			}
		};
		for (const g of gpus) {
			if (g.state !== last) {
				flush();
				last = g.state;
			}
			run += "●";
		}
		flush();
		const burn = gpus.reduce((s, g) => s + (Number.isFinite(g.dph) ? g.dph : 0), 0);
		parts.push(alerts.length > 0 ? ANS.red(`${euro(burn)}/h`) : `${euro(burn)}/h`);
		for (const a of alerts) {
			parts.push(
				a.kind === "time"
					? ANS.red(`⏱${a.value.toFixed(1)}h`)
					: ANS.red(`⚠${Math.max(0, a.value * dayH).toFixed(1)}h`),
			);
		}
	}
	if (input.apiError) parts.push(ANS.red("!"));
	return parts.join(" ");
}

/**
 * Collect everything needed for one footer render.
 * VAST errors degrade to apiError (stale/none), ledger errors drop money.
 */
export async function collectGdStatus(opts: {
	opsKey?: string | null;
	gdKey?: string | null;
	vastKey?: string | null;
	stateHome?: string;
	apiBase?: string;
} = {}): Promise<GdStatusInput> {
	const apiError: string[] = [];
	let money: GdStatusInput["money"] = null;
	let gpus: GpuDot[] = [];
	let vastUsd: number | null = null;

	const opsKey = opts.opsKey ?? null;
	const gdKey = opts.gdKey ?? null;
	const vastKey = opts.vastKey ?? null;
	const home = opts.stateHome ?? vastHome();

	if (opsKey && gdKey) {
		try {
			const ledger = await fetchLedger(opsKey, gdKey);
			money = { budget: ledger.maxBudget, spend: ledger.spend };
		} catch (e) {
			apiError.push(e instanceof Error ? e.message : String(e));
		}
	}
	if (vastKey) {
		try {
			const instances = await fetchRunningInstances(vastKey, opts.apiBase);
			const st = readGpuState(home);
			gpus = instances.map((i) => {
				const tracked = st !== null && st.instance_id === i.id;
				return {
					dph: i.dph ?? 0,
					state: tracked ? ("ready" as const) : ("starting" as const),
					hourlyRate: tracked ? (st.hourly_rate ?? i.dph ?? 0) : i.dph ?? 0,
					launchedAt: tracked ? parseUtcZ(st.launched_at) : undefined,
				};
			});
		} catch (e) {
			apiError.push(e instanceof Error ? e.message : String(e));
		}
		// Remaining VAST money (balance + credit — the same total decideBalance
		// uses) feeds the runway threshold (org-or6b.19). Separate try: an
		// account-call failure must not hide the instance dots.
		try {
			const account = await fetchGdAccount(home, vastKey, opts.apiBase);
			vastUsd = roundCents(account.balance + account.credit);
		} catch (e) {
			apiError.push(e instanceof Error ? e.message : String(e));
		}
	}
	return {
		money,
		gpus,
		vastUsd,
		apiError: apiError.length > 0 ? apiError.join("; ") : null,
	};
}

/** Parse the two keys needed for the footer from vast/config.env. */
export function readFooterKeys(envFile: string): { opsKey: string | null; vastKey: string | null } {
	let raw: string | null = null;
	try {
		raw = fs.readFileSync(envFile, "utf8");
	} catch {
		return { opsKey: null, vastKey: null };
	}
	const env = parseEnvFile(raw);
	return {
		opsKey: env.LITELLM_OPS_KEY || null,
		vastKey: env.VAST_API_KEY || null,
	};
}

export const FOOTER_DEFAULT_ENV = path.join(vastHome(), "config.env");
