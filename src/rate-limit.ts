// In-memory rate limiter: sliding window + concurrency cap (per-Worker-isolate)

export class GlobalRateLimiter {
	private slots: number[] = []; // timestamps of recent acquisitions
	private blockedUntilMs = 0;
	private activeConcurrency = 0;

	constructor(
		private readonly rateLimit: number,
		private readonly rateWindowMs: number,
		private readonly maxConcurrency: number,
	) {}

	async acquire(): Promise<() => void> {
		await this.waitIfBlocked();
		await this.acquireSlot();
		while (this.activeConcurrency >= this.maxConcurrency) {
			await sleep(50);
		}
		this.activeConcurrency++;
		return () => {
			this.activeConcurrency--;
		};
	}

	setBlocked(seconds: number): void {
		this.blockedUntilMs = Date.now() + seconds * 1000;
	}

	private async waitIfBlocked(): Promise<void> {
		while (Date.now() < this.blockedUntilMs) {
			await sleep(Math.min(this.blockedUntilMs - Date.now(), 500));
		}
	}

	private async acquireSlot(): Promise<void> {
		while (true) {
			const now = Date.now();
			this.slots = this.slots.filter((t) => now - t < this.rateWindowMs);
			if (this.slots.length < this.rateLimit) {
				this.slots.push(now);
				return;
			}
			await sleep(100);
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
