'use strict';

const { createClient } = require('@supabase/supabase-js');

const LEGACY_ROW_ID = 'main';
const STORE_VERSION_ROW_ID = 'meta:partitioned-v1';
const UPSERT_BATCH_SIZE = 25;
const MAX_UPSERT_BATCH_BYTES = 512 * 1024;
const DELETE_BATCH_SIZE = 100;
const CHUNK_SIZE = 200 * 1024;
const CHUNK_SUFFIX = '#chunk#';
const ACCOUNT_MEDIA_FIELDS = ['avatar', 'banner', 'music'];
const PARTITION_PREFIXES = [
    'meta:',
    'account:',
    'accountMedia:',
    'accountActivity:',
    'announcement:',
    'privateChannel:',
    'report:',
    'message:',
    'directMessage:'
];

function createSupabaseClients(environment = process.env) {
    const url = environment.SUPABASE_URL;
    const publishableKey = environment.SUPABASE_PUBLISHABLE_KEY;
    const secretKey = environment.SUPABASE_SECRET_KEY;
    const configured = [url, publishableKey, secretKey].filter(Boolean).length;
    if (configured === 0) return null;
    if (configured !== 3) {
        throw new Error('Supabase requires SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, and SUPABASE_SECRET_KEY.');
    }

    const options = {
        auth: {
            autoRefreshToken: false,
            detectSessionInUrl: false,
            persistSession: false
        }
    };
    return {
        auth: createClient(url, publishableKey, options),
        admin: createClient(url, secretKey, options)
    };
}

function rowId(prefix, key, recordId = null) {
    return `${prefix}:${encodeURIComponent(key)}${recordId === null ? '' : `:${recordId}`}`;
}

function serializedRow(rows, id, data) {
    rows.set(id, JSON.stringify(data));
}

function chunkRows(id, serialized) {
    if (Buffer.byteLength(serialized) <= CHUNK_SIZE) {
        return [{ id, data: JSON.parse(serialized), serialized, logicalId: id }];
    }
    const chunks = [];
    for (let index = 0; index < serialized.length; index += CHUNK_SIZE) {
        chunks.push(serialized.slice(index, index + CHUNK_SIZE));
    }
    const rows = [{
        id,
        data: { __chunked: 1, chunks: chunks.length },
        serialized,
        logicalId: id
    }];
    chunks.forEach((chunk, index) => {
        const chunkId = `${id}${CHUNK_SUFFIX}${index}`;
        const data = { __chunk: 1, index, value: chunk };
        rows.push({
            id: chunkId,
            data,
            serialized: JSON.stringify(data),
            logicalId: id
        });
    });
    return rows;
}

function isChunkRowId(id) {
    return typeof id === 'string' && id.includes(CHUNK_SUFFIX);
}

function logicalRowId(id) {
    const index = id.indexOf(CHUNK_SUFFIX);
    return index === -1 ? id : id.slice(0, index);
}

function accountMediaId(key, field) {
    return `${rowId('accountMedia', key)}:${field}`;
}

function accountRows(accounts) {
    const rows = new Map();
    for (const [key, account] of accounts) {
        const {
            salt,
            passwordHash,
            messageCount,
            activeSeconds,
            avatar,
            banner,
            music,
            ...profile
        } = account;
        serializedRow(rows, rowId('account', key), profile);
        serializedRow(rows, rowId('accountActivity', key), { messageCount, activeSeconds });
        for (const [field, value] of Object.entries({ avatar, banner, music })) {
            if (value !== null && value !== undefined) {
                serializedRow(rows, accountMediaId(key, field), { value });
            }
        }
    }
    return rows;
}

function accountActivityRows(accounts) {
    const rows = new Map();
    for (const account of accounts) {
        serializedRow(rows, rowId('accountActivity', account.username.toLowerCase()), {
            messageCount: account.messageCount,
            activeSeconds: account.activeSeconds
        });
    }
    return rows;
}

function recordRows(prefix, records, getKey) {
    const rows = new Map();
    for (const record of records) {
        serializedRow(rows, rowId(prefix, getKey(record)), record);
    }
    return rows;
}

function messageRows(state) {
    const rows = new Map();
    for (const [channelId, messages] of state.messages) {
        for (const message of messages) {
            serializedRow(rows, rowId('message', channelId, message.id), message);
        }
    }
    for (const [key, messages] of state.directMessages) {
        for (const message of messages) {
            serializedRow(rows, rowId('directMessage', key, message.id), message);
        }
    }
    return rows;
}

function allRows(state) {
    const rows = new Map([[STORE_VERSION_ROW_ID, JSON.stringify({ version: 1 })]]);
    for (const [id, data] of accountRows(state.accounts)) rows.set(id, data);
    for (const [id, data] of recordRows('announcement', state.announcements, item => item.id)) rows.set(id, data);
    for (const [id, data] of recordRows('privateChannel', state.privateChannels.values(), item => item.id)) rows.set(id, data);
    for (const [id, data] of recordRows('report', state.reports, item => item.id)) rows.set(id, data);
    for (const [id, data] of messageRows(state)) rows.set(id, data);
    return rows;
}

function decodeKey(value) {
    try {
        return decodeURIComponent(value);
    } catch (error) {
        throw new Error(`Supabase app data contains an invalid row ID: ${error.message}`);
    }
}

function snapshotFromRows(rows) {
    const legacy = rows.find(row => row.id === LEGACY_ROW_ID)?.data || {};
    const snapshot = {
        accounts: Array.isArray(legacy.accounts) ? [...legacy.accounts] : [],
        announcements: Array.isArray(legacy.announcements) ? [...legacy.announcements] : [],
        messages: legacy.messages && typeof legacy.messages === 'object' ? { ...legacy.messages } : {},
        directMessages: legacy.directMessages && typeof legacy.directMessages === 'object'
            ? { ...legacy.directMessages }
            : {},
        privateChannels: Array.isArray(legacy.privateChannels) ? [...legacy.privateChannels] : [],
        reports: Array.isArray(legacy.reports) ? [...legacy.reports] : []
    };
    const accounts = new Map(snapshot.accounts.map(account => [account.username.toLowerCase(), account]));
    const accountActivity = new Map();
    const accountMedia = new Map();
    const announcements = new Map(snapshot.announcements.map(item => [item.id, item]));
    const privateChannels = new Map(snapshot.privateChannels.map(channel => [channel.id, channel]));
    const reports = new Map(snapshot.reports.map(report => [report.id, report]));
    const messages = new Map(Object.entries(snapshot.messages).map(([key, value]) => [key, new Map(value.map(message => [message.id, message]))]));
    const directMessages = new Map(Object.entries(snapshot.directMessages)
        .map(([key, value]) => [key, new Map(value.map(message => [message.id, message]))]));

    for (const row of rows) {
        if (row.id === LEGACY_ROW_ID || typeof row.id !== 'string') continue;
        const parts = row.id.split(':');
        const prefix = parts[0];
        if (prefix === 'account' && parts.length === 2) {
            accounts.set(row.data.username.toLowerCase(), row.data);
        } else if (prefix === 'accountMedia' && parts.length === 3) {
            const key = decodeKey(parts[1]);
            const field = parts[2];
            if (ACCOUNT_MEDIA_FIELDS.includes(field)) {
                const media = accountMedia.get(key) || {};
                media[field] = row.data?.value ?? null;
                accountMedia.set(key, media);
            }
        } else if (prefix === 'accountActivity' && parts.length === 2) {
            accountActivity.set(decodeKey(parts[1]), row.data);
        } else if (prefix === 'announcement' && parts.length === 2) {
            announcements.set(row.data.id, row.data);
        } else if (prefix === 'privateChannel' && parts.length === 2) {
            privateChannels.set(row.data.id, row.data);
        } else if (prefix === 'report' && parts.length === 2) {
            reports.set(row.data.id, row.data);
        } else if (prefix === 'message' && parts.length === 3) {
            const channelId = decodeKey(parts[1]);
            if (!messages.has(channelId)) messages.set(channelId, new Map());
            messages.get(channelId).set(row.data.id, row.data);
        } else if (prefix === 'directMessage' && parts.length === 3) {
            const key = decodeKey(parts[1]);
            if (!directMessages.has(key)) directMessages.set(key, new Map());
            directMessages.get(key).set(row.data.id, row.data);
        }
    }

    snapshot.accounts = [...accounts].map(([key, account]) => ({
        avatar: null,
        banner: null,
        music: null,
        ...account,
        ...(accountMedia.get(key) || {}),
        ...(accountActivity.get(key) || {})
    }));
    snapshot.announcements = [...announcements.values()];
    snapshot.privateChannels = [...privateChannels.values()];
    snapshot.reports = [...reports.values()];
    snapshot.messages = Object.fromEntries([...messages].map(([key, values]) => [
        key,
        [...values.values()].sort((a, b) => a.id - b.id)
    ]));
    snapshot.directMessages = Object.fromEntries([...directMessages].map(([key, values]) => [
        key,
        [...values.values()].sort((a, b) => a.id - b.id)
    ]));
    return snapshot;
}

class SupabaseStore {
    constructor(adminClient) {
        this.adminClient = adminClient;
        this.saveQueue = Promise.resolve();
        this.snapshot = null;
        this.rowCache = new Map();
        this.chunkCounts = new Map();
        this.legacyState = false;
    }

    async load() {
        const { data, error } = await this.adminClient
            .from('orbit_state')
            .select('id,data');
        if (error) {
            throw new Error(`Could not load Supabase app data: ${error.message}`);
        }
        const rows = data || [];
        this.hasState = rows.length > 0;
        this.legacyState = rows.some(row => row.id === LEGACY_ROW_ID);
        this.rowCache = new Map();
        this.chunkCounts = new Map();
        const chunkParts = new Map();
        const manifests = new Map();
        for (const row of rows) {
            if (row.id === LEGACY_ROW_ID || typeof row.id !== 'string') continue;
            if (isChunkRowId(row.id)) {
                const baseId = logicalRowId(row.id);
                const parts = chunkParts.get(baseId) || [];
                parts.push(row);
                chunkParts.set(baseId, parts);
                continue;
            }
            if (row.data?.__chunked === 1) {
                manifests.set(row.id, row.data);
                continue;
            }
            this.rowCache.set(row.id, JSON.stringify(row.data));
        }
        const assembledRows = rows.filter(row => row.id === LEGACY_ROW_ID || (
            typeof row.id === 'string' && !isChunkRowId(row.id) && row.data?.__chunked !== 1
        ));
        for (const [id, manifest] of manifests) {
            const parts = (chunkParts.get(id) || [])
                .filter(part => part.data?.__chunk === 1)
                .sort((a, b) => a.data.index - b.data.index);
            if (parts.length !== manifest.chunks) {
                throw new Error(`Could not load Supabase app data: missing chunked row ${id}.`);
            }
            const serialized = parts.map(part => part.data.value).join('');
            this.rowCache.set(id, serialized);
            this.chunkCounts.set(id, manifest.chunks);
            assembledRows.push({ id, data: JSON.parse(serialized) });
        }
        this.snapshot = snapshotFromRows(assembledRows);
        return this.snapshot;
    }

    save(state) {
        const rows = allRows(state);
        const prefixes = PARTITION_PREFIXES;
        return this.enqueue(() => this.writeRows(rows, {
            removeMissingPrefixes: prefixes,
            removeLegacy: true
        }));
    }

    saveAccounts(state) {
        return this.enqueue(() => this.writeRows(accountRows(state.accounts), {
            removeMissingPrefixes: ['account:', 'accountMedia:']
        }));
    }

    saveAccountActivity(accounts) {
        return this.enqueue(() => this.writeRows(accountActivityRows(accounts)));
    }

    saveAnnouncements(state) {
        return this.savePrefix(recordRows('announcement', state.announcements, item => item.id), 'announcement:');
    }

    saveMessages(state, changes) {
        const rows = new Map();
        const removedIds = [];
        if (changes.channels) {
            for (const channelId of changes.channels) {
                for (const message of state.messages.get(channelId) || []) {
                    serializedRow(rows, rowId('message', channelId, message.id), message);
                }
            }
        }
        for (const message of changes.messages || []) {
            serializedRow(rows, rowId('message', message.channelId, message.id), message);
        }
        for (const { key, message } of changes.directMessages || []) {
            serializedRow(rows, rowId('directMessage', key, message.id), message);
        }
        for (const { channelId, id } of changes.removedMessages || []) {
            removedIds.push(rowId('message', channelId, id));
        }
        for (const { key, id } of changes.removedDirectMessages || []) {
            removedIds.push(rowId('directMessage', key, id));
        }
        if (changes.privateChannels) {
            for (const channel of changes.privateChannels) {
                serializedRow(rows, rowId('privateChannel', channel.id), channel);
            }
        }
        if (changes.reports) {
            for (const report of state.reports) {
                serializedRow(rows, rowId('report', report.id), report);
            }
        }
        return this.enqueue(() => this.writeRows(rows, {
            removeMissingPrefixes: [
                ...(changes.channels ? changes.channels.map(channelId => `message:${encodeURIComponent(channelId)}:`) : []),
                ...(changes.reports ? ['report:'] : [])
            ],
            removedIds
        }));
    }

    savePrefix(rows, prefix) {
        return this.enqueue(() => this.writeRows(rows, { removeMissingPrefixes: [prefix] }));
    }

    enqueue(operation) {
        const result = this.saveQueue.then(operation);
        this.saveQueue = result.catch(() => {});
        return result;
    }

    async writeRows(rows, { removeMissingPrefixes = [], removedIds = [], removeLegacy = false } = {}) {
        const staleLogicalIds = [...this.rowCache.keys()].filter(id =>
            removeMissingPrefixes.some(prefix => id.startsWith(prefix) && !rows.has(id))
        );
        const deleteLogicalIds = [...new Set([...removedIds.map(logicalRowId), ...staleLogicalIds])];

        const changedLogicalRows = [...rows]
            .filter(([id, serialized]) => this.rowCache.get(id) !== serialized);

        const physicalUpserts = [];
        const staleChunkIds = [];
        for (const [id, serialized] of changedLogicalRows) {
            const physical = chunkRows(id, serialized);
            physicalUpserts.push(...physical);
            const nextChunkCount = physical[0].data?.__chunked === 1 ? physical[0].data.chunks : 0;
            const previousChunkCount = this.chunkCounts.get(id) || 0;
            for (let index = nextChunkCount; index < previousChunkCount; index += 1) {
                staleChunkIds.push(`${id}${CHUNK_SUFFIX}${index}`);
            }
        }

        let batch = [];
        let batchBytes = 0;
        const saveBatch = async () => {
            if (!batch.length) return;
            const { error } = await this.adminClient
                .from('orbit_state')
                .upsert(batch.map(({ id, data }) => ({ id, data })), { onConflict: 'id' });
            if (error) {
                throw new Error(`Could not save Supabase app data: ${error.message}`);
            }
            batch = [];
            batchBytes = 0;
        };
        for (const row of physicalUpserts) {
            const rowBytes = Buffer.byteLength(row.serialized);
            if (batch.length && (batch.length >= UPSERT_BATCH_SIZE
                || batchBytes + rowBytes > MAX_UPSERT_BATCH_BYTES)) {
                await saveBatch();
            }
            batch.push(row);
            batchBytes += rowBytes;
        }
        await saveBatch();

        for (const [id, serialized] of changedLogicalRows) {
            this.rowCache.set(id, serialized);
            const physical = chunkRows(id, serialized);
            const nextChunkCount = physical[0].data?.__chunked === 1 ? physical[0].data.chunks : 0;
            if (nextChunkCount > 0) this.chunkCounts.set(id, nextChunkCount);
            else this.chunkCounts.delete(id);
        }

        const deleteIds = [...staleChunkIds];
        for (const id of deleteLogicalIds) {
            deleteIds.push(id);
            const chunkCount = this.chunkCounts.get(id) || 0;
            for (let index = 0; index < chunkCount; index += 1) {
                deleteIds.push(`${id}${CHUNK_SUFFIX}${index}`);
            }
        }
        if (removeLegacy && this.legacyState) deleteIds.push(LEGACY_ROW_ID);

        const uniqueDeleteIds = [...new Set(deleteIds)];
        for (let index = 0; index < uniqueDeleteIds.length; index += DELETE_BATCH_SIZE) {
            const deleteBatch = uniqueDeleteIds.slice(index, index + DELETE_BATCH_SIZE);
            const { error } = await this.adminClient
                .from('orbit_state')
                .delete()
                .in('id', deleteBatch);
            if (error) {
                throw new Error(`Could not clean up Supabase app data: ${error.message}`);
            }
            for (const id of deleteBatch) {
                const logicalId = logicalRowId(id);
                if (logicalId === id) {
                    this.rowCache.delete(id);
                    this.chunkCounts.delete(id);
                }
                if (id === LEGACY_ROW_ID) this.legacyState = false;
            }
        }
    }
}

module.exports = { createSupabaseClients, SupabaseStore };
