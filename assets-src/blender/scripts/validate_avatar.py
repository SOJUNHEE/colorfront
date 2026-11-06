"""
COLORFRONT avatar GLB validator (no dependencies; plain Python 3).

Checks every exported avatar/wardrobe GLB against the Phase 6 contract
(docs/COLORFRONT_Phase6_Review_Pack/02_ART_WARDROBE_SPEC.md):
  - 22 joints with the CharacterRig.ts names and parent hierarchy
  - identity rest rotations and unit scale on every joint (same convention as CharacterRig)
  - Y-up, soles at y = 0, height close to 1.65 m (full avatars)
  - <= 4 influences per vertex, weights normalised, only valid joint indices
  - triangle budget per LOD, material / primitive (draw call) count
  - `muzzle` node under the `gun` joint (rifle + full avatars)

Usage:  python assets-src/blender/scripts/validate_avatar.py [--json out.json]
Exit code 1 when any check fails.
"""

import json
import math
import os
import struct
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
ASSETS = os.path.join(ROOT, 'apps', 'client', 'public', 'assets')

BONES = {
    'root': None, 'hips': 'root', 'spine': 'hips', 'chest': 'spine', 'neck': 'chest', 'head': 'neck',
    'shoulderL': 'chest', 'upperArmL': 'shoulderL', 'foreArmL': 'upperArmL', 'handL': 'foreArmL',
    'shoulderR': 'chest', 'upperArmR': 'shoulderR', 'foreArmR': 'upperArmR', 'handR': 'foreArmR',
    'thighL': 'hips', 'shinL': 'thighL', 'footL': 'shinL', 'thighR': 'hips', 'shinR': 'thighR', 'footR': 'shinR',
    'gun': 'chest', 'liquid': 'chest',
}

FILES = {
    'characters/courier_default_lod0.glb': {'tris': (5000, 8000), 'full': True, 'muzzle': True},
    'characters/courier_default_lod1.glb': {'tris': (1800, 3000), 'full': True, 'muzzle': True},
    'characters/courier_default_lod2.glb': {'tris': (500, 1200), 'full': True, 'muzzle': True},
    'characters/courier_base_lod0.glb': {'tris': (0, 8000)},
    'clothes/top_bomber.glb': {'tris': (0, 3000)},
    'clothes/bottom_cargo.glb': {'tris': (0, 2000)},
    'clothes/shoes_runner.glb': {'tris': (0, 1500)},
    'clothes/hair_sidepart.glb': {'tris': (0, 2500)},
    'clothes/back_tank_standard.glb': {'tris': (0, 1500)},
    'weapons/paint_rifle.glb': {'tris': (0, 1000), 'muzzle': True},
}

COMP = {5120: ('b', 1), 5121: ('B', 1), 5122: ('h', 2), 5123: ('H', 2), 5125: ('I', 4), 5126: ('f', 4)}
NCOMP = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def read_glb(path):
    with open(path, 'rb') as f:
        data = f.read()
    magic, version, length = struct.unpack_from('<III', data, 0)
    assert magic == 0x46546C67, 'not a GLB'
    off = 12
    gltf, binc = None, b''
    while off < length:
        clen, ctype = struct.unpack_from('<II', data, off)
        chunk = data[off + 8:off + 8 + clen]
        if ctype == 0x4E4F534A:
            gltf = json.loads(chunk.decode('utf-8'))
        elif ctype == 0x004E4942:
            binc = chunk
        off += 8 + clen
    return gltf, binc


def accessor(gltf, binc, i):
    a = gltf['accessors'][i]
    bv = gltf['bufferViews'][a['bufferView']]
    fmt, size = COMP[a['componentType']]
    n = NCOMP[a['type']]
    stride = bv.get('byteStride', size * n)
    base = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    out = []
    for k in range(a['count']):
        vals = struct.unpack_from('<' + fmt * n, binc, base + k * stride)
        if a.get('normalized'):
            mx = {'B': 255, 'H': 65535, 'b': 127, 'h': 32767}[fmt]
            vals = tuple(v / mx for v in vals)
        out.append(vals)
    return out


def check(rel, spec):
    path = os.path.join(ASSETS, rel)
    res = {'file': rel, 'ok': True, 'errors': [], 'info': {}}

    def fail(msg):
        res['ok'] = False
        res['errors'].append(msg)
    if not os.path.exists(path):
        fail('missing file')
        return res
    gltf, binc = read_glb(path)
    nodes = gltf.get('nodes', [])
    parent = {}
    for i, n in enumerate(nodes):
        for c in n.get('children', []):
            parent[c] = i
    skins = gltf.get('skins', [])
    if len(skins) != 1:
        fail(f'expected 1 skin, got {len(skins)}')
        return res
    joints = skins[0]['joints']
    names = [nodes[j].get('name') for j in joints]
    res['info']['joints'] = len(joints)
    if sorted(names) != sorted(BONES):
        fail(f'joint names differ: missing={sorted(set(BONES) - set(names))} extra={sorted(set(names) - set(BONES))}')
    by_name = {nodes[j].get('name'): j for j in joints}
    for name, par in BONES.items():
        j = by_name.get(name)
        if j is None:
            continue
        pj = parent.get(j)
        pname = nodes[pj].get('name') if pj is not None else None
        if par is not None and pname != par:
            fail(f'{name}: parent {pname} != {par}')
        n = nodes[j]
        r = n.get('rotation', [0, 0, 0, 1])
        if max(abs(r[0]), abs(r[1]), abs(r[2]), abs(abs(r[3]) - 1)) > 1e-4:
            fail(f'{name}: rest rotation not identity {r}')
        s = n.get('scale', [1, 1, 1])
        if max(abs(v - 1) for v in s) > 1e-4:
            fail(f'{name}: rest scale not 1 {s}')
    # Inverse bind matrices must be pure translations equal to -(joint world position).
    ibm = accessor(gltf, binc, skins[0]['inverseBindMatrices'])
    world = {}

    def wpos(j):
        if j in world:
            return world[j]
        t = nodes[j].get('translation', [0, 0, 0])
        p = parent.get(j)
        base = wpos(p) if p is not None else (0, 0, 0)
        world[j] = tuple(base[k] + t[k] for k in range(3))
        return world[j]
    worst = 0.0
    for k, j in enumerate(joints):
        m = ibm[k]
        w = wpos(j)
        worst = max(worst, abs(m[12] + w[0]), abs(m[13] + w[1]), abs(m[14] + w[2]),
                    abs(m[0] - 1), abs(m[5] - 1), abs(m[10] - 1), abs(m[1]), abs(m[4]))
    res['info']['ibm_max_error'] = round(worst, 6)
    if worst > 1e-3:
        fail(f'inverse bind matrices disagree with the rest pose (max err {worst:.4f})')
    # Meshes.
    tris = 0
    prims = 0
    mats = set()
    ymin, ymax = math.inf, -math.inf
    bad_w = 0
    over4 = 0
    verts = 0
    for mesh in gltf.get('meshes', []):
        for prim in mesh['primitives']:
            prims += 1
            mats.add(prim.get('material'))
            at = prim['attributes']
            idx = gltf['accessors'][prim['indices']]['count'] if 'indices' in prim else gltf['accessors'][at['POSITION']]['count']
            tris += idx // 3
            pa = gltf['accessors'][at['POSITION']]
            ymin, ymax = min(ymin, pa['min'][1]), max(ymax, pa['max'][1])
            if 'JOINTS_0' not in at or 'WEIGHTS_0' not in at:
                fail('primitive without skin weights')
                continue
            if 'JOINTS_1' in at:
                over4 += 1
            J = accessor(gltf, binc, at['JOINTS_0'])
            W = accessor(gltf, binc, at['WEIGHTS_0'])
            verts += len(W)
            for jv, wv in zip(J, W):
                if abs(sum(wv) - 1) > 2e-3:
                    bad_w += 1
                if any(w > 0 and ji >= len(joints) for ji, w in zip(jv, wv)):
                    fail('joint index out of range')
                    break
    res['info'].update({'triangles': tris, 'primitives_drawcalls': prims, 'materials': len(mats), 'vertices': verts,
                        'min_y': round(ymin, 4), 'max_y': round(ymax, 4),
                        'images': len(gltf.get('images', [])), 'bytes': os.path.getsize(path)})
    if over4:
        fail('more than 4 influences per vertex (JOINTS_1 present)')
    if bad_w:
        fail(f'{bad_w} vertices with weights not summing to 1')
    lo, hi = spec['tris']
    if not (lo <= tris <= hi):
        fail(f'triangles {tris} outside budget {lo}-{hi}')
    if spec.get('full'):
        if abs(ymin) > 0.012:
            fail(f'soles not at y=0 (min y {ymin:.3f})')
        if not (1.6 <= ymax <= 1.78):
            fail(f'height {ymax:.3f} m outside 1.60-1.78 (1.65 body + hair)')
        if prims > 3:
            fail(f'{prims} primitives (draw calls) > 3')
        blend = [m.get('name') for m in gltf.get('materials', []) if m.get('alphaMode') == 'BLEND']
        res['info']['blend_materials'] = blend
        if len(mats) != 2 or len(blend) != 1:
            fail(f'expected opaque body + 1 transparent tank glass material, got {len(mats)} used, blend={blend}')
    if spec.get('muzzle'):
        m = [i for i, n in enumerate(nodes) if n.get('name') == 'muzzle']
        if not m:
            fail('no muzzle node')
        elif nodes[parent.get(m[0], -1)].get('name') != 'gun' if parent.get(m[0]) is not None else True:
            fail('muzzle is not a child of the gun joint')
        else:
            t = nodes[m[0]].get('translation', [0, 0, 0])
            res['info']['muzzle_local'] = [round(v, 4) for v in t]
            if math.dist(t, (0, 0.03, -0.64)) > 0.01:
                fail(f'muzzle local offset {t} != legacy (0, 0.03, -0.64)')
    return res


def main():
    results = [check(rel, spec) for rel, spec in FILES.items()]
    for r in results:
        status = 'PASS' if r['ok'] else 'FAIL'
        print(f"{status}  {r['file']}  {json.dumps(r['info'])}")
        for e in r['errors']:
            print(f'      - {e}')
    if '--json' in sys.argv:
        out = sys.argv[sys.argv.index('--json') + 1]
        with open(out, 'w', encoding='utf-8') as f:
            json.dump(results, f, indent=2)
    sys.exit(0 if all(r['ok'] for r in results) else 1)


if __name__ == '__main__':
    main()
