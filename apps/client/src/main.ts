import { NEON_TERMINAL } from '@colorfront/shared';
import {
    AppBase,
    AppOptions,
    CameraComponentSystem,
    ContainerHandler,
    DEVICETYPE_WEBGL2,
    FILLMODE_FILL_WINDOW,
    LightComponentSystem,
    RESOLUTION_AUTO,
    RenderComponentSystem,
    TextureHandler,
    createGraphicsDevice
} from 'playcanvas';

import { Game } from './game/Game.ts';
import { loadSettings } from './settings/settings.ts';

import './style.css';
import './ui/ui.css';

const canvas = document.getElementById('application-canvas') as HTMLCanvasElement;
const uiRoot = document.getElementById('ui-root') as HTMLElement;

function showFatal(message: string) {
    const box = document.createElement('div');
    box.className = 'fatal panel';
    box.textContent = message;
    uiRoot.append(box);
}

async function start() {
    // GDD 5.2: WebGL 2 is the baseline renderer. WebGPU is a later, opt-in experiment.
    const device = await createGraphicsDevice(canvas, { deviceTypes: [DEVICETYPE_WEBGL2], antialias: true });

    const options = new AppOptions();
    options.graphicsDevice = device;
    options.componentSystems = [RenderComponentSystem, CameraComponentSystem, LightComponentSystem];
    // ContainerHandler is kept so GLB characters/scenery can replace the placeholders later.
    options.resourceHandlers = [TextureHandler, ContainerHandler];

    const app = new AppBase(canvas);
    app.init(options);
    app.setCanvasFillMode(FILLMODE_FILL_WINDOW);
    app.setCanvasResolution(RESOLUTION_AUTO);

    const resize = () => app.resizeCanvas();
    window.addEventListener('resize', resize);
    app.on('destroy', () => window.removeEventListener('resize', resize));

    const game = new Game(app, NEON_TERMINAL, loadSettings(), uiRoot);
    app.start();

    if (import.meta.env.DEV) {
        (window as unknown as { __colorfront: unknown }).__colorfront = { app, game };
    }
}

start().catch((err: unknown) => {
    console.error(err);
    showFatal('WebGL 2를 초기화하지 못했습니다. 최신 Chrome 또는 Edge에서 하드웨어 가속을 켠 뒤 다시 시도하세요.');
});
