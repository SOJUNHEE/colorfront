import { DEFAULT_APPEARANCE } from '@colorfront/shared';
import type { AvatarAppearance, TeamId } from '@colorfront/shared';
import { Entity } from 'playcanvas';
import type { AppBase, Vec3 } from 'playcanvas';

import { CharacterRig } from './CharacterRig.ts';
import type { RigPose } from './CharacterRig.ts';
import { AvatarLibrary, GlbAvatar } from './GlbAvatar.ts';

export type { RigPose };

/**
 * What the game needs from a drawn character. Purely visual: nothing here feeds back into the
 * simulation, hit tests or networking. `Game` only talks to this type, so the procedural
 * `CharacterRig` (legacy) and the GLB avatar (Phase 6) are interchangeable.
 *
 * Contract (kept from CharacterRig):
 *  - `root` is a scene entity owned by the view; destroying it releases the view.
 *  - `update` is called once per rendered frame for living players with the interpolated pose.
 *  - `muzzle` returns the world position where shot visuals start (never used for hit tests).
 */
export type AvatarView = {
    readonly root: Entity;
    readonly currentLod: number;
    update(dt: number, pose: RigPose, cameraDistance: number, lodDistance: number): void;
    setTeam(team: TeamId): void;
    setVisible(visible: boolean): void;
    muzzle(out: Vec3): Vec3;
    fired(): void;
    hit(): void;
    respawned(): void;
    celebrate(on: boolean): void;
    /** Optional (GLB avatars): change clothes. Legacy rigs ignore it. */
    setAppearance?(a: AvatarAppearance): Promise<void>;
};

export type AvatarKind = 'glb' | 'legacy';

/** `?avatar=legacy` forces the procedural rig (A/B checks, emergency fallback). */
export function avatarKindFromUrl(search = typeof location === 'undefined' ? '' : location.search): AvatarKind {
    return new URLSearchParams(search).get('avatar') === 'legacy' ? 'legacy' : 'glb';
}

/**
 * Stable wrapper handed to the game. It starts as whatever view is available immediately
 * (legacy rig while GLBs load) and swaps its inner view in place once the GLB library is ready,
 * carrying over team, visibility and victory state. `root` never changes, so `Game` can keep
 * destroying / toggling it exactly as before.
 */
export class SwitchableAvatar implements AvatarView {
    readonly root: Entity;
    private inner: AvatarView;
    private team: TeamId;
    private celebrating = false;
    kind: AvatarKind;
    appearance: AvatarAppearance;

    constructor(root: Entity, first: AvatarView, kind: AvatarKind, team: TeamId, appearance: AvatarAppearance) {
        this.root = root;
        this.inner = first;
        this.kind = kind;
        this.team = team;
        this.appearance = { ...appearance };
        first.root.reparent(root);
    }

    /** Replace the inner view (e.g. legacy -> GLB). The old view is destroyed. */
    swap(next: AvatarView, kind: AvatarKind) {
        const old = this.inner;
        next.root.reparent(this.root);
        next.setTeam(this.team);
        next.celebrate(this.celebrating);
        // Keep the pose until the next update() so the swap never shows a T/A-pose frame.
        next.root.setPosition(old.root.getPosition());
        next.root.setRotation(old.root.getRotation());
        this.inner = next;
        this.kind = kind;
        old.root.destroy();
    }

    get currentLod() {
        return this.inner.currentLod;
    }

    update(dt: number, pose: RigPose, cameraDistance: number, lodDistance: number) {
        this.inner.update(dt, pose, cameraDistance, lodDistance);
    }

    setTeam(team: TeamId) {
        this.team = team;
        this.inner.setTeam(team);
    }

    setVisible(visible: boolean) {
        this.root.enabled = visible;
    }

    muzzle(out: Vec3): Vec3 {
        return this.inner.muzzle(out);
    }

    fired() {
        this.inner.fired();
    }

    hit() {
        this.inner.hit();
    }

    respawned() {
        this.inner.respawned();
    }

    celebrate(on: boolean) {
        this.celebrating = on;
        this.inner.celebrate(on);
    }

    /** Remembered for a later legacy -> GLB upgrade; applied now if the view supports it. */
    setAppearance(a: AvatarAppearance): Promise<void> {
        this.appearance = { ...a };
        return this.inner.setAppearance?.(a) ?? Promise.resolve();
    }

    /** The inner view (diagnostics / tests). */
    get view(): AvatarView {
        return this.inner;
    }
}

export type AvatarFactoryStatus = 'legacy' | 'loading' | 'ready' | 'failed';

/**
 * Creates player views. Never throws and never waits: until the GLB library is loaded every
 * player gets the legacy rig, then all live avatars are upgraded in place. If loading fails the
 * legacy rig simply stays (the game is never blocked on art).
 */
export class AvatarFactory {
    private readonly app: AppBase;
    private lib: AvatarLibrary | null = null;
    private readonly live = new Set<SwitchableAvatar>();
    status: AvatarFactoryStatus;
    error: string | null = null;
    /** Resolves when loading has settled (ready, failed or legacy). */
    readonly settled: Promise<AvatarFactoryStatus>;

    constructor(app: AppBase, kind: AvatarKind, load: (app: AppBase) => Promise<AvatarLibrary> = AvatarLibrary.load) {
        this.app = app;
        if (kind === 'legacy') {
            this.status = 'legacy';
            this.settled = Promise.resolve(this.status);
            return;
        }
        this.status = 'loading';
        this.settled = load(app).then(
            (lib) => {
                this.lib = lib;
                this.status = 'ready';
                for (const a of this.live) this.upgrade(a);
                return this.status;
            },
            (err: unknown) => {
                this.status = 'failed';
                this.error = String(err);
                console.warn('[avatar] GLB avatars unavailable, keeping the legacy rig:', err);
                return this.status;
            }
        );
    }

    create(team: TeamId, seed: number, appearance: AvatarAppearance = DEFAULT_APPEARANCE): SwitchableAvatar {
        const root = new Entity('player-avatar');
        this.app.root.addChild(root);
        const glb = this.lib ? this.makeGlb(team, appearance) : null;
        const view = new SwitchableAvatar(root, glb ?? new CharacterRig(this.app, team, seed), glb ? 'glb' : 'legacy', team, appearance);
        if (!glb) {
            this.live.add(view);
            // Forget it once the game destroys it (removed player, mode switch).
            root.once('destroy', () => this.live.delete(view));
        }
        return view;
    }

    /** Number of views still waiting for the GLB library (diagnostics/tests). */
    get pending() {
        return this.live.size;
    }

    /** Loaded wardrobe library (null while loading / on failure / legacy mode). */
    get library(): AvatarLibrary | null {
        return this.lib;
    }

    private makeGlb(team: TeamId, appearance: AvatarAppearance): AvatarView | null {
        try {
            return new GlbAvatar(this.app, this.lib!, team, appearance);
        } catch (err) {
            console.warn('[avatar] GLB avatar creation failed, using the legacy rig:', err);
            return null;
        }
    }

    private upgrade(view: SwitchableAvatar) {
        this.live.delete(view);
        const glb = this.makeGlb('blue', view.appearance);
        if (glb) view.swap(glb, 'glb');
    }
}
