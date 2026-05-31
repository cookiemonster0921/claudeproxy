// Persistent session store for cross-instance Cloud Run continuation.
// Talks to the Claude proxy's /cloud-sessions endpoint backed by D1.

export interface StoredCloudSession {
	cr_session_id?: string;
	cr_summary?: string;
	cr_updated_at?: string;
}

function proxyBase(): string {
	// ANTHROPIC_BASE_URL points to the proxy — reuse it for our session API
	return (process.env.ANTHROPIC_BASE_URL ?? '').replace(/\/+$/, '');
}

export async function loadSession(channelId: string): Promise<StoredCloudSession | null> {
	const base = proxyBase();
	if (!base) return null;
	try {
		const resp = await fetch(`${base}/cloud-sessions?channel_id=${encodeURIComponent(channelId)}`, {
			headers: proxyAuthHeaders(),
		});
		if (!resp.ok) return null;
		return (await resp.json()) as StoredCloudSession | null;
	} catch (e) {
		console.error('[session-store] loadSession failed:', e instanceof Error ? e.message : e);
		return null;
	}
}

export async function saveSession(
	channelId: string,
	sessionId: string | undefined,
	summary: string,
): Promise<void> {
	const base = proxyBase();
	if (!base) return;
	try {
		await fetch(`${base}/cloud-sessions`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...proxyAuthHeaders() },
			body: JSON.stringify({
				channel_id: channelId,
				cr_session_id: sessionId ?? null,
				cr_summary: summary,
			}),
		});
	} catch (e) {
		console.error('[session-store] saveSession failed:', e instanceof Error ? e.message : e);
	}
}

function proxyAuthHeaders(): Record<string, string> {
	const token = process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.PROXY_TOKEN;
	return token ? { Authorization: `Bearer ${token}` } : {};
}
