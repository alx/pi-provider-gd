/**
 * Tests for src/provider.ts model mapping.
 *
 * The regression this guards: the provider used to hardcode a 4096-token output
 * cap while the backend allows 8192. Undersizing maxTokens makes the upstream
 * stop with finish_reason "length", which pi renders as
 * "Response was truncated before completion." on otherwise-fine long answers.
 */
import { test } from "node:test";
import * as assert from "node:assert/strict";

import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, toModel } from "../src/provider.ts";

test("toModel: uses proxy-reported limits when available", () => {
	const model = toModel("some-deployment", { maxInputTokens: 200_000, maxOutputTokens: 16_384 });
	assert.equal(model.contextWindow, 200_000);
	assert.equal(model.maxTokens, 16_384);
	assert.equal(model.id, "some-deployment");
});

test("toModel: falls back to documented backend limits for aliases without model/info entries", () => {
	const model = toModel("qwen3.8-27b", undefined);
	assert.equal(model.contextWindow, DEFAULT_CONTEXT_WINDOW);
	assert.equal(model.maxTokens, DEFAULT_MAX_TOKENS);
});

test("toModel: partial limits fall back per-field, not wholesale", () => {
	const model = toModel("partial", { maxOutputTokens: 8192 });
	assert.equal(model.maxTokens, 8192);
	assert.equal(model.contextWindow, DEFAULT_CONTEXT_WINDOW);
});

test("toModel: default output cap is large enough that normal answers are not truncated", () => {
	// The old value was 4096; anything at or below that reintroduces the bug.
	assert.ok(DEFAULT_MAX_TOKENS > 4096, `DEFAULT_MAX_TOKENS=${DEFAULT_MAX_TOKENS} must exceed the old 4096 cap`);
});
