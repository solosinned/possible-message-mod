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
    assert.match(page, /id="notification-toggle"/);
    assert.match(page, /id="notification-panel"/);
    assert.match(page, /id="announcement-alert"/);
    assert.match(page, /id="announcement-form"/);
    assert.match(page, /id="announcement-category"/);
    assert.match(page, /id="message-search-dialog"/);
    assert.match(page, /id="pins-dialog"/);
    assert.match(page, /id="thread-dialog"/);
    assert.match(page, /id="edit-message-dialog"/);
    assert.match(page, /id="typing-indicator"/);
    assert.match(page, /id="load-older"/);
    assert.match(page, /id="channel-create-open"/);
    assert.match(page, /id="invite-form"/);
    assert.match(page, /id="channel-mute-toggle"/);
    assert.match(page, /id="unread-jump"/);
    assert.match(page, /id="poll-form"/);
    assert.match(page, /id="event-form"/);
    assert.match(page, /id="report-form"/);
    assert.match(page, /id="reports-dialog"/);
    assert.match(page, /id="voice-dialog"/);
    assert.match(page, /Small-group voice supports up to 8 people/);
    assert.match(page, /function downloadEventCalendar/);
    assert.match(page, /function loadOlderMessages/);
    assert.match(page, /function refreshReports/);
    assert.match(page, /id="member-rank-filter"/);
    assert.match(page, /row\.dataset\.memberKey = username\.toLowerCase\(\)/);
    assert.match(page, /const existingRows = new Map/);
    assert.match(page, /element\.insertBefore\(row, element\.children\[index\] \|\| null\)/);
    assert.match(page, /id="theme-select"/);
    assert.match(page, /message-reaction/);
    assert.match(page, /\.message-reaction-picker \{ display: none/);
    assert.match(page, /\.message:hover \.message-reaction-picker/);
    assert.match(page, /picker\.className = 'message-reaction-picker'/);
    assert.match(page, /changesAfter=\$\{appState\.lastMessageRevision\}/);
    assert.match(page, /id="developer-tools-topbar"/);
    assert.match(page, /\.admin-dialog\[open\] \{ animation: tool-panel-enter/);
    assert.match(page, /\.notification-panel:not\(\[hidden\]\) \{ transform-origin: top right; animation: notification-enter/);
    assert.match(page, /\.announcement-alert\[open\] \{ animation: announcement-enter/);
    assert.match(page, /prefers-reduced-motion: reduce/);
    assert.match(page, /id="moderation-duration"/);
    assert.match(page, /id="moderation-reason"/);
    assert.match(page, /channel: appState\.channel/);
    assert.doesNotMatch(page, /replied-to-target/);
    assert.match(page, /\.message-scroll \{ display: flex; min-height: 0;/);
    assert.match(page, /@keyframes content-enter/);
    assert.match(page, /profile-edit-form\.editor-enter/);
    assert.match(page, /id="onboarding-dialog"/);
    assert.match(page, /id="onboarding-checklist"/);
    assert.match(page, /id="onboarding-open"/);
    assert.match(page, /decoration-orbit/);
    assert.match(page, /memberRoleIcons/);
    assert.match(page, /\.effect-aurora/);
    assert.match(page, /profile-rank-label/);
    assert.doesNotMatch(page, /Upload your own avatar decoration/);
    assert.match(page, /prefers-reduced-motion: reduce/);
    assert.doesNotMatch(page, /https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
});

test('requires an account session before reading channels or messages', async t => {
    const baseUrl = await startServer(t);
    const channels = await fetch(`${baseUrl}/api/channels`);
    const messages = await fetch(`${baseUrl}/api/messages?channel=general`);
    const directMessages = await fetch(`${baseUrl}/api/dms`);
    const notifications = await fetch(`${baseUrl}/api/notifications`);
    const onboarding = await fetch(`${baseUrl}/api/onboarding/me`);

    assert.equal(channels.status, 401);
    assert.equal(messages.status, 401);
    assert.equal(directMessages.status, 401);
    assert.equal(notifications.status, 401);
    assert.equal(onboarding.status, 401);
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

test('bootstraps solosinned as the developer with a hashed password', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-owner-test-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const userStorePath = path.join(directory, 'users.json');
    const baseUrl = await startServer(t, { userStorePath, ownerBootstrapPassword: 'a-bootstrap-password' });
    const login = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: 'solosinned', password: 'a-bootstrap-password' })
    });
    const { user } = await login.json();
    const accounts = JSON.parse(await fs.readFile(userStorePath, 'utf8'));

    assert.equal(login.status, 200);
    assert.equal(user.username, 'solosinned');
    assert.equal(accounts[0].role, 'developer');
    assert.notEqual(accounts[0].passwordHash, 'a-bootstrap-password');
});

test('registers solosinned directly as developer without waiting for a restart', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-developer-register-test-'));
    const baseUrl = await startServer(t, { userStorePath: path.join(directory, 'users.json') });
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const { response, cookie } = await join(baseUrl, 'solosinned');
    const profile = await fetch(`${baseUrl}/api/profile/me`, { headers: { Cookie: cookie } });
    const { profile: result } = await profile.json();

    assert.equal(response.status, 201);
    assert.equal(profile.status, 200);
    assert.equal(result.username, 'solosinned');
    assert.equal(result.role, 'developer');
});

test('developer broadcasts announcements to every signed-in account', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-announcement-test-'));
    const userStorePath = path.join(directory, 'users.json');
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const first = await createChatServer({ host: '127.0.0.1', port: 0, userStorePath });
    const firstBase = `http://127.0.0.1:${first.address().port}`;
    await join(firstBase, 'solosinned');
    await join(firstBase, 'NotificationOwner');
    await new Promise((resolve, reject) => first.close(error => error ? reject(error) : resolve()));

    const accounts = JSON.parse(await fs.readFile(userStorePath, 'utf8'));
    accounts.find(account => account.username === 'NotificationOwner').role = 'owner';
    await fs.writeFile(userStorePath, JSON.stringify(accounts));

    let server = await createChatServer({ host: '127.0.0.1', port: 0, userStorePath });
    t.after(() => server.listening
        ? new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
        : Promise.resolve());
    let base = `http://127.0.0.1:${server.address().port}`;
    const signIn = async username => {
        const response = await fetch(`${base}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ identifier: username, password: 'safe-password-123' })
        });
        assert.equal(response.status, 200);
        return response.headers.get('set-cookie').split(';')[0];
    };
    const developerCookie = await signIn('solosinned');
    const ownerCookie = await signIn('NotificationOwner');
    const developerAdminAction = async body => fetch(`${base}/api/admin/accounts/NotificationOwner`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: developerCookie },
        body: JSON.stringify(body)
    });
    assert.equal((await developerAdminAction({
        action: 'mute', minutes: 10, reason: 'Testing developer rank.', channel: 'general'
    })).status, 200);
    assert.equal((await developerAdminAction({ action: 'unmute' })).status, 200);
    assert.equal((await developerAdminAction({ action: 'role', role: 'admin' })).status, 200);
    assert.equal((await developerAdminAction({ action: 'role', role: 'owner' })).status, 200);
    const announcementUrl = `${base}/api/developer/announcements`;
    const denied = await fetch(announcementUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
        body: JSON.stringify({ title: 'Update', body: 'A message for everyone.' })
    });
    assert.equal(denied.status, 403);
    assert.equal((await fetch(`${base}/api/admin/accounts`, { headers: { Cookie: developerCookie } })).status, 200);
    const protectedRank = await fetch(`${base}/api/admin/accounts/solosinned`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: developerCookie },
        body: JSON.stringify({ action: 'role', role: 'admin' })
    });
    assert.equal(protectedRank.status, 400);

    const created = await fetch(announcementUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: developerCookie },
        body: JSON.stringify({ title: 'Community update', body: 'Welcome to the new announcement system.', category: 'event' })
    });
    const { announcement } = await created.json();
    assert.equal(created.status, 201);
    assert.equal(announcement.author, 'solosinned');
    assert.equal(announcement.title, 'Community update');
    assert.equal(announcement.category, 'event');
    const invalidCategory = await fetch(announcementUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: developerCookie },
        body: JSON.stringify({ title: 'Invalid category', body: 'This category is not supported.', category: 'other' })
    });
    assert.equal(invalidCategory.status, 400);

    const developerFeed = await fetch(`${base}/api/notifications`, { headers: { Cookie: developerCookie } });
    const ownerFeed = await fetch(`${base}/api/notifications`, { headers: { Cookie: ownerCookie } });
    assert.deepEqual((await developerFeed.json()).notifications, [announcement]);
    assert.deepEqual((await ownerFeed.json()).notifications, [announcement]);
    const emptyFeed = await fetch(`${base}/api/notifications?after=${announcement.id}`, {
        headers: { Cookie: ownerCookie }
    });
    assert.deepEqual((await emptyFeed.json()).notifications, []);
    const invalidAnnouncement = await fetch(announcementUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: developerCookie },
        body: JSON.stringify({ title: '  ', body: '' })
    });
    assert.equal(invalidAnnouncement.status, 400);
    const markedRead = await fetch(`${base}/api/notifications/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: ownerCookie },
        body: JSON.stringify({ id: announcement.id })
    });
    assert.deepEqual(await markedRead.json(), { readId: announcement.id });
    const savedAccounts = JSON.parse(await fs.readFile(userStorePath, 'utf8'));
    assert.equal(savedAccounts.find(account => account.username === 'NotificationOwner').announcementReadId, announcement.id);

    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server = await createChatServer({ host: '127.0.0.1', port: 0, userStorePath });
    base = `http://127.0.0.1:${server.address().port}`;
    const ownerLogin = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: 'NotificationOwner', password: 'safe-password-123' })
    });
    const restartedCookie = ownerLogin.headers.get('set-cookie').split(';')[0];
    const restartedFeed = await fetch(`${base}/api/notifications`, { headers: { Cookie: restartedCookie } });
    const restartedResult = await restartedFeed.json();
    assert.deepEqual(restartedResult.notifications, [announcement]);
    assert.equal(restartedResult.readId, announcement.id);
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

test('supports message reactions, pins, search, typing indicators, threads, and safe editing/deletion', async t => {
    const baseUrl = await startServer(t);
    const { cookie: authorCookie } = await join(baseUrl, 'FeatureAuthor');
    const { cookie: otherCookie } = await join(baseUrl, 'FeatureOther');
    const { cookie: developerCookie } = await join(baseUrl, 'solosinned');
    const headers = cookie => ({ 'Content-Type': 'application/json', Cookie: cookie });
    const send = (cookie, body) => fetch(`${baseUrl}/api/messages`, {
        method: 'POST',
        headers: headers(cookie),
        body: JSON.stringify({ channel: 'general', ...body })
    });
    const originalResponse = await send(authorCookie, { content: 'Searchable feature root' });
    const original = (await originalResponse.json()).message;
    await new Promise(resolve => setTimeout(resolve, 320));
    const replyResponse = await send(developerCookie, {
        content: 'A feature thread reply',
        replyToId: original.id
    });
    const reply = (await replyResponse.json()).message;

    const reaction = await fetch(`${baseUrl}/api/messages/${original.id}/reactions`, {
        method: 'POST',
        headers: headers(authorCookie),
        body: JSON.stringify({ channel: 'general', emoji: '👍' })
    });
    assert.equal(reaction.status, 200);
    assert.deepEqual((await reaction.json()).message.reactions, [{ emoji: '👍', users: ['FeatureAuthor'] }]);
    const removedReaction = await fetch(`${baseUrl}/api/messages/${original.id}/reactions`, {
        method: 'POST',
        headers: headers(authorCookie),
        body: JSON.stringify({ channel: 'general', emoji: '👍' })
    });
    assert.deepEqual((await removedReaction.json()).message.reactions, []);

    const deniedPin = await fetch(`${baseUrl}/api/messages/${original.id}/pin`, {
        method: 'POST',
        headers: headers(authorCookie),
        body: JSON.stringify({ channel: 'general' })
    });
    assert.equal(deniedPin.status, 403);
    const pinned = await fetch(`${baseUrl}/api/messages/${original.id}/pin`, {
        method: 'POST',
        headers: headers(developerCookie),
        body: JSON.stringify({ channel: 'general' })
    });
    assert.equal((await pinned.json()).message.pinned, true);
    const changedMessages = await fetch(
        `${baseUrl}/api/messages?channel=general&after=${reply.id}&changesAfter=${original.revision}`,
        { headers: headers(authorCookie) }
    );
    const changedResult = await changedMessages.json();
    assert.equal(changedResult.messages.find(message => message.id === original.id).pinned, true);
    assert.ok(changedResult.revision > original.revision);
    const pins = await fetch(`${baseUrl}/api/pins?channel=general`, { headers: headers(authorCookie) });
    assert.deepEqual((await pins.json()).messages.map(message => message.id), [original.id]);

    const search = await fetch(`${baseUrl}/api/search?q=searchable&channel=general`, {
        headers: headers(authorCookie)
    });
    assert.deepEqual((await search.json()).messages.map(message => message.id), [original.id]);
    const authorSearch = await fetch(`${baseUrl}/api/search?author=featureauthor`, {
        headers: headers(developerCookie)
    });
    assert.deepEqual((await authorSearch.json()).messages.map(message => message.id), [original.id]);

    const thread = await fetch(`${baseUrl}/api/messages/${reply.id}/thread?channel=general`, {
        headers: headers(authorCookie)
    });
    const threadResult = await thread.json();
    assert.equal(threadResult.root.id, original.id);
    assert.deepEqual(threadResult.replies.map(message => message.id), [reply.id]);

    const typing = await fetch(`${baseUrl}/api/typing`, {
        method: 'POST',
        headers: headers(authorCookie),
        body: JSON.stringify({ channel: 'general', typing: true })
    });
    assert.equal(typing.status, 200);
    const typingUsers = await fetch(`${baseUrl}/api/typing?channel=general`, { headers: headers(developerCookie) });
    assert.deepEqual((await typingUsers.json()).users, ['FeatureAuthor']);
    await fetch(`${baseUrl}/api/typing`, {
        method: 'POST',
        headers: headers(authorCookie),
        body: JSON.stringify({ channel: 'general', typing: false })
    });
    const clearedTyping = await fetch(`${baseUrl}/api/typing?channel=general`, { headers: headers(developerCookie) });
    assert.deepEqual((await clearedTyping.json()).users, []);

    const deniedDelete = await fetch(`${baseUrl}/api/messages/${original.id}?channel=general`, {
        method: 'DELETE',
        headers: headers(otherCookie)
    });
    assert.equal(deniedDelete.status, 403);
    const edited = await fetch(`${baseUrl}/api/messages/${reply.id}?channel=general`, {
        method: 'PATCH',
        headers: headers(developerCookie),
        body: JSON.stringify({ content: 'Edited feature reply' })
    });
    assert.equal(edited.status, 200);
    assert.equal((await edited.json()).message.content, 'Edited feature reply');

    const moderatorDelete = await fetch(`${baseUrl}/api/messages/${reply.id}?channel=general`, {
        method: 'DELETE',
        headers: headers(otherCookie)
    });
    assert.equal(moderatorDelete.status, 403);
    const devDelete = await fetch(`${baseUrl}/api/messages/${reply.id}?channel=general`, {
        method: 'DELETE',
        headers: headers(developerCookie)
    });
    assert.equal((await devDelete.json()).message.deleted, true);
    const adminDelete = await fetch(`${baseUrl}/api/messages/${original.id}?channel=general`, {
        method: 'DELETE',
        headers: headers(developerCookie)
    });
    assert.equal((await adminDelete.json()).message.deleted, true);
    const deletedThread = await fetch(`${baseUrl}/api/messages/${original.id}/thread?channel=general`, {
        headers: headers(authorCookie)
    });
    const deletedThreadResult = await deletedThread.json();
    assert.equal(deletedThreadResult.root.deleted, true);
    assert.equal(deletedThreadResult.replies[0].replyTo.content, 'Message deleted');
    const deletedSearch = await fetch(`${baseUrl}/api/search?q=searchable&channel=general`, {
        headers: headers(authorCookie)
    });
    assert.deepEqual((await deletedSearch.json()).messages, []);
});

test('returns separate online and offline user directories', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-members-test-'));
    const userStorePath = path.join(directory, 'users.json');
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const first = await createChatServer({ host: '127.0.0.1', port: 0, userStorePath });
    const firstBase = `http://127.0.0.1:${first.address().port}`;
    await join(firstBase, 'OnlineMember');
    await join(firstBase, 'OfflineAdmin');
    await join(firstBase, 'OnlineMod');
    await join(firstBase, 'OnlineAdmin');
    await join(firstBase, 'OnlineOwner');
    await join(firstBase, 'solosinned');
    await new Promise((resolve, reject) => first.close(error => error ? reject(error) : resolve()));

    const accounts = JSON.parse(await fs.readFile(userStorePath, 'utf8'));
    for (const account of accounts) {
        account.role = account.username === 'solosinned' ? 'owner'
            : account.username === 'OnlineOwner' ? 'owner'
            : account.username.startsWith('OnlineAdmin') || account.username === 'OfflineAdmin' ? 'admin'
                : account.username === 'OnlineMod' ? 'moderator' : 'member';
    }
    await fs.writeFile(userStorePath, JSON.stringify(accounts));

    const server = await createChatServer({ host: '127.0.0.1', port: 0, userStorePath });
    t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    for (const username of ['OnlineMember', 'OnlineMod', 'OnlineAdmin', 'OnlineOwner', 'solosinned']) {
        const login = await fetch(`${baseUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ identifier: username, password: 'safe-password-123' })
        });
        assert.equal(login.status, 200);
    }

    const ownerLogin = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: 'solosinned', password: 'safe-password-123' })
    });
    const response = await fetch(`${baseUrl}/api/users`, {
        headers: { Cookie: ownerLogin.headers.get('set-cookie').split(';')[0] }
    });
    const result = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(result.users.map(user => user.username), ['solosinned', 'OnlineOwner', 'OnlineAdmin', 'OnlineMod', 'OnlineMember']);
    assert.deepEqual(result.offlineUsers.map(user => user.username), ['OfflineAdmin']);
});

test('saves profile pictures, bios, and status and returns public profiles', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-profile-test-'));
    const userStorePath = path.join(directory, 'users.json');
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const baseUrl = await startServer(t, { userStorePath });
    const { cookie } = await join(baseUrl, 'ProfileUser');
    const avatar = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pS8AAAAASUVORK5CYII=';
    const banner = avatar;
    const update = await fetch(`${baseUrl}/api/profile/me`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
            bio: 'Hello from my profile.',
            avatar,
            banner,
            decoration: 'orbit',
            profileEffect: 'starlight',
            status: 'busy'
        })
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
        role: 'member',
        banner,
        decoration: 'orbit',
        profileEffect: 'starlight'
    });
    assert.deepEqual((await ownProfile.json()).profile, saved.profile);
    assert.deepEqual((await publicProfile.json()).profile, saved.profile);
    const activeUser = (await users.json()).users[0];
    assert.equal(activeUser.username, 'ProfileUser');
    assert.equal(activeUser.status, 'busy');
    assert.equal(activeUser.avatar, avatar);
    assert.equal(Object.hasOwn(activeUser, 'music'), false);
    assert.equal(Object.hasOwn(activeUser, 'banner'), false);
    assert.equal(Object.hasOwn(activeUser, 'decorationImage'), false);
    const stored = JSON.parse(await fs.readFile(userStorePath, 'utf8'));
    assert.equal(stored[0].bio, 'Hello from my profile.');
    assert.equal(stored[0].avatar, avatar);
    assert.equal(stored[0].status, 'busy');
    assert.equal(typeof stored[0].email, 'string');
    assert.equal(typeof stored[0].passwordHash, 'string');
});

test('persists onboarding progress and validates onboarding preferences', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-onboarding-test-'));
    const userStorePath = path.join(directory, 'users.json');
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const baseUrl = await startServer(t, { userStorePath });
    const { cookie } = await join(baseUrl, 'OnboardingUser');
    const headers = { 'Content-Type': 'application/json', Cookie: cookie };
    const initial = await fetch(`${baseUrl}/api/onboarding/me`, { headers: { Cookie: cookie } });
    const update = await fetch(`${baseUrl}/api/onboarding/me`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
            completed: true,
            steps: ['channels', 'profile'],
            interests: ['ai', 'music'],
            notifications: 'quiet'
        })
    });
    const duplicateStep = await fetch(`${baseUrl}/api/onboarding/me`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ steps: ['channels', 'channels'] })
    });
    const persisted = await fetch(`${baseUrl}/api/onboarding/me`, { headers: { Cookie: cookie } });
    const updatedProgress = await update.json();
    const stored = JSON.parse(await fs.readFile(userStorePath, 'utf8'));

    assert.deepEqual((await initial.json()).onboarding, {
        completed: false,
        steps: [],
        interests: [],
        notifications: 'mentions'
    });
    assert.equal(update.status, 200);
    assert.deepEqual(updatedProgress.onboarding, {
        completed: true,
        steps: ['channels', 'profile'],
        interests: ['ai', 'music'],
        notifications: 'quiet'
    });
    assert.equal(duplicateStep.status, 400);
    assert.deepEqual((await persisted.json()).onboarding, updatedProgress.onboarding);
    assert.equal(stored[0].onboarding.completed, true);
});

test('removes legacy custom avatar overlays from saved profiles', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-decoration-migration-'));
    const userStorePath = path.join(directory, 'users.json');
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const first = await createChatServer({ host: '127.0.0.1', port: 0, userStorePath });
    const firstBase = `http://127.0.0.1:${first.address().port}`;
    await join(firstBase, 'PresetUser');
    await new Promise((resolve, reject) => first.close(error => error ? reject(error) : resolve()));

    const storedBeforeMigration = JSON.parse(await fs.readFile(userStorePath, 'utf8'));
    storedBeforeMigration[0].decorationImage =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pS8AAAAASUVORK5CYII=';
    await fs.writeFile(userStorePath, JSON.stringify(storedBeforeMigration));

    const server = await createChatServer({ host: '127.0.0.1', port: 0, userStorePath });
    t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const base = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: 'PresetUser', password: 'safe-password-123' })
    });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const profile = await fetch(`${base}/api/profile/me`, { headers: { Cookie: cookie } });
    const migratedStore = JSON.parse(await fs.readFile(userStorePath, 'utf8'));

    assert.equal(login.status, 200);
    assert.equal(Object.hasOwn((await profile.json()).profile, 'decorationImage'), false);
    assert.equal(Object.hasOwn(migratedStore[0], 'decorationImage'), false);
});

test('enforces the profile banner size limit', async t => {
    const baseUrl = await startServer(t);
    const { cookie } = await join(baseUrl, 'BannerLimitUser');
    const headers = { 'Content-Type': 'application/json', Cookie: cookie };
    const makeBanner = size => {
        const bytes = Buffer.alloc(size);
        bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
        return `data:image/png;base64,${bytes.toString('base64')}`;
    };
    const withinLimit = await fetch(`${baseUrl}/api/profile/me`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ bio: '', banner: makeBanner(512 * 1024) })
    });
    const overLimit = await fetch(`${baseUrl}/api/profile/me`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ bio: '', banner: makeBanner(512 * 1024 + 1) })
    });

    assert.equal(withinLimit.status, 200);
    assert.equal(overLimit.status, 400);
    assert.match((await overLimit.json()).error, /up to 512 KB/);
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
        role: 'member',
        banner: null,
        decoration: 'none',
        profileEffect: 'none'
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
        role: 'member',
        banner: null,
        decoration: 'none',
        profileEffect: 'none'
    });
});

test('developer tools manage ranks, ghosting, moderation, and account stats', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-admin-test-'));
    const userStorePath = path.join(directory, 'users.json');
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const first = await createChatServer({ host: '127.0.0.1', port: 0, userStorePath });
    const firstBase = `http://127.0.0.1:${first.address().port}`;
    await join(firstBase, 'solosinned', 'solo@example.com');
    await new Promise((resolve, reject) => first.close(error => error ? reject(error) : resolve()));
    const accounts = JSON.parse(await fs.readFile(userStorePath, 'utf8'));
    assert.ok(accounts[0].createdAt);
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
    assert.equal((await list.json()).accounts.find(account => account.username === 'solosinned').role, 'developer');
    const savedAccounts = JSON.parse(await fs.readFile(userStorePath, 'utf8'));
    assert.equal(savedAccounts[0].role, 'developer');

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

test('staff actions enforce separate moderator and admin permissions', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-staff-test-'));
    const userStorePath = path.join(directory, 'users.json');
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const first = await createChatServer({ host: '127.0.0.1', port: 0, userStorePath });
    const firstBase = `http://127.0.0.1:${first.address().port}`;
    for (const username of ['solosinned', 'StaffAdmin', 'StaffMod', 'OtherMod', 'StaffMember']) {
        await join(firstBase, username);
    }
    await new Promise((resolve, reject) => first.close(error => error ? reject(error) : resolve()));

    const accounts = JSON.parse(await fs.readFile(userStorePath, 'utf8'));
    for (const account of accounts) {
        account.role = account.username === 'solosinned' ? 'owner'
            : account.username === 'StaffAdmin' ? 'admin'
                : ['StaffMod', 'OtherMod'].includes(account.username) ? 'moderator' : 'member';
    }
    await fs.writeFile(userStorePath, JSON.stringify(accounts));

    const server = await createChatServer({ host: '127.0.0.1', port: 0, userStorePath });
    t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const base = `http://127.0.0.1:${server.address().port}`;
    const signIn = async username => {
        const response = await fetch(`${base}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ identifier: username, password: 'safe-password-123' })
        });
        assert.equal(response.status, 200);
        return response.headers.get('set-cookie').split(';')[0];
    };
    const adminCookie = await signIn('StaffAdmin');
    const moderatorCookie = await signIn('StaffMod');
    const memberCookie = await signIn('StaffMember');
    const staffAction = (cookie, username, body) => fetch(
        `${base}/api/staff/members/${encodeURIComponent(username)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) }
    );

    const adminListResponse = await fetch(`${base}/api/staff/members`, { headers: { Cookie: adminCookie } });
    const adminList = await adminListResponse.json();
    assert.equal(adminListResponse.status, 200);
    assert.deepEqual(adminList.accounts.map(account => account.username), ['OtherMod', 'StaffMod', 'StaffMember']);
    assert.equal(Object.hasOwn(adminList.accounts[0], 'email'), false);

    const moderatorListResponse = await fetch(`${base}/api/staff/members`, { headers: { Cookie: moderatorCookie } });
    const moderatorList = await moderatorListResponse.json();
    assert.equal(moderatorListResponse.status, 200);
    assert.deepEqual(moderatorList.accounts.map(account => account.username), ['StaffMember']);
    assert.equal((await fetch(`${base}/api/staff/members`, { headers: { Cookie: memberCookie } })).status, 403);
    assert.equal((await fetch(`${base}/api/admin/accounts`, { headers: { Cookie: adminCookie } })).status, 403);

    assert.equal((await staffAction(moderatorCookie, 'StaffMember', {
        action: 'warn', reason: 'Please keep chat respectful.'
    })).status, 200);
    assert.equal((await staffAction(moderatorCookie, 'StaffMember', {
        action: 'mute', minutes: 10, reason: 'Please stop flooding chat.', channel: 'general'
    })).status, 200);
    assert.equal((await staffAction(moderatorCookie, 'StaffMember', {
        action: 'ghost', minutes: 10, reason: 'Please stop flooding chat.', channel: 'general'
    })).status, 403);
    assert.equal((await staffAction(moderatorCookie, 'StaffMember', {
        action: 'timeout', minutes: 10, reason: 'Please take a break.', channel: 'general'
    })).status, 403);
    assert.equal((await staffAction(moderatorCookie, 'OtherMod', {
        action: 'warn', reason: 'Please keep chat respectful.'
    })).status, 403);
    assert.equal((await staffAction(moderatorCookie, 'StaffMember', {
        action: 'role', role: 'admin'
    })).status, 403);

    const ghostResponse = await staffAction(adminCookie, 'StaffMod', {
        action: 'ghost', minutes: 10, reason: 'Please stop disruptive messages.', channel: 'general'
    });
    assert.equal(ghostResponse.status, 200);
    assert.equal((await ghostResponse.json()).account.ghosted, true);
    const timeoutResponse = await staffAction(adminCookie, 'StaffMember', {
        action: 'timeout', minutes: 60, reason: 'Please take a break.', channel: 'general'
    });
    assert.equal(timeoutResponse.status, 200);
    assert.ok((await timeoutResponse.json()).account.mutedUntil > Date.now());
    assert.equal((await staffAction(adminCookie, 'StaffMember', { action: 'ban' })).status, 403);
    assert.equal((await staffAction(adminCookie, 'solosinned', {
        action: 'warn', reason: 'Please keep chat respectful.'
    })).status, 403);
    assert.equal((await fetch(`${base}/api/admin/accounts`, { headers: { Cookie: moderatorCookie } })).status, 403);
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
    const invalidDecoration = await fetch(`${baseUrl}/api/profile/me`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ bio: '', decoration: 'external-css', profileEffect: 'custom-code' })
    });
    const unsafeBanner = await fetch(`${baseUrl}/api/profile/me`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ bio: '', banner: 'data:image/svg+xml;base64,PHN2Zy8+' })
    });

    assert.equal(unsafeImage.status, 400);
    assert.equal(invalidStatus.status, 400);
    assert.equal(longBio.status, 400);
    assert.equal(invalidDecoration.status, 400);
    assert.equal(unsafeBanner.status, 400);
    const customDecoration = await fetch(`${baseUrl}/api/profile/me`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ bio: '', decorationImage: 'data:image/png;base64,abc' })
    });
    assert.equal(customDecoration.status, 400);
    assert.match((await customDecoration.json()).error, /not supported.*Choose a preset/);
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

test('persists channel and DM history and secures private channels, reports, blocks, and voice signaling', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-feature-test-'));
    const userStorePath = path.join(directory, 'users.json');
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    let server;
    let state;
    const start = async () => {
        state = createChatState();
        server = await createChatServer({
            host: '127.0.0.1',
            port: 0,
            state,
            userStorePath,
            ownerBootstrapPassword: 'developer-safe-password'
        });
        const address = server.address();
        return `http://127.0.0.1:${address.port}`;
    };
    const stop = async () => new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    });
    t.after(async () => {
        if (server?.listening) await stop();
    });
    const api = (base, cookie, route, method = 'GET', body) => fetch(`${base}${route}`, {
        method,
        headers: { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });

    let base = await start();
    const alice = await join(base, 'FeatureAlice');
    const bob = await join(base, 'FeatureBob');
    const moderator = await join(base, 'FeatureModerator');
    state.accounts.get('featuremoderator').role = 'moderator';
    const developerLogin = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: 'solosinned', password: 'developer-safe-password' })
    });
    const developerCookie = developerLogin.headers.get('set-cookie').split(';')[0];
    const startsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const pollBody = { channel: 'off-topic', question: 'Which day?', options: ['Friday', 'Saturday'] };
    const eventBody = {
        channel: 'off-topic',
        title: 'Planning session',
        startsAt,
        details: 'Bring ideas.'
    };
    assert.equal((await api(base, alice.cookie, '/api/polls', 'POST', pollBody)).status, 403);
    assert.equal((await api(base, alice.cookie, '/api/events', 'POST', eventBody)).status, 403);
    assert.equal((await api(base, moderator.cookie, '/api/polls', 'POST', pollBody)).status, 201);
    assert.equal((await api(base, moderator.cookie, '/api/events', 'POST', eventBody)).status, 201);

    for (let index = 0; index < 52; index += 1) {
        state.sessions.get(alice.cookie.slice('chat_session='.length)).lastMessageAt = 0;
        const response = await api(base, alice.cookie, '/api/messages', 'POST', {
            channel: 'general',
            content: `History item ${index + 1}`
        });
        assert.equal(response.status, 201);
    }
    const recentHistory = await api(base, alice.cookie, '/api/messages?channel=general');
    const recentPage = await recentHistory.json();
    assert.equal(recentPage.messages.length, 50);
    assert.equal(recentPage.hasMore, true);
    const olderHistory = await api(
        base,
        alice.cookie,
        `/api/messages?channel=general&before=${recentPage.messages[0].id}&limit=10`
    );
    const olderPage = await olderHistory.json();
    assert.equal(olderPage.messages.length, 2);
    assert.equal(olderPage.hasMore, false);

    const created = await api(base, alice.cookie, '/api/channels', 'POST', {
        name: 'planning-room',
        topic: 'Private plans'
    });
    assert.equal(created.status, 201);
    const { channel, inviteCode } = await created.json();
    assert.match(channel.id, /^private-[a-f0-9]{12}$/);
    assert.ok(inviteCode);
    assert.equal((await api(base, bob.cookie, `/api/messages?channel=${channel.id}`)).status, 404);
    assert.equal((await (await api(base, bob.cookie, '/api/channels')).json()).channels
        .some(item => item.id === channel.id), false);
    assert.equal((await api(base, bob.cookie, '/api/channels/join', 'POST', { inviteCode })).status, 200);
    assert.equal((await api(base, bob.cookie, '/api/polls', 'POST', {
        ...pollBody,
        channel: channel.id
    })).status, 403);
    assert.equal((await api(base, bob.cookie, '/api/events', 'POST', {
        ...eventBody,
        channel: channel.id
    })).status, 403);

    state.sessions.get(alice.cookie.slice('chat_session='.length)).lastMessageAt = 0;
    const posted = await api(base, alice.cookie, '/api/messages', 'POST', {
        channel: channel.id,
        content: 'Planning with @FeatureBob'
    });
    assert.equal(posted.status, 201);
    const privateMessage = (await posted.json()).message;
    const unread = await api(base, bob.cookie, '/api/unread');
    const unreadChannel = (await unread.json()).channels.find(item => item.id === channel.id);
    assert.equal(unreadChannel.count, 1);
    assert.equal(unreadChannel.mentions, 1);
    assert.equal(unreadChannel.firstMessageId, privateMessage.id);
    assert.equal((await api(base, bob.cookie, '/api/preferences', 'PATCH', {
        channel: channel.id,
        muted: true
    })).status, 200);

    const pollResponse = await api(base, alice.cookie, '/api/polls', 'POST', {
        channel: channel.id,
        question: 'Which day?',
        options: ['Friday', 'Saturday']
    });
    assert.equal(pollResponse.status, 201);
    const poll = (await pollResponse.json()).message;
    const vote = await api(base, bob.cookie, `/api/messages/${poll.id}/votes`, 'POST', {
        channel: channel.id,
        option: 1
    });
    assert.equal((await vote.json()).message.poll.options[1].votes[0], 'FeatureBob');

    const eventResponse = await api(base, alice.cookie, '/api/events', 'POST', {
        channel: channel.id,
        title: 'Planning session',
        startsAt,
        details: 'Bring ideas.'
    });
    assert.equal(eventResponse.status, 201);

    const publicMessageResponse = await api(base, bob.cookie, '/api/messages', 'POST', {
        channel: 'general',
        content: 'Please hide me after blocking.'
    });
    assert.equal(publicMessageResponse.status, 201);
    const report = await api(base, bob.cookie, '/api/reports', 'POST', {
        channel: channel.id,
        messageId: privateMessage.id,
        reason: 'Please review this message.'
    });
    assert.equal(report.status, 201);
    assert.equal((await api(base, alice.cookie, '/api/reports')).status, 403);
    const reportQueue = await api(base, developerCookie, '/api/reports');
    assert.equal((await reportQueue.json()).reports.length, 1);

    assert.equal((await api(base, alice.cookie, '/api/dms', 'POST', {
        recipient: 'FeatureBob',
        content: 'A private note.'
    })).status, 201);
    assert.equal((await api(base, alice.cookie, '/api/blocks', 'POST', {
        username: 'FeatureBob',
        block: true
    })).status, 200);
    const blockedHistory = await api(base, alice.cookie, '/api/messages?channel=general');
    assert.equal((await blockedHistory.json()).messages
        .some(message => message.content === 'Please hide me after blocking.'), false);
    assert.equal((await api(base, bob.cookie, '/api/dms/FeatureAlice')).status, 404);
    assert.equal((await api(base, alice.cookie, '/api/dms/FeatureBob')).status, 404);
    assert.equal((await api(base, alice.cookie, '/api/blocks', 'POST', {
        username: 'FeatureBob',
        block: false
    })).status, 200);

    const aliceVoice = await api(base, alice.cookie, '/api/voice/join', 'POST', { channel: channel.id });
    const bobVoice = await api(base, bob.cookie, '/api/voice/join', 'POST', { channel: channel.id });
    assert.deepEqual((await aliceVoice.json()).participants, []);
    assert.deepEqual((await bobVoice.json()).participants, ['FeatureAlice']);
    assert.equal((await api(base, alice.cookie, '/api/voice/signal', 'POST', {
        channel: channel.id,
        to: 'FeatureBob',
        type: 'offer',
        data: { type: 'offer', sdp: 'test-sdp' }
    })).status, 201);
    const signals = await api(base, bob.cookie, `/api/voice?channel=${channel.id}&after=0`);
    assert.equal((await signals.json()).signals[0].type, 'offer');

    await stop();
    base = await start();
    const aliceAgain = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: 'FeatureAlice', password: 'safe-password-123' })
    });
    const aliceAgainCookie = aliceAgain.headers.get('set-cookie').split(';')[0];
    const persistedChannels = await api(base, aliceAgainCookie, '/api/channels');
    assert.ok((await persistedChannels.json()).channels.some(item => item.id === channel.id));
    const persistedHistory = await api(base, aliceAgainCookie, `/api/messages?channel=${channel.id}`);
    const persistedMessages = (await persistedHistory.json()).messages;
    assert.deepEqual(persistedMessages.map(message => message.kind), ['user', 'poll', 'event']);
    assert.deepEqual(persistedMessages[1].poll.options[1].votes, ['FeatureBob']);
    const persistedDm = await api(base, aliceAgainCookie, '/api/dms/FeatureBob');
    assert.equal(persistedDm.status, 200);
    assert.equal((await persistedDm.json()).messages[0].content, 'A private note.');
    const bobAgain = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: 'FeatureBob', password: 'safe-password-123' })
    });
    const bobAgainCookie = bobAgain.headers.get('set-cookie').split(';')[0];
    const persistedUnread = await api(base, bobAgainCookie, '/api/unread');
    assert.equal((await persistedUnread.json()).channels.find(item => item.id === channel.id).muted, true);
    const charlie = await join(base, 'FeatureCharlie');
    assert.equal((await api(base, charlie.cookie, '/api/channels/join', 'POST', { inviteCode })).status, 200);
    const developerAgain = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: 'solosinned', password: 'developer-safe-password' })
    });
    const developerAgainCookie = developerAgain.headers.get('set-cookie').split(';')[0];
    assert.equal((await (await api(base, developerAgainCookie, '/api/reports')).json()).reports.length, 1);
    assert.equal((await api(base, aliceAgainCookie, `/api/voice?channel=${channel.id}&after=0`)).status, 404);
});
