# Discord Bot Setup Guide for jeopi messenger

This guide covers setting up, authorizing, and running a Discord bot with `jeopi messenger`.

## Overview

- **Protocol**: Discord Gateway v10 via outbound WebSocket (`wss://gateway.discord.gg`).
- **Network Requirement**: Outbound WebSocket and HTTPS access to `discord.com`. No public IP, webhook endpoints, or open ports required.
- **Message Types**: Direct Messages (DMs) and Server/Guild Channel messages where the bot is mentioned (`<@bot_id>`).
- **Threads**: Supported directly. Discord treats threads as distinct channel Snowflake IDs.

---

## Step 1: Create a Discord Application and Bot

1. Navigate to the [Discord Developer Portal](https://discord.com/developers/applications).
2. Click **New Application** in the top right.
3. Name your application (e.g. `jeopi-assistant`) and accept Discord's terms.
4. Go to the **Bot** tab on the left sidebar:
   - Click **Reset Token** to generate a new Bot Token.
   - Copy this token immediately.
   - Store it securely in your environment:
     ```sh
     export JEOPI_DISCORD_BOT_TOKEN="your-discord-bot-token-here"
     ```
   - **Important**: This must be the **Bot Token**, not the Client Secret or Application ID.

---

## Step 2: Enable the Privileged Message Content Intent

jeopi requires the **Message Content Intent** to read the text of incoming messages. Without this setting enabled, Discord's Gateway rejects the connection with close code `4014` (`Disallowed intent(s)`).

1. In the Discord Developer Portal, navigate to the **Bot** tab.
2. Scroll down to the **Privileged Gateway Intents** section.
3. Toggle **Message Content Intent** to **ON**.
4. Click **Save Changes**.

*(Note: For bots in fewer than 100 servers, verification or approval is not required to enable this toggle.)*

---

## Step 3: Invite the Bot to Your Server

1. In the Developer Portal, go to **OAuth2** -> **URL Generator** on the left menu.
2. Under **Scopes**, select:
   - `bot`
3. Under **Bot Permissions**, select the following minimal permissions (Administrator is **not** required):
   - **View Channels**
   - **Send Messages**
   - **Send Messages in Threads**
   - **Read Message History**
4. Copy the generated URL at the bottom of the page.
5. Paste the URL into your web browser, select your Discord server, and click **Authorize**.

---

## Step 4: Copy User and Channel Snowflake IDs

jeopi validates exact Discord Snowflake IDs (numeric strings):

1. Open Discord desktop or web client.
2. Go to **User Settings** (gear icon) -> **Advanced**.
3. Toggle **Developer Mode** to **ON**.
4. Retrieve the IDs:
   - **User ID**: Right-click your username (or authorized user's avatar) in the member list and select **Copy User ID**.
   - **Channel ID**: Right-click the channel name where the bot should talk and select **Copy Channel ID**.
   - **Thread ID**: Right-click a thread name and select **Copy Channel ID** (threads have their own unique channel IDs in Discord).

---

## Step 5: Configuration File (`messenger.json`)

Create `messenger.json` in a private directory:

```json
{
  "cwd": "./workspace",
  "sessionDir": "./sessions",
  "toolNames": [],
  "platforms": {
    "discord": {
      "tokenEnv": "JEOPI_DISCORD_BOT_TOKEN",
      "allowedUserIds": ["123456789012345678"],
      "allowedChannelIds": ["987654321098765432"]
    }
  }
}
```

- `tokenEnv`: Names the environment variable containing the bot token.
- `allowedUserIds`: Exact Snowflake IDs of human users allowed to trigger the bot. Messages from any other user are ignored.
- `allowedChannelIds`: (Optional) Restricts valid channel or thread IDs. When omitted, allowed users can communicate with the bot in any channel or DM the bot has access to.

---

## Step 6: Validate and Run

1. Validate the local configuration offline:
   ```sh
   jeopi messenger check --config ./messenger.json
   ```
   Output:
   ```text
   Messenger configuration valid: discord; 0 tools enabled. No network checks performed.
   ```

2. Run the messenger gateway:
   ```sh
   jeopi messenger run --config ./messenger.json
   ```
   Output:
   ```text
   Starting messenger: discord. Press Ctrl+C to stop.
   ```

3. Test the bot:
   - **Direct Message**: Open a DM with the bot in Discord and send `Hello!`. (No mention needed in DMs.)
   - **Server Channel**: In an allowed channel, mention the bot: `@jeopi-assistant explain this function`.
   - Confirm unauthorized users or unlisted channels receive no response.

---

## Troubleshooting

| Symptom | Cause | Solution |
| --- | --- | --- |
| Gateway crashes with `Discord authentication failed (Gateway 4004)` | Invalid Bot Token | Ensure `JEOPI_DISCORD_BOT_TOKEN` holds the Bot Token from the Bot tab (not Client Secret). |
| Gateway crashes with `Discord message intents are invalid or not enabled (Gateway 4014)` | Privileged Message Content Intent is disabled | Go to Developer Portal -> Bot -> Privileged Gateway Intents -> Enable **Message Content Intent**. |
| Bot joins server but does not see messages in a channel | Missing channel permissions | Ensure the bot's role has "View Channel", "Send Messages", and "Read Message History" in that channel. |
| Bot receives messages in DM but not in server channel | Bot was not mentioned in server message | Guild messages require an explicit mention (`@BotName`). Mentions are stripped automatically before prompt execution. |
| Message from user receives no response | User ID not in `allowedUserIds` | Copy the 17-19 digit Snowflake user ID with Developer Mode and verify it matches `allowedUserIds`. |


---

## Live Session Bridge (`/discord live`)

**Optional**: Attach an authorized Discord channel directly to an active jeopi interactive session without running a standalone `messenger` gateway.

### Overview

The `/discord live` command bridges a Discord channel into the current interactive session, allowing authorized Discord users to send messages directly to that session's agent and receive responses in near real-time. The bridge:

- **Does not create or switch sessions**. It attaches to the currently active session.
- **Requires explicit opt-in**: The command demands an acknowledgement flag (`--allow-full-control`) to confirm authorization for Discord to control host tools.
- **Loads a private `messenger.json` configuration**: Reuses the same config format as the standalone `jeopi messenger` gateway.
- **Shares one conversation**: All allowed users and channels interact with the same host session; their histories are not isolated.
- **Terminates cleanly**: Use `/discord stop` to revoke Discord access and close the bridge.

### Activation: `/discord live`

```sh
/discord live /path/to/private-messenger.json --allow-full-control
```

**Parameters:**
- `<configPath>`: Absolute or relative path (resolved against the session's working directory) to a `messenger.json` file with Discord platform configuration. Must exist and be readable.
- `--allow-full-control`: Explicit acknowledgement that this Discord channel has execution authority over the host session's active tools and settings, and can execute any action the authorized user would perform interactively. This flag is **required** and cannot be abbreviated.

**Config Prerequisites:**
- The `messenger.json` file must have a `platforms.discord` section with `tokenEnv` and `allowedUserIds` (see Step 5 above).
- **Required**: `allowedChannelIds` must be a non-empty array of exact Discord channel/thread Snowflake IDs. The live bridge does not support omitted or empty channel lists.
- The bot token (from `JEOPI_DISCORD_BOT_TOKEN` or the configured `tokenEnv`) must be a valid bot token for an application with the Message Content Intent enabled.
- At least one user ID in `allowedUserIds` must match the Discord user sending messages.

**Security Constraints:**
- The bridge grants full host control (`--allow-full-control` acknowledges this). Only activate the bridge in trusted Discord channels with authorized users.
- The `toolNames` field in the config is **ignored by the live bridge**. The bridge runs in the active session and inherits its full set of enabled tools. Discord users can execute any tool the host session has enabled.
- Session transcripts are saved to disk in the configured `sessionDir` (if using standalone `jeopi messenger`) or in the host session's transcript location. Ensure these directories are not world-readable.
- **Config is read once at startup**: Changes to `allowedUserIds` or `allowedChannelIds` in the config file are NOT detected while the bridge is active. To apply config changes, stop the bridge (`/discord stop`) and restart it (`/discord live`).

**Activation Example:**
```sh
/discord live ~/.jeopi/private-discord.json --allow-full-control
```

On success:
```text
Discord live bridge active with full host control acknowledged. Approval mode: <mode>; active tools: <tools>. /discord stop revokes access.
```

If the command fails:
- Missing `--allow-full-control`: `Usage: /discord live <private messenger.json> --allow-full-control`
- Config validation error: `Failed to start Discord live bridge: <error message>`
- Missing or empty `allowedChannelIds` in config: `Failed to start Discord live bridge: Live Discord requires an explicit nonempty allowedChannelIds list`
- Bridge already active: `Discord live bridge is already active or starting (/discord stop first)`

### Status: `/discord status`

Check if a Discord live bridge is currently active:

```sh
/discord status
```

Output when active:
```text
Discord live bridge is active with full host control acknowledged. Approval mode: <mode>; active tools: <tools>.
```

Output when inactive:
```text
Discord live bridge is off
```

### Busy State

While a Discord message is being processed (including tool calls, streaming responses, etc.), subsequent Discord messages are rejected with:

```text
The live session is busy. Please try again when it is idle.
```

This is NOT a queue — messages are rejected, not buffered. The user must retry after the current turn completes.

### Stop: `/discord stop`

Immediately stop the Discord live bridge and revoke all Discord access to the host session:

```sh
/discord stop
```

Output on success:
```text
Discord live bridge stopped; access revoked
```

Output if no bridge is active:
```text
Discord live bridge is not active
```

### Important Notes

- **Shared Session Context**: All Discord messages (regardless of sender or channel) contribute to the same active session's conversation history. Each message is tagged with `[Discord:<messageId> sender:<senderId> channel:<channelId>]` in the transcript.
- **Tool Execution**: Discord messages execute in the active session's context with all tools enabled in that session. The bridge inherits the active session's tool set and approval mode; it does not restrict or filter tools.
- **Concurrent Requests**: The bridge processes Discord messages one at a time. While a turn is active (streaming, compacting, running tools, retrying, etc.), new Discord messages are immediately rejected with "The live session is busy. Please try again when it is idle." Senders must retry after the active turn completes.
- **Bridge Lifecycle**: The bridge closes when:
  - `/discord stop` is invoked.
  - The host session switches (via `/switch`, `/tan`, or external session change).
  - The host session shuts down (via `/quit`, Ctrl+C, or crash).
  - A permanent Discord authentication or configuration error occurs (permanent codes: 4004, 4010, 4011, 4012, 4013, 4014). Transient network errors trigger automatic reconnection with exponential backoff (max 30s delay).
- **Message Splitting**: Long Discord replies are automatically split into chunks of up to 2,000 characters to respect Discord's message length limits.
