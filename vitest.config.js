import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				remoteBindings: false,
				wrangler: { configPath: "./wrangler.jsonc" },
				miniflare: {
					// Force Workers AI routing in tests so .dev.vars MODEL/API keys don't interfere.
					// Disable analytics in tests — D1 migration hasn't been run against test DB.
					bindings: { MODEL: "workers_ai", ANALYTICS_ENABLED: "false" },
				},
			},
		},
	},
});
