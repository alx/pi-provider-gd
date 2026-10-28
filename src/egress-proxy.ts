/**
 * pi-gateway egress proxy support (org-vk8i.30).
 *
 * Farm instances have NO direct internet egress (host iptables rejects it);
 * all public HTTP(S) must flow through the allowlist proxy at PI_EGRESS_PROXY
 * (e.g. http://192.168.112.10:3128). Node's global fetch does not honor
 * HTTP(S)_PROXY, so extension code uses gdFetch():
 *   - PI_EGRESS_PROXY set   → npm-undici fetch with a ProxyAgent dispatcher
 *   - PI_EGRESS_PROXY unset → plain global fetch (desktop, unchanged)
 *
 * Note: this covers fetches made BY THIS PACKAGE. pi core's own model stream
 * is not interceptable from userland — on the farm that is why instances
 * point GD_BASE_URL at the LAN LiteLLM (http://192.168.112.1:4000) instead
 * of the public origin.
 */
import {
	ProxyAgent,
	fetch as undiciFetch,
	getGlobalDispatcher,
	setGlobalDispatcher,
} from "undici";

let proxied = false;

/**
 * Install a ProxyAgent for this process when PI_EGRESS_PROXY is set.
 * No-op otherwise. Safe to call multiple times.
 */
export function applyEgressProxy(): void {
	const url = process.env.PI_EGRESS_PROXY;
	if (!url || proxied) return;
	setGlobalDispatcher(new ProxyAgent(url));
	proxied = true;
}

/**
 * fetch() that honors the egress proxy when configured. Drop-in for the
 * global fetch at all pi-provider-gd call sites.
 */
export function gdFetch(
	input: string | URL | Request,
	init?: RequestInit,
): Promise<Response> {
	if (proxied) {
		return undiciFetch(input as string | URL | Request, init as any);
	}
	return fetch(input, init);
}

/** True when this process is routing fetch() through the egress proxy. */
export function egressProxied(): boolean {
	return proxied;
}

export { getGlobalDispatcher };
