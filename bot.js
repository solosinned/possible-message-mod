const readline = require('node:readline');
const { FishingEconomy } = require('./economy.js');

const SITE_URL = 'https://pencilpractice.website/';
const ADMIN_USERNAME = process.env.BOT_ADMIN_USERNAME || 'solo';
const REPLY_INTERVAL_MS = 250;
const SPAM_INTERVAL_MS = 500;
const MAX_MESSAGE_LENGTH = 260;
const FISH = ['Goldfish', 'Bluefin tuna', 'Clownfish', 'Pufferfish', 'Salmon', 'Swordfish'];
const RPS_CHOICES = ['rock', 'paper', 'scissors'];
const EIGHT_BALL_ANSWERS = ['Yes', 'Looks likely', 'Maybe', 'Ask again later', 'No'];
const JOKES = ['The pencil went to school to get a little sharper.', 'A fish’s favorite instrument is the bass.', 'The computer got cold because it left its Windows open.'];
const COMPLIMENTS = ['you make this chat brighter', 'you have good instincts', 'you are doing well'];
const VIBES = ['immaculate', 'sparkly', 'legendary', 'chill', 'unstoppable'];
const PUNS = ['I used to be a banker, but I lost interest.', 'The baseball kept getting bigger. Then it hit me.', 'I am reading a book about anti-gravity. It is impossible to put down.'];
const FORTUNES = ['A pleasant surprise is heading your way.', 'Today is a great day to try something new.', 'Your next idea will be a brilliant one.'];
const COMMAND_PATTERN = /^s\.([a-z0-9][a-z0-9_-]*)(?:\s+(.*))?$/i;

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

function normalizeUsername(value) {
    const username = cleanUsername(String(value || '')).toLowerCase();
    return username.replace(/[_-]\d{2,}$/, '').replace(/_$/, '');
}

function isBlacklistedUser(username, blacklist = new Set()) {
    const normalized = normalizeUsername(username);
    return Boolean(normalized && blacklist.has(normalized));
}

function handleBlacklistCommand(message, blacklist = new Set(), adminUsername = ADMIN_USERNAME) {
    if (!message || !message.command) return { changed: false, value: null };
    if (message.command !== 'blacklist' && message.command !== 'unblacklist') {
        return { changed: false, value: null };
    }

    const sender = normalizeUsername(message.username || '');
    const admin = normalizeUsername(adminUsername || '');
    if (!sender || sender !== admin) return { changed: false, value: null };

    const target = normalizeUsername(message.args || '');
    if (!target) {
        return { changed: false, value: 'Use s.blacklist username or s.unblacklist username.' };
    }

    if (message.command === 'blacklist') {
        if (target === admin) {
            return { changed: false, value: 'You cannot blacklist the bot owner.' };
        }
        blacklist.add(target);
        return { changed: true, value: `${target} was blacklisted and can no longer use the bot.` };
    }

    if (message.command === 'unblacklist') {
        const removed = blacklist.delete(target);
        return { changed: removed, value: removed ? `${target} was removed from the blacklist.` : `${target} was not on the blacklist.` };
    }

    return { changed: false, value: null };
}

function parseMessage(text) {
    const lines = String(text).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const commandIndex = lines.findIndex(line => COMMAND_PATTERN.test(line));
    if (commandIndex < 0) return null;

    const match = COMMAND_PATTERN.exec(lines[commandIndex]);
    const username = lines.slice(0, commandIndex)
        .reverse()
        .filter(line => !isNoiseLine(line))
        .map(cleanUsername)
        .find(Boolean) || '';
    if (!username) return null;

    return { username, command: match[1].toLowerCase(), args: (match[2] || '').trim() };
}

function parseObservedMessage(text) {
    const command = parseMessage(text);
    if (command) return { ...command, content: command.args };

    const lines = String(text).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const usefulLines = lines.filter(line => !isNoiseLine(line) && !/^\d{7,}$/.test(line));
    if (usefulLines.length < 2) return null;

    const username = cleanUsername(usefulLines[0]);
    const content = usefulLines.slice(1).join(' ').trim();
    if (!username || !content || /^\d+$/.test(username)) return null;
    return { username, command: null, args: '', content };
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

function createReply(message, random = Math.random) {
    if (!message) return null;

    const command = (message.command || '').toLowerCase();
    if (command === 'fish') {
        const fish = FISH[Math.floor(random() * FISH.length)];
        return `${message.username} caught a ${fish}`;
    }
    if (command === 'bark') {
        return `${message.username}: woof woof`;
    }
    if (command === 'ping') {
        return `${message.username}: pong`;
    }
    if (command === 'coin') {
        const side = ['heads', 'tails'][Math.floor(random() * 2)];
        return `${message.username} flipped ${side}`;
    }
    if (command === 'dice') {
        const roll = Math.floor(random() * 6) + 1;
        return `${message.username} rolled a ${roll}`;
    }
    if (command === 'rps') {
        const choice = RPS_CHOICES[Math.floor(random() * RPS_CHOICES.length)];
        return `${message.username} chose ${choice}`;
    }
    if (command === '8ball') {
        const answer = EIGHT_BALL_ANSWERS[Math.floor(random() * EIGHT_BALL_ANSWERS.length)];
        return `${message.username}: ${answer}`;
    }
    if (command === 'dance') {
        return `${message.username} danced`;
    }
    if (command === 'joke') {
        const joke = JOKES[Math.floor(random() * JOKES.length)];
        return `${message.username}: ${joke}`;
    }
    if (command === 'hug') {
        return `${message.username} sent a hug`;
    }
    if (command === 'compliment') {
        const compliment = COMPLIMENTS[Math.floor(random() * COMPLIMENTS.length)];
        return `${message.username}, ${compliment}`;
    }
    if (command === 'roll') {
        return `${message.username} rolled ${Math.floor(random() * 20) + 1} on a d20`;
    }
    if (command === 'highfive') {
        return `${message.username} got a high five`;
    }
    if (command === 'boop') {
        return `${message.username} got booped`;
    }
    if (command === 'cheer') {
        return `${message.username}, keep going`;
    }
    if (command === 'vibe') {
        const vibe = VIBES[Math.floor(random() * VIBES.length)];
        return `${message.username}'s vibe is ${vibe}`;
    }
    if (command === 'riddle') {
        return `${message.username}: A piano has keys but cannot open locks`;
    }
    if (command === 'pun') {
        const pun = PUNS[Math.floor(random() * PUNS.length)];
        return `${message.username}, ${pun}`;
    }
    if (command === 'pick') {
        const options = (message.args || '').split(/,|\bor\b/i).map(option => option.trim()).filter(Boolean).slice(0, 8);
        if (!options.length) return `${message.username}, provide options with s.pick pizza, tacos`;
        const choice = options[Math.floor(random() * options.length)].slice(0, 32);
        return `${message.username} picked ${choice}`;
    }
    if (command === 'rate') {
        const subject = (message.args || `${message.username}'s vibe`).slice(0, 80);
        return `${subject} gets a ${Math.floor(random() * 10) + 1}/10`;
    }
    if (command === 'pet') {
        return `${message.username} patted the chat`;
    }
    if (command === 'sparkle') {
        return `${message.username} added a little sparkle`;
    }
    if (command === 'shrug') {
        return `${message.username} shrugs`;
    }
    if (command === 'fortune') {
        const fortune = FORTUNES[Math.floor(random() * FORTUNES.length)];
        return `${message.username}'s fortune: ${fortune}`;
    }
    if (command === 'help') {
        return `Commands: fish, balance, wallet, shop, bait, buy, equip, work, daily, beg, bark, ping, coin, dice, rps, 8ball, dance, joke, hug, compliment, roll, highfive, boop, cheer, vibe, riddle, pun, pick, rate, pet, sparkle, shrug, fortune, switch, spam, stopspam, help`;
    }
    return null;
}

function createSpamMessage(random = Math.random) {
    return Array.from({ length: 3 }, () => String.fromCharCode(65 + Math.floor(random() * 26))).join('');
}

async function replyToMessages(messages, username, send, economy = null) {
    for (const message of messages) {
        if (message.username.toLowerCase() === username.toLowerCase()) continue;
        const reply = economy?.reply(message) || createReply(message);
        if (!reply) continue;
        await send(message, reply);
    }
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

async function installWatcher(page, ownUsername) {
    await page.evaluate(({ maxLength }) => {
        if (window.__pencilFishWatcher) return;

        const processed = new WeakSet();
        const pending = [];
        const commandPattern = /^s\.([a-z0-9][a-z0-9_-]*)(?:\s+(.*))?$/i;
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

        function parse(text) {
            const lines = String(text).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
            const commandIndex = lines.findIndex(line => commandPattern.test(line));
            if (commandIndex < 0) return null;
            const match = commandPattern.exec(lines[commandIndex]);
            const username = lines.slice(0, commandIndex)
                .reverse()
                .filter(line => !noise(line))
                .map(cleanName)
                .find(name => name && !/^\d+$/.test(name) && !/^(everyone|here)$/i.test(name)) || '';
            if (!username) return null;
            return { username, command: match[1].toLowerCase(), args: (match[2] || '').trim() };
        }

        function observe(text) {
            const command = parse(text);
            if (command) return { ...command, content: command.args };

            const lines = String(text).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
            const usefulLines = lines.filter(line => !noise(line) && !/^\d{7,}$/.test(line));
            if (usefulLines.length < 2) return null;
            const username = cleanName(usefulLines[0]);
            const content = usefulLines.slice(1).join(' ').trim();
            if (!username || !content || /^\d+$/.test(username)) return null;
            return { username, command: null, args: '', content };
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
                        && (/^s\./im.test(text) || text.split(/\r?\n/).filter(Boolean).length >= 2);
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
        window.__pencilFishWatcher = { pending, observer };
    }, { maxLength: MAX_MESSAGE_LENGTH, ownUsername });
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

async function sendReply(page, composer, reply) {
    await composer.fill(reply);
    await composer.press('Enter');
}

async function clickVisibleText(page, pattern, timeoutMs = 10000) {
    const candidates = page.getByText(pattern);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const count = await candidates.count();
        for (let index = 0; index < count; index += 1) {
            const candidate = candidates.nth(index);
            if (await candidate.isVisible().catch(() => false)) {
                await candidate.click();
                return;
            }
        }
        await page.waitForTimeout(200);
    }
    throw new Error(`Could not find visible control matching ${pattern}.`);
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

async function openPrivateConversation(page, adminUsername) {
    const escapedUsername = adminUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const usernameMatches = page.getByText(new RegExp(`^${escapedUsername}$`, 'i'));
    let openedProfile = false;
    for (let index = 0; index < await usernameMatches.count(); index += 1) {
        const candidate = usernameMatches.nth(index);
        if (!(await candidate.isVisible().catch(() => false))) continue;
        await candidate.click();
        openedProfile = true;
        break;
    }
    if (!openedProfile) throw new Error(`Could not find ${adminUsername} in the visible chat to open a private conversation.`);

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
        if (!privateComposer) {
            const fallback = await composers.first().isVisible().catch(() => false);
            if (fallback) {
                privateComposer = composers.first();
                break;
            }
            await page.waitForTimeout(200);
        }
    }
    if (!privateComposer) throw new Error('Could not verify a private conversation composer; no alert was sent.');
    return privateComposer;
}

async function sendAdminAlert(page, adminUsername, message, detection) {
    await closePrivateConversation(page);
    const privateComposer = await openPrivateConversation(page, adminUsername);
    const quotedMessage = String(message.content || '').replace(/\s+/g, ' ').slice(0, 240);
    const alert = `AutoMod: ${message.username} was detected for ${detection}. Message: “${quotedMessage}”`;
    await privateComposer.fill(alert);
    await privateComposer.press('Enter');
    await closePrivateConversation(page);
}

async function testAdminPrivateMessage(page, adminUsername, testMessage = 'This is a bot DM test. Please ignore this message.') {
    await closePrivateConversation(page);
    const privateComposer = await openPrivateConversation(page, adminUsername);
    await privateComposer.fill(testMessage);
    await privateComposer.press('Enter');
    await closePrivateConversation(page);
}

async function clickRoomListControl(page, timeoutMs = 10000) {
    const candidates = page.locator('button, a, [role="button"], [onclick], [data-menu]');
    const deadline = Date.now() + timeoutMs;
    let visibleControls = [];
    while (Date.now() < deadline) {
        const count = await candidates.count();
        visibleControls = [];
        for (let index = 0; index < count; index += 1) {
            const candidate = candidates.nth(index);
            if (!(await candidate.isVisible().catch(() => false))) continue;
            const details = await candidate.evaluate(element => ({
                text: (element.innerText || element.textContent || '').trim().slice(0, 60),
                label: element.getAttribute('aria-label') || '',
                title: element.getAttribute('title') || '',
                id: element.id || '',
                classes: typeof element.className === 'string' ? element.className : '',
                menu: element.getAttribute('data-menu') || ''
            }));
            visibleControls.push(details);
            const metadata = [details.text, details.label, details.title, details.id, details.classes, details.menu].join(' ');
            if (/room|rooms|fa-users|fa-door-open/i.test(metadata)) {
                await candidate.click();
                return;
            }
        }
        await page.waitForTimeout(200);
    }
    const summary = visibleControls.slice(0, 12).map(control =>
        [control.text, control.label, control.title, control.id, control.classes, control.menu]
            .filter(Boolean).join(' | ')).join('; ');
    throw new Error(`Could not identify the room-list control. Visible controls: ${summary || 'none found'}`);
}

async function openRoomList(page) {
    const roomOptionsMenu = page.locator('#room_options_menu');
    if (await roomOptionsMenu.count()) {
        if (await roomOptionsMenu.isVisible().catch(() => false)) return;

        const triggers = page.locator('[data-menu="room_options_menu"], [onclick*="room_options_menu"]');
        const triggerCount = await triggers.count();
        for (let index = 0; index < triggerCount; index += 1) {
            const trigger = triggers.nth(index);
            if (!(await trigger.isVisible().catch(() => false))) continue;
            await trigger.click();
            await roomOptionsMenu.waitFor({ state: 'visible', timeout: 5000 });
            return;
        }

        {
            const opened = await page.evaluate(() => {
                if (!document.querySelector('#room_options_menu')) return false;
                if (typeof window.prepareMenu === 'function') {
                    window.prepareMenu('room_options_menu');
                    return true;
                }
                if (typeof window.showMenu === 'function') {
                    window.showMenu('room_options_menu');
                    return true;
                }
                return false;
            });
            if (opened) {
                await roomOptionsMenu.waitFor({ state: 'visible', timeout: 5000 });
                return;
            }
        }

        if (await roomOptionsMenu.isVisible().catch(() => false)) {
            return;
        }
    }
    await clickRoomListControl(page);
}

async function clickMathsClassEntry(page, timeoutMs = 10000) {
    const entries = page.locator('.room_name, .mroom_name');
    const deadline = Date.now() + timeoutMs;
    let visibleNames = [];
    while (Date.now() < deadline) {
        visibleNames = [];
        const count = await entries.count();
        for (let index = 0; index < count; index += 1) {
            const entry = entries.nth(index);
            if (!(await entry.isVisible().catch(() => false))) continue;
            const name = (await entry.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
            if (!name) continue;
            visibleNames.push(name);
            if (/maths\s+class/i.test(name)) {
                await entry.click();
                return;
            }
        }
        await page.waitForTimeout(200);
    }
    throw new Error(`Could not find MATHS CLASS in room entries. Visible room names: ${visibleNames.join(', ') || 'none found'}`);
}

async function navigateToMathsClass(page, previousRoom) {
    await openRoomList(page);
    await clickMathsClassEntry(page);

    const joinControl = page.getByText(/^join(?: room)?$/i);
    const joinCount = await joinControl.count();
    for (let index = 0; index < joinCount; index += 1) {
        const candidate = joinControl.nth(index);
        if (await candidate.isVisible().catch(() => false)) {
            await candidate.click();
            break;
        }
    }

    const composer = await waitForComposer(page);
    if (!composer) throw new Error('MATHS CLASS opened without a visible chat input.');
    const state = await page.evaluate(() => ({
        page: window.curPage,
        room: window.pageRoom,
        href: window.location.href
    }));
    if (state.room === previousRoom.room) throw new Error('Room navigation did not leave the current room.');
    return { ...state, composer };
}

async function runBot(page, username, roomState, economy) {
    await installWatcher(page, username);
    const blacklist = new Set();
    let activeRoom = roomState;
    let spamComposer = null;
    let spamActive = false;
    let navigatingToMathRoom = false;
    let hasSwitchedToMathRoom = false;
    let nextSpamAt = 0;
    console.log('Listening in the main room. Use s.switch to enter MATHS CLASS, then s.spam to start; s.stopspam stops it.');

    while (true) {
        const current = await page.evaluate(() => ({
            page: window.curPage,
            room: window.pageRoom,
            href: window.location.href
        }));
        if (!navigatingToMathRoom && (current.room !== activeRoom.room || current.href !== activeRoom.href
            || !(await activeRoom.composer.isVisible().catch(() => false)))) {
            throw new Error('Chat or room changed. Bot stopped; restart it in the intended room.');
        }

        const messages = await page.evaluate(() => {
            const watcher = window.__pencilFishWatcher;
            return watcher ? watcher.pending.splice(0) : [];
        });

        const regularMessages = [];
        for (const message of messages) {
            if (isBlacklistedUser(message.username, blacklist)) {
                continue;
            }

            const blacklistCommand = handleBlacklistCommand(message, blacklist, ADMIN_USERNAME);
            if (blacklistCommand.changed || blacklistCommand.value) {
                if (message.username.toLowerCase() === ADMIN_USERNAME.toLowerCase()) {
                    try {
                        await sendReply(page, activeRoom.composer, blacklistCommand.value);
                    } catch {
                        console.log(blacklistCommand.value);
                    }
                }
                continue;
            }

            const detection = detectSelfHarmPromotion(message.content || '');
            if (detection && message.username.toLowerCase() !== username.toLowerCase()
                && message.username.toLowerCase() !== ADMIN_USERNAME.toLowerCase()) {
                try {
                    await sendAdminAlert(page, ADMIN_USERNAME, message, detection);
                    console.log(`AutoMod privately alerted ${ADMIN_USERNAME} about ${message.username}: ${detection}.`);
                } catch (error) {
                    console.error(`AutoMod detected ${message.username} (${detection}) but could not privately alert ${ADMIN_USERNAME}: ${error.message}`);
                }
            }
            if (message.command === 'stopspam') {
                if (spamActive) console.log(`Spam stopped by ${message.username}.`);
                spamActive = false;
                spamComposer = null;
                continue;
            }
            if (message.command === 'switch') {
                if (!hasSwitchedToMathRoom && !navigatingToMathRoom
                    && current.room === roomState.room && activeRoom.room === roomState.room) {
                    navigatingToMathRoom = true;
                    void navigateToMathsClass(page, roomState).then(room => {
                        activeRoom = room;
                        hasSwitchedToMathRoom = true;
                        console.log('Switched to MATHS CLASS. Use s.spam to start.');
                    }).catch(error => {
                        console.error(`Could not switch to MATHS CLASS: ${error.message}`);
                    }).finally(() => {
                        navigatingToMathRoom = false;
                    });
                    console.log('Navigating to MATHS CLASS.');
                }
                continue;
            }
            if (message.command === 'spam') {
                if (message.username.toLowerCase() !== username.toLowerCase()) continue;
                if (hasSwitchedToMathRoom && !spamActive && !navigatingToMathRoom) {
                    spamActive = true;
                    spamComposer = activeRoom.composer;
                    nextSpamAt = Date.now();
                    console.log('Spam started in MATHS CLASS.');
                }
                continue;
            }
            if (spamActive || navigatingToMathRoom) continue;
            regularMessages.push(message);
        }

        await replyToMessages(regularMessages, username, async (message, reply) => {
            await sendReply(page, activeRoom.composer, reply);
            console.log(`Replied to ${message.username} with: ${reply}`);
            await page.waitForTimeout(REPLY_INTERVAL_MS);
        }, economy);

        if (spamActive && spamComposer && Date.now() >= nextSpamAt) {
            const spamMessage = createSpamMessage();
            try {
                await sendReply(page, spamComposer, spamMessage);
                nextSpamAt = Date.now() + SPAM_INTERVAL_MS;
            } catch (error) {
                spamActive = false;
                spamComposer = null;
                console.error(`Spam stopped because sending failed: ${error.message}`);
            }
        }

        await page.waitForTimeout(100);
    }
}

async function main() {
    const { chromium } = require('playwright');
    if (!process.stdin.isTTY && (!process.env.PENCIL_USERNAME || !process.env.PENCIL_PASSWORD)) {
        throw new Error('Set both PENCIL_USERNAME and PENCIL_PASSWORD in the service variables before starting the bot.');
    }
    const username = process.env.PENCIL_USERNAME || await promptLine('Pencil Practice username: ');
    let password = process.env.PENCIL_PASSWORD || await promptHidden('Pencil Practice password (hidden): ');
    if (!username || !password) throw new Error('Username and password are required.');

    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await login(page, username, password);
        password = '';
        const roomState = await waitForSelectedChat(page);
        try {
            await testAdminPrivateMessage(page, ADMIN_USERNAME, 'Bot test: direct message check from the bot startup.');
            console.log(`Sent the startup DM test to ${ADMIN_USERNAME} and closed the conversation.`);
        } catch (error) {
            console.error(`Could not send the startup DM test to ${ADMIN_USERNAME}: ${error.message}`);
        }
        await runBot(page, username, roomState, new FishingEconomy());
    } finally {
        password = '';
        await browser.close();
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

module.exports = {
    parseMessage,
    parseObservedMessage,
    detectSelfHarmPromotion,
    normalizeUsername,
    isBlacklistedUser,
    handleBlacklistCommand,
    createReply,
    createSpamMessage,
    replyToMessages,
    waitForSelectedChat
};