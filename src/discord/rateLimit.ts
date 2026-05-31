interface Bucket {
	slots: number[];
	windowMs: number;
	maxHits: number;
}

const buckets = new Map<string, Bucket>();

export function checkRateLimit(key: string, windowMs: number, maxHits: number): boolean {
	const now = Date.now();
	let bucket = buckets.get(key);
	if (!bucket) {
		bucket = { slots: [], windowMs, maxHits };
		buckets.set(key, bucket);
	}
	// Evict expired slots
	bucket.slots = bucket.slots.filter((t) => now - t < windowMs);
	if (bucket.slots.length >= maxHits) return false;
	bucket.slots.push(now);
	return true;
}

// 10 commands per minute per user
export function checkUserLimit(userId: string): boolean {
	return checkRateLimit(`user:${userId}`, 60_000, 10);
}

// 30 commands per minute per channel
export function checkChannelLimit(channelId: string): boolean {
	return checkRateLimit(`channel:${channelId}`, 60_000, 30);
}

// 100 commands per minute per guild
export function checkGuildLimit(guildId: string): boolean {
	return checkRateLimit(`guild:${guildId}`, 60_000, 100);
}
