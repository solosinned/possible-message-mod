# Pencil Fish Bot

A standalone Node.js bot that signs in through the normal Pencil Practice page and responds to supported `s.` commands in the chat room you select. It uses headless Chromium, does not call private endpoints, and keeps the password only in memory while logging in.

## Setup

1. Change any password that has been shared in chat, then install Node.js 20 or later.
2. Install dependencies with `npm install`, Chromium with `npx playwright install chromium`, and required Linux packages with `npx playwright install-deps chromium` (this may require administrator permission).
3. Start the bot with `npm start`.
4. Enter your username and password in the terminal prompts. The password prompt is hidden; credentials are not saved in files or logs.
5. The bot starts listening in the main room that opens after login. In that room, `s.switch` navigates to the room labeled “MATHS CLASS.” After the switch succeeds, `s.spam` starts sending random three-letter messages every 500 ms; `s.stopspam` stops the loop. Only the logged-in bot username can start spam, while any chat user can stop it.

The bot responds only to standalone messages beginning with `s.`. Its local Sincoins economy supports `s.fish`, `s.balance`, `s.shop`, `s.bait`, `s.buy <bait>`, and `s.equip <bait>`. Caught fish are sold automatically, and five baits unlock progressively rarer fish. `s.work` awards a random amount for a randomly selected job once per hour, `s.daily` gives a daily reward, and `s.beg` gives a smaller reward every 30 minutes. Balances and cooldowns are stored locally in `.sincoins.json` and are separate from the Pencil Practice account. Other commands include `s.bark`, `s.ping`, `s.coin`, `s.dice`, `s.rps`, `s.8ball`, `s.dance`, `s.joke`, `s.hug`, `s.compliment`, `s.roll`, `s.highfive`, `s.boop`, `s.cheer`, `s.vibe`, `s.riddle`, `s.pun`, `s.pick`, `s.rate`, `s.pet`, `s.sparkle`, `s.shrug`, `s.fortune`, and `s.help`. Replies are sent in order with a short pause between them. Use it only where you have permission to automate chat, and stop it with Ctrl+C.

Run the command tests with `npm test`.

## Railway

Deploy this repository as a Railway service. The included Dockerfile installs Chromium and its Linux dependencies, and `railway.json` configures the service to restart whenever the bot process exits. In the service's Variables settings, add `PENCIL_USERNAME` and `PENCIL_PASSWORD` with the Pencil Practice account credentials. Set `BOT_ADMIN_USERNAME` too if the admin account is not `solo`. Do not commit credentials to the repository.

The bot exits if its chat or room changes; Railway will restart it and it will log in again. Add a Railway volume mounted at `/app/data` if you want economy data to survive redeploys, then configure the data path before relying on persistent balances.
