"""Decode a PNG to raw RGBA. Only what the card screenshot produces: 8-bit RGB or RGBA."""
import zlib, struct, sys
f = open(sys.argv[1], 'rb').read()
pos, idat, w, h, ct = 8, b'', 0, 0, 2
while pos < len(f):
    ln = struct.unpack('>I', f[pos:pos+4])[0]
    typ, data = f[pos+4:pos+8], f[pos+8:pos+8+ln]
    if typ == b'IHDR': w, h, _bd, ct = struct.unpack('>IIBB', data[:10])
    if typ == b'IDAT': idat += data
    pos += 12 + ln
bpp = 4 if ct == 6 else 3
raw = zlib.decompress(idat)
out = bytearray(w*h*4)
prev = bytearray(w*bpp); i = 0
for y in range(h):
    ft = raw[i]; i += 1
    line = bytearray(raw[i:i+w*bpp]); i += w*bpp
    for x in range(w*bpp):
        a = line[x-bpp] if x >= bpp else 0
        b = prev[x]
        c = prev[x-bpp] if x >= bpp else 0
        if ft == 1: line[x] = (line[x]+a) & 255
        elif ft == 2: line[x] = (line[x]+b) & 255
        elif ft == 3: line[x] = (line[x]+(a+b)//2) & 255
        elif ft == 4:
            p = a+b-c; pa, pb, pc = abs(p-a), abs(p-b), abs(p-c)
            line[x] = (line[x] + (a if (pa <= pb and pa <= pc) else (b if pb <= pc else c))) & 255
    for x in range(w):
        o = (y*w+x)*4
        out[o] = line[x*bpp]; out[o+1] = line[x*bpp+1]; out[o+2] = line[x*bpp+2]
        out[o+3] = line[x*bpp+3] if bpp == 4 else 255
    prev = line
open(sys.argv[2], 'wb').write(out)
print(w, h)
