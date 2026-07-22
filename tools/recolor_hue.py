#!/usr/bin/env python3
"""1枚目の構図はそのままに、ピンク／紫の照明だけを金・琥珀色へ回す。

生成し直すと構図が毎回変わるので、色相だけを選んで動かす。
青い夜空と自販機の白は触らない（濃紺は残す指示のため）。
"""
import sys
import numpy as np
from PIL import Image

src, dst = sys.argv[1], sys.argv[2]
# 目標の色相（度）。35=琥珀、45寄りにすると金色に近づく
TARGET = float(sys.argv[3]) if len(sys.argv) > 3 else 38.0
# 彩度をどれだけ残すか。1.0で元のまま
SAT = float(sys.argv[4]) if len(sys.argv) > 4 else 0.72

img = Image.open(src).convert('RGB')
a = np.asarray(img).astype(np.float32) / 255.0
r, g, b = a[..., 0], a[..., 1], a[..., 2]

mx, mn = a.max(-1), a.min(-1)
d = mx - mn
v = mx
s = np.where(mx > 0, d / np.maximum(mx, 1e-6), 0)

h = np.zeros_like(mx)
m = (d > 1e-6)
idx = m & (mx == r)
h[idx] = (60 * ((g - b)[idx] / d[idx])) % 360
idx = m & (mx == g)
h[idx] = 60 * ((b - r)[idx] / d[idx]) + 120
idx = m & (mx == b)
h[idx] = 60 * ((r - g)[idx] / d[idx]) + 240

# ピンク〜マゼンタ〜紫の帯を丸ごと拾う。
# 青(240付近)は夜空と自販機なので残したい。よって下側だけ急に切る
hh = (h - 250) % 360          # 250度を起点に測り直す
w = np.zeros_like(hh)
w[(hh >= 15) & (hh <= 110)] = 1.0                       # 265〜360度＝紫〜マゼンタ〜ピンク
band = (hh >= 0) & (hh < 15)
w[band] = hh[band] / 15.0                               # 250〜265度で青からの立ち上がり
band = (hh > 110) & (hh <= 135)
w[band] = 1.0 - (hh[band] - 110) / 25.0                 # 0〜25度（赤）へ抜ける側
w *= np.clip(s / 0.18, 0, 1)                            # 無彩色は動かさない

dh = ((TARGET - h + 180) % 360) - 180
h2 = (h + dh * w) % 360
s2 = s * (1 - w) + s * SAT * w

# HSV -> RGB
c = v * s2
hp = h2 / 60.0
x = c * (1 - np.abs(hp % 2 - 1))
z = np.zeros_like(c)
cond = [(hp < 1), (hp < 2), (hp < 3), (hp < 4), (hp < 5), (hp <= 6)]
rr = np.select(cond, [c, x, z, z, x, c])
gg = np.select(cond, [x, c, c, x, z, z])
bb = np.select(cond, [z, z, x, c, c, x])
mm = v - c
out = np.stack([rr + mm, gg + mm, bb + mm], -1)

Image.fromarray((np.clip(out, 0, 1) * 255).astype(np.uint8)).save(dst)
print('wrote', dst)
