import { OUTFIT_PRESETS, SLOT_FIELD, WARDROBE_ITEMS, WARDROBE_SLOTS, appearanceKey, withItem } from '@colorfront/shared';
import type { AvatarAppearance, WardrobeSlot } from '@colorfront/shared';

import { SLOT_LABELS, WARDROBE_CATALOG } from '../avatar/catalog.ts';

/**
 * "아바타 꾸미기" panel. Pure UI: it edits an appearance and reports changes; the game previews
 * them on the local avatar and owns saving. The 3D view is the game camera orbiting the player
 * (drag = rotate, wheel = zoom) — handled here on the canvas while the panel is open.
 */
export class WardrobePanel {
    readonly root: HTMLElement;
    private current: AvatarAppearance;
    private saved: AvatarAppearance;
    private readonly canvas: HTMLCanvasElement;
    private readonly info: HTMLElement;
    private readonly slots: HTMLElement;
    private readonly presets: HTMLElement;
    private dragging = false;
    private lastX = 0;
    private lastY = 0;
    private readonly off: (() => void)[] = [];

    onChange?: (a: AvatarAppearance) => void;
    onSave?: (a: AvatarAppearance) => void;
    onClose?: (saved: AvatarAppearance) => void;
    /** Orbit input: yaw/pitch deltas (radians) and zoom steps. */
    onOrbit?: (dYaw: number, dPitch: number, zoom: number) => void;

    constructor(parent: HTMLElement, canvas: HTMLCanvasElement, initial: AvatarAppearance) {
        this.canvas = canvas;
        this.current = { ...initial };
        this.saved = { ...initial };
        this.root = document.createElement('div');
        this.root.className = 'wardrobe panel hidden';
        this.root.setAttribute('role', 'dialog');
        this.root.setAttribute('aria-label', '아바타 꾸미기');
        this.root.innerHTML = `
            <h1 class="wardrobe-title">아바타 꾸미기</h1>
            <p class="wardrobe-sub">드래그: 회전 · 휠: 확대/축소 · 외형만 바뀌며 능력치·판정은 같습니다</p>
            <section class="wardrobe-section"><h2>추천 코디</h2><div class="wardrobe-row presets"></div></section>
            <div class="wardrobe-slots"></div>
            <p class="wardrobe-info" aria-live="polite"></p>
            <div class="wardrobe-actions">
                <button type="button" class="ghost" data-act="reset">초기화</button>
                <button type="button" class="ghost" data-act="cancel">취소</button>
                <button type="button" class="play" data-act="save">저장</button>
            </div>
            <p class="wardrobe-note">저장한 외형은 이 기기에만 보관됩니다. 온라인 다른 플레이어에게 보이는 기능은 다음 단계에서 추가됩니다.</p>`;
        parent.append(this.root);
        this.info = this.root.querySelector('.wardrobe-info')!;
        this.slots = this.root.querySelector('.wardrobe-slots')!;
        this.presets = this.root.querySelector('.presets')!;

        for (const p of OUTFIT_PRESETS) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'chip';
            b.textContent = p.label;
            b.dataset.preset = p.id;
            b.addEventListener('click', () => this.set({ ...p.appearance }));
            this.presets.append(b);
        }
        for (const slot of WARDROBE_SLOTS) {
            const sec = document.createElement('section');
            sec.className = 'wardrobe-section';
            const h = document.createElement('h2');
            h.textContent = SLOT_LABELS[slot];
            const row = document.createElement('div');
            row.className = 'wardrobe-row';
            row.dataset.slot = slot;
            for (const id of WARDROBE_ITEMS[slot]) {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'chip';
                b.textContent = WARDROBE_CATALOG[id]?.label ?? id;
                b.dataset.item = id;
                b.addEventListener('click', () => this.set(withItem(this.current, slot as WardrobeSlot, id)));
                row.append(b);
            }
            sec.append(h, row);
            this.slots.append(sec);
        }
        this.root.querySelector('[data-act="reset"]')!.addEventListener('click', () => this.set({ ...OUTFIT_PRESETS[0].appearance }));
        this.root.querySelector('[data-act="cancel"]')!.addEventListener('click', () => this.close(false));
        this.root.querySelector('[data-act="save"]')!.addEventListener('click', () => this.close(true));
        this.render();
    }

    get isOpen() {
        return !this.root.classList.contains('hidden');
    }

    get appearance(): AvatarAppearance {
        return { ...this.current };
    }

    open(saved: AvatarAppearance) {
        this.saved = { ...saved };
        this.current = { ...saved };
        this.render();
        this.root.classList.remove('hidden');
        this.bindOrbit();
        this.root.querySelector<HTMLButtonElement>('.chip')?.focus();
    }

    /** Close; `save` keeps the edit, otherwise the saved outfit is restored. */
    close(save: boolean) {
        if (!this.isOpen) return;
        if (save) {
            this.saved = { ...this.current };
            this.onSave?.(this.saved);
        } else if (appearanceKey(this.current) !== appearanceKey(this.saved)) {
            this.current = { ...this.saved };
            this.onChange?.(this.current);
        }
        this.root.classList.add('hidden');
        for (const f of this.off.splice(0)) f();
        this.dragging = false;
        this.onClose?.(this.saved);
    }

    setInfo(text: string) {
        this.info.textContent = text;
    }

    private set(a: AvatarAppearance) {
        if (appearanceKey(a) === appearanceKey(this.current)) return;
        this.current = a;
        this.render();
        this.onChange?.({ ...a });
    }

    private render() {
        for (const row of this.slots.querySelectorAll<HTMLElement>('.wardrobe-row')) {
            const slot = row.dataset.slot as WardrobeSlot;
            const id = this.current[SLOT_FIELD[slot]];
            for (const b of row.querySelectorAll<HTMLButtonElement>('button')) b.setAttribute('aria-pressed', String(b.dataset.item === id));
        }
        const key = appearanceKey(this.current);
        for (const b of this.presets.querySelectorAll<HTMLButtonElement>('button')) {
            const p = OUTFIT_PRESETS.find((x) => x.id === b.dataset.preset)!;
            b.setAttribute('aria-pressed', String(appearanceKey(p.appearance) === key));
        }
    }

    private bindOrbit() {
        const c = this.canvas;
        const on = <K extends keyof HTMLElementEventMap>(t: EventTarget, type: K, fn: (e: HTMLElementEventMap[K]) => void) => {
            const h = fn as EventListener;
            t.addEventListener(type, h, { passive: false });
            this.off.push(() => t.removeEventListener(type, h));
        };
        on(c, 'pointerdown', (e) => {
            this.dragging = true;
            this.lastX = e.clientX;
            this.lastY = e.clientY;
            c.setPointerCapture?.(e.pointerId);
        });
        on(c, 'pointermove', (e) => {
            if (!this.dragging) return;
            const dx = e.clientX - this.lastX;
            const dy = e.clientY - this.lastY;
            this.lastX = e.clientX;
            this.lastY = e.clientY;
            this.onOrbit?.(-dx * 0.008, dy * 0.005, 0);
        });
        on(c, 'pointerup', () => (this.dragging = false));
        on(c, 'pointercancel', () => (this.dragging = false));
        on(c, 'wheel', (e) => {
            e.preventDefault();
            this.onOrbit?.(0, 0, Math.sign(e.deltaY));
        });
        on(document as unknown as HTMLElement, 'keydown', (e) => {
            if (e.code === 'Escape') this.close(false);
        });
    }
}
