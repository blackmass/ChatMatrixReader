//! File access for the pages, locked into the program folder. No Tauri in here, so it can be tested alone (`rustc --test files.rs`).
//!
//! Every path a page gives is relative to the program folder (the one with `app/` and `config.json`). A path that is absolute, has a
//! drive letter, contains `..`, or reaches outside through a link (symlink / junction) is refused. The program is portable (unzipped,
//! no installer): everything it reads or writes lives under its own folder, and a bug in a page cannot touch anything else.
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

const READ_MAX: u64 = 32 * 1024 * 1024; // a page reads text files (config, glossary, logs); nothing bigger goes through here

/// `rel` (forward or back slashes) -> the full path inside `root`, or an error.
pub fn resolve(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = rel.replace('\\', "/");
    let rel_path = Path::new(&rel);
    let mut full = root.to_path_buf();
    for c in rel_path.components() {
        match c {
            // ':' = a drive letter ("C:") or an NTFS alternate data stream ("a.txt:hidden"): never needed, so never allowed (on every system)
            Component::Normal(part) if part.to_string_lossy().contains(':') => return Err(format!("path not allowed: {rel}")),
            Component::Normal(part) => full.push(part),
            Component::CurDir => {}
            _ => return Err(format!("path not allowed: {rel}")), // "..", "C:", "/x"
        }
    }
    // a link inside the folder must not lead out of it: look at where the deepest existing part really is
    let croot = root.canonicalize().map_err(|e| e.to_string())?;
    let mut cur = full.clone();
    while !cur.exists() {
        if !cur.pop() {
            break;
        }
    }
    let real = cur.canonicalize().map_err(|e| e.to_string())?;
    if !real.starts_with(&croot) {
        return Err(format!("path leaves the program folder: {rel}"));
    }
    Ok(full)
}

/// The text of a file (UTF-8; a broken byte becomes the replacement character), None when the file does not exist.
pub fn read_text(root: &Path, rel: &str) -> Result<Option<String>, String> {
    let p = resolve(root, rel)?;
    match fs::metadata(&p) {
        Ok(m) if m.is_file() => {
            if m.len() > READ_MAX {
                return Err(format!("file too big: {rel}"));
            }
            let bytes = fs::read(&p).map_err(|e| e.to_string())?;
            Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
        }
        Ok(_) => Err(format!("not a file: {rel}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Writes a file in one piece: the text goes to `<name>.tmp` first and replaces the old file only when it is complete, so a crash
/// or a power cut in the middle never leaves a half-written config.json. Missing folders are made.
pub fn write_text(root: &Path, rel: &str, text: &str) -> Result<(), String> {
    let p = resolve(root, rel)?;
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut tmp = p.clone().into_os_string();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    {
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, &p).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

/// Adds text at the end of a file (logs). The file and its folders are made when missing.
pub fn append_text(root: &Path, rel: &str, text: &str) -> Result<(), String> {
    let p = resolve(root, rel)?;
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut f = fs::OpenOptions::new().create(true).append(true).open(&p).map_err(|e| e.to_string())?;
    f.write_all(text.as_bytes()).map_err(|e| e.to_string())
}

/// "file" / "dir" / "" (does not exist)
pub fn kind(root: &Path, rel: &str) -> Result<&'static str, String> {
    let p = resolve(root, rel)?;
    Ok(match fs::metadata(&p) {
        Ok(m) if m.is_dir() => "dir",
        Ok(_) => "file",
        Err(_) => "",
    })
}

/// File names in a folder (a folder name ends with "/"), sorted. A folder that does not exist is an empty list.
pub fn list(root: &Path, rel: &str) -> Result<Vec<String>, String> {
    let p = resolve(root, rel)?;
    let rd = match fs::read_dir(&p) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e.to_string()),
    };
    let mut out: Vec<String> = rd
        .filter_map(|e| e.ok())
        .map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) { format!("{name}/") } else { name }
        })
        .collect();
    out.sort();
    Ok(out)
}

pub fn make_dir(root: &Path, rel: &str) -> Result<(), String> {
    fs::create_dir_all(resolve(root, rel)?).map_err(|e| e.to_string())
}

/// Deletes one file (never a folder, never the program folder itself). A file that is not there is fine.
pub fn remove_file(root: &Path, rel: &str) -> Result<(), String> {
    let p = resolve(root, rel)?;
    match fs::metadata(&p) {
        Ok(m) if m.is_file() => fs::remove_file(&p).map_err(|e| e.to_string()),
        Ok(_) => Err(format!("not a file: {rel}")),
        Err(_) => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("cmr_files_{}_{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn refuses_paths_that_leave_the_folder() {
        let root = temp("refuse");
        for bad in ["../x.txt", "a/../../x", "..\\x", "/etc/passwd", "C:/x", "C:\\x", "\\\\server\\share\\x"] {
            assert!(resolve(&root, bad).is_err(), "{bad} must be refused");
        }
        for good in ["config.json", "a/b/c.txt", "a\\b.txt", "./x", "data/日本語.txt", ""] {
            assert!(resolve(&root, good).is_ok(), "{good} must be allowed");
        }
    }

    #[test]
    fn write_read_append_list_remove() {
        let root = temp("rw");
        assert_eq!(read_text(&root, "config.json").unwrap(), None);
        write_text(&root, "config.json", "{\"a\": 1}").unwrap();
        assert_eq!(read_text(&root, "config.json").unwrap().as_deref(), Some("{\"a\": 1}"));
        write_text(&root, "config.json", "{\"a\": 2}").unwrap(); // replaces
        assert_eq!(read_text(&root, "config.json").unwrap().as_deref(), Some("{\"a\": 2}"));
        assert!(!root.join("config.json.tmp").exists(), "no temporary file is left behind");
        write_text(&root, "logs/한글.txt", "안녕").unwrap(); // folders are made, UTF-8 survives
        assert_eq!(read_text(&root, "logs/한글.txt").unwrap().as_deref(), Some("안녕"));
        append_text(&root, "logs/a.log", "one\n").unwrap();
        append_text(&root, "logs/a.log", "two\n").unwrap();
        assert_eq!(read_text(&root, "logs/a.log").unwrap().as_deref(), Some("one\ntwo\n"));
        assert_eq!(list(&root, "logs").unwrap(), vec!["a.log".to_string(), "한글.txt".to_string()]);
        assert_eq!(list(&root, "").unwrap(), vec!["config.json".to_string(), "logs/".to_string()]);
        assert_eq!(list(&root, "nothing").unwrap(), Vec::<String>::new());
        assert_eq!(kind(&root, "logs").unwrap(), "dir");
        assert_eq!(kind(&root, "config.json").unwrap(), "file");
        assert_eq!(kind(&root, "nope").unwrap(), "");
        remove_file(&root, "logs/a.log").unwrap();
        remove_file(&root, "logs/a.log").unwrap(); // already gone: fine
        assert!(remove_file(&root, "logs").is_err(), "a folder is never deleted");
        assert!(read_text(&root, "logs").is_err());
    }

    #[test]
    fn broken_utf8_does_not_fail() {
        let root = temp("utf8");
        fs::write(root.join("x.txt"), [b'a', 0xff, b'b']).unwrap();
        assert_eq!(read_text(&root, "x.txt").unwrap().as_deref(), Some("a\u{fffd}b"));
    }

    #[cfg(unix)]
    #[test]
    fn a_link_cannot_lead_out() {
        let root = temp("link");
        let outside = temp("outside");
        fs::write(outside.join("secret.txt"), "x").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("out")).unwrap();
        assert!(read_text(&root, "out/secret.txt").is_err());
        assert!(write_text(&root, "out/new.txt", "x").is_err());
        assert!(!outside.join("new.txt").exists());
    }
}
