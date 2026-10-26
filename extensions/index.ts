/**
 * pi-provider-gd — self-contained native `gd` provider for api.girard-davila.net.
 *
 * Installing this package is the whole setup:
 *   pi install git:github.com/alx/pi-provider-gd
 *
 * It registers a native pi provider `gd` that streams OpenAI-compatible
 * requests to the endpoint and discovers models from /v1/models.
 *
 * After install:
 *   /login gd      — either paste the API key from your dashboard at
 *                    https://provider.girard-davila.net/ or sign in via the
 *                    browser device flow (Google SSO → gateway issues the
 *                    key); the key is stored in ~/.pi/agent/auth.json under
 *                    "gd". No hand-editing, no separate pi-provider-litellm
 *                    install.
 *
 * Self-heal: a brand-new session that has no model selected yet is pointed at
 * the default gd model (GD_DEFAULT_MODEL env or DEFAULT_MODEL_ID, validated
 * against the live catalog) as soon as a credential exists — so after
 * install + /login gd the next session is immediately usable.
 *
 * /gd-doctor — diagnose credential + /v1/models reachability from inside pi
 * (pi's /model screen hides the underlying refresh error, so it shows the
 * exact reason a catalog refresh failed).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createGdProvider, DEFAULT_MODEL_ID, ENV_API_KEY, toModel } from "../src/provider.ts";
import {
	BASE_URL,
	PROVIDER_ID,
	credentialKey,
	defaultAuthPath,
	fetchModelIds,
	fetchModelIdsChecked,
	getCredential,
} from "../src/core.ts";
import { deployGpu, fetchGdAccount, GPU_MODEL_ID, parseGpuOnArgs, readGpuState, teardownGpu, vastHome } from "../src/gpu.ts";
import { FOOTER_DEFAULT_ENV, collectGdStatus, computeBurnAlerts, dayHours, formatGdStatus, readFooterKeys, readGdKey } from "../src/gpu-status.ts";
import { spawn } from "node:child_process";

const DEFAULT_MODEL_DISCOVER_TIMEOUT_MS = 4000;

// Customer-facing billing entry (org-cusm.9.10 / org-wfx.1): pay from Pi.
// The LiteLLM proxy (BASE_URL=/api/llm) and the billing service
// (/billing, behind Caddy) are separate origins under the same host.
const BILLING_BASE = "https://api.girard-davila.net/billing";

function openUrl(url: string): void {
	// Best-effort local opener; the URL is always printed so a headless/remote
	// pi can still complete the checkout.
	try {
		const cmd = process.platform === "darwin"
			? ["open", url]
			: process.platform === "win32"
				? ["cmd", "/c", "start", "", url]
				: ["xdg-open", url];
		spawn(cmd[0], cmd.slice(1), { stdio: "ignore", detached: true }).unref();
	} catch {
		/* fall through - user opens the printed URL */
	}
}

async function billingPost<T>(path: string, body: unknown): Promise<{ ok: boolean; status: number; data: T }> {
	let res: Response;
	try {
		res = await fetch(`${BILLING_BASE}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	} catch (e) {
		return { ok: false, status: 0, data: ({ error: String(e) }) as T };
	}
	let data: unknown = {};
	try { data = await res.json(); } catch { /* body may be empty */ }
	return { ok: res.ok, status: res.status, data: data as T };
}

export default function gdExtension(pi: ExtensionAPI) {
	pi.registerProvider(createGdProvider());

	/**
	 * Option B: land a model-less session on the default gd model.
	 * No-op when the session already has a model or no credential is stored.
	 */
	const ensureDefaultModel = (ctx: ExtensionContext) => {
		return (async () => {
			if (ctx.model) return; // session already has a model
			const storedKey = credentialKey(getCredential(defaultAuthPath(), PROVIDER_ID));
			const key = storedKey ?? process.env[ENV_API_KEY];
			if (!key) return; // not logged in; /login gd will guide the user
			// Best-effort catalog: [] on network failure, in which case we fall
			// back to the configured default id unvalidated.
			const ids = await fetchModelIds(BASE_URL, key, {
				timeoutMs: DEFAULT_MODEL_DISCOVER_TIMEOUT_MS,
			});
			const desired = process.env.GD_DEFAULT_MODEL ?? DEFAULT_MODEL_ID;
			const id = ids.includes(desired) ? desired : (ids[0] ?? desired);
			await pi.setModel(toModel(id));
		})().catch(() => {
			/* never break session start */
		});
	};

	pi.on("session_start", (_event, ctx) => {
		void ensureDefaultModel(ctx);
		startGpuStatus(ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		stopGpuStatus(ctx);
	});

	// ------------------------------------------------------------------
	// gd-gpu powerline footer segment (needs pi-powerline-footer, a dep of
	// this package):  [gd <ledger €> ●● <burn €/h> ⏱x.xh ⚠x.xh]
	//   money  = api.girard-davila.net ledger of the gd customer key
	//            (LiteLLM /key/info: budget - spend; no budget → -spend)
	//   dots   = one ● per VAST GPU (plus synthetic dots for waiting/failed):
	//            yellow=waiting for GPU, grey=model loading, green=ready, red=failed
	//   burn   = summed $/h of running instances; RED when a burn alert fires
	//   alerts = org-or6b.19 (decision (c), GD_DAY_HOURS default 8):
	//            ⏱ red when ≥ BURN_TIME_HOURS (3h) rented (state launched_at)
	//            ⚠ red when remaining VAST money < 1 day of work at current
	//              burn (VAST balance + credit ÷ (burn × GD_DAY_HOURS) < 1)
	//            Read-only: the footer changes color, it never tears down.
	// Multiple servers: dots+burn aggregate over ALL running VAST instances
	// (v1 API), so extra -vast-2/-vast-3 rows / multiple llama.cpp servers
	// show up without changes; per-instance readiness maps through the local
	// state file (single current.json — upstream limitation, see README).
	// ------------------------------------------------------------------
	const FOOTER_STATUS_KEY = "gd-gpu";
	const FOOTER_ITEM: Record<string, unknown> = {
		id: FOOTER_STATUS_KEY,
		statusKey: FOOTER_STATUS_KEY,
		position: "right",
		prefix: "gd",
		selfColorize: true,
		hideWhenMissing: true,
		excludeFromExtensionStatuses: true,
	};
	let gpuPoll: ReturnType<typeof setInterval> | null = null;
	let gpuPollBusy = false;

	const tickGpuStatus = async (ctx: ExtensionContext): Promise<void> => {
		if (gpuPollBusy) return;
		gpuPollBusy = true;
		try {
			const keys = readFooterKeys(FOOTER_DEFAULT_ENV);
			const gdKey = readGdKey();
			if (!keys.opsKey && !keys.vastKey && !gdKey) return; // nothing to show
			const data = await collectGdStatus({ opsKey: keys.opsKey, vastKey: keys.vastKey, gdKey });
			const text = formatGdStatus(data);
			ctx.ui.setStatus(FOOTER_STATUS_KEY, text === "" ? undefined : text);
		} catch {
			/* footer is best-effort; never break the session */
		} finally {
			gpuPollBusy = false;
		}
	};

	const startGpuStatus = (ctx: ExtensionContext): void => {
		if (gpuPoll) return;
		void tickGpuStatus(ctx);
		gpuPoll = setInterval(() => void tickGpuStatus(ctx), 30_000);
	};

	const stopGpuStatus = (ctx: ExtensionContext): void => {
		if (gpuPoll) {
			clearInterval(gpuPoll);
			gpuPoll = null;
		}
		ctx.ui.setStatus(FOOTER_STATUS_KEY, undefined);
	};

	// /gd-footer — manage the powerline.customItems entry for the gd segment.
	const SETTINGS_PATH = path.join(os.homedir(), ".pi", "agent", "settings.json");
	interface PowerlineCfg {
		powerline?: { customItems?: Array<Record<string, unknown>>; [k: string]: unknown };
		[k: string]: unknown;
	}
	const readSettings = (): PowerlineCfg => {
		try {
			return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")) as PowerlineCfg;
		} catch {
			return {};
		}
	};
	const writeSettings = (s: PowerlineCfg): void => {
		fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
		fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2) + "\n");
	};
	const itemsWith = (s: PowerlineCfg, fn: (items: Array<Record<string, unknown>>) => Array<Record<string, unknown>>): void => {
		const pl: Record<string, unknown> = { ...(s.powerline ?? {}) };
		const items = Array.isArray(pl.customItems) ? (pl.customItems as Array<Record<string, unknown>>) : [];
		const next = fn(items);
		if (next.length > 0) pl.customItems = next;
		else delete pl.customItems;
		s.powerline = pl as PowerlineCfg["powerline"];
		writeSettings(s);
	};

	pi.registerCommand("gd-footer", {
		description: "gd segment for pi-powerline-footer: /gd-footer [on|off|status] (default on)",
		async handler(args: string) {
			const arg = (args ?? "").trim().toLowerCase();
			const settings = readSettings();
			const has = () => {
				const items = settings.powerline?.customItems;
				return Array.isArray(items) && items.some((i) => i.id === FOOTER_STATUS_KEY);
			};
			if (arg === "off") {
				if (!has()) return pi.sendMessage({ customType: "gd-footer", content: "gd-footer is already off.", display: true });
				itemsWith(settings, (items) => items.filter((i) => i.id !== FOOTER_STATUS_KEY));
				stopGpuStatusSafe();
				return pi.sendMessage({ customType: "gd-footer", content: "gd-footer: customItems entry removed. Run /reload if pi-powerline-footer is already loaded.", display: true });
			}
			if (arg === "status") {
				const lines = [
					`gd-footer entry in ${SETTINGS_PATH}: ${has() ? "present" : "missing (run /gd-footer on)"}`,
					`status poller: ${gpuPoll ? "running (30s)" : "stopped"}`,
					"money = gd customer key ledger (budget−spend, or −spend when unlimited) via /key/info; ● per running VAST GPU (yellow waiting for GPU / grey model loading / green ready / red launch failed); burn = summed $/h (red = burn alert); ⏱x.xh = ≥3h rented; ⚠x.xh = VAST money left < 1 day of work (GD_DAY_HOURS default 8)",
			];
				return pi.sendMessage({ customType: "gd-footer", content: lines.join("\n"), display: true });
			}
			if (has()) return pi.sendMessage({ customType: "gd-footer", content: "gd-footer is already on.", display: true });
			itemsWith(settings, (items) => [...items, { ...FOOTER_ITEM }]);
			pi.sendMessage({ customType: "gd-footer", content: "gd-footer: customItems entry added. Run /reload if pi-powerline-footer is already loaded.", display: true });
		},
	});
	function stopGpuStatusSafe(): void {
		// best-effort clear without a ctx (command handlers get their own ctx; this one is for the entry removal only)
		if (gpuPoll) {
			clearInterval(gpuPoll);
			gpuPoll = null;
		}
	}

	/**
	 * /gd-doctor — diagnose the gd provider from inside pi.
	 * pi's /model screen hides the underlying refresh error, so this reports
	 * the exact failure (credential state, network, HTTP status, model list).
	 */
	/**
	 * gd_deploy_gpu — check the gd VAST user's money (balance + credit are
	 * SEPARATE fields; either pays), reuse a running instance, else launch one
	 * and wait until the model is loaded. Takes 10–20 min on a cold launch.
	 */
	const GpuDeployParams = Type.Object({
		"max-price": Type.Optional(Type.Number({ description: "Max $/hr cap passed to the VAST launch (offer cap). Omit to take the top candidate's own rate." })),
	});
	pi.registerTool({
		name: "gd_deploy_gpu",
		label: "Deploy gd GPU",
		description: `Deploy (or reuse) the gd VAST overflow GPU and wait until its model is loaded. Checks the gd VAST user balance+credit first; a fresh launch takes 10-20 minutes — do not interrupt or re-invoke it while running. Returns the model id this session should switch to (usually ${GPU_MODEL_ID}).`,
		parameters: GpuDeployParams,
		async execute(_toolCallId, params, signal) {
			const progress: string[] = [];
			try {
				const res = await deployGpu({ maxPrice: params["max-price"], signal, log: (line) => progress.push(line) });
				const lines = [
					`gd GPU READY ${res.reused ? "(reused running instance, no new billing)" : "(new instance)"}: ${res.instance_id} at $${(res.hourly_rate ?? 0).toFixed(2)}/hr${res.gpu ? ` on ${res.gpu}` : ""}`,
					`model: ${res.model} (group includes the VAST overflow row; litellm row already unblocked by launch.py)`,
					`money: ${res.balance_note}`,
					`next: call gd_gpu_model with model "${res.model}" to point this session at it`,
				];
				return { content: [{ type: "text" as const, text: lines.join("\n") }], details: { ...res, progress: progress.slice(-10) } };
			} catch (e) {
				const tail = progress.slice(-10).join("\n");
				throw new Error(`${e instanceof Error ? e.message : String(e)}${tail ? `\n--- launcher output (tail) ---\n${tail}` : ""}`);
			}
		},
	});

	/**
	 * gd_gpu_model — point THIS pi session at a gd model (default the group
	 * that contains the VAST overflow row), validated against the live catalog.
	 */
	const GpuModelParams = Type.Object({
		model: Type.Optional(Type.String({ description: `gd model id to switch to (default ${GPU_MODEL_ID})` })),
	});
	pi.registerTool({
		name: "gd_gpu_model",
		label: "Use gd GPU model",
		description: `Switch this pi session to a gd proxy model. Default ${GPU_MODEL_ID} — the group that includes the VAST overflow GPU once gd_deploy_gpu has reported READY.`,
		parameters: GpuModelParams,
		async execute(_toolCallId, params) {
			const storedKey = credentialKey(getCredential(defaultAuthPath(), PROVIDER_ID));
			const key = storedKey ?? process.env[ENV_API_KEY];
			if (!key) throw new Error("no gd credential — run /login gd first");
			const id = params.model ?? GPU_MODEL_ID;
			const ids = await fetchModelIds(BASE_URL, key);
			if (ids.length > 0 && !ids.includes(id)) {
				throw new Error(`model ${id} not in the live gd catalog (${ids.length} models: ${ids.slice(0, 12).join(", ")}…)`);
			}
			await pi.setModel(toModel(id));
			return { content: [{ type: "text" as const, text: `pi session model → gd/${id}` }], details: { model: id } };
		},
	});

	/**
	 * /gd-gpu-on — create a gd VAST GPU instance (human switch-on).
	 * Defaults: datacenter-only (compliance), no price cap (top candidate
	 * rate), reuse a running instance, min balance floor $1.00.
	 * Params: [standard|premium] [model] [--price <max $/hr>] [--home-ok (test: allow non-DC)].
	 * A bare positional (other than the tier) is the vast/models.json model id
	 * (org-or6b.8), forwarded to scripts.launch --model.
	 * Runs detached (10–20 min) and messages back when READY.
	 */
	let gpuOnInFlight = false;
		pi.registerCommand("gd-gpu-on", {
			description: "Create a gd VAST GPU instance: /gd-gpu-on [standard|premium] [model] [--price <max $/hr>] [--home-ok]", 
			async handler(args: string) {
				if (gpuOnInFlight) {
					pi.sendMessage({ customType: "gd-gpu", content: "a /gd-gpu-on is already in flight — watch the footer (grey ●) or run /gd-gpu for status", display: true });
					return;
				}
				const parsed = parseGpuOnArgs(args);
				if (parsed.error) {
					pi.sendMessage({ customType: "gd-gpu", content: `gd-gpu-on: ${parsed.error}`, display: true });
					return;
				}
				gpuOnInFlight = true;
				const notes: string[] = [];
				const params = [parsed.tier ? `tier ${parsed.tier}` : "tier default ($VAST_TIER or standard)", parsed.model ? `model ${parsed.model}` : "model default (manifest: qwen3.8)", parsed.maxPrice !== undefined ? `cap $${parsed.maxPrice}/hr` : "no price cap (top candidate rate)", parsed.homeOk ? "TEST: non-datacenter allowed" : "datacenter-only"];
				pi.sendMessage({ customType: "gd-gpu", content: `gd-gpu-on: launching VAST instance (10–20 min incl. model download) — ${params.join(", ")} — footer dot: yellow=waiting for GPU, grey=model loading, green=READY.`, display: true });
				void deployGpu({ maxPrice: parsed.maxPrice, tier: parsed.tier, model: parsed.model, allowHome: parsed.homeOk, log: (l) => notes.push(l) })
				.then((res) => {
					pi.sendMessage({ customType: "gd-gpu", content: `gd-gpu READY: instance ${res.instance_id} @ $${(res.hourly_rate ?? 0).toFixed(2)}/hr${res.gpu ? ` on ${res.gpu}` : ""}${res.reused ? " (reused running instance)" : ""}, model ${res.model}\nbalance: ${res.balance_note}\n→ switch this session with the gd_gpu_model tool (default ${GPU_MODEL_ID}) or run /gd-gpu.`, display: true });
				})
				.catch((e) => {
					const tail = notes.slice(-8).join("\n");
					pi.sendMessage({ customType: "gd-gpu", content: `gd-gpu-on FAILED: ${e instanceof Error ? e.message : String(e)}${tail ? `\n--- launcher tail ---\n${tail}` : ""}`, display: true });
				})
				.finally(() => {
					gpuOnInFlight = false;
				});
			},
		});

	/**
	 * /gd-gpu-off [instance_id] — stop the billing: destroy the VAST instance
	 * and block the litellm -vast row (scripts.teardown). No id = current
	 * instance from state/label.
	 */
		pi.registerCommand("gd-gpu-off", {
			description: "Destroy the gd VAST GPU (stops billing) and block the litellm VAST row: /gd-gpu-off [instance_id]",
			async handler(args: string) {
				let instanceId: number | undefined;
				const tok = (args ?? "").trim();
				if (tok) {
					const n = Number(tok);
					if (!Number.isInteger(n) || n <= 0) {
						pi.sendMessage({ customType: "gd-gpu", content: `gd-gpu-off: instance_id must be a positive integer, got "${tok}"`, display: true });
						return;
					}
					instanceId = n;
				}
				pi.sendMessage({ customType: "gd-gpu", content: `gd-gpu-off: tearing down${instanceId ? ` instance ${instanceId}` : " the current instance"} (blocks the litellm VAST row first — down first) ...`, display: true });
				try {
					const res = await teardownGpu({ instanceId, log: () => {} });
					pi.sendMessage({ customType: "gd-gpu", content: res.ok ? `teardown OK\n${res.tail.split("\n").slice(-8).join("\n")}` : `teardown FAILED (non-zero exit)\n${res.tail}`, display: true });
				} catch (e) {
					pi.sendMessage({ customType: "gd-gpu", content: `teardown error: ${e instanceof Error ? e.message : String(e)}`, display: true });
				}
			},
		});

	/** /gd-gpu — status: ledger money, VAST account, running instances, burn, local state. */
		pi.registerCommand("gd-gpu", {
			description: "Status of gd GPU instances (ledger, VAST account, running, burn rate)",
			async handler() {
				const keys = readFooterKeys(FOOTER_DEFAULT_ENV);
				const gdKey = readGdKey();
				if (!keys.opsKey && !keys.vastKey && !gdKey) {
					pi.sendMessage({ customType: "gd-gpu", content: "gd-gpu: no gd/VAST credentials found (vast/config.env, auth.json) — nothing to show.", display: true });
					return;
				}
				const lines: string[] = ["gd GPU status"];
				const data = await collectGdStatus({ opsKey: keys.opsKey, vastKey: keys.vastKey, gdKey }).catch(() => null);
				if (data) {
					if (data.money) {
						lines.push(data.money.budget !== null ? `ledger: $${(data.money.budget - data.money.spend).toFixed(2)} available of $${data.money.budget.toFixed(2)} budget (spent $${data.money.spend.toFixed(2)})` : `ledger: -$${data.money.spend.toFixed(2)} spent (no budget set)`);
					}
					const gpus = data.gpus ?? [];
					const burn = gpus.reduce((s, g) => s + g.dph, 0);
					lines.push(`running: ${gpus.length} instance(s), burn $${burn.toFixed(2)}/hr`);
					for (const g of gpus) {
						const mark = g.state === "ready" ? "● " : g.state === "error" ? "✖ " : "○ ";
						lines.push(`  ${mark}$${g.dph.toFixed(2)}/hr — ${g.state}${g.error ? ` (${g.error})` : ""}`);
					}
					for (const a of computeBurnAlerts(data, Date.now(), dayHours())) lines.push(`burn alert [${a.kind}]: ${a.detail}`);
					if (data.vastUsd !== null && data.vastUsd !== undefined) lines.push(`vast money left (runway basis): $${data.vastUsd.toFixed(2)}`);
					if (data.apiError) lines.push(`last refresh error: ${data.apiError}`);
				} else {
					lines.push("status fetch failed (see footer !) — retry with /gd-gpu.");
				}
				if (keys.vastKey) {
					try {
						const acc = await fetchGdAccount(vastHome(), keys.vastKey);
						lines.push(`vast account: $${acc.balance.toFixed(2)} balance + $${acc.credit.toFixed(2)} credit = $${(acc.balance + acc.credit).toFixed(2)} usable`);
					} catch {
					lines.push("vast account: (unreachable)");
				}
			}
				const st = readGpuState(vastHome());
				if (st) lines.push(`local state: instance ${st.instance_id ?? "?"}, model ${st.model ?? "?"}, api ${st.api_base ?? "?"}, since ${st.launched_at ?? "?"}`);
				else lines.push("local state: none (no current instance)");
				if (data) lines.push(`footer: ${formatGdStatus(data).replace(/\x1b\[[0-9;]*m/g, "")}`);
				pi.sendMessage({ customType: "gd-gpu", content: lines.join("\n"), display: true });
			},
		});

	pi.registerCommand("gd-pay", {
		description: "Start a gd payment from Pi: /gd-pay tokens [5|10|25] [email], /gd-pay rental, or /gd-pay alone for account + guidance",
		async handler(args: string) {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const mode = parts[0] || "";
			const gdKey = readGdKey();
			let user = "";
			let flowLocked = false;
			if (gdKey) {
				try {
					const r = await fetch(`${BILLING_BASE}/account`, { headers: { "x-gd-key": gdKey } });
					if (r.ok) {
						const a = (await r.json()) as { user?: string; flow_locked?: boolean };
						user = a.user ?? "";
						flowLocked = !!a.flow_locked;
					}
				} catch { /* probe is best-effort */ }
			}
			if (mode === "tokens") {
				const size = (parts[1] || "5").trim();
				const pack = ["5", "10", "25"].includes(size) ? Number(size) : 0;
				if (!pack) {
					pi.sendMessage({ customType: "gd-pay", content: `gd-pay tokens: pack must be 5, 10 or 25 (got "${size}"). Usage: /gd-pay tokens [5|10|25] [email]`, display: true });
					return;
				}
				const email = (parts[2] || user || "").trim();
				if (!email) {
					pi.sendMessage({ customType: "gd-pay", content: "gd-pay tokens: need the email for this account. Pass it: /gd-pay tokens 10 you@email.com", display: true });
					return;
				}
				try {
					// gd_key: shared-account architecture (org-gxn.18.4) - all customer
					// keys live under one LiteLLM user, so the webhook must credit the
					// payer's actual gd key, not a per-email LiteLLM user.
					const r = await billingPost<{ checkout_url?: string }>("/checkout/tokens", { user_email: email, pack_usd: pack, gd_key: gdKey || undefined });
					if (!r.ok || !r.data?.checkout_url) {
						const body = JSON.stringify(r.data).slice(0, 240);
						pi.sendMessage({ customType: "gd-pay", content: `gd-pay tokens: checkout failed (HTTP ${r.status}) ${body}`, display: true });
						return;
					}
					openUrl(r.data.checkout_url);
					pi.sendMessage({ customType: "gd-pay", content: `gd-pay tokens: opened $${pack} token pack checkout for ${email}\n${r.data.checkout_url}`, display: true });
				} catch (e) {
					pi.sendMessage({ customType: "gd-pay", content: `gd-pay tokens error: ${e instanceof Error ? e.message : String(e)}`, display: true });
				}
				return;
			}
			if (mode === "rental") {
				const hint = flowLocked ? " (self-hosted flow is currently locked - the operator unlocks one at a time)" : "";
				pi.sendMessage({ customType: "gd-pay", content: `gd-pay rental: GPU rentals are quoted and unlocked one at a time by the operator${hint}. Contact us via girard-davila.net/models - once unlocked, the rental launches automatically.`, display: true });
				return;
			}
			const lines = [
				`gd-pay - payment from Pi${gdKey ? "" : " (no gd key stored - run /login gd first)"}`,
				"  /gd-pay tokens [5|10|25] [email]   buy token credits (Stripe checkout)",
				"  /gd-pay rental                    GPU rental (quoted + unlocked by the operator)",
				flowLocked ? "Self-hosted GPU flow is currently LOCKED (guided beta) - rentals are unlocked one at a time." : "",
				user ? `account: ${user}` : "",
			].filter(Boolean);
			pi.sendMessage({ customType: "gd-pay", content: lines.join("\n"), display: true });
		},
	});
	pi.registerCommand("gd-doctor", {
		description: `Diagnose the gd provider (credential + ${BASE_URL}/v1/models)`,
		async handler() {
			const lines: string[] = [];
			const storedKey = credentialKey(getCredential(defaultAuthPath(), PROVIDER_ID));
			const key = storedKey ?? process.env[ENV_API_KEY];
			lines.push(`gd-doctor — endpoint: ${BASE_URL}`);
			lines.push(
				`credential: ${key ? `found (${key.slice(0, 8)}…, from ${storedKey ? "auth.json" : ENV_API_KEY})` : "none — run /login gd"}`,
			);
			if (key) {
				try {
					const ids = await fetchModelIdsChecked(BASE_URL, key, { timeoutMs: 8000 });
					lines.push(`discovery: OK — ${ids.length} model(s): ${ids.join(", ")}`);
					const desired = process.env.GD_DEFAULT_MODEL ?? DEFAULT_MODEL_ID;
					lines.push(`default model would be: ${ids.includes(desired) ? desired : (ids[0] ?? desired)}`);
				} catch (e) {
					lines.push(`discovery FAILED: ${e instanceof Error ? e.message : String(e)}`);
					lines.push("If this is a network error, check connectivity from this machine, e.g.: curl -I " + BASE_URL + "/v1/models");
					lines.push("If the problem persists, contact the maintainer: Alexandre Girard <git@alexgirard.com> — please include this /gd-doctor output.");
				}
			}
			pi.sendMessage({ customType: "gd-doctor", content: lines.join("\n"), display: true });
		},
	});
}
