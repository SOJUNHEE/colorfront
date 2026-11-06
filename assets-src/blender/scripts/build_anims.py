"""
COLORFRONT Phase 6 Gate 4 — keyframed animation clips for the Neon Courier rig.

Run (headless, after build_courier.py has written the master .blend):
    blender -b assets-src/blender/colorfront_courier_master.blend --factory-startup \
        --python assets-src/blender/scripts/build_anims.py -- [--renders]

Writes
    apps/client/public/assets/characters/courier_anims.glb   (skeleton + one glTF animation per clip)
    assets-src/blender/colorfront_courier_anims.blend         (editable Actions, one per clip)
    assets-src/blender/anim_clips.json                        (clip table: duration, loop, layer, stride)
    docs/phase6/gate4/clip_<name>.png                         (frame sheets, --renders)

Conventions
    The rig's bones all point along +Z (Blender) with zero roll, so every glTF joint has an
    identity rest rotation and the bone-local axes equal the runtime axes (X right, Y up, Z back;
    characters face -Z). A pose-bone quaternion here is therefore exactly the runtime local
    rotation. Angles below are runtime Euler degrees:
        spine/chest/neck/head  X < 0 bends forward, Y > 0 turns left, Z > 0 tilts left
        thigh                  swing f > 0 = leg forward; knee k >= 0 bends the shin back;
                               foot angle = pitch of the foot in hips space (0 = flat, > 0 toe up)
    Only hips/spine/chest/neck/head/legs are keyed. Arms, gun and tank stay with the runtime
    (two-bone IK keeps the hands on the weapon); nothing here moves the root, so the server-driven
    position is never overridden (no root motion).
"""

import json
import math
import os
import sys

import bpy
from mathutils import Euler, Quaternion, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
SRC = os.path.join(ROOT, 'assets-src', 'blender')
OUT = os.path.join(ROOT, 'apps', 'client', 'public', 'assets', 'characters', 'courier_anims.glb')
SHEETS = os.path.join(ROOT, 'docs', 'phase6', 'gate4')
ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
FPS = 60

LEG_BONES = ('thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR')
UPPER = ('spine', 'chest', 'neck', 'head')
FULL = ('hips',) + UPPER + LEG_BONES


def q(x=0.0, y=0.0, z=0.0):
    return Euler((math.radians(x), math.radians(y), math.radians(z)), 'XYZ').to_quaternion()


def leg(f=0.0, k=0.0, foot=0.0, ab=0.0, side='L'):
    """Anatomical leg pose -> (thigh, shin, foot) runtime local rotations.
    f: thigh swing (forward +), k: knee bend (>= 0), foot: foot pitch relative to hips (toe up +),
    ab: abduction (outward +)."""
    sgn = -1 if side == 'L' else 1
    return {
        'thigh' + side: q(f, 0, sgn * ab),
        'shin' + side: q(-k, 0, 0),
        'foot' + side: q(foot - f + k, 0, 0),
    }


THIGH_LEN = 0.68 - 0.37
SHIN_LEN = 0.37 - 0.085
LEG_LEN = THIGH_LEN + SHIN_LEN


def leg_extent(f=0.0, k=0.0, foot=0.0, ab=0.0, hips_pitch=0.0):
    """Vertical hip -> ankle distance of a leg pose (metres)."""
    a = math.radians(f + hips_pitch)
    b = math.radians(f + hips_pitch - k)
    return (THIGH_LEN * math.cos(a) + SHIN_LEN * math.cos(b)) * math.cos(math.radians(ab))


def pose(hips=(0, 0, 0), hips_pos=(0, 0, 0), spine=(0, 0, 0), chest=(0, 0, 0), neck=(0, 0, 0), head=(0, 0, 0),
         L=None, R=None, ground=1.0):
    """`ground` > 0 lowers the hips so the more extended leg reaches the floor (feet planted, no
    floating crouch); `hips_pos` is added on top (e.g. a hop). ground=0 for airborne poses."""
    if ground:
        ext = max(leg_extent(*(L or (0, 0, 0)), hips_pitch=hips[0]), leg_extent(*(R or (0, 0, 0)), hips_pitch=hips[0]))
        hips_pos = (hips_pos[0], hips_pos[1] - (LEG_LEN - ext) * ground, hips_pos[2])
    p = {'hips': q(*hips), 'hips@pos': Vector(hips_pos), 'spine': q(*spine), 'chest': q(*chest),
         'neck': q(*neck), 'head': q(*head)}
    p.update(leg(*(L or (0, 0, 0)), side='L'))
    p.update(leg(*(R or (0, 0, 0)), side='R'))
    return p


def upper(spine=(0, 0, 0), chest=(0, 0, 0), neck=(0, 0, 0), head=(0, 0, 0)):
    return {'spine': q(*spine), 'chest': q(*chest), 'neck': q(*neck), 'head': q(*head)}


# ── gait tables ──────────────────────────────────────────────────────────────────────────────────
# One cycle = left contact -> right contact -> left contact. Left leg keys (phase, f, k, foot);
# the right leg is the same table shifted by half a cycle.
JOG_LEG = [
    (0.000, 34, 12, 14),    # contact: heel first
    (0.125, 18, 34, 0),     # loading: knee absorbs
    (0.250, -2, 20, 0),     # mid-stance
    (0.375, -30, 14, -22),  # push-off
    (0.500, -38, 62, -28),  # toe-off
    (0.625, -8, 104, -10),  # swing: heel to seat
    (0.750, 26, 92, 4),     # swing through
    (0.875, 44, 38, 12),    # reach
]
RUN_LEG = [
    (0.000, 42, 14, 16),
    (0.125, 22, 40, 0),
    (0.250, 0, 26, 0),
    (0.375, -38, 16, -26),
    (0.500, -48, 74, -34),
    (0.625, -14, 124, -12),
    (0.750, 34, 110, 4),
    (0.875, 54, 44, 14),
]


def sample_table(table, ph):
    ph %= 1.0
    ext = table + [(1.0,) + table[0][1:]]
    for (p0, *a), (p1, *b) in zip(ext, ext[1:]):
        if p0 <= ph <= p1:
            t = (ph - p0) / (p1 - p0)
            return [x + (y - x) * t for x, y in zip(a, b)]
    return list(table[0][1:])


def gait(table, lean, bounce, yaw, roll, phases=8, reverse=False, lean_head=0.0):
    keys = []
    for i in range(phases + 1):
        ph = i / phases
        src = 1 - ph if reverse else ph
        lf, lk, lfoot = sample_table(table, src)
        rf, rk, rfoot = sample_table(table, src + 0.5)
        # Pelvis: lowest while loading (0.125 / 0.625), highest at push-off.
        # Pelvis height follows the stance leg (ground=0.75: a little float, arcade feel) plus a
        # small push-off lift.
        y = bounce * max(0.0, math.sin(4 * math.pi * (src - 0.25)))
        pelvis_yaw = -yaw * math.cos(2 * math.pi * src)          # left hip forward at left contact
        pelvis_roll = roll * math.sin(2 * math.pi * (src - 0.1))
        keys.append((ph, pose(
            hips=(0, pelvis_yaw, pelvis_roll), hips_pos=(0, y, 0),
            spine=(lean * 0.6, -pelvis_yaw * 0.6, -pelvis_roll * 0.5),
            chest=(lean * 0.4, -pelvis_yaw * 0.5, 0),
            head=(-lean * 0.8 + lean_head, 0, 0),
            L=(lf, lk, lfoot), R=(rf, rk, rfoot), ground=0.75)))
    return keys


def strafe(direction):
    """Side-step gallop toward +X (right, direction=1) or -X (left, -1). Pelvis turns a little
    toward the movement, chest turns back to keep facing the aim."""
    lead, trail = ('R', 'L') if direction > 0 else ('L', 'R')
    table = [
        # phase, lead (ab, k, f), trail (ab, k, f)
        (0.00, (24, 10, 4), (6, 22, -4)),
        (0.25, (10, 30, 0), (2, 58, 6)),
        (0.50, (-4, 18, -2), (16, 40, 4)),
        (0.75, (8, 62, 6), (6, 16, -2)),
    ]
    keys = []
    for i, (ph, (lab, lk, lf), (tab, tk, tf)) in enumerate(table + [(1.0,) + table[0][1:]]):
        y = 0.0
        legs = {lead: (lf, lk, 0, lab), trail: (tf, tk, 0, tab)}
        keys.append((ph, pose(hips=(0, -12 * direction, 3 * direction * (1 if ph in (0.0, 0.5, 1.0) else -1)),
                              hips_pos=(0, y, 0),
                              spine=(-6, 7 * direction, 0), chest=(-3, 6 * direction, 0), head=(3, 0, 0),
                              L=legs['L'], R=legs['R'])))
    return keys


STAND = dict(L=(2, 6, 0), R=(-2, 6, 0))

CLIPS = {}


def clip(name, duration, loop, layer, keys, bones=FULL, stride=None):
    CLIPS[name] = dict(duration=duration, loop=loop, layer=layer, keys=keys, bones=bones, stride=stride)


def build_clips():
    # Locomotion (full body). `stride` = metres travelled per cycle at the clip's design speed;
    # the runtime advances the phase by distance / stride so the feet track the ground speed.
    clip('idle', 2.4, True, 'base', [
        (0.0, pose(hips=(0, 0, 1.2), spine=(-2, 0, -0.6), chest=(-1, 0, 0), head=(1, 2, 0),
                   L=(2, 7, 0, 1), R=(-2, 5, 0, 1))),
        (0.25, pose(hips=(0, 1, 0), spine=(-2.5, 0, 0), chest=(0.8, 0, 0), head=(0, 5, 0),
                    L=(2, 9, 0, 1), R=(-2, 8, 0, 1))),
        (0.5, pose(hips=(0, 0, -1.2), spine=(-2, 0, 0.6), chest=(-1.2, 0, 0), head=(1, -1, 0),
                   L=(2, 5, 0, 1), R=(-2, 7, 0, 1))),
        (0.75, pose(hips=(0, -1, 0), spine=(-2.5, 0, 0), chest=(1, 0, 0), head=(-1, -4, 0),
                    L=(2, 8, 0, 1), R=(-2, 9, 0, 1))),
        (1.0, None),
    ])
    clip('jog', 0.5, True, 'base', gait(JOG_LEG, lean=-9, bounce=0.02, yaw=9, roll=3), stride=3.0)
    clip('run', 0.44, True, 'base', gait(RUN_LEG, lean=-15, bounce=0.035, yaw=11, roll=4, lean_head=4), stride=3.52)
    clip('jog_back', 0.5, True, 'base', gait([(p, f * 0.75, k * 0.85, ft * 0.6) for p, f, k, ft in JOG_LEG],
                                             lean=3, bounce=0.015, yaw=6, roll=2, reverse=True), stride=3.0)
    clip('strafe_R', 0.5, True, 'base', strafe(1), stride=3.0)
    clip('strafe_L', 0.5, True, 'base', strafe(-1), stride=3.0)
    clip('dash', 0.2, True, 'base', [
        (0.0, pose(hips=(-6, 0, 0), spine=(-24, 0, 0), chest=(-10, 0, 0), head=(22, 0, 0),
                   L=(52, 70, 10), R=(-46, 32, -30))),
        (0.5, pose(hips=(-6, 0, 0), spine=(-26, 0, 0), chest=(-11, 0, 0), head=(24, 0, 0),
                   L=(56, 76, 12), R=(-48, 36, -32))),
        (1.0, None),
    ])
    # Air.
    clip('jump_start', 0.16, False, 'base', [
        (0.0, pose(spine=(-12, 0, 0), chest=(-4, 0, 0), head=(10, 0, 0),
                   L=(28, 50, 0), R=(24, 46, 0))),
        (0.55, pose(hips_pos=(0, 0.03, 0), spine=(2, 0, 0), chest=(3, 0, 0), head=(-2, 0, 0),
                    L=(-4, 4, -28), R=(-8, 6, -30), ground=0)),
        (1.0, pose(hips_pos=(0, 0.03, 0), spine=(-2, 0, 0), head=(0, 0, 0), L=(20, 40, -10), R=(4, 20, -20), ground=0)),
    ])
    clip('jump_air', 0.9, True, 'base', [
        (0.0, pose(spine=(-4, 0, 0), chest=(-2, 0, 0), head=(3, 0, 0), L=(38, 72, -6), R=(8, 34, -18), ground=0)),
        (0.5, pose(spine=(-6, 0, 0), chest=(-1, 0, 0), head=(4, 0, 0), L=(44, 82, -4), R=(12, 42, -14), ground=0)),
        (1.0, None),
    ])
    clip('land', 0.42, False, 'base', [
        (0.0, pose(spine=(-10, 0, 0), chest=(-4, 0, 0), head=(6, 0, 0),
                   L=(30, 50, 0), R=(26, 46, 0))),
        (0.22, pose(hips=(-4, 0, 0), spine=(-20, 0, 0), chest=(-8, 0, 0), head=(16, 0, 0),
                    L=(52, 92, 0), R=(48, 88, 0))),
        (0.6, pose(hips_pos=(0, 0.015, 0), spine=(3, 0, 0), chest=(2, 0, 0), head=(-3, 0, 0),
                   L=(4, 8, 0), R=(0, 6, 0))),
        (1.0, pose(hips=(0, 0, 0), **STAND)),
    ])
    # Upper-body layer (added on top of the base layer; rest = identity, so these are deltas).
    clip('aim', 0.5, True, 'upper', [
        (0.0, upper(spine=(0, -5, 0), chest=(-2, -9, 0), head=(0, 12, 0))),
        (1.0, None),
    ], bones=UPPER)
    clip('fire', 0.16, False, 'upper', [
        (0.0, upper()),
        (0.18, upper(spine=(2.5, 0, 0), chest=(6, -1.5, 0), head=(2, 0, 0))),
        (1.0, upper()),
    ], bones=UPPER)
    clip('reload', 1.0, False, 'upper', [
        (0.0, upper()),
        (0.2, upper(spine=(-4, 10, 0), chest=(-6, 16, 2), head=(-14, 24, 4))),
        (0.55, upper(spine=(-5, 12, 0), chest=(-7, 18, 3), head=(-18, 26, 6))),
        (0.8, upper(spine=(1, -3, 0), chest=(2, -5, 0), head=(2, -4, 0))),
        (1.0, upper()),
    ], bones=UPPER)
    clip('hit', 0.36, False, 'upper', [
        (0.0, upper()),
        (0.16, upper(spine=(10, 7, -3), chest=(13, 10, -4), head=(16, -6, 8))),
        (0.55, upper(spine=(-3, -2, 1), chest=(-3, -3, 1), head=(-4, 2, -2))),
        (1.0, upper()),
    ], bones=UPPER)
    # Full-body one-shots.
    clip('respawn', 0.7, False, 'base', [
        (0.0, pose(hips=(-8, 0, 0), spine=(-30, 0, 0), chest=(-12, 0, 0), head=(22, 0, 0),
                   L=(78, 118, 0), R=(74, 114, 0))),
        (0.45, pose(spine=(-10, 0, 0), chest=(-4, 0, 0), head=(8, 0, 0),
                    L=(40, 64, 0), R=(36, 60, 0))),
        (0.7, pose(hips_pos=(0, 0.03, 0), spine=(6, 0, 0), chest=(5, 0, 0), head=(-6, 0, 0),
                   L=(-2, 2, -6), R=(-4, 2, -8))),
        (1.0, pose(**STAND)),
    ])
    clip('victory', 0.9, True, 'base', [
        (0.0, pose(spine=(-8, 0, 0), chest=(-2, 0, 0), head=(6, 0, 0),
                   L=(30, 52, 0), R=(26, 48, 0))),
        (0.28, pose(hips_pos=(0, 0.17, 0), spine=(8, 6, 0), chest=(10, 8, 0), head=(-12, -6, 0),
                    L=(34, 86, -10), R=(10, 60, -20), ground=0)),
        (0.55, pose(hips_pos=(0, 0.06, 0), spine=(4, 0, 0), chest=(5, 0, 0), head=(-6, 0, 0),
                    L=(14, 30, -12), R=(4, 22, -14), ground=0)),
        (0.72, pose(spine=(-9, -4, 0), chest=(-3, -6, 0), head=(8, 6, 0),
                    L=(32, 56, 0), R=(28, 50, 0))),
        (1.0, None),
    ])


# ── Blender actions ──────────────────────────────────────────────────────────────────────────────
def key_clip(arm, name, c):
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    arm.animation_data_create()
    arm.animation_data.action = act
    frames = round(c['duration'] * FPS)
    keys = c['keys']
    first = keys[0][1]
    for pb in arm.pose.bones:
        pb.rotation_mode = 'QUATERNION'
        pb.rotation_quaternion = Quaternion()
        pb.location = Vector()
    prev = {}
    for t, p in keys:
        p = first if p is None else p
        frame = 1 + round(t * frames)
        for bone in c['bones']:
            pb = arm.pose.bones[bone]
            rot = p.get(bone, Quaternion())
            if bone in prev and prev[bone].dot(rot) < 0:
                rot = rot.copy()
                rot.negate()  # keep the shortest arc between keys
            prev[bone] = rot
            pb.rotation_quaternion = rot
            pb.keyframe_insert('rotation_quaternion', frame=frame, group=bone)
            if bone == 'hips':
                pb.location = p.get('hips@pos', Vector())
                pb.keyframe_insert('location', frame=frame, group=bone)
    # Smooth (Bezier) in-betweens; loops get cyclic handles so the seam has no kink.
    for fc in _fcurves(act):
        for kp in fc.keyframe_points:
            kp.interpolation = 'BEZIER'
            kp.handle_left_type = kp.handle_right_type = 'AUTO_CLAMPED'
        if c['loop']:
            fc.modifiers.new('CYCLES')
        fc.update()
    act.frame_range = (1, 1 + frames)
    act.use_frame_range = True
    track = arm.animation_data.nla_tracks.new()
    track.name = name
    track.strips.new(name, 1, act)
    track.mute = True
    arm.animation_data.action = None
    return act


def _fcurves(act):
    if hasattr(act, 'fcurves') and len(getattr(act, 'fcurves', [])):
        return list(act.fcurves)
    out = []
    for layer in getattr(act, 'layers', []):
        for strip in layer.strips:
            for bag in strip.channelbags:
                out.extend(bag.fcurves)
    return out


def export(arm):
    bpy.ops.object.select_all(action='DESELECT')
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    props = bpy.ops.export_scene.gltf.get_rna_type().properties.keys()
    kw = dict(filepath=OUT, export_format='GLB', use_selection=True, export_yup=True, export_apply=False,
              export_skins=True, export_animations=True, export_materials='NONE')
    opt = dict(export_animation_mode='ACTIONS', export_force_sampling=True, export_optimize_animation_size=True,
               export_anim_single_armature=True, export_reset_pose_bones=True, export_bake_animation=False,
               export_anim_slide_to_zero=True, export_def_bones=False, export_frame_range=False,
               export_extras=False, export_cameras=False, export_lights=False, export_morph=False,
               export_optimize_animation_keep_anim_armature=True)
    kw.update({k: v for k, v in opt.items() if k in props})
    bpy.ops.export_scene.gltf(**kw)


# ── frame sheets ─────────────────────────────────────────────────────────────────────────────────
def render_sheets(arm):
    import numpy as np
    os.makedirs(SHEETS, exist_ok=True)
    sc = bpy.context.scene
    engines = bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items.keys()
    sc.render.engine = 'BLENDER_WORKBENCH' if 'BLENDER_WORKBENCH' in engines else engines[0]
    sc.display.shading.light = 'STUDIO'
    sc.display.shading.color_type = 'SINGLE'
    sc.display.shading.single_color = (0.75, 0.78, 0.85)
    sc.display.shading.show_cavity = True
    sc.display.shading.show_object_outline = True
    sc.render.resolution_x, sc.render.resolution_y = 260, 380
    sc.render.film_transparent = False
    if sc.world is None:
        sc.world = bpy.data.worlds.new('sheet_world')
    sc.world.color = (0.18, 0.2, 0.24)
    for o in sc.objects:
        if o.type == 'MESH':
            keep = o.name == 'courier_default_lod0'
            o.hide_render = not keep
            if keep:
                o.hide_set(False)
                o.hide_viewport = False
    # Ground line for judging foot contact.
    bpy.ops.mesh.primitive_plane_add(size=3, location=(0, 0, 0))
    bpy.context.active_object.name = 'sheet_ground'
    cam_data = bpy.data.cameras.new('sheet_cam')
    cam_data.type = 'ORTHO'
    cam_data.ortho_scale = 2.1
    cam = bpy.data.objects.new('sheet_cam', cam_data)
    sc.collection.objects.link(cam)
    sc.camera = cam
    # Near-side view from the character's right, slightly in front (characters face +Y in Blender).
    cam.location = Vector((3.35, 0.59, 0.85))
    cam.rotation_euler = Euler((math.radians(90), 0, math.radians(100)), 'XYZ')
    tmp = os.path.join(SHEETS, '_frame.png')
    arm.animation_data_create()
    for name, c in CLIPS.items():
        act = bpy.data.actions[name]
        arm.animation_data.action = act
        frames = round(c['duration'] * FPS)
        n = 6
        tiles = []
        for i in range(n):
            sc.frame_set(1 + round(i / (n - (0 if c['loop'] else 1)) * frames))
            sc.render.filepath = tmp
            bpy.ops.render.render(write_still=True)
            img = bpy.data.images.load(tmp)
            px = np.array(img.pixels[:], dtype=np.float32).reshape(img.size[1], img.size[0], 4)
            tiles.append(px)
            bpy.data.images.remove(img)
        sheet = np.concatenate(tiles, axis=1)
        out = bpy.data.images.new(f'clip_{name}', sheet.shape[1], sheet.shape[0], alpha=True)
        out.pixels = sheet.ravel()
        out.filepath_raw = os.path.join(SHEETS, f'clip_{name}.png')
        out.file_format = 'PNG'
        out.save()
    arm.animation_data.action = None
    if os.path.exists(tmp):
        os.remove(tmp)


def main():
    arm = bpy.data.objects['courier_rig']
    for a in list(bpy.data.actions):
        bpy.data.actions.remove(a)
    if arm.animation_data:
        for t in list(arm.animation_data.nla_tracks):
            arm.animation_data.nla_tracks.remove(t)
    bpy.context.scene.render.fps = FPS
    build_clips()
    for name, c in CLIPS.items():
        key_clip(arm, name, c)
    export(arm)
    table = {n: {'duration': c['duration'], 'loop': c['loop'], 'layer': c['layer'], 'stride': c['stride'],
                 'bones': list(c['bones'])} for n, c in CLIPS.items()}
    with open(os.path.join(SRC, 'anim_clips.json'), 'w', encoding='utf-8') as f:
        json.dump(table, f, indent=2)
        f.write('\n')
    # Editable source: the master rig + actions (meshes kept so the clips can be previewed).
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(SRC, 'colorfront_courier_anims.blend'), copy=True)
    if '--renders' in ARGS:
        render_sheets(arm)
    print('CF_ANIMS', {n: (c['duration'], len(c['keys'])) for n, c in CLIPS.items()})


main()
