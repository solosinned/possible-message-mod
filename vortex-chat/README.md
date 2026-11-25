# Vortex Chat Integration (Express.js)

A clean, complete Express.js example that integrates [Vortex Chat](https://vtx.chat) using the official `@vortex-chat/sdk`.

It includes:
- **OAuth login** with Vortex (`/auth/vortex`, `/auth/vortex/callback`) using PKCE + state validation
- **Server-side session storage** for Vortex tokens/user profile
- **Protected API routes** for current user, channels, messages, sending messages, and logout
- **Realtime message forwarding** from Vortex realtime (`.connect()`) to browser clients via Socket.IO
- **App/Bot example** showing `vortex.app()` and `app.announce()`
- A simple frontend (`public/index.html`) for login, channel list, message list, and sending

## Project files

```text
vortex-chat/
  .env.example
  .gitignore
  package.json
  server.js
  public/
    index.html
  README.md
```

## 1) Setup `.env`

Copy the example file and fill in your secret:

```bash
cd vortex-chat
cp .env.example .env
```

Edit `.env`:

```env
VORTEX_CLIENT_ID=vtx_4d21b21ace36baeb7916
VORTEX_CLIENT_SECRET=your-real-client-secret
SESSION_SECRET=replace-with-a-long-random-secret

VORTEX_REDIRECT_URI=http://localhost:3000/auth/vortex/callback
PORT=3000
BASE_URL=http://localhost:3000
COOKIE_SECURE=false
```

### Important: client secret

- `VORTEX_CLIENT_SECRET` must **only** live on the server (environment variable / secret manager).
- **Never** put the client secret in browser JavaScript, frontend env vars, HTML, git commits, screenshots, or logs.
- This project uses `VORTEX_CLIENT_SECRET` only inside the server-side `Vortex` SDK client.
- If a secret is exposed, rotate it immediately in Vortex Partner Tools.

## 2) Add your domain/callback in Vortex dashboard

In Vortex:

1. Open **Partner Tools → Your Apps**.
2. Select your app (or create one) and use the **npm SDK** connection.
3. Copy your Client ID and Client Secret. The secret is shown once; rotate it if needed.
4. Under **Where it works**, allow the site/domain your callback runs on.
   - Local development: allow `http://localhost:3000` (or the local origin you use).
   - Production: allow your real domain, e.g. `https://yourdomain.com`.
5. Make sure your callback URL is on an allowed site. This demo defaults to:

   ```text
   http://localhost:3000/auth/vortex/callback
   ```

   For production, set:

   ```env
   VORTEX_REDIRECT_URI=https://yourdomain.com/auth/vortex/callback
   BASE_URL=https://yourdomain.com
   COOKIE_SECURE=true
   ```

## 3) Run the project

```bash
cd vortex-chat
npm install
npm start
```

For auto-reload during development (Node 18+):

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and click **Login with Vortex**.

## 4) What the server implements

### OAuth flow

- `GET /auth/vortex`
  - Calls `vortex.getAuthorizeUrl({ redirectUri })`
  - Stores `state` and `codeVerifier` in the session
  - Redirects the user to Vortex
- `GET /auth/vortex/callback`
  - Validates `state` (CSRF protection)
  - Calls `vortex.exchangeCode({ code, redirectUri, codeVerifier })`
  - Fetches/sanitizes the Vortex user profile
  - Stores tokens + user profile in session and demo store

### Protected API

- `GET /api/me` — returns `{ signedIn, user }`
- `GET /api/channels` — returns guild + channels from `userSession.guild()`
- `GET /api/messages/:channelId?limit=50` — returns recent messages from `userSession.messages(...)`
- `POST /api/messages/:channelId` — sends a message as the logged-in user via `userSession.send(...)`
- `GET /api/logout` (also POST) — revokes refresh token when possible and destroys session

### Realtime

When a browser connects via Socket.IO and is authenticated:
- The server opens a Vortex realtime connection using `vortex.forUser(tokens).connect()`
- It listens for `message`, `edit`, and `delete` events
- It logs events server-side and forwards them to browser clients in the matching channel room

This keeps Vortex tokens/secrets on the server.

### App/Bot session example

`server.js` includes `sendAppAnnouncement(channelId, content)`:

```js
const appSession = vortex.app();
const { guild, channels } = await appSession.guild();
await appSession.announce(channelId, "Server restart in 5 minutes!");
```

There is also an optional demo endpoint:

```http
POST /api/admin/announce
x-admin-demo-key: <ADMIN_DEMO_KEY>
Content-Type: application/json

{
  "channelId": "channel-id",
  "content": "Hello from the app!"
}
```

Enable it only for local testing by setting `ADMIN_DEMO_KEY` in `.env`. Do not expose it publicly without proper auth.

## 5) Storage notes

This demo uses:
- `express-session` MemoryStore for session cookies (demo only)
- In-memory `Map` + a local `.data-store.json` file for demo persistence

**Production TODO:**
- Replace MemoryStore with Redis/Postgres-backed session store.
- Replace in-memory/JSON user storage with a real database.
- Encrypt refresh tokens at rest.
- Add audit logging, rate limiting, CSRF protection for cross-origin setups, and monitoring.

## 6) Token refresh & security

- `vortex.forUser(tokens, { onRefresh })` is used so rotated refresh tokens are saved.
- Vortex refresh tokens rotate on every use; always persist the newest tokens.
- OAuth callback validates `state`.
- PKCE is enabled by default by `getAuthorizeUrl`.
- API errors handle `VortexError`, including `429` rate limits.
- The client secret is never sent to the browser.

## 7) Troubleshooting

- **Missing VORTEX_CLIENT_SECRET / SESSION_SECRET**: create `.env` from `.env.example`.
- **OAuth callback error / bad redirect**: verify `VORTEX_REDIRECT_URI` is on a domain allowed in Vortex Partner Tools → Where it works.
- **401 from Vortex**: token may be expired/revoked; sign in again.
- **429 rate limited**: back off and retry; check `error.body`/logs for details.
- **Realtime not connecting**: ensure `socket.io-client` is installed (required by `@vortex-chat/sdk` realtime).
- **App announce fails**: your Vortex app needs a guild and `guild.announce` scope/permission as configured in Vortex.

## References

- Vortex SDK patterns used: `new Vortex(...)`, `getAuthorizeUrl`, `exchangeCode`, `forUser`, `app()`, `connect()`, `guild()`, `channels()`, `messages()`, `send()`, `announce()`.
- Vortex Partner Policy: https://vtx.chat/legal/partner-policy
