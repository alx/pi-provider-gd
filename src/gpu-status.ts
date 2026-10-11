import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BASE_URL } from "./core.ts";
import { fetchRunningInstances, parseEnvFile, readGpuState, vastHome } from "./gpu.ts";

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
}

export interface GdStatusInput {
	/**
	 * Ledger money: null = unknown/error.
	 * budget null = no budget set (show spend as -x.xx€); else show max(0, budget - spend).
	 */
	money?: { budget: number | null; spend: number } | null;
	gpus?: GpuDot[];
	/** Last fetch error, if any (stale data may still be shown). */
	apiError?: string | null;
}

const euro = (n: number) => `${(Math.round(n * 100) / 100).toFixed(2)}€`;

/**
 * Render the footer value: `8.22€ ●● 0.68€/h`
 *  - money: available (budget - spend) as `x.xx€`, red when < 10% of budget;
 *    no budget -> spend so far as `-x.xx€` (grey).
 *  - one ● per running VAST instance: grey=starting, green=ready, red=error.
 *  - burn: summed dph, only when at least one GPU is running.
 *  - apiError: red `!` (stale data, if any, still shown).
 */
export function formatGdStatus(input: GdStatusInput): string {
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
		parts.push(`${euro(burn)}/h`);
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
} = {}): Promise<GdStatusInput> {
	const apiError: string[] = [];
	let money: GdStatusInput["money"] = null;
	let gpus: GpuDot[] = [];

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
			const instances = await fetchRunningInstances(vastKey);
			const st = readGpuState(home);
			gpus = instances.map((i) => ({
				dph: i.dph ?? 0,
				state: st && st.instance_id === i.id ? ("ready" as const) : ("starting" as const),
			}));
		} catch (e) {
			apiError.push(e instanceof Error ? e.message : String(e));
		}
	}
	return {
		money,
		gpus,
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
