"""Cosmos (pokt1...) address from a secp256k1 private key in hex, standard library only.

Used by the server survey to tell which keys file holds the operator's key without
printing or passing the key anywhere: the key is read from the file in this process and
only the derived address is printed.
"""
import hashlib
import re

# secp256k1
P = 2**256 - 2**32 - 977
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
G = (0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
     0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8)


def _add(a, b):
    if a is None:
        return b
    if b is None:
        return a
    if a[0] == b[0] and (a[1] + b[1]) % P == 0:
        return None
    if a == b:
        m = (3 * a[0] * a[0]) * pow(2 * a[1], P - 2, P) % P
    else:
        m = (b[1] - a[1]) * pow(b[0] - a[0], P - 2, P) % P
    x = (m * m - a[0] - b[0]) % P
    return (x, (m * (a[0] - x) - a[1]) % P)


def _mul(k, pt):
    r = None
    while k:
        if k & 1:
            r = _add(r, pt)
        pt = _add(pt, pt)
        k >>= 1
    return r


def _ripemd160(data):
    try:
        h = hashlib.new('ripemd160')
        h.update(data)
        return h.digest()
    except (ValueError, TypeError):
        return _ripemd160_py(data)


def _ripemd160_py(msg):
    """RIPEMD-160 for systems whose OpenSSL no longer provides it."""
    def rol(x, n):
        return ((x << n) | (x >> (32 - n))) & 0xFFFFFFFF
    fs = [lambda x, y, z: x ^ y ^ z,
          lambda x, y, z: (x & y) | (~x & z),
          lambda x, y, z: (x | ~y) ^ z,
          lambda x, y, z: (x & z) | (y & ~z),
          lambda x, y, z: x ^ (y | ~z)]
    KL = [0x00000000, 0x5A827999, 0x6ED9EBA1, 0x8F1BBCDC, 0xA953FD4E]
    KR = [0x50A28BE6, 0x5C4DD124, 0x6D703EF3, 0x7A6D76E9, 0x00000000]
    RL = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
          7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8,
          3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12,
          1, 9, 11, 10, 0, 8, 12, 4, 13, 3, 7, 15, 14, 5, 6, 2,
          4, 0, 5, 9, 7, 12, 2, 10, 14, 1, 3, 8, 11, 6, 15, 13]
    RR = [5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12,
          6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4, 9, 1, 2,
          15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13,
          8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2, 13, 9, 7, 10, 14,
          12, 15, 10, 4, 1, 5, 8, 7, 6, 2, 13, 14, 0, 3, 9, 11]
    SL = [11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8,
          7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9, 11, 7, 13, 12,
          11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5,
          11, 12, 14, 15, 14, 15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12,
          9, 15, 5, 11, 6, 8, 13, 12, 5, 12, 13, 14, 11, 8, 5, 6]
    SR = [8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6,
          9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7, 6, 15, 13, 11,
          9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5,
          15, 5, 8, 11, 14, 14, 6, 14, 6, 9, 12, 9, 12, 5, 15, 8,
          8, 5, 12, 9, 12, 5, 14, 6, 8, 13, 6, 5, 15, 13, 11, 11]
    h = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0]
    ml = len(msg) * 8
    msg = msg + b'\x80' + b'\x00' * ((55 - len(msg)) % 64) + ml.to_bytes(8, 'little')
    for off in range(0, len(msg), 64):
        X = [int.from_bytes(msg[off + 4 * i:off + 4 * i + 4], 'little') for i in range(16)]
        al, bl, cl, dl, el = h
        ar, br, cr, dr, er = h
        for j in range(80):
            r = j // 16
            t = (rol((al + fs[r](bl, cl, dl) + X[RL[j]] + KL[r]) & 0xFFFFFFFF, SL[j]) + el) & 0xFFFFFFFF
            al, el, dl, cl, bl = el, dl, rol(cl, 10), bl, t
            t = (rol((ar + fs[4 - r](br, cr, dr) + X[RR[j]] + KR[r]) & 0xFFFFFFFF, SR[j]) + er) & 0xFFFFFFFF
            ar, er, dr, cr, br = er, dr, rol(cr, 10), br, t
        t = (h[1] + cl + dr) & 0xFFFFFFFF
        h[1] = (h[2] + dl + er) & 0xFFFFFFFF
        h[2] = (h[3] + el + ar) & 0xFFFFFFFF
        h[3] = (h[4] + al + br) & 0xFFFFFFFF
        h[4] = (h[0] + bl + cr) & 0xFFFFFFFF
        h[0] = t
    return b''.join(x.to_bytes(4, 'little') for x in h)


_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'


def _polymod(values):
    gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
    chk = 1
    for v in values:
        b = chk >> 25
        chk = ((chk & 0x1ffffff) << 5) ^ v
        for i in range(5):
            chk ^= gen[i] if ((b >> i) & 1) else 0
    return chk


def bech32(hrp, data):
    acc, bits, out = 0, 0, []
    for b in data:
        acc = (acc << 8) | b
        bits += 8
        while bits >= 5:
            bits -= 5
            out.append((acc >> bits) & 31)
    if bits:
        out.append((acc << (5 - bits)) & 31)
    hx = [ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp]
    pm = _polymod(hx + out + [0] * 6) ^ 1
    return hrp + '1' + ''.join(_CHARSET[d] for d in out + [(pm >> 5 * (5 - i)) & 31 for i in range(6)])


def address_from_hex(hexkey, hrp='pokt'):
    k = int(hexkey, 16)
    if not 0 < k < N:
        raise ValueError('not a secp256k1 private key')
    x, y = _mul(k, G)
    pub = bytes([2 + (y & 1)]) + x.to_bytes(32, 'big')
    return bech32(hrp, _ripemd160(hashlib.sha256(pub).digest()))


def address_from_bytes(raw, hrp='pokt'):
    """The bech32 form of an address stored as hex bytes (a keyring's <hex>.address file)."""
    return bech32(hrp, raw)


if __name__ == '__main__':
    import sys
    # keysfile <path> [<operator>]: the keys file on stdin; one line per key found, with
    # its address and whether it is the operator's. The key itself is never printed.
    if len(sys.argv) >= 3 and sys.argv[1] == 'keysfile':
        path = sys.argv[2]
        op = sys.argv[3] if len(sys.argv) > 3 else ''
        text = sys.stdin.read()
        found = 0
        for k in re.findall(r'(?<![0-9a-fA-F])(?:0x)?([0-9a-fA-F]{64})(?![0-9a-fA-F])', text):
            try:
                a = address_from_hex(k)
            except ValueError:
                continue
            found += 1
            print('keysfile: path=%s address=%s match=%s' % (path, a, ('yes' if a == op else 'no') if op else '-'))
        if not found:
            print('keysfile: path=%s keys=0' % path)
    else:
        for line in sys.stdin:
            line = line.strip()
            if line:
                print(address_from_hex(line))
