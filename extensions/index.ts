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
 *   /login gd      — either paste an API key created at
 *                    https://api.girard-davila.net/api/llm/ui/ or sign in via
 *                    browser SSO (GitHub → issued key); the key is stored in
 *                    ~/.pi/agent/auth.json under "gd". No hand-editing, no
 *                    separate pi-provider-litellm install.
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
import { deployGpu, GPU_MODEL_ID, teardownGpu } from "../src/gpu.ts";
import { FOOTER_DEFAULT_ENV, collectGdStatus, formatGdStatus, readFooterKeys, readGdKey } from "../src/gpu-status.ts";

const DEFAULT_MODEL_DISCOVER_TIMEOUT_MS = 4000;

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
	// this package):  [gd <ledger €> ●● <burn €/h>]
	//   money  = api.girard-davila.net ledger of the gd customer key
	//            (LiteLLM /key/info: budget - spend; no budget → -spend)
	//   dots   = one ● per running VAST instance
	//            grey=starting, green=ready, red=error
	//   burn   = summed $/h of running instances
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
					"money = gd customer key ledger (budget−spend, or −spend when unlimited) via /key/info; ● per running VAST GPU (grey up / green ready / red error); burn = summed $/h.",
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
	 * /teardown-gpu — stop the billing: destroy the VAST instance and block
	 * the litellm -vast row (scripts.teardown). The on-switch is gd_deploy_gpu.
	 */
	pi.registerCommand("teardown-gpu", {
		description: "Tear down the gd VAST GPU instance (stops billing) and block the litellm VAST row",
		async handler() {
			const lines: string[] = [];
			try {
				const res = await teardownGpu({ log: (l) => lines.push(l) });
				pi.sendMessage({ customType: "teardown-gpu", content: res.ok ? `teardown OK\n${res.tail.split("\n").slice(-8).join("\n")}` : `teardown FAILED (code≠0)\n${res.tail}`, display: true });
			} catch (e) {
				pi.sendMessage({ customType: "teardown-gpu", content: `teardown error: ${e instanceof Error ? e.message : String(e)}`, display: true });
			}
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
