import { CameraFrame, Color, GAMMA_SRGB, SSAOTYPE_LIGHTING, SSAOTYPE_NONE, TONEMAP_NEUTRAL } from 'playcanvas';
import type { AppBase, CameraComponent } from 'playcanvas';

import type { QualityProfile } from '../settings/settings.ts';

/**
 * HDR post-processing through the engine's CameraFrame. Low quality bypasses it entirely
 * (direct render with tone mapping on the camera), so weak GPUs pay nothing.
 */
export class PostEffects {
    private frame: CameraFrame | null = null;
    private readonly app: AppBase;
    private readonly camera: CameraComponent;

    constructor(app: AppBase, camera: CameraComponent) {
        this.app = app;
        this.camera = camera;
    }

    apply(profile: QualityProfile) {
        const post = profile.post;
        if (post === 'none') {
            this.frame?.destroy();
            this.frame = null;
            this.camera.toneMapping = TONEMAP_NEUTRAL;
            this.camera.gammaCorrection = GAMMA_SRGB;
            return;
        }
        if (!this.frame) this.frame = new CameraFrame(this.app, this.camera);
        const f = this.frame;
        f.rendering.toneMapping = TONEMAP_NEUTRAL;
        f.rendering.samples = post === 'full' ? 4 : 2;
        f.rendering.sharpness = post === 'full' ? 0.25 : 0.15;
        // Bloom only above ~1.0 scene luminance: neon, muzzle flashes and paint highlights glow,
        // the lit environment and characters do not (keeps enemies readable).
        f.bloom.intensity = post === 'full' ? 0.03 : 0.02;
        f.bloom.threshold = 0.9;
        f.bloom.blurLevel = post === 'full' ? 14 : 10;
        f.grading.enabled = true;
        f.grading.brightness = 1.02;
        f.grading.contrast = 1.07;
        f.grading.saturation = 1.06;
        f.grading.tint = new Color(1, 0.99, 0.97);
        f.vignette.intensity = 0.28;
        f.vignette.inner = 0.55;
        f.vignette.outer = 1.25;
        f.vignette.curvature = 0.6;
        f.ssao.type = post === 'full' ? SSAOTYPE_LIGHTING : SSAOTYPE_NONE;
        f.ssao.intensity = 0.55;
        f.ssao.radius = 25;
        f.ssao.samples = 12;
        f.ssao.blurEnabled = true;
        f.update();
    }
}
