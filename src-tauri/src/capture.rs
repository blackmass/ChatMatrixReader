//! Sound capture for the voice recognition (Build B2). Windows only. The exe only moves sound; what is said in it is the engine's business.
//!
//!   capture_start(id, options)  listens to the sound of the chosen program and writes it, as 16 kHz mono PCM, to the standard input of the
//!                               running extension program `id` (ext_run). capture_stop(id) ends it.
//!
//! Three threads per capture:
//!   sessions  every `poll` seconds: which sound sessions belong to the chosen program, on which output device, how loud (capturelib::Router)
//!   worker    opens the sound source the router asks for and reads it:
//!               "process"  the program's own sound (process loopback) - tried first, nothing else is mixed in
//!               "device"   the output device the program plays on (loopback), passed through only while the program itself is audibly playing
//!                          (the gate): used when the single-program capture is refused (or when the options say so)
//!               "system"   the default output device, everything
//!             When a source breaks (the program ends, the device goes away) it waits and tries again; it never gives up by itself.
//!   writer    every 20 ms: what the worker delivered, kept on the wall clock (gaps filled with silence), to the engine's input
//!
//! Events to every window (`gen` = which capture it is from: a capture that was stopped and started again says "off" late, the page ignores that):
//!   `capture-state` { id, gen, mode, device, program, pid, gate, level, peak, status, reason }   (4 times a second; mode "off" once at the end)
//!   `capture-warn`  { id, gen, code: "no_audio" | "audio_back" | "dropped", msg, seconds? }
//! With `framed` the sound is written in frames ("CMRFA" + 8 hex digits for the length + the sound), as the engine's --framed expects (engine/stt/src/protocol.h):
//! the page can then send control messages into the same input (ext_stdin).
//! Nothing is written anywhere: the sound only goes through memory to the engine.
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender, TryRecvError};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Media::Audio::*;
use windows::Win32::System::Com::{CoCreateInstance, CoTaskMemFree, CLSCTX_ALL};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};
use windows::core::Interface;

use crate::audio::win::{activate, cmdline, com, device_name, err_of, process_table, wfx};
use crate::capturelib::*;
use crate::{ext, procrole};

const LOOPBACK: u32 = 0x0002_0000;
const EVENT: u32 = 0x0004_0000;

// ---- options ---------------------------------------------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq)]
enum Method { Auto, Process, Device }

#[derive(Clone)]
struct Options {
    spec: Option<Spec>,            // None = the whole system (default output device)
    method: Method,
    pcm: Pcm,
    gate_peak: f32,
    gate_hold: f64,
    poll: f64,
    lose_after: f64,
    no_audio: f64,
    framed: bool,                  // the engine reads frames (its --framed)
}

fn parse(o: &Value) -> Result<Options, String> {
    let t = &o["target"];
    let spec = match t["mode"].as_str().unwrap_or("") {
        "system" => None,
        "app" => {
            let names: Vec<String> = t["names"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect()).unwrap_or_default();
            if names.is_empty() { return Err("no program given".into()); }
            Some(Spec { names, role: t["role"].as_str().unwrap_or("").into(), sub: t["sub"].as_str().unwrap_or("").into(), skip_audio_service: t["skip_audio_service"].as_bool().unwrap_or(false) })
        }
        m => return Err(format!("unknown target mode '{m}'")),
    };
    let num = |k: &str, d: f64, lo: f64, hi: f64| o[k].as_f64().filter(|v| v.is_finite()).map(|v| v.clamp(lo, hi)).unwrap_or(d);
    Ok(Options {
        spec,
        method: match o["method"].as_str().unwrap_or("auto") { "process" => Method::Process, "device" => Method::Device, _ => Method::Auto },
        pcm: Pcm::parse(o["pcm"].as_str().unwrap_or("s16")),
        gate_peak: num("gate_peak", 0.002, 0.0, 0.5) as f32,
        gate_hold: num("gate_hold", 1.0, 0.0, 10.0),
        poll: num("poll", 0.25, 0.05, 5.0),
        lose_after: num("lose_after", 10.0, 1.0, 600.0),
        no_audio: num("no_audio", 8.0, 0.0, 600.0),
        framed: o["framed"].as_bool().unwrap_or(false),
    })
}

// ---- shared state ----------------------------------------------------------------------------------------------------------

#[derive(Default, Clone)]
struct Info { mode: &'static str, device: String, program: String, pid: u32, status: String, reason: String }

static GEN: AtomicU64 = AtomicU64::new(1);

struct Shared {
    gen: u64,
    stop: AtomicBool,
    want: Mutex<Want>,
    program_peak: AtomicU32,       // f32 bits: how loud the program is on the device we listen to (from the sessions)
    gate_open: AtomicBool,
    audible: AtomicBool,           // something other than silence was passed on since the writer looked
    level: AtomicU32,              // f32 bits: the loudest sample of the last chunk passed on
    info: Mutex<Info>,
}

fn caps() -> &'static Mutex<HashMap<String, Arc<Shared>>> {
    static M: OnceLock<Mutex<HashMap<String, Arc<Shared>>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

fn load(a: &AtomicU32) -> f32 { f32::from_bits(a.load(Ordering::Relaxed)) }
fn store(a: &AtomicU32, v: f32) { a.store(v.to_bits(), Ordering::Relaxed); }
fn secs(t0: &Instant) -> f64 { t0.elapsed().as_secs_f64() }
fn set_info(sh: &Shared, f: impl FnOnce(&mut Info)) { if let Ok(mut i) = sh.info.lock() { f(&mut i); } }

// ---- start / stop ----------------------------------------------------------------------------------------------------------

pub fn start(app: AppHandle, id: String, options: Value) -> Result<Value, String> {
    let opts = parse(&options)?;
    if !ext::is_running(&id) { return Err("the engine is not running".into()); }
    let gen = GEN.fetch_add(1, Ordering::Relaxed);
    let sh = Arc::new(Shared {
        gen, stop: AtomicBool::new(false), want: Mutex::new(Want::default()), program_peak: AtomicU32::new(0), gate_open: AtomicBool::new(false),
        audible: AtomicBool::new(false), level: AtomicU32::new(0), info: Mutex::new(Info { mode: "none", status: "waiting".into(), ..Default::default() }),
    });
    {
        let mut m = caps().lock().map_err(|e| e.to_string())?;
        if m.contains_key(&id) { return Err("already capturing".into()); }
        m.insert(id.clone(), sh.clone());
    }
    let (tx, rx) = channel::<Vec<f32>>();
    if opts.spec.is_some() {
        let (sh2, o2) = (sh.clone(), opts.clone());
        std::thread::Builder::new().name("cap-sessions".into()).spawn(move || sessions_loop(sh2, o2)).map_err(|e| e.to_string())?;
    }
    { let (sh2, o2) = (sh.clone(), opts.clone()); std::thread::Builder::new().name("cap-worker".into()).spawn(move || worker_loop(sh2, o2, tx)).map_err(|e| e.to_string())?; }
    { let (sh2, o2, id2) = (sh, opts, id); std::thread::Builder::new().name("cap-writer".into()).spawn(move || writer_loop(app, id2, sh2, o2, rx)).map_err(|e| e.to_string())?; }
    Ok(json!({ "ok": true, "gen": gen }))
}

pub fn stop(id: &str) {
    let sh = caps().lock().ok().and_then(|mut m| m.remove(id));
    if let Some(sh) = sh { sh.stop.store(true, Ordering::Relaxed); }
}

// ---- sessions thread -------------------------------------------------------------------------------------------------------

/// one reading of every sound session: (pid, output device, state, peak)
fn snapshot(en: &IMMDeviceEnumerator) -> Vec<(u32, String, i32, f32)> {
    let mut out = Vec::new();
    unsafe {
        let Ok(coll) = en.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE) else { return out };
        for i in 0..coll.GetCount().unwrap_or(0) {
            let Ok(dev) = coll.Item(i) else { continue };
            let name = device_name(&dev);
            let Ok(mgr) = dev.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else { continue };
            let Ok(list) = mgr.GetSessionEnumerator() else { continue };
            for k in 0..list.GetCount().unwrap_or(0) {
                let Ok(ctl) = list.GetSession(k) else { continue };
                let Ok(c2) = ctl.cast::<IAudioSessionControl2>() else { continue };
                let pid = c2.GetProcessId().unwrap_or(0);
                if pid == 0 { continue; }
                let state = ctl.GetState().map(|s| s.0).unwrap_or(-1);
                let peak = ctl.cast::<windows::Win32::Media::Audio::Endpoints::IAudioMeterInformation>().ok().and_then(|m| m.GetPeakValue().ok()).unwrap_or(0.0);
                out.push((pid, name.clone(), state, peak));
            }
        }
    }
    out
}

/// does this process, or one of its parents, carry the program's name? (Chromium based programs play their sound in a helper process)
fn belongs(spec: &Spec, table: &HashMap<u32, (u32, String)>, pid: u32) -> bool {
    let mut p = pid;
    for _ in 0..8 {
        let Some((parent, name)) = table.get(&p) else { return false };
        if spec.name_ok(name) { return true; }
        if *parent == 0 || *parent == p { return false; }
        p = *parent;
    }
    false
}

fn sessions_loop(sh: Arc<Shared>, o: Options) {
    com();
    let Some(spec) = o.spec.clone() else { return };
    let t0 = Instant::now();
    let mut router = Router::new(o.gate_peak, o.lose_after);
    let mut roles: HashMap<u32, (String, String)> = HashMap::new();
    let me = std::process::id();
    let en: Option<IMMDeviceEnumerator> = unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok() };
    let Some(en) = en else { set_info(&sh, |i| i.status = "error: no device enumerator".into()); return };
    while !sh.stop.load(Ordering::Relaxed) {
        let rows = snapshot(&en);
        let table = process_table();
        roles.retain(|pid, _| table.contains_key(pid));
        let mut sessions = Vec::new();
        for (pid, device, state, peak) in rows {
            if pid == me || state == 2 || !belongs(&spec, &table, pid) { continue; }
            let (kind, sub) = roles.entry(pid).or_insert_with(|| procrole::roles_of(&cmdline::of(pid))).clone();
            if !spec.role_ok(&kind, &sub) { continue; }
            sessions.push(Sess { pid, device, peak });
        }
        let want = router.step(secs(&t0), &sessions);
        store(&sh.program_peak, want.peak);
        let program = want.pid.and_then(|p| table.get(&p)).map(|t| t.1.clone()).unwrap_or_default();
        set_info(&sh, |i| { i.program = program; });
        if let Ok(mut w) = sh.want.lock() { *w = want; }
        std::thread::sleep(Duration::from_secs_f64(o.poll));
    }
}

// ---- the sound sources -----------------------------------------------------------------------------------------------------

struct Stream { client: IAudioClient, cap: IAudioCaptureClient, event: Option<HANDLE>, ch: usize, rate: u32, float: bool }

impl Stream {
    /// the sound of one program alone (process loopback). The one combination that was measured to work on Windows 10 19045:
    /// the program and its children, 16 bit 44.1 kHz stereo, LOOPBACK + EVENTCALLBACK, 20 ms buffer.
    fn process(pid: u32) -> Result<Stream, String> {
        unsafe {
            let client = activate(pid, 0)?;
            let fmt = wfx(1, 2, 44100, 16);
            client.Initialize(AUDCLNT_SHAREMODE_SHARED, LOOPBACK | EVENT, 200_000, 0, &fmt, None).map_err(|e| format!("initialize {}", err_of(&e)))?;
            let cap: IAudioCaptureClient = client.GetService().map_err(|e| err_of(&e))?;
            let ev = CreateEventW(None, false, false, None).map_err(|e| e.to_string())?;
            client.SetEventHandle(ev).map_err(|e| err_of(&e))?;
            client.Start().map_err(|e| err_of(&e))?;
            Ok(Stream { client, cap, event: Some(ev), ch: 2, rate: 44100, float: false })
        }
    }

    /// everything an output device plays (loopback), in the device's own format; None = the default output device
    fn device(name: Option<&str>) -> Result<(Stream, String), String> {
        unsafe {
            let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| format!("MMDeviceEnumerator: {e}"))?;
            let mut found: Option<IMMDevice> = None;
            if let Some(n) = name.filter(|n| !n.is_empty()) {
                if let Ok(coll) = en.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE) {
                    for i in 0..coll.GetCount().unwrap_or(0) { if let Ok(d) = coll.Item(i) { if device_name(&d) == n { found = Some(d); break; } } }
                }
            }
            let dev = match found { Some(d) => d, None => en.GetDefaultAudioEndpoint(eRender, eConsole).map_err(|e| format!("no output device: {}", err_of(&e)))? };
            let dname = device_name(&dev);
            let client: IAudioClient = dev.Activate(CLSCTX_ALL, None).map_err(|e| format!("activate {}", err_of(&e)))?;
            let pf = client.GetMixFormat().map_err(|e| format!("mixformat {}", err_of(&e)))?;
            let f = std::ptr::read_unaligned(pf);
            let (tag, ch, rate, bits) = (f.wFormatTag, f.nChannels as usize, f.nSamplesPerSec, f.wBitsPerSample);
            let float = bits == 32 && (tag == 3 || tag == 0xFFFE);
            if !(bits == 16 || float) { CoTaskMemFree(Some(pf as *const core::ffi::c_void)); return Err(format!("format not handled: tag {tag} bits {bits}")); }
            let init = client.Initialize(AUDCLNT_SHAREMODE_SHARED, LOOPBACK, 1_000_000, 0, pf, None);
            CoTaskMemFree(Some(pf as *const core::ffi::c_void));
            init.map_err(|e| format!("initialize {}", err_of(&e)))?;
            let cap: IAudioCaptureClient = client.GetService().map_err(|e| err_of(&e))?;
            client.Start().map_err(|e| err_of(&e))?;
            Ok((Stream { client, cap, event: None, ch, rate, float }, dname))
        }
    }

    /// waits a little for sound and returns what arrived, as mono float at the stream's own rate. Err = the source is gone.
    fn read(&mut self) -> Result<Vec<f32>, String> {
        unsafe {
            match self.event { Some(e) => { WaitForSingleObject(e, 40); } None => std::thread::sleep(Duration::from_millis(10)) }
            let mut out = Vec::new();
            loop {
                let n = self.cap.GetNextPacketSize().map_err(|e| err_of(&e))?;
                if n == 0 { break; }
                let mut data: *mut u8 = std::ptr::null_mut();
                let (mut frames, mut fl) = (0u32, 0u32);
                self.cap.GetBuffer(&mut data, &mut frames, &mut fl, None, None).map_err(|e| err_of(&e))?;
                let count = frames as usize * self.ch;
                if fl & 2 != 0 || data.is_null() { out.extend(std::iter::repeat(0.0f32).take(frames as usize)); }
                else if self.float { out.extend(mono_f32(std::slice::from_raw_parts(data as *const f32, count), self.ch)); }
                else { out.extend(mono_i16(std::slice::from_raw_parts(data as *const i16, count), self.ch)); }
                let _ = self.cap.ReleaseBuffer(frames);
                if out.len() > self.rate as usize * 5 { break; }       // (never hold more than 5 s in one go)
            }
            Ok(out)
        }
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        unsafe { let _ = self.client.Stop(); if let Some(e) = self.event { let _ = CloseHandle(e); } }
    }
}

// ---- worker thread ---------------------------------------------------------------------------------------------------------

#[derive(PartialEq, Clone)]
enum Key { None, System, App(String, u32) }

fn worker_loop(sh: Arc<Shared>, o: Options, tx: Sender<Vec<f32>>) {
    com();
    let t0 = Instant::now();
    let mut gate = Gate::new(o.gate_peak, o.gate_hold);
    let mut cur_key = Key::None;
    let mut stream: Option<(Stream, Resampler, &'static str)> = None;
    let mut retry_at = 0.0f64;
    while !sh.stop.load(Ordering::Relaxed) {
        let now = secs(&t0);
        let want = match &o.spec { None => Key::System, Some(_) => { let w = sh.want.lock().map(|w| w.clone()).unwrap_or_default(); match (w.device, w.pid) { (Some(d), Some(p)) => Key::App(d, p), _ => Key::None } } };
        if want != cur_key {
            stream = None;
            cur_key = want.clone();
            retry_at = 0.0;
            set_info(&sh, |i| { i.mode = "none"; i.device.clear(); i.pid = 0; i.reason.clear(); i.status = if want == Key::None { "waiting for the program to play sound".into() } else { "opening".into() }; });
        }
        if stream.is_none() && cur_key != Key::None && now >= retry_at {
            match open(&cur_key, &o) {
                Ok((s, mode, dev, reason)) => {
                    let r = Resampler::new(s.rate);
                    set_info(&sh, |i| { i.mode = mode; i.device = dev; i.pid = if let Key::App(_, p) = &cur_key { *p } else { 0 }; i.status = "listening".into(); i.reason = reason; });
                    stream = Some((s, r, mode));
                }
                Err(e) => { retry_at = now + 1.0; set_info(&sh, |i| { i.status = "retry".into(); i.reason = e; }); }
            }
        }
        let Some((s, r, mode)) = stream.as_mut() else { std::thread::sleep(Duration::from_millis(50)); continue };
        match s.read() {
            Ok(x) => {
                let mut y = r.process(&x);
                if y.is_empty() { continue; }
                // only the whole-device source needs the gate (the other sources hold nothing but the program's sound)
                let open = if *mode == "device" { gate.update(secs(&t0), if cur_key == Key::None { None } else { Some(load(&sh.program_peak)) }) } else { true };
                sh.gate_open.store(open, Ordering::Relaxed);
                if !open { for v in y.iter_mut() { *v = 0.0; } }
                let pk = peak_of(&y);
                store(&sh.level, pk);
                if pk > 0.0005 { sh.audible.store(true, Ordering::Relaxed); }
                if tx.send(y).is_err() { break; }
            }
            Err(e) => {
                // the source broke (the program ended, the device was unplugged ...): wait and try again
                stream = None;
                retry_at = secs(&t0) + 1.0;
                set_info(&sh, |i| { i.status = "retry".into(); i.reason = e; });
            }
        }
    }
}

/// Opens what the key asks for, as the method allows. -> (stream, mode, output device name, why the single-program capture was not used)
fn open(key: &Key, o: &Options) -> Result<(Stream, &'static str, String, String), String> {
    match key {
        Key::None => Err("nothing to listen to".into()),
        Key::System => Stream::device(None).map(|(s, d)| (s, "system", d, String::new())),
        Key::App(dev, pid) => {
            let mut why = String::new();
            if o.method != Method::Device {
                match Stream::process(*pid) {
                    Ok(s) => return Ok((s, "process", dev.clone(), String::new())),
                    Err(e) => { if o.method == Method::Process { return Err(e); } why = e; }
                }
            }
            Stream::device(Some(dev)).map(|(s, d)| (s, "device", d, why))
        }
    }
}

// ---- writer thread ---------------------------------------------------------------------------------------------------------

fn writer_loop(app: AppHandle, id: String, sh: Arc<Shared>, o: Options, rx: Receiver<Vec<f32>>) {
    let t0 = Instant::now();
    let mut pacer = Pacer::new(0.04);
    let mut watch = SilenceWatch::new(o.no_audio);
    let mut last_state = -1.0f64;
    let mut dropped_warned = false;
    let max_backlog = RATE as usize * 30;
    let mut end = "stopped";
    loop {
        std::thread::sleep(Duration::from_millis(20));
        if sh.stop.load(Ordering::Relaxed) { break; }
        let mut got: Vec<f32> = Vec::new();
        loop { match rx.try_recv() { Ok(mut v) => got.append(&mut v), Err(TryRecvError::Empty) => break, Err(TryRecvError::Disconnected) => break } }
        if got.len() > max_backlog {       // the engine does not read: keep the newest, say so once
            let cut = got.len() - max_backlog;
            got.drain(..cut);
            if !dropped_warned { dropped_warned = true; let _ = app.emit("capture-warn", json!({ "id": id, "gen": sh.gen, "code": "dropped", "msg": "the engine reads too slowly: old sound was dropped" })); }
        }
        let now = secs(&t0);
        let mut bytes = encode(&pacer.tick(now, got), o.pcm);
        if o.framed && !bytes.is_empty() { bytes = frame(&bytes); }
        if !bytes.is_empty() && ext::write_stdin(&id, &bytes, false).is_err() { end = "engine gone"; break; }
        match watch.tick(now, sh.audible.swap(false, Ordering::Relaxed)) {
            Silence::Warn => { let _ = app.emit("capture-warn", json!({ "id": id, "gen": sh.gen, "code": "no_audio", "seconds": o.no_audio as u64,
                "msg": format!("no sound from the program for {:.0} s - is it running, and is something being played / said?", o.no_audio) })); }
            Silence::Back => { let _ = app.emit("capture-warn", json!({ "id": id, "gen": sh.gen, "code": "audio_back", "msg": "sound is back" })); }
            Silence::None => {}
        }
        if now - last_state >= 0.25 {
            last_state = now;
            let i = sh.info.lock().map(|i| i.clone()).unwrap_or_default();
            let _ = app.emit("capture-state", json!({ "id": id, "gen": sh.gen, "mode": i.mode, "device": i.device, "program": i.program, "pid": i.pid, "status": i.status, "reason": i.reason,
                "gate": sh.gate_open.load(Ordering::Relaxed), "level": (load(&sh.level) * 1000.0).round() / 1000.0, "peak": (load(&sh.program_peak) * 1000.0).round() / 1000.0 }));
        }
    }
    sh.stop.store(true, Ordering::Relaxed);
    if let Ok(mut m) = caps().lock() { if m.get(&id).map(|s| Arc::ptr_eq(s, &sh)).unwrap_or(false) { m.remove(&id); } }
    let _ = app.emit("capture-state", json!({ "id": id, "gen": sh.gen, "mode": "off", "device": "", "program": "", "pid": 0, "status": end, "reason": "", "gate": false, "level": 0, "peak": 0 }));
}
