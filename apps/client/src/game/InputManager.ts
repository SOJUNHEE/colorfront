import { InputButton, PITCH_LIMIT } from '@colorfront/shared';

/** Base mouse sensitivity in radians per pixel, multiplied by the user setting. */
const BASE_SENSITIVITY = 0.0022;

const KEY_BUTTONS: Record<string, InputButton> = {
    Space: InputButton.Jump,
    ShiftLeft: InputButton.Sprint,
    ShiftRight: InputButton.Sprint,
    KeyQ: InputButton.Dash,
    KeyR: InputButton.Reload
};

/**
 * Keyboard/mouse state with Pointer Lock. Look angles update at render rate; buttons are
 * sampled once per fixed tick, and short taps between two ticks are latched so they are
 * never lost.
 */
export class InputManager {
    yaw = 0;
    pitch = 0;
    sensitivity = 1;
    invertY = false;

    /** Accumulated wheel steps since the last read (positive = zoom out). */
    private wheel = 0;
    private readonly keys = new Set<string>();
    private heldButtons = 0;
    private latchedButtons = 0;
    private locked = false;
    private readonly listeners: (() => void)[] = [];

    readonly canvas: HTMLCanvasElement;

    /** Called with the new state whenever pointer lock is gained or lost. */
    onLockChange?: (locked: boolean) => void;

    /** Non-simulation key presses while locked (e.g. developer shortcuts). */
    onKeyAction?: (code: string) => void;

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
        this.listen(document, 'pointerlockchange', () => {
            this.locked = document.pointerLockElement === this.canvas;
            if (!this.locked) this.releaseAll();
            this.onLockChange?.(this.locked);
        });
        this.listen(document, 'keydown', (e) => this.onKey(e as KeyboardEvent, true));
        this.listen(document, 'keyup', (e) => this.onKey(e as KeyboardEvent, false));
        this.listen(document, 'mousemove', (e) => this.onMouseMove(e as MouseEvent));
        this.listen(this.canvas, 'mousedown', (e) => this.onMouseButton(e as MouseEvent, true));
        this.listen(document, 'mouseup', (e) => this.onMouseButton(e as MouseEvent, false));
        this.listen(this.canvas, 'contextmenu', (e) => e.preventDefault());
        this.listen(this.canvas, 'wheel', (e) => {
            if (!this.locked) return;
            e.preventDefault();
            this.wheel += Math.sign((e as WheelEvent).deltaY);
        });
        this.listen(window, 'blur', () => this.releaseAll());
    }

    get isLocked(): boolean {
        return this.locked;
    }

    async requestLock(): Promise<void> {
        try {
            await this.canvas.requestPointerLock({ unadjustedMovement: true });
        } catch {
            // unadjustedMovement is not supported everywhere; retry without it. A rejection here
            // (e.g. Chrome's ~1 s cooldown after ESC) propagates to the caller.
            await this.canvas.requestPointerLock();
        }
    }

    /** Forward/strafe axes from WASD. */
    moveAxes(): { moveX: number; moveZ: number } {
        if (!this.locked) return { moveX: 0, moveZ: 0 };
        const k = this.keys;
        const moveX = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
        const moveZ = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
        return { moveX, moveZ };
    }

    /** Buttons for the next tick: held plus anything pressed since the last sample. */
    sampleButtons(): number {
        const buttons = this.heldButtons | this.latchedButtons;
        this.latchedButtons = 0;
        return this.locked ? buttons : 0;
    }

    isHeld(button: InputButton): boolean {
        return this.locked && (this.heldButtons & button) !== 0;
    }

    consumeWheel(): number {
        const w = this.wheel;
        this.wheel = 0;
        return w;
    }

    destroy(): void {
        for (const off of this.listeners) off();
        this.listeners.length = 0;
    }

    private listen(target: EventTarget, type: string, fn: (e: Event) => void) {
        target.addEventListener(type, fn, { passive: false });
        this.listeners.push(() => target.removeEventListener(type, fn));
    }

    private press(button: InputButton, down: boolean) {
        if (down) {
            this.heldButtons |= button;
            this.latchedButtons |= button;
        } else {
            this.heldButtons &= ~button;
        }
    }

    private onKey(e: KeyboardEvent, down: boolean) {
        if (!this.locked) return;
        // Keep the page from scrolling or the browser from moving focus while playing.
        if (e.code === 'Space' || e.code === 'Tab') e.preventDefault();
        if (down) this.keys.add(e.code);
        else this.keys.delete(e.code);
        const button = KEY_BUTTONS[e.code];
        if (button !== undefined && !(down && e.repeat)) this.press(button, down);
        else if (button === undefined && down && !e.repeat) this.onKeyAction?.(e.code);
    }

    private onMouseButton(e: MouseEvent, down: boolean) {
        if (!this.locked) return;
        if (e.button === 0) this.press(InputButton.Fire, down);
        else if (e.button === 2) this.press(InputButton.Aim, down);
    }

    private onMouseMove(e: MouseEvent) {
        if (!this.locked) return;
        const s = BASE_SENSITIVITY * this.sensitivity;
        this.yaw -= e.movementX * s;
        this.pitch += (this.invertY ? e.movementY : -e.movementY) * s;
        if (this.pitch > PITCH_LIMIT) this.pitch = PITCH_LIMIT;
        if (this.pitch < -PITCH_LIMIT) this.pitch = -PITCH_LIMIT;
        // Keep yaw bounded so float precision never degrades over a long session.
        if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
        else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
    }

    private releaseAll() {
        this.keys.clear();
        this.heldButtons = 0;
        this.latchedButtons = 0;
    }
}
