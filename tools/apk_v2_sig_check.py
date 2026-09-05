"""APK v2 签名证书指纹验证（无第三方依赖，扫描式）
原理：APK Signature Scheme v2 block 内含 signer X.509 证书（DER，30 82 开头）。
在 signing block 段内扫描所有 30 82 候选，算 SHA1/MD5 并与期望 release keystore 指纹比对。
"""
import struct, hashlib, sys

EXPECT_SHA1 = '8E:D4:C3:68:A8:66:70:95:8D:34:9B:4A:A3:6B:83:06:2F:3B:17:89'

def fmt_fp(hexstr, upper=True):
    h = hexstr.upper() if upper else hexstr.lower()
    return ':'.join(h[i:i+2] for i in range(0, len(h), 2))

def main(apk):
    data = open(apk, 'rb').read()
    eocd = data.rfind(b'\x50\x4b\x05\x06')
    if eocd < 0: raise SystemExit('EOCD not found')
    cd_off = struct.unpack_from('<I', data, eocd + 16)[0]
    assert data[cd_off-16:cd_off] == b'APK Sig Block 42', 'no APK Sig Block'
    size = struct.unpack_from('<Q', data, cd_off - 24)[0]
    seg_start = cd_off - 16 - size          # signing block 段起点
    seg_end = cd_off - 16                    # magic 起点（段尾）
    seg = data[seg_start:seg_end]
    assert b'\x1a\x87\x09\x71' in seg, 'v2 block ID not found'
    print(f'signing block: {len(seg)} bytes @ {seg_start}')

    hits = []
    i = 0
    while True:
        j = seg.find(b'\x30\x82', i)
        if j < 0: break
        der_len = struct.unpack_from('>H', seg, j + 2)[0]   # X.509 SEQUENCE 长度
        total = der_len + 4
        if 300 < total < 20000 and j + total <= len(seg):
            cert = seg[j:j + total]
            sha1 = fmt_fp(hashlib.sha1(cert).hexdigest())
            md5 = fmt_fp(hashlib.md5(cert).hexdigest())
            match = (sha1 == EXPECT_SHA1)
            hits.append((j, total, sha1, md5, match))
            if match: break
        i = j + 2

    if not hits:
        raise SystemExit('no X.509 candidate found in v2 block')
    print(f'found {len(hits)} X.509 candidate(s)')
    for off, ln, sha1, md5, m in hits[:5]:
        tag = ' <<< MATCH release keystore' if m else ''
        print(f'  @{off:6d} len={ln:5d}  SHA1={sha1}  MD5={md5}{tag}')
    ok = any(m for *_, m in hits)
    print('RESULT:', 'PASS ✅ 与 release keystore 签名一致（可上架）' if ok else 'FAIL ❌ 未匹配期望指纹')
    return 0 if ok else 1

if __name__ == '__main__':
    sys.exit(main(sys.argv[1]))
