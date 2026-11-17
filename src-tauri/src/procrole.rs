//! What kind of process a command line belongs to (no Windows calls in here, so it can be tested alone: `rustc --test procrole.rs`).
//!
//! Chromium based programs (Discord, Chrome ...) start helper processes with `--type=renderer`, `--type=utility --utility-sub-type=...`.
//! Their roles stay the same when the program restarts; process ids do not. Measured with Discord (the Python reader):
//!   voice chat                -> `--type=renderer`, on the output device chosen in Discord's own settings
//!   video / web audio         -> `--type=utility` + `--utility-sub-type=audio.mojom.AudioService`, on the default device

/// Splits a Windows command line the way the C runtime does for ordinary programs: spaces separate, a double quote groups.
pub fn split_args(cmd: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    let mut any = false;
    for c in cmd.chars() {
        match c {
            '"' => { quoted = !quoted; any = true; }
            c if c.is_whitespace() && !quoted => {
                if any { out.push(std::mem::take(&mut cur)); any = false; }
            }
            c => { cur.push(c); any = true; }
        }
    }
    if any { out.push(cur); }
    out
}

/// -> (kind, sub): kind "main" (no --type=), "renderer", "utility", "gpu-process" ...; sub = the last part of --utility-sub-type
/// ("audio.mojom.AudioService" -> "AudioService"), "" when there is none.
pub fn roles_of(cmd: &str) -> (String, String) {
    let args = split_args(cmd);
    let value = |name: &str| args.iter().skip(1).find_map(|a| a.strip_prefix(name).map(|v| v.to_string()));
    let kind = value("--type=").unwrap_or_default();
    let sub = value("--utility-sub-type=").unwrap_or_default();
    let sub = sub.rsplit('.').next().unwrap_or("").to_string();
    (if kind.is_empty() { "main".to_string() } else { kind }, sub)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_like_windows() {
        assert_eq!(split_args(r#""C:\Program Files\Discord\Discord.exe" --type=renderer --x="a b" c"#),
                   vec![r"C:\Program Files\Discord\Discord.exe", "--type=renderer", "--x=a b", "c"]);
        assert_eq!(split_args("  a   b "), vec!["a", "b"]);
        assert_eq!(split_args(""), Vec::<String>::new());
        assert_eq!(split_args(r#"a "" b"#), vec!["a", "", "b"]);
    }

    #[test]
    fn roles() {
        assert_eq!(roles_of(r#""C:\x\Discord.exe""#), ("main".to_string(), "".to_string()));
        assert_eq!(roles_of(r#""C:\x\Discord.exe" --type=renderer --user-data-dir="C:\a b""#), ("renderer".to_string(), "".to_string()));
        assert_eq!(roles_of(r#""C:\x\Discord.exe" --type=utility --utility-sub-type=audio.mojom.AudioService --lang=ko"#),
                   ("utility".to_string(), "AudioService".to_string()));
        assert_eq!(roles_of(r#""C:\x\Discord.exe" --type=gpu-process"#).0, "gpu-process");
        // the program's own path is never read as an option, and an option inside another value does not count
        assert_eq!(roles_of(r#""C:\--type=fake\Discord.exe""#).0, "main");
        assert_eq!(roles_of(r#"x.exe --note=--type=renderer"#).0, "main");
        assert_eq!(roles_of("").0, "main");
    }
}
