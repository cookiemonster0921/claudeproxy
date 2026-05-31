function hexToBytes(hex: string): Uint8Array {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < hex.length; i += 2) {
		bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
	}
	return bytes;
}

export async function verifyDiscordRequest(
	request: Request,
	publicKey: string,
): Promise<{ valid: boolean; body: string }> {
	const signature = request.headers.get('x-signature-ed25519');
	const timestamp = request.headers.get('x-signature-timestamp');
	const body = await request.text();

	if (!signature || !timestamp || !publicKey) return { valid: false, body };

	try {
		const key = await crypto.subtle.importKey(
			'raw',
			hexToBytes(publicKey),
			{ name: 'Ed25519' },
			false,
			['verify'],
		);
		const valid = await crypto.subtle.verify(
			'Ed25519',
			key,
			hexToBytes(signature),
			new TextEncoder().encode(timestamp + body),
		);
		return { valid, body };
	} catch {
		return { valid: false, body };
	}
}
