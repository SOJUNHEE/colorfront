import { AIM } from '../combat/hitscan.ts';
import { PLAYER_SHAPE, TICK_RATE } from '../constants/simulation.ts';
import { InputButton, sanitizeInput } from '../input/buttons.ts';
import { isVulnerable } from '../rules/combat.ts';
import { type CollisionWorld, raycast } from '../simulation/collision.ts';
import type { MatchSimulation } from '../simulation/match.ts';
import type { PlayerInput, PlayerState } from '../types/player.ts';

/** Reachable points across the three routes (x, z), shared by both teams. */
const WAYPOINTS: [number, number][] = [
    [-50, 0], [-40, 8], [-36, -14], [-20, 0], [-10, 12], [0, -12], [10, 12], [20, 0], [36, -14], [40, 8], [50, 0],
    [-56, -22], [-56, -40], [-42, -45], [-20, -24], [-20, -45], [0, -46], [20, -45], [20, -24], [42, -45], [56, -40], [56, -22],
    [-58, 28], [-50, 50], [-32, 40], [-16, 53], [0, 40], [16, 53], [32, 40], [50, 50], [58, 28],
    [-20, 18], [20, 18], [-18, -16], [18, -16], [0, 8]
];

function rng(seed: number) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const wrap = (a: number) => {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
};

/** Yaw/pitch that look from `from` toward `to` (PlayerInput convention). */
export function lookAt(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
}

/**
 * Simple deterministic bot for offline battles and render/load testing. Produces ordinary
 * PlayerInput — it gets no privileges the server would not give a human.
 */
export class SimpleBot {
    readonly id: string;
    private readonly random: () => number;
    private goal: [number, number];
    private lastProgressTick = 0;
    private bestDistance = Infinity;
    private seq = 0;
    private yaw = 0;
    private pitch = 0;
    private fireHold = 0;
    private strafe = 0;
    private strafeTicks = 0;

    constructor(id: string, seed: number) {
        this.id = id;
        this.random = rng(seed);
        this.goal = WAYPOINTS[Math.floor(this.random() * WAYPOINTS.length)];
    }

    private pickGoal(tick: number) {
        this.goal = WAYPOINTS[Math.floor(this.random() * WAYPOINTS.length)];
        this.bestDistance = Infinity;
        this.lastProgressTick = tick;
    }

    private visibleEnemy(self: PlayerState, sim: MatchSimulation, world: CollisionWorld): PlayerState | null {
        let best: PlayerState | null = null;
        let bestD = 22;
        const eye = { x: self.position.x, y: self.position.y + AIM.pivotHeight, z: self.position.z };
        for (const o of sim.players) {
            if (o.team === self.team || !isVulnerable(o, sim.map.spawnZones)) continue;
            const dx = o.position.x - eye.x;
            const dy = o.position.y + PLAYER_SHAPE.height * 0.6 - eye.y;
            const dz = o.position.z - eye.z;
            const d = Math.hypot(dx, dy, dz);
            if (d >= bestD || d < 0.5) continue;
            if (raycast(world, eye, { x: dx / d, y: dy / d, z: dz / d }, d)) continue;
            best = o;
            bestD = d;
        }
        return best;
    }

    think(self: PlayerState, sim: MatchSimulation): PlayerInput {
        const tick = sim.tick;
        let buttons = 0;
        let moveZ = 1;
        let moveX = 0;
        const enemy = this.visibleEnemy(self, sim, sim.world);
        if (enemy) {
            const target = { x: enemy.position.x, y: enemy.position.y + PLAYER_SHAPE.height * 0.55, z: enemy.position.z };
            const look = lookAt({ x: self.position.x, y: self.position.y + AIM.pivotHeight, z: self.position.z }, target);
            // Imperfect tracking: turn rate limit and a little jitter.
            const jitter = (this.random() - 0.5) * 0.06;
            this.yaw += Math.max(-0.25, Math.min(0.25, wrap(look.yaw + jitter - this.yaw)));
            this.pitch += Math.max(-0.2, Math.min(0.2, look.pitch - this.pitch));
            if (Math.abs(wrap(look.yaw - this.yaw)) < 0.12) buttons |= InputButton.Fire;
            // Strafe while fighting.
            if (--this.strafeTicks <= 0) {
                this.strafe = this.random() < 0.5 ? -1 : 1;
                this.strafeTicks = 15 + Math.floor(this.random() * 30);
            }
            moveX = this.strafe;
            moveZ = this.random() < 0.3 ? 0.4 : 0;
        } else {
            const dx = this.goal[0] - self.position.x;
            const dz = this.goal[1] - self.position.z;
            const d = Math.hypot(dx, dz);
            if (d < 2.5) this.pickGoal(tick);
            if (d < this.bestDistance - 0.5) {
                this.bestDistance = d;
                this.lastProgressTick = tick;
            }
            const desired = Math.atan2(-dx, -dz);
            this.yaw += Math.max(-0.18, Math.min(0.18, wrap(desired - this.yaw)));
            // Paint the ground ahead while travelling.
            this.pitch += (-0.32 - this.pitch) * 0.2;
            if (this.fireHold > 0) {
                buttons |= InputButton.Fire;
                this.fireHold--;
            } else if (this.random() < 0.04) this.fireHold = 20 + Math.floor(this.random() * 40);
            if (self.grounded && this.random() < 0.08) buttons |= InputButton.Sprint;
            // Stuck: hop, dash and pick another goal.
            if (tick - this.lastProgressTick > TICK_RATE * 2.5) {
                buttons |= InputButton.Jump;
                if (this.random() < 0.5) buttons |= InputButton.Dash;
                this.pickGoal(tick);
                this.yaw += (this.random() - 0.5) * 2;
            }
        }
        if (this.random() < 0.004) buttons |= InputButton.Jump;
        if (self.ammo === 0) buttons |= InputButton.Reload;
        this.yaw = wrap(this.yaw);
        return sanitizeInput({ seq: ++this.seq, moveX, moveZ, yaw: this.yaw, pitch: this.pitch, buttons });
    }
}
