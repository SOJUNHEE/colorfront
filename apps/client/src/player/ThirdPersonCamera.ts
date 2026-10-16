import { AIM, aimDirection, aimPivot, raycast } from '@colorfront/shared';
import type { CollisionWorld } from '@colorfront/shared';
import type { Entity } from 'playcanvas';

export type CameraTarget = {
    /** Interpolated feet position of the followed player. */
    x: number;
    y: number;
    z: number;
    yaw: number;
    pitch: number;
    aiming: boolean;
};

const MIN_DISTANCE = 2.5;
const MAX_DISTANCE = 6.5;
const AIM_DISTANCE = 1.7;
const AIM_FOV_RATIO = 0.72;

/**
 * Over-the-shoulder follow camera. Zoom with the wheel, tighter view while aiming, and pulls in
 * front of walls using the shared collision raycast. The camera always sits on the line behind
 * the shared `aimPivot`, so the screen-centre crosshair is the same ray the hitscan uses.
 */
export class ThirdPersonCamera {
    /** Hip-fire distance, changed with the mouse wheel. */
    distance = 4.2;
    baseFov = 70;

    /** Visual-only recoil and shake; the aim used by the simulation is never altered. */
    shakeEnabled = true;

    private currentDistance = 4.2;
    private aimBlend = 0;
    private kickPitch = 0;
    private kickVel = 0;
    private shakeAmount = 0;
    private time = 0;
    private readonly camera: Entity;
    private readonly world: CollisionWorld;

    constructor(camera: Entity, world: CollisionWorld) {
        this.camera = camera;
        this.world = world;
    }

    /** Short upward camera kick on firing. */
    kick(strength = 1) {
        if (this.shakeEnabled) this.kickVel += 9 * strength;
    }

    /** Brief shake (taking hits, nearby splats). */
    shake(amount: number) {
        if (this.shakeEnabled) this.shakeAmount = Math.min(1, this.shakeAmount + amount);
    }

    zoom(steps: number) {
        this.distance = Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, this.distance + steps * 0.5));
    }

    update(dt: number, t: CameraTarget) {
        this.time += dt;
        // Critically damped spring back to zero for the kick.
        this.kickVel += (-this.kickPitch * 260 - this.kickVel * 26) * dt;
        this.kickPitch += this.kickVel * dt;
        this.shakeAmount = Math.max(0, this.shakeAmount - dt * 3);
        // Frame-rate independent smoothing toward the aim state.
        const k = 1 - Math.exp(-dt * 14);
        this.aimBlend += ((t.aiming ? 1 : 0) - this.aimBlend) * k;

        const forward = aimDirection(t.yaw, t.pitch);
        const pivot = aimPivot(this.world, t, t.yaw);
        const wanted = this.distance + (AIM_DISTANCE - this.distance) * this.aimBlend;

        const back = { x: -forward.x, y: -forward.y, z: -forward.z };
        const hit = raycast(this.world, pivot, back, wanted + AIM.wallMargin);
        const allowed = hit ? Math.max(0.2, hit.distance - AIM.wallMargin) : wanted;

        // Snap in immediately (never show the inside of a wall), ease back out.
        if (allowed < this.currentDistance) this.currentDistance = allowed;
        else this.currentDistance += (allowed - this.currentDistance) * (1 - Math.exp(-dt * 6));

        const d = this.currentDistance;
        this.camera.setPosition(pivot.x + back.x * d, pivot.y + back.y * d, pivot.z + back.z * d);
        const sh = this.shakeAmount * this.shakeAmount;
        const shakeP = sh * 1.6 * Math.sin(this.time * 47.0);
        const shakeY = sh * 1.6 * Math.sin(this.time * 39.0 + 1.3);
        this.camera.setEulerAngles(
            (t.pitch * 180) / Math.PI + this.kickPitch + shakeP,
            (t.yaw * 180) / Math.PI + shakeY,
            sh * Math.sin(this.time * 31.0) * 1.2
        );
        this.camera.camera!.fov = this.baseFov * (1 + (AIM_FOV_RATIO - 1) * this.aimBlend) + this.kickPitch * 0.5;
    }
}
