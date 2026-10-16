import {
    FixedStepper,
    InputButton,
    MatchSimulation,
    SimpleBot,
    TICK_DT,
    TICK_RATE,
    WEAPONS,
    paintSpeedMultiplier,
    reloadTicks,
    sanitizeInput
} from '@colorfront/shared';
import type {
    MapDefinition,
    MatchEvent,
    PaintGrid,
    PlayerInput,
    PlayerState,
    ShotTrace,
    TeamId,
    Vec3
} from '@colorfront/shared';
import { Entity, Vec3 as PcVec3 } from 'playcanvas';
import type { AppBase } from 'playcanvas';

import { PaintEffects } from '../paint/PaintEffects.ts';
import { PaintRenderer } from '../paint/PaintRenderer.ts';
import { CharacterRig } from '../player/CharacterRig.ts';
import { ThirdPersonCamera } from '../player/ThirdPersonCamera.ts';
import { SceneEnvironment } from '../render/Environment.ts';
import { PostEffects } from '../render/PostEffects.ts';
import { buildArena } from '../scenes/ArenaBuilder.ts';
import type { ArenaView } from '../scenes/ArenaBuilder.ts';
import { QUALITY_PROFILES, saveSettings } from '../settings/settings.ts';
import type { GameSettings, GraphicsQuality } from '../settings/settings.ts';
import { Hud } from '../ui/Hud.ts';
import { SettingsMenu } from '../ui/SettingsMenu.ts';

import { InputManager } from './InputManager.ts';

const LOCAL_ID = 'local';

type Actor = {
    state: PlayerState;
    rig: CharacterRig;
    prev: Vec3;
    bot: SimpleBot | null;
    name: string;
};

/**
 * Offline session: the local player plus optional local bots, all driven by the shared
 * MatchSimulation (the same tick the Phase 3 server will run). Rendering, effects and HUD read
 * the simulation; nothing visual feeds back into it.
 */
export class Game {
    private readonly app: AppBase;
    private readonly map: MapDefinition;
    private readonly sim: MatchSimulation;
    private readonly input: InputManager;
    private readonly stepper = new FixedStepper(TICK_DT);
    private readonly actors = new Map<string, Actor>();
    private readonly local: Actor;
    private readonly camera: Entity;
    private readonly followCamera: ThirdPersonCamera;
    private readonly environment: SceneEnvironment;
    private readonly post: PostEffects;
    private readonly hud: Hud;
    private readonly menu: SettingsMenu;
    private readonly paintRenderer: PaintRenderer;
    private readonly effects: PaintEffects;
    private arena: ArenaView;
    private arenaQuality: GraphicsQuality;
    private lastShot: ShotTrace | null = null;
    private settings: GameSettings;
    private seq = 0;
    private botSerial = 0;
    private frameCount = 0;
    private frameTime = 0;
    private stats = { fps: 0, frameMs: 0 };
    private readonly tmp = new PcVec3();

    constructor(app: AppBase, map: MapDefinition, settings: GameSettings, uiRoot: HTMLElement) {
        this.app = app;
        this.map = map;
        this.settings = settings;
        this.sim = new MatchSimulation(map);
        this.input = new InputManager(app.graphicsDevice.canvas as HTMLCanvasElement);

        const profile = QUALITY_PROFILES[settings.quality];
        this.environment = new SceneEnvironment(app);
        this.arenaQuality = settings.quality;
        this.arena = this.buildArena(settings.quality);
        this.paintRenderer = new PaintRenderer(app, this.sim.paint, profile.paintDetail);
        this.effects = new PaintEffects(app, profile.particleBudget);

        this.camera = new Entity('camera');
        this.camera.addComponent('camera', { nearClip: 0.1, farClip: 1200 });
        app.root.addChild(this.camera);
        this.followCamera = new ThirdPersonCamera(this.camera, this.sim.world);
        this.post = new PostEffects(app, this.camera.camera!);

        this.local = this.addActor(LOCAL_ID, 'blue', null, 'YOU');
        this.input.yaw = this.local.state.yaw;

        this.hud = new Hud(uiRoot);
        this.menu = new SettingsMenu(uiRoot, settings);
        this.hud.setVisible(false);
        this.menu.show('start');

        this.menu.onChange = (next) => {
            this.settings = next;
            saveSettings(next);
            this.applySettings();
        };
        this.menu.onPlay = () => {
            this.input.requestLock().catch(() => {
                this.menu.setMessage('마우스 잠금을 시작하지 못했습니다. 잠시 후 다시 클릭하세요.');
            });
        };
        this.input.onLockChange = (locked) => {
            this.hud.setVisible(locked);
            if (locked) this.menu.hide();
            else this.menu.show('paused');
        };
        this.menu.onTeam = (team) => this.setTeam(team);
        this.menu.onClearPaint = () => {
            this.sim.paint.clear();
            this.hud.showToast('페인트를 초기화했습니다');
        };
        this.menu.onBots = (count) => {
            this.setBots(count);
            this.hud.showToast(
                count
                    ? `로컬 봇 ${count}명 (${Math.ceil((count + 1) / 2)} vs ${Math.floor((count + 1) / 2)})`
                    : '봇을 모두 제거했습니다'
            );
        };
        this.menu.onVictory = () => {
            this.victory = !this.victory;
            for (const a of this.actors.values())
                a.rig.celebrate(this.victory && a.state.team === this.local.state.team);
        };
        this.input.onKeyAction = (code) => {
            if (code === 'KeyT') this.setTeam(this.local.state.team === 'blue' ? 'orange' : 'blue');
        };
        this.menu.setTeam(this.local.state.team);

        this.applySettings();
        app.on('update', this.update, this);
    }

    private victory = false;

    private buildArena(quality: GraphicsQuality): ArenaView {
        const p = QUALITY_PROFILES[quality];
        return buildArena(this.app, this.map, {
            textureSize: quality === 'low' ? 256 : 512,
            decorDensity: p.decorDensity
        });
    }

    private addActor(id: string, team: TeamId, bot: SimpleBot | null, name: string): Actor {
        const state = this.sim.addPlayer(id, team);
        const rig = new CharacterRig(this.app, team, this.actors.size * 7 + 3);
        const actor = { state, rig, prev: { ...state.position }, bot, name };
        this.actors.set(id, actor);
        return actor;
    }

    private removeActor(id: string) {
        const a = this.actors.get(id);
        if (!a || id === LOCAL_ID) return;
        a.rig.root.destroy();
        this.actors.delete(id);
        this.sim.removePlayer(id);
    }

    /** Developer tool: fill the match with local bots (teams balanced around the local player). */
    setBots(count: number) {
        for (const id of [...this.actors.keys()]) if (id !== LOCAL_ID) this.removeActor(id);
        const mine = this.local.state.team;
        const other: TeamId = mine === 'blue' ? 'orange' : 'blue';
        const enemies = Math.ceil(count / 2);
        for (let i = 0; i < count; i++) {
            const team = i < enemies ? other : mine;
            const n = ++this.botSerial;
            const id = `bot${n}`;
            this.addActor(id, team, new SimpleBot(id, 9000 + n), `BOT-${String(n).padStart(2, '0')}`);
        }
    }

    /** Developer tool: switch which team the local player paints for. */
    private setTeam(team: TeamId) {
        const s = this.local.state;
        if (s.team === team) return;
        s.team = team;
        this.local.rig.setTeam(team);
        this.menu.setTeam(team);
        this.hud.showToast(team === 'blue' ? '▲ 블루팀으로 도색합니다' : '■ 오렌지팀으로 도색합니다', 1.5);
    }

    copyPrevious() {
        for (const a of this.actors.values()) {
            a.prev.x = a.state.position.x;
            a.prev.y = a.state.position.y;
            a.prev.z = a.state.position.z;
        }
    }

    private tick() {
        const inputs = new Map<string, PlayerInput>();
        const { moveX, moveZ } = this.input.moveAxes();
        inputs.set(
            LOCAL_ID,
            sanitizeInput({
                seq: ++this.seq,
                moveX,
                moveZ,
                yaw: this.input.yaw,
                pitch: this.input.pitch,
                buttons: this.input.sampleButtons()
            })
        );
        for (const a of this.actors.values())
            if (a.bot && a.state.alive) inputs.set(a.state.id, a.bot.think(a.state, this.sim));
        this.copyPrevious();
        const before = Array.from(this.sim.paint.surfaceRevisions);
        const events = this.sim.step(inputs);
        let landing = 0;
        for (const e of events) landing = Math.max(landing, this.handleEvent(e));
        // Hold back newly painted surfaces until the visual slug lands there.
        if (landing > 0) {
            this.sim.paint.surfaceRevisions.forEach((rev, i) => {
                if (rev !== before[i]) this.paintRenderer.hold(i, this.paintRenderer.now + landing);
            });
        }
    }

    /** React to a simulation event; returns the projectile flight time for shot events. */
    private handleEvent(e: MatchEvent): number {
        switch (e.type) {
            case 'shot': {
                const a = this.actors.get(e.playerId);
                if (!a) return 0;
                if (e.playerId === LOCAL_ID) {
                    this.lastShot = e.shot;
                    this.followCamera.kick();
                }
                a.rig.fired();
                // Effects start at the rifle nozzle of the visible model.
                const muzzle = a.rig.muzzle(this.tmp);
                const visual = { ...e.shot, origin: { x: muzzle.x, y: muzzle.y, z: muzzle.z } };
                return this.effects.fire(visual, e.team, WEAPONS[a.state.weaponId].paintRadius);
            }
            case 'hit': {
                const target = this.actors.get(e.targetId);
                const attacker = this.actors.get(e.attackerId);
                if (target) {
                    target.rig.hit();
                    const p = target.state.position;
                    this.effects.hitSpray(attacker?.state.team ?? 'blue', e.at, {
                        x: e.at.x - p.x,
                        y: 0,
                        z: e.at.z - p.z
                    });
                }
                if (e.targetId === LOCAL_ID) {
                    this.hud.tookDamage(e.damage / 100);
                    this.followCamera.shake(0.35);
                }
                if (e.attackerId === LOCAL_ID) this.hud.showHitMarker(false);
                return 0;
            }
            case 'splat': {
                const target = this.actors.get(e.targetId);
                const attacker = this.actors.get(e.attackerId);
                const killerTeam = attacker?.state.team ?? (e.team === 'blue' ? 'orange' : 'blue');
                this.effects.burst(killerTeam, e.at);
                if (target) target.rig.setVisible(false);
                if (attacker && target)
                    this.hud.pushFeed(attacker.name, attacker.state.team, target.name, target.state.team);
                if (e.attackerId === LOCAL_ID) this.hud.showHitMarker(true);
                const d = Math.hypot(e.at.x - this.local.state.position.x, e.at.z - this.local.state.position.z);
                if (d < 12) this.followCamera.shake(0.5 * (1 - d / 12));
                return 0;
            }
            case 'respawn': {
                const a = this.actors.get(e.playerId);
                if (!a) return 0;
                a.rig.setVisible(true);
                a.rig.respawned();
                a.prev = { ...a.state.position };
                if (e.playerId === LOCAL_ID) {
                    this.input.yaw = a.state.yaw;
                    this.input.pitch = 0;
                }
                return 0;
            }
            default:
                return 0;
        }
    }

    update(dt: number) {
        const alpha = this.stepper.advance(dt, () => this.tick());
        const aiming = this.input.isHeld(InputButton.Aim);
        const ls = this.local.state;
        const lp = this.local.prev;
        const lx = lp.x + (ls.position.x - lp.x) * alpha;
        const ly = lp.y + (ls.position.y - lp.y) * alpha;
        const lz = lp.z + (ls.position.z - lp.z) * alpha;

        this.followCamera.zoom(this.input.consumeWheel());
        this.followCamera.update(dt, { x: lx, y: ly, z: lz, yaw: this.input.yaw, pitch: this.input.pitch, aiming });
        const cam = this.camera.getPosition();
        const profile = QUALITY_PROFILES[this.settings.quality];

        for (const a of this.actors.values()) {
            const s = a.state;
            const isLocal = a === this.local;
            const x = a.prev.x + (s.position.x - a.prev.x) * alpha;
            const y = a.prev.y + (s.position.y - a.prev.y) * alpha;
            const z = a.prev.z + (s.position.z - a.prev.z) * alpha;
            const total = reloadTicks(WEAPONS[s.weaponId]) || 1;
            const camDist = Math.hypot(x - cam.x, y - cam.y, z - cam.z);
            if (!s.alive) continue;
            a.rig.update(
                dt,
                {
                    x,
                    y,
                    z,
                    // The local character follows the live mouse look for responsiveness.
                    yaw: isLocal ? this.input.yaw : s.yaw,
                    pitch: isLocal ? this.input.pitch : s.pitch,
                    vx: s.velocity.x,
                    vz: s.velocity.z,
                    vy: s.velocity.y,
                    grounded: s.grounded,
                    aiming: isLocal && aiming,
                    dashing: s.dashTicksRemaining > 0,
                    reload: s.reloadTicksRemaining > 0 ? 1 - s.reloadTicksRemaining / total : -1,
                    ammo: s.ammo / (WEAPONS[s.weaponId].magazineSize ?? 1),
                    alive: s.alive
                },
                camDist,
                profile.characterLodDistance
            );
        }

        this.paintRenderer.update(dt);
        this.effects.update(dt);
        const score = this.sim.paint.score();
        this.arena.update(dt, score);

        this.measureFrame(dt);
        this.hud.setRespawn(ls.alive ? null : ls.respawnTicks / TICK_RATE);
        this.hud.update(dt, ls, aiming, this.stats, score, paintSpeedMultiplier(this.sim.paint, ls));
    }

    private measureFrame(dt: number) {
        this.frameCount++;
        this.frameTime += dt;
        if (this.frameTime >= 0.5) {
            this.stats = { fps: this.frameCount / this.frameTime, frameMs: (this.frameTime / this.frameCount) * 1000 };
            this.frameCount = 0;
            this.frameTime = 0;
        }
    }

    applySettings() {
        const s = this.settings;
        const profile = QUALITY_PROFILES[s.quality];
        const device = this.app.graphicsDevice;
        device.maxPixelRatio = Math.min(window.devicePixelRatio || 1, profile.maxPixelRatio) * s.renderScale;
        this.app.resizeCanvas();
        if (s.quality !== this.arenaQuality) {
            // Decor density and texture resolution are baked into the level meshes.
            this.arena.destroy();
            this.arena = this.buildArena(s.quality);
            this.arenaQuality = s.quality;
        }
        this.environment.apply(profile);
        this.post.apply(profile);
        this.paintRenderer.setDetail(profile.paintDetail, profile.post !== 'none');
        this.effects.budget = profile.particleBudget;
        this.followCamera.baseFov = s.fov;
        this.followCamera.shakeEnabled = s.cameraShake;
        this.input.sensitivity = s.sensitivity;
        this.input.invertY = s.invertY;
        this.hud.setFpsVisible(s.showFps);
    }

    /** Debug hooks used by browser checks and the visual/perf scripts; not part of gameplay. */
    get debugState(): PlayerState {
        return this.local.state;
    }

    get debugPaint(): PaintGrid {
        return this.sim.paint;
    }

    get debugLastShot(): ShotTrace | null {
        return this.lastShot;
    }

    get debugSim(): MatchSimulation {
        return this.sim;
    }

    debugSpawnBots(count: number) {
        this.setBots(count);
    }

    debugStats() {
        return {
            droplets: this.effects.dropletCount,
            uploads: this.paintRenderer.uploadsThisFrame,
            actors: this.actors.size
        };
    }
}
