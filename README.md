# Pencil Fish Bot

A standalone Node.js bot that signs in through the normal Pencil Practice page and responds to supported `s.` commands in the chat room you select. It uses headless Chromium, does not call private endpoints, and keeps the password only in memory while logging in.

## Setup

1. Change any password that has been shared in chat, then install Node.js 20 or later.
2. Install dependencies with `npm install`, Chromium with `npx playwright install chromium`, and required Linux packages with `npx playwright install-deps chromium` (this may require administrator permission).
3. Start the bot with `npm start`.
4. Enter your username and password in the terminal prompts. The password prompt is hidden; credentials are not saved in files or logs.
5. The bot starts listening when it finds a visible chat input after login. It cannot navigate between rooms, so make sure the intended room is open.

The bot responds only to standalone messages beginning with `s.`. Its local Sincoins fishing economy supports `s.fish`, `s.balance`, `s.shop`, `s.bait`, `s.buy <bait>`, and `s.equip <bait>`. Caught fish are sold automatically for Sincoins; five baits unlock progressively rarer fish. The economy is stored locally in `.sincoins.json` and is separate from the Pencil Practice account. Other fun commands include `s.bark`, `s.ping`, `s.coin`, `s.dice`, `s.rps`, `s.8ball`, `s.dance`, `s.joke`, `s.hug`, `s.compliment`, `s.roll`, `s.highfive`, `s.boop`, `s.cheer`, `s.vibe`, `s.riddle`, `s.pun`, `s.pick`, `s.rate`, `s.pet`, `s.sparkle`, `s.shrug`, `s.fortune`, and `s.help`. Replies are sent in order with a short pause between them. Use it only where you have permission to automate chat, and stop it with Ctrl+C.

Run the command tests with `npm test`.
