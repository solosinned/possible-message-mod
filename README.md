# Orbit Chat

Orbit is a small, multi-channel chat site. The live site is [esakura.lol](https://esakura.lol). Create an account with a username, email address, and password, then sign in with either your username or email.

## Run locally

1. Install Node.js 20 or later.
2. Start the site:

   ```sh
   npm start
   ```

3. Open `http://localhost:3000`.

Without Supabase configuration, local development saves account records to `data/users.json` and stores passwords as salted scrypt hashes. When Supabase is configured, Supabase Auth manages passwords and Supabase Postgres stores app profiles, messages, announcements, and other persistent chat data.

### Configure Supabase for deployments

1. Create a Supabase project and open the SQL Editor. Run [`supabase/schema.sql`](./supabase/schema.sql) to create or upgrade the private `orbit_state` table. Before deploying this update, run the schema again so existing tables can store partitioned rows.
2. In Railway, add these variables to the web service. Get the URL and keys from the Supabase project's API settings:

   | Railway variable | Supabase value |
   | --- | --- |
   | `SUPABASE_URL` | Project URL |
   | `SUPABASE_PUBLISHABLE_KEY` | Publishable key |
   | `SUPABASE_SECRET_KEY` | Secret key |
   | `SUPABASE_AUTH_REDIRECT_URL` | `https://esakura.lol/` |

   Keep `SUPABASE_SECRET_KEY` in Railway's server-side variables only. Never put it in browser code or commit it to GitHub. The publishable key is used by the server for Supabase Auth requests; the browser does not connect to Supabase directly.
3. In Supabase Auth settings, enable the Email provider, add `https://esakura.lol/` to the allowed redirect URLs for password resets, and turn off email confirmation. New accounts are created by the server as already confirmed. Configure SMTP if you want password-reset emails to be delivered reliably.
4. Deploy. The app checks that all required variables are present and reads/writes partitioned records in `orbit_state`. The table has row-level security enabled and grants no direct access to browser roles. On its first startup after this update, the app migrates the legacy `main` JSONB row into per-record rows and removes the old row only after the new rows have been saved successfully.

Accounts, announcements, reports, and private channels are stored as individual records; each channel message and direct message is also stored as its own row. Frequently updated account activity counters are separate from profile data. This avoids rewriting the full chat history when one account or message changes. The primary key on `id` is the index used for these point updates; no additional index is needed. Run a single Railway web-service replica; multiple replicas would each hold an in-memory copy and could overwrite newer state. Login sessions are temporary and users may need to sign in again after a deploy, but Supabase Auth accounts and application data persist.

For a one-time import of local JSON files, set `SUPABASE_IMPORT_JSON=true` for the first startup only, while the app can read the original `USER_STORE_PATH` and companion message/announcement files. Import runs only when the Supabase table is empty. Verify the data in the live app, then remove `SUPABASE_IMPORT_JSON`. Imported profile data and chat history are preserved, but old scrypt password hashes are discarded; each imported user must create a new Supabase Auth password by registering with the same username and email. If you have no old JSON files or backup, Supabase cannot recover the missing accounts.

New sign-ups use Supabase Auth and can sign in immediately without a confirmation email. The app keeps a per-IP sign-in and sign-up attempt limit to reduce abuse. Supabase controls its own email sending quotas; the app does not disable those platform limits. Users can request a password-reset link from the sign-in screen, which still sends an email.

To create the `solosinned` developer account automatically when the account store does not already contain it, set `OWNER_BOOTSTRAP_PASSWORD` in the server environment before starting Orbit. Use a deployment secret for this value; it is hashed before being saved, and setting it does not change an existing account's password. The generated account uses `solosinned@localhost.invalid` as its email.

### Keep accounts across Railway deploys

Railway containers do not keep files between deployments unless the service has a persistent volume. In the Railway service settings, add a volume and mount it at `/data`. Orbit automatically saves `users.json` in the mounted volume using Railway's `RAILWAY_VOLUME_MOUNT_PATH`. You can instead set `USER_STORE_PATH` to an absolute file path inside your mounted volume.

The latest 200 channel messages and direct-message history per conversation are saved in `users.json.messages.json` beside the account store. On Railway, keep this file on the same `/data` volume as the account file. The chat can load older messages from the channel history control. Active login sessions, typing indicators, and voice rooms are temporary and reset when the server restarts.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Address the web server listens on |
| `PORT` | `3000` | Web server port |
| `USER_STORE_PATH` | `data/users.json`, or `users.json` in `RAILWAY_VOLUME_MOUNT_PATH` when set | Account data file |
| `OWNER_BOOTSTRAP_PASSWORD` | unset | Password used to create the default developer account if it does not exist |
| `OWNER_USERNAME` | `solosinned` | Username promoted to developer on startup |
| `SUPABASE_URL` | unset | Supabase project URL; enables Supabase persistence and Auth |
| `SUPABASE_PUBLISHABLE_KEY` | unset | Supabase publishable key used for Auth requests |
| `SUPABASE_SECRET_KEY` | unset | Server-only Supabase key used to access the private Postgres state table |
| `SUPABASE_AUTH_REDIRECT_URL` | `https://esakura.lol/` | Allowed redirect target for Supabase password-recovery emails |
| `SUPABASE_IMPORT_JSON` | `false` | Import local JSON data into Supabase on the first startup only |
| `COOKIE_SECURE` | `false` | Set to `true` when serving the site over HTTPS |
| `VOICE_ICE_SERVERS` | Cloudflare STUN | Optional JSON array of WebRTC ICE server objects; configure TURN credentials as deployment secrets for networks that need a relay |

For example, set `VOICE_ICE_SERVERS` to a JSON value like `[{"urls":"turn:turn.example.com:3478","username":"...","credential":"..."}]` using your TURN provider's values. Keep relay credentials in deployment secrets, not in source control, and prefer short-lived credentials because signed-in clients receive the ICE configuration.

The site has `#general`, `#ideas`, and `#off-topic` channels, plus invite-only private channels and private one-to-one direct messages. Channel owners can rotate and share invite codes; a user can own up to 20 private channels, with 200 private channels maximum. The channel list shows unread counts and mentions, offers a jump to the next unread message, and lets each user mute notifications per channel. Start a DM from another member's profile; blocking a user hides their channel messages and prevents direct messages in either direction.

Channel messages and DMs support PNG/JPEG/WebP image attachments up to 4 MB and replies. Channel owners and staff can start polls and scheduled events with calendar downloads. Any member can report a message; staff can review, resolve, or dismiss reports from the Reports panel. The members panel separates online and offline accounts.

Voice chat is small-group peer-to-peer audio, limited to 8 participants per channel. Browsers request microphone access, and participants may be able to see each other's network addresses. The default STUN server helps peers connect across some NATs; networks that require TURN need a TURN server configured through `VOICE_ICE_SERVERS`. For example, provide a JSON array with a TURN URL, username, and credential through your deployment's secret settings. Voice rooms and signaling are temporary and are not stored in chat history.

New members see a skippable Getting started guide with channel descriptions, topic interests, a notification style, and a four-item checklist. Progress and preferences are saved with the account and can be reopened from the channel list.

Members can set a short bio, upload a PNG/JPEG/WebP profile picture and banner, add profile music, and choose from built-in avatar decorations and animated profile effects. The original vector rank icons appear in member lists, messages, and profiles; profiles show both the icon and rank name. Profile fields are saved with the account data.

The account named `solosinned` (or the username configured with `OWNER_USERNAME`) is promoted to Developer on startup, including accounts created through registration. Developer is the highest rank, above Owner. Developers see Developer tools, can manage accounts and ranks, use all moderation actions, and send announcements to everyone. Announcements appear on signed-in users' screens and in the bell notification panel. The latest 100 announcements are saved beside the account store in `users.json.announcements.json` (or the configured account-store filename), and each user's read position is saved with their account. Owners can edit member bios and pictures, assign member/moderator/admin ranks, use moderation actions, and ban/unban accounts, but cannot send announcements or assign Developer rank. Admins and moderators see a separate Staff actions panel: moderators can warn and mute members, while admins can also ghost and timeout members or moderators. Staff cannot manage accounts or ranks, ban users, or act on accounts with an equal or higher rank. Mute, ghost, and timeout actions prompt for a duration and reason, then Orbit posts a notice in the selected channel. The account directory shows email, creation date, message count, active time, rank, warnings, and moderation state. Profile edits, ranks, moderation actions, message counts, and activity time are saved with account data; chat messages and DMs are persisted in the companion message-history file.

Channel messages support emoji reactions, threaded replies, pins, editing and deletion, search by text or author, and live typing indicators. Developers, owners, and admins can pin messages; authors can edit or delete their own messages, while staff above an author's rank can delete them. Message changes synchronize through polling. Announcements support update, event, and urgent categories. Member lists show rank-colored badges and can be filtered by username or rank; each browser can choose a Violet, Ocean, or Rose theme, saved locally. Menus and new cards animate into view, and animations respect the browser's reduced-motion preference.

Run the tests with `npm test`.
