# pi-telegram-bridge

Telegram bot bridge for pi agents — send messages, ask questions, and listen for human replies via Telegram.

## Install

```bash
pi install npm:@bytesbrains/pi-telegram-bridge
```

## Configuration

Set the following environment variables:

```bash
export TELEGRAM_BOT_TOKEN="123456:ABC-DEF1234ghikl-zyx57W2v1u123ew11"
export TELEGRAM_CHAT_ID="123456789"
```

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | ✅ | Bot token from [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_CHAT_ID` | ✅ | Target chat ID (your personal chat or a group) |

## Tools

### telegram_listen

Check for new inbound messages from the human.

```
telegram_listen()
```

### telegram_send

Send a one-way message. Use for status updates and progress reports.

```
telegram_send(message="Build completed successfully ✅")
```

### telegram_ask

Ask a question with inline keyboard options and **wait** for a human reply. Blocks until answered or timeout (default 30 min).

```
telegram_ask(question="Deploy to production?")
telegram_ask(question="Which branch?", options=["main", "staging", "dev"])
telegram_ask(question="Approve this change?", options=["Approve", "Reject", "Need changes"], timeoutMinutes=5)
```

### telegram_override

Ask a human to approve or reject a blocked action (force push, destructive git ops, file deletion, etc.). Designed for supervisor override flows. Returns `details.action = "proceed"|"abort"|"explain"` so the agent can call `supervisor_override()` or abort.

```
telegram_override(
  command="git push gitea feat/add-check --force",
  reason="Force push can overwrite remote history"
)

telegram_override(
  command="rm -rf node_modules",
  reason="Recursive deletion outside project boundary",
  context="User requested a clean reinstall of dependencies",
  options=["Yes, it's fine", "No, cancel", "Use npx instead", "Explain more"],
  timeoutMinutes=10
)
```

**Parameters:**
| Param | Required | Default | Description |
|-------|----------|---------|-------------|
| `command` | ✅ | — | The blocked command or action |
| `reason` | ✅ | — | Why it was blocked by the supervisor |
| `context` | ❌ | — | Additional context (what the user asked for, etc.) |
| `options` | ❌ | `["Yes, proceed", "No, cancel", "Explain more"]` | Custom button labels |
| `timeoutMinutes` | ❌ | `30` | How long to wait for a response |

**Returns `details`:**
| Field | Type | Description |
|-------|------|-------------|
| `choice` | `string` | The exact button label the human clicked |
| `action` | `string` | `"proceed"` (first option), `"abort"` (second option), or `"explain"` (anything else) |
| `command` | `string` | The original blocked command |
| `timedOut` | `boolean` | Whether the request timed out |

**Agent workflow:**
1. Agent gets blocked by supervisor
2. Calls `telegram_override(command, reason, context)`
3. Checks `details.action`:
   - `"proceed"` → call `supervisor_override(reason, command)`
   - `"abort"` → tell user action was cancelled
   - `"explain"` → call `telegram_send(message="...")` with more context, then re-ask
4. If `details.timedOut` → abort the action

### telegram_status

Check if the bridge is configured and running.

```
telegram_status()
```

## Background Listener

The extension starts a background listener on session start that polls for incoming Telegram messages. Any non-bot text message in the configured chat is forwarded to the agent as a user message. The agent responds with a confirmation.

The listener runs automatically — no manual setup needed.

## How It Works

1. **Session start**: The bridge restores the last processed update ID from session state and starts polling
2. **Inbound messages**: Non-bot text messages in the configured chat are forwarded to the agent
3. **Session end**: The listener stops cleanly on session shutdown
4. **Update ID is persisted** across sessions to avoid processing duplicate messages

## Get a Bot Token

1. Open Telegram and chat with [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts
3. Copy the token and set `TELEGRAM_BOT_TOKEN`
4. Send a message to your bot, then visit:
   `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
5. Copy the `chat.id` from the response and set `TELEGRAM_CHAT_ID`

## Requirements

- Node.js >= 18
- A Telegram bot token
- A chat ID to send/receive messages

## License

MIT

---

Built and maintained by [BytesBrains](https://bytesbrains.com) — AI automation & agents, engineered to production standards.
*The model proposes, code guarantees.*
