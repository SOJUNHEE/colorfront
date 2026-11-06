import {
    ClientMessage,
    LOOK_MIN_INTERVAL_MS,
    PaintReceiver,
    ROOM_NAME,
    ServerMessage,
    TICK_RATE,
    createPlayerState,
    predictPlayer,
    sanitizeInput
} from '@colorfront/shared';
import type {
    CollisionWorld,
    EventsMessage,
    HelloMessage,
    MatchPhase,
    NetEvent,
    PaintGrid,
    PaintHashMessage,
    PlayerInput,
    PlayerState,
    PlayerStepResult,
    RoundResultMessage,
    TeamId
} from '@colorfront/shared';
import { Client } from '@colyseus/sdk';
import type { Room } from '@colyseus/sdk';

/** Remote players are drawn this far in the past so two patches (50 ms apart) bracket them. */
const INTERP_DELAY_MS = 100;
const SNAPSHOT_KEEP = 24;
/** Prediction errors above this snap instead of smoothing (teleport, respawn, round reset). */
const SNAP_DISTANCE = 2.5;
/** Pending inputs kept for replay; anything older is long acknowledged or lost. */
const PENDING_LIMIT = 90;
/** Shot event → paint delta pairs further apart than this are unrelated (diagnostics only). */
const PAINT_DELAY_WINDOW_MS = 1000;
const TOKEN_KEY = 'colorfront.reconnect';
const RECONNECT_ATTEMPTS = 6;
const RECONNECT_RETRY_MS = 500;
/** Colyseus ErrorCode.MATCHMAKE_INVALID_ROOM_ID (the room no longer exists). */
const MATCHMAKE_INVALID_ROOM_ID = 522;

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error';

type Snapshot = { t: number; x: number; y: number; z: number; yaw: number; pitch: number };

/** A player as this client sees it. The local one is predicted; remote ones are interpolated. */
export type NetActor = {
    id: string;
    name: string;
    team: TeamId;
    connected: boolean;
    ready: boolean;
    kills: number;
    deaths: number;
    painted: number;
    /** Cosmetic outfit as replicated by the server (look string, Gate 3-B). */
    look: string;
    state: PlayerState;
    snapshots: Snapshot[];
};

export type RawInput = { moveX: number; moveZ: number; yaw: number; pitch: number; buttons: number };

type NetPlayerLike = {
    look?: string;
    name: string;
    team: string;
    connected: boolean;
    ready: boolean;
    x: number;
    y: number;
    z: number;
    vx?: number;
    vy?: number;
    vz?: number;
    yaw: number;
    pitch: number;
    grounded: boolean;
    alive: boolean;
    hp: number;
    ammo: number;
    reload: number;
    fireCd?: number;
    dash: number;
    dashCd?: number;
    dashX?: number;
    dashZ?: number;
    buttons: number;
    seq?: number;
    invuln?: number;
    respawn?: number;
    kills: number;
    deaths: number;
    painted: number;
};

type MatchStateLike = {
    phase: string;
    round: number;
    tick: number;
    ticksLeft: number;
    blue: number;
    orange: number;
    paintable: number;
    winner: string;
    players: { forEach(cb: (p: NetPlayerLike, id: string) => void): void; get(id: string): NetPlayerLike | undefined };
};

const lerpAngle = (a: number, b: number, t: number) => {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
};

export function defaultServerUrl(): string {
    const env = import.meta.env.VITE_SERVER_URL as string | undefined;
    if (import.meta.env.DEV) {
        const override = new URLSearchParams(location.search).get('server');
        if (override && /^wss?:\/\//.test(override)) return override;
    }
    if (env) return env;
    const secure = location.protocol === 'https:';
    return `${secure ? 'wss' : 'ws'}://${location.hostname || 'localhost'}:2567`;
}

/**
 * Client side of the authoritative match (GDD 7). Sends only inputs; predicts the local player
 * with the shared simulation (movement, weapon timing, paint speed from the server's grid);
 * reconciles with every Schema patch; interpolates everyone else ~100 ms in the past. The paint
 * grid is written exclusively from server snapshots/deltas.
 */
export class OnlineSession {
    readonly paint: PaintGrid;
    readonly receiver: PaintReceiver;
    private readonly world: CollisionWorld;
    private client: Client | null = null;
    room: Room | null = null;

    status: ConnectionStatus = 'idle';
    error = '';
    /** Last failed seat-reclaim attempt after a reload (diagnostics). */
    reconnectError = '';
    sessionId = '';
    roomId = '';
    hello: HelloMessage | null = null;

    phase: MatchPhase = 'WAITING';
    round = 1;
    ticksLeft = 0;
    score = { blue: 0, orange: 0, paintable: 0 };
    winner = '';
    result: RoundResultMessage | null = null;

    readonly actors = new Map<string, NetActor>();
    local: NetActor | null = null;
    /** Visual-only offset that hides small corrections (decays to zero). */
    readonly smoothing = { x: 0, y: 0, z: 0 };
    corrections = 0;
    snaps = 0;

    private seq = 0;
    private readonly pending: PlayerInput[] = [];
    private lastAckSeq = 0;

    rttMs = 0;
    /** Recent ping samples; the readout is their median so one stalled ping (e.g. while assets
     *  load right after joining) does not linger in the display. */
    private readonly rttSamples: number[] = [];
    private pingTimer = 0;
    bytesIn = 0;
    bytesOut = 0;
    hashChecks = 0;
    hashMismatches = 0;
    lastHash: PaintHashMessage | null = null;
    /** Time from a shot event to the paint delta that contains it (ms), last few samples. */
    readonly paintDelays: number[] = [];
    private lastShotEventAt = 0;

    onActorAdded?: (actor: NetActor) => void;
    /** A player's replicated outfit changed (not called for the initial value). */
    onActorLook?: (actor: NetActor) => void;
    /** Outfit sent at join and on change (look string). */
    look = '';
    private lastLookSent = 0;
    private lookTimer: ReturnType<typeof setTimeout> | undefined;
    onActorRemoved?: (id: string) => void;
    onEvents?: (events: NetEvent[]) => void;
    /** Surfaces whose paint changed in a server message. */
    onPaint?: (changedSurfaces: number[]) => void;
    onResult?: (result: RoundResultMessage) => void;
    onPhase?: (phase: MatchPhase, previous: MatchPhase) => void;
    onStatus?: (status: ConnectionStatus) => void;
    onWelcome?: (local: NetActor) => void;

    constructor(paint: PaintGrid, world: CollisionWorld) {
        this.paint = paint;
        this.world = world;
        this.receiver = new PaintReceiver(paint);
    }

    get acceptsInput(): boolean {
        return this.phase === 'WAITING' || this.phase === 'PLAYING';
    }

    /**
     * @param devRoomOptions development only: options for a room this client creates (e.g. short
     * timings for tests). The server ignores them in production.
     */
    async connect(url: string, name: string, roomId?: string, devRoomOptions: Record<string, unknown> = {}) {
        this.setStatus('connecting');
        this.client = new Client(url);
        let room: Room | null = null;
        const token = sessionStorage.getItem(TOKEN_KEY);
        if (token && !roomId) {
            // Page reload within the grace period: take the same seat back (GDD 7.5). Right after
            // a reload the server may not have seen the old socket close yet, so retry briefly
            // before giving the seat up.
            for (let attempt = 0; attempt < RECONNECT_ATTEMPTS && !room; attempt++) {
                try {
                    room = await this.client.reconnect(token);
                } catch (err) {
                    this.reconnectError = err instanceof Error ? err.message : String(err);
                    // 522: the room is gone — no point retrying. 524 (token not valid yet/anymore)
                    // is what the reload race produces, so that one is retried.
                    if ((err as { code?: number }).code === MATCHMAKE_INVALID_ROOM_ID) break;
                    await new Promise((r) => setTimeout(r, RECONNECT_RETRY_MS));
                }
            }
            if (!room) sessionStorage.removeItem(TOKEN_KEY);
        }
        if (!room) {
            try {
                const look = this.look || undefined;
                room = roomId
                    ? await this.client.joinById(roomId, { name, look })
                    : await this.client.joinOrCreate(ROOM_NAME, { ...devRoomOptions, name, look });
            } catch (err) {
                this.error = err instanceof Error ? err.message : String(err);
                this.setStatus('error');
                throw err;
            }
        }
        this.attach(room);
    }

    private attach(room: Room) {
        this.room = room;
        this.sessionId = room.sessionId;
        this.roomId = room.roomId;
        sessionStorage.setItem(TOKEN_KEY, room.reconnectionToken);
        this.countBytes(room);

        room.onMessage(ServerMessage.Hello, (m: HelloMessage) => {
            this.hello = m;
        });
        room.onMessage(ServerMessage.PaintSnapshot, (b: Uint8Array) => this.onPaintBytes(b));
        room.onMessage(ServerMessage.PaintDelta, (b: Uint8Array) => this.onPaintBytes(b));
        room.onMessage(ServerMessage.PaintHash, (m: PaintHashMessage) => this.onHash(m));
        room.onMessage(ServerMessage.Events, (m: EventsMessage) => {
            if (m.ev.some((e) => e.t === 's' && e.i)) this.lastShotEventAt = performance.now();
            this.onEvents?.(m.ev);
        });
        room.onMessage(ServerMessage.RoundResult, (m: RoundResultMessage) => {
            this.result = m;
            this.onResult?.(m);
        });
        room.onMessage('metrics', () => undefined); // diagnostics reply; ignored by the game
        room.onStateChange((state) => this.onState(state as unknown as MatchStateLike));
        room.onDrop(() => this.setStatus('reconnecting'));
        room.onReconnect(() => {
            this.setStatus('connected');
            // The SDK fires onReconnect before it stores the new token; save it right after.
            queueMicrotask(() => sessionStorage.setItem(TOKEN_KEY, room.reconnectionToken));
        });
        // Always leave the newest token behind for a reload (GDD 7.5).
        window.addEventListener('pagehide', () => {
            if (this.status !== 'disconnected') sessionStorage.setItem(TOKEN_KEY, room.reconnectionToken);
        });
        room.onLeave((code) => {
            this.setStatus('disconnected');
            this.error = `연결 종료 (${code})`;
            if (code === 4000) sessionStorage.removeItem(TOKEN_KEY);
        });
        room.onError((code, message) => {
            this.error = `${code} ${message ?? ''}`;
        });
        this.setStatus('connected');
    }

    /** Count raw bytes received (all messages and patches) for the bandwidth readout. */
    private countBytes(room: Room) {
        const events = room.connection.events as { onmessage?: (ev: MessageEvent) => void };
        const original = events.onmessage;
        if (!original) return;
        events.onmessage = (ev: MessageEvent) => {
            const data = ev.data as ArrayBuffer | Uint8Array | string;
            this.bytesIn += typeof data === 'string' ? data.length : data.byteLength;
            original(ev);
        };
    }

    private setStatus(s: ConnectionStatus) {
        this.status = s;
        this.onStatus?.(s);
    }

    leave() {
        sessionStorage.removeItem(TOKEN_KEY);
        this.room?.leave(true).catch(() => undefined);
    }

    setReady(ready: boolean) {
        this.room?.send(ClientMessage.Ready, ready);
    }

    /**
     * Change this player's replicated outfit. The server accepts one change per
     * LOOK_MIN_INTERVAL_MS, so quick successive saves are coalesced and only the latest is sent.
     */
    setLook(look: string) {
        this.look = look;
        clearTimeout(this.lookTimer);
        if (!this.room || this.status !== 'connected') return; // goes with the join / welcome
        const wait = this.lastLookSent + LOOK_MIN_INTERVAL_MS + 50 - Date.now();
        if (wait <= 0) this.sendLook();
        else this.lookTimer = setTimeout(() => this.sendLook(), wait);
    }

    private sendLook() {
        if (!this.room || this.status !== 'connected') return;
        this.room.send(ClientMessage.Look, this.look);
        this.lastLookSent = Date.now();
    }

    /** Debug/test only: drop the socket as a network failure would (the SDK reconnects). */
    simulateDrop() {
        if (!this.room) return;
        this.room.reconnection.minUptime = 0;
        this.room.connection.close(4010, 'simulated drop');
    }

    // ── per fixed tick ──────────────────────────────────────────────────────────

    /**
     * Send this tick's input and predict the local player. Returns the predicted step (for shot
     * visuals) or null when not predicting (frozen phase, splatted, not joined yet).
     */
    tick(raw: RawInput, now: number): PlayerStepResult | null {
        this.pingTimer -= 1;
        if (this.pingTimer <= 0 && this.room && this.status === 'connected') {
            this.pingTimer = TICK_RATE;
            this.room.ping((ms) => {
                this.rttSamples.push(ms);
                if (this.rttSamples.length > 5) this.rttSamples.shift();
                const sorted = [...this.rttSamples].sort((x, y) => x - y);
                this.rttMs = sorted[Math.floor(sorted.length / 2)];
            });
        }
        const local = this.local;
        if (!local || !this.room || this.status !== 'connected') return null;
        const input = sanitizeInput({ seq: ++this.seq, ...raw });
        this.room.send(ClientMessage.Input, [input.seq, input.moveX, input.moveZ, input.yaw, input.pitch, input.buttons]);
        this.bytesOut += 32;
        if (!this.acceptsInput || !local.state.alive) return null;
        this.pending.push(input);
        if (this.pending.length > PENDING_LIMIT) this.pending.shift();
        local.state.yaw = input.yaw;
        local.state.pitch = input.pitch;
        void now;
        return predictPlayer(local.state, input, this.world, this.paint, this.targets());
    }

    private targets(): PlayerState[] {
        const out: PlayerState[] = [];
        const me = this.local;
        for (const a of this.actors.values()) {
            if (a !== me && a.state.alive && me && a.team !== me.team) out.push(a.state);
        }
        return out;
    }

    // ── state patches ──────────────────────────────────────────────────────────

    private onState(st: MatchStateLike) {
        const now = performance.now();
        const prevPhase = this.phase;
        this.phase = st.phase as MatchPhase;
        this.round = st.round;
        this.ticksLeft = st.ticksLeft ?? 0;
        this.score.blue = st.blue ?? 0;
        this.score.orange = st.orange ?? 0;
        this.score.paintable = st.paintable ?? 0;
        this.winner = st.winner;

        const seen = new Set<string>();
        st.players.forEach((p, id) => {
            seen.add(id);
            let actor = this.actors.get(id);
            if (!actor) {
                actor = {
                    id,
                    name: p.name,
                    team: p.team as TeamId,
                    connected: p.connected,
                    ready: p.ready,
                    kills: 0,
                    deaths: 0,
                    painted: 0,
                    look: p.look ?? '',
                    state: createPlayerState(id, p.team as TeamId),
                    snapshots: []
                };
                writeState(actor.state, p);
                this.actors.set(id, actor);
                if (id === this.sessionId) {
                    this.local = actor;
                    this.lastAckSeq = p.seq ?? 0;
                    this.seq = Math.max(this.seq, this.lastAckSeq);
                    this.onWelcome?.(actor);
                }
                this.onActorAdded?.(actor);
            }
            if ((p.look ?? '') !== actor.look) {
                actor.look = p.look ?? '';
                this.onActorLook?.(actor);
            }
            actor.name = p.name;
            actor.team = p.team as TeamId;
            actor.state.team = actor.team;
            actor.connected = p.connected;
            actor.ready = p.ready;
            actor.kills = p.kills ?? 0;
            actor.deaths = p.deaths ?? 0;
            actor.painted = p.painted ?? 0;
            if (actor === this.local) this.reconcile(p);
            else {
                actor.snapshots.push({ t: now, x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch });
                if (actor.snapshots.length > SNAPSHOT_KEEP) actor.snapshots.shift();
                // Non-positional fields come straight from the latest patch. Velocity, timers and
                // cooldowns are owner-only (D-017); remote velocity is derived in interpolate().
                const s = actor.state;
                s.grounded = p.grounded;
                s.alive = p.alive;
                s.hp = p.hp;
                s.ammo = p.ammo;
                s.reloadTicksRemaining = p.reload;
                s.dashTicksRemaining = p.dash;
                s.lastButtons = p.buttons;
            }
        });
        for (const id of [...this.actors.keys()]) {
            if (seen.has(id)) continue;
            this.actors.delete(id);
            this.onActorRemoved?.(id);
        }
        if (prevPhase !== this.phase) this.onPhase?.(this.phase, prevPhase);
    }

    /** Server truth for the local player, then replay of the inputs it has not processed yet. */
    private reconcile(p: NetPlayerLike) {
        const s = this.local!.state;
        const before = { x: s.position.x, y: s.position.y, z: s.position.z };
        const yaw = s.yaw;
        const pitch = s.pitch;
        writeState(s, p);
        // The owner always receives seq (it is in its own StateView).
        const ack = p.seq ?? 0;
        this.lastAckSeq = ack;
        while (this.pending.length && this.pending[0].seq <= ack) this.pending.shift();
        if (this.acceptsInput && s.alive) {
            for (const input of this.pending) predictPlayer(s, input, this.world, this.paint);
        } else {
            this.pending.length = 0;
        }
        // Look direction is the player's own (latest input), never rewound.
        s.yaw = yaw;
        s.pitch = pitch;
        const dx = before.x - s.position.x;
        const dy = before.y - s.position.y;
        const dz = before.z - s.position.z;
        const err = Math.hypot(dx, dy, dz);
        if (err > SNAP_DISTANCE) {
            this.smoothing.x = this.smoothing.y = this.smoothing.z = 0;
            this.snaps++;
        } else if (err > 1e-3) {
            this.smoothing.x += dx;
            this.smoothing.y += dy;
            this.smoothing.z += dz;
            this.corrections++;
        }
    }

    /** Decay the correction offset (call once per rendered frame). */
    decaySmoothing(dt: number) {
        const k = Math.exp(-dt * 12);
        this.smoothing.x *= k;
        this.smoothing.y *= k;
        this.smoothing.z *= k;
    }

    /** Move every remote actor to its interpolated position at `now - INTERP_DELAY_MS`. */
    interpolate(now: number) {
        const t = now - INTERP_DELAY_MS;
        for (const a of this.actors.values()) {
            if (a === this.local) continue;
            const snaps = a.snapshots;
            if (!snaps.length) continue;
            let i = snaps.length - 1;
            while (i > 0 && snaps[i - 1].t > t) i--;
            const b = snaps[i];
            const prev = i > 0 ? snaps[i - 1] : b;
            const span = b.t - prev.t;
            const k = span > 0 ? Math.min(1, Math.max(0, (t - prev.t) / span)) : 1;
            const s = a.state;
            // Teleports (respawn, round reset) jump instead of sliding across the map.
            const jump = Math.hypot(b.x - prev.x, b.z - prev.z) > 6;
            const f = jump ? 1 : k;
            s.position.x = prev.x + (b.x - prev.x) * f;
            s.position.y = prev.y + (b.y - prev.y) * f;
            s.position.z = prev.z + (b.z - prev.z) * f;
            s.yaw = lerpAngle(prev.yaw, b.yaw, f);
            s.pitch = prev.pitch + (b.pitch - prev.pitch) * f;
            // Animation speed from the two bracketing patches (velocity itself is not replicated).
            const dt = span > 0 && !jump ? span / 1000 : 0;
            s.velocity.x = dt ? (b.x - prev.x) / dt : 0;
            s.velocity.y = dt ? (b.y - prev.y) / dt : 0;
            s.velocity.z = dt ? (b.z - prev.z) / dt : 0;
        }
    }

    // ── paint ──────────────────────────────────────────────────────────────────

    private onPaintBytes(bytes: Uint8Array) {
        const before = Array.from(this.paint.surfaceRevisions);
        let result;
        try {
            result = this.receiver.receive(bytes, performance.now());
        } catch (err) {
            console.warn('[paint] bad message, resyncing', err);
            this.receiver.resyncing = true;
            this.room?.send(ClientMessage.PaintResync);
            return;
        }
        if (result === 'gap') {
            this.room?.send(ClientMessage.PaintResync);
            return;
        }
        if (result !== 'applied') return;
        if (this.lastShotEventAt) {
            const delay = performance.now() - this.lastShotEventAt;
            // A shot that changed no cells has no delta; don't pair it with a later, unrelated one.
            if (delay < PAINT_DELAY_WINDOW_MS) {
                this.paintDelays.push(delay);
                if (this.paintDelays.length > 60) this.paintDelays.shift();
            }
            this.lastShotEventAt = 0;
        }
        const changed: number[] = [];
        this.paint.surfaceRevisions.forEach((rev, i) => {
            if (rev !== before[i]) changed.push(i);
        });
        if (changed.length) this.onPaint?.(changed);
    }

    private onHash(m: PaintHashMessage) {
        this.lastHash = m;
        if (this.receiver.seq !== m.seq || this.receiver.resyncing) return;
        this.hashChecks++;
        if (this.paint.hash() !== m.hash) {
            // Should never happen; recover with a snapshot and count it.
            this.hashMismatches++;
            this.receiver.resyncing = true;
            this.room?.send(ClientMessage.PaintResync);
        }
    }

    get pendingInputs() {
        return this.pending.length;
    }

    get ackSeq() {
        return this.lastAckSeq;
    }
}

/** Owner-only fields (D-017) are absent for other players; they default to 0. */
function writeState(s: PlayerState, p: NetPlayerLike) {
    s.position.x = p.x;
    s.position.y = p.y;
    s.position.z = p.z;
    s.velocity.x = p.vx ?? 0;
    s.velocity.y = p.vy ?? 0;
    s.velocity.z = p.vz ?? 0;
    s.yaw = p.yaw;
    s.pitch = p.pitch;
    s.grounded = p.grounded;
    s.alive = p.alive;
    s.hp = p.hp;
    s.ammo = p.ammo;
    s.reloadTicksRemaining = p.reload;
    s.fireCooldownTicks = p.fireCd ?? 0;
    s.dashTicksRemaining = p.dash;
    s.dashCooldownTicks = p.dashCd ?? 0;
    s.dashDirX = p.dashX ?? 0;
    s.dashDirZ = p.dashZ ?? 0;
    s.lastButtons = p.buttons;
    s.lastProcessedSeq = p.seq ?? 0;
    s.invulnerableTicks = p.invuln ?? 0;
    s.respawnTicks = p.respawn ?? 0;
    s.team = p.team as TeamId;
}
