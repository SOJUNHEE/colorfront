import {
    FixedStepper,
    InputButton,
    MATCH_START,
    MatchSimulation,
    SimpleBot,
    TICK_DT,
    TICK_RATE,
    WEAPONS,
    paintSpeedMultiplier,
    reloadTicks,
    sanitizeInput,
    unpackShot,
    unpackVec
} from '@colorfront/shared';
import type {
    MapDefinition,
    MatchEvent,
    NetEvent,
    PaintGrid,
    PaintScore,
    PlayerInput,
    PlayerState,
    ShotTrace,
    TeamId,
    Vec3
} from '@colorfront/shared';
import { Entity, Vec3 as PcVec3 } from 'playcanvas';
import type { AppBase } from 'playcanvas';

import { OnlineSession, defaultServerUrl } from '../network/OnlineSession.ts';
import type { NetActor } from '../network/OnlineSession.ts';
import { PaintEffects } from '../paint/PaintEffects.ts';
import { PaintRenderer } from '../paint/PaintRenderer.ts';
import { AvatarFactory, avatarKindFromUrl } from '../player/AvatarView.ts';
import type { AvatarView } from '../player/AvatarView.ts';
import { ThirdPersonCamera } from '../player/ThirdPersonCamera.ts';
import { SceneEnvironment } from '../render/Environment.ts';
import { PostEffects } from '../render/PostEffects.ts';
import { buildArena } from '../scenes/ArenaBuilder.ts';
import type { ArenaView } from '../scenes/ArenaBuilder.ts';
import { QUALITY_PROFILES, saveSettings } from '../settings/settings.ts';
import type { GameSettings, GraphicsQuality } from '../settings/settings.ts';
import { Hud } from '../ui/Hud.ts';
import { MatchPanel } from '../ui/MatchPanel.ts';
import { SettingsMenu } from '../ui/SettingsMenu.ts';

import { InputManager } from './InputManager.ts';

const OFFLINE_LOCAL_ID = 'local';

type Actor = {
    state: PlayerState;
    rig: AvatarView;
    prev: Vec3;
    /** Offline only: a local bot (graphics/load tool, never a network player). */
    bot: SimpleBot | null;
    name: string;
    /** Online only: the replicated player this actor draws. */
    net: NetActor | null;
};

export type GameMode = 'menu' | 'offline' | 'online';

/**
 * One rendered match. Two clearly separated sources of truth:
 *  - offline: the local player plus optional local bots, stepped here by the shared
 *    MatchSimulation (practice and graphics/load testing);
 *  - online: the authoritative Colyseus room. This client only sends inputs, predicts its own
 *    player and draws what the server replicates (players, events, paint).
 * Rendering, effects and HUD read state; nothing visual feeds back into the simulation.
 */
export class Game {
    private readonly app: AppBase;
    private readonly map: MapDefinition;
    private readonly sim: MatchSimulation;
    private readonly input: InputManager;
    private readonly stepper = new FixedStepper(TICK_DT);
    private readonly actors = new Map<string, Actor>();
    private local: Actor;
    private localId = OFFLINE_LOCAL_ID;
    private readonly camera: Entity;
    private readonly followCamera: ThirdPersonCamera;
    private readonly environment: SceneEnvironment;
    private readonly post: PostEffects;
    private readonly hud: Hud;
    private readonly menu: SettingsMenu;
    private readonly matchPanel: MatchPanel;
    private readonly paintRenderer: PaintRenderer;
    private readonly effects: PaintEffects;
    /** Player views: legacy rig until the GLB avatars are loaded, then upgraded in place. */
    private readonly avatars: AvatarFactory;
    private arena: ArenaView;
    private arenaQuality: GraphicsQuality;
    private lastShot: ShotTrace | null = null;
    private settings: GameSettings;
    private seq = 0;
    private botSerial = 0;
    private frameCount = 0;
    private frameTime = 0;
    private stats = { fps: 0, frameMs: 0 };
    private readonly frameSamples: number[] = [];
    private readonly tmp = new PcVec3();
    mode: GameMode = 'menu';
    online: OnlineSession | null = null;
    /** Renderer time until which freshly replicated paint stays hidden (slug still in flight). */
    private landingUntil = 0;

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
        this.avatars = new AvatarFactory(app, avatarKindFromUrl());

        this.camera = new Entity('camera');
        this.camera.addComponent('camera', { nearClip: 0.1, farClip: 1200 });
        app.root.addChild(this.camera);
        this.followCamera = new ThirdPersonCamera(this.camera, this.sim.world);
        this.post = new PostEffects(app, this.camera.camera!);

        this.local = this.addActor(OFFLINE_LOCAL_ID, 'blue', null, 'YOU');
        this.input.yaw = this.local.state.yaw;

        this.hud = new Hud(uiRoot);
        this.matchPanel = new MatchPanel(uiRoot);
        this.menu = new SettingsMenu(uiRoot, settings);
        this.hud.setVisible(false);
        this.menu.show('start');

        this.menu.onChange = (next) => {
            this.settings = next;
            saveSettings(next);
            this.applySettings();
        };
        this.menu.onPlay = () => this.lockPointer();
        this.menu.onPlayOffline = () => {
            this.mode = 'offline';
            this.hud.setModeLabel('오프라인 연습 · 로컬 봇');
            this.lockPointer();
        };
        this.menu.onPlayOnline = (name) => {
            this.lockPointer();
            this.startOnline(name);
        };
        this.menu.onReady = () => this.toggleReady();
        this.menu.onLeaveOnline = () => {
            this.online?.leave();
            location.href = location.pathname;
        };
        this.input.onLockChange = (locked) => {
            this.hud.setVisible(locked);
            if (locked) this.menu.hide();
            else this.menu.show(this.mode === 'menu' ? 'start' : 'paused');
        };
        this.menu.onTeam = (team) => this.setTeam(team);
        this.menu.onClearPaint = () => {
            if (this.mode === 'online') return;
            this.sim.paint.clear();
            this.hud.showToast('페인트를 초기화했습니다');
        };
        this.menu.onBots = (count) => {
            if (this.mode === 'online') return;
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
            if (code === 'KeyT' && this.mode !== 'online')
                this.setTeam(this.local.state.team === 'blue' ? 'orange' : 'blue');
            if (code === 'KeyG') this.toggleReady();
        };
        this.menu.setTeam(this.local.state.team);

        this.applySettings();
        app.on('update', this.update, this);

        // Direct links (?mode=online[&room=ID][&name=NICK]) join without the start screen; the
        // pointer still needs one click on "계속하기".
        const params = new URLSearchParams(location.search);
        if (params.get('mode') === 'online' || params.has('room')) {
            this.startOnline(params.get('name') ?? '', params.get('room') ?? undefined);
            this.menu.show('paused');
        }
    }

    private victory = false;

    private lockPointer() {
        this.input.requestLock().catch(() => {
            this.menu.setMessage('마우스 잠금을 시작하지 못했습니다. 잠시 후 다시 클릭하세요.');
        });
    }

    private buildArena(quality: GraphicsQuality): ArenaView {
        const p = QUALITY_PROFILES[quality];
        return buildArena(this.app, this.map, {
            textureSize: quality === 'low' ? 256 : 512,
            decorDensity: p.decorDensity
        });
    }

    private addActor(id: string, team: TeamId, bot: SimpleBot | null, name: string): Actor {
        const state = this.sim.addPlayer(id, team);
        const rig = this.avatars.create(team, this.actors.size * 7 + 3);
        const actor: Actor = { state, rig, prev: { ...state.position }, bot, name, net: null };
        this.actors.set(id, actor);
        return actor;
    }

    private removeActor(id: string) {
        const a = this.actors.get(id);
        if (!a || id === this.localId) return;
        a.rig.root.destroy();
        this.actors.delete(id);
        this.sim.removePlayer(id);
    }

    // ── online ─────────────────────────────────────────────────────────────────

    private startOnline(name: string, roomId?: string) {
        if (this.online) return;
        this.mode = 'online';
        this.menu.setOnline(true);
        this.hud.setModeLabel('온라인 · 서버 판정');
        this.matchPanel.setVisible(true);
        // Leave offline practice completely: no bots, no locally simulated player, clean paint.
        for (const id of [...this.actors.keys()]) {
            const a = this.actors.get(id)!;
            a.rig.root.destroy();
            this.sim.removePlayer(id);
        }
        this.actors.clear();
        this.sim.paint.clear();

        const session = new OnlineSession(this.sim.paint, this.sim.world);
        this.online = session;
        session.onActorAdded = (net) => this.addNetActor(net);
        session.onActorRemoved = (id) => {
            const a = this.actors.get(id);
            if (!a) return;
            a.rig.root.destroy();
            this.actors.delete(id);
        };
        session.onWelcome = (net) => {
            this.localId = net.id;
            this.input.yaw = this.map.spawnZones.find((z) => z.team === net.team)?.yaw ?? 0;
            this.input.pitch = 0;
        };
        session.onEvents = (events) => this.handleNetEvents(events);
        session.onPaint = (changed) => {
            if (this.landingUntil <= this.paintRenderer.now) return;
            for (const i of changed) this.paintRenderer.hold(i, this.landingUntil);
        };
        session.onPhase = (phase) => {
            if (phase === 'COUNTDOWN' && this.online?.local) {
                // Round reset puts everyone back at spawn facing the arena.
                this.input.yaw = this.map.spawnZones.find((z) => z.team === this.online!.local!.team)?.yaw ?? 0;
                this.input.pitch = 0;
                this.hud.showToast('라운드 시작 준비! 페인트가 초기화되었습니다', 2);
            }
            if (phase === 'PLAYING') this.hud.showToast('경기 시작!', 1.5);
        };
        session.onResult = (r) => this.matchPanel.showResult(r, this.localId, this.online?.local?.team ?? null);
        session.onStatus = (status) => {
            if (status === 'reconnecting') this.hud.showToast('연결이 끊겼습니다. 재연결 중…', 3);
            if (status === 'connected' && this.online?.sessionId) this.hud.showToast('서버에 연결되었습니다', 1.5);
            if (status === 'disconnected' || status === 'error') this.menu.setMessage(`서버 연결 끊김: ${this.online?.error ?? ''}`);
        };
        session.connect(defaultServerUrl(), name, roomId, devRoomOptions()).catch((err: unknown) => {
            console.error(err);
            this.menu.setMessage(`서버에 연결하지 못했습니다 (${defaultServerUrl()}). 서버가 실행 중인지 확인하세요: npm run dev:server`);
        });
    }

    private addNetActor(net: NetActor) {
        const rig = this.avatars.create(net.team, this.actors.size * 7 + 3);
        const actor: Actor = { state: net.state, rig, prev: { ...net.state.position }, bot: null, name: net.name, net };
        this.actors.set(net.id, actor);
        if (net.id === this.online?.sessionId) this.local = actor;
        rig.setVisible(net.state.alive);
    }

    private toggleReady() {
        const s = this.online;
        if (!s?.local || s.phase !== 'WAITING') return;
        s.setReady(!s.local.ready);
        this.menu.setReady(!s.local.ready);
    }

    private handleNetEvents(events: NetEvent[]) {
        let landing = 0;
        for (const e of events) {
            if (e.t !== 's') this.debugEventLog.push(JSON.stringify(e));
            else this.debugEventLog.push(`s:${e.p}:${e.h ?? '-'}`);
            if (this.debugEventLog.length > 200) this.debugEventLog.splice(0, 100);
            switch (e.t) {
                case 's':
                    // Our own shots were already shown by prediction.
                    if (e.p === this.localId) break;
                    landing = Math.max(
                        landing,
                        this.handleEvent({
                            type: 'shot',
                            playerId: e.p,
                            team: this.actors.get(e.p)?.state.team ?? 'blue',
                            paintedCells: 0,
                            shot: unpackShot(e)
                        })
                    );
                    break;
                case 'h':
                    this.handleEvent({ type: 'hit', attackerId: e.a, targetId: e.v, damage: e.dmg, at: unpackVec(e.at) });
                    break;
                case 'k':
                    this.handleEvent({ type: 'splat', attackerId: e.a, targetId: e.v, team: e.team, at: unpackVec(e.at) });
                    break;
                case 'r':
                    this.handleEvent({ type: 'respawn', playerId: e.p });
                    break;
                default:
                    break;
            }
        }
        if (landing > 0) this.landingUntil = Math.max(this.landingUntil, this.paintRenderer.now + landing);
    }

    // ── offline ────────────────────────────────────────────────────────────────

    /** Developer tool: fill the match with local bots (teams balanced around the local player). */
    setBots(count: number) {
        if (this.mode === 'online') return;
        for (const id of [...this.actors.keys()]) if (id !== this.localId) this.removeActor(id);
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
        if (this.mode === 'online') return;
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
        if (this.mode === 'online') {
            this.tickOnline();
            return;
        }
        const inputs = new Map<string, PlayerInput>();
        const { moveX, moveZ } = this.input.moveAxes();
        inputs.set(
            this.localId,
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

    private tickOnline() {
        const session = this.online!;
        const local = session.local ? this.actors.get(session.local.id) : undefined;
        if (local) {
            local.prev.x = local.state.position.x;
            local.prev.y = local.state.position.y;
            local.prev.z = local.state.position.z;
        }
        const { moveX, moveZ } = this.input.moveAxes();
        const step = session.tick(
            { moveX, moveZ, yaw: this.input.yaw, pitch: this.input.pitch, buttons: this.input.sampleButtons() },
            performance.now()
        );
        if (step?.shot && local) {
            // Predicted shot: recoil, rifle animation and slug now; paint arrives from the server.
            const landing = this.handleEvent({ type: 'shot', playerId: this.localId, team: local.state.team, shot: step.shot, paintedCells: 0 });
            this.landingUntil = Math.max(this.landingUntil, this.paintRenderer.now + landing);
        }
    }

    /** React to a simulation event; returns the projectile flight time for shot events. */
    private handleEvent(e: MatchEvent): number {
        switch (e.type) {
            case 'shot': {
                const a = this.actors.get(e.playerId);
                if (!a) return 0;
                if (e.playerId === this.localId) {
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
                if (e.targetId === this.localId) {
                    this.hud.tookDamage(e.damage / 100);
                    this.followCamera.shake(0.35);
                }
                if (e.attackerId === this.localId) this.hud.showHitMarker(false);
                return 0;
            }
            case 'splat': {
                const target = this.actors.get(e.targetId);
                const attacker = this.actors.get(e.attackerId);
                const killerTeam = attacker?.state.team ?? (e.team === 'blue' ? 'orange' : 'blue');
                this.effects.burst(killerTeam, e.at);
                if (target) target.rig.setVisible(false);
                const aName = attacker?.net?.name ?? attacker?.name;
                const tName = target?.net?.name ?? target?.name;
                if (attacker && target && aName && tName)
                    this.hud.pushFeed(aName, attacker.state.team, tName, target.state.team);
                if (e.attackerId === this.localId) this.hud.showHitMarker(true);
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
                if (e.playerId === this.localId) {
                    // Online, the replicated spawn may land a patch later; face the arena either way.
                    this.input.yaw =
                        this.mode === 'online'
                            ? (this.map.spawnZones.find((z) => z.team === a.state.team)?.yaw ?? a.state.yaw)
                            : a.state.yaw;
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
        const online = this.mode === 'online' ? this.online : null;
        if (online) {
            online.interpolate(performance.now());
            online.decaySmoothing(dt);
        }
        const aiming = this.input.isHeld(InputButton.Aim);
        const ls = this.local.state;
        const lp = this.local.prev;
        const off = online?.smoothing ?? { x: 0, y: 0, z: 0 };
        const lx = lp.x + (ls.position.x - lp.x) * alpha + off.x;
        const ly = lp.y + (ls.position.y - lp.y) * alpha + off.y;
        const lz = lp.z + (ls.position.z - lp.z) * alpha + off.z;

        this.followCamera.zoom(this.input.consumeWheel());
        this.followCamera.update(dt, { x: lx, y: ly, z: lz, yaw: this.input.yaw, pitch: this.input.pitch, aiming });
        const cam = this.camera.getPosition();
        const profile = QUALITY_PROFILES[this.settings.quality];

        for (const a of this.actors.values()) {
            const s = a.state;
            const isLocal = a === this.local;
            let x: number;
            let y: number;
            let z: number;
            if (isLocal) {
                x = lx;
                y = ly;
                z = lz;
            } else if (online) {
                // Remote players were already interpolated ~100 ms in the past.
                x = s.position.x;
                y = s.position.y;
                z = s.position.z;
            } else {
                x = a.prev.x + (s.position.x - a.prev.x) * alpha;
                y = a.prev.y + (s.position.y - a.prev.y) * alpha;
                z = a.prev.z + (s.position.z - a.prev.z) * alpha;
            }
            const total = reloadTicks(WEAPONS[s.weaponId]) || 1;
            const camDist = Math.hypot(x - cam.x, y - cam.y, z - cam.z);
            if (online && a.net) a.rig.setVisible(s.alive);
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
                    aiming: isLocal ? aiming : (s.lastButtons & InputButton.Aim) !== 0,
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
        const score = this.currentScore();
        this.arena.update(dt, score);

        this.measureFrame(dt);
        this.hud.setRespawn(ls.alive ? null : ls.respawnTicks / TICK_RATE);
        this.hud.update(dt, ls, aiming, this.stats, score, paintSpeedMultiplier(this.sim.paint, ls));
        if (online) {
            this.matchPanel.update({
                status: online.status,
                roomId: online.roomId,
                rttMs: online.rttMs,
                phase: online.phase,
                ticksLeft: online.ticksLeft,
                round: online.round,
                actors: online.actors.values(),
                localId: this.localId,
                minPlayers: MATCH_START.customRoomMinPlayers,
                syncOk: !online.receiver.resyncing
            });
            this.menu.setReady(online.local?.ready ?? false);
        }
    }

    /** Online: the server's replicated counts (what every client shows). Offline: the local grid. */
    private currentScore(): PaintScore {
        if (this.mode === 'online' && this.online) {
            const { blue, orange, paintable } = this.online.score;
            const total = paintable || this.sim.paint.paintableCount;
            return { blue, orange, paintable: total, unpainted: total - blue - orange };
        }
        return this.sim.paint.score();
    }

    private measureFrame(dt: number) {
        this.frameCount++;
        this.frameTime += dt;
        this.frameSamples.push(dt * 1000);
        if (this.frameSamples.length > 600) this.frameSamples.shift();
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

    /** Avatar pipeline state (GLB loading / fallback) for checks and perf scripts. */
    get debugAvatars() {
        const kinds: Record<string, number> = {};
        const lods: Record<string, number> = {};
        for (const a of this.actors.values()) {
            const k = (a.rig as { kind?: string }).kind ?? 'legacy';
            kinds[k] = (kinds[k] ?? 0) + 1;
            lods[a.rig.currentLod] = (lods[a.rig.currentLod] ?? 0) + 1;
        }
        return { status: this.avatars.status, error: this.avatars.error, pending: this.avatars.pending, kinds, lods, settled: this.avatars.settled };
    }

    debugStats() {
        return {
            droplets: this.effects.dropletCount,
            uploads: this.paintRenderer.uploadsThisFrame,
            actors: this.actors.size
        };
    }

    /** Online diagnostics for the two-browser verification (read-only). */
    debugNet() {
        const s = this.online;
        if (!s) return null;
        const sorted = [...this.frameSamples].sort((a, b) => a - b);
        const p95 = sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : 0;
        const delays = [...s.paintDelays].sort((a, b) => a - b);
        const local = s.local;
        return {
            status: s.status,
            sessionId: s.sessionId,
            roomId: s.roomId,
            phase: s.phase,
            round: s.round,
            ticksLeft: s.ticksLeft,
            team: local?.team ?? null,
            hp: local?.state.hp ?? null,
            alive: local?.state.alive ?? null,
            ammo: local?.state.ammo ?? null,
            position: local ? { ...local.state.position } : null,
            players: [...s.actors.values()].map((a) => ({
                id: a.id,
                name: a.name,
                team: a.team,
                connected: a.connected,
                ready: a.ready,
                alive: a.state.alive,
                kills: a.kills,
                deaths: a.deaths,
                painted: a.painted,
                x: +a.state.position.x.toFixed(2),
                y: +a.state.position.y.toFixed(2),
                z: +a.state.position.z.toFixed(2),
                dash: a.state.dashTicksRemaining,
                visible: this.actors.get(a.id)?.rig.root.enabled ?? false
            })),
            score: { ...s.score },
            clientGrid: { blue: this.sim.paint.blueCount, orange: this.sim.paint.orangeCount, hash: this.sim.paint.hash() },
            paintSeq: s.receiver.seq,
            snapshots: s.receiver.snapshots,
            deltas: s.receiver.deltas,
            gaps: s.receiver.gaps,
            hashChecks: s.hashChecks,
            hashMismatches: s.hashMismatches,
            lastServerHash: s.lastHash,
            result: s.result,
            rttMs: +s.rttMs.toFixed(1),
            bytesIn: s.bytesIn,
            bytesOut: s.bytesOut,
            corrections: s.corrections,
            snaps: s.snaps,
            reconnectError: s.reconnectError,
            pendingInputs: s.pendingInputs,
            paintDelayMs: delays.length ? { p50: delays[Math.floor(delays.length / 2)], p95: delays[Math.floor(delays.length * 0.95)], n: delays.length } : null,
            fps: +this.stats.fps.toFixed(1),
            frameP95Ms: +p95.toFixed(2),
            events: this.debugEventLog.slice(-40)
        };
    }

    readonly debugEventLog: string[] = [];

    debugDrop() {
        this.online?.simulateDrop();
    }
}

/** DEV only: `?seconds=90` asks a newly created room for a short round (tests, demos). */
function devRoomOptions(): Record<string, unknown> {
    if (!import.meta.env.DEV) return {};
    const seconds = Number(new URLSearchParams(location.search).get('seconds'));
    if (!Number.isFinite(seconds) || seconds <= 0) return {};
    return { timing: { countdownSeconds: 5, playingSeconds: seconds, resultsRevealSeconds: 3, resultsSummarySeconds: 12 } };
}
