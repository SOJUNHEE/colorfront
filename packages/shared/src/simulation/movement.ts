import { DASH_SPEED, MOVEMENT, PLAYER_SHAPE, TICK_DT } from '../constants/simulation.ts';
import { InputButton, hasButton } from '../input/buttons.ts';
import type { PlayerInput, PlayerState } from '../types/player.ts';
import { type CollisionWorld, findCeiling, findGround, resolveHorizontal } from './collision.ts';

/** Fraction of the radius that must be over a surface to stand on it. */
const FOOT_RADIUS = PLAYER_SHAPE.radius * 0.5;

export interface MovementStepResult {
    jumped: boolean;
    dashed: boolean;
    landed: boolean;
    hitWall: boolean;
    /** Fell below MOVEMENT.killY; the caller decides where to respawn. */
    fellOut: boolean;
}

/** Forward (looking) direction on the XZ plane for a yaw. */
export const forwardFromYaw = (yaw: number) => ({ x: -Math.sin(yaw), z: -Math.cos(yaw) });

/**
 * Advance one player by one fixed tick. Pure apart from mutating `state`; the same function is
 * meant to run on the client (prediction) and the server (authority). `input` must already be
 * sanitised with sanitizeInput().
 *
 * `groundSpeedMultiplier` (paint under the feet) scales grounded walk/sprint speed only. It is
 * ignored in the air and never affects the fixed-distance dash.
 */
export function stepMovement(
    state: PlayerState,
    input: PlayerInput,
    world: CollisionWorld,
    dt: number = TICK_DT,
    groundSpeedMultiplier = 1
): MovementStepResult {
    const result: MovementStepResult = { jumped: false, dashed: false, landed: false, hitWall: false, fellOut: false };
    const pos = state.position;
    const vel = state.velocity;
    const pressed = input.buttons & ~state.lastButtons;

    state.yaw = input.yaw;
    state.pitch = input.pitch;

    // Wish direction in world space.
    const sin = Math.sin(input.yaw);
    const cos = Math.cos(input.yaw);
    let wishX = cos * input.moveX - sin * input.moveZ;
    let wishZ = -sin * input.moveX - cos * input.moveZ;
    const wishLenSq = wishX * wishX + wishZ * wishZ;
    if (wishLenSq > 1) {
        const l = Math.sqrt(wishLenSq);
        wishX /= l;
        wishZ /= l;
    }

    const aiming = hasButton(input.buttons, InputButton.Aim);
    const sprinting = hasButton(input.buttons, InputButton.Sprint) && !aiming && wishLenSq > 1e-4;
    const baseSpeed = sprinting ? MOVEMENT.sprintSpeed : MOVEMENT.walkSpeed;
    const speed = state.grounded ? baseSpeed * groundSpeedMultiplier : baseSpeed;

    // Dash: fixed distance burst, then hand back to normal acceleration.
    if (state.dashCooldownTicks > 0) state.dashCooldownTicks--;
    if (hasButton(pressed, InputButton.Dash) && state.dashCooldownTicks === 0 && state.dashTicksRemaining === 0) {
        if (wishLenSq > 1e-4) {
            const l = Math.sqrt(wishLenSq);
            state.dashDirX = wishX / l;
            state.dashDirZ = wishZ / l;
        } else {
            state.dashDirX = -sin;
            state.dashDirZ = -cos;
        }
        state.dashTicksRemaining = MOVEMENT.dashTicks;
        state.dashCooldownTicks = MOVEMENT.dashCooldownTicks;
        result.dashed = true;
    }

    const dashing = state.dashTicksRemaining > 0;
    if (dashing) {
        vel.x = state.dashDirX * DASH_SPEED;
        vel.z = state.dashDirZ * DASH_SPEED;
        if (vel.y < 0) vel.y = 0;
    } else {
        const targetX = wishX * speed;
        const targetZ = wishZ * speed;
        const accel = state.grounded ? MOVEMENT.groundAcceleration : MOVEMENT.airAcceleration;
        const dvx = targetX - vel.x;
        const dvz = targetZ - vel.z;
        const dvLen = Math.sqrt(dvx * dvx + dvz * dvz);
        const maxDv = accel * dt;
        if (dvLen <= maxDv) {
            vel.x = targetX;
            vel.z = targetZ;
        } else {
            vel.x += (dvx / dvLen) * maxDv;
            vel.z += (dvz / dvLen) * maxDv;
        }
    }

    if (hasButton(pressed, InputButton.Jump) && state.grounded && !dashing) {
        vel.y = MOVEMENT.jumpSpeed;
        state.grounded = false;
        result.jumped = true;
    }

    if (!dashing) {
        vel.y -= MOVEMENT.gravity * dt;
        if (vel.y < -MOVEMENT.maxFallSpeed) vel.y = -MOVEMENT.maxFallSpeed;
    }

    // Integrate in sub-steps short enough that the cylinder cannot tunnel through walls.
    const moveX = vel.x * dt;
    const moveZ = vel.z * dt;
    const horizontal = Math.sqrt(moveX * moveX + moveZ * moveZ);
    const steps = Math.max(1, Math.ceil(horizontal / MOVEMENT.maxSubstepDistance));
    const subDt = dt / steps;
    const wasGrounded = state.grounded;
    let grounded = false;

    for (let i = 0; i < steps; i++) {
        pos.x += vel.x * subDt;
        pos.z += vel.z * subDt;
        if (resolveHorizontal(world, pos, vel, PLAYER_SHAPE.radius, PLAYER_SHAPE.height, MOVEMENT.stepHeight)) {
            result.hitWall = true;
        }

        const prevY = pos.y;
        pos.y += vel.y * subDt;

        if (vel.y > 0) {
            const ceiling = findCeiling(world, pos.x, pos.z, PLAYER_SHAPE.radius * 0.9, prevY + PLAYER_SHAPE.height, pos.y + PLAYER_SHAPE.height);
            if (ceiling !== Infinity) {
                pos.y = ceiling - PLAYER_SHAPE.height;
                vel.y = 0;
            }
        }

        const ground = findGround(world, pos.x, pos.z, FOOT_RADIUS, Math.max(prevY, pos.y) + MOVEMENT.stepHeight);
        if (pos.y <= ground) {
            pos.y = ground;
            if (vel.y < 0) vel.y = 0;
            grounded = true;
        } else if ((wasGrounded || grounded) && vel.y <= 0 && pos.y - ground <= MOVEMENT.groundSnapDistance) {
            // Stick to the floor when walking down ramps and small steps.
            pos.y = ground;
            vel.y = 0;
            grounded = true;
        } else {
            grounded = false;
        }

        // Falling past a ledge rim can drop the feet below the step allowance while still
        // overlapping it horizontally; push out again so no tick ends inside geometry.
        if (!grounded && resolveHorizontal(world, pos, vel, PLAYER_SHAPE.radius, PLAYER_SHAPE.height, MOVEMENT.stepHeight)) {
            result.hitWall = true;
        }
    }

    if (dashing) {
        state.dashTicksRemaining--;
        if (state.dashTicksRemaining === 0) {
            // Hand straight over to the current input so the dash covers exactly 4 m: no slide
            // when idle, and no slide length that depends on the paint under the feet.
            vel.x = wishX * speed;
            vel.z = wishZ * speed;
        }
    }

    // Safety net: never leave the arena footprint even if a boundary wall is missing.
    const b = world.bounds;
    const r = PLAYER_SHAPE.radius;
    if (pos.x < b.minX + r) pos.x = b.minX + r;
    if (pos.x > b.maxX - r) pos.x = b.maxX - r;
    if (pos.z < b.minZ + r) pos.z = b.minZ + r;
    if (pos.z > b.maxZ - r) pos.z = b.maxZ - r;

    result.landed = grounded && !wasGrounded;
    state.grounded = grounded;
    state.lastButtons = input.buttons;
    state.lastProcessedSeq = input.seq;
    result.fellOut = pos.y < MOVEMENT.killY;
    return result;
}
