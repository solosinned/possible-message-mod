const fs = require('node:fs');
const path = require('node:path');

const BAITS = [
    { id: 'worm', name: 'Worm Bait', price: 0, weights: [100] },
    { id: 'minnow', name: 'Minnow Bait', price: 25, weights: [70, 30] },
    { id: 'glow', name: 'Glow Lure', price: 85, weights: [48, 37, 15] },
    { id: 'golden', name: 'Golden Bait', price: 275, weights: [25, 34, 27, 14] },
    { id: 'mythic', name: 'Mythic Lure', price: 1000, weights: [15, 22, 26, 20, 12, 5] }
];

const FISH_BY_RARITY = [
    [
        { name: 'Goldfish', value: 3 }, { name: 'Bluegill', value: 4 },
        { name: 'Minnow', value: 5 }, { name: 'Carp', value: 6 },
        { name: 'Guppy', value: 4 }, { name: 'Perch', value: 7 }
    ],
    [
        { name: 'Rainbow Trout', value: 12 }, { name: 'Catfish', value: 14 },
        { name: 'Koi', value: 16 }, { name: 'Angelfish', value: 18 },
        { name: 'Lionfish', value: 19 }, { name: 'Mackerel', value: 15 }
    ],
    [
        { name: 'Stingray', value: 30 }, { name: 'Octopus', value: 34 },
        { name: 'Piranha', value: 28 }, { name: 'Electric Eel', value: 38 },
        { name: 'Seahorse', value: 40 }, { name: 'Lobster', value: 44 }
    ],
    [
        { name: 'Swordfish', value: 75 }, { name: 'Manta Ray', value: 85 },
        { name: 'Hammerhead Shark', value: 90 }, { name: 'Oarfish', value: 105 },
        { name: 'Jellyfish', value: 70 }, { name: 'Sea Turtle', value: 95 }
    ],
    [
        { name: 'Golden Koi', value: 220 }, { name: 'Blue Whale', value: 260 },
        { name: 'Kraken', value: 300 }, { name: 'Moon Jelly', value: 200 },
        { name: 'Leviathan', value: 400 }, { name: 'Star Serpent', value: 350 }
    ],
    [
        { name: 'Cosmic Coelacanth', value: 700 }, { name: 'Abyssal Dragonfish', value: 850 },
        { name: 'Prism Phoenix Fish', value: 1000 }, { name: 'Eternal Goldfish', value: 1250 },
        { name: 'Nebula Narwhal', value: 1100 }, { name: 'The Big One', value: 1500 }
    ]
];

const RARITIES = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary', 'Mythic'];
const WORK_JOBS = [
    { name: 'delivery driver', min: 25, max: 55 },
    { name: 'cashier', min: 20, max: 45 },
    { name: 'dog walker', min: 22, max: 50 },
    { name: 'tutor', min: 35, max: 70 },
    { name: 'mechanic', min: 30, max: 65 },
    { name: 'gardener', min: 20, max: 48 }
];
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const HALF_HOUR_MS = 30 * 60 * 1000;
const ECONOMY_COMMANDS = new Set([
    'fish', 'balance', 'wallet', 'shop', 'bait', 'buy', 'equip', 'work', 'daily', 'beg'
]);

function weightedChoice(options, random) {
    const total = options.reduce((sum, option) => sum + option.weight, 0);
    let roll = random() * total;
    for (const option of options) {
        roll -= option.weight;
        if (roll < 0) return option.value;
    }
    return options[options.length - 1].value;
}

function normalizeBait(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

class FishingEconomy {
    constructor(storePath = path.join(__dirname, '.sincoins.json'), random = Math.random, now = Date.now) {
        this.storePath = storePath;
        this.random = random;
        this.now = now;
        this.players = Object.create(null);
        this.load();
    }

    reply(message) {
        if (!message || !ECONOMY_COMMANDS.has((message.command || '').toLowerCase())) return null;

        const username = message.username;
        const player = this.getPlayer(username);
        const command = message.command.toLowerCase();
        if (command === 'fish') return this.catchFish(username, player);
        if (command === 'balance' || command === 'wallet') {
            return `${username} has ${player.sincoins} Sincoins.`;
        }
        if (command === 'shop') {
            const listings = BAITS.map(bait => `${bait.name}: ${bait.price || 'free'}`).join(' | ');
            return `Bait shop (Sincoins): ${listings}. Buy with s.buy <bait>.`;
        }
        if (command === 'bait') {
            const owned = player.ownedBaits.map(id => this.findBait(id).name).join(', ');
            return `${username}'s bait: ${this.findBait(player.equippedBait).name}. Owned: ${owned}.`;
        }
        if (command === 'buy') return this.buyBait(username, player, message.args);
        if (command === 'equip') return this.equipBait(username, player, message.args);
        if (command === 'work') return this.work(username, player);
        if (command === 'daily') return this.daily(username, player);
        if (command === 'beg') return this.beg(username, player);
        return null;
    }

    getPlayer(username) {
        const key = String(username).toLowerCase();
        if (!this.players[key]) {
            this.players[key] = {
                sincoins: 0, ownedBaits: ['worm'], equippedBait: 'worm', workAt: null, dailyAt: null, begAt: null
            };
        }
        return this.players[key];
    }

    catchFish(username, player) {
        const bait = this.findBait(player.equippedBait);
        const rarityOptions = bait.weights.map((weight, index) => ({
            weight,
            value: index
        }));
        const rarityIndex = weightedChoice(rarityOptions, this.random);
        const fish = FISH_BY_RARITY[rarityIndex][Math.floor(this.random() * FISH_BY_RARITY[rarityIndex].length)];
        player.sincoins += fish.value;
        this.save();
        return `${username} caught a ${RARITIES[rarityIndex]} ${fish.name} and earned ${fish.value} Sincoins. Balance: ${player.sincoins}`;
    }

    work(username, player) {
        const cooldownMessage = this.claimCooldown(username, player, 'workAt', HOUR_MS, 'work');
        if (cooldownMessage) return cooldownMessage;

        const job = WORK_JOBS[Math.floor(this.random() * WORK_JOBS.length)];
        const reward = Math.floor(this.random() * (job.max - job.min + 1)) + job.min;
        player.sincoins += reward;
        this.save();
        return `${username} worked as a ${job.name} and earned ${reward} Sincoins. Balance: ${player.sincoins}`;
    }

    daily(username, player) {
        const cooldownMessage = this.claimCooldown(username, player, 'dailyAt', DAY_MS, 'collect a daily reward');
        if (cooldownMessage) return cooldownMessage;

        const reward = Math.floor(this.random() * 101) + 100;
        player.sincoins += reward;
        this.save();
        return `${username} collected ${reward} Sincoins. Balance: ${player.sincoins}`;
    }

    beg(username, player) {
        const cooldownMessage = this.claimCooldown(username, player, 'begAt', HALF_HOUR_MS, 'beg');
        if (cooldownMessage) return cooldownMessage;

        const reward = Math.floor(this.random() * 16) + 5;
        player.sincoins += reward;
        this.save();
        return `${username} asked around and received ${reward} Sincoins. Balance: ${player.sincoins}`;
    }

    claimCooldown(username, player, key, cooldownMs, action) {
        const now = this.now();
        const availableAt = player[key] + cooldownMs;
        if (player[key] !== null && availableAt > now) {
            const secondsLeft = Math.ceil((availableAt - now) / 1000);
            const timeLeft = secondsLeft >= 60
                ? `${Math.ceil(secondsLeft / 60)} minutes`
                : `${secondsLeft} seconds`;
            return `${username}, you can ${action} again in ${timeLeft}`;
        }
        player[key] = now;
        return null;
    }

    buyBait(username, player, input) {
        const bait = this.resolveBait(input);
        if (!bait) return `${username}, check s.shop for bait. Example: s.buy minnow`;
        if (player.ownedBaits.includes(bait.id)) {
            return `${username}, you already own ${bait.name}. Use s.equip ${bait.id} to switch.`;
        }
        if (player.sincoins < bait.price) {
            return `${username}, ${bait.name} costs ${bait.price} Sincoins; you have ${player.sincoins}.`;
        }
        player.sincoins -= bait.price;
        player.ownedBaits.push(bait.id);
        player.equippedBait = bait.id;
        this.save();
        return `${username} bought and equipped ${bait.name} for ${bait.price} Sincoins. Balance: ${player.sincoins}.`;
    }

    equipBait(username, player, input) {
        const bait = this.resolveBait(input);
        if (!bait) return `${username}, choose bait from s.shop. Example: s.equip minnow`;
        if (!player.ownedBaits.includes(bait.id)) {
            return `${username}, you need to buy ${bait.name} first with s.buy ${bait.id}.`;
        }
        player.equippedBait = bait.id;
        this.save();
        return `${username} equipped ${bait.name}.`;
    }

    findBait(id) {
        return BAITS.find(bait => bait.id === id) || BAITS[0];
    }

    resolveBait(input) {
        const normalized = normalizeBait(input);
        return BAITS.find(bait => normalizeBait(bait.id) === normalized
            || normalizeBait(bait.name) === normalized) || null;
    }

    load() {
        let data;
        try {
            data = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
        } catch (error) {
            if (error.code === 'ENOENT') return;
            throw error;
        }
        if (!data || data.version !== 1 || !data.players || typeof data.players !== 'object') {
            throw new Error(`Sincoins data file is invalid: ${this.storePath}`);
        }
        for (const [username, player] of Object.entries(data.players)) {
            if (!player || !Number.isSafeInteger(player.sincoins) || player.sincoins < 0) continue;
            const ownedBaits = Array.isArray(player.ownedBaits)
                ? [...new Set(player.ownedBaits.filter(id => BAITS.some(bait => bait.id === id)))]
                : [];
            if (!ownedBaits.includes('worm')) ownedBaits.unshift('worm');
            const equippedBait = ownedBaits.includes(player.equippedBait) ? player.equippedBait : 'worm';
            const timestamp = key => Number.isSafeInteger(player[key]) && player[key] >= 0 ? player[key] : null;
            this.players[username.toLowerCase()] = {
                sincoins: player.sincoins,
                ownedBaits,
                equippedBait,
                workAt: timestamp('workAt'),
                dailyAt: timestamp('dailyAt'),
                begAt: timestamp('begAt')
            };
        }
    }

    save() {
        const temporaryPath = `${this.storePath}.tmp`;
        fs.writeFileSync(temporaryPath, JSON.stringify({ version: 1, players: this.players }), { mode: 0o600 });
        fs.renameSync(temporaryPath, this.storePath);
    }
}

module.exports = { FishingEconomy, BAITS, FISH_BY_RARITY, RARITIES };