"""Raw RGBA to PNG, for looking at a buffer."""
import zlib, struct, sys
w, h = int(sys.argv[3]), int(sys.argv[4])
d = open(sys.argv[1], 'rb').read()
raw = b''.join(b'\x00' + d[y*w*4:(y+1)*w*4] for y in range(h))
def chunk(t, b): 
    c = t + b
    return struct.pack('>I', len(b)) + c + struct.pack('>I', zlib.crc32(c))
open(sys.argv[2], 'wb').write(
    b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
    + chunk(b'IDAT', zlib.compress(raw, 6)) + chunk(b'IEND', b''))
