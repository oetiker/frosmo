"""Raw RGBA to a single-image y4m clip, for Chromium's fake camera.

  --use-file-for-fake-video-capture=<file>.y4m

Uncompressed YUV420p; the same frame repeated so the stream keeps showing it.
"""
import sys
src, dst, w, h = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
frames = int(sys.argv[5]) if len(sys.argv) > 5 else 60
d = open(src, 'rb').read()
y = bytearray(w * h)
u = bytearray((w // 2) * (h // 2))
v = bytearray((w // 2) * (h // 2))
for j in range(h):
    for i in range(w):
        o = (j * w + i) * 4
        r, g, b = d[o], d[o+1], d[o+2]
        y[j*w+i] = min(255, max(0, int(0.257*r + 0.504*g + 0.098*b) + 16))
        if j % 2 == 0 and i % 2 == 0:
            k = (j//2) * (w//2) + (i//2)
            u[k] = min(255, max(0, int(-0.148*r - 0.291*g + 0.439*b) + 128))
            v[k] = min(255, max(0, int(0.439*r - 0.368*g - 0.071*b) + 128))
with open(dst, 'wb') as f:
    f.write(f"YUV4MPEG2 W{w} H{h} F15:1 Ip A1:1 C420jpeg\n".encode())
    for _ in range(frames):
        f.write(b"FRAME\n")
        f.write(y); f.write(u); f.write(v)
print("wrote", dst)
