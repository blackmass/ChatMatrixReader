//! Pure helpers of the extension tools (no Tauri, no Windows: `rustc --test extlib.rs`).

/// SHA-256, fed in pieces.
pub struct Sha256 { h: [u32; 8], buf: Vec<u8>, len: u64 }

const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

impl Sha256 {
    pub fn new() -> Sha256 {
        Sha256 { h: [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19], buf: Vec::with_capacity(64), len: 0 }
    }

    fn block(h: &mut [u32; 8], b: &[u8]) {
        let mut w = [0u32; 64];
        for i in 0..16 { w[i] = u32::from_be_bytes([b[i * 4], b[i * 4 + 1], b[i * 4 + 2], b[i * 4 + 3]]); }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
        }
        let [mut a, mut b2, mut c, mut d, mut e, mut f, mut g, mut hh] = *h;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ (!e & g);
            let t1 = hh.wrapping_add(s1).wrapping_add(ch).wrapping_add(K[i]).wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b2) ^ (a & c) ^ (b2 & c);
            let t2 = s0.wrapping_add(maj);
            hh = g; g = f; f = e; e = d.wrapping_add(t1); d = c; c = b2; b2 = a; a = t1.wrapping_add(t2);
        }
        for (x, y) in h.iter_mut().zip([a, b2, c, d, e, f, g, hh]) { *x = x.wrapping_add(y); }
    }

    pub fn update(&mut self, data: &[u8]) {
        self.len += data.len() as u64;
        self.buf.extend_from_slice(data);
        let full = self.buf.len() / 64 * 64;
        for chunk in self.buf[..full].chunks(64) { Sha256::block(&mut self.h, chunk); }
        self.buf.drain(..full);
    }

    /// lower case hex
    pub fn finish(mut self) -> String {
        let bits = self.len * 8;
        let mut tail = std::mem::take(&mut self.buf);
        tail.push(0x80);
        while tail.len() % 64 != 56 { tail.push(0); }
        tail.extend_from_slice(&bits.to_be_bytes());
        for chunk in tail.chunks(64) { Sha256::block(&mut self.h, chunk); }
        self.h.iter().map(|x| format!("{x:08x}")).collect()
    }
}

/// A name of an extension folder: `stt`, `my-ext_2`.
pub fn name_ok(name: &str) -> bool {
    !name.is_empty() && name.len() <= 32 && name.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-' || c == b'_')
}

/// `extensions/<name>/<rest>` -> (name, rest). `rest` may be empty only when `allow_root` (the extension's own folder). Slashes either way.
/// This is only the shape check; the path is also resolved inside the program folder by files::resolve.
pub fn under_extension(rel: &str, allow_root: bool) -> Result<(String, String), String> {
    let rel = rel.replace('\\', "/");
    let parts: Vec<&str> = rel.split('/').filter(|p| !p.is_empty() && *p != ".").collect();
    if parts.len() < 2 || parts[0] != "extensions" || !name_ok(parts[1]) { return Err(format!("not inside an extension folder: {rel}")); }
    if parts.iter().any(|p| *p == ".." || p.contains(':')) { return Err(format!("path not allowed: {rel}")); }
    if parts.len() == 2 && !allow_root { return Err(format!("needs a path inside the extension folder: {rel}")); }
    Ok((parts[1].to_string(), parts[2..].join("/")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sha(data: &[u8]) -> String { let mut s = Sha256::new(); s.update(data); s.finish() }

    #[test]
    fn sha256_known_values() {
        assert_eq!(sha(b""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert_eq!(sha(b"abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_eq!(sha(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"), "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
    }

    #[test]
    fn sha256_in_pieces_equals_at_once() {
        let data: Vec<u8> = (0..100_000u32).map(|i| (i * 7 % 251) as u8).collect();
        let mut s = Sha256::new();
        for c in data.chunks(1000 + 13) { s.update(c); }
        assert_eq!(s.finish(), sha(&data));
        let million = vec![b'a'; 1_000_000];
        assert_eq!(sha(&million), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
    }

    #[test]
    fn extension_paths() {
        assert_eq!(under_extension("extensions/stt/models/a.bin", false).unwrap(), ("stt".to_string(), "models/a.bin".to_string()));
        assert_eq!(under_extension("extensions\\stt\\engine-cpu\\x.exe", false).unwrap().1, "engine-cpu/x.exe");
        assert!(under_extension("extensions/stt", false).is_err());
        assert!(under_extension("extensions/stt", true).is_ok());
        for bad in ["extensions", "extensions/", "app/x", "config.json", "extensions/../app/x", "extensions/Stt/x", "extensions/stt/../../x", "extensions/stt/a:b", "../extensions/stt/x", "x/extensions/stt/y"] {
            assert!(under_extension(bad, true).is_err(), "{bad}");
        }
    }
}
