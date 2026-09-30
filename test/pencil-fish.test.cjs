const test = require('node:test');
const assert = require('node:assert/strict');
const {
    parseMessage,
    parseObservedMessage,
    detectSelfHarmPromotion,
    createReply,
    createSpamMessage,
    createConversationStarter,
    getConversationStarterInterval,
    replyToMessages,
    runWithReconnect,
    waitForSelectedChat,
    evaluateWithNavigationRetry,
    normalizeUsername,
    isBlacklistedUser,
    handleBlacklistCommand
} = require('../bot.js');

test('chooses varied conversation starters and schedules them 20 to 40 minutes apart', () => {
    assert.equal(createConversationStarter(() => 0), 'Pineapple on pizza: genuinely good or no?');
    const anotherStarter = createConversationStarter(() => 0.9);
    assert.ok(anotherStarter.endsWith('?'));
    assert.notEqual(anotherStarter, createConversationStarter(() => 0));

    assert.equal(getConversationStarterInterval(() => 0), 20 * 60 * 1000);
    assert.equal(getConversationStarterInterval(() => 0.5), 30 * 60 * 1000);
    const longestInterval = getConversationStarterInterval(() => 0.999999);
    assert.ok(longestInterval < 40 * 60 * 1000);
    assert.ok(longestInterval >= 20 * 60 * 1000);
});

test('retries a disconnected bot session with an increasing delay', async () => {
    let sessionCalls = 0;
    const delays = [];
    const stop = new Error('stop retry loop');
    const originalLog = console.log;
    const originalError = console.error;
    console.log = () => {};
    console.error = () => {};

    try {
        await assert.rejects(runWithReconnect(async () => {
            sessionCalls += 1;
            if (sessionCalls === 1) throw new Error('network lost');
        }, async delay => {
            delays.push(delay);
            if (delays.length === 2) throw stop;
        }), error => error === stop);
    } finally {
        console.log = originalLog;
        console.error = originalError;
    }

    assert.equal(sessionCalls, 2);
    assert.deepEqual(delays, [1000, 2000]);
});

test('retries a page evaluation after navigation destroys its context', async () => {
    let evaluateCalls = 0;
    const page = {
        evaluate: async () => {
            evaluateCalls += 1;
            if (evaluateCalls === 1) {
                throw new Error('Execution context was destroyed, most likely because of a navigation');
            }
            return evaluateCalls === 2 ? undefined : 'ready';
        },
        waitForLoadState: async () => {},
        waitForTimeout: async () => {}
    };

    assert.equal(await evaluateWithNavigationRetry(page, () => 'ready', 'solo'), 'ready');
    assert.equal(evaluateCalls, 3);
});

test('parses a line-start s.fish command and its sender', () => {
    assert.deepEqual(parseMessage('Svnny\ns.fish\n28/09 2:41'), {
        username: 'Svnny',
        command: 'fish',
        args: ''
    });
});

test('parses commands that start with a number', () => {
    assert.deepEqual(parseMessage('Svnny\ns.8ball Will I win?'), {
        username: 'Svnny',
        command: '8ball',
        args: 'Will I win?'
    });
});

test('accepts a visible chat composer when the app page flag is home', async () => {
    const page = {
        viewportSize: () => ({ width: 1000, height: 800 }),
        locator: () => ({
            count: async () => 1,
            nth: () => ({
                isVisible: async () => true,
                evaluate: async () => ({ label: 'Type here', rect: { y: 750, width: 400 } })
            })
        }),
        evaluate: async () => ({ page: 'home', room: 1, href: 'https://pencilpractice.website/' })
    };

    const state = await waitForSelectedChat(page);

    assert.equal(state.page, 'home');
    assert.equal(state.room, 1);
    assert.ok(state.composer);
});

test('uses the displayed username instead of a numeric account id', () => {
    assert.deepEqual(parseMessage('Svnny\n2089932\ns.fish'), {
        username: 'Svnny',
        command: 'fish',
        args: ''
    });
});

test('removes a numeric account id appended to the displayed username', () => {
    assert.deepEqual(parseMessage('solo2089935\ns.fish'), {
        username: 'solo',
        command: 'fish',
        args: ''
    });
});

test('keeps usernames that start with numbers', () => {
    assert.deepEqual(parseMessage('7solo\ns.fish'), {
        username: '7solo',
        command: 'fish',
        args: ''
    });
});

test('normalizes decorative Unicode usernames before creating a ping', () => {
    assert.deepEqual(parseMessage('𝓼𝓸𝓵𝓸\ns.fish'), {
        username: 'solo',
        command: 'fish',
        args: ''
    });
});

test('ignores ordinary text and commands not at the start of a line', () => {
    assert.equal(parseMessage('Svnny\ntry s.fish sometime'), null);
    assert.equal(parseMessage('Svnny\nhello there'), null);
});

test('parses regular chat messages with their displayed sender', () => {
    assert.deepEqual(parseObservedMessage('Alice\nYou should cut yourself\n28/09 2:41'), {
        username: 'Alice',
        command: null,
        args: '',
        content: 'You should cut yourself'
    });
});

test('detects direct self-harm encouragement and common obfuscations', () => {
    for (const text of [
        'you should kill yourself',
        'go cut yourself',
        'hang urself',
        'go jump off a bridge',
        'kys',
        'ky.s',
        'k y s',
        'k1ll y0urself'
    ]) {
        assert.ok(detectSelfHarmPromotion(text), `expected detection for: ${text}`);
    }
});

test('does not moderate profanity or unrelated chat', () => {
    assert.equal(detectSelfHarmPromotion('that was a damn good game'), null);
    assert.equal(detectSelfHarmPromotion('I will see you tomorrow'), null);
});

test('admin can blacklist and unblacklist only from the admin account', () => {
    const blacklist = new Set();

    assert.deepEqual(handleBlacklistCommand({ username: 'solo', command: 'ping', args: '' }, blacklist, 'solo'), {
        changed: false,
        value: null
    });
    assert.equal(handleBlacklistCommand({ username: 'solo', command: 'blacklist', args: 'bob' }, blacklist, 'solo').changed, true);
    assert.equal(isBlacklistedUser('Bob', blacklist), true);
    assert.equal(handleBlacklistCommand({ username: 'alice', command: 'blacklist', args: 'charlie' }, blacklist, 'solo').changed, false);
    assert.equal(handleBlacklistCommand({ username: 'solo', command: 'unblacklist', args: 'bob' }, blacklist, 'solo').changed, true);
    assert.equal(isBlacklistedUser('bob', blacklist), false);
    assert.equal(normalizeUsername('  @Solo_123 '), 'solo');
});

test('rejects messages without a sender and mention-everyone names', () => {
    assert.equal(parseMessage('s.fish'), null);
    assert.equal(parseMessage('@everyone\ns.fish'), null);
});

test('creates plain replies for supported commands', () => {
    assert.equal(createReply({ username: 'Svnny', command: 'unknown' }), null);
    assert.equal(createReply({ username: 'Svnny', command: 'fish' }, () => 0), 'Svnny caught a Goldfish');
    assert.equal(createReply({ username: 'Svnny', command: 'bark' }), 'Svnny: woof woof');
    assert.equal(createReply({ username: 'Svnny', command: 'ping' }), 'Svnny: pong');
    assert.equal(createReply({ username: 'Svnny', command: 'coin' }, () => 0), 'Svnny flipped heads');
    assert.equal(createReply({ username: 'Svnny', command: 'dice' }, () => 0.5), 'Svnny rolled a 4');
    assert.equal(createReply({ username: 'Svnny', command: 'rps' }, () => 0), 'Svnny chose rock');
    assert.equal(createReply({ username: 'Svnny', command: '8ball' }, () => 0.8), 'Svnny: No');
    assert.equal(createReply({ username: 'Svnny', command: 'dance' }), 'Svnny danced');
    assert.equal(createReply({ username: 'Svnny', command: 'joke' }, () => 0), 'Svnny: The pencil went to school to get a little sharper.');
    assert.equal(createReply({ username: 'Svnny', command: 'hug' }), 'Svnny sent a hug');
    assert.equal(createReply({ username: 'Svnny', command: 'compliment' }, () => 0), 'Svnny, you make this chat brighter');
    assert.equal(createReply({ username: 'Svnny', command: 'roll' }, () => 0), 'Svnny rolled 1 on a d20');
    assert.equal(createReply({ username: 'Svnny', command: 'highfive' }), 'Svnny got a high five');
    assert.equal(createReply({ username: 'Svnny', command: 'boop' }), 'Svnny got booped');
    assert.equal(createReply({ username: 'Svnny', command: 'cheer' }), 'Svnny, keep going');
    assert.equal(createReply({ username: 'Svnny', command: 'vibe' }, () => 0), "Svnny's vibe is immaculate");
    assert.equal(createReply({ username: 'Svnny', command: 'riddle' }), 'Svnny: A piano has keys but cannot open locks');
    assert.equal(createReply({ username: 'Svnny', command: 'pun' }, () => 0), 'Svnny, I used to be a banker, but I lost interest.');
    assert.equal(createReply({ username: 'Svnny', command: 'pick', args: 'pizza, tacos' }, () => 0.9), 'Svnny picked tacos');
    assert.equal(createReply({ username: 'Svnny', command: 'pick' }), 'Svnny, provide options with s.pick pizza, tacos');
    assert.equal(createReply({ username: 'Svnny', command: 'rate', args: 'my drawing' }, () => 0), 'my drawing gets a 1/10');
    assert.equal(createReply({ username: 'Svnny', command: 'pet' }), 'Svnny patted the chat');
    assert.equal(createReply({ username: 'Svnny', command: 'sparkle' }), 'Svnny added a little sparkle');
    assert.equal(createReply({ username: 'Svnny', command: 'shrug' }), 'Svnny shrugs');
    assert.equal(createReply({ username: 'Svnny', command: 'fortune' }, () => 0), "Svnny's fortune: A pleasant surprise is heading your way.");
    assert.equal(createReply({ username: 'Svnny', command: 'help' }), 'Commands: fish, balance, wallet, shop, bait, buy, equip, work, daily, beg, bark, ping, coin, dice, rps, 8ball, dance, joke, hug, compliment, roll, highfive, boop, cheer, vibe, riddle, pun, pick, rate, pet, sparkle, shrug, fortune, switch, spam, stopspam, help');
});

test('command replies contain no emoji, exclamation marks, or question marks', () => {
    const commands = [
        'fish', 'bark', 'ping', 'coin', 'dice', 'rps', '8ball', 'dance', 'joke', 'hug',
        'compliment', 'roll', 'highfive', 'boop', 'cheer', 'vibe', 'riddle', 'pun', 'pick',
        'rate', 'pet', 'sparkle', 'shrug', 'fortune', 'help'
    ];
    for (const command of commands) {
        const reply = createReply({ username: 'Svnny', command, args: 'pizza, tacos' }, () => 0);
        assert.doesNotMatch(reply, /[!?\p{Extended_Pictographic}]/u, command);
    }
});

test('creates three random uppercase letters for spam messages', () => {
    const rolls = [0, 25 / 26, 12 / 26];
    assert.equal(createSpamMessage(() => rolls.shift()), 'AZM');
});

test('replies to every supported command in a batch in order', async () => {
    const sent = [];
    await replyToMessages([
        { username: 'Alice', command: 'ping' },
        { username: 'Bot', command: 'ping' },
        { username: 'Bob', command: 'hug' },
        { username: 'Casey', command: 'unknown' },
        { username: 'Dana', command: 'dance' }
    ], 'Bot', async (message, reply) => sent.push([message.username, reply]));

    assert.deepEqual(sent, [
        ['Alice', 'Alice: pong'],
        ['Bob', 'Bob sent a hug'],
        ['Dana', 'Dana danced']
    ]);
});