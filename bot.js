const readline = require('node:readline');
const { FishingEconomy } = require('./economy.js');

const SITE_URL = 'https://pencilpractice.website/';
const REPLY_INTERVAL_MS = 250;
const MAX_MESSAGE_LENGTH = 260;
const FISH = ['Goldfish', 'Bluefin tuna', 'Clownfish', 'Pufferfish', 'Salmon', 'Swordfish'];
const RPS_CHOICES = ['rock', 'paper', 'scissors'];
const EIGHT_BALL_ANSWERS = ['Absolutely!', 'It is looking good!', 'Maybe...', 'Ask again later!', 'Not today!'];
const JOKES = ['Why did the pencil go to school? To get a little sharper!', 'What is a fish’s favorite instrument? The bass!', 'Why did the computer get cold? It left its Windows open!'];
const COMPLIMENTS = ['you make this chat brighter!', 'you have legendary vibes!', 'you are doing amazing today!'];
const VIBES = ['immaculate', 'sparkly', 'legendary', 'chill', 'unstoppable'];
const PUNS = ['I used to be a banker, but I lost interest.', 'I wondered why the baseball was getting bigger. Then it hit me.', 'I am reading a book about anti-gravity. It is impossible to put down!'];
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

function createReply(message, random = Math.random) {
    if (!message) return null;

    const command = (message.command || '').toLowerCase();
    if (command === 'fish') {
        const fish = FISH[Math.floor(random() * FISH.length)];
        return `${message.username} caught a ${fish}!`;
    }
    if (command === 'bark') {
        return `${message.username} barks: woof woof!`;
    }
    if (command === 'ping') {
        return `Pong! ${message.username} got pinged!`;
    }
    if (command === 'coin') {
        const side = ['heads', 'tails'][Math.floor(random() * 2)];
        return `${message.username} flipped a coin: ${side}!`;
    }
    if (command === 'dice') {
        const roll = Math.floor(random() * 6) + 1;
        return `${message.username} rolled a ${roll}!`;
    }
    if (command === 'rps') {
        const choice = RPS_CHOICES[Math.floor(random() * RPS_CHOICES.length)];
        return `${message.username} chose ${choice}!`;
    }
    if (command === '8ball') {
        const answer = EIGHT_BALL_ANSWERS[Math.floor(random() * EIGHT_BALL_ANSWERS.length)];
        return `${message.username} asks the magic 8-ball: ${answer}`;
    }
    if (command === 'dance') {
        return `${message.username} does a happy dance!`;
    }
    if (command === 'joke') {
        const joke = JOKES[Math.floor(random() * JOKES.length)];
        return `${message.username}, ${joke}`;
    }
    if (command === 'hug') {
        return `${message.username} gets a big virtual hug!`;
    }
    if (command === 'compliment') {
        const compliment = COMPLIMENTS[Math.floor(random() * COMPLIMENTS.length)];
        return `${message.username}, ${compliment}`;
    }
    if (command === 'roll') {
        return `${message.username} rolled a ${Math.floor(random() * 20) + 1} on a d20!`;
    }
    if (command === 'highfive') {
        return `${message.username} gets a high five!`;
    }
    if (command === 'boop') {
        return `Boop! ${message.username} has been booped!`;
    }
    if (command === 'cheer') {
        return `Let's go, ${message.username}! You've got this!`;
    }
    if (command === 'vibe') {
        const vibe = VIBES[Math.floor(random() * VIBES.length)];
        return `${message.username}'s vibe is ${vibe}!`;
    }
    if (command === 'riddle') {
        return `${message.username}: What has keys but cannot open locks? A piano!`;
    }
    if (command === 'pun') {
        const pun = PUNS[Math.floor(random() * PUNS.length)];
        return `${message.username}, ${pun}`;
    }
    if (command === 'pick') {
        const options = (message.args || '').split(/,|\bor\b/i).map(option => option.trim()).filter(Boolean).slice(0, 8);
        if (!options.length) return `${message.username}, give me options: s.pick pizza, tacos`;
        const choice = options[Math.floor(random() * options.length)].slice(0, 32);
        return `${message.username}, I pick ${choice}!`;
    }
    if (command === 'rate') {
        const subject = (message.args || `${message.username}'s vibe`).slice(0, 80);
        return `${subject} gets a ${Math.floor(random() * 10) + 1}/10 rating!`;
    }
    if (command === 'pet') {
        return `${message.username} gives the chat a gentle pat!`;
    }
    if (command === 'sparkle') {
        return `✨ ${message.username} adds a little sparkle! ✨`;
    }
    if (command === 'shrug') {
        return `${message.username} shrugs: who knows!`;
    }
    if (command === 'fortune') {
        const fortune = FORTUNES[Math.floor(random() * FORTUNES.length)];
        return `${message.username}'s fortune: ${fortune}`;
    }
    if (command === 'help') {
        return `Commands: fish, balance, shop, bait, buy, equip, bark, ping, coin, dice, rps, 8ball, dance, joke, hug, compliment, roll, highfive, boop, cheer, vibe, riddle, pun, pick, rate, pet, sparkle, shrug, fortune, help`;
    }
    return null;
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

        function textOf(element) {
            return String(element.innerText || element.textContent || '').trim();
        }

        function inspect(node) {
            let root = node.nodeType === 1 ? node : node.parentElement;
            if (!root) return;
            const elements = [root, ...root.querySelectorAll('*')]
                .filter(element => {
                    const text = textOf(element);
                    return text.length > 0 && text.length <= maxLength && /^s\./im.test(text);
                })
                .sort((a, b) => textOf(a).length - textOf(b).length);

            for (const element of elements) {
                let candidate = element;
                for (let depth = 0; candidate && depth < 7; depth += 1, candidate = candidate.parentElement) {
                    if (candidate === document.body || candidate === document.documentElement || processed.has(candidate)) break;
                    if (elements.some(item => processed.has(item) && candidate.contains(item))) break;
                    const text = textOf(candidate);
                    if (text.length > maxLength) continue;
                    const message = parse(text);
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

async function runBot(page, username, roomState, economy) {
    await installWatcher(page, username);
    const composer = roomState.composer;
    console.log('Listening for chat commands in the selected room. Press Ctrl+C to stop.');

    while (true) {
        const current = await page.evaluate(() => ({
            page: window.curPage,
            room: window.pageRoom,
            href: window.location.href
        }));
        if (current.room !== roomState.room || current.href !== roomState.href
            || !(await composer.isVisible().catch(() => false))) {
            console.log('Chat or room changed. Bot paused; restart it in the intended room.');
            return;
        }

        const messages = await page.evaluate(() => {
            const watcher = window.__pencilFishWatcher;
            return watcher ? watcher.pending.splice(0) : [];
        });
        await replyToMessages(messages, username, async (message, reply) => {
            await sendReply(page, composer, reply);
            console.log(`Replied to ${message.username} with: ${reply}`);
            await page.waitForTimeout(REPLY_INTERVAL_MS);
        }, economy);

        await page.waitForTimeout(100);
    }
}

async function main() {
    const { chromium } = require('playwright');
    const username = await promptLine('Pencil Practice username: ');
    let password = await promptHidden('Pencil Practice password (hidden): ');
    if (!username || !password) throw new Error('Username and password are required.');

    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await login(page, username, password);
        password = '';
        const roomState = await waitForSelectedChat(page);
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

module.exports = { parseMessage, createReply, replyToMessages, waitForSelectedChat };