const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { createSupabaseClients, SupabaseStore } = require('./supabase-store.js');

const HOST = resolveHost();
const PORT = resolvePort();
const MAX_BODY_BYTES = 9 * 1024 * 1024;
const MAX_MESSAGE_LENGTH = 1000;
const MESSAGE_HISTORY_LIMIT = 200;
const MAX_AVATAR_BYTES = 256 * 1024;
const MAX_BANNER_BYTES = 512 * 1024;
const MAX_CHAT_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_MUSIC_BYTES = 6 * 1024 * 1024;
const MAX_BIO_LENGTH = 160;
const OWNER_USERNAME = (process.env.OWNER_USERNAME || 'solosinned').toLowerCase();
const DEVELOPER_USERNAMES = new Set(['solosinned', OWNER_USERNAME]);
const ACCOUNT_ROLES = new Set(['member', 'moderator', 'admin', 'owner', 'developer']);
const STAFF_ROLES = new Set(['developer', 'owner', 'admin', 'moderator']);
const ROLE_ORDER = { developer: 0, owner: 1, admin: 2, moderator: 3, member: 4 };
const MAX_ANNOUNCEMENTS = 100;
const MAX_ANNOUNCEMENT_TITLE_LENGTH = 100;
const MAX_ANNOUNCEMENT_BODY_LENGTH = 1000;
const MAX_CHANNEL_NAME_LENGTH = 32;
const MAX_CHANNEL_TOPIC_LENGTH = 120;
const MAX_PRIVATE_CHANNELS = 200;
const MAX_PRIVATE_CHANNELS_PER_OWNER = 20;
const MAX_VOICE_PARTICIPANTS = 8;
const MAX_POLL_OPTIONS = 6;
const MAX_REPORT_REASON_LENGTH = 500;
const MAX_REPORTS = 1000;
const DEFAULT_VOICE_ICE_SERVERS = [{ urls: 'stun:stun.cloudflare.com:3478' }];
const ANNOUNCEMENT_CATEGORIES = new Set(['update', 'event', 'urgent']);
const REACTION_EMOJIS = new Set(['👍', '❤️', '😂', '🎉', '😮']);
const TYPING_TTL_MS = 5000;
const PROFILE_STATUSES = new Set(['online', 'away', 'busy']);
const PROFILE_DECORATIONS = new Set(['none', 'orbit', 'halo', 'aurora']);
const PROFILE_EFFECTS = new Set(['none', 'aurora', 'starlight', 'ember']);
const ONBOARDING_STEPS = new Set(['channels', 'profile', 'message']);
const ONBOARDING_INTERESTS = new Set(['conversation', 'ideas', 'games', 'music']);
const ONBOARDING_NOTIFICATIONS = new Set(['all', 'mentions', 'quiet']);
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_ATTEMPT_LIMIT = 10;
const scrypt = promisify(crypto.scrypt);
const DUMMY_PASSWORD_HASH = crypto.scryptSync('not-a-real-password', 'orbit-dummy-salt', 64);
const PAGE = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
const CHANNELS = [
    { id: 'general', name: 'general', topic: 'The place for everyday conversation.' },
    { id: 'ai-lab', name: 'ideas', topic: 'Share projects, ideas, and things you’re curious about.' },
    { id: 'off-topic', name: 'off-topic', topic: 'Games, music, and everything else.' }
];

function getUserStorePath(environment = process.env) {
    const dataDirectory = environment.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
    return environment.USER_STORE_PATH || path.join(dataDirectory, 'users.json');
}

function normalizeHost(value) {
    const host = String(value ?? '').trim();
    if (!host) return '0.0.0.0';
    if (/^https?:\/\//i.test(host)) {
        try {
            return new URL(host).hostname || '0.0.0.0';
        } catch {
            // Fall back to the raw value below.
        }
    }
    if (host.includes(':') && !host.startsWith('[')) {
        const lastColon = host.lastIndexOf(':');
        const suffix = host.slice(lastColon + 1);
        const prefix = host.slice(0, lastColon);
        if (/^\d+$/.test(suffix) && prefix) return prefix;
    }
    return host;
}

function resolveHost(environment = process.env) {
    return normalizeHost(environment.HOST || '0.0.0.0');
}

function resolvePort(environment = process.env) {
    const candidate = environment.PORT ?? 3000;
    if (typeof candidate === 'string') {
        const trimmed = candidate.trim();
        if (/^\d+$/.test(trimmed)) return Number(trimmed);
        const match = trimmed.match(/:(\d+)\)?$/);
        if (match) return Number(match[1]);
        const urlMatch = trimmed.match(/https?:\/\/[^:/]+:(\d+)/i);
        if (urlMatch) return Number(urlMatch[1]);
    }
    const value = Number(candidate);
    return Number.isInteger(value) && value > 0 && value <= 65535 ? value : 3000;
}

function normalizeEmail(value) {
    return String(value || '').normalize('NFKC').trim().toLowerCase();
}

function validEmail(email) {
    return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function extractMentionNames(content) {
    const mentions = new Set();
    const pattern = /(^|[^A-Za-z0-9_.-])@([A-Za-z0-9_.-]+)/g;
    let match;
    while ((match = pattern.exec(String(content || ''))) !== null) {
        mentions.add(match[2].toLowerCase());
    }
    return mentions;
}

function cleanUsername(value) {
    return String(value || '').normalize('NFKC').trim();
}

function validUsername(username) {
    return username.length >= 3 && username.length <= 24 && /^[A-Za-z0-9_.-]+$/.test(username);
}

function createChatState() {
    return {
        accounts: new Map(),
        sessions: new Map(),
        messages: new Map(CHANNELS.map(channel => [channel.id, []])),
        nextMessageId: 1,
        messageRevisions: new Map(CHANNELS.map(channel => [channel.id, 1])),
        typing: new Map(CHANNELS.map(channel => [channel.id, new Map()])),
        announcements: [],
        nextAnnouncementId: Date.now() * 1000,
        announcementStorePath: null,
        privateChannels: new Map(),
        reports: [],
        voiceRooms: new Map(),
        voiceSignals: [],
        nextVoiceSignalId: 1,
        messageStorePath: null,
        directMessages: new Map(),
        nextDirectMessageId: 1,
        authAttempts: new Map(),
        authQueue: Promise.resolve(),
        messageQueue: Promise.resolve(),
        activityTimer: null,
        userStorePath: null,
        supabaseClients: null,
        supabaseStore: null
    };
}

async function loadAccounts(state, userStorePath, ownerBootstrapPassword) {
    state.userStorePath = state.supabaseStore ? null : userStorePath;
    let records;
    if (state.supabaseStore) {
        records = state.supabaseStore.snapshot.accounts || [];
    } else {
        let contents;
        try {
            contents = await fs.promises.readFile(userStorePath, 'utf8');
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        records = contents === undefined ? [] : JSON.parse(contents);
    }
    if (!Array.isArray(records)) throw new Error(`Account store at ${userStorePath} must contain a JSON array.`);
    let migrated = false;
    for (const account of records) {
        if (!account || typeof account.username !== 'string' || typeof account.email !== 'string'
            || !validUsername(account.username) || !validEmail(account.email)
            || (!state.supabaseStore
                && (typeof account.salt !== 'string' || !/^[a-f0-9]{32}$/.test(account.salt)
                    || typeof account.passwordHash !== 'string' || !/^[a-f0-9]{128}$/.test(account.passwordHash)))) {
            throw new Error(`Account store at ${userStorePath} contains an invalid account record.`);
        }
        if (!ACCOUNT_ROLES.has(account.role)) {
            account.role = 'member';
            migrated = true;
        }
        if (account.createdAt === undefined) {
            account.createdAt = null;
            migrated = true;
        }
        if (!Number.isSafeInteger(account.announcementReadId) || account.announcementReadId < 0) {
            account.announcementReadId = 0;
            migrated = true;
        }
        if (!Array.isArray(account.blockedUsers)
            || account.blockedUsers.some(username => typeof username !== 'string')) {
            account.blockedUsers = [];
            migrated = true;
        }
        if (!account.mutedChannels || typeof account.mutedChannels !== 'object'
            || Array.isArray(account.mutedChannels)) {
            account.mutedChannels = {};
            migrated = true;
        }
        if (!account.channelReadIds || typeof account.channelReadIds !== 'object'
            || Array.isArray(account.channelReadIds)) {
            account.channelReadIds = {};
            migrated = true;
        }
        if (DEVELOPER_USERNAMES.has(account.username.toLowerCase()) && account.role !== 'developer') {
            account.role = 'developer';
            migrated = true;
        }
        if (!Number.isSafeInteger(account.messageCount) || account.messageCount < 0) {
            account.messageCount = 0;
            migrated = true;
        }
        if (!Number.isFinite(account.activeSeconds) || account.activeSeconds < 0) {
            account.activeSeconds = 0;
            migrated = true;
        }
        if (account.muted !== true && account.muted !== false) {
            account.muted = false;
            migrated = true;
        }
        if (account.mutedUntil !== null && account.mutedUntil !== undefined
            && (!Number.isFinite(account.mutedUntil) || account.mutedUntil < 0)) {
            account.mutedUntil = null;
            migrated = true;
        }
        if (account.muteUntil !== null && account.muteUntil !== undefined
            && (!Number.isFinite(account.muteUntil) || account.muteUntil < 0)) {
            account.muteUntil = null;
            migrated = true;
        }
        if (account.muteUntil === undefined) {
            account.muteUntil = null;
            migrated = true;
        }
        if (typeof account.banned !== 'boolean') {
            account.banned = false;
            migrated = true;
        }
        if (typeof account.ghosted !== 'boolean') {
            account.ghosted = false;
            migrated = true;
        }
        if (account.ghostedUntil !== null && account.ghostedUntil !== undefined
            && (!Number.isFinite(account.ghostedUntil) || account.ghostedUntil < 0)) {
            account.ghostedUntil = null;
            migrated = true;
        }
        if (account.ghostedUntil === undefined) {
            account.ghostedUntil = null;
            migrated = true;
        }
        account.bio ??= '';
        account.avatar ??= null;
        account.music ??= null;
        account.status ??= 'online';
        account.banner ??= null;
        account.decoration ??= 'none';
        account.profileEffect ??= 'none';
        account.onboarding ??= { completed: false, steps: [], interests: [], notifications: 'mentions' };
        if (account.onboarding && typeof account.onboarding === 'object'
            && !Array.isArray(account.onboarding)) {
            if (Array.isArray(account.onboarding.steps) && account.onboarding.steps.includes('bot')) {
                account.onboarding.steps = account.onboarding.steps.filter(step => step !== 'bot');
                migrated = true;
            }
            if (Array.isArray(account.onboarding.interests) && account.onboarding.interests.includes('ai')) {
                const interests = account.onboarding.interests.filter(interest => interest !== 'ai');
                if (!interests.includes('ideas')) interests.push('ideas');
                account.onboarding.interests = interests;
                migrated = true;
            }
        }
        if (Object.hasOwn(account, 'decorationImage')) {
            delete account.decorationImage;
            migrated = true;
        }
        if (typeof account.bio !== 'string' || account.bio.length > MAX_BIO_LENGTH
            || (account.avatar !== null && !validAvatar(account.avatar))
            || (account.music !== null && !validMusic(account.music))
            || !PROFILE_STATUSES.has(account.status)
            || (account.banner !== null && !validProfileImage(account.banner, MAX_BANNER_BYTES))
            || !PROFILE_DECORATIONS.has(account.decoration)
            || !PROFILE_EFFECTS.has(account.profileEffect)
            || !validOnboarding(account.onboarding)) {
            throw new Error(`Account store at ${userStorePath} contains invalid profile data.`);
        }
        if (!Array.isArray(account.warnings) || account.warnings.some(warning =>
            !warning || typeof warning.reason !== 'string' || typeof warning.by !== 'string'
            || typeof warning.createdAt !== 'string'
        )) {
            account.warnings = [];
            migrated = true;
        }
        state.accounts.set(account.username.toLowerCase(), account);
    }
    if (migrated && !state.supabaseStore) await saveAccounts(state, userStorePath);

    if (ownerBootstrapPassword && !state.supabaseStore && !state.accounts.has(OWNER_USERNAME)) {
        if (ownerBootstrapPassword.length < 8 || ownerBootstrapPassword.length > 128) {
            throw new Error('OWNER_BOOTSTRAP_PASSWORD must be between 8 and 128 characters.');
        }
        if (!validUsername(OWNER_USERNAME)) throw new Error('OWNER_USERNAME is invalid.');
        const passwordDetails = await hashPassword(ownerBootstrapPassword);
        state.accounts.set(OWNER_USERNAME, {
            username: OWNER_USERNAME,
            email: `${OWNER_USERNAME}@localhost.invalid`,
            ...passwordDetails,
            bio: '',
            avatar: null,
            music: null,
            status: 'online',
            banner: null,
            decoration: 'none',
            profileEffect: 'none',
            onboarding: { completed: false, steps: [], interests: [], notifications: 'mentions' },
            role: 'developer',
            createdAt: null,
            announcementReadId: 0,
            blockedUsers: [],
            mutedChannels: {},
            channelReadIds: {},
            messageCount: 0,
            activeSeconds: 0,
            muted: false,
            muteUntil: null,
            mutedUntil: null,
            banned: false,
            ghosted: false,
            ghostedUntil: null,
            warnings: []
        });
        await saveAccounts(state, userStorePath);
    }
}

function validAvatar(value) {
    return validProfileImage(value, MAX_AVATAR_BYTES);
}

function validProfileImage(value, maxBytes) {
    if (typeof value !== 'string') return false;
    const match = value.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!match) return false;
    const encoded = match[2];
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length === 0 || bytes.length > maxBytes || bytes.toString('base64') !== encoded) return false;
    if (match[1] === 'png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (match[1] === 'jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF'
        && bytes.toString('ascii', 8, 12) === 'WEBP';
}

function validOnboarding(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value)
        && typeof value.completed === 'boolean'
        && Array.isArray(value.steps) && value.steps.every(step => ONBOARDING_STEPS.has(step))
        && new Set(value.steps).size === value.steps.length
        && Array.isArray(value.interests) && value.interests.every(interest => ONBOARDING_INTERESTS.has(interest))
        && new Set(value.interests).size === value.interests.length
        && ONBOARDING_NOTIFICATIONS.has(value.notifications));
}

function validMusic(value) {
    if (typeof value !== 'string') return false;
    const match = value.match(/^data:audio\/([a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/i);
    if (!match) return false;
    const encoded = match[2];
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length === 0 || bytes.length > MAX_MUSIC_BYTES || bytes.toString('base64') !== encoded) return false;
    const mime = match[1].toLowerCase();
    return ['mpeg', 'mp3', 'wav', 'ogg', 'webm', 'aac', 'm4a', 'mp4', 'x-m4a'].includes(mime);
}

function validChatImage(value) {
    if (typeof value !== 'string') return false;
    const match = value.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
    if (!match) return false;
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.length === 0 || bytes.length > MAX_CHAT_IMAGE_BYTES || bytes.toString('base64') !== match[2]) return false;
    if (match[1] === 'png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (match[1] === 'jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF'
        && bytes.toString('ascii', 8, 12) === 'WEBP';
}

function messageReply(messages, replyToId, viewerUserId = null) {
    if (replyToId === undefined || replyToId === null || replyToId === '') return null;
    if (!Number.isSafeInteger(replyToId) || replyToId < 1) return undefined;
    const original = messages.find(message => message.id === replyToId);
    if (!original || original.deleted || (original.recipientUserId && original.recipientUserId !== viewerUserId)) {
        return undefined;
    }
    return {
        id: original.id,
        author: original.author,
        content: original.content,
        image: Boolean(original.image)
    };
}

function publicProfile(account) {
    return {
        username: account.username,
        bio: account.bio,
        avatar: account.avatar,
        music: account.music || null,
        status: account.status,
        role: account.role || 'member',
        banner: account.banner || null,
        decoration: account.decoration || 'none',
        profileEffect: account.profileEffect || 'none'
    };
}

function memberDirectoryProfile(account) {
    const { music, banner, ...profile } = publicProfile(account);
    return profile;
}

function compareMembersByRole(a, b) {
    return (ROLE_ORDER[a.role] ?? 4) - (ROLE_ORDER[b.role] ?? 4)
        || a.username.localeCompare(b.username);
}

function accountIsMuted(account, now = Date.now()) {
    return Boolean(account.muted || account.muteUntil > now || account.mutedUntil > now);
}

function accountIsGhosted(account, now = Date.now()) {
    return account.ghosted && (!account.ghostedUntil || account.ghostedUntil > now);
}

function adminAccount(account) {
    const now = Date.now();
    return {
        ...publicProfile(account),
        email: account.email,
        createdAt: account.createdAt,
        messageCount: account.messageCount,
        activeSeconds: Math.floor(account.activeSeconds),
        muteUntil: account.muteUntil,
        mutedUntil: account.mutedUntil,
        muted: account.muted || account.muteUntil > now,
        banned: account.banned,
        ghosted: accountIsGhosted(account, now),
        warnings: account.warnings
    };
}

function staffAccount(account) {
    const now = Date.now();
    return {
        username: account.username,
        avatar: account.avatar,
        role: account.role || 'member',
        muted: account.muted || account.muteUntil > now,
        muteUntil: account.muteUntil,
        mutedUntil: account.mutedUntil,
        ghosted: accountIsGhosted(account, now),
        warningCount: account.warnings.length
    };
}

function trackActivity(state, session, now = Date.now()) {
    const account = state.accounts.get(session.userId);
    if (!account) return;
    if (session.lastActiveAt) {
        account.activeSeconds += Math.min(Math.max(0, now - session.lastActiveAt), 30000) / 1000;
    }
    session.lastActiveAt = now;
    session.lastSeenAt = now;
    state.activityDirty = true;
}

function persistActivity(state) {
    if (!state.activityDirty || (!state.userStorePath && !state.supabaseStore)) return Promise.resolve();
    state.activityDirty = false;
    const saving = withAuthLock(state, () => saveAccounts(state, state.userStorePath));
    state.activitySave = saving.catch(error => {
            state.activityDirty = true;
            console.error(`Could not save account activity: ${error.message}`);
            throw error;
        });
    return state.activitySave;
}

async function markMessageCount(state, account) {
    account.messageCount += 1;
    state.activityDirty = true;
    if (!state.supabaseStore) await persistActivity(state);
}

async function saveAccounts(state, userStorePath) {
    if (state.supabaseStore) return state.supabaseStore.save(state);
    const directory = path.dirname(userStorePath);
    const temporaryPath = `${userStorePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
        await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
        await fs.promises.writeFile(temporaryPath, JSON.stringify([...state.accounts.values()], null, 2), {
            encoding: 'utf8',
            mode: 0o600
        });
        await fs.promises.rename(temporaryPath, userStorePath);
        await fs.promises.chmod(userStorePath, 0o600);
    } catch (error) {
        await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
        error.statusCode ||= 500;
        throw error;
    }
}

async function loadAnnouncements(state, userStorePath) {
    if (state.supabaseStore) {
        const records = state.supabaseStore.snapshot.announcements || [];
        if (!Array.isArray(records) || records.some(announcement =>
            !announcement || !Number.isSafeInteger(announcement.id) || announcement.id < 1
            || typeof announcement.title !== 'string' || announcement.title.length < 1
            || announcement.title.length > MAX_ANNOUNCEMENT_TITLE_LENGTH
            || typeof announcement.body !== 'string' || announcement.body.length < 1
            || announcement.body.length > MAX_ANNOUNCEMENT_BODY_LENGTH
            || !ANNOUNCEMENT_CATEGORIES.has(announcement.category || 'update')
            || typeof announcement.author !== 'string' || typeof announcement.createdAt !== 'string'
        )) {
            throw new Error('Supabase app data contains invalid announcements.');
        }
        state.announcements = records.sort((a, b) => a.id - b.id).slice(-MAX_ANNOUNCEMENTS);
        state.nextAnnouncementId = Math.max(
            state.nextAnnouncementId,
            ...state.announcements.map(announcement => announcement.id + 1)
        );
        return;
    }
    const announcementStorePath = `${userStorePath}.announcements.json`;
    state.announcementStorePath = announcementStorePath;
    let contents;
    try {
        contents = await fs.promises.readFile(announcementStorePath, 'utf8');
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    if (contents === undefined) return;
    const records = JSON.parse(contents);
    if (!Array.isArray(records) || records.some(announcement =>
        !announcement || !Number.isSafeInteger(announcement.id) || announcement.id < 1
        || typeof announcement.title !== 'string' || announcement.title.length < 1
        || announcement.title.length > MAX_ANNOUNCEMENT_TITLE_LENGTH
        || typeof announcement.body !== 'string' || announcement.body.length < 1
        || announcement.body.length > MAX_ANNOUNCEMENT_BODY_LENGTH
        || !ANNOUNCEMENT_CATEGORIES.has(announcement.category || 'update')
        || typeof announcement.author !== 'string' || typeof announcement.createdAt !== 'string'
    )) {
        throw new Error(`Announcement store at ${announcementStorePath} contains invalid data.`);
    }
    state.announcements = records.sort((a, b) => a.id - b.id).slice(-MAX_ANNOUNCEMENTS);
    state.nextAnnouncementId = Math.max(
        state.nextAnnouncementId,
        ...state.announcements.map(announcement => announcement.id + 1)
    );
}

async function saveAnnouncements(state) {
    if (state.supabaseStore) return state.supabaseStore.save(state);
    const announcementStorePath = state.announcementStorePath;
    if (!announcementStorePath) throw new Error('Announcement store path is not configured.');
    const directory = path.dirname(announcementStorePath);
    await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${announcementStorePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
        await fs.promises.writeFile(temporaryPath, JSON.stringify(state.announcements, null, 2), {
            encoding: 'utf8',
            mode: 0o600
        });
        await fs.promises.rename(temporaryPath, announcementStorePath);
        await fs.promises.chmod(announcementStorePath, 0o600);
    } catch (error) {
        await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
        error.statusCode ||= 500;
        throw error;
    }
}

function validStoredMessage(message) {
    const validBase = message && Number.isSafeInteger(message.id) && message.id > 0
        && typeof message.author === 'string' && typeof message.content === 'string'
        && typeof message.createdAt === 'string' && typeof message.kind === 'string';
    if (!validBase) return false;
    if (message.kind === 'poll') {
        return message.poll && Array.isArray(message.poll.options)
            && message.poll.options.length >= 2 && message.poll.options.length <= MAX_POLL_OPTIONS
            && message.poll.options.every(option => option && typeof option.text === 'string'
                && option.text.length <= 100 && Array.isArray(option.votes)
                && option.votes.every(voter => typeof voter === 'string'))
            && typeof message.poll.closed === 'boolean';
    }
    if (message.kind === 'event') {
        return message.event && typeof message.event.startsAt === 'string'
            && Number.isFinite(Date.parse(message.event.startsAt))
            && typeof message.event.details === 'string';
    }
    return true;
}

async function loadMessages(state, userStorePath) {
    if (state.supabaseStore) {
        const stored = state.supabaseStore.snapshot;
        if (!stored.messages || typeof stored.messages !== 'object' || Array.isArray(stored.messages)
            || !stored.directMessages || typeof stored.directMessages !== 'object' || Array.isArray(stored.directMessages)
            || !Array.isArray(stored.privateChannels || []) || !Array.isArray(stored.reports || [])) {
            throw new Error('Supabase app data contains invalid message data.');
        }
        return loadStoredMessages(state, stored);
    }
    const messageStorePath = `${userStorePath}.messages.json`;
    state.messageStorePath = messageStorePath;
    let contents;
    try {
        contents = await fs.promises.readFile(messageStorePath, 'utf8');
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    if (contents === undefined) return;
    const stored = JSON.parse(contents);
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)
        || !stored.messages || typeof stored.messages !== 'object' || Array.isArray(stored.messages)
        || !stored.directMessages || typeof stored.directMessages !== 'object' || Array.isArray(stored.directMessages)
        || !Array.isArray(stored.privateChannels) || !Array.isArray(stored.reports)) {
        throw new Error(`Message store at ${messageStorePath} contains invalid data.`);
    }
    return loadStoredMessages(state, stored, messageStorePath);
}

function loadStoredMessages(state, stored, messageStorePath = 'Supabase app data') {
    if (stored.privateChannels.length > MAX_PRIVATE_CHANNELS) {
        throw new Error(`Message store at ${messageStorePath} contains too many private channels.`);
    }
    for (const channel of stored.privateChannels) {
        if (!channel || typeof channel.id !== 'string' || !/^private-[a-f0-9]{12}$/.test(channel.id)
            || typeof channel.name !== 'string' || typeof channel.topic !== 'string'
            || typeof channel.owner !== 'string' || !Array.isArray(channel.members)
            || channel.members.some(member => typeof member !== 'string')) {
            throw new Error(`Message store at ${messageStorePath} contains an invalid private channel.`);
        }
        state.privateChannels.set(channel.id, channel);
        state.messages.set(channel.id, []);
        state.messageRevisions.set(channel.id, 1);
        state.typing.set(channel.id, new Map());
    }
    let migratedBotMessages = false;
    const migrateBotMessages = messages => messages.map(message => {
        if (message.kind === 'bot') {
            message.author = 'System';
            message.kind = 'system';
            migratedBotMessages = true;
        }
        return message;
    });
    for (const channel of [...CHANNELS, ...state.privateChannels.values()]) {
        const messages = stored.messages[channel.id] || [];
        if (!Array.isArray(messages) || messages.some(message =>
            !validStoredMessage(message) || message.channelId !== channel.id
        )) {
            throw new Error(`Message store at ${messageStorePath} contains invalid messages for ${channel.id}.`);
        }
        state.messages.set(channel.id, migrateBotMessages(messages.slice(-MESSAGE_HISTORY_LIMIT)));
        state.messageRevisions.set(channel.id, Math.max(
            1,
            ...messages.map(message => Number.isSafeInteger(message.revision) ? message.revision + 1 : 1)
        ));
    }
    for (const [key, messages] of Object.entries(stored.directMessages)) {
        if (!/^[a-z0-9_.-]+:[a-z0-9_.-]+$/.test(key) || !Array.isArray(messages)
            || messages.some(message => !validStoredMessage(message))) {
            throw new Error(`Message store at ${messageStorePath} contains invalid direct messages.`);
        }
        state.directMessages.set(key, migrateBotMessages(messages.slice(-MESSAGE_HISTORY_LIMIT)));
    }
    if (stored.reports.length > MAX_REPORTS || stored.reports.some(report => !report || !Number.isSafeInteger(report.id)
        || typeof report.channelId !== 'string' || !Number.isSafeInteger(report.messageId)
        || typeof report.reporter !== 'string' || typeof report.reason !== 'string'
        || !['open', 'resolved', 'dismissed'].includes(report.status))) {
        throw new Error(`Message store at ${messageStorePath} contains invalid reports.`);
    }
    state.reports = stored.reports;
    const allMessages = [...state.messages.values(), ...state.directMessages.values()].flat();
    state.nextMessageId = allMessages.reduce((latest, message) => Math.max(latest, message.id + 1), 1);
    state.nextDirectMessageId = [...state.directMessages.values()].flat()
        .reduce((latest, message) => Math.max(latest, message.id + 1), 1);
    if (migratedBotMessages && !state.supabaseStore) return saveMessages(state);
}

function saveMessages(state) {
    const save = async () => {
        if (state.supabaseStore) return state.supabaseStore.save(state);
        if (!state.messageStorePath) throw new Error('Message store path is not configured.');
        const stored = {
            messages: Object.fromEntries(state.messages),
            directMessages: Object.fromEntries(state.directMessages),
            privateChannels: [...state.privateChannels.values()],
            reports: state.reports
        };
        const directory = path.dirname(state.messageStorePath);
        const temporaryPath = `${state.messageStorePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
        try {
            await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
            await fs.promises.writeFile(temporaryPath, JSON.stringify(stored), {
                encoding: 'utf8',
                mode: 0o600
            });
            await fs.promises.rename(temporaryPath, state.messageStorePath);
            await fs.promises.chmod(state.messageStorePath, 0o600);
        } catch (error) {
            await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
            error.statusCode ||= 500;
            throw error;
        }
    };
    const result = (state.messageQueue || Promise.resolve()).then(save);
    state.messageQueue = result.catch(() => {});
    return result;
}

function getChannel(state, channelId) {
    return CHANNELS.find(channel => channel.id === channelId) || state.privateChannels.get(channelId) || null;
}

function canAccessChannel(state, channelId, userId) {
    if (CHANNELS.some(channel => channel.id === channelId)) return true;
    return state.privateChannels.get(channelId)?.members.includes(userId) || false;
}

function visibleChannel(state, channel, userId) {
    const visible = {
        id: channel.id,
        name: channel.name,
        topic: channel.topic,
        private: Boolean(state.privateChannels.has(channel.id))
    };
    if (visible.private) visible.canInvite = channel.owner === userId;
    return visible;
}

function withAuthLock(state, operation) {
    const result = state.authQueue.then(operation);
    state.authQueue = result.catch(() => {});
    return result;
}

function updateAccountFields(state, account, changes, userStorePath) {
    return withAuthLock(state, async () => {
        const previous = Object.fromEntries(Object.keys(changes).map(key => [key, account[key]]));
        Object.assign(account, changes);
        try {
            await saveAccounts(state, userStorePath);
        } catch (error) {
            Object.assign(account, previous);
            throw error;
        }
    });
}

function checkAuthLimit(state, key) {
    const now = Date.now();
    let attempt = state.authAttempts.get(key);
    if (!attempt || now >= attempt.resetAt) {
        attempt = { count: 0, resetAt: now + LOGIN_WINDOW_MS };
        state.authAttempts.set(key, attempt);
    }
    if (attempt.count >= LOGIN_ATTEMPT_LIMIT) return false;
    attempt.count += 1;
    return true;
}

async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    const derived = await scrypt(password, salt, 64);
    return { salt, passwordHash: derived.toString('hex') };
}

function createAccountRecord(username, email, passwordDetails = {}, authUserId = null) {
    return {
        username,
        email,
        ...passwordDetails,
        ...(authUserId ? { authUserId } : {}),
        bio: '',
        avatar: null,
        music: null,
        status: 'online',
        banner: null,
        decoration: 'none',
        profileEffect: 'none',
        onboarding: { completed: false, steps: [], interests: [], notifications: 'mentions' },
        role: DEVELOPER_USERNAMES.has(username.toLowerCase()) ? 'developer' : 'member',
        createdAt: new Date().toISOString(),
        announcementReadId: 0,
        blockedUsers: [],
        mutedChannels: {},
        channelReadIds: {},
        messageCount: 0,
        activeSeconds: 0,
        muted: false,
        muteUntil: null,
        mutedUntil: null,
        banned: false,
        ghosted: false,
        ghostedUntil: null,
        warnings: []
    };
}

function createSession(state, account) {
    const id = crypto.randomBytes(24).toString('hex');
    state.sessions.set(id, { userId: account.username.toLowerCase(), name: account.username, lastSeenAt: Date.now() });
    const cookie = [`chat_session=${id}`, 'HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${SESSION_TTL_MS / 1000}`];
    if (process.env.COOKIE_SECURE === 'true') cookie.push('Secure');
    return { 'Set-Cookie': cookie.join('; ') };
}

function readJson(request) {
    return new Promise((resolve, reject) => {
        let size = 0;
        let body = '';
        let tooLarge = false;
        request.setEncoding('utf8');
        request.on('data', chunk => {
            size += Buffer.byteLength(chunk);
            if (size > MAX_BODY_BYTES) {
                tooLarge = true;
                return;
            }
            body += chunk;
        });
        request.on('end', () => {
            if (tooLarge) {
                reject(Object.assign(new Error('Request body is too large.'), { statusCode: 413 }));
                return;
            }
            try {
                const value = body ? JSON.parse(body) : {};
                if (!value || typeof value !== 'object' || Array.isArray(value)) {
                    reject(Object.assign(new Error('Request body must be a JSON object.'), { statusCode: 400 }));
                    return;
                }
                resolve(value);
            } catch {
                reject(Object.assign(new Error('Request body must be valid JSON.'), { statusCode: 400 }));
            }
        });
        request.on('error', reject);
    });
}

function sendJson(response, statusCode, payload, headers = {}) {
    response.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...headers
    });
    response.end(JSON.stringify(payload));
}

function readSessionId(request) {
    const cookies = String(request.headers.cookie || '').split(';');
    const sessionCookie = cookies.map(cookie => cookie.trim())
        .find(cookie => cookie.startsWith('chat_session='));
    return sessionCookie ? sessionCookie.slice('chat_session='.length) : '';
}

function createMessage(state, channelId, author, content, kind = 'user') {
    const message = {
        id: state.nextMessageId++,
        channelId,
        revision: state.messageRevisions.get(channelId) || 1,
        author,
        content,
        kind,
        reactions: [],
        pinned: false,
        createdAt: new Date().toISOString()
    };
    const channelMessages = state.messages.get(channelId);
    channelMessages.push(message);
    state.messageRevisions.set(channelId, message.revision + 1);
    if (channelMessages.length > MESSAGE_HISTORY_LIMIT) channelMessages.shift();
    return message;
}

function getMessages(state, channelId, after, before = 0, limit = 50) {
    const channelMessages = state.messages.get(channelId) || [];
    if (after > 0) return channelMessages.filter(message => message.id > after);
    if (before > 0) return channelMessages.filter(message => message.id < before).slice(-limit);
    return channelMessages.slice(-limit);
}

function getVisibleMessages(state, channelId, after, viewerUserId, before = 0, limit = 50) {
    return getMessages(state, channelId, after, before, limit).filter(message =>
        (!message.recipientUserId || message.recipientUserId === viewerUserId)
        && !isBlockedByViewer(state, viewerUserId, message)
    );
}

function getVisibleChannelHistory(state, channelId, viewerUserId) {
    return (state.messages.get(channelId) || []).filter(message =>
        (!message.recipientUserId || message.recipientUserId === viewerUserId)
        && !isBlockedByViewer(state, viewerUserId, message)
    );
}

function isBlockedByViewer(state, viewerUserId, message) {
    const viewer = state.accounts.get(viewerUserId);
    return Boolean(viewer?.blockedUsers?.includes(message.author.toLowerCase()));
}

function getChannelMessage(state, channelId, messageId) {
    return (state.messages.get(channelId) || []).find(message => message.id === messageId);
}

function touchMessage(state, message) {
    message.revision = state.messageRevisions.get(message.channelId) || 1;
    state.messageRevisions.set(message.channelId, message.revision + 1);
}

function canModerateMessage(state, actor, message) {
    if (!['developer', 'owner', 'admin'].includes(actor.role)) return false;
    const author = state.accounts.get(message.author.toLowerCase());
    if (author) return (ROLE_ORDER[actor.role] ?? Infinity) < (ROLE_ORDER[author.role] ?? ROLE_ORDER.member);
    return message.kind !== 'system';
}

function directMessageKey(firstUserId, secondUserId) {
    return [firstUserId, secondUserId].sort().join(':');
}

async function createChatServer({
    host = resolveHost(),
    port = resolvePort(),
    state = createChatState(),
    userStorePath = getUserStorePath(),
    ownerBootstrapPassword = process.env.OWNER_BOOTSTRAP_PASSWORD,
    supabaseClients = createSupabaseClients()
} = {}) {
    state.supabaseClients = supabaseClients;
    let importingJson = false;
    if (state.supabaseClients) {
        state.supabaseStore = new SupabaseStore(state.supabaseClients.admin);
        await state.supabaseStore.load();
        importingJson = !state.supabaseStore.hasState && process.env.SUPABASE_IMPORT_JSON === 'true';
        if (importingJson) {
            const sourceFiles = [
                userStorePath,
                `${userStorePath}.messages.json`,
                `${userStorePath}.announcements.json`
            ];
            let sourceFound = false;
            for (const sourceFile of sourceFiles) {
                try {
                    await fs.promises.access(sourceFile);
                    sourceFound = true;
                    break;
                } catch (error) {
                    if (error.code !== 'ENOENT') throw error;
                }
            }
            if (!sourceFound) {
                throw new Error('SUPABASE_IMPORT_JSON is enabled, but no local JSON data files were found.');
            }
            state.supabaseStore = null;
        }
    }
    await loadAccounts(state, userStorePath, ownerBootstrapPassword);
    await loadAnnouncements(state, userStorePath);
    await loadMessages(state, userStorePath);
    if (importingJson) {
        for (const account of state.accounts.values()) {
            delete account.salt;
            delete account.passwordHash;
        }
        state.supabaseStore = new SupabaseStore(state.supabaseClients.admin);
        state.supabaseStore.hasState = false;
        state.supabaseStore.snapshot = {};
        state.userStorePath = null;
        state.messageStorePath = null;
        state.announcementStorePath = null;
        await state.supabaseStore.save(state);
    } else if (state.supabaseStore) {
        await state.supabaseStore.save(state);
    }
    const server = http.createServer(async (request, response) => {
        const pathname = new URL(request.url || '/', 'http://localhost').pathname;
        response.setHeader('X-Frame-Options', 'DENY');
        response.setHeader('Referrer-Policy', 'same-origin');
        response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' stun: turn: turns:; img-src 'self' data:; media-src 'self' data: blob:; base-uri 'none'; frame-ancestors 'none'");

        if (request.method === 'GET' && pathname === '/') {
            response.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff'
            });
            response.end(PAGE);
            return;
        }

        if (pathname.startsWith('/api/')) {
            response.setHeader('X-Content-Type-Options', 'nosniff');
            response.setHeader('Cache-Control', 'no-store');
        }

        const sessionId = readSessionId(request);
        let session = state.sessions.get(sessionId);
        if (session && Date.now() - session.lastSeenAt > SESSION_TTL_MS) {
            state.sessions.delete(sessionId);
            session = null;
        }
        if (session) trackActivity(state, session);

        if (request.method === 'GET' && pathname === '/api/session') {
            sendJson(response, 200, {
                user: session ? { name: session.name, username: session.name } : null
            });
            return;
        }

        if (request.method === 'POST' && pathname === '/api/auth/register') {
            try {
                const body = await readJson(request);
                const username = cleanUsername(body.username);
                const email = normalizeEmail(body.email);
                const password = typeof body.password === 'string' ? body.password : '';
                if (!checkAuthLimit(state, `register:${request.socket.remoteAddress || 'unknown'}`)) {
                    sendJson(response, 429, { error: 'Too many sign-up attempts. Please wait 15 minutes and try again.' });
                    return;
                }
                if (!validUsername(username)) {
                    sendJson(response, 400, { error: 'Username must be 3–24 characters using letters, numbers, dots, dashes, or underscores.' });
                    return;
                }
                if (!validEmail(email)) {
                    sendJson(response, 400, { error: 'Enter a valid email address.' });
                    return;
                }
                if (password.length < 8 || password.length > 128) {
                    sendJson(response, 400, { error: 'Password must be between 8 and 128 characters.' });
                    return;
                }
                if (state.supabaseClients) {
                    const result = await withAuthLock(state, async () => {
                        const account = state.accounts.get(username.toLowerCase());
                        const emailAccount = [...state.accounts.values()].find(item => item.email === email);
                        const canRecoverProfile = account && account.email === email && !account.authUserId;
                        if ((account && !canRecoverProfile) || (emailAccount && emailAccount !== account)) {
                            return { status: 409, error: 'That username or email is already registered.' };
                        }
                        const { data, error } = await state.supabaseClients.admin.auth.admin.createUser({
                            email,
                            password,
                            email_confirm: true,
                            user_metadata: { username }
                        });
                        if (error) {
                            const duplicate = /already registered|already exists/i.test(error.message);
                            return {
                                status: duplicate ? 409 : 400,
                                error: duplicate
                                    ? 'That email is already registered. Sign in or reset your password.'
                                    : error.message
                            };
                        }
                        if (!data.user || data.user.identities?.length === 0) {
                            return { status: 409, error: 'That email is already registered. Sign in or reset your password.' };
                        }
                        const previousAccount = account ? { ...account } : null;
                        const newAccount = account || createAccountRecord(username, email);
                        newAccount.email = email;
                        newAccount.authUserId = data.user.id;
                        delete newAccount.salt;
                        delete newAccount.passwordHash;
                        state.accounts.set(username.toLowerCase(), newAccount);
                        try {
                            await saveAccounts(state, userStorePath);
                        } catch (saveError) {
                            if (previousAccount) Object.assign(newAccount, previousAccount);
                            else state.accounts.delete(username.toLowerCase());
                            try {
                                await state.supabaseClients.admin.auth.admin.deleteUser(data.user.id);
                            } catch (rollbackError) {
                                console.error(`Could not remove Supabase account after profile save failure: ${rollbackError.message}`);
                            }
                            throw saveError;
                        }
                        return { status: 201, account: newAccount };
                    });
                    if (result.error) {
                        sendJson(response, result.status, { error: result.error });
                        return;
                    }
                    state.authAttempts.delete(`register:${request.socket.remoteAddress || 'unknown'}`);
                    const headers = createSession(state, result.account);
                    sendJson(response, 201, {
                        user: { name: result.account.username, username: result.account.username }
                    }, headers);
                    return;
                }
                const passwordDetails = await hashPassword(password);
                const result = await withAuthLock(state, async () => {
                    const emailTaken = [...state.accounts.values()].some(account => account.email === email);
                    if (state.accounts.has(username.toLowerCase()) || emailTaken) {
                        return { status: 409, error: 'That username or email is already registered.' };
                    }
                    const account = createAccountRecord(username, email, passwordDetails);
                    state.accounts.set(username.toLowerCase(), account);
                    try {
                        await saveAccounts(state, userStorePath);
                    } catch (error) {
                        state.accounts.delete(username.toLowerCase());
                        console.error(`Could not save account data: ${error.message}`);
                        return { status: 500, error: 'Your account could not be saved. Please try again.' };
                    }
                    return { status: 201, account };
                });
                if (result.error) {
                    sendJson(response, result.status, { error: result.error });
                    return;
                }
                state.authAttempts.delete(`register:${request.socket.remoteAddress || 'unknown'}`);
                const headers = createSession(state, result.account);
                sendJson(response, 201, {
                    user: { name: result.account.username, username: result.account.username }
                }, headers);
            } catch (error) {
                sendJson(response, error.statusCode || 400, { error: error.message });
            }
            return;
        }

        if (request.method === 'POST' && pathname === '/api/auth/login') {
            try {
                const body = await readJson(request);
                const identifier = String(body.identifier || '').normalize('NFKC').trim().toLowerCase();
                const password = typeof body.password === 'string' ? body.password : '';
                const key = `login:${request.socket.remoteAddress || 'unknown'}`;
                if (!checkAuthLimit(state, key)) {
                    sendJson(response, 429, { error: 'Too many sign-in attempts. Please wait 15 minutes and try again.' });
                    return;
                }
                const account = [...state.accounts.values()].find(item =>
                    item.username.toLowerCase() === identifier || item.email === identifier
                );
                if (state.supabaseClients) {
                    if (!account?.authUserId) {
                        sendJson(response, 401, {
                            error: 'Username/email or password is incorrect. If this account came from older data, create an account with the same username and email to set a new password.'
                        });
                        return;
                    }
                    if (account.banned) {
                        sendJson(response, 403, { error: 'This account is banned from the chat.' });
                        return;
                    }
                    const { data, error } = await state.supabaseClients.auth.auth.signInWithPassword({
                        email: account.email,
                        password
                    });
                    if (error || data.user?.id !== account.authUserId) {
                        sendJson(response, 401, { error: 'Username/email or password is incorrect.' });
                        return;
                    }
                    state.authAttempts.delete(key);
                    const headers = createSession(state, account);
                    sendJson(response, 200, {
                        user: { name: account.username, username: account.username }
                    }, headers);
                    return;
                }
                const salt = account?.salt || 'orbit-dummy-salt';
                const expected = account ? Buffer.from(account.passwordHash, 'hex') : DUMMY_PASSWORD_HASH;
                const actual = await scrypt(password.slice(0, 128), salt, expected.length);
                if (!account || actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
                    sendJson(response, 401, { error: 'Username/email or password is incorrect.' });
                    return;
                }
                if (account.banned) {
                    sendJson(response, 403, { error: 'This account is banned from the chat.' });
                    return;
                }
                state.authAttempts.delete(key);
                const headers = createSession(state, account);
                sendJson(response, 200, {
                    user: { name: account.username, username: account.username }
                }, headers);
            } catch (error) {
                sendJson(response, error.statusCode || 400, { error: error.message });
            }
            return;
        }

        if (request.method === 'POST' && pathname === '/api/auth/reset-password') {
            try {
                if (!state.supabaseClients) {
                    sendJson(response, 503, { error: 'Password recovery is not configured.' });
                    return;
                }
                const resetKey = `reset:${request.socket.remoteAddress || 'unknown'}`;
                if (!checkAuthLimit(state, resetKey)) {
                    sendJson(response, 429, { error: 'Too many recovery attempts. Please wait 15 minutes and try again.' });
                    return;
                }
                const body = await readJson(request);
                const identifier = String(body.identifier || '').normalize('NFKC').trim().toLowerCase();
                const account = [...state.accounts.values()].find(item =>
                    item.username.toLowerCase() === identifier || item.email === identifier
                );
                if (account?.authUserId) {
                    const redirectTo = process.env.SUPABASE_AUTH_REDIRECT_URL || 'https://esakura.lol/';
                    const { error } = await state.supabaseClients.auth.auth.resetPasswordForEmail(
                        account.email,
                        { redirectTo }
                    );
                    if (error) throw new Error(`Could not send password reset email: ${error.message}`);
                }
                state.authAttempts.delete(resetKey);
                sendJson(response, 200, {
                    message: account && !account.authUserId
                        ? 'This older profile needs to be linked first. Create an account with the same username and email to set a new password.'
                        : 'If that account can be recovered, password reset instructions have been sent to its email.'
                });
            } catch (error) {
                sendJson(response, error.statusCode || 400, { error: error.message });
            }
            return;
        }

        if (request.method === 'POST' && pathname === '/api/auth/update-password') {
            try {
                if (!state.supabaseClients) {
                    sendJson(response, 503, { error: 'Password recovery is not configured.' });
                    return;
                }
                const resetKey = `reset:${request.socket.remoteAddress || 'unknown'}`;
                if (!checkAuthLimit(state, resetKey)) {
                    sendJson(response, 429, { error: 'Too many recovery attempts. Please wait 15 minutes and try again.' });
                    return;
                }
                const body = await readJson(request);
                const accessToken = typeof body.accessToken === 'string' ? body.accessToken : '';
                const password = typeof body.password === 'string' ? body.password : '';
                if (password.length < 8 || password.length > 128) {
                    sendJson(response, 400, { error: 'Password must be between 8 and 128 characters.' });
                    return;
                }
                const { data, error } = await state.supabaseClients.auth.auth.getUser(accessToken);
                if (error || !data.user) {
                    sendJson(response, 401, { error: 'That password reset link is invalid or has expired.' });
                    return;
                }
                const { error: updateError } = await state.supabaseClients.admin.auth.admin.updateUserById(
                    data.user.id,
                    { password }
                );
                if (updateError) throw new Error(`Could not update password: ${updateError.message}`);
                state.authAttempts.delete(resetKey);
                sendJson(response, 200, { message: 'Your password has been updated. Sign in with your new password.' });
            } catch (error) {
                sendJson(response, error.statusCode || 400, { error: error.message });
            }
            return;
        }

        if (request.method === 'POST' && pathname === '/api/auth/logout') {
            if (session) state.sessions.delete(sessionId);
            sendJson(response, 200, { user: null }, {
                'Set-Cookie': 'chat_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'
            });
            return;
        }

        if (!session) {
            sendJson(response, 401, { error: 'Please sign in to continue.' });
            return;
        }

        const signedInAccount = state.accounts.get(session.userId);
        if (!signedInAccount || signedInAccount.banned) {
            state.sessions.delete(sessionId);
            sendJson(response, 403, { error: 'This account is banned from the chat.' }, {
                'Set-Cookie': 'chat_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'
            });
            return;
        }

        if (request.method === 'GET' && pathname === '/api/notifications') {
            const after = Number(new URL(request.url || '/', 'http://localhost').searchParams.get('after') || 0);
            if (!Number.isSafeInteger(after) || after < 0) {
                sendJson(response, 400, { error: 'Notification cursor is invalid.' });
                return;
            }
            sendJson(response, 200, {
                notifications: state.announcements.filter(announcement => announcement.id > after),
                readId: signedInAccount.announcementReadId || 0
            });
            return;
        }

        if (request.method === 'POST' && pathname === '/api/notifications/read') {
            try {
                const body = await readJson(request);
                const latestId = state.announcements.at(-1)?.id || 0;
                if (!Number.isSafeInteger(body.id) || body.id < 0 || body.id > latestId) {
                    sendJson(response, 400, { error: 'Notification read position is invalid.' });
                    return;
                }
                let readId;
                try {
                    readId = await withAuthLock(state, async () => {
                        const previousReadId = signedInAccount.announcementReadId || 0;
                        signedInAccount.announcementReadId = Math.max(previousReadId, body.id);
                        try {
                            await saveAccounts(state, userStorePath);
                        } catch (error) {
                            signedInAccount.announcementReadId = previousReadId;
                            throw error;
                        }
                        return signedInAccount.announcementReadId;
                    });
                } catch (error) {
                    console.error(`Could not save notification read state: ${error.message}`);
                    sendJson(response, 500, { error: 'Your notification read state could not be saved.' });
                    return;
                }
                sendJson(response, 200, { readId });
            } catch (error) {
                sendJson(response, error.statusCode || 400, { error: error.message });
            }
            return;
        }

        if (pathname === '/api/developer/announcements') {
            if (signedInAccount.role !== 'developer') {
                sendJson(response, 403, { error: 'Developer access is required to send announcements.' });
                return;
            }
            if (request.method !== 'POST') {
                sendJson(response, 405, { error: 'Method not allowed.' });
                return;
            }
            try {
                const body = await readJson(request);
                const title = typeof body.title === 'string' ? body.title.trim() : '';
                const content = typeof body.body === 'string' ? body.body.trim() : '';
                const category = body.category || 'update';
                if (!title || title.length > MAX_ANNOUNCEMENT_TITLE_LENGTH
                    || !content || content.length > MAX_ANNOUNCEMENT_BODY_LENGTH
                    || !ANNOUNCEMENT_CATEGORIES.has(category)) {
                    sendJson(response, 400, {
                        error: 'Enter an announcement title and message, and choose a valid announcement category.'
                    });
                    return;
                }
                let announcement;
                try {
                    announcement = await withAuthLock(state, async () => {
                        const previousAnnouncements = [...state.announcements];
                        const previousNextId = state.nextAnnouncementId;
                        const id = Math.max(state.nextAnnouncementId, Date.now() * 1000);
                        announcement = {
                            id,
                            title,
                            body: content,
                            category,
                            author: signedInAccount.username,
                            createdAt: new Date().toISOString()
                        };
                        state.nextAnnouncementId = id + 1;
                        state.announcements.push(announcement);
                        if (state.announcements.length > MAX_ANNOUNCEMENTS) {
                            state.announcements.splice(0, state.announcements.length - MAX_ANNOUNCEMENTS);
                        }
                        try {
                            await saveAnnouncements(state);
                        } catch (error) {
                            state.announcements = previousAnnouncements;
                            state.nextAnnouncementId = previousNextId;
                            throw error;
                        }
                        return announcement;
                    });
                } catch (error) {
                    console.error(`Could not save developer announcement: ${error.message}`);
                    error.statusCode = 500;
                    error.message = 'The announcement could not be saved. Please try again.';
                    throw error;
                }
                sendJson(response, 201, { announcement });
            } catch (error) {
                sendJson(response, error.statusCode || 400, { error: error.message });
            }
            return;
        }

        const isStaffRoute = pathname.startsWith('/api/staff/');
        if (pathname.startsWith('/api/admin/') || isStaffRoute) {
            if (isStaffRoute
                ? !['admin', 'moderator'].includes(signedInAccount.role)
                : !['owner', 'developer'].includes(signedInAccount.role)) {
                sendJson(response, 403, {
                    error: isStaffRoute
                        ? 'Admin or moderator access is required for staff actions.'
                        : 'Owner access is required for developer tools.'
                });
                return;
            }
            const accountsPath = isStaffRoute ? '/api/staff/members' : '/api/admin/accounts';
            const accountPathPrefix = `${accountsPath}/`;
            if (request.method === 'GET' && pathname === accountsPath) {
                const accounts = [...state.accounts.values()]
                    .filter(account => !isStaffRoute || (
                        !account.banned
                        && ROLE_ORDER[account.role] > ROLE_ORDER[signedInAccount.role]
                    ))
                    .map(isStaffRoute ? staffAccount : adminAccount)
                    .sort(compareMembersByRole);
                sendJson(response, 200, { accounts });
                return;
            }
            if (request.method === 'POST' && pathname.startsWith(accountPathPrefix)) {
                let username;
                try {
                    username = decodeURIComponent(pathname.slice(accountPathPrefix.length)).toLowerCase();
                } catch {
                    sendJson(response, 400, { error: 'Invalid account name.' });
                    return;
                }
                const target = state.accounts.get(username);
                if (!target) {
                    sendJson(response, 404, { error: 'Account not found.' });
                    return;
                }
                try {
                    const body = await readJson(request);
                    const action = body.action;
                    if (isStaffRoute && !['admin', 'moderator'].includes(signedInAccount.role)) {
                        sendJson(response, 403, { error: 'Staff access is required.' });
                        return;
                    }
                    if (isStaffRoute && ROLE_ORDER[target.role] <= ROLE_ORDER[signedInAccount.role]) {
                        sendJson(response, 403, { error: 'Staff can only take action on accounts with a lower rank.' });
                        return;
                    }
                    const staffPermissions = {
                        moderator: new Set(['warn', 'mute', 'unmute']),
                        admin: new Set(['warn', 'mute', 'unmute', 'ghost', 'unghost', 'timeout', 'untimeout'])
                    };
                    if (isStaffRoute && !staffPermissions[signedInAccount.role].has(action)) {
                        sendJson(response, 403, { error: 'Your staff role cannot perform that action.' });
                        return;
                    }
                    const previous = { ...target, warnings: [...target.warnings] };
                    if (action === 'role') {
                        const cannotChangeTargetRole = target.role === 'developer'
                            || target.role === 'owner' && signedInAccount.role !== 'developer';
                        if (!['member', 'moderator', 'admin', 'owner'].includes(body.role) || cannotChangeTargetRole) {
                            sendJson(response, 400, { error: 'That account rank cannot be changed by your role.' });
                            return;
                        }
                        target.role = body.role;
                    } else if (action === 'profile') {
                        const bio = typeof body.bio === 'string' ? body.bio.trim() : null;
                        const avatar = body.avatar === undefined ? (target.avatar ?? null) : body.avatar === null ? null : body.avatar;
                        const music = body.music === undefined ? (target.music ?? null) : body.music === null ? null : body.music;
                        const status = body.status ?? target.status;
                        const banner = body.banner === undefined ? (target.banner ?? null) : body.banner === null ? null : body.banner;
                        const decoration = body.decoration ?? target.decoration ?? 'none';
                        const profileEffect = body.profileEffect ?? target.profileEffect ?? 'none';
                        if (bio === null || bio.length > MAX_BIO_LENGTH
                            || (avatar !== null && !validAvatar(avatar))
                            || (music !== null && !validMusic(music))
                            || !PROFILE_STATUSES.has(status)
                            || (banner !== null && !validProfileImage(banner, MAX_BANNER_BYTES))
                            || !PROFILE_DECORATIONS.has(decoration)
                            || !PROFILE_EFFECTS.has(profileEffect)) {
                            sendJson(response, 400, { error: 'Profile details are invalid.' });
                            return;
                        }
                        if (body.decorationImage !== undefined && body.decorationImage !== null) {
                            sendJson(response, 400, { error: 'Custom avatar decorations are not supported. Choose a preset instead.' });
                            return;
                        }
                        Object.assign(target, { bio, avatar, music, status, banner, decoration, profileEffect });
                    } else if (action === 'mute' || action === 'ghost' || action === 'timeout') {
                        const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
                        const minutes = Number(body.minutes);
                        const channel = CHANNELS.find(item => item.id === body.channel);
                        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080
                            || reason.length < 3 || reason.length > 240 || !channel) {
                            sendJson(response, 400, { error: 'Choose a duration from 1 minute to 7 days, enter a reason of 3–240 characters, and select a valid channel.' });
                            return;
                        }
                        const until = Date.now() + minutes * 60000;
                        if (action === 'mute') {
                            target.muteUntil = until;
                        } else if (action === 'ghost') {
                            target.ghosted = true;
                            target.ghostedUntil = until;
                        } else {
                            target.muted = false;
                            target.mutedUntil = until;
                        }
                    } else if (action === 'unmute') {
                        target.muted = false;
                        target.muteUntil = null;
                    } else if (action === 'untimeout') {
                        target.mutedUntil = null;
                    } else if (action === 'warn') {
                        const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 240) : '';
                        if (reason.length < 3) {
                            sendJson(response, 400, { error: 'Add a warning reason of at least 3 characters.' });
                            return;
                        }
                        target.warnings.push({ reason, by: signedInAccount.username, createdAt: new Date().toISOString() });
                        target.warnings = target.warnings.slice(-50);
                    } else if (action === 'ban' || action === 'unban') {
                        if (target.role === 'developer'
                            || target.role === 'owner' && signedInAccount.role !== 'developer') {
                            sendJson(response, 400, { error: 'That account cannot be banned by your role.' });
                            return;
                        }
                        target.banned = action === 'ban';
                    } else if (action === 'unghost') {
                        target.ghosted = false;
                        target.ghostedUntil = null;
                    } else {
                        sendJson(response, 400, { error: 'Unknown developer action.' });
                        return;
                    }
                    const result = await withAuthLock(state, async () => {
                        try {
                            await saveAccounts(state, userStorePath);
                            return true;
                        } catch (error) {
                            Object.assign(target, previous);
                            console.error(`Could not save developer action: ${error.message}`);
                            return false;
                        }
                    });
                    if (!result) {
                        sendJson(response, 500, { error: 'The change could not be saved. Please try again.' });
                        return;
                    }
                    if (action === 'ban') {
                        for (const [id, activeSession] of state.sessions) {
                            if (activeSession.userId === target.username.toLowerCase()) state.sessions.delete(id);
                        }
                    }
                    if (action === 'mute' || action === 'ghost' || action === 'timeout') {
                        const minutes = Number(body.minutes);
                        const duration = minutes % 1440 === 0
                            ? `${minutes / 1440} day${minutes === 1440 ? '' : 's'}`
                            : minutes % 60 === 0
                                ? `${minutes / 60} hour${minutes === 60 ? '' : 's'}`
                                : `${minutes} minute${minutes === 1 ? '' : 's'}`;
                        const actionText = action === 'timeout' ? 'timed out' : action === 'ghost' ? 'ghosted' : 'muted';
                        const channelMessages = state.messages.get(body.channel);
                        const previousMessages = [...channelMessages];
                        const previousNextMessageId = state.nextMessageId;
                        const previousRevision = state.messageRevisions.get(body.channel);
                        const message = createMessage(
                            state,
                            body.channel,
                            'System',
                            `${target.username} was ${actionText} for ${duration}. Reason: ${body.reason.trim()}`,
                            'system'
                        );
                        try {
                            await saveMessages(state);
                        } catch (error) {
                            channelMessages.splice(0, channelMessages.length, ...previousMessages);
                            state.nextMessageId = previousNextMessageId;
                            state.messageRevisions.set(body.channel, previousRevision);
                            throw error;
                        }
                        sendJson(response, 200, {
                            account: isStaffRoute ? staffAccount(target) : adminAccount(target),
                            message
                        });
                        return;
                    }
                    sendJson(response, 200, {
                        account: isStaffRoute ? staffAccount(target) : adminAccount(target)
                    });
                } catch (error) {
                    sendJson(response, error.statusCode || 400, { error: error.message });
                }
                return;
            }
            sendJson(response, 404, { error: 'Developer tool not found.' });
            return;
        }

        if (request.method === 'GET' && pathname === '/api/profile/me') {
            const account = state.accounts.get(session.userId);
            if (!account) {
                sendJson(response, 401, { error: 'Your account could not be found. Please sign in again.' });
                return;
            }
            sendJson(response, 200, { profile: publicProfile(account) });
            return;
        }

        if (pathname === '/api/onboarding/me') {
            const account = state.accounts.get(session.userId);
            if (!account) {
                sendJson(response, 401, { error: 'Your account could not be found. Please sign in again.' });
                return;
            }
            if (request.method === 'GET') {
                sendJson(response, 200, { onboarding: account.onboarding });
                return;
            }
            if (request.method !== 'PUT') {
                sendJson(response, 405, { error: 'Method not allowed.' });
                return;
            }
            try {
                const body = await readJson(request);
                const onboarding = {
                    ...account.onboarding,
                    ...(body.completed === undefined ? {} : { completed: body.completed }),
                    ...(body.steps === undefined ? {} : { steps: body.steps }),
                    ...(body.interests === undefined ? {} : { interests: body.interests }),
                    ...(body.notifications === undefined ? {} : { notifications: body.notifications })
                };
                if (!validOnboarding(onboarding)) {
                    sendJson(response, 400, { error: 'Onboarding progress or preferences are invalid.' });
                    return;
                }
                const result = await withAuthLock(state, async () => {
                    const previous = account.onboarding;
                    account.onboarding = onboarding;
                    try {
                        await saveAccounts(state, userStorePath);
                        return { onboarding };
                    } catch (error) {
                        account.onboarding = previous;
                        console.error(`Could not save onboarding progress: ${error.message}`);
                        return { error: 'Your onboarding progress could not be saved. Please try again.' };
                    }
                });
                if (result.error) {
                    sendJson(response, 500, { error: result.error });
                    return;
                }
                sendJson(response, 200, result);
            } catch (error) {
                sendJson(response, error.statusCode || 400, { error: error.message });
            }
            return;
        }

        if (request.method === 'GET' && pathname.startsWith('/api/profile/')) {
            let username;
            try {
                username = decodeURIComponent(pathname.slice('/api/profile/'.length)).toLowerCase();
            } catch {
                sendJson(response, 400, { error: 'Invalid profile name.' });
                return;
            }
            const account = state.accounts.get(username);
            if (!account) {
                sendJson(response, 404, { error: 'Profile not found.' });
                return;
            }
            sendJson(response, 200, { profile: publicProfile(account) });
            return;
        }

        if (request.method === 'PUT' && pathname === '/api/profile/me') {
            try {
                const body = await readJson(request);
                const account = state.accounts.get(session.userId);
                if (!account) {
                    sendJson(response, 401, { error: 'Your account could not be found. Please sign in again.' });
                    return;
                }
                const bio = typeof body.bio === 'string' ? body.bio.trim() : null;
                const avatar = body.avatar === undefined ? (account.avatar ?? null) : body.avatar === null ? null : body.avatar;
                const music = body.music === undefined ? (account.music ?? null) : body.music === null ? null : body.music;
                const status = body.status ?? account.status;
                const banner = body.banner === undefined ? (account.banner ?? null) : body.banner === null ? null : body.banner;
                const decoration = body.decoration ?? account.decoration ?? 'none';
                const profileEffect = body.profileEffect ?? account.profileEffect ?? 'none';
                if (bio === null || bio.length > MAX_BIO_LENGTH) {
                    sendJson(response, 400, { error: `Bio must be no more than ${MAX_BIO_LENGTH} characters.` });
                    return;
                }
                if (avatar !== null && !validAvatar(avatar)) {
                    sendJson(response, 400, { error: 'Profile picture must be a PNG, JPEG, or WebP image up to 256 KB.' });
                    return;
                }
                if (music !== null && !validMusic(music)) {
                    sendJson(response, 400, { error: 'Profile music must be an audio file up to 6 MB.' });
                    return;
                }
                if (!PROFILE_STATUSES.has(status)) {
                    sendJson(response, 400, { error: 'Choose online, away, or busy status.' });
                    return;
                }
                if (banner !== null && !validProfileImage(banner, MAX_BANNER_BYTES)) {
                    sendJson(response, 400, { error: 'Profile banner must be a PNG, JPEG, or WebP image up to 512 KB.' });
                    return;
                }
                if (!PROFILE_DECORATIONS.has(decoration)) {
                    sendJson(response, 400, { error: 'Choose a supported profile decoration.' });
                    return;
                }
                if (body.decorationImage !== undefined && body.decorationImage !== null) {
                    sendJson(response, 400, { error: 'Custom avatar decorations are not supported. Choose a preset instead.' });
                    return;
                }
                if (!PROFILE_EFFECTS.has(profileEffect)) {
                    sendJson(response, 400, { error: 'Choose a supported profile effect.' });
                    return;
                }
                const result = await withAuthLock(state, async () => {
                    const previous = {
                        bio: account.bio,
                        avatar: account.avatar,
                        music: account.music,
                        status: account.status,
                        banner: account.banner,
                        decoration: account.decoration,
                        profileEffect: account.profileEffect
                    };
                    account.bio = bio;
                    account.avatar = avatar;
                    account.music = music;
                    account.status = status;
                    account.banner = banner;
                    account.decoration = decoration;
                    account.profileEffect = profileEffect;
                    try {
                        await saveAccounts(state, userStorePath);
                        return { profile: publicProfile(account) };
                    } catch (error) {
                        Object.assign(account, previous);
                        console.error(`Could not save profile data: ${error.message}`);
                        return { error: 'Your profile could not be saved. Please try again.' };
                    }
                });
                if (result.error) {
                    sendJson(response, 500, { error: result.error });
                    return;
                }
                sendJson(response, 200, result);
            } catch (error) {
                sendJson(response, error.statusCode || 400, { error: error.message });
            }
            return;
        }

        if (request.method === 'GET' && pathname === '/api/channels') {
            const channels = [...CHANNELS, ...state.privateChannels.values()]
                .filter(channel => canAccessChannel(state, channel.id, session.userId))
                .map(channel => visibleChannel(state, channel, session.userId));
            sendJson(response, 200, { channels });
            return;
        }

        if (request.method === 'POST' && pathname === '/api/channels') {
            try {
                const body = await readJson(request);
                const name = typeof body.name === 'string' ? body.name.trim() : '';
                const topic = typeof body.topic === 'string' ? body.topic.trim() : '';
                if (!/^[A-Za-z0-9][A-Za-z0-9-]{1,31}$/.test(name)
                    || name.length > MAX_CHANNEL_NAME_LENGTH
                    || topic.length > MAX_CHANNEL_TOPIC_LENGTH) {
                    sendJson(response, 400, {
                        error: `Channel names must be 2–${MAX_CHANNEL_NAME_LENGTH} letters, numbers, or dashes; topics can be up to ${MAX_CHANNEL_TOPIC_LENGTH} characters.`
                    });
                    return;
                }
                const ownedChannels = [...state.privateChannels.values()]
                    .filter(channel => channel.owner === session.userId).length;
                if (state.privateChannels.size >= MAX_PRIVATE_CHANNELS
                    || ownedChannels >= MAX_PRIVATE_CHANNELS_PER_OWNER) {
                    sendJson(response, 429, { error: 'You have reached the private channel limit.' });
                    return;
                }
                const id = `private-${crypto.randomBytes(6).toString('hex')}`;
                const channel = {
                    id,
                    name,
                    topic,
                    owner: session.userId,
                    members: [session.userId],
                    inviteCode: crypto.randomBytes(12).toString('hex'),
                    createdAt: new Date().toISOString()
                };
                state.privateChannels.set(id, channel);
                state.messages.set(id, []);
                state.messageRevisions.set(id, 1);
                state.typing.set(id, new Map());
                try {
                    await saveMessages(state);
                } catch (error) {
                    state.privateChannels.delete(id);
                    state.messages.delete(id);
                    state.messageRevisions.delete(id);
                    state.typing.delete(id);
                    throw error;
                }
                sendJson(response, 201, {
                    channel: visibleChannel(state, channel, session.userId),
                    inviteCode: channel.inviteCode
                });
            } catch (error) {
                console.error(`Could not create private channel: ${error.message}`);
                sendJson(response, error.statusCode || 500, {
                    error: error.statusCode ? error.message : 'The private channel could not be saved.'
                });
            }
            return;
        }

        if (request.method === 'POST' && pathname === '/api/channels/join') {
            try {
                const body = await readJson(request);
                const inviteCode = typeof body.inviteCode === 'string' ? body.inviteCode.trim() : '';
                const channel = [...state.privateChannels.values()]
                    .find(item => item.inviteCode === inviteCode);
                if (!channel || !state.accounts.has(session.userId)) {
                    sendJson(response, 404, { error: 'That channel invite is invalid.' });
                    return;
                }
                if (!channel.members.includes(session.userId)) {
                    channel.members.push(session.userId);
                    try {
                        await saveMessages(state);
                    } catch (error) {
                        channel.members.pop();
                        throw error;
                    }
                }
                sendJson(response, 200, { channel: visibleChannel(state, channel, session.userId) });
            } catch (error) {
                console.error(`Could not join private channel: ${error.message}`);
                sendJson(response, error.statusCode || 500, {
                    error: error.statusCode ? error.message : 'The channel invite could not be used.'
                });
            }
            return;
        }

        const channelInviteMatch = pathname.match(/^\/api\/channels\/(private-[a-f0-9]{12})\/invite$/);
        if (request.method === 'POST' && channelInviteMatch) {
            const channel = state.privateChannels.get(channelInviteMatch[1]);
            if (!channel || channel.owner !== session.userId) {
                sendJson(response, 404, { error: 'Channel invite management is unavailable.' });
                return;
            }
            const previousInviteCode = channel.inviteCode;
            channel.inviteCode = crypto.randomBytes(12).toString('hex');
            try {
                await saveMessages(state);
            } catch (error) {
                channel.inviteCode = previousInviteCode;
                console.error(`Could not rotate channel invite: ${error.message}`);
                sendJson(response, 500, { error: 'The channel invite could not be saved.' });
                return;
            }
            sendJson(response, 200, { inviteCode: channel.inviteCode });
            return;
        }

        if (request.method === 'POST' && (pathname === '/api/polls' || pathname === '/api/events')) {
            try {
                const body = await readJson(request);
                const channel = getChannel(state, body.channel);
                if (!channel || !canAccessChannel(state, channel.id, session.userId)) {
                    sendJson(response, 404, { error: 'Channel not found.' });
                    return;
                }
                const account = state.accounts.get(session.userId);
                if (!STAFF_ROLES.has(account.role) && channel.owner !== session.userId) {
                    sendJson(response, 403, { error: 'Only channel owners and staff can start polls or events.' });
                    return;
                }
                if (accountIsMuted(account)) {
                    sendJson(response, 403, { error: account.muted ? 'Your account is muted.' : 'Your account is timed out.' });
                    return;
                }
                let message;
                const channelMessages = state.messages.get(channel.id);
                const previousMessages = [...channelMessages];
                const previousNextMessageId = state.nextMessageId;
                const previousRevision = state.messageRevisions.get(channel.id);
                if (pathname === '/api/polls') {
                    const question = typeof body.question === 'string' ? body.question.trim() : '';
                    const options = Array.isArray(body.options)
                        ? [...new Set(body.options.map(option => typeof option === 'string' ? option.trim() : ''))]
                            .filter(Boolean)
                        : [];
                    if (!question || question.length > MAX_MESSAGE_LENGTH
                        || options.length < 2 || options.length > MAX_POLL_OPTIONS
                        || options.some(option => option.length > 100)) {
                        sendJson(response, 400, {
                            error: `Polls need a question and 2–${MAX_POLL_OPTIONS} distinct options of up to 100 characters.`
                        });
                        return;
                    }
                    message = createMessage(state, channel.id, account.username, question, 'poll');
                    message.poll = { options: options.map(text => ({ text, votes: [] })), closed: false };
                } else {
                    const title = typeof body.title === 'string' ? body.title.trim() : '';
                    const details = typeof body.details === 'string' ? body.details.trim() : '';
                    const startsAt = typeof body.startsAt === 'string' ? Date.parse(body.startsAt) : NaN;
                    if (!title || title.length > 100 || details.length > MAX_MESSAGE_LENGTH
                        || !Number.isFinite(startsAt) || startsAt <= Date.now()
                        || startsAt > Date.now() + 366 * 24 * 60 * 60 * 1000) {
                        sendJson(response, 400, {
                            error: 'Events need a title, a future date within one year, and details of up to 1000 characters.'
                        });
                        return;
                    }
                    message = createMessage(state, channel.id, account.username, title, 'event');
                    message.event = { startsAt: new Date(startsAt).toISOString(), details };
                }
                try {
                    await saveMessages(state);
                    await markMessageCount(state, account);
                } catch (error) {
                    channelMessages.splice(0, channelMessages.length, ...previousMessages);
                    state.nextMessageId = previousNextMessageId;
                    state.messageRevisions.set(channel.id, previousRevision);
                    throw error;
                }
                sendJson(response, 201, { message });
            } catch (error) {
                console.error(`Could not create chat item: ${error.message}`);
                sendJson(response, error.statusCode || 500, {
                    error: error.statusCode ? error.message : 'The chat item could not be saved.'
                });
            }
            return;
        }

        const voteMatch = pathname.match(/^\/api\/messages\/(\d+)\/votes$/);
        if (request.method === 'POST' && voteMatch) {
            try {
                const body = await readJson(request);
                const channelId = typeof body.channel === 'string' ? body.channel : '';
                const message = getChannelMessage(state, channelId, Number(voteMatch[1]));
                if (!canAccessChannel(state, channelId, session.userId)
                    || !message || message.kind !== 'poll' || !message.poll || message.deleted
                    || isBlockedByViewer(state, session.userId, message)) {
                    sendJson(response, 404, { error: 'Poll not found.' });
                    return;
                }
                if (message.poll.closed || !Number.isSafeInteger(body.option)
                    || body.option < 0 || body.option >= message.poll.options.length) {
                    sendJson(response, 400, { error: 'Choose an available poll option.' });
                    return;
                }
                const username = state.accounts.get(session.userId).username;
                const previousVotes = message.poll.options.map(option => [...option.votes]);
                const previousRevision = message.revision;
                const previousChannelRevision = state.messageRevisions.get(channelId);
                for (const option of message.poll.options) {
                    option.votes = option.votes.filter(voter => voter.toLowerCase() !== username.toLowerCase());
                }
                message.poll.options[body.option].votes.push(username);
                touchMessage(state, message);
                try {
                    await saveMessages(state);
                } catch (error) {
                    message.poll.options.forEach((option, index) => {
                        option.votes = previousVotes[index];
                    });
                    message.revision = previousRevision;
                    state.messageRevisions.set(channelId, previousChannelRevision);
                    throw error;
                }
                sendJson(response, 200, { message });
            } catch (error) {
                console.error(`Could not save poll vote: ${error.message}`);
                sendJson(response, error.statusCode || 500, {
                    error: error.statusCode ? error.message : 'Your vote could not be saved.'
                });
            }
            return;
        }

        if (pathname === '/api/voice/config' && request.method === 'GET') {
            try {
                const servers = process.env.VOICE_ICE_SERVERS
                    ? JSON.parse(process.env.VOICE_ICE_SERVERS)
                    : DEFAULT_VOICE_ICE_SERVERS;
                if (!Array.isArray(servers) || servers.some(server =>
                    !server || typeof server !== 'object'
                    || !(typeof server.urls === 'string'
                        || Array.isArray(server.urls) && server.urls.every(url => typeof url === 'string'))
                )) {
                    throw new Error('VOICE_ICE_SERVERS must be a JSON array of ICE server objects.');
                }
                sendJson(response, 200, { iceServers: servers });
            } catch (error) {
                console.error(`Invalid voice ICE configuration: ${error.message}`);
                sendJson(response, 500, { error: 'Voice network configuration is invalid.' });
            }
            return;
        }

        if (pathname === '/api/voice/join' && request.method === 'POST') {
            try {
                const body = await readJson(request);
                const channel = getChannel(state, body.channel);
                if (!channel || !canAccessChannel(state, channel.id, session.userId)) {
                    sendJson(response, 404, { error: 'Channel not found.' });
                    return;
                }
                const now = Date.now();
                let room = state.voiceRooms.get(channel.id);
                if (!room) {
                    room = new Map();
                    state.voiceRooms.set(channel.id, room);
                }
                for (const [userId, participant] of room) {
                    if (now - participant.lastSeenAt > 30000) room.delete(userId);
                }
                if (!room.has(session.userId) && room.size >= MAX_VOICE_PARTICIPANTS) {
                    sendJson(response, 429, { error: `Voice chat is limited to ${MAX_VOICE_PARTICIPANTS} people per channel.` });
                    return;
                }
                room.set(session.userId, {
                    username: signedInAccount.username,
                    lastSeenAt: now
                });
                sendJson(response, 200, {
                    participants: [...room.entries()]
                        .filter(([userId]) => userId !== session.userId)
                        .map(([, participant]) => participant.username),
                    cursor: state.nextVoiceSignalId - 1
                });
            } catch (error) {
                sendJson(response, error.statusCode || 400, { error: error.message });
            }
            return;
        }

        if (pathname === '/api/voice' && request.method === 'GET') {
            const url = new URL(request.url || '/', 'http://localhost');
            const channelId = url.searchParams.get('channel') || '';
            const after = Number(url.searchParams.get('after') || 0);
            if (!canAccessChannel(state, channelId, session.userId)
                || !state.voiceRooms.get(channelId)?.has(session.userId)) {
                sendJson(response, 404, { error: 'You are not in this voice room.' });
                return;
            }
            if (!Number.isSafeInteger(after) || after < 0) {
                sendJson(response, 400, { error: 'Voice signal cursor is invalid.' });
                return;
            }
            const room = state.voiceRooms.get(channelId);
            const now = Date.now();
            for (const [userId, participant] of room) {
                if (now - participant.lastSeenAt > 30000) room.delete(userId);
            }
            room.get(session.userId).lastSeenAt = now;
            sendJson(response, 200, {
                participants: [...room.entries()]
                    .filter(([userId]) => userId !== session.userId)
                    .map(([, participant]) => participant.username),
                signals: state.voiceSignals.filter(signal =>
                    signal.channelId === channelId && signal.to === session.userId && signal.id > after
                )
            });
            return;
        }

        if (pathname === '/api/voice/leave' && request.method === 'POST') {
            try {
                const body = await readJson(request);
                const room = state.voiceRooms.get(body.channel);
                room?.delete(session.userId);
                state.voiceSignals = state.voiceSignals.filter(signal =>
                    signal.channelId !== body.channel
                    || (signal.to !== session.userId && signal.from !== session.userId)
                );
                if (room && !room.size) state.voiceRooms.delete(body.channel);
                sendJson(response, 200, { left: true });
            } catch (error) {
                sendJson(response, error.statusCode || 400, { error: error.message });
            }
            return;
        }

        if (pathname === '/api/voice/signal' && request.method === 'POST') {
            try {
                const body = await readJson(request);
                const room = state.voiceRooms.get(body.channel);
                const recipientId = cleanUsername(body.to).toLowerCase();
                const target = room?.get(recipientId);
                const validSignal = ['offer', 'answer', 'candidate'].includes(body.type)
                    && body.data && typeof body.data === 'object'
                    && JSON.stringify(body.data).length <= 32000
                    && (body.type === 'candidate'
                        ? typeof body.data.candidate === 'string' && body.data.candidate.length <= 4096
                        : typeof body.data.sdp === 'string' && body.data.sdp.length <= 30000);
                if (!room?.has(session.userId) || !canAccessChannel(state, body.channel, session.userId)
                    || !target || recipientId === session.userId || !validSignal) {
                    sendJson(response, 400, { error: 'That voice signal is invalid or its recipient left the room.' });
                    return;
                }
                const signal = {
                    id: state.nextVoiceSignalId++,
                    channelId: body.channel,
                    from: session.userId,
                    type: body.type,
                    data: body.data
                };
                state.voiceSignals.push({ ...signal, to: recipientId });
                if (state.voiceSignals.length > 1000) state.voiceSignals.splice(0, state.voiceSignals.length - 1000);
                sendJson(response, 201, { sent: true });
            } catch (error) {
                sendJson(response, error.statusCode || 400, { error: error.message });
            }
            return;
        }

        if (request.method === 'GET' && pathname === '/api/unread') {
            const channels = [...CHANNELS, ...state.privateChannels.values()]
                .filter(channel => canAccessChannel(state, channel.id, session.userId))
                .map(channel => {
                    const afterId = Number(signedInAccount.channelReadIds?.[channel.id] || 0);
                    const unread = (state.messages.get(channel.id) || [])
                        .filter(message => message.id > afterId && message.author.toLowerCase() !== session.userId
                            && !message.deleted
                            && (!message.recipientUserId || message.recipientUserId === session.userId)
                            && !isBlockedByViewer(state, session.userId, message));
                    const mentioned = unread.filter(message =>
                        extractMentionNames(message.content).has(session.userId));
                    return {
                        id: channel.id,
                        count: unread.length,
                        mentions: mentioned.length,
                        firstMessageId: unread[0]?.id || 0,
                        firstMentionId: mentioned[0]?.id || 0,
                        readId: afterId,
                        muted: signedInAccount.mutedChannels?.[channel.id] === true
                    };
                });
            sendJson(response, 200, { channels });
            return;
        }

        const channelReadMatch = pathname.match(/^\/api\/channels\/([a-z0-9-]+)\/read$/);
        if (request.method === 'POST' && channelReadMatch) {
            const channelId = channelReadMatch[1];
            if (!canAccessChannel(state, channelId, session.userId)) {
                sendJson(response, 404, { error: 'Channel not found.' });
                return;
            }
            try {
                const body = await readJson(request);
                const latestId = (state.messages.get(channelId) || []).at(-1)?.id || 0;
                const requestedId = body.id === undefined ? latestId : body.id;
                if (!Number.isSafeInteger(requestedId) || requestedId < 0 || requestedId > latestId) {
                    sendJson(response, 400, { error: 'Channel read position is invalid.' });
                    return;
                }
                const nextReadIds = {
                    ...(signedInAccount.channelReadIds || {}),
                    [channelId]: Math.max(
                        Number(signedInAccount.channelReadIds?.[channelId]) || 0,
                        requestedId
                    )
                };
                await updateAccountFields(state, signedInAccount, { channelReadIds: nextReadIds }, userStorePath);
                sendJson(response, 200, { readId: nextReadIds[channelId] });
            } catch (error) {
                console.error(`Could not save channel read position: ${error.message}`);
                sendJson(response, error.statusCode || 500, {
                    error: error.statusCode ? error.message : 'The channel read position could not be saved.'
                });
            }
            return;
        }

        if (request.method === 'PATCH' && pathname === '/api/preferences') {
            try {
                const body = await readJson(request);
                if (typeof body.channel !== 'string'
                    || !canAccessChannel(state, body.channel, session.userId)
                    || typeof body.muted !== 'boolean') {
                    sendJson(response, 400, { error: 'Choose a channel and a valid mute setting.' });
                    return;
                }
                const mutedChannels = { ...(signedInAccount.mutedChannels || {}), [body.channel]: body.muted };
                await updateAccountFields(state, signedInAccount, { mutedChannels }, userStorePath);
                sendJson(response, 200, { muted: body.muted });
            } catch (error) {
                console.error(`Could not save notification preferences: ${error.message}`);
                sendJson(response, error.statusCode || 500, {
                    error: error.statusCode ? error.message : 'Your notification preference could not be saved.'
                });
            }
            return;
        }

        if (request.method === 'GET' && pathname === '/api/blocks') {
            sendJson(response, 200, { users: signedInAccount.blockedUsers || [] });
            return;
        }

        if (request.method === 'POST' && pathname === '/api/blocks') {
            try {
                const body = await readJson(request);
                const username = cleanUsername(body.username).toLowerCase();
                const target = state.accounts.get(username);
                if (!target || username === session.userId || typeof body.block !== 'boolean') {
                    sendJson(response, 400, { error: 'Choose another valid account and a block setting.' });
                    return;
                }
                const previous = signedInAccount.blockedUsers || [];
                const next = body.block
                    ? [...new Set([...previous, username])]
                    : previous.filter(item => item !== username);
                await updateAccountFields(state, signedInAccount, { blockedUsers: next }, userStorePath);
                sendJson(response, 200, { users: next });
            } catch (error) {
                console.error(`Could not save block list: ${error.message}`);
                sendJson(response, error.statusCode || 500, {
                    error: error.statusCode ? error.message : 'Your block list could not be saved.'
                });
            }
            return;
        }

        if (request.method === 'POST' && pathname === '/api/reports') {
            try {
                const body = await readJson(request);
                const channelId = typeof body.channel === 'string' ? body.channel : '';
                const messageId = Number(body.messageId);
                const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
                const message = getChannelMessage(state, channelId, messageId);
                if (!canAccessChannel(state, channelId, session.userId) || !message || message.deleted
                    || message.author.toLowerCase() === session.userId
                    || reason.length < 3 || reason.length > MAX_REPORT_REASON_LENGTH) {
                    sendJson(response, 400, {
                        error: `Choose a message you did not write and give a reason of 3–${MAX_REPORT_REASON_LENGTH} characters.`
                    });
                    return;
                }
                const duplicate = state.reports.find(report => report.channelId === channelId
                    && report.messageId === messageId && report.reporter === session.userId
                    && report.status === 'open');
                if (duplicate) {
                    sendJson(response, 409, { error: 'You already reported this message.' });
                    return;
                }
                const previousReports = [...state.reports];
                if (state.reports.length >= MAX_REPORTS) {
                    const oldestClosed = state.reports.findIndex(item => item.status !== 'open');
                    if (oldestClosed < 0) {
                        sendJson(response, 429, { error: 'The staff report queue is full. Please try again later.' });
                        return;
                    }
                    state.reports.splice(oldestClosed, 1);
                }
                const report = {
                    id: state.reports.reduce((latest, item) => Math.max(latest, item.id), 0) + 1,
                    channelId,
                    messageId,
                    reporter: session.userId,
                    reason,
                    status: 'open',
                    createdAt: new Date().toISOString()
                };
                state.reports.push(report);
                try {
                    await saveMessages(state);
                } catch (error) {
                    state.reports.splice(0, state.reports.length, ...previousReports);
                    throw error;
                }
                sendJson(response, 201, { report });
            } catch (error) {
                console.error(`Could not save message report: ${error.message}`);
                sendJson(response, error.statusCode || 500, {
                    error: error.statusCode ? error.message : 'The report could not be saved.'
                });
            }
            return;
        }

        if (pathname === '/api/reports' && request.method === 'GET') {
            if (!['developer', 'owner', 'admin', 'moderator'].includes(signedInAccount.role)) {
                sendJson(response, 403, { error: 'Staff access is required to review reports.' });
                return;
            }
            sendJson(response, 200, {
                reports: state.reports.map(report => ({
                    ...report,
                    message: getChannelMessage(state, report.channelId, report.messageId) || null
                }))
            });
            return;
        }

        const reportMatch = pathname.match(/^\/api\/reports\/(\d+)$/);
        if (request.method === 'PATCH' && reportMatch) {
            if (!['developer', 'owner', 'admin', 'moderator'].includes(signedInAccount.role)) {
                sendJson(response, 403, { error: 'Staff access is required to review reports.' });
                return;
            }
            try {
                const body = await readJson(request);
                const report = state.reports.find(item => item.id === Number(reportMatch[1]));
                if (!report || !['resolved', 'dismissed', 'open'].includes(body.status)) {
                    sendJson(response, 400, { error: 'Choose a valid report and review status.' });
                    return;
                }
                const previous = { ...report };
                report.status = body.status;
                report.reviewedBy = session.userId;
                report.reviewedAt = new Date().toISOString();
                try {
                    await saveMessages(state);
                } catch (error) {
                    Object.assign(report, previous);
                    throw error;
                }
                sendJson(response, 200, { report });
            } catch (error) {
                console.error(`Could not update message report: ${error.message}`);
                sendJson(response, error.statusCode || 500, {
                    error: error.statusCode ? error.message : 'The report could not be updated.'
                });
            }
            return;
        }

        if (request.method === 'GET' && pathname === '/api/users') {
            const now = Date.now();
            for (const [id, current] of state.sessions) {
                if (now - current.lastSeenAt > SESSION_TTL_MS) state.sessions.delete(id);
            }
            const activeUserIds = new Set([...state.sessions.values()]
                .filter(current => now - current.lastSeenAt < 45000)
                .map(current => current.userId));
            const users = [...activeUserIds]
                .map(userId => state.accounts.get(userId))
                .filter(account => account && !account.banned && !accountIsGhosted(account))
                .map(memberDirectoryProfile)
                .sort(compareMembersByRole);
            const offlineUsers = [...state.accounts.values()]
                .filter(account => !activeUserIds.has(account.username.toLowerCase()) && !account.banned && !accountIsGhosted(account))
                .map(memberDirectoryProfile)
                .sort(compareMembersByRole);
            sendJson(response, 200, { users, offlineUsers });
            return;
        }

        if (request.method === 'GET' && pathname === '/api/typing') {
            const channelId = new URL(request.url || '/', 'http://localhost').searchParams.get('channel') || '';
            const channelTyping = state.typing.get(channelId);
            if (!channelTyping || !canAccessChannel(state, channelId, session.userId)) {
                sendJson(response, 404, { error: 'Channel not found.' });
                return;
            }
            const now = Date.now();
            for (const [userId, expiresAt] of channelTyping) {
                if (expiresAt <= now || userId === session.userId) channelTyping.delete(userId);
            }
            sendJson(response, 200, {
                users: [...channelTyping.keys()]
                    .filter(userId => !signedInAccount.blockedUsers.includes(userId))
                    .map(userId => state.accounts.get(userId)?.username)
                    .filter(Boolean)
            });
            return;
        }

        if (request.method === 'POST' && pathname === '/api/typing') {
            try {
                const body = await readJson(request);
                const channelTyping = state.typing.get(body.channel);
                if (!channelTyping || !canAccessChannel(state, body.channel, session.userId)
                    || typeof body.typing !== 'boolean') {
                    sendJson(response, 400, { error: 'Choose a valid channel and typing state.' });
                    return;
                }
                if (body.typing && !accountIsGhosted(state.accounts.get(session.userId))) {
                    channelTyping.set(session.userId, Date.now() + TYPING_TTL_MS);
                } else channelTyping.delete(session.userId);
                sendJson(response, 200, { typing: body.typing });
            } catch (error) {
                sendJson(response, error.statusCode || 400, { error: error.message });
            }
            return;
        }

        if (request.method === 'GET' && pathname === '/api/pins') {
            const channelId = new URL(request.url || '/', 'http://localhost').searchParams.get('channel') || '';
            if (!state.messages.has(channelId) || !canAccessChannel(state, channelId, session.userId)) {
                sendJson(response, 404, { error: 'Channel not found.' });
                return;
            }
            sendJson(response, 200, {
                messages: getVisibleChannelHistory(state, channelId, session.userId)
                    .filter(message => message.pinned)
            });
            return;
        }

        if (request.method === 'GET' && pathname === '/api/search') {
            const url = new URL(request.url || '/', 'http://localhost');
            const query = (url.searchParams.get('q') || '').trim().toLocaleLowerCase();
            const author = (url.searchParams.get('author') || '').trim().toLocaleLowerCase();
            const channelFilter = url.searchParams.get('channel') || '';
            if ((!query && !author) || query.length > 100 || author.length > 24
                || (channelFilter && !canAccessChannel(state, channelFilter, session.userId))) {
                sendJson(response, 400, { error: 'Enter a search term or username, and choose a valid channel.' });
                return;
            }
            const results = [...state.messages.entries()]
                .filter(([channelId]) => !channelFilter || channelId === channelFilter)
                .filter(([channelId]) => canAccessChannel(state, channelId, session.userId))
                .flatMap(([channelId]) => getVisibleChannelHistory(state, channelId, session.userId))
                .filter(message => !message.deleted
                    && (!query || `${message.content} ${message.image ? 'image' : ''}`.toLocaleLowerCase().includes(query))
                    && (!author || message.author.toLocaleLowerCase().includes(author)))
                .sort((a, b) => b.id - a.id)
                .slice(0, 50);
            sendJson(response, 200, { messages: results });
            return;
        }

        if (request.method === 'GET' && pathname === '/api/dms') {
            const conversations = [];
            for (const [key, messages] of state.directMessages) {
                const participants = key.split(':');
                if (!participants.includes(session.userId) || messages.length === 0) continue;
                const otherUserId = participants.find(userId => userId !== session.userId);
                const otherAccount = state.accounts.get(otherUserId);
                if (!otherAccount || otherAccount.banned || accountIsGhosted(otherAccount)
                    || signedInAccount.blockedUsers.includes(otherUserId)
                    || otherAccount.blockedUsers.includes(session.userId)) continue;
                const incoming = messages.filter(message => message.recipientId === session.userId).at(-1) || null;
                const latest = messages.at(-1);
                conversations.push({
                    username: otherAccount.username,
                    avatar: otherAccount.avatar,
                    status: otherAccount.status,
                    latestMessage: {
                        id: latest.id,
                        author: latest.author,
                        content: latest.content || (latest.image ? 'Image' : ''),
                        createdAt: latest.createdAt
                    },
                    latestIncomingMessageId: incoming?.id || 0
                });
            }
            conversations.sort((a, b) => b.latestMessage.id - a.latestMessage.id);
            sendJson(response, 200, { conversations });
            return;
        }

        if (request.method === 'GET' && pathname.startsWith('/api/dms/')) {
            let username;
            try {
                username = decodeURIComponent(pathname.slice('/api/dms/'.length)).toLowerCase();
            } catch {
                sendJson(response, 400, { error: 'Invalid direct message recipient.' });
                return;
            }
            const otherAccount = state.accounts.get(username);
            if (!otherAccount || otherAccount.banned || accountIsGhosted(otherAccount) || username === session.userId
                || signedInAccount.blockedUsers.includes(username)
                || otherAccount.blockedUsers.includes(session.userId)) {
                sendJson(response, 404, { error: 'That direct message conversation is unavailable.' });
                return;
            }
            const afterValue = Number(new URL(request.url || '/', 'http://localhost').searchParams.get('after') || 0);
            if (!Number.isSafeInteger(afterValue) || afterValue < 0) {
                sendJson(response, 400, { error: 'Invalid message cursor.' });
                return;
            }
            const messages = state.directMessages.get(directMessageKey(session.userId, username)) || [];
            sendJson(response, 200, {
                messages: afterValue > 0
                    ? messages.filter(message => message.id > afterValue).map(({ senderId, recipientId, ...message }) => message)
                    : messages.slice(-50).map(({ senderId, recipientId, ...message }) => message)
            });
            return;
        }

        if (request.method === 'POST' && pathname === '/api/dms') {
            try {
                const body = await readJson(request);
                const recipientName = cleanUsername(body.recipient);
                const recipientId = recipientName.toLowerCase();
                const recipient = state.accounts.get(recipientId);
                const content = typeof body.content === 'string' ? body.content.trim() : '';
                const image = body.image === undefined || body.image === null ? null : body.image;
                if (!recipient || recipient.banned || accountIsGhosted(recipient) || recipientId === session.userId
                    || signedInAccount.blockedUsers.includes(recipientId)
                    || recipient.blockedUsers.includes(session.userId)) {
                    sendJson(response, 404, { error: 'That direct message recipient is unavailable.' });
                    return;
                }
                if ((!content && !image) || content.length > MAX_MESSAGE_LENGTH) {
                    sendJson(response, 400, { error: `Messages must contain text or an image and no more than ${MAX_MESSAGE_LENGTH} characters.` });
                    return;
                }
                if (image !== null && !validChatImage(image)) {
                    sendJson(response, 400, { error: 'Chat images must be PNG, JPEG, or WebP files up to 4 MB.' });
                    return;
                }
                const currentAccount = state.accounts.get(session.userId);
                if (accountIsMuted(currentAccount)) {
                    sendJson(response, 403, { error: currentAccount.muted ? 'Your account is muted.' : 'Your account is timed out.' });
                    return;
                }
                const now = Date.now();
                if (now - (session.lastDirectMessageAt || 0) < 300) {
                    sendJson(response, 429, { error: 'Please wait a moment before sending another message.' });
                    return;
                }
                const key = directMessageKey(session.userId, recipientId);
                const conversation = state.directMessages.get(key) || [];
                const previousConversation = [...conversation];
                const previousNextDirectMessageId = state.nextDirectMessageId;
                const replyTo = messageReply(conversation, body.replyToId);
                if (replyTo === undefined) {
                    sendJson(response, 400, { error: 'The message you are replying to could not be found.' });
                    return;
                }
                session.lastDirectMessageAt = now;
                const message = {
                    id: state.nextDirectMessageId++,
                    author: currentAccount.username,
                    content,
                    image,
                    replyTo,
                    kind: 'user',
                    createdAt: new Date().toISOString(),
                    senderId: session.userId,
                    recipientId
                };
                conversation.push(message);
                if (conversation.length > MESSAGE_HISTORY_LIMIT) conversation.shift();
                state.directMessages.set(key, conversation);
                try {
                    await saveMessages(state);
                } catch (error) {
                    conversation.splice(0, conversation.length, ...previousConversation);
                    state.nextDirectMessageId = previousNextDirectMessageId;
                    throw error;
                }
                await markMessageCount(state, currentAccount);
                const { senderId, recipientId: messageRecipientId, ...visibleMessage } = message;
                sendJson(response, 201, { message: visibleMessage });
            } catch (error) {
                sendJson(response, error.statusCode || 400, { error: error.message });
            }
            return;
        }

        const threadMatch = pathname.match(/^\/api\/messages\/(\d+)\/thread$/);
        if (request.method === 'GET' && threadMatch) {
            const url = new URL(request.url || '/', 'http://localhost');
            const channelId = url.searchParams.get('channel') || '';
            if (!canAccessChannel(state, channelId, session.userId)) {
                sendJson(response, 404, { error: 'Message not found.' });
                return;
            }
            const messages = getVisibleChannelHistory(state, channelId, session.userId);
            const target = messages.find(message => message.id === Number(threadMatch[1]));
            if (!target) {
                sendJson(response, 404, { error: 'Message not found.' });
                return;
            }
            const root = target.replyTo?.id
                ? messages.find(message => message.id === target.replyTo.id) || target
                : target;
            sendJson(response, 200, {
                root,
                replies: messages.filter(message => message.replyTo?.id === root.id)
            });
            return;
        }

        const messageActionMatch = pathname.match(/^\/api\/messages\/(\d+)\/(reactions|pin)$/);
        if (request.method === 'POST' && messageActionMatch) {
            try {
                const body = await readJson(request);
                const channelId = typeof body.channel === 'string' ? body.channel : '';
                const message = getChannelMessage(state, channelId, Number(messageActionMatch[1]));
                if (!message || message.deleted || isBlockedByViewer(state, session.userId, message)) {
                    sendJson(response, 404, { error: 'Message not found.' });
                    return;
                }
                if (!canAccessChannel(state, channelId, session.userId)) {
                    sendJson(response, 404, { error: 'Message not found.' });
                    return;
                }
                if (message.recipientUserId && message.recipientUserId !== session.userId) {
                    sendJson(response, 404, { error: 'Message not found.' });
                    return;
                }
                const previous = {
                    reactions: (message.reactions || []).map(item => ({
                        ...item,
                        users: Array.isArray(item.users) ? [...item.users] : []
                    })),
                    pinned: message.pinned,
                    revision: message.revision,
                    channelRevision: state.messageRevisions.get(channelId)
                };
                if (messageActionMatch[2] === 'reactions') {
                    if (!REACTION_EMOJIS.has(body.emoji)) {
                        sendJson(response, 400, { error: 'Choose a supported reaction.' });
                        return;
                    }
                    let reaction = (message.reactions || []).find(item => item.emoji === body.emoji);
                    if (!reaction) {
                        reaction = { emoji: body.emoji, users: [] };
                        message.reactions = [...(message.reactions || []), reaction];
                    }
                    const username = state.accounts.get(session.userId).username;
                    const existingIndex = reaction.users.findIndex(user => user.toLowerCase() === username.toLowerCase());
                    if (existingIndex >= 0) reaction.users.splice(existingIndex, 1);
                    else reaction.users.push(username);
                    if (!reaction.users.length) {
                        message.reactions = message.reactions.filter(item => item !== reaction);
                    }
                } else {
                    const role = state.accounts.get(session.userId)?.role;
                    if (!['developer', 'owner', 'admin'].includes(role)) {
                        sendJson(response, 403, { error: 'Only administrators and above can pin messages.' });
                        return;
                    }
                    message.pinned = !message.pinned;
                }
                touchMessage(state, message);
                try {
                    await saveMessages(state);
                } catch (error) {
                    message.reactions = previous.reactions;
                    message.pinned = previous.pinned;
                    message.revision = previous.revision;
                    state.messageRevisions.set(channelId, previous.channelRevision);
                    throw error;
                }
                sendJson(response, 200, { message });
            } catch (error) {
                sendJson(response, error.statusCode || 400, { error: error.message });
            }
            return;
        }

        const messageMatch = pathname.match(/^\/api\/messages\/(\d+)$/);
        if (messageMatch && (request.method === 'PATCH' || request.method === 'DELETE')) {
            const channelId = new URL(request.url || '/', 'http://localhost').searchParams.get('channel') || '';
            const message = getChannelMessage(state, channelId, Number(messageMatch[1]));
            if (!canAccessChannel(state, channelId, session.userId)
                || !message || message.deleted || message.kind !== 'user'
                || isBlockedByViewer(state, session.userId, message)
                || (message.recipientUserId && message.recipientUserId !== session.userId)) {
                sendJson(response, 404, { error: 'Message not found.' });
                return;
            }
            const isAuthor = message.author.toLowerCase() === session.userId;
            if (!isAuthor && !canModerateMessage(state, state.accounts.get(session.userId), message)) {
                sendJson(response, 403, { error: 'You cannot change this message.' });
                return;
            }
            const previousMessage = {
                ...message,
                reactions: (message.reactions || []).map(item => ({
                    ...item,
                    users: Array.isArray(item.users) ? [...item.users] : []
                })),
                replyTo: message.replyTo ? { ...message.replyTo } : undefined
            };
            const previousRelated = [];
            const previousChannelRevision = state.messageRevisions.get(channelId);
            try {
                if (request.method === 'PATCH') {
                    if (!isAuthor) {
                        sendJson(response, 403, { error: 'Only the author can edit a message.' });
                        return;
                    }
                    const body = await readJson(request);
                    const content = typeof body.content === 'string' ? body.content.trim() : '';
                    if (!content || content.length > MAX_MESSAGE_LENGTH) {
                        sendJson(response, 400, { error: `Edited messages must contain text and no more than ${MAX_MESSAGE_LENGTH} characters.` });
                        return;
                    }
                    message.content = content;
                    message.editedAt = new Date().toISOString();
                } else {
                    message.deleted = true;
                    message.content = '';
                    message.image = null;
                    message.pinned = false;
                    message.reactions = [];
                    for (const related of state.messages.get(channelId) || []) {
                        if (related.replyTo?.id === message.id) {
                            previousRelated.push({
                                message: related,
                                replyTo: { ...related.replyTo },
                                revision: related.revision
                            });
                            related.replyTo = {
                                id: message.id,
                                author: message.author,
                                content: 'Message deleted',
                                image: false
                            };
                            touchMessage(state, related);
                        }
                    }
                }
                touchMessage(state, message);
                try {
                    await saveMessages(state);
                } catch (error) {
                    Object.assign(message, previousMessage);
                    for (const key of ['editedAt', 'deleted', 'image', 'pinned', 'replyTo']) {
                        if (previousMessage[key] === undefined) delete message[key];
                    }
                    for (const related of previousRelated) {
                        related.message.replyTo = related.replyTo;
                        related.message.revision = related.revision;
                    }
                    state.messageRevisions.set(channelId, previousChannelRevision);
                    throw error;
                }
                sendJson(response, 200, { message });
            } catch (error) {
                sendJson(response, error.statusCode || 400, { error: error.message });
            }
            return;
        }

        if (request.method === 'GET' && pathname === '/api/messages') {
            const url = new URL(request.url || '/', 'http://localhost');
            const channelId = url.searchParams.get('channel') || '';
            const channel = getChannel(state, channelId);
            if (!channel || !canAccessChannel(state, channelId, session.userId)) {
                sendJson(response, 404, { error: 'Channel not found.' });
                return;
            }
            const afterValue = Number(url.searchParams.get('after') || 0);
            const changesAfterParam = url.searchParams.get('changesAfter');
            const changesAfter = changesAfterParam === null ? null : Number(changesAfterParam);
            const beforeValue = Number(url.searchParams.get('before') || 0);
            const limit = Number(url.searchParams.get('limit') || 50);
            if (!Number.isSafeInteger(afterValue) || afterValue < 0
                || (changesAfter !== null && (!Number.isSafeInteger(changesAfter) || changesAfter < 0))
                || !Number.isSafeInteger(beforeValue) || beforeValue < 0
                || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
                || (afterValue > 0 && beforeValue > 0)) {
                sendJson(response, 400, { error: 'Invalid message cursor.' });
                return;
            }
            const allMessages = getVisibleChannelHistory(state, channel.id, session.userId);
            const messages = getVisibleMessages(state, channel.id, afterValue, session.userId, beforeValue, limit);
            if (afterValue > 0 && changesAfter !== null) {
                for (const message of getVisibleChannelHistory(state, channel.id, session.userId)) {
                    if (message.revision > changesAfter && !messages.some(item => item.id === message.id)) {
                        messages.push(message);
                    }
                }
                messages.sort((a, b) => a.id - b.id);
            }
            sendJson(response, 200, {
                messages,
                hasMore: beforeValue > 0
                    ? allMessages.some(message => message.id < (messages[0]?.id || beforeValue))
                    : afterValue === 0 && !beforeValue && allMessages.length > messages.length,
                revision: (state.messageRevisions.get(channel.id) || 1) - 1
            });
            return;
        }

        if (request.method === 'POST' && pathname === '/api/messages') {
            try {
                const body = await readJson(request);
                const channel = getChannel(state, body.channel);
                const content = typeof body.content === 'string' ? body.content.trim() : '';
                const image = body.image === undefined || body.image === null ? null : body.image;
                if (!channel || !canAccessChannel(state, body.channel, session.userId)) {
                    sendJson(response, 404, { error: 'Channel not found.' });
                    return;
                }
                if ((!content && !image) || content.length > MAX_MESSAGE_LENGTH) {
                    sendJson(response, 400, { error: `Messages must contain text or an image and no more than ${MAX_MESSAGE_LENGTH} characters.` });
                    return;
                }
                if (image !== null && !validChatImage(image)) {
                    sendJson(response, 400, { error: 'Chat images must be PNG, JPEG, or WebP files up to 4 MB.' });
                    return;
                }
                const currentAccount = state.accounts.get(session.userId);
                if (accountIsMuted(currentAccount)) {
                    sendJson(response, 403, { error: currentAccount.muted ? 'Your account is muted.' : 'Your account is timed out.' });
                    return;
                }
                const now = Date.now();
                if (now - (session.lastMessageAt || 0) < 300) {
                    sendJson(response, 429, { error: 'Please wait a moment before sending another message.' });
                    return;
                }
                const replyTo = messageReply(state.messages.get(channel.id), body.replyToId, session.userId);
                if (replyTo === undefined) {
                    sendJson(response, 400, { error: 'The message you are replying to could not be found.' });
                    return;
                }
                session.lastMessageAt = now;
                const channelMessages = state.messages.get(channel.id);
                const previousMessages = [...channelMessages];
                const previousNextMessageId = state.nextMessageId;
                const previousRevision = state.messageRevisions.get(channel.id);
                const message = createMessage(state, channel.id, session.name, content);
                message.image = image;
                message.replyTo = replyTo;
                await markMessageCount(state, currentAccount);
                if (accountIsGhosted(currentAccount)) message.recipientUserId = session.userId;
                try {
                    await saveMessages(state);
                } catch (error) {
                    channelMessages.splice(0, channelMessages.length, ...previousMessages);
                    state.nextMessageId = previousNextMessageId;
                    state.messageRevisions.set(channel.id, previousRevision);
                    throw error;
                }
                sendJson(response, 201, { message });
            } catch (error) {
                sendJson(response, error.statusCode || 400, { error: error.message });
            }
            return;
        }

        if (request.method === 'GET' && !pathname.startsWith('/api/')) {
            sendJson(response, 404, { error: 'Page not found.' });
            return;
        }

        sendJson(response, 405, { error: 'Method not allowed.' });
    });

    state.activityTimer = setInterval(() => {
        void persistActivity(state).catch(() => {});
    }, 30000);
    state.activityTimer.unref();
    server.once('close', () => {
        clearInterval(state.activityTimer);
    });

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
            server.removeListener('error', reject);
            resolve(server);
        });
    });
}

async function main() {
    const state = createChatState();
    const server = await createChatServer({ state });
    const address = server.address();
    const listeningHost = address && typeof address === 'object' ? address.address : resolveHost();
    const listeningPort = address && typeof address === 'object' ? address.port : resolvePort();
    console.log(`Orbit chat is listening on ${listeningHost}:${listeningPort}`);
    let shuttingDown = false;
    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.once(signal, () => {
            if (shuttingDown) return;
            shuttingDown = true;
            clearInterval(state.activityTimer);
            void persistActivity(state).catch(() => {}).finally(() => {
                server.close();
            });
        });
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

module.exports = {
    CHANNELS,
    getUserStorePath,
    createChatState,
    createMessage,
    getMessages,
    createChatServer
};
