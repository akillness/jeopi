# Slack Socket Mode Setup Guide for jeopi messenger

This guide covers setting up, authorizing, and running a Slack bot with `jeopi messenger` using **Socket Mode**.

## Overview

- **Protocol**: Slack Socket Mode via outbound WebSocket connection (`apps.connections.open`).
- **Network Requirement**: Outbound WebSocket and HTTPS to `slack.com`. No public IP, webhook endpoints, or open ports required.
- **Tokens**: Two tokens required:
  1. **Bot Token (`xoxb-...`)**: Used to call REST APIs (`chat.postMessage`, `auth.test`).
  2. **App-Level Token (`xapp-...`)**: Used to establish the outbound Socket Mode WebSocket connection.
- **Message Types**: Direct Messages (DMs via App Home) and Channel mentions (`@YourBot`).
- **Threading**: Channel responses are posted automatically as replies in the message's thread.

---

## Step 1: Create a Slack App

1. Visit [api.slack.com/apps](https://api.slack.com/apps).
2. Click **Create New App** -> **From scratch**.
3. Name your app (e.g. `jeopi`) and select your development workspace.
4. Click **Create App**.

---

## Step 2: Enable Socket Mode and Generate App Token

Socket Mode allows your local jeopi instance to receive Slack events over a bidirectional WebSocket rather than an open HTTP webhook endpoint.

1. In the app settings sidebar under **Settings**, click **Socket Mode**.
2. Toggle **Enable Socket Mode** to **ON**.
3. A popup will prompt you to generate an App-Level Token:
   - Token Name: `jeopi-socket-mode`
   - Scope: `connections:write` (selected automatically)
   - Click **Generate**.
4. Copy the generated token starting with `xapp-`.
5. Store it in your environment:
   ```sh
   export JEOPI_SLACK_APP_TOKEN="xapp-..."
   ```

---

## Step 3: Configure Bot Scopes and Install App

1. In the left sidebar under **Features**, click **OAuth & Permissions**.
2. Scroll to **Scopes** -> **Bot Token Scopes** and add:
   - `chat:write` — Send messages as the bot
   - `app_mentions:read` — Receive messages when the bot is mentioned in public/private channels
   - `im:history` — Read messages in direct message conversations with the bot
3. Scroll back to the top of the **OAuth & Permissions** page and click **Install to Workspace** (or **Reinstall to Workspace**).
4. Review the permissions and click **Allow**.
5. Copy the **Bot User OAuth Token** starting with `xoxb-`.
6. Store it in your environment:
   ```sh
   export JEOPI_SLACK_BOT_TOKEN="xoxb-..."
   ```

*Note: Whenever you modify scopes in the future, you must reinstall the app to your workspace for changes to take effect.*

---

## Step 4: Subscribe to Bot Events

1. In the left sidebar under **Features**, click **Event Subscriptions**.
2. Toggle **Enable Events** to **ON**.
   *(Because Socket Mode is enabled, Slack will not ask for a Request URL.)*
3. Expand **Subscribe to bot events** and click **Add Bot User Event**:
   - `app_mention` — Subscribes to mentions of your bot in channels
   - `message.im` — Subscribes to direct messages sent to the bot
4. Click **Save Changes** in the bottom right corner.
5. If prompted, click the banner at the top to reinstall the app to apply the event changes.

---

## Step 5: Enable Direct Messages in App Home

1. In the left sidebar under **Features**, click **App Home**.
2. Scroll down to the **Show Tabs** section.
3. Under the **Messages Tab**, check the box:
   - **Allow users to send Slash commands and messages from the messages tab**.
4. This enables a 1-on-1 direct message conversation tab between authorized workspace members and your bot.

---

## Step 6: Invite the Bot to Channels

For the bot to respond in any public or private channel:
1. Open the Slack client and navigate to the target channel.
2. Type `/invite @YourBotName` and press Enter.

---

## Step 7: Retrieve Member IDs and Channel IDs

jeopi requires exact Slack IDs:

- **User Member ID**:
  1. Click the user's profile picture or name in Slack.
  2. Click the three dots icon (`...`) on their profile card.
  3. Select **Copy member ID** (format: `U1234567890` or `W1234567890`).
  4. Add this to `allowedUserIds`.

- **Channel ID**:
  1. Right-click the channel name in the sidebar -> **View channel details**.
  2. Scroll to the bottom of the About tab and copy the **Channel ID** (format: `C1234567890`).
  3. Add this to `allowedChannelIds`.

- **Direct Message Channel ID**:
  - Right-click the DM conversation in the sidebar -> **Copy link**.
  - The URL ends with the DM conversation ID (format: `D1234567890`).

---

## Step 8: Configuration File (`messenger.json`)

Create `messenger.json` in a private directory:

```json
{
  "cwd": "./workspace",
  "sessionDir": "./sessions",
  "toolNames": [],
  "platforms": {
    "slack": {
      "tokenEnv": "JEOPI_SLACK_BOT_TOKEN",
      "appTokenEnv": "JEOPI_SLACK_APP_TOKEN",
      "allowedUserIds": ["U1234567890"],
      "allowedChannelIds": ["C1234567890", "D1234567890"]
    }
  }
}
```

- `tokenEnv`: Environment variable for the `xoxb-` bot token.
- `appTokenEnv`: Environment variable for the `xapp-` app token.
- `allowedUserIds`: Exact member IDs allowed to interact with the bot.
- `allowedChannelIds`: (Optional) Restricts channels and DMs where the bot responds.

---

## Step 9: Validate and Run

1. Validate the local configuration offline:
   ```sh
   jeopi messenger check --config ./messenger.json
   ```
   Output:
   ```text
   Messenger configuration valid: slack; 0 tools enabled. No network checks performed.
   ```

2. Run the messenger gateway:
   ```sh
   jeopi messenger run --config ./messenger.json
   ```
   Output:
   ```text
   Starting messenger: slack. Press Ctrl+C to stop.
   ```

3. Test the bot:
   - **Direct Message**: In Slack, go to Apps -> click your bot -> open the Messages tab -> send `Hello!`.
   - **Channel Mention**: In an invited channel, mention the bot: `@jeopi check git status`.
   - The bot replies in the message thread.

---

## Troubleshooting

| Symptom | Cause | Solution |
| --- | --- | --- |
| Gateway crashes with `Slack token configuration is invalid` | Token does not match expected prefix | Ensure `tokenEnv` starts with `xoxb-` and `appTokenEnv` starts with `xapp-`. |
| Gateway crashes with `Slack authentication or permission failed` | Token expired, revoked, or missing scopes | Verify bot scopes (`chat:write`, `app_mentions:read`, `im:history`) and app scope (`connections:write`). Reinstall the app. |
| Gateway connects to Socket Mode, but no events are received | Event Subscriptions disabled or missing | Verify Event Subscriptions is enabled with `message.im` and `app_mention` subscribed. |
| Cannot send direct messages in App Home | Messages tab not enabled | Go to App Home -> Messages Tab -> check "Allow users to send Slash commands and messages from the messages tab". |
| Bot does not reply in a channel | Bot is not invited or mention missing | Invite the bot with `/invite @YourBot` and mention `@YourBot` in the message. |
| User receives no response | User ID not listed in `allowedUserIds` | Copy the user's Member ID (`U...`) and add to `allowedUserIds`. |
