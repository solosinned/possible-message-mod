const readline = require('node:readline');

const SITE_URL = 'https://pencilpractice.website/';
const OPENAI_MODERATION_URL = 'https://api.openai.com/v1/moderations';
const OPENAI_MODERATION_MODEL = 'omni-moderation-latest';
const ADMIN_USERNAME = process.env.BOT_ADMIN_USERNAME || 'solo';
const MAX_MESSAGE_LENGTH = 260;

function isNoiseLine(line) {
    return /^\d{1,2}\/\d{1,2}(?:\s+\d{1,2}:\d{2})?$/.test(line)
        || /^\d{1,2}:\d{2}$/.test(line)
        || /^(online|offline)$/i.test(line);
}

function cleanUsername(value) {
    const username = value.normalize('NFKC')
        .replace(/^[^\p{L}\p{N}@]+/u, '')
        .replace(/^@+/, '')
        .replace(/[^\p{L}\p{M}\p{N}_.-]/gu, '')
        .replace(/\d{7,}$/, '')
        .slice(0, 32);
    return !username || /^\d+$/.test(username) || /^(everyone|here)$/i.test(username) ? '' : username;
}

function parseObservedMessage(text) {
    const lines = String(text).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const usefulLines = lines.filter(line => !isNoiseLine(line) && !/^\d{7,}$/.test(line));
    if (usefulLines.length < 2) return null;

    const username = cleanUsername(usefulLines[0]);
    const content = usefulLines.slice(1).join(' ').trim();
    if (!username || !content || /^\d+$/.test(username)) return null;
    return { username, content };
}

function detectSelfHarmPromotion(text) {
    const normalized = String(text).normalize('NFKC').toLowerCase()
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        .replace(/[0]/g, 'o').replace(/[1!|]/g, 'i').replace(/[3]/g, 'e')
        .replace(/[4@]/g, 'a').replace(/[5$]/g, 's')
        .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

    if (/\bk(?:\s*y)?\s*s\b|\bkys\b/.test(normalized)) return 'telling someone to kill themselves (KYS)';
    if (/\b(?:kill|end)\s+(?:your\s+self|yourself|ur\s+self|urself)\b|\bend\s+your\s+life\b/.test(normalized)) {
        return 'telling someone to kill themselves';
    }
    if (/\b(?:cut|harm|hurt)\s+(?:your\s+self|yourself|ur\s+self|urself)\b/.test(normalized)) {
        return 'telling someone to self-harm';
    }
    if (/\bhang\s+(?:your\s+self|yourself|ur\s+self|urself)\b/.test(normalized)) return 'telling someone to hang themselves';
    if (/\bjump\s+off\s+(?:a\s+)?(?:bridge|roof|cliff|building)\b|\b(?:you\s+should|go)\s+jump\b/.test(normalized)) {
        return 'telling someone to jump to their death';
    }
    if (/\b(?:you\s+should|you\s+need\s+to|go)\s+(?:kill|cut|hang)\s+(?:your\s+self|yourself|ur\s+self|urself)\b/.test(normalized)) {
        return 'encouraging self-harm';
    }
    return null;
}

async function moderateMessage(text, apiKey = process.env.OPENAI_API_KEY, fetchImpl = globalThis.fetch) {
    if (!apiKey) throw new Error('Set OPENAI_API_KEY to enable AI moderation.');
    if (typeof fetchImpl !== 'function') throw new Error('This Node.js version does not provide fetch.');

    const response = await fetchImpl(OPENAI_MODERATION_URL, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ model: OPENAI_MODERATION_MODEL, input: String(text) }),
        signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error(`OpenAI moderation request failed (${response.status}).`);

    const result = await response.json();
    const moderation = result.results?.[0];
    if (!moderation) throw new Error('OpenAI moderation returned an invalid response.');
    if (!moderation.flagged) return null;

    const categories = Object.entries(moderation.categories || {})
        .filter(([, flagged]) => flagged)
        .map(([category]) => category.replace(/[\/_-]/g, ' '));
    return categories.length ? categories.join(', ') : 'content flagged by AI moderation';
}

function promptLine(label) {
    return new Promise(resolve => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(label, answer => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

function promptHidden(label) {
    return new Promise((resolve, reject) => {
        const input = process.stdin;
        if (!input.isTTY || typeof input.setRawMode !== 'function') {
            reject(new Error('Run this bot from a terminal so the password can be entered without echo.'));
            return;
        }

        process.stdout.write(label);
        let value = '';
        input.setRawMode(true);
        input.resume();
        input.setEncoding('utf8');

        function onData(character) {
            if (character === '\u0003') {
                cleanup();
                reject(new Error('Cancelled.'));
            } else if (character === '\r' || character === '\n') {
                cleanup();
                process.stdout.write('\n');
                resolve(value);
            } else if (character === '\u007f' || character === '\b') {
                value = value.slice(0, -1);
            } else {
                value += character;
            }
        }

        function cleanup() {
            input.removeListener('data', onData);
            input.setRawMode(false);
            input.pause();
        }

        input.on('data', onData);
    });
}

async function login(page, username, password) {
    await page.goto(SITE_URL, { waitUntil: 'domcontentloaded' });
    const usernameField = page.locator('#user_username');
    if (!(await usernameField.count())) {
        const loginButton = page.locator('.intro_login_btn');
        await loginButton.waitFor({ state: 'visible', timeout: 15000 });
        await loginButton.click();
        await usernameField.waitFor({ state: 'visible', timeout: 15000 });
    }

    await usernameField.fill(username);
    await page.locator('#user_password').fill(password);
    const submitButton = page.locator('#login_form_box button[onclick*="sendLogin"]');
    await submitButton.waitFor({ state: 'visible', timeout: 15000 });
    await submitButton.click();

    try {
        await page.locator('#login_form_box').waitFor({ state: 'hidden', timeout: 20000 });
    } catch {
        const formText = (await page.locator('#login_form_box').innerText().catch(() => '')).trim();
        throw new Error(formText || 'Login did not complete. Check the account details or any site verification prompt.');
    }
}

async function waitForSelectedChat(page) {
    const composer = await waitForComposer(page);
    if (!composer) {
        throw new Error('Login succeeded, but no visible chat input was found. Open the main room and restart the bot.');
    }
    const state = await page.evaluate(() => ({
        page: window.curPage,
        room: window.pageRoom,
        href: window.location.href
    }));
    return { ...state, composer };
}

async function installWatcher(page) {
    await page.evaluate(({ maxLength }) => {
        if (window.__pencilModerationWatcher) return;

        const processed = new WeakSet();
        const pending = [];
        const noise = line => /^\d{1,2}\/\d{1,2}(?:\s+\d{1,2}:\d{2})?$/.test(line)
            || /^\d{1,2}:\d{2}$/.test(line)
            || /^(online|offline)$/i.test(line);

        function cleanName(value) {
            return value.normalize('NFKC')
                .replace(/^[^\p{L}\p{N}@]+/u, '')
                .replace(/^@+/, '')
                .replace(/[^\p{L}\p{M}\p{N}_.-]/gu, '')
                .replace(/\d{7,}$/, '')
                .slice(0, 32);
        }

        function observe(text) {
            const lines = String(text).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
            const usefulLines = lines.filter(line => !noise(line) && !/^\d{7,}$/.test(line));
            if (usefulLines.length < 2) return null;
            const username = cleanName(usefulLines[0]);
            const content = usefulLines.slice(1).join(' ').trim();
            if (!username || !content || /^\d+$/.test(username)) return null;
            return { username, content };
        }

        function textOf(element) {
            return String(element.innerText || element.textContent || '').trim();
        }

        function inspect(node) {
            let root = node.nodeType === 1 ? node : node.parentElement;
            if (!root) return;
            const elements = [root, ...root.querySelectorAll('*')]
                .filter(element => {
                    const text = textOf(element);
                    return text.length > 0 && text.length <= maxLength
                        && text.split(/\r?\n/).filter(Boolean).length >= 2;
                })
                .sort((a, b) => textOf(a).length - textOf(b).length);

            for (const element of elements) {
                let candidate = element;
                for (let depth = 0; candidate && depth < 7; depth += 1, candidate = candidate.parentElement) {
                    if (candidate === document.body || candidate === document.documentElement || processed.has(candidate)) break;
                    if (elements.some(item => processed.has(item) && candidate.contains(item))) break;
                    const text = textOf(candidate);
                    if (text.length > maxLength) continue;
                    const message = observe(text);
                    if (message) {
                        processed.add(candidate);
                        pending.push(message);
                        break;
                    }
                }
            }
        }

        const observer = new MutationObserver(mutations => {
            for (const mutation of mutations) {
                const nodes = mutation.type === 'characterData'
                    ? [mutation.target]
                    : Array.from(mutation.addedNodes);
                for (const node of nodes) inspect(node);
            }
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        window.__pencilModerationWatcher = { pending, observer };
    }, { maxLength: MAX_MESSAGE_LENGTH });
}

async function evaluateWithNavigationRetry(page, evaluate) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
            return await page.evaluate(evaluate);
        } catch (error) {
            if (!/Execution context was destroyed/.test(error.message) || attempt === 4) throw error;

            console.warn('Page navigation interrupted chat polling; retrying.');
            await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
            await page.waitForTimeout(100);
            try {
                await installWatcher(page);
            } catch (watcherError) {
                if (!/Execution context was destroyed/.test(watcherError.message)) throw watcherError;
            }
        }
    }
}

async function findComposer(page) {
    const candidates = page.locator('textarea, input:not([type="hidden"]), [contenteditable="true"]');
    const viewport = page.viewportSize();
    if (!viewport) return null;

    let bottomCandidate = null;
    let bottomPosition = -1;
    const count = await candidates.count();
    for (let index = 0; index < count; index += 1) {
        const candidate = candidates.nth(index);
        if (!(await candidate.isVisible().catch(() => false))) continue;

        const details = await candidate.evaluate(element => ({
            label: [element.getAttribute('placeholder'), element.getAttribute('aria-label'), element.getAttribute('data-placeholder')]
                .filter(Boolean).join(' '),
            rect: element.getBoundingClientRect().toJSON()
        }));
        if (/type\s+here/i.test(details.label)) return candidate;

        const nearBottom = details.rect.y > viewport.height * 0.7;
        const composerSized = details.rect.width > Math.min(250, viewport.width * 0.3);
        if (nearBottom && composerSized && details.rect.y > bottomPosition) {
            bottomCandidate = candidate;
            bottomPosition = details.rect.y;
        }
    }
    return bottomCandidate;
}

async function waitForComposer(page, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const composer = await findComposer(page);
        if (composer) return composer;
        await page.waitForTimeout(300);
    }
    return null;
}

async function closePrivateConversation(page) {
    const closeCandidates = page.locator('button[aria-label*="close" i], [title*="close" i], [data-testid*="close" i], .close, button:has-text("Close"), a:has-text("Close")');
    const count = await closeCandidates.count();
    for (let index = 0; index < count; index += 1) {
        const candidate = closeCandidates.nth(index);
        if (!(await candidate.isVisible().catch(() => false))) continue;
        await candidate.click();
        return true;
    }
    try {
        await page.keyboard.press('Escape');
        return true;
    } catch {
        return false;
    }
}

async function clickVisibleUsername(page, username) {
    const escapedUsername = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const usernamePattern = new RegExp(`^\\s*${escapedUsername}\\s*$`, 'i');
    const textMatches = page.getByText(usernamePattern);
    for (let index = 0; index < await textMatches.count(); index += 1) {
        const candidate = textMatches.nth(index);
        if (!(await candidate.isVisible().catch(() => false))) continue;
        await candidate.click();
        return true;
    }

    const attributedCandidates = page.locator('[data-username], [data-user], [data-name], [title], [aria-label]');
    for (let index = 0; index < await attributedCandidates.count(); index += 1) {
        const candidate = attributedCandidates.nth(index);
        if (!(await candidate.isVisible().catch(() => false))) continue;
        const labels = await candidate.evaluate(element => [
            element.getAttribute('data-username'),
            element.getAttribute('data-user'),
            element.getAttribute('data-name'),
            element.getAttribute('title'),
            element.getAttribute('aria-label')
        ].filter(Boolean).map(value => value.normalize('NFKC').trim().toLowerCase()));
        if (!labels.includes(username.normalize('NFKC').trim().toLowerCase())) continue;
        await candidate.click();
        return true;
    }
    return false;
}

async function openContactList(page) {
    const controls = page.locator('button, a, [role="button"], [onclick], [data-menu]');
    const contactControl = /private\s*messages|inbox|online\s+users|user\s+list|member\s+list|contacts|friends/i;
    for (let index = 0; index < await controls.count(); index += 1) {
        const candidate = controls.nth(index);
        if (!(await candidate.isVisible().catch(() => false))) continue;
        const label = await candidate.evaluate(element => [
            element.innerText,
            element.textContent,
            element.getAttribute('aria-label'),
            element.getAttribute('title'),
            element.id,
            element.getAttribute('data-menu')
        ].filter(Boolean).join(' '));
        if (!contactControl.test(label)) continue;
        await candidate.click();
        return true;
    }
    return false;
}

async function searchContact(page, username) {
    const inputs = page.locator('input:not([type="hidden"]), [role="searchbox"]');
    for (let index = 0; index < await inputs.count(); index += 1) {
        const candidate = inputs.nth(index);
        if (!(await candidate.isVisible().catch(() => false))) continue;
        const label = await candidate.evaluate(element => [
            element.getAttribute('placeholder'),
            element.getAttribute('aria-label'),
            element.getAttribute('title'),
            element.id,
            typeof element.className === 'string' ? element.className : ''
        ].filter(Boolean).join(' '));
        if (!/(search|find|lookup)/i.test(label) || !/(user|member|people|contact|friend|recipient)/i.test(label)) continue;
        await candidate.fill(username);
        await candidate.press('Enter').catch(() => {});
        await page.waitForTimeout(300);
        if (await clickVisibleUsername(page, username)) return true;
    }
    return false;
}

async function openPrivateConversation(page, adminUsername) {
    let openedProfile = await clickVisibleUsername(page, adminUsername);
    if (!openedProfile) {
        await openContactList(page);
        openedProfile = await clickVisibleUsername(page, adminUsername);
    }
    if (!openedProfile) openedProfile = await searchContact(page, adminUsername);
    if (!openedProfile) {
        throw new Error(`Could not find ${adminUsername} in the chat, contacts, inbox, or user search.`);
    }

    const controls = page.locator('button, a, [role="button"], [onclick], [data-action], .profile-action, .user-action, .message-btn');
    const deadline = Date.now() + 5000;
    let privateControl = null;
    while (Date.now() < deadline && !privateControl) {
        const count = await controls.count();
        for (let index = 0; index < count; index += 1) {
            const candidate = controls.nth(index);
            if (!(await candidate.isVisible().catch(() => false))) continue;
            const label = await candidate.evaluate(element => [
                element.innerText,
                element.textContent,
                element.getAttribute('aria-label'),
                element.getAttribute('title'),
                element.id,
                element.getAttribute('data-action'),
                typeof element.className === 'string' ? element.className : ''
            ].filter(Boolean).join(' '));
            if (/private|direct|message|chat|dm|pm|send|reply|mail/i.test(label) && !/close|cancel|mute|block|report|friend/i.test(label)) {
                privateControl = candidate;
                break;
            }
        }
        if (!privateControl) await page.waitForTimeout(200);
    }
    if (privateControl) {
        await privateControl.click();
    }

    const composers = page.locator('textarea, input:not([type="hidden"]), [contenteditable="true"]');
    const composerDeadline = Date.now() + 5000;
    let privateComposer = null;
    while (Date.now() < composerDeadline && !privateComposer) {
        for (let index = 0; index < await composers.count(); index += 1) {
            const candidate = composers.nth(index);
            if (!(await candidate.isVisible().catch(() => false))) continue;
            const metadata = await candidate.evaluate(element => [
                element.getAttribute('placeholder'),
                element.getAttribute('aria-label'),
                element.getAttribute('title'),
                element.id,
                typeof element.className === 'string' ? element.className : '',
                (element.innerText || '').trim(),
                (element.value || '').trim()
            ].filter(Boolean).join(' '));
            const looksLikeDmComposer = /message|send|chat|dm|pm|reply|write/i.test(metadata) && !/room|main|global|general/i.test(metadata);
            if (looksLikeDmComposer) {
                privateComposer = candidate;
                break;
            }
        }
        if (!privateComposer) await page.waitForTimeout(200);
    }
    if (!privateComposer) throw new Error('Could not verify a private conversation composer; no alert was sent.');
    return privateComposer;
}

async function sendAdminAlert(page, adminUsername, message, detection) {
    const quotedMessage = String(message.content || '').replace(/\s+/g, ' ').slice(0, 240);
    const alert = `AutoMod: ${message.username} was detected for ${detection}. Message: “${quotedMessage}”`;
    await sendPrivateMessage(page, adminUsername, alert);
}

async function sendPrivateMessage(page, adminUsername, text) {
    await closePrivateConversation(page);
    const privateComposer = await openPrivateConversation(page, adminUsername);
    await privateComposer.fill(text);
    await privateComposer.press('Enter');
    await closePrivateConversation(page);
}

async function sendStartupMessage(page, adminUsername) {
    await sendPrivateMessage(page, adminUsername, 'Moderation bot is online and monitoring the selected room.');
}

async function runBot(page, username, roomState) {
    await installWatcher(page);
    const activeRoom = roomState;
    console.log('Watching the selected room for moderation alerts.');

    while (true) {
        const current = await evaluateWithNavigationRetry(page, () => ({
            page: window.curPage,
            room: window.pageRoom,
            href: window.location.href
        }));
        if (current.room !== activeRoom.room || current.href !== activeRoom.href
            || !(await activeRoom.composer.isVisible().catch(() => false))) {
            throw new Error('Chat or room changed. Bot stopped; restart it in the intended room.');
        }

        const messages = await evaluateWithNavigationRetry(page, () => {
            const watcher = window.__pencilModerationWatcher;
            return watcher ? watcher.pending.splice(0) : [];
        });
        for (const message of messages) {
            if (message.username.toLowerCase() === username.toLowerCase()
                || message.username.toLowerCase() === ADMIN_USERNAME.toLowerCase()) continue;

            let aiDetection = null;
            try {
                aiDetection = await moderateMessage(message.content || '');
            } catch (error) {
                console.error(`AI moderation failed for a message from ${message.username}: ${error.message}`);
            }
            const phraseDetection = detectSelfHarmPromotion(message.content || '');
            const detection = [aiDetection, phraseDetection].filter(Boolean).join('; ');
            if (detection) {
                try {
                    await sendAdminAlert(page, ADMIN_USERNAME, message, detection);
                    console.log(`AutoMod privately alerted ${ADMIN_USERNAME} about ${message.username}: ${detection}.`);
                } catch (error) {
                    console.error(`AutoMod detected ${message.username} (${detection}) but could not privately alert ${ADMIN_USERNAME}: ${error.message}`);
                }
            }
        }

        await page.waitForTimeout(100);
    }
}

async function runWithReconnect(runSession, wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))) {
    let attempt = 0;
    while (true) {
        try {
            await runSession();
        } catch (error) {
            console.error(`Bot disconnected: ${error.message}`);
        }

        const delay = Math.min(1000 * (2 ** attempt), 60000);
        console.log(`Retrying login in ${Math.ceil(delay / 1000)} seconds.`);
        await wait(delay);
        attempt = Math.min(attempt + 1, 6);
    }
}

async function main() {
    const { chromium } = require('playwright');
    if (!process.env.OPENAI_API_KEY) {
        throw new Error('Set OPENAI_API_KEY in the service variables to enable AI moderation.');
    }
    if (!process.stdin.isTTY && (!process.env.PENCIL_USERNAME || !process.env.PENCIL_PASSWORD)) {
        throw new Error('Set both PENCIL_USERNAME and PENCIL_PASSWORD in the service variables before starting the bot.');
    }
    const username = process.env.PENCIL_USERNAME || await promptLine('Pencil Practice username: ');
    const password = process.env.PENCIL_PASSWORD || await promptHidden('Pencil Practice password (hidden): ');
    if (!username || !password) throw new Error('Username and password are required.');

    await runWithReconnect(async () => {
        let browser;
        try {
            browser = await chromium.launch({ headless: true });
            const page = await browser.newPage();
            await login(page, username, password);
            await waitForSelectedChat(page);
            try {
                await sendStartupMessage(page, ADMIN_USERNAME);
                console.log(`Sent startup message to ${ADMIN_USERNAME}.`);
            } catch (error) {
                console.error(`Could not send startup message to ${ADMIN_USERNAME}: ${error.message}`);
            }
            const roomState = await waitForSelectedChat(page);
            await runBot(page, username, roomState);
        } finally {
            if (browser) await browser.close().catch(() => {});
        }
    });
}

if (require.main === module) {
    main().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

module.exports = {
    parseObservedMessage,
    detectSelfHarmPromotion,
    moderateMessage,
    clickVisibleUsername,
    runWithReconnect,
    waitForSelectedChat,
    evaluateWithNavigationRetry
};