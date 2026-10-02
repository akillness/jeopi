# jeopi

Core implementation package for the `jeopi` coding agent in the `jeopi` monorepo.

For installation, setup, provider configuration, model roles, slash commands, and full CLI reference, see:
- [Monorepo README (local)](../../README.md)
- [Monorepo README (GitHub)](https://github.com/can1357/oh-my-pi#readme)

Package-specific references:
- [CHANGELOG](./CHANGELOG.md)
- [MCP configuration guide](../../docs/mcp-config.md)
- [MCP runtime lifecycle](../../docs/mcp-runtime-lifecycle.md)
- [MCP server/tool authoring](../../docs/mcp-server-tool-authoring.md)
- [DEVELOPMENT](./DEVELOPMENT.md)

## Messenger gateway

`jeopi messenger` connects authorized Discord, Telegram, and Slack bots to headless agent sessions for bidirectional **text** conversations. Discord Gateway and Slack Socket Mode use outbound WebSockets; Telegram uses outbound long polling. No public HTTP ingress, webhook endpoint, or tunnel is required. Configure a working jeopi model/provider first using the [main setup guide](../../README.md).

### Configuration and CLI

Save this as `messenger.json` in a private directory outside your repository. Replace every placeholder ID, and remove platform blocks you do not use (at least one is required):

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

Create `workspace` yourself. Relative `cwd` and `sessionDir` resolve against the **configuration file's directory**, not the shell's working directory; absolute paths also work, but `~` is not expanded inside JSON. Omitting these fields defaults to `.` and `.jeopi/messenger-sessions` relative to that same directory. The session directory is created on the first accepted request.

Provide the named environment variables to the process through your secret manager or a private service environment. They hold bot credentials; JSON holds **environment variable names, never token values**. Only configured platforms require credentials. Do not paste tokens into commands, browser URLs, commits, chat, or diagnostics; do not use `echo`, environment dumps, or shell tracing to check them.

```sh
jeopi messenger check --config /absolute/private/path/messenger.json
jeopi messenger run --config /absolute/private/path/messenger.json
```

`check` validates JSON fields, allowlists, tool names, and the presence/shape of required environment values **locally only**. It performs no network checks and does not validate token authenticity, IDs, provider permissions, model access, or end-to-end delivery. `run` opens the transports; stop it with Ctrl+C or SIGTERM. After setup, test a DM from an allowed user and a bot mention in an allowed group/channel, and confirm unauthorized users receive no reply. Run only one gateway process for a given bot/configuration and session directory.

### Provider setup

**Telegram** ([official tutorial](https://core.telegram.org/bots/tutorial), [Bot API](https://core.telegram.org/bots/api)):

1. Create a bot through [@BotFather](https://t.me/BotFather) with `/newbot`; store its token as `JEOPI_TELEGRAM_BOT_TOKEN`. Send the bot a private message to start the conversation.
2. With the gateway stopped, use an authorized local Bot API client to call `getUpdates` and inspect only `message.from.id` (the human user) and `message.chat.id` (the destination). Put their decimal values in the allowlists as JSON strings, preserving a group chat ID's minus sign. Do not use usernames or the bot's own ID as user IDs. Keep the token-bearing request URL and full responses out of logs.
3. Long polling cannot run alongside a webhook or another polling client. If this bot previously used a webhook, remove it explicitly with `deleteWebhook` after checking the impact on that integration; jeopi does not remove it for you.
4. For groups, add the bot and allow the group's chat ID. With Telegram privacy mode enabled, use an addressed command such as `/ask@YourBot question`; jeopi treats it as ordinary prompt text, not a remote command. Plain `@YourBot question` may require disabling privacy mode through BotFather and re-adding the bot. Grant only the access you intend; group requests still require an explicit mention. Forum replies stay in the originating topic.

**Discord** ([Developer Portal](https://discord.com/developers/applications), [Gateway intents](https://docs.discord.com/developers/events/gateway#gateway-intents), [permissions](https://docs.discord.com/developers/topics/permissions)):

1. Create an application with a bot user; store the **bot token**, not a user token or client secret, as `JEOPI_DISCORD_BOT_TOKEN`.
2. In the Bot settings, enable the privileged **Message Content Intent** (obtain approval if Discord requires it for your app). The adapter requests `GUILD_MESSAGES`, `DIRECT_MESSAGES`, and `MESSAGE_CONTENT`; it does not request member or presence intents.
3. Install/invite the bot into your server with the `bot` scope and **View Channels**, **Send Messages**, and **Read Message History** permissions in intended channels. For threads, also grant **Send Messages in Threads** and access to the thread. Administrator permission is not required.
4. Enable Developer Mode in Discord's Advanced settings, then use **Copy User ID** for each authorized human and **Copy Channel ID** for each allowed channel/DM. A Discord thread is its own channel ID: allow that thread ID, not only its parent. Use exact numeric IDs as strings. Users must be able to DM the bot under their Discord privacy settings; guild messages must mention it.

**Slack** ([Socket Mode setup](https://docs.slack.dev/apis/events-api/using-socket-mode/), [app settings](https://api.slack.com/apps)):

1. Create an app in the intended workspace and enable **Socket Mode**. Generate an app-level `xapp-` token with `connections:write`; store it as `JEOPI_SLACK_APP_TOKEN`.
2. Under OAuth & Permissions, add bot scopes `chat:write`, `app_mentions:read`, and `im:history`. Install/reinstall the app into the workspace after scope changes; store its Bot User OAuth `xoxb-` token as `JEOPI_SLACK_BOT_TOKEN`. Both tokens must belong to the same app/workspace setup.
3. Enable Event Subscriptions and subscribe to bot events `message.im` and `app_mention`. Socket Mode needs no Request URL. Enable App Home's Messages tab and allow users to send messages to the app for DMs.
4. Invite the bot to each allowed channel with `/invite @YourBot`. Copy each human's **Member ID** from their profile menu into `allowedUserIds`. Copy the channel ID from channel details, or the DM conversation ID from its Slack link (`D...`), into `allowedChannelIds`; use IDs, not display names. Channel requests must mention the bot and replies remain in their thread.

### Security boundaries and limits

- Every configured platform requires a nonempty `allowedUserIds` list of exact IDs; wildcards are rejected. Optional `allowedChannelIds` further restricts channels **including DMs**; if supplied it must be nonempty. Omitting it permits that platform's allowed users in any reachable channel, still subject to the mention rule outside DMs.
- Conversation history is isolated by platform, bot/workspace identity, channel, thread/topic where applicable, and **sender**, with `cwd` included in the persisted route. Discord threads use their channel ID. This is history separation, not access control over messages visible to other members of a group or over local files.
- Keep configuration, workspace, and session storage under a dedicated private directory/account. Session directories/files are restricted to modes `0700`/`0600`; transcripts persist on disk and are not encrypted by this feature. Authorized prompts and enabled-tool results can reach your configured model provider and replies go back to the originating chat. Never use a sensitive personal workspace for remote prompts.
- `toolNames` defaults to `[]`, so remote sessions have no tools. They do not load workspace context files, skills, rules, prompt templates, custom tools, extension discovery, MCP, or LSP. Slash-looking input, including `/new`, is ordinary user text; there is no remote session-management command surface.
- **Dangerous opt-in:** the entire supported local-tool list is `"toolNames": ["read", "grep", "glob", "bash", "edit", "write"]`. Enable only the subset you deliberately authorize, never by default. Selected tools are allowed without per-call interactive approval: even read/search tools can disclose local data, and shell/write tools grant local execution/modification authority. `cwd` is not a filesystem jail. This is **not a sandbox**; isolate the OS account/container and its credentials before granting remote users tools.
- Incoming text is limited to 32,000 UTF-16 units. Turns are serialized across platforms with at most 100 pending messages; excess messages are dropped. Deduplication and transport cursors are in memory, not a durable delivery queue. Reconnects retry transient failures, but fatal authentication/configuration errors stop the gateway; restart after correcting them. Do not assume exactly-once processing or recovery of every message after an outage.
- Replies are split into provider-sized text chunks (Discord 2,000, Telegram 4,096, Slack 4,000 UTF-16 units). Slack spaces chunks; there is no general outbound rate-limit scheduler or durable retry/outbox. Failed sends are not automatically replayed and a multi-chunk reply can be partial. Check provider limits and connectivity before manually retrying a request that may already have run tools.

These are native jeopi transports, informed by Aside's bundled `~/.aside/u/0/skills/builtin/channel/SKILL.md` context/reply model and [Hermes Agent gateway architecture at `040b6df2c40b0f4f88f51e4c2062eafc4d7463c5`](https://github.com/NousResearch/hermes-agent/tree/040b6df2c40b0f4f88f51e4c2062eafc4d7463c5), **not full ports**. Aside's moderation/history/reaction tools and Hermes media support are not included. Attachments, image/audio/video processing, and media uploads are not supported by this text gateway.

### Detailed Guides and Agent Skill

- [Messenger Architecture & Configuration Guide](../../docs/messenger.md)
- [Telegram Bot Setup Guide](../../docs/messenger/telegram.md)
- [Discord Bot Setup Guide](../../docs/messenger/discord.md)
- [Slack Socket Mode Setup Guide](../../docs/messenger/slack.md)

#### Install as Agent Skill

Install the `jeopi-messenger` skill so AI agents can manage and operate messenger configurations:

```sh
# Universal install via skills CLI
npx skills add akillness/jeopi --skill jeopi-messenger

# Manual install into agent projects
mkdir -p .agents/skills/jeopi-messenger
cp -r ../../skills/jeopi-messenger/* .agents/skills/jeopi-messenger/
```

## Memory backends

The agent supports three mutually-exclusive memory backends, selected via the `memory.backend` setting (Settings → Memory tab, or `~/.jeopi/config.yml`):

- `off` (default) — no memory subsystem runs.
- `local` — existing rollout-summarisation pipeline; writes `memory_summary.md` and consolidated artifacts under the agent dir.
- `hindsight` — talks to a [Hindsight](https://hindsight.vectorize.io) server (Cloud or self-hosted Docker), retains transcripts every Nth user turn, recalls memories on the first turn of a session, and exposes `retain`, `recall`, and `reflect`.

### Hindsight quickstart

1. Run a Hindsight server (Cloud or `docker run -p 8888:8888 ghcr.io/vectorize-io/hindsight:latest`).
2. Set `memory.backend = "hindsight"` and `hindsight.apiUrl = "http://localhost:8888"` (or your Cloud URL).
3. Optional environment overrides (env wins over settings):
   - `HINDSIGHT_API_URL`, `HINDSIGHT_API_TOKEN` — connection
   - `HINDSIGHT_BANK_ID`, `HINDSIGHT_DYNAMIC_BANK_ID`, `HINDSIGHT_AGENT_NAME` — bank addressing
   - `HINDSIGHT_AUTO_RECALL`, `HINDSIGHT_AUTO_RETAIN`, `HINDSIGHT_RETAIN_MODE` — lifecycle
   - `HINDSIGHT_RECALL_BUDGET`, `HINDSIGHT_RECALL_MAX_TOKENS` — recall sizing
   - `HINDSIGHT_BANK_MISSION`, `HINDSIGHT_DEBUG`

Switching backends mid-session is honoured on the next system-prompt rebuild and the next `/memory` slash command. Existing users with `memories.enabled = true|false` are migrated to `memory.backend = "local"|"off"` exactly once on first launch.
