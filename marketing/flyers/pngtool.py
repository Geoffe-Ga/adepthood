"""Dependency-free PNG read/crop/write, for proofing flyer renders."""
import zlib, struct, pathlib

def read(p):
    d = pathlib.Path(p).read_bytes(); assert d[:8] == b'\x89PNG\r\n\x1a\n'
    i, idat, w, h, ct = 8, b'', None, None, None
    while i < len(d):
        ln = struct.unpack('>I', d[i:i+4])[0]; typ = d[i+4:i+8]; data = d[i+8:i+8+ln]
        if typ == b'IHDR': w, h, _bd, ct = struct.unpack('>IIBB', data[:10])
        elif typ == b'IDAT': idat += data
        i += 12 + ln
    raw = zlib.decompress(idat); ch = {0:1,2:3,3:1,4:2,6:4}[ct]; stride = w*ch
    out = bytearray(); prev = bytearray(stride); pos = 0
    for _ in range(h):
        f = raw[pos]; pos += 1; line = bytearray(raw[pos:pos+stride]); pos += stride
        for x in range(stride):
            a = line[x-ch] if x >= ch else 0; b = prev[x]; c = prev[x-ch] if x >= ch else 0
            if f == 1: line[x] = (line[x]+a) & 255
            elif f == 2: line[x] = (line[x]+b) & 255
            elif f == 3: line[x] = (line[x]+(a+b)//2) & 255
            elif f == 4:
                pp = a+b-c; pa, pb, pc = abs(pp-a), abs(pp-b), abs(pp-c)
                line[x] = (line[x] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        out += line; prev = line
    return w, h, ch, bytes(out)

def write(p, w, h, ch, px):
    ct = {1:0,3:2,4:6}[ch]
    raw = b''.join(b'\x00' + px[y*w*ch:(y+1)*w*ch] for y in range(h))
    def chunk(t, d):
        return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t+d) & 0xffffffff)
    pathlib.Path(p).write_bytes(
        b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, ct, 0, 0, 0))
        + chunk(b'IDAT', zlib.compress(raw, 6)) + chunk(b'IEND', b''))

def crop(src, dst, y0, y1=None, x0=0, x1=None):
    w, h, ch, px = read(src)
    y1 = h if y1 is None else min(y1, h); x1 = w if x1 is None else min(x1, w)
    cw = x1 - x0
    out = b''.join(px[(y*w + x0)*ch:(y*w + x1)*ch] for y in range(y0, y1))
    write(dst, cw, y1 - y0, ch, out)
    return cw, y1 - y0
