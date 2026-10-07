const test = require('node:test');
const assert = require('node:assert/strict');
const {
    parseObservedMessage,
    detectSelfHarmPromotion,
    moderateMessage,
    clickVisibleUsername,
    runWithReconnect,
    waitForSelectedChat,
    evaluateWithNavigationRetry
} = require('../bot.js');

test('parses ordinary messages and ignores one-line content', () => {
    assert.deepEqual(parseObservedMessage('Alice\nYou should cut yourself\n28/09 2:41'), {
        username: 'Alice',
        content: 'You should cut yourself'
    });
    assert.equal(parseObservedMessage('hello'), null);
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

test('does not flag profanity or unrelated chat', () => {
    assert.equal(detectSelfHarmPromotion('that was a damn good game'), null);
    assert.equal(detectSelfHarmPromotion('I will see you tomorrow'), null);
});

test('sends chat text to OpenAI moderation and returns flagged categories', async () => {
    let requestUrl;
    let requestOptions;
    const detection = await moderateMessage('message text', 'test-api-key', async (url, options) => {
        requestUrl = url;
        requestOptions = options;
        return {
            ok: true,
            json: async () => ({
                results: [{ flagged: true, categories: { harassment: true, 'self-harm/intent': true, violence: false } }]
            })
        };
    });

    assert.equal(requestUrl, 'https://api.openai.com/v1/moderations');
    assert.equal(requestOptions.headers.Authorization, 'Bearer test-api-key');
    assert.deepEqual(JSON.parse(requestOptions.body), {
        model: 'omni-moderation-latest',
        input: 'message text'
    });
    assert.equal(detection, 'harassment, self harm intent');
});

test('returns no detection for messages the moderation API does not flag', async () => {
    const detection = await moderateMessage('ordinary message', 'test-api-key', async () => ({
        ok: true,
        json: async () => ({ results: [{ flagged: false, categories: {} }] })
    }));

    assert.equal(detection, null);
});

test('reports moderation API errors instead of treating them as clean results', async () => {
    await assert.rejects(moderateMessage('message text', 'test-api-key', async () => ({
        ok: false,
        status: 429
    })), /request failed \(429\)/);
});

test('finds the admin account by its plain username', async () => {
    let clicked = false;
    let requestedPattern;
    const page = {
        getByText: pattern => {
            requestedPattern = pattern;
            return {
                count: async () => 1,
                nth: () => ({
                    isVisible: async () => true,
                    click: async () => { clicked = true; }
                })
            };
        }
    };

    assert.equal(await clickVisibleUsername(page, 'solo'), true);
    assert.equal(requestedPattern.test('solo'), true);
    assert.equal(requestedPattern.test('solomon'), false);
    assert.equal(clicked, true);
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

test('retries page evaluation after navigation destroys its context', async () => {
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

    assert.equal(await evaluateWithNavigationRetry(page, () => 'ready'), 'ready');
    assert.equal(evaluateCalls, 3);
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