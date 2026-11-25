import "dotenv/config";

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import session from "express-session";
import { Server as SocketIOServer } from "socket.io";
import vortexSdk from "@vortex-chat/sdk";

// CJS interop: @vortex-chat/sdk exports { Vortex, VortexError, ... } via module.exports.
const { Vortex, VortexError } = vortexSdk;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const VORTEX_CLIENT_ID = process.env.VORTEX_CLIENT_ID || "vtx_4d21b21ace36baeb7916";
const VORTEX_CLIENT_SECRET = process.env.VORTEX_CLIENT_SECRET;
const SESSION_SECRET = process.env.SESSION_SECRET;
const VORTEX_REDIRECT_URI =
  process.env.VORTEX_REDIRECT_URI || `${BASE_URL}/auth/vortex/callback`;
const COOKIE_SECURE =
  process.env.COOKIE_SECURE === "true" || BASE_URL.startsWith("https://");

if (!VORTEX_CLIENT_SECRET) {
  throw new Error(
    "Missing VORTEX_CLIENT_SECRET. Copy .env.example to .env and set your secret."
  );
}
if (!SESSION_SECRET) {
  throw new Error(
    "Missing SESSION_SECRET. Copy .env.example to .env and set a long random secret."
  );
}

// ---------------------------------------------------------------------------
// Vortex client (server-side only - NEVER expose clientSecret to browser)
// ---------------------------------------------------------------------------

const vortex = new Vortex({
  clientId: VORTEX_CLIENT_ID,
  clientSecret: VORTEX_CLIENT_SECRET,
});

// ---------------------------------------------------------------------------
// Temporary in-memory storage
// Replace this with a real database (Postgres, Redis, SQLite, etc.) in production.
// Store: user profile, tokens, and any app-specific data.
// ---------------------------------------------------------------------------

/** @type {Map<string, { user: object, tokens: object, updatedAt: string, loggedOutAt?: string }>} */
const userStore = new Map();

function persistUser(vortexUser, tokens) {
  // TODO(production): upsert into your database instead of in-memory Map.
  // Store refresh tokens encrypted at rest. Never log tokens.
  const existing = userStore.get(vortexUser.id) || {};
  userStore.set(vortexUser.id, {
    ...existing,
    user: vortexUser,
    tokens,
    updatedAt: new Date().toISOString(),
  });
}

function getPersistedUser(userId) {
  return userStore.get(userId) || null;
}

// Optional: simple JSON file persistence for demo continuity across restarts.
// TODO(production): remove this and use a real database.
const DATA_FILE = path.join(__dirname, ".data-store.json");
function loadStoreFromDisk() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    for (const [id, record] of Object.entries(raw.users || {})) {
      userStore.set(id, record);
    }
    console.log(`[store] Loaded ${userStore.size} user(s) from ${DATA_FILE}`);
  } catch (err) {
    console.warn("[store] Could not load demo data file:", err.message);
  }
}
function saveStoreToDisk() {
  try {
    const users = Object.fromEntries(userStore.entries());
    fs.writeFileSync(DATA_FILE, JSON.stringify({ users }, null, 2));
  } catch (err) {
    console.warn("[store] Could not save demo data file:", err.message);
  }
}
loadStoreFromDisk();

// ---------------------------------------------------------------------------
// Express app + Socket.IO (for pushing realtime events to the browser)
// ---------------------------------------------------------------------------

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: COOKIE_SECURE ? { origin: BASE_URL, credentials: true } : undefined,
});

app.use(express.json({ limit: "32kb" }));
app.use(express.urlencoded({ extended: false }));

const sessionMiddleware = session({
  name: "vortex.sid",
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: COOKIE_SECURE,
    maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
  },
  // TODO(production): use a persistent session store (Redis, Postgres, etc.).
  // MemoryStore leaks memory and does not survive restarts/multiple instances.
});

app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, "public")));

// Share Express session with Socket.IO so browser connections are authenticated.
io.engine.use(sessionMiddleware);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  });
}

function requireAuth(req, res, next) {
  if (!req.session?.vortex?.tokens?.accessToken) {
    return res.status(401).json({ error: "Not signed in. Visit /auth/vortex to log in." });
  }
  next();
}

function sanitizeUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    avatar: user.avatar,
    avatarFrame: user.avatarFrame || "",
    rank: user.rank || "",
    color: user.color || "",
    premium: user.premium || 0,
    level: user.level || 0,
  };
}

function serializeMessage(message) {
  return {
    id: message.id,
    channelId: message.channelId,
    content: message.content,
    author: {
      id: message.author?.id,
      username: message.author?.username,
      avatar: message.author?.avatar,
      rank: message.author?.rank,
      color: message.author?.color,
    },
    createdAt: message.createdAt instanceof Date ? message.createdAt.toISOString() : message.createdAt,
    editedAt: message.editedAt instanceof Date ? message.editedAt.toISOString() : message.editedAt,
    system: !!message.system,
    kind: message.kind || "",
    source: message.source || "vortex",
    replyTo: message.replyTo || null,
    attachments: message.attachments || [],
  };
}

function assertChannelId(channelId) {
  if (typeof channelId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(channelId)) {
    const err = new Error("Invalid channelId");
    err.statusCode = 400;
    throw err;
  }
  return channelId;
}

function roomForChannel(channelId) {
  return `channel:${channelId}`;
}

/**
 * Create a Vortex UserSession for the current logged-in user.
 * onRefresh persists rotated refresh tokens - this is important because
 * Vortex refresh tokens rotate on every use.
 */
function getUserSession(req) {
  const sessionData = req.session.vortex;
  if (!sessionData?.tokens) throw new VortexError("Not signed in", 401);

  return vortex.forUser(sessionData.tokens, {
    onRefresh: async (newTokens) => {
      req.session.vortex.tokens = newTokens;
      if (req.session.vortex.user?.id) {
        persistUser(req.session.vortex.user, newTokens);
        saveStoreToDisk();
      }
      try {
        await saveSession(req);
      } catch (err) {
        console.warn("[auth] Failed to save refreshed tokens to session:", err.message);
      }
    },
  });
}

function handleApiError(err, res) {
  if (err instanceof VortexError) {
    const status = err.status || 500;

    if (status === 429) {
      // Vortex rate limit. err.body may include retry information.
      console.warn("[vortex] Rate limited (429):", err.message, err.body);
      return res.status(429).json({
        error: "Rate limited by Vortex. Please retry shortly.",
        detail: err.message,
        body: err.body,
      });
    }

    if (status === 401) {
      return res.status(401).json({
        error: "Vortex authentication failed. Please sign in again.",
        detail: err.message,
      });
    }

    return res.status(status >= 400 && status < 600 ? status : 502).json({
      error: err.message || "Vortex API error",
      status,
    });
  }

  console.error("[api] Unexpected error:", err);
  return res.status(500).json({ error: "Internal server error" });
}

// ---------------------------------------------------------------------------
// D. Realtime: Vortex realtime connection per logged-in browser session
// ---------------------------------------------------------------------------

/**
 * Active Vortex realtime connections keyed by Express session ID.
 * Each entry: { rt, userId, refCount }
 */
const realtimeConnections = new Map();

async function ensureRealtimeForSession(reqSession) {
  const sessionId = reqSession.id;
  const vortexData = reqSession.vortex;
  if (!vortexData?.tokens?.accessToken) return null;

  const existing = realtimeConnections.get(sessionId);
  if (existing) return existing.rt;

  // Build a UserSession from stored tokens. onRefresh updates the persisted record.
  const userSession = vortex.forUser(vortexData.tokens, {
    onRefresh: async (newTokens) => {
      vortexData.tokens = newTokens;
      if (vortexData.user?.id) {
        persistUser(vortexData.user, newTokens);
        saveStoreToDisk();
      }
      // Session object is in-memory here; express-session will persist on next request/save.
      // TODO(production): persist refreshed tokens in your DB and session store reliably.
    },
  });

  console.log(`[realtime] Connecting Vortex realtime for user ${vortexData.user?.username || "unknown"}`);
  const rt = await userSession.connect();

  rt.on("ready", () => {
    console.log(`[realtime] Ready for session ${sessionId}`);
  });

  rt.on("message", (message) => {
    const payload = serializeMessage(message);
    console.log(`[realtime] New message in ${payload.channelId} from ${payload.author?.username}: ${payload.content}`);
    io.to(roomForChannel(payload.channelId)).emit("chat:message", payload);
  });

  rt.on("edit", (message) => {
    const payload = serializeMessage(message);
    console.log(`[realtime] Message edited in ${payload.channelId}: ${payload.id}`);
    io.to(roomForChannel(payload.channelId)).emit("chat:messageUpdated", payload);
  });

  rt.on("delete", ({ id, channelId }) => {
    console.log(`[realtime] Message deleted in ${channelId}: ${id}`);
    io.to(roomForChannel(channelId)).emit("chat:messageDeleted", { id, channelId });
  });

  rt.on("error", (err) => {
    console.warn(`[realtime] Error for session ${sessionId}:`, err?.message || err);
  });

  rt.on("disconnect", (reason) => {
    console.log(`[realtime] Disconnected for session ${sessionId}:`, reason);
  });

  realtimeConnections.set(sessionId, {
    rt,
    userId: vortexData.user?.id || null,
    refCount: 0,
  });

  return rt;
}

function closeRealtimeForSession(sessionId) {
  const entry = realtimeConnections.get(sessionId);
  if (!entry) return;
  try {
    entry.rt.close();
  } catch (err) {
    console.warn("[realtime] Error closing connection:", err.message);
  }
  realtimeConnections.delete(sessionId);
}

// Socket.IO: authenticate browser clients and bridge Vortex realtime events.
io.on("connection", async (socket) => {
  const reqSession = socket.request.session;
  const sessionId = socket.request.sessionID || reqSession?.id;
  const vortexData = reqSession?.vortex;

  if (!sessionId || !vortexData?.tokens?.accessToken) {
    socket.emit("chat:error", { error: "Not signed in" });
    socket.disconnect(true);
    return;
  }

  try {
    await ensureRealtimeForSession({ ...reqSession, id: sessionId });
    const entry = realtimeConnections.get(sessionId);
    if (entry) entry.refCount += 1;
  } catch (err) {
    console.warn("[socket.io] Failed to establish Vortex realtime:", err.message);
    socket.emit("chat:error", { error: "Failed to connect realtime." });
  }

  socket.on("chat:join", (payload) => {
    try {
      const channelId = assertChannelId(payload?.channelId);
      for (const room of socket.rooms) {
        if (room.startsWith("channel:")) socket.leave(room);
      }
      socket.join(roomForChannel(channelId));
    } catch (err) {
      socket.emit("chat:error", { error: err.message });
    }
  });

  socket.on("disconnect", () => {
    const entry = realtimeConnections.get(sessionId);
    if (!entry) return;
    entry.refCount = Math.max(0, entry.refCount - 1);
    // Keep connection alive briefly for page refreshes; close after grace period if unused.
    setTimeout(() => {
      const current = realtimeConnections.get(sessionId);
      if (current && current.refCount === 0) {
        closeRealtimeForSession(sessionId);
      }
    }, 30_000);
  });
});

// ---------------------------------------------------------------------------
// A. OAuth Login Flow
// ---------------------------------------------------------------------------

// GET /auth/vortex -> redirect user to Vortex login
app.get("/auth/vortex", async (req, res) => {
  try {
    // getAuthorizeUrl generates state + PKCE codeVerifier by default (pkce: true).
    const { url, state, codeVerifier } = vortex.getAuthorizeUrl({
      redirectUri: VORTEX_REDIRECT_URI,
      // scopes: ["identify", "chat.read", "chat.write"], // optional; Vortex picks defaults
    });

    // Store state + codeVerifier in session for callback validation.
    req.session.oauth = {
      state,
      codeVerifier,
      createdAt: Date.now(),
    };
    await saveSession(req);

    return res.redirect(url);
  } catch (err) {
    console.error("[oauth] Failed to create authorize URL:", err);
    return res.status(500).send("Failed to start Vortex login.");
  }
});

// GET /auth/vortex/callback -> exchange code for tokens, save user, log in
app.get("/auth/vortex/callback", async (req, res) => {
  try {
    const { code, state, error, error_description: errorDescription } = req.query;

    if (error) {
      console.warn("[oauth] Vortex returned error:", error, errorDescription);
      return res.status(400).send(`Vortex login failed: ${String(errorDescription || error)}`);
    }

    if (typeof code !== "string" || typeof state !== "string") {
      return res.status(400).send("Missing OAuth code or state.");
    }

    const pending = req.session.oauth;
    if (!pending?.state || !pending?.codeVerifier) {
      return res.status(400).send("Missing OAuth session. Please start login again.");
    }

    // Always validate state to prevent CSRF.
    if (state !== pending.state) {
      return res.status(400).send("Invalid OAuth state. Please start login again.");
    }

    // Optional: reject stale OAuth attempts (10 minutes).
    if (Date.now() - pending.createdAt > 10 * 60 * 1000) {
      delete req.session.oauth;
      return res.status(400).send("OAuth attempt expired. Please start login again.");
    }

    // Exchange authorization code for tokens. PKCE codeVerifier is required.
    const tokens = await vortex.exchangeCode({
      code,
      redirectUri: VORTEX_REDIRECT_URI,
      codeVerifier: pending.codeVerifier,
    });

    // Clean up one-time OAuth state.
    delete req.session.oauth;

    // tokens.user may be included; fetch /me as a reliable source when needed.
    let vortexUser = tokens.user;
    if (!vortexUser?.id) {
      vortexUser = await vortex.getUser(tokens.accessToken);
    }

    const safeUser = sanitizeUser(vortexUser);

    // Store tokens and user profile in session.
    req.session.vortex = {
      tokens,
      user: safeUser,
    };

    // Persist in demo store / database.
    persistUser(safeUser, tokens);
    saveStoreToDisk();

    await saveSession(req);

    console.log(`[oauth] User signed in: ${safeUser.username} (${safeUser.id})`);
    return res.redirect("/");
  } catch (err) {
    console.error("[oauth] Callback failed:", err);
    if (err instanceof VortexError) {
      return res.status(err.status || 500).send(`Vortex OAuth error: ${err.message}`);
    }
    return res.status(500).send("OAuth callback failed.");
  }
});

// ---------------------------------------------------------------------------
// B/C. Protected routes / API
// ---------------------------------------------------------------------------

// GET /api/me -> current logged-in Vortex user
app.get("/api/me", async (req, res) => {
  try {
    if (!req.session?.vortex?.tokens?.accessToken) {
      return res.json({ signedIn: false });
    }

    const userSession = getUserSession(req);
    let me = req.session.vortex.user;
    try {
      me = sanitizeUser(await userSession.me());
      req.session.vortex.user = me;
      persistUser(me, req.session.vortex.tokens);
      saveStoreToDisk();
      await saveSession(req);
    } catch (err) {
      // Serve cached session profile if Vortex is temporarily unavailable.
      console.warn("[/api/me] Could not refresh profile from Vortex:", err.message);
    }

    return res.json({
      signedIn: true,
      user: me,
    });
  } catch (err) {
    return handleApiError(err, res);
  }
});

// GET /api/channels -> guild + list of channels the user can see
app.get("/api/channels", requireAuth, async (req, res) => {
  try {
    const userSession = getUserSession(req);
    const data = await userSession.guild(); // { guild, channels, app, permissions? }

    return res.json({
      guild: data.guild,
      channels: (data.channels || []).map((c) => ({
        id: c.id,
        type: c.type,
        name: c.name,
        description: c.description || "",
        icon: c.icon || "",
        category: c.category || "",
        position: c.position ?? 0,
        locked: !!c.locked,
        slowmodeSeconds: c.slowmodeSeconds || 0,
        canSend: !!c.canSend,
      })),
      permissions: data.permissions || null,
    });
  } catch (err) {
    return handleApiError(err, res);
  }
});

// GET /api/messages/:channelId -> recent messages (limit 50)
app.get("/api/messages/:channelId", requireAuth, async (req, res) => {
  try {
    const channelId = assertChannelId(req.params.channelId);
    const requestedLimit = Number(req.query.limit);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 50)
      : 50;

    const userSession = getUserSession(req);
    const result = await userSession.messages(channelId, { limit });

    return res.json({
      channelId,
      messages: result.messages.map(serializeMessage),
      hasMore: !!result.hasMore,
    });
  } catch (err) {
    if (err.statusCode === 400) return res.status(400).json({ error: err.message });
    return handleApiError(err, res);
  }
});

// POST /api/messages/:channelId -> send a message as the logged-in user
app.post("/api/messages/:channelId", requireAuth, async (req, res) => {
  try {
    const channelId = assertChannelId(req.params.channelId);
    const content = typeof req.body?.content === "string" ? req.body.content.trim() : "";

    if (!content) return res.status(400).json({ error: "Message content is required." });
    if (content.length > 2000) {
      return res.status(400).json({ error: "Message is too long (max 2000 characters)." });
    }

    const userSession = getUserSession(req);
    const sent = await userSession.send(channelId, content);
    const payload = serializeMessage(sent);

    // Optimistically push to browser clients. Realtime listener may also deliver it;
    // the frontend dedupes by message ID.
    io.to(roomForChannel(channelId)).emit("chat:message", payload);

    return res.status(201).json({ message: payload });
  } catch (err) {
    if (err.statusCode === 400) return res.status(400).json({ error: err.message });
    return handleApiError(err, res);
  }
});

// GET /api/logout -> destroys the session
app.get("/api/logout", logoutHandler);
app.post("/api/logout", logoutHandler);

async function logoutHandler(req, res) {
  const tokens = req.session?.vortex?.tokens;
  const userId = req.session?.vortex?.user?.id;

  closeRealtimeForSession(req.sessionID);

  // Revoke refresh token so it cannot be reused.
  if (tokens?.refreshToken) {
    try {
      await vortex.revoke(tokens.refreshToken);
    } catch (err) {
      console.warn("[logout] Failed to revoke Vortex token:", err.message);
    }
  }

  // TODO(production): also remove/invalidate user records/tokens in your database as needed.
  if (userId) {
    const record = getPersistedUser(userId);
    if (record) {
      record.tokens = null;
      record.loggedOutAt = new Date().toISOString();
      userStore.set(userId, record);
      saveStoreToDisk();
    }
  }

  req.session.destroy((err) => {
    if (err) {
      console.error("[logout] Session destroy failed:", err);
      return res.status(500).json({ error: "Failed to log out." });
    }
    res.clearCookie("vortex.sid");
    if (req.method === "GET" && (req.headers.accept || "").includes("text/html")) {
      return res.redirect("/");
    }
    return res.json({ ok: true });
  });
}

// ---------------------------------------------------------------------------
// E. App/Bot session example (server-to-server, uses client credentials)
// ---------------------------------------------------------------------------

/**
 * Example: send an announcement as your app/bot.
 *
 * AppSession uses the client secret (server-side only) and can act on your own guild.
 * This is different from UserSession, which acts on behalf of a logged-in Vortex user.
 */
async function sendAppAnnouncement(channelId, content) {
  const appSession = vortex.app(); // client-credentials app session (cached by SDK)

  // Fetch guild info/channels visible to the app.
  const { guild, channels } = await appSession.guild();
  console.log(`[app] Connected as app to guild "${guild.name}" (${guild.id})`);
  console.log(`[app] Guild has ${channels.length} channel(s)`);

  // Post an announcement to a channel. Requires guild.announce scope on the app.
  const announcement = await appSession.announce(channelId, content);
  console.log("[app] Announcement sent:", announcement);
  return announcement;
}

// Optional demo endpoint for the AppSession example.
// Protect this in production! Here it's gated by ADMIN_DEMO_KEY env var.
app.post("/api/admin/announce", async (req, res) => {
  try {
    const configuredKey = process.env.ADMIN_DEMO_KEY;
    if (!configuredKey) {
      return res.status(403).json({
        error: "ADMIN_DEMO_KEY is not configured. Set it in .env to enable this demo endpoint.",
      });
    }

    const providedKey = req.header("x-admin-demo-key");
    if (!providedKey || providedKey !== configuredKey) {
      return res.status(401).json({ error: "Invalid admin demo key." });
    }

    const channelId = assertChannelId(req.body?.channelId);
    const content = typeof req.body?.content === "string" ? req.body.content.trim() : "";
    if (!content) return res.status(400).json({ error: "content is required" });

    const announcement = await sendAppAnnouncement(channelId, content);
    return res.status(201).json({ ok: true, announcement });
  } catch (err) {
    if (err.statusCode === 400) return res.status(400).json({ error: err.message });
    return handleApiError(err, res);
  }
});

// Example: open an app realtime connection and log events.
// Call this if you want the bot/app to listen for messages across the guild.
/*
async function startAppRealtimeListener() {
  const appSession = vortex.app();
  const live = await appSession.connect(); // joins every channel your guild has

  live.on("ready", () => console.log("[app-realtime] Ready"));
  live.on("message", (msg) => console.log(`[app-realtime] ${msg.author.username}: ${msg.content}`));
  live.on("delete", ({ id }) => console.log("[app-realtime] deleted", id));
  live.on("error", (err) => console.warn("[app-realtime] error", err.message));
}
startAppRealtimeListener().catch(console.error);
*/

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

server.listen(PORT, () => {
  console.log(`Vortex Chat demo listening on ${BASE_URL}`);
  console.log(`OAuth callback: ${VORTEX_REDIRECT_URI}`);
  console.log("Make sure this callback domain/IP is allowed in Vortex Partner Tools -> Where it works.");
});
