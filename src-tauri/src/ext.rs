//! Generic tools for extensions (the voice extension `extensions/stt/` is the first user). They know nothing about Whisper:
//!   download  a file into `extensions/<name>/...` (to `<file>.part` first, resumes, SHA-256 checked, progress events, cancel)
//!   run       a program of an extension hidden; its output lines come back as events; it dies together with this program
//!   remove    a file or folder inside `extensions/<name>/`
//! Every path is relative to the program folder and must be inside `extensions/<name>/` (extlib.rs checks the shape, files.rs the folder).
//! Events (all to every window): `ext-progress` { id, done, total }, `ext-line` { id, line }, `ext-err` { id, line }, `ext-exit` { id, code }.
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::{extlib, files};

fn cancels() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static M: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

struct Run { child: Arc<Mutex<Child>>, stdin: Arc<Mutex<Option<ChildStdin>>> }

fn runs() -> &'static Mutex<HashMap<String, Run>> {
    static M: OnceLock<Mutex<HashMap<String, Run>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

fn file_sha256(path: &Path) -> Result<String, String> {
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut sha = extlib::Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 { break; }
        sha.update(&buf[..n]);
    }
    Ok(sha.finish())
}

// ---- download -------------------------------------------------------------------------------------------------------

/// An engine program that was downloaded must be allowed to run (macOS: a file written by a download has no "execute" right). Only the engine folders
/// (extensions/<name>/engine-<kind>/); the models and the other files stay as they are. Windows has no such right: nothing to do.
fn make_runnable(dest: &str, target: &Path) {
    #[cfg(unix)]
    if dest.replace('\\', "/").contains("/engine-") {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(target, std::fs::Permissions::from_mode(0o755));
    }
    #[cfg(not(unix))]
    let _ = (dest, target);
}

pub async fn download(app: AppHandle, root: PathBuf, id: String, url: String, dest: String, sha: Option<String>) -> Result<Value, String> {
    extlib::under_extension(&dest, false)?;
    let target = files::resolve(&root, &dest)?;
    let part = PathBuf::from(format!("{}.part", target.display()));
    if let Some(dir) = target.parent() { std::fs::create_dir_all(dir).map_err(|e| e.to_string())?; }
    let want = sha.map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty());
    if target.is_file() {
        // already there: fine when it is the right file (or when no checksum was given)
        match &want {
            Some(w) => { if file_sha256(&target)? == *w { make_runnable(&dest, &target); return Ok(json!({ "ok": true, "skipped": true })); } }
            None => { make_runnable(&dest, &target); return Ok(json!({ "ok": true, "skipped": true })); }
        }
    }
    let flag = Arc::new(AtomicBool::new(false));
    cancels().lock().map_err(|e| e.to_string())?.insert(id.clone(), flag.clone());
    let got = fetch(&app, &id, &url, &part, &flag).await;
    if let Ok(mut m) = cancels().lock() { m.remove(&id); }
    let bytes = got?;   // an error leaves the .part file, so the next try goes on from there
    if let Some(w) = &want {
        let have = file_sha256(&part)?;
        if have != *w { let _ = std::fs::remove_file(&part); return Err("sha256 mismatch".into()); }
    }
    let _ = std::fs::remove_file(&target);
    std::fs::rename(&part, &target).map_err(|e| e.to_string())?;
    make_runnable(&dest, &target);
    Ok(json!({ "ok": true, "bytes": bytes }))
}

async fn fetch(app: &AppHandle, id: &str, url: &str, part: &Path, flag: &Arc<AtomicBool>) -> Result<u64, String> {
    use tauri_plugin_http::reqwest;
    let client = reqwest::Client::builder().connect_timeout(Duration::from_secs(20)).http1_only().build().map_err(|e| e.to_string())?;
    for attempt in 0..2 {
        let start = std::fs::metadata(part).map(|m| m.len()).unwrap_or(0);
        let mut req = client.get(url);
        if start > 0 { req = req.header("Range", format!("bytes={start}-")); }
        let mut res = req.send().await.map_err(|e| format!("{e}"))?;
        let status = res.status().as_u16();
        if status == 416 && attempt == 0 { let _ = std::fs::remove_file(part); continue; } // the .part file was not usable: start over
        if status != 200 && status != 206 { return Err(format!("HTTP {status}")); }
        let resumed = status == 206 && start > 0;
        let base = if resumed { start } else { 0 };
        let total = res.content_length().map(|n| n + base).unwrap_or(0);
        let opened = if resumed { std::fs::OpenOptions::new().append(true).open(part) } else { std::fs::File::create(part) };
        let mut file = opened.map_err(|e| e.to_string())?;
        let mut done = base;
        let mut last = Instant::now();
        let _ = app.emit("ext-progress", json!({ "id": id, "done": done, "total": total }));
        while let Some(chunk) = res.chunk().await.map_err(|e| format!("{e}"))? {
            if flag.load(Ordering::Relaxed) { return Err("cancelled".into()); }
            file.write_all(&chunk).map_err(|e| e.to_string())?;
            done += chunk.len() as u64;
            if last.elapsed() > Duration::from_millis(250) {
                last = Instant::now();
                let _ = app.emit("ext-progress", json!({ "id": id, "done": done, "total": total }));
            }
        }
        file.flush().map_err(|e| e.to_string())?;
        let _ = app.emit("ext-progress", json!({ "id": id, "done": done, "total": done }));
        return Ok(done);
    }
    Err("download failed".into())
}

pub fn cancel(id: &str) {
    if let Ok(m) = cancels().lock() { if let Some(f) = m.get(id) { f.store(true, Ordering::Relaxed); } }
}

// ---- run ------------------------------------------------------------------------------------------------------------

#[cfg(windows)]
mod job {
    //! One job object with "kill on close": a program started through `run` ends when this program ends, however it ends.
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use std::sync::OnceLock;

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attr: *const u8, name: *const u16) -> isize;
        fn SetInformationJobObject(job: isize, class: i32, info: *const u8, len: u32) -> i32;
        fn AssignProcessToJobObject(job: isize, process: isize) -> i32;
    }
    #[repr(C)]
    struct Basic { per_process: i64, per_job: i64, flags: u32, min_ws: usize, max_ws: usize, active: u32, affinity: usize, prio: u32, sched: u32 }
    #[repr(C)]
    struct Extended { basic: Basic, io: [u64; 6], proc_mem: usize, job_mem: usize, peak_proc: usize, peak_job: usize }

    fn handle() -> isize {
        static H: OnceLock<isize> = OnceLock::new();
        *H.get_or_init(|| unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job == 0 { return 0; }
            let info = Extended { basic: Basic { per_process: 0, per_job: 0, flags: 0x2000, min_ws: 0, max_ws: 0, active: 0, affinity: 0, prio: 0, sched: 0 },
                io: [0; 6], proc_mem: 0, job_mem: 0, peak_proc: 0, peak_job: 0 }; // flags 0x2000 = KILL_ON_JOB_CLOSE
            if SetInformationJobObject(job, 9, &info as *const Extended as *const u8, std::mem::size_of::<Extended>() as u32) == 0 { return 0; }
            job
        })
    }

    pub fn assign(child: &Child) {
        let job = handle();
        if job != 0 { unsafe { AssignProcessToJobObject(job, child.as_raw_handle() as isize); } }
    }
}

fn pump(app: AppHandle, id: String, event: &'static str, source: impl Read + Send + 'static) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(source);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&buf).trim_end().to_string();
                    let _ = app.emit(event, json!({ "id": id, "line": line }));
                }
            }
        }
    });
}

/// Starts `exe` (inside an extension folder) hidden. TEMP / TMP point into the extension's own `tmp` folder, so nothing is written elsewhere.
pub fn run(app: AppHandle, root: PathBuf, id: String, exe: String, args: Vec<String>) -> Result<Value, String> {
    let (name, _) = extlib::under_extension(&exe, false)?;
    let path = files::resolve(&root, &exe)?;
    if !path.is_file() { return Err(format!("not found: {exe}")); }
    if runs().lock().map_err(|e| e.to_string())?.contains_key(&id) { return Err("already running".into()); }
    let tmp = files::resolve(&root, &format!("extensions/{name}/tmp"))?;
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let mut cmd = Command::new(&path);
    cmd.args(&args).env("TEMP", &tmp).env("TMP", &tmp).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(dir) = path.parent() { cmd.current_dir(dir); }
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; cmd.creation_flags(0x0800_0000); } // CREATE_NO_WINDOW
    let mut child = cmd.spawn().map_err(|e| format!("cannot start: {e}"))?;
    #[cfg(windows)]
    job::assign(&child);
    let pid = child.id();
    if let Some(o) = child.stdout.take() { pump(app.clone(), id.clone(), "ext-line", o); }
    if let Some(e) = child.stderr.take() { pump(app.clone(), id.clone(), "ext-err", e); }
    let stdin = Arc::new(Mutex::new(child.stdin.take()));
    let child = Arc::new(Mutex::new(child));
    runs().lock().map_err(|e| e.to_string())?.insert(id.clone(), Run { child: child.clone(), stdin });
    // the one who reports the end (and forgets the run)
    let (app2, id2) = (app, id);
    std::thread::spawn(move || {
        let code = loop {
            std::thread::sleep(Duration::from_millis(100));
            let Ok(mut c) = child.lock() else { break -1 };
            match c.try_wait() { Ok(Some(s)) => break s.code().unwrap_or(-1), Ok(None) => {} Err(_) => break -1 }
        };
        if let Ok(mut m) = runs().lock() { m.remove(&id2); }
        let _ = app2.emit("ext-exit", json!({ "id": id2, "code": code }));
    });
    Ok(json!({ "ok": true, "pid": pid }))
}

/// Bytes to the standard input of a running program (the sound goes through here later). Closed stdin = the program ends its loop.
pub fn write_stdin(id: &str, bytes: &[u8], close: bool) -> Result<(), String> {
    let stdin = { let m = runs().lock().map_err(|e| e.to_string())?; m.get(id).map(|r| r.stdin.clone()) };
    let stdin = stdin.ok_or_else(|| "not running".to_string())?;
    let mut g = stdin.lock().map_err(|e| e.to_string())?;
    if let Some(s) = g.as_mut() {
        if !bytes.is_empty() { s.write_all(bytes).map_err(|e| e.to_string())?; }
        s.flush().map_err(|e| e.to_string())?;
    }
    if close { *g = None; }
    Ok(())
}

pub fn kill(id: &str) {
    let child = runs().lock().ok().and_then(|m| m.get(id).map(|r| r.child.clone()));
    if let Some(c) = child { if let Ok(mut c) = c.lock() { let _ = c.kill(); } }
}

pub fn is_running(id: &str) -> bool { runs().lock().map(|m| m.contains_key(id)).unwrap_or(false) }

// ---- remove ---------------------------------------------------------------------------------------------------------

/// A file or a folder (with everything in it) inside `extensions/<name>/`, or the extension's whole folder. Not there = fine.
pub fn remove(root: &Path, path: &str) -> Result<(), String> {
    extlib::under_extension(path, true)?;
    let p = files::resolve(root, path)?;
    match std::fs::symlink_metadata(&p) {
        Ok(m) if m.is_dir() => std::fs::remove_dir_all(&p).map_err(|e| e.to_string()),
        Ok(_) => std::fs::remove_file(&p).map_err(|e| e.to_string()),
        Err(_) => Ok(()),
    }
}
