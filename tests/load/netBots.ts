/**
 * Network load test (Phase 4/5): N real Colyseus SDK clients join one room on a running game
 * server and play a full round with SimpleBot brains. They send only inputs, exactly like the
 * browser client; each keeps its own paint grid built from server snapshots/deltas.
 *
 *   npm run start:server            # in another terminal
 *   npm run load -- --players 30 --seconds 60
 *
 * Reports server tick time (from /metrics), memory, per-client bandwidth, ping, and whether every
 * client's paint grid ends identical to the server's (hash) with the same round result.
 * Local bots in the browser are a separate, render-only tool; these are network players.
 */
import {
    ClientMessage,
    MatchSimulation,
    NEON_TERMINAL,
    PaintGrid,
    PaintReceiver,
    ROOM_NAME,
    ServerMessage,
    SimpleBot,
    TICK_RATE,
    createPlayerState
} from '@colorfront/shared';
import type { PaintHashMessage, PlayerState, RoundResultMessage, TeamId } from '@colorfront/shared';
import { Client } from '@colyseus/sdk';
import type { Room } from '@colyseus/sdk';

type Args = { players: number; seconds: number; url: string; http: string; extra: number };

function parseArgs(): Args {
    const a = process.argv.slice(2);
    const get = (k: string, d: string) => {
        const i = a.indexOf(`--${k}`);
        return i >= 0 && a[i + 1] ? a[i + 1] : d;
    };
    const url = get('url', 'ws://127.0.0.1:2567');
    return {
        players: Math.max(2, Math.min(30, Number(get('players', '8')))),
        seconds: Math.max(10, Number(get('seconds', '60'))),
        url,
        http: url.replace(/^ws/, 'http'),
        /** Real players (e.g. a browser) the round should also wait for. */
        extra: Math.max(0, Number(get('extra', '0')))
    };
}

const KINDS: Record<number, string> = { 13: 'messages (events, hash, result)', 14: 'full state', 15: 'state patches', 17: 'paint (binary)' };

const view = new MatchSimulation(NEON_TERMINAL); // read-only world for the bot brains

class NetBot {
    readonly brain: SimpleBot;
    readonly paint = new PaintGrid(view.world, NEON_TERMINAL);
    readonly receiver = new PaintReceiver(this.paint);
    room!: Room;
    seq = 0;
    bytesIn = 0;
    bytesOut = 0;
    /** Received bytes by Colyseus protocol code: 13 messages, 14 full state, 15 patches, 17 binary. */
    readonly bytesByKind: Record<string, number> = {};
    rtt: number[] = [];
    result: RoundResultMessage | null = null;
    lastHash: PaintHashMessage | null = null;
    hashChecks = 0;
    hashMismatches = 0;
    readonly name: string;
    readonly index: number;

    constructor(index: number) {
        this.index = index;
        this.name = `Load-${String(index).padStart(2, '0')}`;
        this.brain = new SimpleBot(this.name, 7000 + index);
    }

    async join(url: string, roomId: string | null, players: number, seconds: number) {
        const client = new Client(url);
        const options = roomId
            ? { name: this.name }
            : {
                  name: this.name,
                  minPlayers: players,
                  timing: { countdownSeconds: 3, playingSeconds: seconds, resultsRevealSeconds: 2, resultsSummarySeconds: 5 }
              };
        this.room = roomId ? await client.joinById(roomId, options) : await client.create(ROOM_NAME, options);
        const events = this.room.connection.events as { onmessage?: (ev: { data: ArrayBuffer | Uint8Array }) => void };
        const original = events.onmessage;
        if (original) {
            events.onmessage = (ev) => {
                this.bytesIn += ev.data.byteLength;
                const code = new Uint8Array(ev.data instanceof ArrayBuffer ? ev.data : ev.data.buffer, ev.data instanceof ArrayBuffer ? 0 : ev.data.byteOffset, 1)[0];
                const kind = KINDS[code & 0x3f] ?? `code${code}`;
                this.bytesByKind[kind] = (this.bytesByKind[kind] ?? 0) + ev.data.byteLength;
                original(ev);
            };
        }
        const onPaint = (b: Uint8Array) => {
            if (this.receiver.receive(b) === 'gap') this.room.send(ClientMessage.PaintResync);
        };
        this.room.onMessage(ServerMessage.PaintSnapshot, onPaint);
        this.room.onMessage(ServerMessage.PaintDelta, onPaint);
        this.room.onMessage(ServerMessage.PaintHash, (m: PaintHashMessage) => {
            this.lastHash = m;
            if (this.receiver.seq !== m.seq || this.receiver.resyncing) return;
            this.hashChecks++;
            if (this.paint.hash() !== m.hash) this.hashMismatches++;
        });
        this.room.onMessage(ServerMessage.RoundResult, (m: RoundResultMessage) => (this.result = m));
        for (const t of [ServerMessage.Hello, ServerMessage.Events, 'metrics']) this.room.onMessage(t, () => undefined);
        return this.room.roomId;
    }

    get state(): any {
        return this.room.state;
    }

    send(input: [number, number, number, number, number, number]) {
        this.room.send(ClientMessage.Input, input);
        this.bytesOut += 24; // 6 numbers, msgpack-encoded ≈ 20–28 bytes plus framing
    }
}

/** Copy the replicated players into the shared view so every brain sees the same world. */
function syncView(source: NetBot) {
    view.players.length = 0;
    source.state.players.forEach((p: any, id: string) => {
        const s: PlayerState = createPlayerState(id, p.team as TeamId);
        s.position = { x: p.x, y: p.y, z: p.z };
        s.velocity = { x: p.vx ?? 0, y: p.vy ?? 0, z: p.vz ?? 0 };
        s.yaw = p.yaw;
        s.pitch = p.pitch;
        s.grounded = p.grounded;
        s.alive = p.alive;
        s.hp = p.hp;
        s.ammo = p.ammo;
        s.reloadTicksRemaining = p.reload;
        s.dashCooldownTicks = p.dashCd ?? 0;
        s.invulnerableTicks = p.invuln ?? 0;
        view.players.push(s);
    });
    view.tick = source.state.tick ?? 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (xs: number[], q: number) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * q))];
};

async function serverRoom(http: string, roomId: string) {
    const m = (await (await fetch(`${http}/metrics`)).json()) as { rooms: any[]; memoryMB: number };
    return { room: m.rooms.find((r: any) => r.roomId === roomId), memoryMB: m.memoryMB };
}

async function main() {
    const args = parseArgs();
    console.log(`[load] ${args.players} network bots → ${args.url}, round ${args.seconds}s`);
    const bots = Array.from({ length: args.players }, (_, i) => new NetBot(i + 1));
    const roomId = await bots[0].join(args.url, null, args.players + args.extra, args.seconds);
    for (const b of bots.slice(1)) await b.join(args.url, roomId, args.players, args.seconds);
    await sleep(500);
    const teams = { blue: 0, orange: 0 };
    bots[0].state.players.forEach((p: any) => teams[p.team as TeamId]++);
    console.log(`[load] room ${roomId}: ${bots[0].state.players.size} players (${teams.blue} blue / ${teams.orange} orange)`);
    if (args.extra) console.log(`[load] waiting for ${args.extra} more player(s): ?mode=online&room=${roomId}`);
    for (const b of bots) b.room.send(ClientMessage.Ready, true);

    // 30 Hz input loop for every bot (drift-free schedule).
    const samples: any[] = [];
    let running = true;
    const t0 = performance.now();
    let tick = 0;
    const loop = async () => {
        while (running) {
            tick++;
            syncView(bots[0]);
            for (const b of bots) {
                const me = b.state.players.get(b.room.sessionId);
                const self = view.players.find((p) => p.id === b.room.sessionId);
                if (!me || !self) continue;
                const input = me.alive ? b.brain.think(self, view) : { moveX: 0, moveZ: 0, yaw: self.yaw, pitch: 0, buttons: 0 };
                b.send([++b.seq, input.moveX, input.moveZ, input.yaw, input.pitch, input.buttons]);
            }
            if (tick % TICK_RATE === 0) for (const b of bots) b.room.ping((ms) => b.rtt.push(ms));
            const next = t0 + (tick * 1000) / TICK_RATE;
            await sleep(Math.max(0, next - performance.now()));
        }
    };
    const loopDone = loop();

    // Sample server metrics every 5 s until the round result arrives everywhere.
    const deadline = Date.now() + (args.seconds + 30 + args.extra * 60) * 1000;
    let phaseSeen = '';
    while (Date.now() < deadline) {
        await sleep(5000);
        const s = await serverRoom(args.http, roomId);
        const phase = bots[0].state.phase;
        if (phase !== phaseSeen) {
            console.log(`[load] phase ${phase}`);
            phaseSeen = phase;
        }
        if (s.room) samples.push({ t: Math.round((performance.now() - t0) / 1000), phase, ...s.room, memoryMB: s.memoryMB });
        if (bots.every((b) => b.result)) break;
    }
    running = false;
    await loopDone;
    await sleep(800); // last deltas

    const s = await serverRoom(args.http, roomId);
    const elapsed = (performance.now() - t0) / 1000;
    const hashes = new Set(bots.map((b) => b.paint.hash()));
    const results = new Set(bots.map((b) => JSON.stringify(b.result)));
    const rtts = bots.flatMap((b) => b.rtt);
    const inKBs = bots.map((b) => b.bytesIn / 1024 / elapsed);
    const playing = samples.filter((x) => x.phase === 'PLAYING');
    const summary = {
        players: args.players,
        roundSeconds: args.seconds,
        elapsedSec: +elapsed.toFixed(1),
        server: {
            tickAvgMs: s.room?.tickAvgMs,
            tickP95Ms: s.room?.tickP95Ms,
            tickMaxMs: s.room?.tickMaxMs,
            overruns: s.room?.overruns,
            tickErrors: s.room?.tickErrors,
            rejectedMessages: s.room?.rejectedMessages,
            paintBytesTotal: s.room?.paintBytesTotal,
            memoryMB: s.memoryMB,
            playingSamples: playing.map((x) => ({ t: x.t, avg: x.tickAvgMs, p95: x.tickP95Ms, mem: x.memoryMB }))
        },
        perClient: {
            downKBps: { avg: +(inKBs.reduce((a, b) => a + b, 0) / inKBs.length).toFixed(2), max: +Math.max(...inKBs).toFixed(2) },
            upKBpsEstimate: +((bots[0].bytesOut / 1024) / elapsed).toFixed(2),
            downBreakdownKBps: Object.fromEntries(Object.entries(bots[0].bytesByKind).map(([k, v]) => [k, +(v / 1024 / elapsed).toFixed(2)])),
            rttMs: { p50: +pct(rtts, 0.5).toFixed(1), p95: +pct(rtts, 0.95).toFixed(1), max: +Math.max(0, ...rtts).toFixed(1) }
        },
        consistency: {
            distinctClientHashes: hashes.size,
            clientHashEqualsServer: hashes.size === 1 && [...hashes][0] === s.room?.paintHash,
            identicalResults: results.size === 1 && bots[0].result !== null,
            hashChecks: bots.reduce((n, b) => n + b.hashChecks, 0),
            hashMismatches: bots.reduce((n, b) => n + b.hashMismatches, 0),
            paintGaps: bots.reduce((n, b) => n + b.receiver.gaps, 0)
        },
        result: bots[0].result && {
            winner: bots[0].result.winner,
            bluePct: +((100 * bots[0].result.blue) / bots[0].result.paintable).toFixed(2),
            orangePct: +((100 * bots[0].result.orange) / bots[0].result.paintable).toFixed(2),
            kills: bots[0].result.players.reduce((n, p) => n + p.kills, 0)
        }
    };
    console.log(JSON.stringify(summary, null, 2));
    for (const b of bots) await b.room.leave(true).catch(() => undefined);
    process.exit(summary.consistency.clientHashEqualsServer && summary.consistency.identicalResults ? 0 : 1);
}

main().catch((err) => {
    console.error(err);
    process.exit(2);
});
