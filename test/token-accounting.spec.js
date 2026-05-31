import { describe, it, expect } from "vitest";
import {
	buildTokenAccounting,
	classifyRequest,
	estimateRequestTokens,
	hasRetryHeader,
} from "../src/token-accounting";
import { parseAnthropicSSE } from "../src/proxy-service";
import { logAnalytics } from "../src/analytics";

describe("analytics token accounting", () => {
	it("uses provider usage for successful non-streaming billable tokens", () => {
		const estimates = estimateRequestTokens({
			model: "claude-sonnet-4-6",
			max_tokens: 128,
			messages: [{ role: "user", content: "hello" }],
		});
		const accounting = buildTokenAccounting(
			estimates,
			{ input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 3 },
			99,
			200,
		);
		expect(accounting.billable_input_tokens).toBe(12);
		expect(accounting.billable_output_tokens).toBe(4);
		expect(accounting.cached_input_tokens).toBe(3);
		expect(accounting.provider_usage_found).toBe(true);
		expect(accounting.provider_usage_json).toContain('"input_tokens":12');
	});

	it("parses successful streaming usage from message_delta", () => {
		const sse = [
			'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-6","usage":{"input_tokens":999,"output_tokens":0}}}\n\n',
			'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
			'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello world"}}\n\n',
			'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
			'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":22,"output_tokens":5,"cache_creation_input_tokens":7}}\n\n',
			'event: message_stop\ndata: {"type":"message_stop"}\n\n',
		].join("");
		const parsed = parseAnthropicSSE(sse, "fallback", 1);
		expect(parsed.providerUsage).toEqual({
			input_tokens: 22,
			output_tokens: 5,
			cache_creation_input_tokens: 7,
		});
		expect(parsed.estimatedOutputTokens).toBe(3);
		expect(parsed.message.usage.input_tokens).toBe(22);
	});

	it("does not bill estimated context for 429 responses", () => {
		const estimates = { estimated_context_tokens: 55000, estimated_prompt_tokens: 10, estimated_tool_result_tokens: 0 };
		const accounting = buildTokenAccounting(estimates, undefined, 0, 429);
		expect(classifyRequest("hello", 429, "rate_limit_error")).toBe("rate_limited");
		expect(accounting.billable_input_tokens).toBe(0);
		expect(accounting.billable_output_tokens).toBe(0);
		expect(accounting.failed_request_tokens).toBe(55000);
	});

	it("keeps fake/no-provider-usage output as an estimate, not billable usage", () => {
		const estimates = { estimated_context_tokens: 20, estimated_prompt_tokens: 20, estimated_tool_result_tokens: 0 };
		const accounting = buildTokenAccounting(estimates, undefined, 6, 200);
		expect(accounting.provider_usage_found).toBe(false);
		expect(accounting.billable_input_tokens).toBe(0);
		expect(accounting.billable_output_tokens).toBe(0);
	});

	it("classifies tool-result and skill-result request previews", () => {
		expect(classifyRequest("[Result: ok]")).toBe("tool_result");
		expect(classifyRequest("[Result: Launching skill: imagegen]")).toBe("skill_result");
		expect(
			estimateRequestTokens({
				model: "claude-sonnet-4-6",
				max_tokens: 128,
				messages: [
					{
						role: "user",
						content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "x".repeat(40) }],
					},
				],
			}).estimated_tool_result_tokens,
		).toBe(10);
	});

	it("marks retry-like rows without adding billable cost", () => {
		const headers = new Headers({ "x-stainless-retry-count": "2" });
		const estimates = { estimated_context_tokens: 1000, estimated_prompt_tokens: 1, estimated_tool_result_tokens: 0 };
		const first = buildTokenAccounting(estimates, undefined, 0, 429);
		const retry = buildTokenAccounting(estimates, undefined, 0, 429);
		expect(hasRetryHeader(headers)).toBe(true);
		expect(first.billable_input_tokens + retry.billable_input_tokens).toBe(0);
		expect(first.failed_request_tokens + retry.failed_request_tokens).toBe(2000);
	});

	it("inserts all analytics token-accounting fields", async () => {
		let bound = [];
		const db = {
			prepare() {
				return {
					bind(...args) {
						bound = args;
						return { run: () => Promise.resolve() };
					},
				};
			},
		};
		await logAnalytics(db, {
			id: "req_1",
			timestamp: "2026-05-26T00:00:00.000Z",
			method: "POST",
			path: "/v1/messages",
			model: "claude-sonnet-4-6",
			provider: "workers_ai",
			stream: false,
			status_code: 200,
			success: true,
			duration_ms: 10,
			approximate_input_tokens: 20,
			approximate_output_tokens: 5,
			estimated_cost_usd: 0.1,
			estimated_context_tokens: 20,
			estimated_prompt_tokens: 5,
			estimated_tool_result_tokens: 0,
			billable_input_tokens: 12,
			billable_output_tokens: 4,
			cached_input_tokens: 3,
			failed_request_tokens: 0,
			request_kind: "normal",
			was_retry: false,
			retry_count: 0,
			provider_usage_json: '{"input_tokens":12,"output_tokens":4}',
			error_type: undefined,
			fallback_used: false,
			user_agent: "test",
			client_ip_hash: undefined,
			prompt_snapshot: undefined,
			response_snapshot: undefined,
			tool_snapshot: undefined,
			source: undefined,
			discord_guild_id: undefined,
			discord_channel_id: undefined,
			discord_command: undefined,
		});
		expect(bound).toHaveLength(35);
		expect(bound).toContain("normal");
		expect(bound).toContain('{"input_tokens":12,"output_tokens":4}');
	});
});
