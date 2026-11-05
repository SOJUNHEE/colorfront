import {
    ClientMessage,
    InputButton,
    MAX_PLAYERS_PER_ROOM,
    MatchFlow,
    MatchSimulation,
    NEON_TERMINAL,
    PLAYER_MAX_HP,
    RECONNECT_GRACE_SECONDS,
    ServerMessage,
    TICK_RATE,
    encodePaintDelta,
    encodePaintSnapshot,
    finalizeRound,
    flowTiming,
    packShot,
    packVec
} from '@colorfront/shared';
import type {
    EventsMessage,
    FlowChange,
    HelloMessage,
    MatchEvent,
    MatchTiming,
    NetEvent,
    PaintHashMessage,
    PlayerInput,
    PlayerState,
    RoundResultMessage,
    TeamId
} from '@colorfront/shared';
import { Room } from '@colyseus/core';
import { StateView } from '@colyseus/schema';
import type { Client } from '@colyseus/core';

import { TickMetrics } from '../metrics.ts';
import { MatchState, NetPlayer } from '../schema.ts';
import { parseInput, sanitizeName } from '../security.ts';

/**
 * Input pacing (D-016). Every client input is simulated exactly once, in order, so the server ends
 * where the client predicted. A player earns one input credit per tick (capped), and each simulated
 * input costs one: inputs that arrive late in a burst (frame hitch, jitter) are caught up at up to
 * INPUT_MAX_PER_TICK per tick, but over time nobody moves faster than real time.
 */
const INPUT_CREDIT_CAP = 10;
const INPUT_MAX_PER_TICK = 3;
/** Inputs buffered per client (1 s). Beyond that the oldest are dropped: a client sending faster
 * than real time only fills its own queue. */
const INPUT_QUEUE_LIMIT = TICK_RATE;
/** Paint deltas are batched every N ticks (GDD 6.3: 50–100 ms). */
const PAINT_DELTA_EVERY = 2;
/** Clients get the full paint hash this often to verify their copy. */
const PAINT_HASH_EVERY = TICK_RATE * 2;

export type MatchRoomOptions = {
    /** Development/test only: shorter phase timings. Ignored when NODE_ENV=production. */
    timing?: Partial<MatchTiming>;
    minPlayers?: number;
};

type Session = {
    queue: PlayerInput[];
    last: PlayerInput | null;
    lastSeq: number;
    /** Simulated inputs this player may still use (see INPUT_CREDIT_CAP). */
    credits: number;
};

/**
 * Authoritative match room (GDD 7). Clients send only inputs; the shared MatchSimulation
 * decides movement, hits, splats and paint. State (players, phase, clock, scores) replicates
 * through Schema patches; paint and one-off events through messages.
 */
export class MatchRoom extends Room<{ state: MatchState }> {
    maxClients = MAX_PLAYERS_PER_ROOM;
    /** 30 inputs/s plus ready/resync/metrics, with headroom for jitter bursts. */
    maxMessagesPerSecond = 90;

    sim!: MatchSimulation;
    flow!: MatchFlow;
    readonly metrics = new TickMetrics();
    private readonly sessions = new Map<string, Session>();
    private paintSeq = 0;
    /** Room ticks since creation (advances in every phase, unlike sim.tick). */
    private roomTick = 0;
    private pendingEvents: NetEvent[] = [];

    onCreate(options: MatchRoomOptions = {}) {
        const dev = process.env.NODE_ENV !== 'production';
        const timing = dev && options.timing ? options.timing : {};
        const minPlayers = dev && options.minPlayers ? Math.max(1, Math.floor(options.minPlayers)) : undefined;
        this.sim = new MatchSimulation(NEON_TERMINAL);
        this.flow = new MatchFlow(flowTiming(timing), minPlayers);
        const state = new MatchState();
        state.phase = this.flow.phase;
        state.round = this.flow.round;
        state.paintable = this.sim.paint.paintableCount;
        // Schema numbers start undefined; the first full state is sent before the first tick.
        state.tick = 0;
        state.ticksLeft = 0;
        state.blue = 0;
        state.orange = 0;
        state.winner = '';
        this.setState(state);
        this.setPatchRate(50);

        this.onMessage(ClientMessage.Input, (client, raw) => this.onInput(client, raw));
        this.onMessage(ClientMessage.Ready, (client, ready) => {
            const p = this.state.players.get(client.sessionId);
            if (p && this.flow.phase === 'WAITING') p.ready = ready === true;
        });
        this.onMessage(ClientMessage.PaintResync, (client) => this.sendSnapshot(client));
        this.onMessage('metrics', (client) => client.send('metrics', this.metricsSnapshot()));
        // Anything else (forged "damage"/"paint"/position messages, old clients) is dropped and counted.
        this.onMessage('*', () => this.metrics.rejected++);

        this.setFixedTimestep(() => this.safeStep(), TICK_RATE);
    }

    onJoin(client: Client, options: { name?: unknown } = {}) {
        const team = this.pickTeam();
        const name = sanitizeName(options?.name, client.sessionId);
        const state = this.sim.addPlayer(client.sessionId, team);
        const net = new NetPlayer();
        net.name = name;
        net.team = team;
        net.connected = true;
        net.ready = false;
        net.kills = 0;
        net.deaths = 0;
        net.painted = 0;
        this.writePlayer(net, state);
        this.state.players.set(client.sessionId, net);
        this.giveOwnerView(client);
        this.sessions.set(client.sessionId, { queue: [], last: null, lastSeq: 0, credits: 1 });
        this.greet(client);
    }

    onDrop(client: Client) {
        const p = this.state.players.get(client.sessionId);
        if (p) p.connected = false;
        // GDD 7.5: keep the seat for 30 s; the player stays in the world, idle.
        this.allowReconnection(client, RECONNECT_GRACE_SECONDS);
    }

    onReconnect(client: Client) {
        const p = this.state.players.get(client.sessionId);
        if (p) p.connected = true;
        this.giveOwnerView(client);
        const s = this.sessions.get(client.sessionId);
        if (s) s.queue.length = 0;
        this.greet(client);
    }

    onLeave(client: Client) {
        this.sim.removePlayer(client.sessionId);
        this.state.players.delete(client.sessionId);
        this.sessions.delete(client.sessionId);
    }

    /** The owner (only) receives its player's prediction fields (`.view()` in the schema). */
    private giveOwnerView(client: Client) {
        const net = this.state.players.get(client.sessionId);
        if (!net) return;
        client.view = new StateView();
        client.view.add(net);
    }

    private greet(client: Client) {
        const hello: HelloMessage = {
            sessionId: client.sessionId,
            mapId: NEON_TERMINAL.id,
            tickRate: TICK_RATE,
            patchRateMs: this.patchRate ?? 50,
            serverTime: Date.now()
        };
        client.send(ServerMessage.Hello, hello);
        this.sendSnapshot(client);
    }

    private sendSnapshot(client: Client) {
        client.sendBytes(ServerMessage.PaintSnapshot, encodePaintSnapshot(this.sim.paint, this.paintSeq));
    }

    /** Fewer players first; ties go to blue. Keeps teams within one player (GDD 7.1). */
    private pickTeam(): TeamId {
        let blue = 0;
        let orange = 0;
        this.state.players.forEach((p) => (p.team === 'blue' ? blue++ : orange++));
        return orange < blue ? 'orange' : 'blue';
    }

    private onInput(client: Client, raw: unknown) {
        const s = this.sessions.get(client.sessionId);
        const input = parseInput(raw);
        if (!s || !input) {
            this.metrics.rejected++;
            return;
        }
        if (input.seq <= s.lastSeq) return; // duplicate or out of order
        s.lastSeq = input.seq;
        s.queue.push(input);
        if (s.queue.length > INPUT_QUEUE_LIMIT) s.queue.splice(0, s.queue.length - INPUT_QUEUE_LIMIT);
    }

    private takeInput(s: Session): PlayerInput | null {
        if (s.queue.length === 0 || s.credits < 1) return null;
        s.credits--;
        const next = s.queue.shift()!;
        s.last = next;
        return next;
    }

    /** A bug in one tick must not take the whole server (every room) down; log it and go on. */
    private safeStep() {
        try {
            this.step();
        } catch (err) {
            this.metrics.errors++;
            if (this.metrics.errors <= 5 || this.metrics.errors % 100 === 0) {
                console.error(`[room ${this.roomId}] tick ${this.sim.tick} failed (#${this.metrics.errors}):`, err);
            }
        }
    }

    private step() {
        const t0 = performance.now();
        this.roomTick++;
        let players = 0;
        let ready = 0;
        this.state.players.forEach((p) => {
            if (!p.connected) return;
            players++;
            if (p.ready) ready++;
        });
        const change = this.flow.step(players, ready);
        if (change) this.onPhaseChange(change);

        if (this.flow.acceptsInput) {
            for (const s of this.sessions.values()) s.credits = Math.min(INPUT_CREDIT_CAP, s.credits + 1);
            const inputs = new Map<string, PlayerInput>();
            for (const [sid, s] of this.sessions) {
                const next = this.takeInput(s);
                if (next) inputs.set(sid, next);
                else if (s.last) {
                    // Nothing arrived for this tick (jitter, stalled or hidden tab, dead link): the
                    // player stands still looking the same way. Held buttons stay held (no fake new
                    // jump/dash edges) but nobody keeps firing on a frozen client's behalf.
                    inputs.set(sid, { ...s.last, moveX: 0, moveZ: 0, buttons: s.last.buttons & ~InputButton.Fire });
                }
            }
            for (const e of this.sim.step(inputs)) this.collectEvent(e);
            // Catch-up: late inputs of this tick's bursts, paid for with saved credits.
            for (let extra = 1; extra < INPUT_MAX_PER_TICK; extra++) {
                const more = new Map<string, PlayerInput>();
                for (const [sid, s] of this.sessions) {
                    const next = this.takeInput(s);
                    if (next) more.set(sid, next);
                }
                if (more.size === 0) break;
                for (const e of this.sim.stepExtra(more)) this.collectEvent(e);
            }
        } else {
            // Frozen phases: acknowledge and discard inputs so client prediction stays aligned.
            for (const [sid, s] of this.sessions) {
                const p = this.sim.get(sid);
                if (p && s.queue.length) p.lastProcessedSeq = s.queue[s.queue.length - 1].seq;
                s.queue.length = 0;
                if (p) p.lastButtons = 0;
            }
        }

        this.syncState();

        if (this.pendingEvents.length) {
            const msg: EventsMessage = { tick: this.sim.tick, ev: this.pendingEvents };
            this.broadcast(ServerMessage.Events, msg);
            this.pendingEvents = [];
        }
        if (this.roomTick % PAINT_DELTA_EVERY === 0 || change) this.flushPaint();
        if (this.roomTick % PAINT_HASH_EVERY === 0) {
            const score = this.sim.paint.score();
            const msg: PaintHashMessage = { seq: this.paintSeq, hash: this.sim.paint.hash(), blue: score.blue, orange: score.orange, paintable: score.paintable };
            this.broadcast(ServerMessage.PaintHash, msg);
        }
        this.metrics.record(performance.now() - t0, players);
    }

    /** Whole-grid change (round reset): one small RLE snapshot beats a full-grid delta. */
    private broadcastSnapshot() {
        this.sim.paint.discardDirty();
        this.paintSeq++;
        const bytes = encodePaintSnapshot(this.sim.paint, this.paintSeq);
        this.broadcastBytes(ServerMessage.PaintSnapshot, bytes, {});
        this.metrics.paintBytes += bytes.length;
    }

    private flushPaint() {
        const bytes = encodePaintDelta(this.sim.paint, this.paintSeq + 1, this.sim.tick);
        if (!bytes) return;
        this.paintSeq++;
        this.broadcastBytes(ServerMessage.PaintDelta, bytes, {});
        this.metrics.paintBytes += bytes.length;
    }

    private onPhaseChange(change: FlowChange) {
        if (change.to === 'COUNTDOWN') {
            // New round: clean paint, everyone back to their spawn, frozen until PLAYING.
            this.sim.resetRound();
            this.state.winner = '';
            this.broadcastSnapshot();
        }
        if (change.to === 'RESULTS') {
            // D-001: the score is frozen the instant PLAYING ends.
            const result = finalizeRound(this.sim.paint.score());
            this.state.winner = result.winner;
            const msg: RoundResultMessage = {
                round: change.round,
                paintable: result.paintable,
                blue: result.blue,
                orange: result.orange,
                winner: result.winner,
                hash: this.sim.paint.hash(),
                players: []
            };
            this.state.players.forEach((p, id) => {
                const st = this.sim.stats.get(id);
                msg.players.push({ id, name: p.name, team: p.team as TeamId, painted: st?.painted ?? 0, kills: st?.kills ?? 0, deaths: st?.deaths ?? 0 });
            });
            this.broadcast(ServerMessage.RoundResult, msg);
        }
        if (change.to === 'WAITING') {
            this.state.players.forEach((p) => (p.ready = false));
        }
    }

    private collectEvent(e: MatchEvent) {
        switch (e.type) {
            case 'shot':
                this.pendingEvents.push(packShot(e.playerId, e.shot));
                break;
            case 'hit':
                this.pendingEvents.push({ t: 'h', a: e.attackerId, v: e.targetId, dmg: e.damage, at: packVec(e.at) });
                break;
            case 'splat':
                this.pendingEvents.push({ t: 'k', a: e.attackerId, v: e.targetId, team: e.team, at: packVec(e.at) });
                break;
            case 'respawn':
                this.pendingEvents.push({ t: 'r', p: e.playerId });
                break;
            default:
                break;
        }
    }

    private writePlayer(net: NetPlayer, s: PlayerState) {
        net.x = s.position.x;
        net.y = s.position.y;
        net.z = s.position.z;
        net.vx = s.velocity.x;
        net.vy = s.velocity.y;
        net.vz = s.velocity.z;
        net.yaw = s.yaw;
        net.pitch = s.pitch;
        net.grounded = s.grounded;
        net.alive = s.alive;
        net.hp = Math.max(0, Math.min(PLAYER_MAX_HP, Math.round(s.hp)));
        net.ammo = s.ammo;
        net.reload = s.reloadTicksRemaining;
        net.fireCd = s.fireCooldownTicks;
        net.dash = s.dashTicksRemaining;
        net.dashCd = s.dashCooldownTicks;
        net.dashX = s.dashDirX;
        net.dashZ = s.dashDirZ;
        net.buttons = s.lastButtons;
        net.seq = s.lastProcessedSeq;
        net.invuln = s.invulnerableTicks;
        net.respawn = s.respawnTicks;
        net.team = s.team;
    }

    private syncState() {
        const st = this.state;
        st.phase = this.flow.phase;
        st.round = this.flow.round;
        st.tick = this.sim.tick;
        st.ticksLeft = this.flow.ticksLeft;
        const score = this.sim.paint.score();
        st.blue = score.blue;
        st.orange = score.orange;
        st.paintable = score.paintable;
        st.players.forEach((net, id) => {
            const s = this.sim.get(id);
            if (!s) return;
            this.writePlayer(net, s);
            const stats = this.sim.stats.get(id);
            if (stats) {
                net.kills = stats.kills;
                net.deaths = stats.deaths;
                net.painted = stats.painted;
            }
        });
    }

    metricsSnapshot() {
        return {
            roomId: this.roomId,
            clients: this.clients.length,
            phase: this.flow.phase,
            tick: this.sim.tick,
            paintSeq: this.paintSeq,
            paintHash: this.sim.paint.hash(),
            ...this.metrics.summary(),
            memoryMB: Math.round(process.memoryUsage().rss / 1048576)
        };
    }
}
