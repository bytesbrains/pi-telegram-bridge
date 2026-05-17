/**
 * pi-telegram-bridge — Telegram Bot Bridge
 *
 * Tools: telegram_listen, telegram_send, telegram_ask, telegram_override, telegram_status
 * Config: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID environment variables
 *
 * Starts a background listener on session start that polls for incoming
 * messages and forwards them to the agent as user messages.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	getToken,
	getChatId,
	telegramApi,
	sendMsg,
	sendPhoto,
	getFileUrl,
	downloadFile,
	pollReply,
	getBotId,
	seedLastUpdateId,
	pollUpdates,
} from "./helpers";
import * as path from "node:path";
import * as os from "node:os";
import {
	listenSchema,
	sendSchema,
	askSchema,
	statusSchema,
	overrideSchema,
	notifySchema,
	sendPhotoSchema,
} from "./tools/telegram";

export default function telegramBridge(pi: ExtensionAPI) {
	let botId: number | null = null;
	let listenerAbort: AbortController | null = null;
	let lastUpdateId = 0;
	let mentionTrigger = "@pi"; // configurable via TELEGRAM_MENTION env var
	const sessionStartTime = Date.now();
	let messageCount = 0;

	// ── Mention support ────────────────────────────────────────────

	async function resolveMentionTrigger(): Promise<string> {
		// 1. Explicit env var overrides everything
		const envMention = process.env.TELEGRAM_MENTION;
		if (envMention)
			return envMention.startsWith("@") ? envMention : "@" + envMention;
		// 2. Try bot username from getMe
		try {
			const r = (await telegramApi("getMe", {})) as {
				result: { username: string };
			};
			if (r.result?.username) return "@" + r.result.username;
		} catch {
			/* fall through */
		}
		return "@pi";
	}

	/** Strip mention from message text and return cleaned text + whether it was mentioned. */
	function checkMention(
		text: string,
		isPrivateChat: boolean,
	): { mentioned: boolean; cleanedText: string } {
		if (isPrivateChat) return { mentioned: true, cleanedText: text };
		const trigger = mentionTrigger.slice(1).toLowerCase(); // strip @
		const patterns = [
			new RegExp(`@${trigger}\\b`, "i"), // @pi at start or middle
			new RegExp(`^${trigger}\\b`, "i"), // pi at start (no @)
		];
		for (const re of patterns) {
			if (re.test(text)) {
				const cleaned = text.replace(re, "").trim();
				return { mentioned: true, cleanedText: cleaned || text };
			}
		}
		return { mentioned: false, cleanedText: text };
	}

	// ── Dashboard helper ────────────────────────────────────────────

	async function sendDashboard() {
		const token = getToken();
		const giteaToken = process.env.GITEA_TOKEN || process.env.GIT_TOKEN || "";
		const apiBase = "http://127.0.0.1:3001/api/v1/repos/factory/pi-ext";
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (giteaToken) headers["Authorization"] = `token ${giteaToken}`;

		try {
			const [issuesR, prsR, runsR] = await Promise.all([
				fetch(`${apiBase}/issues?state=open&limit=10`, { headers })
					.then((r) => r.json())
					.catch(() => []),
				fetch(`${apiBase}/pulls?state=open&limit=10`, { headers })
					.then((r) => r.json())
					.catch(() => []),
				fetch(`${apiBase}/actions/runs?limit=3`, { headers })
					.then((r) => r.json())
					.catch(() => ({ workflow_runs: [] })),
			]);

			const issues = Array.isArray(issuesR) ? issuesR : [];
			const prs = Array.isArray(prsR) ? prsR : [];
			const runs = (runsR as any).workflow_runs ?? [];

			const lines: string[] = [];
			lines.push("📊 <b>pi-ext Status</b>");
			lines.push("");

			// Open issues
			lines.push(`📋 <b>Open Issues:</b> ${issues.length}`);
			if (issues.length > 0) {
				for (const i of (issues as any[]).slice(0, 5)) {
					const labels = i.labels?.length
						? ` [${i.labels.map((l: any) => l.name).join(", ")}]`
						: "";
					lines.push(`   #${i.number} ${i.title.slice(0, 60)}${labels}`);
				}
			} else {
				lines.push("   (none)");
			}
			lines.push("");

			// Open PRs
			lines.push(`🔀 <b>Open PRs:</b> ${prs.length}`);
			if (prs.length > 0) {
				for (const p of (prs as any[]).slice(0, 5)) {
					const mergeIcon = p.mergeable ? "✅" : "❌";
					lines.push(`   ${mergeIcon} #${p.number} ${p.title.slice(0, 55)}`);
				}
			} else {
				lines.push("   (none)");
			}
			lines.push("");

			// CI status
			if (runs.length > 0) {
				const latest = runs[0];
				const statusIcon =
					latest.status === "success"
						? "✅"
						: latest.status === "failure"
							? "❌"
							: latest.status === "running"
								? "🔄"
								: "⏳";
				lines.push(
					`🔧 <b>Last CI:</b> ${statusIcon} ${latest.status} (${runs.length} recent runs)`,
				);
			} else {
				lines.push("🔧 <b>Last CI:</b> no runs");
			}
			lines.push("");

			// Session metrics
			const uptimeMin = Math.floor((Date.now() - sessionStartTime) / 60000);
			const uptimeStr =
				uptimeMin < 60
					? `${uptimeMin}m`
					: `${Math.floor(uptimeMin / 60)}h ${uptimeMin % 60}m`;
			lines.push("🤖 <b>Session</b>");
			lines.push(`   Uptime: ${uptimeStr}`);
			lines.push(`   Messages: ${messageCount}`);
			lines.push(`   Mention: ${mentionTrigger}`);

			await sendMsg(lines.join("\n"), undefined, "HTML");
		} catch {
			await sendMsg(
				"⚠️ Could not fetch project dashboard. Gitea may be unreachable.",
			);
		}
	}

	// ── Session lifecycle ───────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		// Ensure photo download directory exists
		const { mkdir } = await import("node:fs/promises");
		const photoDir = path.join(os.tmpdir(), "telegram-photos");
		await mkdir(photoDir, { recursive: true }).catch(() => {});
		// Restore lastUpdateId from session state
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === "tg-last-update") {
				lastUpdateId = (entry.data as { update_id: number }).update_id;
			}
		}
		// Skip listener if Telegram is not configured
		if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
			console.warn(
				"pi-telegram-bridge: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set. Listener disabled.",
			);
			return;
		}
		// Start background listener
		try {
			mentionTrigger = await resolveMentionTrigger();
			startListener();
		} catch (e: unknown) {
			console.warn(
				"pi-telegram-bridge: Failed to start listener:",
				e instanceof Error ? e.message : e,
			);
		}
	});

	pi.on("session_shutdown", () => {
		listenerAbort?.abort();
		listenerAbort = null;
	});

	// ── Background listener ─────────────────────────────────────────

	async function startListener() {
		if (listenerAbort) return; // already running
		listenerAbort = new AbortController();
		const signal = listenerAbort.signal;
		const token = getToken();
		const chatId = getChatId();

		// Get bot's own ID once to filter out self-messages
		if (!botId) {
			botId = await getBotId();
		}

		// Seed lastUpdateId
		lastUpdateId = await seedLastUpdateId(lastUpdateId, signal);

		// Create photo download directory
		const fsPromises = await import("node:fs/promises");
		const photoDir = path.join(os.tmpdir(), "telegram-photos");
		await fsPromises.mkdir(photoDir, { recursive: true }).catch(() => {});

		// Fire and forget — poll in background
		pollUpdates(
			token,
			chatId,
			botId,
			lastUpdateId,
			signal,
			// onMessage: forward to pi (with mention check in groups), or dashboard on "hi"
			async (text: string, msgChatId: string) => {
				const isPrivate = msgChatId === chatId;
				const { mentioned, cleanedText } = checkMention(text, isPrivate);
				if (!mentioned) return; // ignore unmentioned messages in groups

				const trimmed = cleanedText.trim().toLowerCase();
				if (trimmed === "hi" || trimmed === "/status" || trimmed === "status") {
					await sendDashboard();
					return;
				}
				messageCount++;
				pi.sendUserMessage(cleanedText);
				await sendMsg(
					`👂 Got it! Working on: _${cleanedText.slice(0, 100)}_`,
					undefined,
					"Markdown",
				);
			},
			// onPhoto: download and forward photo + caption to pi
			async (photoId: string, caption?: string) => {
				const timestamp = Date.now();
				const filename = `photo_${timestamp}.jpg`;
				const destPath = path.join(photoDir, filename);
				const result = await downloadFile(photoId, destPath);
				if (result) {
					const captionText = caption ? `\n\n📝 Caption: ${caption}` : "";
					pi.sendUserMessage(
						`📸 Photo received from Telegram\nPath: ${result}${captionText}\n\nUse read("${result}") to view the image.`,
					);
					await sendMsg("📸 Photo received! Processing...");
				} else {
					pi.sendUserMessage(
						"📸 Photo received from Telegram but could not be downloaded.",
					);
					await sendMsg(
						"⚠️ Could not download your photo. Please check the bot configuration.",
					);
				}
			},
			// onUpdateId: persist offset
			(id: number) => {
				lastUpdateId = id;
				pi.appendEntry("tg-last-update", { update_id: id });
			},
		);
	}

	// ── Tools ───────────────────────────────────────────────────────

	// telegram_listen
	pi.registerTool({
		name: "telegram_listen",
		label: "Telegram Listen",
		description:
			"Check Telegram for any new inbound messages from the human. Returns the latest message text, or indicates no new messages.",
		parameters: listenSchema,
		async execute() {
			try {
				const token = getToken();
				const chatId = getChatId();
				if (!botId) botId = await getBotId();

				const res = await fetch(
					`https://api.telegram.org/bot${token}/getUpdates`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ offset: lastUpdateId + 1, timeout: 5 }),
					},
				);
				if (!res.ok)
					return {
						content: [{ type: "text", text: "Could not reach Telegram." }],
						details: { message: "" },
						isError: true,
					};

				const data = (await res.json()) as {
					ok: boolean;
					result: Array<{
						update_id: number;
						message?: {
							message_id: number;
							chat: { id: number };
							from?: { id: number; is_bot?: boolean };
							text?: string;
						};
						callback_query?: unknown;
					}>;
				};
				if (!data.ok)
					return {
						content: [{ type: "text", text: "Telegram API error." }],
						details: { message: "" },
						isError: true,
					};

				for (const u of data.result) {
					lastUpdateId = u.update_id;
					pi.appendEntry("tg-last-update", { update_id: lastUpdateId });
					if (u.callback_query) continue;
					if (u.message && String(u.message.chat.id) === chatId) {
						if (u.message.from?.is_bot || u.message.from?.id === botId)
							continue;
						// Photo message
						if (u.message.photo && u.message.photo.length > 0) {
							const photoId =
								u.message.photo[u.message.photo.length - 1].file_id;
							const caption = u.message.caption || "";
							const timestamp = Date.now();
							const fsPromises = await import("node:fs/promises");
							const photoDirLocal = path.join(os.tmpdir(), "telegram-photos");
							await fsPromises
								.mkdir(photoDirLocal, { recursive: true })
								.catch(() => {});
							const destFile = path.join(
								photoDirLocal,
								`photo_${timestamp}.jpg`,
							);
							const result = await downloadFile(photoId, destFile);
							const captionInfo = caption ? `\nCaption: "${caption}"` : "";
							if (result) {
								return {
									content: [
										{
											type: "text",
											text: `📸 Photo received from Telegram\nPath: ${result}${captionInfo}\n\nUse read("${result}") to view the image.`,
										},
									],
									details: {
										message: caption,
										photoPath: result,
										hasPhoto: true,
									},
								};
							}
							return {
								content: [
									{
										type: "text",
										text: `📸 Photo received from Telegram but could not be downloaded.${captionInfo}`,
									},
								],
								details: {
									message: caption,
									hasPhoto: true,
									downloadFailed: true,
								},
							};
						}
						// Text message
						if (u.message.text) {
							return {
								content: [
									{
										type: "text",
										text: `📩 New message: "${u.message.text}"`,
									},
								],
								details: { message: u.message.text },
							};
						}
					}
				}
				return {
					content: [{ type: "text", text: "No new messages." }],
					details: { message: "" },
				};
			} catch (e: unknown) {
				return {
					content: [
						{
							type: "text",
							text: `Failed: ${e instanceof Error ? e.message : e}`,
						},
					],
					details: { message: "" },
					isError: true,
				};
			}
		},
	});

	// telegram_send
	pi.registerTool({
		name: "telegram_send",
		label: "Telegram Send",
		description: "Send a one-way message to Telegram. Use for status updates.",
		parameters: sendSchema,
		async execute(_id: string, params: { message: string }) {
			try {
				const mid = await sendMsg(params.message);
				return {
					content: [{ type: "text", text: `Sent (id:${mid})` }],
					details: {},
				};
			} catch (e: unknown) {
				return {
					content: [
						{
							type: "text",
							text: `Failed: ${e instanceof Error ? e.message : e}`,
						},
					],
					details: {},
					isError: true,
				};
			}
		},
	});

	// telegram_ask
	pi.registerTool({
		name: "telegram_ask",
		label: "Telegram Ask",
		description:
			"Ask a question on Telegram and WAIT for a human reply. BLOCKS until you answer. Use when you need human input.",
		parameters: askSchema,
		async execute(
			_id: string,
			params: {
				question: string;
				options?: string[];
				timeoutMinutes?: number;
			},
		) {
			try {
				const chatId = getChatId();
				const opts = params.options ?? ["Yes", "No", "Explain"];
				const kb = opts.map((o: string) => [{ text: o, callback_data: o }]);
				const timeoutMs = (params.timeoutMinutes ?? 30) * 60000;
				const mid = await sendMsg(
					`❓ *${params.question}*`,
					{
						inline_keyboard: kb,
					},
					"Markdown",
				);
				const reply = await pollReply(mid, chatId, timeoutMs);
				if (!reply) {
					await sendMsg("⏰ No reply. Proceeding autonomously.");
					return {
						content: [
							{ type: "text", text: "Timeout — proceeding autonomously" },
						],
						details: { timedOut: true, answer: "" },
					};
				}
				return {
					content: [{ type: "text", text: `Reply: "${reply}"` }],
					details: { timedOut: false, answer: reply },
				};
			} catch (e: unknown) {
				return {
					content: [
						{
							type: "text",
							text: `Failed: ${e instanceof Error ? e.message : e}`,
						},
					],
					details: { timedOut: false, answer: "" },
					isError: true,
				};
			}
		},
	});

	// telegram_override
	pi.registerTool({
		name: "telegram_override",
		label: "Telegram Override",
		description:
			"Ask a human on Telegram to approve or reject a blocked action. " +
			"Use when the supervisor blocks a dangerous command (force push, " +
			"destructive git ops, file deletion, etc.) and you need human approval. " +
			"Returns the human's choice so you can call supervisor_override or abort.",
		parameters: overrideSchema,
		async execute(
			_id: string,
			params: {
				command: string;
				reason: string;
				context?: string;
				options?: string[];
				timeoutMinutes?: number;
			},
		) {
			try {
				const chatId = getChatId();
				const opts = params.options ?? [
					"Yes, proceed",
					"No, cancel",
					"Explain more",
				];
				const timeoutMs = (params.timeoutMinutes ?? 30) * 60000;

				let message = `🛑 <b>Supervisor blocked an action</b>\n\n`;
				message += `<b>Command:</b> <code>${params.command.slice(0, 200)}</code>\n`;
				message += `<b>Reason:</b> ${params.reason.slice(0, 300)}\n`;
				if (params.context) {
					message += `<b>Context:</b> ${params.context.slice(0, 300)}\n`;
				}
				message += `\n<i>What should I do?</i>`;

				const kb = opts.map((o: string) => [{ text: o, callback_data: o }]);
				const mid = await sendMsg(message, { inline_keyboard: kb }, "HTML");
				const reply = await pollReply(mid, chatId, timeoutMs);

				if (!reply) {
					await sendMsg("⏰ No reply to override request. Aborting action.");
					return {
						content: [
							{
								type: "text",
								text: "Timeout — no human response. Action aborted.",
							},
						],
						details: {
							timedOut: true,
							action: "abort",
							command: params.command,
							choice: "",
						},
					};
				}

				// Map the reply to an action
				const choice = reply.trim();
				let action: string;
				if (choice === opts[0]) {
					action = "proceed";
				} else if (choice === opts[1]) {
					action = "abort";
				} else {
					action = "explain";
				}

				await sendMsg(
					`✅ Choice received: <i>${choice}</i>`,
					undefined,
					"HTML",
				);

				return {
					content: [
						{
							type: "text",
							text: `Human chose: "${choice}" → action: ${action}`,
						},
					],
					details: {
						choice,
						action,
						command: params.command,
						timedOut: false,
					},
				};
			} catch (e: unknown) {
				return {
					content: [
						{
							type: "text",
							text: `Failed: ${e instanceof Error ? e.message : e}`,
						},
					],
					details: {
						timedOut: false,
						action: "",
						command: "",
						choice: "",
					},
					isError: true,
				};
			}
		},
	});

	// telegram_notify — rich formatted notifications
	pi.registerTool({
		name: "telegram_notify",
		label: "Telegram Notify",
		description:
			"Send a rich, well-formatted notification to Telegram. " +
			"Choose a kind: issue, pr, task, pipeline, session, alert, " +
			"factory-job, standup, diff, decision, or ack. " +
			"Fill the matching fields for that kind. " +
			"All other fields are ignored — only provide fields relevant to your chosen kind.",
		parameters: notifySchema,
		async execute(_id: string, params: Record<string, unknown>) {
			try {
				const { buildNotification } = await import("./templates");
				const message = buildNotification(
					params as unknown as import("./templates").NotifyInput,
				);
				const mid = await sendMsg(message, undefined, "HTML");
				return {
					content: [{ type: "text", text: `Notification sent (id:${mid})` }],
					details: {},
				};
			} catch (e: unknown) {
				return {
					content: [
						{
							type: "text",
							text: `Failed: ${e instanceof Error ? e.message : e}`,
						},
					],
					details: {},
					isError: true,
				};
			}
		},
	});

	// telegram_send_photo
	pi.registerTool({
		name: "telegram_send_photo",
		label: "Send Photo",
		description:
			"Send a photo to the Telegram chat. Supports local file paths and remote URLs.",
		parameters: sendPhotoSchema,
		async execute(
			_id: string,
			params: { photoPath: string; caption?: string },
		) {
			try {
				const mid = await sendPhoto(params.photoPath, params.caption);
				return {
					content: [{ type: "text", text: `Photo sent (id:${mid})` }],
					details: { messageId: mid },
				};
			} catch (e: unknown) {
				return {
					content: [
						{
							type: "text",
							text: `Failed to send photo: ${e instanceof Error ? e.message : e}`,
						},
					],
					details: {},
					isError: true,
				};
			}
		},
	});

	// telegram_status
	pi.registerTool({
		name: "telegram_status",
		label: "Telegram Status",
		description: "Check if the Telegram bridge is configured and running.",
		parameters: statusSchema,
		async execute() {
			if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
				return {
					content: [
						{
							type: "text",
							text: "Not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.",
						},
					],
					details: {},
				};
			}
			try {
				const r = (await telegramApi("getMe", {})) as {
					result: { username: string };
				};
				return {
					content: [
						{
							type: "text",
							text: `Active. Bot: @${r.result.username} (listener: ${listenerAbort ? "🟢 running" : "🔴 stopped"})`,
						},
					],
					details: {},
				};
			} catch {
				return {
					content: [{ type: "text", text: "Token set but unreachable." }],
					details: {},
				};
			}
		},
	});
}
