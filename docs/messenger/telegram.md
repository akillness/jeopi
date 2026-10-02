# Telegram Bot Setup Guide for jeopi messenger

This guide walks through configuring, authorizing, and running a Telegram bot with `jeopi messenger`.

## Overview

- **Protocol**: HTTPS long polling (`getUpdates`).
- **Network Requirement**: Outbound HTTPS requests to `api.telegram.org` only. No public IP, webhook URL, or open incoming ports required.
- **Message Types**: Direct messages (private chat) and group/supergroup mentions (`@YourBot` or `/ask@YourBot`).
- **Threads**: Telegram forum topics in supergroups are automatically supported and preserved via `message_thread_id`.

---

## Step 1: Create a Bot via @BotFather

1. Open Telegram and search for the official [@BotFather](https://t.me/BotFather) bot (verified checkmark).
2. Send `/newbot` to start the creation process.
3. Enter a friendly display name for your bot (e.g. `My jeopi Assistant`).
4. Enter a unique username ending in `bot` (e.g. `my_jeopi_agent_bot`).
5. BotFather will provide an HTTP API token formatted like:
   ```text
   1234567890:ABCdefGhIJKlmNoPQRsTUVwxyZ_1234567
   ```
6. Store this token securely. Set it as an environment variable in your shell profile or process environment:
   ```sh
   export JEOPI_TELEGRAM_BOT_TOKEN="1234567890:ABCdefGhIJKlmNoPQRsTUVwxyZ_1234567"
   ```

---

## Step 2: Retrieve Telegram User ID and Chat ID

jeopi requires exact numeric IDs in `allowedUserIds` and `allowedChannelIds`. Telegram usernames (e.g. `@username`) are **not** supported because usernames can change.

### Finding your User ID
1. Search for `@userinfobot` or `@raw_data_bot` on Telegram and send `/start`.
2. Note your numeric **Id** (e.g. `987654321`). This is your `allowedUserIds` value.

### Finding a Group or Channel Chat ID
1. Add your bot to the desired Telegram group or supergroup.
2. Send a test message in the group mentioning the bot: `@my_jeopi_agent_bot hello`.
3. In a terminal, call `getUpdates` using curl:
   ```sh
   curl -s "https://api.telegram.org/bot${JEOPI_TELEGRAM_BOT_TOKEN}/getUpdates" | jq .
   ```
4. Look for the `chat` object in the output:
   - For a private chat, `chat.id` is positive (same as the user ID).
   - For a group or supergroup, `chat.id` is negative and often starts with `-100` (e.g. `-1001987654321`).
   - Preserve the leading minus sign when adding to `allowedChannelIds`.

---

## Step 3: Configure Privacy Mode and Group Mentions

By default, Telegram bots in groups have **Privacy Mode enabled**. In this mode:
- The bot only receives messages that start with a slash command explicitly addressed to it (e.g. `/ask@my_jeopi_agent_bot what is the weather?`) or direct replies to the bot's own messages.
- Plain `@my_jeopi_agent_bot text` messages will **not** be delivered by Telegram to the bot unless Privacy Mode is disabled.

### Option A: Keep Privacy Mode Enabled (Recommended for security)
- In groups, address the bot with a command prefix:
  ```text
  /ask@my_jeopi_agent_bot explain this code
  ```
- jeopi automatically strips `/ask@my_jeopi_agent_bot` and treats the remaining text as the user prompt.

### Option B: Disable Privacy Mode (For plain @mentions)
1. Send `/setprivacy` to [@BotFather](https://t.me/BotFather).
2. Select your bot.
3. Choose **Disable**.
4. Remove the bot from the group and re-add it so Telegram applies the updated permission.

---

## Step 4: Clear Conflicting Webhooks

Telegram does **not** allow long polling (`getUpdates`) while an active webhook is registered. If the bot token was previously used with a webhook:

```sh
curl -s "https://api.telegram.org/bot${JEOPI_TELEGRAM_BOT_TOKEN}/deleteWebhook"
```

Expected response:
```json
{"ok":true,"result":true,"description":"Webhook was deleted"}
```

---

## Step 5: Configuration File (`messenger.json`)

Create `messenger.json` in a private directory:

```json
{
  "cwd": "./workspace",
  "sessionDir": "./sessions",
  "toolNames": [],
  "platforms": {
    "telegram": {
      "tokenEnv": "JEOPI_TELEGRAM_BOT_TOKEN",
      "allowedUserIds": ["987654321"],
      "allowedChannelIds": ["987654321", "-1001987654321"]
    }
  }
}
```

- `tokenEnv`: Names the environment variable holding the BotFather token.
- `allowedUserIds`: Exact user IDs permitted to interact. Any message from unlisted users is silently ignored.
- `allowedChannelIds`: (Optional) Restricts valid chats/groups. When specified, messages outside these chats are ignored.

---

## Step 6: Validate and Run

1. Validate the local configuration offline:
   ```sh
   jeopi messenger check --config ./messenger.json
   ```
   Output:
   ```text
   Messenger configuration valid: telegram; 0 tools enabled. No network checks performed.
   ```

2. Run the messenger gateway:
   ```sh
   jeopi messenger run --config ./messenger.json
   ```
   Output:
   ```text
   Starting messenger: telegram. Press Ctrl+C to stop.
   ```

3. Open a direct message with the bot in Telegram, type `Hello!`, and verify the agent's response.

---

## Troubleshooting

| Symptom | Cause | Solution |
| --- | --- | --- |
| Gateway crashes with `Telegram authentication or polling configuration failed` | Invalid token or HTTP 401/404 from Telegram | Verify `JEOPI_TELEGRAM_BOT_TOKEN` is set, non-empty, and matches BotFather output. |
| Gateway polls without error, but never receives messages | Active webhook registered or Privacy Mode blocking | Run `deleteWebhook` (Step 4) and verify Privacy Mode settings (Step 3). |
| Bot receives messages in DM but not in group | Missing group mention or Privacy Mode enabled | Ensure you tag `@YourBot` or use `/cmd@YourBot`. |
| Group messages ignored by gateway | Group chat ID not listed in `allowedChannelIds` | Check `getUpdates` for the group chat ID (including the minus sign `-100...`) and add it. |
| Message from user receives no response | User ID not listed in `allowedUserIds` | Confirm user ID via `@userinfobot` and add to `allowedUserIds`. |
