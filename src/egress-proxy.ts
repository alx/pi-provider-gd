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
	type Request as UndiciRequest,
	type Response as UndiciResponse,
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
 *
 * Type note: with lib dom + @types/node, the global Response/Request are
 * Node's (undici-backed) declarations, which are not structurally identical
 * to the undici package's own Response/Request. At runtime they ARE the same
 * objects (Node's global fetch is undici's fetch), so the two casts below
 * are type-level only.
 */
export function gdFetch(
	input: string | URL | Request,
	init?: RequestInit,
): Promise<Response> {
	if (proxied) {
		// undiciFetch's parameter type is its own Request; a node/dom Request
		// is the same runtime object, so cast through the package type.
		const uInput =
			typeof input === "string" || input instanceof URL
				? input
				: (input as unknown as UndiciRequest);
		const p = undiciFetch(uInput, init as any) as Promise<UndiciResponse>;
		return p.then((r) => r as unknown as Response);
	}
	return fetch(input, init);
}

/** True when this process is routing fetch() through the egress proxy. */
export function egressProxied(): boolean {
	return proxied;
}

export { getGlobalDispatcher };
