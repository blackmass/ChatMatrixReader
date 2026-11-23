//! What the program and its helper processes use (the tab "기록" of the options). Read only when that page is open (it asks every second or two).
//! Windows: this process and all its descendants (the WebView2 helpers: browser, GPU, renderers, utilities; the voice engine): memory (working set, private), the CPU time so far, handles,
//! GDI / USER objects (windows are USER objects: the count shows what many windows cost). macOS: this process and its children by `ps`; the WebKit helper processes are started by the system,
//! not by this program, so they are listed apart (all programs' together).
use serde_json::{json, Value};

#[cfg(windows)]
mod imp {
    use super::*;
    use std::collections::HashSet;

    #[repr(C)]
    #[derive(Default)]
    struct Pmc { cb: u32, page_faults: u32, peak_ws: usize, ws: usize, q1: usize, q2: usize, q3: usize, q4: usize, pagefile: usize, peak_pagefile: usize, private: usize }
    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    struct FileTime { lo: u32, hi: u32 }
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
        fn CloseHandle(h: isize) -> i32;
        fn K32GetProcessMemoryInfo(h: isize, c: *mut Pmc, cb: u32) -> i32;
        fn GetProcessTimes(h: isize, create: *mut FileTime, exit: *mut FileTime, kernel: *mut FileTime, user: *mut FileTime) -> i32;
        fn GetProcessHandleCount(h: isize, count: *mut u32) -> i32;
    }
    #[link(name = "user32")]
    extern "system" {
        fn GetGuiResources(h: isize, flags: u32) -> u32;
    }
    fn ft(t: FileTime) -> u64 { ((t.hi as u64) << 32) | t.lo as u64 }

    pub fn stats() -> Value {
        let me = std::process::id();
        let table = crate::audio::win::process_table();
        let mut mine: HashSet<u32> = HashSet::new();
        mine.insert(me);
        loop {                                                              // (the processes that came from this one, children of children too)
            let before = mine.len();
            for (pid, (ppid, _)) in &table { if mine.contains(ppid) { mine.insert(*pid); } }
            if mine.len() == before { break; }
        }
        let mut rows: Vec<Value> = Vec::new();
        for pid in mine {
            let Some((ppid, exe)) = table.get(&pid) else { continue };
            let (kind, sub) = if pid == me { ("main".to_string(), String::new()) } else { crate::procrole::roles_of(&crate::audio::win::cmdline::of(pid)) };
            let (mut ws, mut private, mut cpu_ms, mut handles, mut gdi, mut user) = (0u64, 0u64, 0u64, 0u32, 0u32, 0u32);
            unsafe {
                let h = OpenProcess(0x1000, 0, pid);                        // PROCESS_QUERY_LIMITED_INFORMATION
                if h != 0 {
                    let mut c = Pmc::default();
                    c.cb = std::mem::size_of::<Pmc>() as u32;
                    if K32GetProcessMemoryInfo(h, &mut c, c.cb) != 0 { ws = c.ws as u64; private = c.private as u64; }
                    let (mut a, mut b, mut k, mut u) = (FileTime::default(), FileTime::default(), FileTime::default(), FileTime::default());
                    if GetProcessTimes(h, &mut a, &mut b, &mut k, &mut u) != 0 { cpu_ms = (ft(k) + ft(u)) / 10_000; }
                    GetProcessHandleCount(h, &mut handles);
                    gdi = GetGuiResources(h, 0);
                    user = GetGuiResources(h, 1);
                    CloseHandle(h);
                }
            }
            rows.push(json!({ "pid": pid, "parent": ppid, "name": exe, "kind": kind, "sub": sub, "ws": ws, "private": private, "cpu_ms": cpu_ms, "handles": handles, "gdi": gdi, "user": user }));
        }
        rows.sort_by_key(|r| (r["pid"] != me, r["pid"].as_u64().unwrap_or(0)));
        json!({ "os": "windows", "self": me, "procs": rows, "note": "" })
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::*;

    pub fn stats() -> Value {
        let me = std::process::id();
        let out = std::process::Command::new("/bin/ps").args(["-axo", "pid=,ppid=,rss=,pcpu=,comm="]).output();
        let text = out.ok().map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default();
        let mut all: Vec<(u32, u32, u64, f64, String)> = Vec::new();
        for line in text.lines() {
            let mut it = line.split_whitespace();
            let (Some(p), Some(pp), Some(rss), Some(cpu)) = (it.next(), it.next(), it.next(), it.next()) else { continue };
            let name = it.collect::<Vec<_>>().join(" ");
            if let (Ok(p), Ok(pp), Ok(rss), Ok(cpu)) = (p.parse::<u32>(), pp.parse::<u32>(), rss.parse::<u64>(), cpu.parse::<f64>()) { all.push((p, pp, rss * 1024, cpu, name)); }
        }
        let mut mine = std::collections::HashSet::new();
        mine.insert(me);
        loop {
            let before = mine.len();
            for (p, pp, ..) in &all { if mine.contains(pp) { mine.insert(*p); } }
            if mine.len() == before { break; }
        }
        let mut rows: Vec<Value> = Vec::new();
        for (p, pp, ws, cpu, name) in &all {
            let ours = mine.contains(p);
            let webkit = name.contains("com.apple.WebKit");
            if !ours && !webkit { continue; }
            let short = name.rsplit('/').next().unwrap_or(name).to_string();
            rows.push(json!({ "pid": p, "parent": pp, "name": short, "kind": if *p == me { "main" } else if ours { "child" } else { "webkit" }, "sub": "", "ws": ws, "private": 0, "cpu_pct": cpu, "handles": 0, "gdi": 0, "user": 0 }));
        }
        rows.sort_by_key(|r| (r["pid"] != me, r["pid"].as_u64().unwrap_or(0)));
        json!({ "os": "macos", "self": me, "procs": rows, "note": "webkit" })
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod imp {
    use super::*;
    pub fn stats() -> Value { json!({ "os": "other", "self": std::process::id(), "procs": [], "note": "" }) }
}

pub fn stats() -> Value { imp::stats() }
