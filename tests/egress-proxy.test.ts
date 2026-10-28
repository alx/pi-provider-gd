/**
 * Tests for egress-proxy.ts (org-vk8i.30).
 *
 * Run with: node --test tests/   (Node >= 24: native TS type-stripping)
 *
 * Order matters: applyEgressProxy() is sticky for the process, so the
 * no-op test must run before the proxy tests (node:test preserves order).
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as http from "node:http";
import {
	applyEgressProxy,
	egressProxied,
	gdFetch,
} from "../src/egress-proxy.ts";
import { getGlobalDispatcher } from "undici";

const save = process.env.PI_EGRESS_PROXY;

test("no-op when PI_EGRESS_PROXY is unset", async () => {
	const saved = process.env.PI_EGRESS_PROXY;
	delete process.env.PI_EGRESS_PROXY;
	try {
		const before = getGlobalDispatcher();
		applyEgressProxy();
		assert.ok(!egressProxied());
		assert.strictEqual(getGlobalDispatcher(), before);
		// and gdFetch still works against a plain origin
		const srv = http.createServer((_, res) => res.end("direct"));
		await new Promise<void>((r) => srv.listen(0, r));
		try {
			const port = (srv.address() as import("node:net").AddressInfo).port;
			const res = await gdFetch(`http://127.0.0.1:${port}/`);
			assert.equal(await res.text(), "direct");
		} finally {
			srv.close();
		}
	} finally {
		if (saved !== undefined) process.env.PI_EGRESS_PROXY = saved;
	}
});

test("routes fetch() through the proxy when PI_EGRESS_PROXY is set", async () => {
	// Minimal absolute-form proxy: answers any request with a marker body.
	const seen: string[] = [];
	const proxy = http.createServer((req, res) => {
		seen.push(req.url ?? "?");
		res.writeHead(200, { "content-type": "text/plain" });
		res.end("PROXIED");
	});
	await new Promise<void>((r) => proxy.listen(0, r));
	const port = (proxy.address() as import("node:net").AddressInfo).port;
	process.env.PI_EGRESS_PROXY = `http://127.0.0.1:${port}`;
	applyEgressProxy();
	assert.ok(egressProxied());
	assert.strictEqual(getGlobalDispatcher().constructor.name, "ProxyAgent");

	// gdFetch must hit the proxy, not the (nonexistent) origin.
	const res = await gdFetch("http://egress-test.invalid/");
	assert.equal(await res.text(), "PROXIED");
	assert.deepEqual(seen, ["http://egress-test.invalid/"]);

	proxy.close();
	// restore for other suites in this process
	if (save === undefined) delete process.env.PI_EGRESS_PROXY;
	else process.env.PI_EGRESS_PROXY = save;
});
