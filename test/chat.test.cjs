const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
    getUserStorePath,
    createChatState,
    generateBotReply,
    botUnavailableMessage,
    createChatServer
} = require('../bot.js');

test('stores accounts in the Railway volume when one is mounted', () => {
    assert.equal(
        getUserStorePath({ RAILWAY_VOLUME_MOUNT_PATH: '/data' }),
        '/data/users.json'
    );
    assert.equal(
        getUserStorePath({ RAILWAY_VOLUME_MOUNT_PATH: '/data', USER_STORE_PATH: '/accounts/users.json' }),
        '/accounts/users.json'
    );
});

async function startServer(t, options = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-chat-test-'));
    const userStorePath = options.userStorePath || path.join(directory, 'users.json');
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const server = await createChatServer({ host: '127.0.0.1', port: 0, userStorePath, ...options });
    t.after(() => new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    }));
    const address = server.address();
    return `http://127.0.0.1:${address.port}`;
}

async function join(baseUrl, username, email = `${username.toLowerCase()}@example.com`, password = 'safe-password-123') {
    const response = await fetch(`${baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, email, password })
    });
    return {
        response,
        cookie: response.headers.get('set-cookie')?.split(';')[0]
    };
}

test('generates a concise bot reply with recent channel context', async () => {
    let requestUrl;
    let requestOptions;
    const reply = await generateBotReply([
        { author: 'Alice', content: 'What should we build?', kind: 'user' },
        { author: 'Orbit', content: 'A tiny chat site.', kind: 'bot' },
        { author: 'Bob', content: '@bot can we add reactions?', kind: 'user' }
    ], async (url, options) => {
        requestUrl = url;
        requestOptions = options;
        return {
            ok: true,
            json: async () => ({ message: { content: 'Sure, reactions would be a fun addition.' } })
        };
    }, { baseUrl: 'http://ollama.local/', model: 'test-model' });

    assert.equal(requestUrl, 'http://ollama.local/api/chat');
    const payload = JSON.parse(requestOptions.body);
    assert.equal(payload.model, 'test-model');
    assert.equal(payload.stream, false);
    assert.deepEqual(payload.messages.slice(1), [
        { role: 'user', content: 'Alice: What should we build?' },
        { role: 'assistant', content: 'A tiny chat site.' },
        { role: 'user', content: 'Bob: @bot can we add reactions?' }
    ]);
    assert.equal(reply, 'Sure, reactions would be a fun addition.');
});

test('rejects failed and empty AI responses', async () => {
    await assert.rejects(generateBotReply([], async () => ({ ok: false, status: 503 })), /request failed \(503\)/);
    await assert.rejects(generateBotReply([], async () => ({
        ok: true,
        json: async () => ({ message: { content: '  ' } })
    })), /empty response/);
});

test('explains how to get Ollama running', () => {
    assert.match(
        botUnavailableMessage(new TypeError('fetch failed', { cause: new Error('connection refused') }), 'http://127.0.0.1:11434', 'llama3.2:1b'),
        /Start Ollama on the chat server with "ollama serve"/
    );
    assert.match(
        botUnavailableMessage(new Error('Ollama request failed (404)'), 'http://localhost:11434', 'test-model'),
        /ollama pull test-model/
    );
});

test('serves the chat app with security headers and no external chat integration', async t => {
    const baseUrl = await startServer(t);
    const response = await fetch(baseUrl);
    const page = await response.text();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.match(response.headers.get('content-security-policy'), /media-src 'self' data: blob:/);
    assert.match(page, /Orbit community/);
    assert.match(page, /@bot/);
    assert.match(page, /Username or email/);
    assert.match(page, /Create account/);
    assert.match(page, /id="attach-image"/);
    assert.match(page, /message-reply-button/);
    assert.match(page, /\.message\.has-reply \.message-text \{/);
    assert.match(page, /\.message\.has-reply \.message-image \{/);
    assert.match(page, /message\.replyTo \? ' has-reply' : ''/);
    assert.doesNotMatch(page, /\.message\.has-reply \{[^}]*background/);
    assert.match(page, /id="moderation-dialog"/);
    assert.match(page, /id="moderation-duration"/);
    assert.match(page, /id="moderation-reason"/);
    assert.match(page, /channel: appState\.channel/);
    assert.doesNotMatch(page, /replied-to-target/);
    assert.match(page, /\.message-scroll \{ display: flex; min-height: 0;/);
    assert.match(page, /@keyframes content-enter/);
    assert.match(page, /profile-edit-form\.editor-enter/);
    assert.match(page, /prefers-reduced-motion: reduce/);
    assert.doesNotMatch(page, /https?:\/\//);
});

test('requires an account session before reading channels or messages', async t => {
    const baseUrl = await startServer(t);
    const channels = await fetch(`${baseUrl}/api/channels`);
    const messages = await fetch(`${baseUrl}/api/messages?channel=general`);
    const directMessages = await fetch(`${baseUrl}/api/dms`);

    assert.equal(channels.status, 401);
    assert.equal(messages.status, 401);
    assert.equal(directMessages.status, 401);
});

test('creates an account and prevents duplicate usernames or emails', async t => {
    const baseUrl = await startServer(t);
    const alice = await join(baseUrl, 'Alice', 'alice@example.com');
    const duplicateUsername = await join(baseUrl, 'alice', 'alice2@example.com');
    const duplicateEmail = await join(baseUrl, 'Alice2', 'ALICE@example.com');
    const reserved = await join(baseUrl, 'Orbit', 'orbit@example.com');

    assert.equal(alice.response.status, 201);
    assert.match(alice.cookie, /^chat_session=[a-f0-9]{48}$/);
    assert.equal(duplicateUsername.response.status, 409);
    assert.match((await duplicateUsername.response.json()).error, /already registered/);
    assert.equal(duplicateEmail.response.status, 409);
    assert.equal(reserved.response.status, 400);
});

test('signs in with either the username or email', async t => {
    const baseUrl = await startServer(t);
    await join(baseUrl, 'Alice', 'alice@example.com');
    const usernameLogin = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: 'Alice', password: 'safe-password-123' })
    });
    const emailLogin = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: 'ALICE@example.com', password: 'safe-password-123' })
    });

    assert.equal(usernameLogin.status, 200);
    assert.equal(emailLogin.status, 200);
    assert.equal((await emailLogin.json()).user.name, 'Alice');
    assert.match(emailLogin.headers.get('set-cookie'), /^chat_session=/);
});

test('logs out and clears the session cookie', async t => {
    const baseUrl = await startServer(t);
    const { cookie } = await join(baseUrl, 'Alice');
    const logout = await fetch(`${baseUrl}/api/auth/logout`, {
        method: 'POST',
        headers: { Cookie: cookie }
    });
    const session = await fetch(`${baseUrl}/api/session`, { headers: { Cookie: cookie } });

    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await session.json()).user, null);
});

test('sends and retrieves private direct messages only within each conversation', async t => {
    const baseUrl = await startServer(t);
    const { cookie: aliceCookie } = await join(baseUrl, 'DirectAlice');
    const { cookie: bobCookie } = await join(baseUrl, 'DirectBob');
    const { cookie: eveCookie } = await join(baseUrl, 'DirectEve');
    const sent = await fetch(`${baseUrl}/api/dms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: aliceCookie },
        body: JSON.stringify({ recipient: 'DirectBob', content: 'Hello privately.' })
    });
    const sentResult = await sent.json();
    const bobMessages = await fetch(`${baseUrl}/api/dms/DirectAlice`, { headers: { Cookie: bobCookie } });
    const aliceMessages = await fetch(`${baseUrl}/api/dms/DirectBob`, { headers: { Cookie: aliceCookie } });
    const aliceConversations = await fetch(`${baseUrl}/api/dms`, { headers: { Cookie: aliceCookie } });
    const bobConversations = await fetch(`${baseUrl}/api/dms`, { headers: { Cookie: bobCookie } });
    const eveMessages = await fetch(`${baseUrl}/api/dms/DirectBob`, { headers: { Cookie: eveCookie } });

    assert.equal(sent.status, 201);
    assert.deepEqual(sentResult.message, {
        id: 1,
        author: 'DirectAlice',
        content: 'Hello privately.',
        image: null,
        replyTo: null,
        kind: 'user',
        createdAt: sentResult.message.createdAt
    });
    assert.deepEqual((await bobMessages.json()).messages, [sentResult.message]);
    assert.deepEqual((await aliceMessages.json()).messages, [sentResult.message]);
    assert.equal((await aliceConversations.json()).conversations[0].username, 'DirectBob');
    const bobConversation = (await bobConversations.json()).conversations[0];
    assert.equal(bobConversation.username, 'DirectAlice');
    assert.equal(bobConversation.latestIncomingMessageId, sentResult.message.id);
    assert.deepEqual((await eveMessages.json()).messages, []);

    await new Promise(resolve => setTimeout(resolve, 320));
    const imageBytes = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]);
    const image = `data:image/webp;base64,${imageBytes.toString('base64')}`;
    const replyResponse = await fetch(`${baseUrl}/api/dms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: bobCookie },
        body: JSON.stringify({
            recipient: 'DirectAlice',
            content: 'Here is the image.',
            image,
            replyToId: sentResult.message.id
        })
    });
    const reply = (await replyResponse.json()).message;
    const aliceUpdated = await fetch(`${baseUrl}/api/dms/DirectBob`, { headers: { Cookie: aliceCookie } });

    assert.equal(replyResponse.status, 201);
    assert.equal(reply.image, image);
    assert.deepEqual(reply.replyTo, {
        id: sentResult.message.id,
        author: 'DirectAlice',
        content: 'Hello privately.',
        image: false
    });
    assert.deepEqual((await aliceUpdated.json()).messages, [sentResult.message, reply]);
});

test('supports image-only channel messages and replies with message context', async t => {
    const baseUrl = await startServer(t);
    const { cookie } = await join(baseUrl, 'ReplyUser');
    const headers = { 'Content-Type': 'application/json', Cookie: cookie };
    const imageBytes = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]);
    const image = `data:image/webp;base64,${imageBytes.toString('base64')}`;
    const originalResponse = await fetch(`${baseUrl}/api/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ channel: 'general', content: 'Original message' })
    });
    const original = (await originalResponse.json()).message;
    await new Promise(resolve => setTimeout(resolve, 320));
    const replyResponse = await fetch(`${baseUrl}/api/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ channel: 'general', content: '', image, replyToId: original.id })
    });
    const reply = (await replyResponse.json()).message;
    const history = await fetch(`${baseUrl}/api/messages?channel=general`, { headers: { Cookie: cookie } });
    const messages = (await history.json()).messages;

    assert.equal(originalResponse.status, 201);
    assert.equal(replyResponse.status, 201);
    assert.equal(reply.image, image);
    assert.deepEqual(reply.replyTo, {
        id: original.id,
        author: 'ReplyUser',
        content: 'Original message',
        image: false
    });
    assert.deepEqual(messages, [original, reply]);
});

test('rejects invalid chat images and replies to missing messages', async t => {
    const baseUrl = await startServer(t);
    const { cookie } = await join(baseUrl, 'InvalidImageUser');
    const headers = { 'Content-Type': 'application/json', Cookie: cookie };
    const invalidImage = await fetch(`${baseUrl}/api/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ channel: 'general', content: '', image: 'data:image/png;base64,AAAA' })
    });
    const missingReply = await fetch(`${baseUrl}/api/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ channel: 'general', content: 'Reply', replyToId: 999 })
    });

    assert.equal(invalidImage.status, 400);
    assert.equal(missingReply.status, 400);
});

test('returns separate online and offline user directories', async t => {
    const baseUrl = await startServer(t);
    const { cookie: aliceCookie } = await join(baseUrl, 'OnlineAlice');
    const { cookie: bobCookie } = await join(baseUrl, 'OfflineBob');
    await fetch(`${baseUrl}/api/auth/logout`, {
        method: 'POST',
        headers: { Cookie: bobCookie }
    });

    const response = await fetch(`${baseUrl}/api/users`, { headers: { Cookie: aliceCookie } });
    const result = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(result.users.map(user => user.username), ['OnlineAlice']);
    assert.deepEqual(result.offlineUsers.map(user => user.username), ['OfflineBob']);
});

test('saves profile pictures, bios, and status and returns public profiles', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-profile-test-'));
    const userStorePath = path.join(directory, 'users.json');
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const baseUrl = await startServer(t, { userStorePath });
    const { cookie } = await join(baseUrl, 'ProfileUser');
    const avatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pS8AAAAASUVORK5CYII=';
    const update = await fetch(`${baseUrl}/api/profile/me`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ bio: 'Hello from my profile.', avatar, status: 'busy' })
    });
    const saved = await update.json();
    const ownProfile = await fetch(`${baseUrl}/api/profile/me`, { headers: { Cookie: cookie } });
    const publicProfile = await fetch(`${baseUrl}/api/profile/profileuser`, { headers: { Cookie: cookie } });
    const users = await fetch(`${baseUrl}/api/users`, { headers: { Cookie: cookie } });

    assert.equal(update.status, 200);
    assert.deepEqual(saved.profile, {
        username: 'ProfileUser',
        bio: 'Hello from my profile.',
        avatar,
        music: null,
        status: 'busy',
        role: 'member'
    });
    assert.deepEqual((await ownProfile.json()).profile, saved.profile);
    assert.deepEqual((await publicProfile.json()).profile, saved.profile);
    const activeUser = (await users.json()).users[0];
    assert.equal(activeUser.username, 'ProfileUser');
    assert.equal(activeUser.status, 'busy');
    assert.equal(activeUser.avatar, avatar);
    assert.equal(Object.hasOwn(activeUser, 'music'), false);
    const stored = JSON.parse(await fs.readFile(userStorePath, 'utf8'));
    assert.equal(stored[0].bio, 'Hello from my profile.');
    assert.equal(stored[0].avatar, avatar);
    assert.equal(stored[0].status, 'busy');
    assert.equal(typeof stored[0].email, 'string');
    assert.equal(typeof stored[0].passwordHash, 'string');
});

test('saves profile music and returns it on public profiles', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-music-test-'));
    const userStorePath = path.join(directory, 'users.json');
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const baseUrl = await startServer(t, { userStorePath });
    const { cookie } = await join(baseUrl, 'MusicUser');
    const music = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10';
    const update = await fetch(`${baseUrl}/api/profile/me`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ bio: 'I make playlists.', avatar: null, music, status: 'online' })
    });
    const saved = await update.json();
    const publicProfile = await fetch(`${baseUrl}/api/profile/musicuser`, { headers: { Cookie: cookie } });
    const members = await fetch(`${baseUrl}/api/users`, { headers: { Cookie: cookie } });
    const stored = JSON.parse(await fs.readFile(userStorePath, 'utf8'));

    assert.equal(update.status, 200);
    assert.deepEqual(saved.profile, {
        username: 'MusicUser',
        bio: 'I make playlists.',
        avatar: null,
        music,
        status: 'online',
        role: 'member'
    });
    assert.deepEqual((await publicProfile.json()).profile, saved.profile);
    const directoryEntry = (await members.json()).users[0];
    assert.equal(Object.hasOwn(directoryEntry, 'music'), false);
    assert.equal(stored[0].music, music);
});

test('accepts profile music up to 6 MB and rejects larger files', async t => {
    const baseUrl = await startServer(t);
    const { cookie } = await join(baseUrl, 'MusicLimitUser');
    const headers = { 'Content-Type': 'application/json', Cookie: cookie };
    const saveMusic = music => fetch(`${baseUrl}/api/profile/me`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ bio: '', music: `data:audio/mpeg;base64,${music}` })
    });

    const withinLimit = await saveMusic(Buffer.alloc(6 * 1024 * 1024).toString('base64'));
    const overLimit = await saveMusic(Buffer.alloc(6 * 1024 * 1024 + 1).toString('base64'));

    assert.equal(withinLimit.status, 200);
    assert.equal(overLimit.status, 400);
    assert.match((await overLimit.json()).error, /up to 6 MB/);
});

test('keeps profile pictures, bios, and status after a server restart', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-profile-restart-'));
    const userStorePath = path.join(directory, 'users.json');
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const first = await createChatServer({ host: '127.0.0.1', port: 0, userStorePath });
    const firstBase = `http://127.0.0.1:${first.address().port}`;
    const { cookie } = await join(firstBase, 'RestartUser');
    const avatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pS8AAAAASUVORK5CYII=';
    await fetch(`${firstBase}/api/profile/me`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ bio: 'Saved between restarts.', avatar, status: 'away' })
    });
    await new Promise((resolve, reject) => first.close(error => error ? reject(error) : resolve()));

    const second = await createChatServer({ host: '127.0.0.1', port: 0, userStorePath });
    t.after(() => new Promise((resolve, reject) => second.close(error => error ? reject(error) : resolve())));
    const secondBase = `http://127.0.0.1:${second.address().port}`;
    const login = await fetch(`${secondBase}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: 'RestartUser', password: 'safe-password-123' })
    });
    const newCookie = login.headers.get('set-cookie').split(';')[0];
    const profile = await fetch(`${secondBase}/api/profile/me`, { headers: { Cookie: newCookie } });

    assert.equal(login.status, 200);
    assert.deepEqual((await profile.json()).profile, {
        username: 'RestartUser',
        bio: 'Saved between restarts.',
        avatar,
        music: null,
        status: 'away',
        role: 'member'
    });
});

test('owner tools manage ranks, ghosting, moderation, and account stats', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-admin-test-'));
    const userStorePath = path.join(directory, 'users.json');
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const first = await createChatServer({ host: '127.0.0.1', port: 0, userStorePath });
    const firstBase = `http://127.0.0.1:${first.address().port}`;
    await join(firstBase, 'solosinned', 'solo@example.com');
    await new Promise((resolve, reject) => first.close(error => error ? reject(error) : resolve()));
    const accounts = JSON.parse(await fs.readFile(userStorePath, 'utf8'));
    accounts[0].createdAt = null;
    accounts[0].role = 'member';
    await fs.writeFile(userStorePath, JSON.stringify(accounts));

    const server = await createChatServer({ host: '127.0.0.1', port: 0, userStorePath });
    t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const base = `http://127.0.0.1:${server.address().port}`;
    const ownerLogin = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: 'solo@example.com', password: 'safe-password-123' })
    });
    const ownerCookie = ownerLogin.headers.get('set-cookie').split(';')[0];
    const target = await join(base, 'TargetUser');
    const reader = await join(base, 'ReaderUser');
    const targetCookie = target.cookie;
    const readerCookie = reader.cookie;

    const forbidden = await fetch(`${base}/api/admin/accounts`, { headers: { Cookie: readerCookie } });
    const forbiddenAction = await fetch(`${base}/api/admin/accounts/TargetUser`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: readerCookie },
        body: JSON.stringify({ action: 'ban' })
    });
    const list = await fetch(`${base}/api/admin/accounts`, { headers: { Cookie: ownerCookie } });
    assert.equal(forbidden.status, 403);
    assert.equal(forbiddenAction.status, 403);
    assert.equal(list.status, 200);
    assert.equal((await list.json()).accounts.find(account => account.username === 'solosinned').role, 'owner');

    const adminAction = (username, body) => fetch(`${base}/api/admin/accounts/${username}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
        body: JSON.stringify(body)
    });
    assert.equal((await adminAction('TargetUser', { action: 'role', role: 'moderator' })).status, 200);
    assert.equal((await adminAction('TargetUser', { action: 'ghost' })).status, 400);
    const ghostActionResponse = await adminAction('TargetUser', {
        action: 'ghost', minutes: 60, reason: 'Repeated disruptive messages.', channel: 'general'
    });
    const ghostAction = await ghostActionResponse.json();
    assert.equal(ghostActionResponse.status, 200);
    assert.match(ghostAction.message.content, /TargetUser was ghosted for 1 hour\. Reason: Repeated disruptive messages\./);
    assert.equal((await adminAction('TargetUser', { action: 'warn', reason: 'Please keep the chat respectful.' })).status, 200);

    const ghosted = await fetch(`${base}/api/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: targetCookie },
        body: JSON.stringify({ channel: 'general', content: 'This message should only be mine.' })
    });
    assert.equal(ghosted.status, 201);
    const mine = await fetch(`${base}/api/messages?channel=general`, { headers: { Cookie: targetCookie } });
    const others = await fetch(`${base}/api/messages?channel=general`, { headers: { Cookie: readerCookie } });
    assert.equal((await mine.json()).messages.filter(message => message.author === 'TargetUser').length, 1);
    assert.equal((await others.json()).messages.filter(message => message.author === 'TargetUser').length, 0);

    const muteActionResponse = await adminAction('TargetUser', {
        action: 'mute', minutes: 10, reason: 'Please stop flooding the channel.', channel: 'general'
    });
    const muteAction = await muteActionResponse.json();
    assert.equal(muteActionResponse.status, 200);
    assert.ok(muteAction.account.muteUntil > Date.now());
    assert.match(muteAction.message.content, /TargetUser was muted for 10 minutes\. Reason: Please stop flooding the channel\./);
    const mutedMessage = await fetch(`${base}/api/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: targetCookie },
        body: JSON.stringify({ channel: 'general', content: 'Muted message.' })
    });
    assert.equal(mutedMessage.status, 403);
    assert.equal((await adminAction('TargetUser', { action: 'unmute' })).status, 200);
    const timeoutActionResponse = await adminAction('TargetUser', {
        action: 'timeout', minutes: 1440, reason: 'Please take a break.', channel: 'general'
    });
    const timeoutAction = await timeoutActionResponse.json();
    assert.equal(timeoutActionResponse.status, 200);
    assert.ok(timeoutAction.account.mutedUntil > Date.now());
    assert.match(timeoutAction.message.content, /TargetUser was timed out for 1 day\. Reason: Please take a break\./);
    assert.equal((await adminAction('TargetUser', { action: 'untimeout' })).status, 200);
    const noticesResponse = await fetch(`${base}/api/messages?channel=general`, { headers: { Cookie: readerCookie } });
    const notices = (await noticesResponse.json()).messages.filter(message => message.author === 'Orbit');
    assert.equal(notices.length, 3);

    const afterActions = await fetch(`${base}/api/admin/accounts`, { headers: { Cookie: ownerCookie } });
    const targetStats = (await afterActions.json()).accounts.find(account => account.username === 'TargetUser');
    assert.equal(targetStats.role, 'moderator');
    assert.equal(targetStats.ghosted, true);
    assert.equal(targetStats.messageCount, 1);
    assert.equal(targetStats.warnings.length, 1);
    assert.ok(targetStats.createdAt);
    const persistedAccounts = JSON.parse(await fs.readFile(userStorePath, 'utf8'));
    const persistedTarget = persistedAccounts.find(account => account.username === 'TargetUser');
    assert.equal(persistedTarget.messageCount, 1);
    assert.equal(persistedTarget.warnings.length, 1);

    assert.equal((await adminAction('TargetUser', { action: 'ban' })).status, 200);
    const bannedRequest = await fetch(`${base}/api/messages?channel=general`, { headers: { Cookie: targetCookie } });
    assert.equal(bannedRequest.status, 401);
});

test('rejects unsupported profile pictures, invalid status, and oversized bios', async t => {
    const baseUrl = await startServer(t);
    const { cookie } = await join(baseUrl, 'ProfileUser');
    const headers = { 'Content-Type': 'application/json', Cookie: cookie };
    const unsafeImage = await fetch(`${baseUrl}/api/profile/me`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ bio: '', avatar: 'data:image/svg+xml;base64,PHN2Zy8+', status: 'online' })
    });
    const invalidStatus = await fetch(`${baseUrl}/api/profile/me`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ bio: '', avatar: null, status: 'invisible' })
    });
    const longBio = await fetch(`${baseUrl}/api/profile/me`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ bio: 'x'.repeat(161), avatar: null, status: 'online' })
    });

    assert.equal(unsafeImage.status, 400);
    assert.equal(invalidStatus.status, 400);
    assert.equal(longBio.status, 400);
});

test('rejects invalid sign-up details and incorrect passwords', async t => {
    const baseUrl = await startServer(t);
    const invalid = await fetch(`${baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'a', email: 'not-an-email', password: 'short' })
    });
    await join(baseUrl, 'Alice', 'alice@example.com');
    const wrongPassword = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: 'Alice', password: 'incorrect-password' })
    });

    assert.equal(invalid.status, 400);
    assert.equal(wrongPassword.status, 401);
    assert.match((await wrongPassword.json()).error, /incorrect/);
});

test('persists password hashes and accounts across server restarts', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-chat-persist-'));
    const userStorePath = path.join(directory, 'users.json');
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const firstServer = await createChatServer({ host: '127.0.0.1', port: 0, userStorePath });
    const firstAddress = firstServer.address();
    const firstBaseUrl = `http://127.0.0.1:${firstAddress.port}`;
    await join(firstBaseUrl, 'Alice', 'alice@example.com', 'my-passphrase');
    await new Promise((resolve, reject) => firstServer.close(error => error ? reject(error) : resolve()));

    const stored = JSON.parse(await fs.readFile(userStorePath, 'utf8'));
    assert.equal(stored.length, 1);
    assert.notEqual(stored[0].passwordHash, 'my-passphrase');
    assert.equal((await fs.stat(userStorePath)).mode & 0o777, 0o600);

    const secondBaseUrl = await startServer(t, { userStorePath });
    const login = await fetch(`${secondBaseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: 'alice@example.com', password: 'my-passphrase' })
    });
    assert.equal(login.status, 200);
});

test('stores channel messages under the signed-in account name', async t => {
    const baseUrl = await startServer(t);
    const { cookie } = await join(baseUrl, 'Alice');
    const response = await fetch(`${baseUrl}/api/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ channel: 'general', author: 'Moderator', content: 'Hello there' })
    });
    const result = await response.json();

    assert.equal(response.status, 201);
    assert.equal(result.message.author, 'Alice');
    assert.equal(result.message.content, 'Hello there');
    assert.equal(result.message.image, null);
    assert.equal(result.message.replyTo, null);
    assert.equal(result.message.channelId, 'general');
    assert.equal(result.message.kind, 'user');

    const history = await fetch(`${baseUrl}/api/messages?channel=general`, { headers: { Cookie: cookie } });
    assert.deepEqual((await history.json()).messages, [result.message]);
});

test('rejects invalid channels, empty messages, and malformed JSON', async t => {
    const baseUrl = await startServer(t);
    const { cookie } = await join(baseUrl, 'Alice');
    const headers = { 'Content-Type': 'application/json', Cookie: cookie };
    const invalidChannel = await fetch(`${baseUrl}/api/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ channel: 'unknown', content: 'Hello' })
    });
    const emptyMessage = await fetch(`${baseUrl}/api/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ channel: 'general', content: '  ' })
    });
    const malformed = await fetch(`${baseUrl}/api/messages`, {
        method: 'POST',
        headers,
        body: '{'
    });
    const invalidShape = await fetch(`${baseUrl}/api/messages`, {
        method: 'POST',
        headers,
        body: 'null'
    });

    assert.equal(invalidChannel.status, 404);
    assert.equal(emptyMessage.status, 400);
    assert.equal(malformed.status, 400);
    assert.equal(invalidShape.status, 400);
});

test('answers an @bot message inside its channel', async t => {
    const state = createChatState();
    let botRequest;
    const baseUrl = await startServer(t, {
        state,
        fetchImpl: async (url, options) => {
            botRequest = { url, payload: JSON.parse(options.body) };
            return {
                ok: true,
                json: async () => ({ message: { content: 'Hello, Alice!' } })
            };
        },
        baseUrl: 'http://ollama.local',
        model: 'test-model'
    });
    const { cookie } = await join(baseUrl, 'Alice');
    const response = await fetch(`${baseUrl}/api/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ channel: 'ai-lab', content: '@bot say hello' })
    });
    const result = await response.json();
    await state.botQueues.get('ai-lab');
    const history = await fetch(`${baseUrl}/api/messages?channel=ai-lab`, {
        headers: { Cookie: cookie }
    });
    const messages = (await history.json()).messages;

    assert.equal(response.status, 201);
    assert.equal(result.botPending, true);
    assert.equal(botRequest.url, 'http://ollama.local/api/chat');
    assert.equal(botRequest.payload.model, 'test-model');
    assert.deepEqual(messages.map(message => [message.author, message.content, message.kind]), [
        ['Alice', '@bot say hello', 'user'],
        ['Orbit', 'Hello, Alice!', 'bot']
    ]);
});

test('publishes a visible notice when Ollama is unavailable', async t => {
    const state = createChatState();
    const baseUrl = await startServer(t, {
        state,
        fetchImpl: async () => ({ ok: false, status: 503 })
    });
    const { cookie } = await join(baseUrl, 'Alice');
    const originalError = console.error;
    const errors = [];
    console.error = message => errors.push(message);
    try {
        await fetch(`${baseUrl}/api/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({ channel: 'general', content: '@bot help' })
        });
        await state.botQueues.get('general');

        const response = await fetch(`${baseUrl}/api/messages?channel=general`, {
            headers: { Cookie: cookie }
        });
        const messages = (await response.json()).messages;

        assert.equal(messages.at(-1).kind, 'system');
        assert.match(messages.at(-1).content, /AI service is temporarily unavailable/i);
        assert.match(errors[0], /Ollama request failed \(503\)/);
    } finally {
        console.error = originalError;
    }
});
