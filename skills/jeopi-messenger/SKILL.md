---
name: jeopi-messenger
description: Configure, validate, run, and troubleshoot jeopi's bidirectional messenger gateway for Discord, Telegram, and Slack text bots. Use when connecting jeopi to chat platforms, managing messenger.json configuration, checking environment credentials, setting up bot tokens, or debugging gateway connections.
---

# jeopi-messenger

Operate and manage `jeopi messenger` — a headless, bidirectional text gateway connecting Discord Gateway (WebSocket), Telegram (long polling), and Slack Socket Mode (WebSocket) directly to isolated jeopi agent sessions without public HTTP ingress, webhooks, or tunnels.

## When to Use This Skill

- User wants to interact with jeopi remotely via Discord, Telegram, or Slack.
- Creating or editing `messenger.json` configuration files.
- Setting up bot credentials (`JEOPI_DISCORD_BOT_TOKEN`, `JEOPI_TELEGRAM_BOT_TOKEN`, `JEOPI_SLACK_BOT_TOKEN`, `JEOPI_SLACK_APP_TOKEN`).
- Running dry-run validation (`jeopi messenger check --config <file>`).
- Running the live messenger gateway daemon (`jeopi messenger run --config <file>`).
- Troubleshooting bot connection failures, missing message intents, permission errors, or allowlist drops.

---

## Operating Protocol for Agents

### Phase 1: Planning and Platform Requirements

Before generating configurations, identify which chat platforms the user wants to connect:

1. **Telegram**:
   - Requires Bot Token from [@BotFather](https://t.me/BotFather) (`JEOPI_TELEGRAM_BOT_TOKEN`).
   - Requires exact numeric Telegram User ID for `allowedUserIds` (e.g. from `@userinfobot`).
   - Group chats require negative chat IDs in `allowedChannelIds` (e.g. `"-100..."`).
   - Active webhooks must be cleared using `deleteWebhook` before starting long polling.
   - Privacy Mode on BotFather determines if plain `@mentions` work or addressed commands (`/ask@YourBot`) are needed.

2. **Discord**:
   - Requires Bot Token from the [Discord Developer Portal](https://discord.com/developers/applications) (`JEOPI_DISCORD_BOT_TOKEN`).
   - **Critical Requirement**: **Message Content Intent** must be enabled under Bot -> Privileged Gateway Intents (or gateway crashes with close code `4014`).
   - Bot invite needs `bot` scope with permissions: View Channels, Send Messages, Read Message History, Send Messages in Threads.
   - Requires Developer Mode enabled in Discord to copy exact Snowflake IDs for `allowedUserIds` and `allowedChannelIds`.
   - Mentions are required in server channels (`<@bot_id>`); DMs do not require mentions.

3. **Slack**:
   - Requires an App created at [api.slack.com/apps](https://api.slack.com/apps).
   - **Socket Mode**: Enabled with App-Level Token (`xapp-...`) having `connections:write` scope (`JEOPI_SLACK_APP_TOKEN`).
   - **OAuth Bot Token**: (`xoxb-...`) with scopes `chat:write`, `app_mentions:read`, `im:history` (`JEOPI_SLACK_BOT_TOKEN`).
   - **Event Subscriptions**: Enabled with bot events `message.im` and `app_mention`.
   - **App Home**: Messages Tab enabled for direct messaging.
   - User Member ID (`U...`) and Channel ID (`C...` or `D...`). Channel replies are threaded.

---

### Phase 2: Configuration Construction (`messenger.json`)

Construct a private `messenger.json` outside the public repository tree:

```json
{
  "cwd": "./workspace",
  "sessionDir": "./sessions",
  "toolNames": [],
  "platforms": {
    "telegram": {
      "tokenEnv": "JEOPI_TELEGRAM_BOT_TOKEN",
      "allowedUserIds": ["TELEGRAM_USER_ID"],
      "allowedChannelIds": ["TELEGRAM_CHAT_ID"]
    },
    "discord": {
      "tokenEnv": "JEOPI_DISCORD_BOT_TOKEN",
      "allowedUserIds": ["DISCORD_USER_ID"],
      "allowedChannelIds": ["DISCORD_CHANNEL_OR_THREAD_ID"]
    },
    "slack": {
      "tokenEnv": "JEOPI_SLACK_BOT_TOKEN",
      "appTokenEnv": "JEOPI_SLACK_APP_TOKEN",
      "allowedUserIds": ["SLACK_MEMBER_ID"],
      "allowedChannelIds": ["SLACK_CHANNEL_OR_DM_ID"]
    }
  }
}
```

#### Security Boundaries for Agents:
- **Never embed raw tokens in `messenger.json`**: Store only the *name* of the environment variable (e.g. `"tokenEnv": "JEOPI_DISCORD_BOT_TOKEN"`).
- **Tool Authorization**: Default `toolNames` to `[]`. Only add `"read"`, `"grep"`, `"glob"`, `"bash"`, `"edit"`, or `"write"` if the user explicitly asks for tool capabilities, and explicitly warn the user that tools grant remote execution on the host machine.
- **Strict Allowlists**: Never output wildcards or empty allowlists; they are rejected by the parser.

---

### Phase 3: Verification and Launch

1. **Check Environment Variables**:
   Verify that the configured token environment variables exist in the current environment:
   ```sh
   test -n "$JEOPI_DISCORD_BOT_TOKEN" && echo "Discord token present"
   ```

2. **Run Offline Validation**:
   ```sh
   jeopi messenger check --config /path/to/messenger.json
   ```
   Confirm output: `Messenger configuration valid: <platforms>; <N> tools enabled. No network checks performed.`

3. **Start the Messenger Gateway**:
   ```sh
   jeopi messenger run --config /path/to/messenger.json
   ```
   Monitor standard output: `Starting messenger: <platforms>. Press Ctrl+C to stop.`

4. **Verify Communication**:
   - Send a direct message to the bot from an allowed user ID.
   - Send a message from an unlisted user to verify the bot silently ignores unauthorized requests.

---

### Phase 4: Troubleshooting Common Diagnostics

| Failure Signature | Diagnostic & Root Cause | Resolution |
| --- | --- | --- |
| `Discord message intents are invalid or not enabled (Gateway 4014)` | Discord privileged Message Content Intent is toggled off | Instruct user to open Discord Developer Portal -> Bot -> Privileged Gateway Intents -> Enable **Message Content Intent**. |
| `Discord authentication failed (Gateway 4004)` | Invalid Bot Token | Re-copy Bot Token from the Bot tab (not Client Secret). |
| `Slack token configuration is invalid` | Token prefix mismatch | Check `tokenEnv` starts with `xoxb-` and `appTokenEnv` starts with `xapp-`. |
| `Slack authentication or permission failed` | Missing OAuth scopes or app not reinstalled | Verify `chat:write`, `app_mentions:read`, `im:history`, `connections:write`. Reinstall app to workspace. |
| `Telegram authentication or polling configuration failed` | Bad token or active webhook collision | Verify token with BotFather; run `curl https://api.telegram.org/bot<TOKEN>/deleteWebhook`. |
| Bot ignores group/channel message | Message was not addressed or channel not allowed | Ensure bot is mentioned (`@bot`). If Telegram Privacy Mode is ON, use `/ask@BotName ...`. Verify `allowedChannelIds`. |
| `Messenger requires a nonempty credential in <NAME>` | Target environment variable is unset or empty | Set the missing environment variable in the process shell before running. |

---

## Agent Installation Instructions

To install this skill in any AI coding agent environment:

### Method 1: Using the Universal Skills CLI
```sh
npx skills add akillness/jeopi --skill jeopi-messenger
```

### Method 2: Manual Installation into Agent Workspaces
- **jeopi**: Copy to `.jeopi/skills/jeopi-messenger/` or `~/.jeopi/agent/skills/jeopi-messenger/`
- **Claude Code**: Copy to `.claude/skills/jeopi-messenger/` or `~/.claude/skills/jeopi-messenger/`
- **Cursor / Codex / OpenCode / Antigravity / Aside**: Copy to `.agents/skills/jeopi-messenger/`
