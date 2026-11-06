# Orbit Chat

Orbit is a small, multi-channel chat site with an AI bot in the conversation. Create an account with a username, email address, and password, then sign in with either your username or email. Mention `@bot` when you want an AI reply.

## Run locally

1. Install Node.js 20 or later and [Ollama](https://ollama.com/download).
2. Start Ollama and download a model:

   ```sh
   ollama serve
   ollama pull llama3.2:1b
   ```

3. Start the site:

   ```sh
   npm start
   ```

4. Open `http://localhost:3000`.

The bot uses Ollama at `http://127.0.0.1:11434` with `llama3.2:1b` by default. Set `OLLAMA_BASE_URL` or `OLLAMA_MODEL` to use a different Ollama server or model. Run Ollama in the same environment as the chat server. If it is unavailable, Orbit will explain what needs to be started or installed.

Account records are saved to `data/users.json` locally. Passwords are stored as salted scrypt hashes, not as plain text.

To create the `solosinned` developer account automatically when the account store does not already contain it, set `OWNER_BOOTSTRAP_PASSWORD` in the server environment before starting Orbit. Use a deployment secret for this value; it is hashed before being saved, and setting it does not change an existing account's password. The generated account uses `solosinned@localhost.invalid` as its email.

### Keep accounts across Railway deploys

Railway containers do not keep files between deployments unless the service has a persistent volume. In the Railway service settings, add a volume and mount it at `/data`. Orbit automatically saves `users.json` in the mounted volume using Railway's `RAILWAY_VOLUME_MOUNT_PATH`. You can instead set `USER_STORE_PATH` to an absolute file path inside your mounted volume.

The latest 200 channel messages and direct-message history per conversation are saved in `users.json.messages.json` beside the account store. On Railway, keep this file on the same `/data` volume as the account file. The chat can load older messages from the channel history control. Active login sessions, typing indicators, and voice rooms are temporary and reset when the server restarts.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Address the web server listens on |
| `PORT` | `3000` | Web server port |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama server address |
| `OLLAMA_MODEL` | `llama3.2:1b` | Model used for bot replies |
| `USER_STORE_PATH` | `data/users.json`, or `users.json` in `RAILWAY_VOLUME_MOUNT_PATH` when set | Account data file |
| `OWNER_BOOTSTRAP_PASSWORD` | unset | Password used to create the default developer account if it does not exist |
| `OWNER_USERNAME` | `solosinned` | Username promoted to developer on startup |
| `COOKIE_SECURE` | `false` | Set to `true` when serving the site over HTTPS |
| `VOICE_ICE_SERVERS` | Cloudflare STUN | Optional JSON array of WebRTC ICE server objects; configure TURN credentials as deployment secrets for networks that need a relay |

For example, set `VOICE_ICE_SERVERS` to a JSON value like `[{"urls":"turn:turn.example.com:3478","username":"...","credential":"..."}]` using your TURN provider's values. Keep relay credentials in deployment secrets, not in source control, and prefer short-lived credentials because signed-in clients receive the ICE configuration.

The site has `#general`, `#ai-lab`, and `#off-topic` channels, plus invite-only private channels and private one-to-one direct messages. Channel owners can rotate and share invite codes; a user can own up to 20 private channels, with 200 private channels maximum. The channel list shows unread counts and mentions, offers a jump to the next unread message, and lets each user mute notifications per channel. Start a DM from another member's profile; blocking a user hides their channel messages and prevents direct messages in either direction.

Channel messages and DMs support PNG/JPEG/WebP image attachments up to 4 MB and replies. Channel owners and staff can start polls and scheduled events with calendar downloads. Any member can report a message; staff can review, resolve, or dismiss reports from the Reports panel. The members panel separates online and offline accounts.

Voice chat is small-group peer-to-peer audio, limited to 8 participants per channel. Browsers request microphone access, and participants may be able to see each other's network addresses. The default STUN server helps peers connect across some NATs; networks that require TURN need a TURN server configured through `VOICE_ICE_SERVERS`. For example, provide a JSON array with a TURN URL, username, and credential through your deployment's secret settings. Voice rooms and signaling are temporary and are not stored in chat history.

New members see a skippable Getting started guide with channel descriptions, topic interests, a notification style, and a four-item checklist. Progress and preferences are saved with the account and can be reopened from the channel list.

Members can set a short bio, upload a PNG/JPEG/WebP profile picture and banner, add profile music, and choose from built-in avatar decorations and animated profile effects. The original vector rank icons appear in member lists, messages, and profiles; profiles show both the icon and rank name. Profile fields are saved with the account data.

The account named `solosinned` (or the username configured with `OWNER_USERNAME`) is promoted to Developer on startup, including accounts created through registration. Developer is the highest rank, above Owner. Developers see Developer tools, can manage accounts and ranks, use all moderation actions, and send announcements to everyone. Announcements appear on signed-in users' screens and in the bell notification panel. The latest 100 announcements are saved beside the account store in `users.json.announcements.json` (or the configured account-store filename), and each user's read position is saved with their account. Owners can edit member bios and pictures, assign member/moderator/admin ranks, use moderation actions, and ban/unban accounts, but cannot send announcements or assign Developer rank. Admins and moderators see a separate Staff actions panel: moderators can warn and mute members, while admins can also ghost and timeout members or moderators. Staff cannot manage accounts or ranks, ban users, or act on accounts with an equal or higher rank. Mute, ghost, and timeout actions prompt for a duration and reason, then Orbit posts a notice in the selected channel. The account directory shows email, creation date, message count, active time, rank, warnings, and moderation state. Profile edits, ranks, moderation actions, message counts, and activity time are saved with account data; chat messages and DMs are persisted in the companion message-history file.

Channel messages support emoji reactions, threaded replies, pins, editing and deletion, search by text or author, and live typing indicators. Developers, owners, and admins can pin messages; authors can edit or delete their own messages, while staff above an author's rank can delete them. Message changes synchronize through polling. Announcements support update, event, and urgent categories. Member lists show rank-colored badges and can be filtered by username or rank; each browser can choose a Violet, Ocean, or Rose theme, saved locally. Menus and new cards animate into view, and animations respect the browser's reduced-motion preference.

Run the tests with `npm test`.
