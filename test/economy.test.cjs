const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FishingEconomy, BAITS, FISH_BY_RARITY } = require('../economy.js');

function createEconomy(t, random = () => 0, now = Date.now) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sincoins-test-'));
    const storePath = path.join(directory, 'sincoins.json');
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return { economy: new FishingEconomy(storePath, random, now), storePath };
}

function command(username, name, args = '') {
    return { username, command: name, args };
}

test('defines five baits with progressively broader rarity pools', () => {
    assert.equal(BAITS.length, 5);
    assert.deepEqual(BAITS.map(bait => bait.weights.length), [1, 2, 3, 4, 6]);
    assert.ok(FISH_BY_RARITY.every(fish => fish.length >= 5));
});

test('starter bait only catches Common fish and awards its Sincoin value', t => {
    const { economy } = createEconomy(t);

    assert.equal(economy.reply(command('Alice', 'fish')), 'Alice caught a Common Goldfish and earned 3 Sincoins. Balance: 3');
    assert.equal(economy.reply(command('Alice', 'balance')), 'Alice has 3 Sincoins.');
});

test('buying Minnow Bait unlocks Uncommon catches and deducts its price', t => {
    let rolls = [];
    const { economy } = createEconomy(t, () => rolls.shift() ?? 0);
    for (let catchIndex = 0; catchIndex < 9; catchIndex += 1) economy.reply(command('Alice', 'fish'));

    assert.match(economy.reply(command('Alice', 'buy', 'minnow')), /bought and equipped Minnow Bait for 25 Sincoins/);
    assert.equal(economy.reply(command('Alice', 'bait')), "Alice's bait: Minnow Bait. Owned: Worm Bait, Minnow Bait.");

    rolls = [0.99, 0];
    assert.equal(economy.reply(command('Alice', 'fish')), 'Alice caught a Uncommon Rainbow Trout and earned 12 Sincoins. Balance: 14');
});

test('does not grant or equip bait that the player cannot afford', t => {
    const { economy } = createEconomy(t);

    assert.match(economy.reply(command('Alice', 'buy', 'mythic')), /costs 1000 Sincoins; you have 0/);
    assert.match(economy.reply(command('Alice', 'equip', 'mythic')), /need to buy Mythic Lure first/);
    assert.equal(economy.reply(command('Alice', 'bait')), "Alice's bait: Worm Bait. Owned: Worm Bait.");
});

test('persists balances and bait separately for each player', t => {
    const { economy, storePath } = createEconomy(t);
    for (let catchIndex = 0; catchIndex < 9; catchIndex += 1) economy.reply(command('Alice', 'fish'));
    economy.reply(command('Alice', 'buy', 'Minnow Bait'));

    const restartedEconomy = new FishingEconomy(storePath, () => 0);
    assert.equal(restartedEconomy.reply(command('Alice', 'balance')), 'Alice has 2 Sincoins.');
    assert.equal(restartedEconomy.reply(command('Alice', 'bait')), "Alice's bait: Minnow Bait. Owned: Worm Bait, Minnow Bait.");
    assert.equal(restartedEconomy.reply(command('Bob', 'balance')), 'Bob has 0 Sincoins.');
});

test('shop lists all baits and unknown economy commands stay unhandled', t => {
    const { economy } = createEconomy(t);
    const shop = economy.reply(command('Alice', 'shop'));

    for (const bait of BAITS) assert.ok(shop.includes(bait.name));
    assert.equal(economy.reply(command('Alice', 'unknown')), null);
});

test('work pays for a random job once per hour', t => {
    let now = 0;
    const rolls = [0, 0, 0.999, 0.999];
    const { economy } = createEconomy(t, () => rolls.shift() ?? 0, () => now);

    assert.equal(economy.reply(command('Alice', 'work')), 'Alice worked as a delivery driver and earned 25 Sincoins. Balance: 25');
    assert.equal(economy.reply(command('Alice', 'work')), 'Alice, you can work again in 60 minutes');
    assert.equal(economy.reply(command('Alice', 'balance')), 'Alice has 25 Sincoins.');

    now += 60 * 60 * 1000;
    assert.equal(economy.reply(command('Alice', 'work')), 'Alice worked as a gardener and earned 48 Sincoins. Balance: 73');
});

test('daily and beg rewards have separate cooldowns per player', t => {
    let now = 1;
    const { economy } = createEconomy(t, () => 0, () => now);

    assert.equal(economy.reply(command('Alice', 'daily')), 'Alice collected 100 Sincoins. Balance: 100');
    assert.equal(economy.reply(command('Alice', 'daily')), 'Alice, you can collect a daily reward again in 1440 minutes');
    assert.equal(economy.reply(command('Alice', 'beg')), 'Alice asked around and received 5 Sincoins. Balance: 105');
    assert.equal(economy.reply(command('Alice', 'beg')), 'Alice, you can beg again in 30 minutes');
    assert.equal(economy.reply(command('Bob', 'beg')), 'Bob asked around and received 5 Sincoins. Balance: 5');
});

test('work cooldown survives a restart', t => {
    let now = 1000;
    const { economy, storePath } = createEconomy(t, () => 0, () => now);
    economy.reply(command('Alice', 'work'));

    now += 1000;
    const restartedEconomy = new FishingEconomy(storePath, () => 0, () => now);
    assert.equal(restartedEconomy.reply(command('Alice', 'work')), 'Alice, you can work again in 60 minutes');
});