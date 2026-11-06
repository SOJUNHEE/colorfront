"""Compose PNG screenshots into one labelled-by-order contact sheet (Blender's Python, no deps).

blender -b --factory-startup --python contact_sheet.py -- OUT.png COLS SCALE IN1.png IN2.png ...
"""
import sys

import bpy
import numpy as np

args = sys.argv[sys.argv.index('--') + 1:]
out, cols, scale, files = args[0], int(args[1]), int(args[2]), args[3:]
imgs = []
for f in files:
    im = bpy.data.images.load(f)
    w, h = im.size
    a = np.array(im.pixels[:], dtype=np.float32).reshape(h, w, 4)
    a = a[::scale, ::scale]
    imgs.append(a)
    bpy.data.images.remove(im)
h, w = imgs[0].shape[:2]
rows = (len(imgs) + cols - 1) // cols
sheet = np.ones((rows * h, cols * w, 4), dtype=np.float32) * 0.1
sheet[..., 3] = 1
for i, a in enumerate(imgs):
    r, c = i // cols, i % cols
    sheet[(rows - 1 - r) * h:(rows - r) * h, c * w:(c + 1) * w] = a[:h, :w]
img = bpy.data.images.new('sheet', cols * w, rows * h, alpha=True)
img.pixels.foreach_set(sheet.ravel())
img.filepath_raw = out
img.file_format = 'PNG'
img.save()
print('sheet', out, cols * w, rows * h)
