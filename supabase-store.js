'use strict';

const { createClient } = require('@supabase/supabase-js');

const STATE_ID = 'main';

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

class SupabaseStore {
    constructor(adminClient) {
        this.adminClient = adminClient;
        this.saveQueue = Promise.resolve();
        this.snapshot = null;
    }

    async load() {
        const { data, error } = await this.adminClient
            .from('orbit_state')
            .select('data')
            .eq('id', STATE_ID)
            .maybeSingle();
        if (error) {
            throw new Error(`Could not load Supabase app data: ${error.message}`);
        }
        this.hasState = Boolean(data);
        this.snapshot = {
            accounts: [],
            announcements: [],
            messages: {},
            directMessages: {},
            privateChannels: [],
            reports: [],
            ...(data?.data || {})
        };
        return this.snapshot;
    }

    save(state) {
        const save = async () => {
            const snapshot = {
                accounts: [...state.accounts.values()].map(account => {
                    const { salt, passwordHash, ...profile } = account;
                    return profile;
                }),
                announcements: state.announcements,
                messages: Object.fromEntries(state.messages),
                directMessages: Object.fromEntries(state.directMessages),
                privateChannels: [...state.privateChannels.values()],
                reports: state.reports
            };
            const { error } = await this.adminClient
                .from('orbit_state')
                .upsert({ id: STATE_ID, data: snapshot }, { onConflict: 'id' });
            if (error) {
                throw new Error(`Could not save Supabase app data: ${error.message}`);
            }
            this.snapshot = snapshot;
        };
        const result = this.saveQueue.then(save);
        this.saveQueue = result.catch(() => {});
        return result;
    }
}

module.exports = { createSupabaseClients, SupabaseStore };
