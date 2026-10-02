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
