# pi-telegram-bridge

Telegram bot bridge for pi agents — send messages, ask questions, receive photos, and get a live project dashboard on "hi".

## Install

```bash
pi install npm:@bytesbrains/pi-telegram-bridge@1.1.6
```

## Quick Setup

### 1. Create a bot with @BotFather

Open Telegram and chat with [@BotFather](https://t.me/BotFather):

```
/newbot
```

Follow the prompts. You'll get a token like:

```
123456:ABC-DEF1234ghikl-zyx57W2v1u123ew11
```

### 2. Get your Chat ID

Send ANY message to your new bot on Telegram, then visit this URL in your browser:

```
https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
```

Look for `"chat":{"id":123456789}` in the response. That's your chat ID.

> **For group chats:** Add the bot to a group, send a message mentioning the bot, then check the same URL. Use the group chat ID.

### 3. Set environment variables

```bash
export TELEGRAM_BOT_TOKEN="123456:ABC-DEF1234ghikl-zyx57W2v1u123ew11"
export TELEGRAM_CHAT_ID="123456789"
```

Add them to your shell profile (`~/.zshrc`, `~/.bashrc`) to persist across sessions.

### 4. Verify

Start pi and run `telegram_status()`. You should see:

```
Active. Bot: @your_bot_name (listener: 🟢 running)
```

## Environment Variables

| Variable             | Required | Default                 | Description                                                     |
| -------------------- | -------- | ----------------------- | --------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN` | ✅       | —                       | Bot token from @BotFather                                       |
| `TELEGRAM_CHAT_ID`   | ✅       | —                       | Chat ID to send/receive messages                                |
| `TELEGRAM_MENTION`   | ❌       | `@pi` (or bot username) | Only respond to messages containing this mention in group chats |

### TELEGRAM_MENTION

Controls which messages the agent responds to in **group chats**:

```bash
# Use a custom mention trigger
export TELEGRAM_MENTION="@mybot"

# Or let it auto-detect from the bot username
export TELEGRAM_MENTION=""   # defaults to @bot_username
```

- **Private chat** (direct message to bot): All messages are treated as directed — no mention needed
- **Group chat**: Only messages containing `@botname` are forwarded to the agent. Everything else is ignored.

## Features

### Status Dashboard

Send `hi`, `/status`, or `status` to your bot on Telegram. It replies with a live project summary:

```
📊 pi-ext Status

📋 Open Issues: 3
   #1 telegram-bridge HTML parse crash
   #5 status dashboard on hi message

🔀 Open PRs: 2
   ✅ #2 fix(telegram-bridge): escape HTML entities

🔧 Last CI: ⏳ queued (5 recent runs)
```

### Photo Support

**Send photos to the agent:** Send any photo to the bot — the agent downloads it and can use `read()` to view it. Add a caption for context:

> 📸 Photo: `login page broken, 404 in console`

**Send photos from the agent:** Use `telegram_send_photo()` to share screenshots or diagrams:

```
telegram_send_photo(photoPath="/tmp/screenshot.png", caption="Build output")
```

### @Mention Support

In group chats, the bot only responds to messages that mention it. This lets humans talk freely without triggering the agent.

| Chat type | Message                  | Bot responds?                            |
| --------- | ------------------------ | ---------------------------------------- |
| Private   | `hi`                     | ✅                                       |
| Private   | `@pi what's the status?` | ✅ (mention stripped)                    |
| Group     | `hi`                     | ❌                                       |
| Group     | `@pi what's the status?` | ✅ (agent receives `what's the status?`) |

## Tools

### telegram_listen

Check for new inbound messages (text and photos) from the human.

```
telegram_listen()
```

Returns photo paths and captions if a photo was received.

### telegram_send

Send a one-way text message.

```
telegram_send(message="Build completed successfully ✅")
```

### telegram_send_photo

Send a photo — supports local file paths and remote URLs.

```
telegram_send_photo(photoPath="/tmp/screenshot.png")
telegram_send_photo(photoPath="/tmp/screenshot.png", caption="Error in console")
telegram_send_photo(photoPath="https://example.com/image.jpg")
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

## Requirements

- Node.js >= 18
- A Telegram bot token (from @BotFather)
- A chat ID

## License

MIT
