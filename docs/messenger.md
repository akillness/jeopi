# Messenger Gateway Architecture and Configuration

`jeopi messenger` is a headless, bidirectional text gateway connecting authorized **Discord**, **Telegram**, and **Slack** bots directly to isolated agent sessions.

It is designed for personal assistants, team developer bots, and remote coding companions without exposing local ports or maintaining public infrastructure.

## Key Highlights

- **Zero Inbound Ingress**: Discord Gateway and Slack Socket Mode connect via outbound WebSockets (`wss://`). Telegram connects via outbound HTTPS long polling. No public IP, webhook endpoints, cloud relays, or tunnel tools (like ngrok or cloudflared) are required.
- **Strict Identity Allowlists**: Every platform requires an exact list of authorized human IDs (`allowedUserIds`). Wildcards and empty allowlists are strictly rejected at validation.
- **Multi-Tenant History Isolation**: Session histories are isolated on disk by `[platform, accountId, channelId, threadId, senderId]` and `cwd`. Even in shared channels or group chats, two users never share or leak session transcripts.
- **Fail-Closed Tool Sandboxing**: By default, `toolNames` is empty (`[]`). Remote bots operate in pure conversational text mode without filesystem or command-execution authority. Tools (`read`, `grep`, `glob`, `bash`, `edit`, `write`) must be explicitly opted into.
- **Local Dry-Run Verification**: `jeopi messenger check` verifies configuration syntax, schema, and environment variable presence completely offline without making external network calls.

---

## Architecture and Lifecycle

```text
 ┌──────────────────────┐   Outbound WebSocket (v10)   ┌─────────────────────────┐
 │   Discord Gateway    │ ◄─────────────────────────── │                         │
 └──────────────────────┘                              │                         │
 ┌──────────────────────┐   Outbound HTTPS Long Poll   │     jeopi messenger     │
 │  Telegram Bot API    │ ◄─────────────────────────── │         Gateway         │
 └──────────────────────┘                              │                         │
 ┌──────────────────────┐   Outbound WebSocket         │  (Loopback Dispatcher)  │
 │  Slack Socket Mode   │ ◄─────────────────────────── │                         │
 └──────────────────────┘                              └────────────┬────────────┘
                                                                    │
                                       ┌────────────────────────────┴────────────────────────────┐
                                       │                  Session Bridge Router                  │
                                       │   Route Key: [platform, account, channel, thread, user] │
                                       └────────────────────────────┬────────────────────────────┘
                                                                    │
                                       ┌────────────────────────────▼────────────────────────────┐
                                       │                   Headless AgentSession                 │
                                       │  - Isolated Settings & Working Tree (cwd)               │
                                       │  - Constrained Active Tools (toolNames whitelist)       │
                                       │  - Private Transcripts (0700 dir / 0600 files)          │
                                       └─────────────────────────────────────────────────────────┘
```

### Transport Mechanisms

1. **Telegram Adapter (`packages/coding-agent/src/messenger/telegram.ts`)**:
   - Calls `getMe` on startup to verify identity and fetch the bot's username.
   - Polls `getUpdates` with `timeout: 25` and `allowed_updates: ["message"]`.
   - Mentions (`@YourBot`) and addressed bot commands (`/ask@YourBot ...`) are stripped from incoming text before prompting the agent.
   - Forum topics in supergroups are mapped to `threadId` via `message_thread_id`.
   - Outbound replies are split into chunks of up to 4,096 characters.
   - **Constraint**: Cannot run alongside an active webhook. If previously used with a webhook, call `deleteWebhook` before starting.

2. **Discord Adapter (`packages/coding-agent/src/messenger/discord.ts`)**:
   - Requests Gateway v10 via `https://discord.com/api/v10/gateway/bot`.
   - Opens an outbound WebSocket connection (`wss://gateway.discord.gg`).
   - Requests Gateway Intents: `GUILD_MESSAGES (512)`, `DIRECT_MESSAGES (4096)`, and `MESSAGE_CONTENT (32768)`.
   - Automatically negotiates heartbeats (Opcode 1 / Opcode 10) and handles Gateway Resumes (Opcode 6).
   - In servers/guilds, the bot must be mentioned (`<@bot_id>`). Mentions are stripped before passing text to the agent.
   - Threads are treated as their own distinct channels using Discord's thread channel Snowflake ID.
   - Outbound replies are split into chunks of up to 2,000 characters.

3. **Slack Adapter (`packages/coding-agent/src/messenger/slack.ts`)**:
   - Uses **Socket Mode** (`apps.connections.open`) with an App-Level Token (`xapp-...`).
   - Opens an outbound WebSocket connection to Slack's edge.
   - Listens for `events_api` envelopes containing `message.im` and `app_mention` events.
   - Mentions (`<@bot_user_id>`) in channels are stripped before prompt processing.
   - Replies to channel messages are automatically threaded (`thread_ts`). Direct messages are unthreaded unless the incoming message was already part of a thread.
   - Outbound replies are split into chunks of up to 4,000 characters with a 1-second delay between chunks.

---

## Configuration Reference (`messenger.json`)

Configuration files should be placed in a secure, private directory outside public repositories.

```json
{
  "cwd": "./workspace",
  "sessionDir": "./sessions",
  "toolNames": [],
  "platforms": {
    "telegram": {
      "tokenEnv": "JEOPI_TELEGRAM_BOT_TOKEN",
      "allowedUserIds": ["123456789"],
      "allowedChannelIds": ["-1001234567890"]
    },
    "discord": {
      "tokenEnv": "JEOPI_DISCORD_BOT_TOKEN",
      "allowedUserIds": ["123456789012345678"],
      "allowedChannelIds": ["987654321098765432"]
    },
    "slack": {
      "tokenEnv": "JEOPI_SLACK_BOT_TOKEN",
      "appTokenEnv": "JEOPI_SLACK_APP_TOKEN",
      "allowedUserIds": ["U1234567890"],
      "allowedChannelIds": ["C1234567890"]
    }
  }
}
```

### Top-Level Properties

| Property | Type | Default | Description |
| --- | --- | --- | --- |
| `cwd` | `string` | `"."` | Working directory where the agent runs and resolves workspace paths. Relative paths resolve against the directory containing `messenger.json`. |
| `sessionDir` | `string` | `".jeopi/messenger-sessions"` | Directory where conversation session files are saved. Created on the first accepted message with `0700` permissions. |
| `toolNames` | `string[]` | `[]` | Whitelist of tools exposed to remote chats. Supported values: `"read"`, `"grep"`, `"glob"`, `"bash"`, `"edit"`, `"write"`. Leave empty for pure text chats. |
| `platforms` | `object` | (Required) | Mapping of configured platforms. At least one platform (`telegram`, `discord`, or `slack`) must be defined. |

### Platform Properties

#### `telegram`
- `tokenEnv` (*string*, default: `"JEOPI_TELEGRAM_BOT_TOKEN"`): Name of the environment variable containing the Telegram bot token from `@BotFather`.
- `allowedUserIds` (*string[]*, required): Array of exact numeric Telegram user IDs (`from.id`) permitted to interact with the bot.
- `allowedChannelIds` (*string[]*, optional): Array of exact chat/group IDs (`chat.id`) permitted. For supergroups/groups, include the leading negative sign (e.g. `"-100..."`).

#### `discord`
- `tokenEnv` (*string*, default: `"JEOPI_DISCORD_BOT_TOKEN"`): Name of the environment variable containing the Discord Bot Token from the Developer Portal.
- `allowedUserIds` (*string[]*, required): Array of exact Snowflake user IDs permitted to interact with the bot.
- `allowedChannelIds` (*string[]*, optional): Array of exact channel or thread Snowflake IDs permitted. When omitted, allowed users can communicate in any channel or DM where the bot has access.

#### `slack`
- `tokenEnv` (*string*, default: `"JEOPI_SLACK_BOT_TOKEN"`): Name of the environment variable containing the Bot User OAuth Token (starts with `xoxb-`).
- `appTokenEnv` (*string*, default: `"JEOPI_SLACK_APP_TOKEN"`): Name of the environment variable containing the App-Level Token with `connections:write` scope (starts with `xapp-`).
- `allowedUserIds` (*string[]*, required): Array of exact Slack Member IDs (e.g. `"U1234567890"`).
- `allowedChannelIds` (*string[]*, optional): Array of exact Channel IDs (`"C..."`) or DM IDs (`"D..."`).

---

## Security Boundaries and Threat Model

1. **Token Protection**:
   - `messenger.json` stores **environment variable names**, never raw tokens.
   - Do not commit token values, echo tokens in terminal scripts, or include credentials in logs.
2. **Strict Identity Verification**:
   - Every platform requires non-empty, unique exact IDs in `allowedUserIds`. Wildcards (`*`), spaces, or empty strings cause immediate parse failure.
   - Unauthorized senders are discarded silently without error replies or diagnostic echoes.
3. **Session Transcript Separation**:
   - Session keys combine `[platform, accountId, channelId, threadId, senderId]` and the workspace `cwd`.
   - Separate human users always receive independent agent sessions, even when interacting within the same shared group or thread.
4. **Dangerous Tool Permissions Warning**:
   - `toolNames` defaults to `[]` (no tools). Remote sessions do not load workspace context files, skills, custom tools, extensions, MCP, or LSP.
   - If `"bash"`, `"edit"`, or `"write"` are enabled, authorized remote users have execution and write authority on the local machine under the OS user running `jeopi`.
   - `cwd` is a starting location, not a chroot or filesystem jail. If tools are needed, run `jeopi messenger` inside a dedicated, isolated container or virtual machine.
5. **Session File Protection**:
   - The session directory is created with mode `0700`, and transcript files are saved with mode `0600`.

---

## Operating the Gateway

### 1. Offline Dry-Run Validation (`check`)

Validates file syntax, allowlists, path formats, and ensures referenced environment variables exist and are non-empty:

```sh
jeopi messenger check --config /path/to/messenger.json
```

Output on success:
```text
Messenger configuration valid: telegram, discord, slack; 0 tools enabled. No network checks performed.
```

### 2. Live Execution (`run`)

Starts the outbound adapters and connects to enabled platforms:

```sh
jeopi messenger run --config /path/to/messenger.json
```

Output on start:
```text
Starting messenger: telegram, discord, slack. Press Ctrl+C to stop.
```

Stop the gateway cleanly at any time with `Ctrl+C` (SIGINT) or `SIGTERM`.

---

## Platform Setup Guides

Step-by-step setup guides for each platform:

- [Telegram Bot Setup Guide](messenger/telegram.md)
- [Discord Bot Setup Guide](messenger/discord.md)
- [Slack Socket Mode App Setup Guide](messenger/slack.md)

---

## Agent Skill Installation

To let AI coding agents (jeopi, Claude Code, Codex, Cursor, Aside) manage, configure, and operate the messenger gateway, install the `jeopi-messenger` skill:

```sh
# Universal install via skills CLI
npx skills add akillness/jeopi --skill jeopi-messenger

# Or install manually into your project
mkdir -p .agents/skills/jeopi-messenger
cp -r /path/to/jeopi/skills/jeopi-messenger/* .agents/skills/jeopi-messenger/
```

See [skills/jeopi-messenger/SKILL.md](../skills/jeopi-messenger/SKILL.md) for full instructions.
