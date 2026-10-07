# Pencil Practice Moderation Bot

A standalone Node.js bot that signs in through the normal Pencil Practice page and checks messages in the selected chat room with OpenAI's moderation API. It privately alerts the configured admin when the API or its local self-harm phrase fallback flags a message. It uses headless Chromium, does not call private Pencil Practice endpoints, and keeps the site password only in memory while logging in.

## Setup

1. Change any password that has been shared in chat, then install Node.js 20 or later.
2. Install dependencies with `npm install`, Chromium with `npx playwright install chromium`, and required Linux packages with `npx playwright install-deps chromium` (this may require administrator permission).
3. Set `OPENAI_API_KEY` in the environment, then start the bot with `npm start`.
4. Enter your username and password in the terminal prompts. The password prompt is hidden; credentials are not saved in files or logs.
5. After login, the bot sends `BOT_ADMIN_USERNAME` a private startup message, then watches the selected room. Keep the account online as a dedicated bot account; it will reconnect and resume monitoring after disconnects. Set `BOT_ADMIN_USERNAME` to your account (defaults to `solo`).

The bot only sends private alerts. It does not delete messages, mute users, or ban users, so a moderator must review each alert and take action on the site. Only chat message text is sent to OpenAI for moderation; configure an API key and review OpenAI's data handling terms before enabling it. If the API is unavailable, the bot logs the failure and retains its narrow self-harm phrase fallback. Use it only where you have permission to monitor chat, and stop it with Ctrl+C.

Run the command tests with `npm test`.

## Railway

Deploy this repository as a Railway service. The included Dockerfile installs Chromium and its Linux dependencies, and `railway.json` configures the service to restart whenever the bot process exits. In the service's Variables settings, add `PENCIL_USERNAME`, `PENCIL_PASSWORD`, and `OPENAI_API_KEY`. Set `BOT_ADMIN_USERNAME` too if the admin account is not `solo`. Do not commit credentials to the repository.

The bot exits if its chat or room changes; Railway will restart it and it will log in again. Ensure the service has permission to access the Pencil Practice account and the selected room.
