//! Plugins: the parts that need no Tauri (the checks of names and paths, the secret that goes into the address of a plugin, the fingerprint of a plugin folder).
//! Tested alone: `rustc --test --edition 2021 pluginlib.rs` (with extlib.rs next to it: `#[path]` below).
//!
//! A plugin lives in `plugins/<id>/` of the program folder and is shown in a sandboxed frame from the address
//! `cmrplug://localhost/<token>/<file>` (Windows: `http://cmrplug.localhost/<token>/<file>`). The token is made by this program when the plugin is started (one per plugin
//! and per run) and is told only to the page that starts the plugin: another plugin does not know it and so cannot read these files.
use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::path::Path;
use std::sync::Mutex;

#[cfg(not(test))]
use crate::extlib::Sha256;
#[cfg(test)]
#[path = "extlib.rs"]
mod extlib;
#[cfg(test)]
use extlib::Sha256;

/// The id of a plugin = the name of its folder: lower case letters, digits, '-' and '_' (long and not easy to guess is what the documents ask for).
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 100 && id.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-' || c == b'_')
}

/// A path inside a plugin folder, as the address gives it: no "..", no drive or stream names, no back slash, not absolute, no empty or hidden-name tricks.
pub fn valid_rel(rel: &str) -> bool {
    !rel.is_empty()
        && rel.len() <= 300
        && !rel.starts_with('/')
        && !rel.contains("..")
        && !rel.contains(':')
        && !rel.contains('\\')
        && !rel.contains('\0')
        && !rel.split('/').any(|s| s.is_empty() || s.ends_with('.') || s.ends_with(' '))
}

/// Is `file` really inside `root` (links and junctions are followed: one that leads out does not count)?
pub fn inside(root: &Path, file: &Path) -> bool {
    match (std::fs::canonicalize(root), std::fs::canonicalize(file)) {
        (Ok(r), Ok(f)) => f.starts_with(&r),
        _ => false,
    }
}

/// 128 bits that nobody outside this program can guess: keys the system gave to the hasher (they come from the system's random numbers) mixed with the clock.
fn random_hex() -> String {
    let mut out = String::new();
    for i in 0..2u64 {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        h.write_u128(t);
        h.write_u64(i);
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

/// plugin id <-> token, for this run of the program.
pub struct Tokens {
    by_token: Mutex<HashMap<String, String>>,
    by_id: Mutex<HashMap<String, String>>,
}

impl Tokens {
    pub fn new() -> Tokens {
        Tokens { by_token: Mutex::new(HashMap::new()), by_id: Mutex::new(HashMap::new()) }
    }
    /// The token of a plugin (made the first time). `renew`: a new one (the old address stops working): when the plugin is started again.
    pub fn token_for(&self, id: &str, renew: bool) -> Result<String, String> {
        if !valid_id(id) {
            return Err("bad plugin id".into());
        }
        let mut by_id = self.by_id.lock().unwrap();
        let mut by_token = self.by_token.lock().unwrap();
        if !renew {
            if let Some(t) = by_id.get(id) {
                return Ok(t.clone());
            }
        }
        if let Some(old) = by_id.get(id) {
            by_token.remove(old);
        }
        let t = random_hex();
        by_token.insert(t.clone(), id.to_string());
        by_id.insert(id.to_string(), t.clone());
        Ok(t)
    }
    pub fn id_of(&self, token: &str) -> Option<String> {
        self.by_token.lock().unwrap().get(token).cloned()
    }
    /// The plugin is stopped: its address stops working.
    pub fn forget(&self, id: &str) {
        if let Some(t) = self.by_id.lock().unwrap().remove(id) {
            self.by_token.lock().unwrap().remove(&t);
        }
    }
}

pub struct FileInfo { pub path: String, pub size: u64, pub sha256: String }

const MAX_FILES: usize = 2000;
const MAX_DEPTH: usize = 8;
const MAX_TOTAL: u64 = 200 * 1024 * 1024;

fn sha_of(path: &Path) -> Result<String, String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut sha = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 { break; }
        sha.update(&buf[..n]);
    }
    Ok(sha.finish())
}

fn walk(root: &Path, dir: &Path, depth: usize, out: &mut Vec<FileInfo>, total: &mut u64) -> Result<(), String> {
    if depth > MAX_DEPTH {
        return Err("the folder is nested too deep".into());
    }
    let mut names: Vec<_> = std::fs::read_dir(dir).map_err(|e| e.to_string())?.filter_map(|e| e.ok()).collect();
    names.sort_by_key(|e| e.file_name());
    for e in names {
        let p = e.path();
        let meta = std::fs::symlink_metadata(&p).map_err(|e| e.to_string())?;
        if meta.file_type().is_symlink() {
            return Err(format!("a link is not allowed in a plugin: {}", p.display()));
        }
        if meta.is_dir() {
            walk(root, &p, depth + 1, out, total)?;
        } else if meta.is_file() {
            if out.len() >= MAX_FILES { return Err("too many files".into()); }
            *total += meta.len();
            if *total > MAX_TOTAL { return Err("the plugin is too big".into()); }
            let rel = p.strip_prefix(root).map_err(|e| e.to_string())?.to_string_lossy().replace('\\', "/");
            out.push(FileInfo { path: rel, size: meta.len(), sha256: sha_of(&p)? });
        }
    }
    Ok(())
}

/// Every file of the folder with its SHA-256, and one fingerprint of all of them (the SHA-256 of the lines "path<TAB>sha256", in the order of the paths).
pub fn tree_hash(root: &Path) -> Result<(String, Vec<FileInfo>), String> {
    let mut files = Vec::new();
    let mut total = 0u64;
    walk(root, root, 0, &mut files, &mut total)?;
    files.sort_by(|a, b| a.path.cmp(&b.path));
    let mut sha = Sha256::new();
    for f in &files {
        sha.update(format!("{}\t{}\n", f.path, f.sha256).as_bytes());
    }
    Ok((sha.finish(), files))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids() {
        assert!(valid_id("community-watch_9f3a"));
        for bad in ["", "Big", "a b", "a/b", "a.b", "../x", &"a".repeat(101)] {
            assert!(!valid_id(bad), "{bad}");
        }
    }

    #[test]
    fn paths() {
        for ok in ["index.html", "js/main.mjs", "a-b/c_d.css"] {
            assert!(valid_rel(ok), "{ok}");
        }
        for bad in ["", "/etc/x", "../x", "a/../b", "a\\b", "c:x", "a//b", "a/", "a./b", "a /b", "x\0y"] {
            assert!(!valid_rel(bad), "{bad}");
        }
    }

    #[test]
    fn tokens() {
        let t = Tokens::new();
        let a = t.token_for("one", false).unwrap();
        let b = t.token_for("two", false).unwrap();
        assert_eq!(a.len(), 32);
        assert_ne!(a, b);
        assert_eq!(t.token_for("one", false).unwrap(), a);
        assert_eq!(t.id_of(&a).as_deref(), Some("one"));
        let a2 = t.token_for("one", true).unwrap();
        assert_ne!(a, a2);
        assert!(t.id_of(&a).is_none());
        t.forget("one");
        assert!(t.id_of(&a2).is_none());
        assert!(t.token_for("Bad", false).is_err());
        assert_ne!(random_hex(), random_hex());
    }

    #[test]
    fn hash_of_a_folder() {
        let dir = std::env::temp_dir().join(format!("pluginlib_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("js")).unwrap();
        std::fs::write(dir.join("plugin.json"), b"{}").unwrap();
        std::fs::write(dir.join("js/main.mjs"), b"hello").unwrap();
        let (all, files) = tree_hash(&dir).unwrap();
        assert_eq!(files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["js/main.mjs", "plugin.json"]);
        assert_eq!(files[0].sha256, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");   // sha256("hello")
        assert_eq!(all.len(), 64);
        std::fs::write(dir.join("js/main.mjs"), b"hellO").unwrap();
        assert_ne!(tree_hash(&dir).unwrap().0, all);
        assert!(inside(&dir, &dir.join("js/main.mjs")));
        assert!(!inside(&dir, &dir.join("..")));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
