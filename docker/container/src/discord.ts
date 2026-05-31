// Discord bot API helpers for async notifications

const DISCORD_API = 'https://discord.com/api/v10';

export async function sendChannelMessage(
	botToken: string,
	channelId: string,
	content: string,
): Promise<void> {
	// Discord max message length is 2000 chars
	const chunks = splitMessage(content, 2000);
	for (const chunk of chunks) {
		await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
			method: 'POST',
			headers: {
				Authorization: `Bot ${botToken}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ content: chunk }),
		});
	}
}

export async function sendProgressUpdate(
	botToken: string,
	channelId: string,
	runId: string,
	preview: string,
): Promise<void> {
	const short = preview.length > 500 ? preview.slice(0, 500) + '…' : preview;
	await sendChannelMessage(
		botToken,
		channelId,
		`⏳ **Agent progress** (\`${runId.slice(0, 8)}\`)\n\`\`\`\n${short}\n\`\`\``,
	);
}

function splitMessage(text: string, maxLen: number): string[] {
	if (text.length <= maxLen) return [text];
	const chunks: string[] = [];
	let i = 0;
	while (i < text.length) {
		chunks.push(text.slice(i, i + maxLen));
		i += maxLen;
	}
	return chunks;
}
