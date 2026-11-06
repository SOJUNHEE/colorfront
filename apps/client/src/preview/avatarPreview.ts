/**
 * Phase 6 Gate 1 — standalone PlayCanvas preview of the GLB courier (not wired into the game).
 * Line-up (left -> right): GLB LOD0 blue, GLB LOD0 orange, GLB LOD1, GLB LOD2, legacy CharacterRig.
 * Drives every avatar with the same RigPose stream for the 12 gameplay states, so skinning,
 * IK, tank level, team swap and LODs can be checked side by side. Automation: window.__preview.
 */
import { DEFAULT_APPEARANCE, PLAYABLE_WEAPONS } from '@colorfront/shared';
import type { WeaponId } from '@colorfront/shared';
import {
    AppBase,
    AppOptions,
    CameraComponentSystem,
    Color,
    ContainerHandler,
    DEVICETYPE_WEBGL2,
    Entity,
    FILLMODE_FILL_WINDOW,
    LightComponentSystem,
    RESOLUTION_AUTO,
    RenderComponentSystem,
    StandardMaterial,
    TextureHandler,
    Vec3,
    createGraphicsDevice
} from 'playcanvas';

import type { AvatarView, RigPose } from '../player/AvatarView.ts';
import { CharacterRig } from '../player/CharacterRig.ts';
import { AvatarLibrary, GlbAvatar } from '../player/GlbAvatar.ts';
import { SceneEnvironment } from '../render/Environment.ts';
import { PostEffects } from '../render/PostEffects.ts';
import { QUALITY_PROFILES } from '../settings/settings.ts';

const POSES = [
    'idle',
    'walk',
    'run',
    'back',
    'strafeL',
    'strafeR',
    'dash',
    'jump',
    'land',
    'aim',
    'fire',
    'reload',
    'hit',
    'respawn',
    'victory',
    'sequence'
] as const;
/** Gate 4 fixed sequence: walk -> run -> jump -> land -> aim -> fire -> reload -> dash -> idle (seconds). */
const SEQUENCE: readonly [number, PoseName][] = [
    [0, 'walk'],
    [1.2, 'run'],
    [2.4, 'jump'],
    [2.85, 'land'],
    [3.6, 'aim'],
    [4.4, 'fire'],
    [5.4, 'reload'],
    [7.0, 'dash'],
    [7.35, 'idle'],
    [8.2, 'walk']
];
const SEQUENCE_LENGTH = 8.2;
type PoseName = Exclude<(typeof POSES)[number], 'sequence'> | 'sequence';
const VIEWS = ['front', 'side', 'back', 'three', 'game', 'lineup', 'face'] as const;
type ViewName = (typeof VIEWS)[number];

type Slot = { view: AvatarView; x: number; lod: number; label: string };

async function main() {
    const canvas = document.getElementById('preview-canvas') as HTMLCanvasElement;
    const status = document.getElementById('status')!;
    const device = await createGraphicsDevice(canvas, { deviceTypes: [DEVICETYPE_WEBGL2], antialias: true });
    const options = new AppOptions();
    options.graphicsDevice = device;
    options.componentSystems = [RenderComponentSystem, CameraComponentSystem, LightComponentSystem];
    options.resourceHandlers = [TextureHandler, ContainerHandler];
    const app = new AppBase(canvas);
    app.init(options);
    app.setCanvasFillMode(FILLMODE_FILL_WINDOW);
    app.setCanvasResolution(RESOLUTION_AUTO);
    window.addEventListener('resize', () => app.resizeCanvas());

    const profile = QUALITY_PROFILES.high;
    const env = new SceneEnvironment(app);
    env.apply(profile);
    const camera = new Entity('camera');
    camera.addComponent('camera', { nearClip: 0.05, farClip: 500, fov: 35 });
    app.root.addChild(camera);
    new PostEffects(app, camera.camera!).apply(profile);

    // Concrete-ish floor.
    const floorMat = new StandardMaterial();
    floorMat.diffuse = new Color(0.36, 0.38, 0.42);
    floorMat.gloss = 0.3;
    floorMat.update();
    const floor = new Entity('floor');
    floor.addComponent('render', { type: 'box', material: floorMat });
    floor.setLocalScale(30, 0.1, 30);
    floor.setPosition(0, -0.05, 0);
    app.root.addChild(floor);

    app.start();
    const t0 = performance.now();
    let lib: AvatarLibrary;
    try {
        lib = await AvatarLibrary.load(app);
    } catch (err) {
        status.textContent = `GLB 로드 실패: ${String(err)}`;
        throw err;
    }
    const loadMs = Math.round(performance.now() - t0);

    const slots: Slot[] = [];
    const mk = (x: number, team: 'blue' | 'orange', lod: number, label: string) => {
        const v = new GlbAvatar(app, lib, team);
        slots.push({ view: v, x, lod, label });
    };
    mk(0, 'blue', 0, 'GLB LOD0 블루');
    mk(1.4, 'orange', 0, 'GLB LOD0 오렌지');
    mk(2.8, 'blue', 1, 'GLB LOD1');
    mk(4.2, 'orange', 2, 'GLB LOD2');
    slots.push({ view: new CharacterRig(app, 'blue', 3), x: -1.6, lod: 0, label: '기존 CharacterRig' });

    let pose: PoseName = 'idle';
    let weapon: WeaponId = 'paint-rifle';
    /** Pose actually driven this frame (resolves 'sequence'). */
    const active = (): Exclude<PoseName, 'sequence'> => {
        if (pose !== 'sequence') return pose;
        const t = clock % SEQUENCE_LENGTH;
        let cur: PoseName = 'idle';
        for (const [at, p] of SEQUENCE) if (t >= at) cur = p;
        return cur as Exclude<PoseName, 'sequence'>;
    };
    /** Seconds since the current sequence step started (or since the pose was picked). */
    const local = () => {
        if (pose !== 'sequence') return clock;
        const t = clock % SEQUENCE_LENGTH;
        let start = 0;
        for (const [at] of SEQUENCE) if (t >= at) start = at;
        return t - start;
    };
    let view: ViewName = 'front';
    let clock = 0;
    let lastFire = 0;
    let lastHit = 0;
    let lastSpawn = 0;
    // Avatars face +Z (yaw = pi): the scene sun lights that side, so the front view is front-lit.

    function rigPose(x: number): RigPose {
        const yaw = Math.PI;
        const base: RigPose = {
            x,
            y: 0,
            z: 0,
            yaw,
            pitch: 0,
            vx: 0,
            vz: 0,
            vy: 0,
            grounded: true,
            aiming: false,
            dashing: false,
            reload: -1,
            ammo: 0.65,
            alive: true
        };
        const fwd = (s: number) => ({ vx: -Math.sin(yaw) * s, vz: -Math.cos(yaw) * s });
        const side = (s: number) => ({ vx: Math.cos(yaw) * s, vz: -Math.sin(yaw) * s });
        const lt = local();
        switch (active()) {
            case 'back':
                return { ...base, ...fwd(-5) };
            case 'strafeL':
                return { ...base, ...side(-6) };
            case 'strafeR':
                return { ...base, ...side(6) };
            case 'walk':
                return { ...base, ...fwd(4) };
            case 'run':
                return { ...base, ...fwd(8) };
            case 'dash':
                return { ...base, ...fwd(14), dashing: true };
            case 'jump':
                return pose === 'sequence' ? { ...base, ...fwd(8), grounded: false, vy: 5 - lt * 20 } : { ...base, grounded: false, vy: 3 };
            case 'land': {
                if (pose === 'sequence') return base;
                const air = clock % 1.2 < 0.45;
                return { ...base, grounded: !air, vy: air ? -6 : 0 };
            }
            case 'aim':
                return { ...base, aiming: true, pitch: 0.12 };
            case 'fire':
                return { ...base, aiming: true, ammo: 1 - (clock % 3) / 3 };
            case 'reload': {
                const r = pose === 'sequence' ? Math.min(0.999, lt / 1.6) : (clock % 1.6) / 1.6;
                return { ...base, reload: r, ammo: r };
            }
            default:
                return base;
        }
    }

    function placeCamera() {
        const c = 0; // centre slot (blue LOD0)
        const set = (p: [number, number, number], t: [number, number, number], fov = 35) => {
            camera.setPosition(...p);
            camera.lookAt(new Vec3(...t));
            camera.camera!.fov = fov;
        };
        switch (view) {
            case 'front':
                set([c, 1.0, 4.6], [c, 0.86, 0]);
                break;
            case 'side':
                set([c - 4.6, 1.0, 0], [c, 0.86, 0]);
                break;
            case 'back':
                set([c, 1.0, -4.6], [c, 0.86, 0]);
                break;
            case 'three':
                set([c - 3.1, 1.4, 3.3], [c, 0.86, 0]);
                break;
            case 'face':
                set([c - 0.45, 1.5, 1.15], [c, 1.36, 0], 30);
                break;
            case 'game':
                // In-game follow camera: over the right shoulder, ~3.4 m behind (1366x768 scale check).
                set([c - 0.75, 2.0, -3.4], [c - 0.2, 1.25, 6], 60);
                break;
            case 'lineup':
                set([1.3, 1.25, 8.6], [1.3, 0.85, 0], 32);
                break;
        }
    }

    app.on('update', (dt: number) => {
        clock += dt;
        const now = active();
        if (now === 'fire' && clock - lastFire > 0.2) {
            lastFire = clock;
            for (const s of slots) s.view.fired();
        }
        if (now === 'hit' && clock - lastHit > 0.8) {
            lastHit = clock;
            for (const s of slots) s.view.hit();
        }
        if (now === 'respawn' && clock - lastSpawn > 1.5) {
            lastSpawn = clock;
            for (const s of slots) s.view.respawned();
        }
        for (const s of slots) {
            s.view.celebrate(now === 'victory');
            s.view.setWeapon?.(weapon);
            // Force each slot's LOD through the camera distance argument (lodDistance = 10 m).
            const dist = [2, 15, 40][s.lod];
            s.view.update(dt, rigPose(s.x), dist, 10);
        }
        placeCamera();
    });

    // UI.
    const btns = (host: string, list: readonly string[], cur: () => string, set: (v: string) => void) => {
        const el = document.getElementById(host)!;
        const render = () => {
            el.replaceChildren();
            for (const v of list) {
                const b = document.createElement('button');
                b.textContent = v;
                if (v === cur()) b.className = 'on';
                b.onclick = () => {
                    set(v);
                    render();
                };
                el.append(b);
            }
        };
        render();
    };
    btns('views', VIEWS, () => view, (v) => (view = v as ViewName));
    btns('poses', POSES, () => pose, (v) => {
        pose = v as PoseName;
        clock = 0;
    });
    btns('weapons', PLAYABLE_WEAPONS, () => weapon, (v) => (weapon = v as WeaponId));
    const stats = lib.triangles({ appearance: DEFAULT_APPEARANCE, team: 'blue', weapon: 'paint-rifle' });
    status.textContent = `GLB 로드 ${loadMs} ms · 삼각형 LOD0/1/2 = ${stats.join(' / ')}`;

    // Automation hooks (Playwright captures).
    const w = window as unknown as Record<string, unknown>;
    w.__preview = {
        app,
        slots,
        loadMs,
        triangles: stats,
        setView: (v: ViewName) => {
            view = v;
            placeCamera();
        },
        setPose: (p: PoseName) => {
            pose = p;
            clock = 0;
        },
        setWeapon: (w: WeaponId) => {
            weapon = w;
        },
        /** Advance the simulation deterministically (time frozen afterwards). */
        step: (sec: number, dt = 1 / 60) => {
            app.timeScale = 0; // stay frozen: only these explicit steps advance time
            for (let i = 0; i < Math.round(sec / dt); i++) app.fire('update', dt);
        },
        freeze: (on: boolean) => {
            app.timeScale = on ? 0 : 1;
        },
        muzzle: () => slots.map((s) => s.view.muzzle(new Vec3()).toString()),
        hideUi: (on: boolean) => {
            document.getElementById('ui')!.style.display = on ? 'none' : '';
        }
    };
}

main().catch((err: unknown) => {
    console.error(err);
});
