import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";

describe("claude-code-cf-proxy", () => {
	it("GET /health returns ok (unit style)", async () => {
		const request = new Request("http://example.com/health");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.ok).toBe(true);
		expect(body.service).toBe("claude-code-cf-proxy");
	});

	it("GET /health returns ok (integration style)", async () => {
		const response = await SELF.fetch("http://example.com/health");
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.ok).toBe(true);
	});

	it("GET /v1/models returns model list", async () => {
		const response = await SELF.fetch("http://example.com/v1/models");
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.object).toBe("list");
		expect(body.data.length).toBeGreaterThan(0);
		// Workers AI models always present (no key required)
		expect(body.data.map((m) => m.id)).toContain("cf-llama");
		// All IDs must match one of the known provider prefixes / short-name patterns
		expect(body.data.every((m) =>
			m.id.startsWith("cf-") ||          // Workers AI short names
			m.id.startsWith("gemini-") ||      // Google AI short names (GEMINI_MODEL_ALIASES)
			m.id.startsWith("openrouter/") ||  // OpenRouter qualified IDs
			m.id.startsWith("nvidia_nim/")     // NVIDIA NIM qualified IDs
		)).toBe(true);
		// Models include display_name and owned_by fields
		expect(body.data[0].display_name).toBeTruthy();
		expect(body.data[0].owned_by).toBeTruthy();
	});

	it("POST /v1/messages/count_tokens returns token estimate", async () => {
		const response = await SELF.fetch("http://example.com/v1/messages/count_tokens", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "cf-llama",
				messages: [{ role: "user", content: "Hello world" }],
			}),
		});
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(typeof body.input_tokens).toBe("number");
		expect(body.input_tokens).toBeGreaterThan(0);
	});

	it("OPTIONS returns CORS preflight headers", async () => {
		const response = await SELF.fetch("http://example.com/v1/messages", { method: "OPTIONS" });
		expect(response.status).toBe(204);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
	});

	it("POST /v1/messages with unknown model returns 400", async () => {
		const response = await SELF.fetch("http://example.com/v1/messages", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "does-not-exist",
				max_tokens: 100,
				messages: [{ role: "user", content: "hi" }],
			}),
		});
		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body.type).toBe("error");
	});

	it("POST /v1/messages converts Workers AI tool calls to Anthropic tool_use blocks", async () => {
		const calls = [];
		const fakeEnv = {
			...env,
			AI: {
				run(model, input) {
					calls.push({ model, input });
					return Promise.resolve({
						response: "",
						usage: { prompt_tokens: 12, completion_tokens: 4 },
						tool_calls: [{ name: "Bash", arguments: { command: "pwd" } }],
					});
				},
			},
		};
		const request = new Request("http://example.com/v1/messages", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "claude-sonnet-4-6",
				max_tokens: 128,
				messages: [{ role: "user", content: "run pwd" }],
				tools: [
					{
						name: "Bash",
						description: "Run a shell command",
						input_schema: {
							type: "object",
							properties: { command: { type: "string", description: "Command to run" } },
							required: ["command"],
						},
					},
				],
			}),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, fakeEnv, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.model).toBe("claude-sonnet-4-6");
		expect(body.stop_reason).toBe("tool_use");
		expect(body.content).toMatchObject([
			{ type: "tool_use", name: "Bash", input: { command: "pwd" } },
		]);
		expect(calls[0].input.tools[0]).toMatchObject({
			type: "function",
			function: { name: "Bash" },
		});
		expect(calls[0].input.max_tokens).toBe(128);
	});

	it("POST /v1/messages streams Anthropic tool_use events", async () => {
		const fakeEnv = {
			...env,
			AI: {
				run() {
					return Promise.resolve({
						response: "",
						tool_calls: [{ name: "Read", arguments: { file_path: "README.md" } }],
					});
				},
			},
		};
		const request = new Request("http://example.com/v1/messages", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "claude-sonnet-4-6",
				max_tokens: 128,
				stream: true,
				messages: [{ role: "user", content: "read README" }],
				tools: [{ name: "Read", input_schema: { type: "object", properties: {} } }],
			}),
		});

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, fakeEnv, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		const body = await response.text();
		expect(body).toContain("event: content_block_start");
		expect(body).toContain('"type":"tool_use"');
		expect(body).toContain('"name":"Read"');
		expect(body).toContain('"stop_reason":"tool_use"');
	});

	it("unknown route returns 404", async () => {
		const response = await SELF.fetch("http://example.com/not-a-real-path");
		expect(response.status).toBe(404);
	});
});
