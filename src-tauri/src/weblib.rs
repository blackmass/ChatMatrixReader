//! The web windows of the plugins: the pure part (no Tauri), tested alone: `rustc --test --edition 2021 weblib.rs`.
//!
//! A web window may go to an address only when its host is on the list the program built from what the user allowed: a plain host ("m.example.com") or a whole domain
//! ("*.example.com": the domain itself and every host below it).

/// Is `host` allowed by one of the patterns? (host names are compared in lower case; "*.example.com" matches "example.com" and "a.b.example.com", never "badexample.com")
pub fn host_allowed(host: &str, patterns: &[String]) -> bool {
    let h = host.trim_end_matches('.').to_ascii_lowercase();
    if h.is_empty() { return false; }
    patterns.iter().any(|p| {
        let p = p.trim().to_ascii_lowercase();
        match p.strip_prefix("*.") {
            Some(domain) => !domain.is_empty() && (h == domain || h.ends_with(&format!(".{domain}"))),
            None => !p.is_empty() && h == p,
        }
    })
}

/// The commands the bar that is drawn into the page can send: the page tries to go to "cmr-cmd://<command>", which is caught and never goes anywhere.
pub fn is_command_url(scheme: &str) -> bool { scheme == "cmr-cmd" }

/// A key for a plugin's own web data (a folder name on Windows): letters, digits, '-' and '_' of the plugin id, nothing else.
pub fn data_key(plugin_id: &str) -> String {
    let k: String = plugin_id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(100).collect();
    if k.is_empty() { "plugin".into() } else { k }
}

/// 16 bytes from a text (the identifier of a macOS web data store): the same text always gives the same bytes. FNV-1a over two seeds, nothing secret.
#[allow(dead_code)]   // (macOS only)
pub fn store_id(text: &str) -> [u8; 16] {
    let mut out = [0u8; 16];
    for (i, seed) in [0xcbf29ce484222325u64, 0x84222325cbf29ce4u64].iter().enumerate() {
        let mut h = *seed;
        for b in text.bytes() { h ^= b as u64; h = h.wrapping_mul(0x100000001b3); }
        out[i * 8..i * 8 + 8].copy_from_slice(&h.to_be_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    fn p(v: &[&str]) -> Vec<String> { v.iter().map(|s| s.to_string()).collect() }

    #[test]
    fn hosts_and_domains() {
        let pats = p(&["m.example.com", "*.dcinside.com"]);
        for ok in ["m.example.com", "M.Example.COM", "dcinside.com", "gall.dcinside.com", "a.b.dcinside.com", "gall.dcinside.com."] { assert!(host_allowed(ok, &pats), "{ok}"); }
        for bad in ["example.com", "x.m.example.com", "baddcinside.com", "dcinside.com.evil.org", "evil.org", "", "com"] { assert!(!host_allowed(bad, &pats), "{bad}"); }
        assert!(!host_allowed("a.com", &p(&[])));
        assert!(!host_allowed("a.com", &p(&["*.", "", "*"])));
    }

    #[test]
    fn keys() {
        assert_eq!(data_key("my-plugin_id9"), "my-plugin_id9");
        assert_eq!(data_key("../x/y"), "xy");
        assert_eq!(data_key("///"), "plugin");
        assert_eq!(store_id("a"), store_id("a"));
        assert_ne!(store_id("a"), store_id("b"));
    }
}
