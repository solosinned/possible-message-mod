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

### Keep accounts across Railway deploys

Railway containers do not keep files between deployments unless the service has a persistent volume. In the Railway service settings, add a volume and mount it at `/data`. Orbit automatically saves `users.json` in the mounted volume using Railway's `RAILWAY_VOLUME_MOUNT_PATH`. You can instead set `USER_STORE_PATH` to an absolute file path inside your mounted volume.

Chat messages, direct messages, and active login sessions are held in memory and reset when the server restarts. There is no email verification or password reset flow yet.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Address the web server listens on |
| `PORT` | `3000` | Web server port |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Ollama server address |
| `OLLAMA_MODEL` | `llama3.2:1b` | Model used for bot replies |
| `USER_STORE_PATH` | `data/users.json`, or `users.json` in `RAILWAY_VOLUME_MOUNT_PATH` when set | Account data file |
| `COOKIE_SECURE` | `false` | Set to `true` when serving the site over HTTPS |

The site has `#general`, `#ai-lab`, and `#off-topic` channels, plus private one-to-one direct messages. Start a DM from another member's profile; active conversations appear in the sidebar, incoming messages are marked unread and play a short ping after the first page interaction. The members panel separates online and offline accounts.

Members can set a short bio, upload a PNG/JPEG/WebP profile picture, add a short audio track for their profile, choose Online/Away/Busy, and open profiles from the members list. Profile fields are saved with the account data.

The existing legacy `solosinned` account is promoted to owner on startup. Owners see Developer tools and can edit member bios and pictures, assign member/moderator/admin ranks, ghost messages so they are visible only to their sender, add warnings, mute, timeout (up to seven days), and ban/unban accounts. The account directory shows email, creation date, message count, active time, rank, warnings, and moderation state. Profile edits, ranks, moderation actions, message counts, and activity time are saved with account data; chat messages themselves remain in memory.

Run the tests with `npm test`.
