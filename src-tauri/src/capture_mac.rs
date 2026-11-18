//! Sound capture for the voice recognition on macOS (13 or later): ScreenCaptureKit, audio only. The same two commands as capture.rs (Windows):
//!
//!   capture_start(id, options)  listens to the sound of the chosen program (or of the whole Mac) and writes it, as 16 kHz mono PCM, to the standard
//!                               input of the running extension program `id` (ext_run). capture_stop(id) ends it.
//!
//! How: one SCStream with audio on and a tiny picture (2 x 2 pixels, one a second: ScreenCaptureKit wants a picture to go with the sound, and nothing
//! reads it). "The program alone" = a content filter that includes only the applications whose name (or bundle id) matches; "the whole Mac" = every
//! application (this program's own sound is left out). ScreenCaptureKit is asked for its own default format (48 kHz, two channels, like OBS) and the sound is changed to 16 kHz mono here
//! (asking the system for 16 kHz mono gave no voice chat of Discord).
//! The permission is the one the screen reading already needs: Screen Recording (System Settings -> Privacy & Security). Without it the capture
//! says so in `reason` and tries again every second.
//!
//! Method: "auto" = the program alone; when that cannot be started, the whole Mac (the page shows which one is used); "process" = the program alone only;
//! "device" is the whole Mac (there is no "output device" to pick on a Mac, so no gate either).
//!
//! The events are the ones of capture.rs: `capture-state` { id, gen, mode: "process" | "system" | "none" | "off", device, program, pid, gate, level, peak, status,
//! reason } 4 times a second, and `capture-warn` { id, gen, code: "no_audio" | "audio_back" | "dropped", msg }. Nothing is written anywhere.
use std::collections::HashMap;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender, TryRecvError};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{define_class, msg_send, AnyThread, DefinedClass};
use objc2_core_audio_types::{AudioBufferList, AudioStreamBasicDescription};
use objc2_core_foundation::CFRetained;
use objc2_core_media::{CMAudioFormatDescriptionGetStreamBasicDescription, CMBlockBuffer, CMSampleBuffer, CMTime, CMTimeFlags};
use objc2_foundation::{NSArray, NSError};
use objc2_screen_capture_kit::{
    SCContentFilter, SCDisplay, SCRunningApplication, SCShareableContent, SCStream, SCStreamConfiguration, SCStreamDelegate, SCStreamOutput,
    SCStreamOutputType, SCWindow,
};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::capturelib::*;
use crate::ext;

// ---- options ---------------------------------------------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq)]
enum Method { Auto, Process, System }

#[derive(Clone)]
struct Options {
    names: Option<Vec<String>>,    // None = the whole Mac
    method: Method,
    pcm: Pcm,
    no_audio: f64,
    framed: bool,
}

fn parse(o: &Value) -> Result<Options, String> {
    let t = &o["target"];
    let names = match t["mode"].as_str().unwrap_or("") {
        "system" => None,
        "app" => {
            let n: Vec<String> = t["names"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(|s| s.to_ascii_lowercase())).collect()).unwrap_or_default();
            if n.is_empty() { return Err("no program given".into()); }
            Some(n)
        }
        m => return Err(format!("unknown target mode '{m}'")),
    };
    let no_audio = o["no_audio"].as_f64().filter(|v| v.is_finite()).map(|v| v.clamp(0.0, 600.0)).unwrap_or(8.0);
    Ok(Options {
        names,
        method: match o["method"].as_str().unwrap_or("auto") { "process" => Method::Process, "device" => Method::System, _ => Method::Auto },
        pcm: Pcm::parse(o["pcm"].as_str().unwrap_or("s16")),
        no_audio,
        framed: o["framed"].as_bool().unwrap_or(false),
    })
}

/// "world of warcraft*" matches by the beginning, anything else must be the whole name; the name of the program and its bundle id are both tried
fn name_ok(names: &[String], app_name: &str, bundle: &str) -> bool {
    let (a, b) = (app_name.to_ascii_lowercase(), bundle.to_ascii_lowercase());
    let a = a.strip_suffix(".app").unwrap_or(&a).to_string();
    names.iter().any(|n| {
        let n = n.strip_suffix(".app").unwrap_or(n);
        match n.strip_suffix('*') { Some(p) => a.starts_with(p) || b.starts_with(p), None => a == n || b == n }
    })
}

// ---- shared state ----------------------------------------------------------------------------------------------------------

#[derive(Default, Clone)]
struct Info { mode: &'static str, device: String, program: String, pid: u32, status: String, reason: String }

static GEN: AtomicU64 = AtomicU64::new(1);

struct Shared {
    gen: u64,
    stop: AtomicBool,
    audible: AtomicBool,           // something other than silence arrived since the writer looked
    level: AtomicU32,              // f32 bits: the loudest sample of the last piece
    pieces: AtomicU64,             // how many pieces of sound ScreenCaptureKit has delivered (for the line the options show: is anything arriving?)
    screens: AtomicU64,            // how many pictures (they are thrown away; it shows that the stream itself is alive)
    rate: AtomicU32,               // the rate of the last piece, as ScreenCaptureKit gave it
    nbuf: AtomicU32,               // how many buffers (channels, when planar) the last piece had
    info: Mutex<Info>,
}

fn caps() -> &'static Mutex<HashMap<String, Arc<Shared>>> {
    static M: OnceLock<Mutex<HashMap<String, Arc<Shared>>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}
fn load(a: &AtomicU32) -> f32 { f32::from_bits(a.load(Ordering::Relaxed)) }
fn set_info(sh: &Shared, f: impl FnOnce(&mut Info)) { if let Ok(mut i) = sh.info.lock() { f(&mut i); } }

/// what ScreenCaptureKit objects need to cross to another thread in a channel (they are used again only on the thread that made the stream)
struct Sx<T>(T);
unsafe impl<T> Send for Sx<T> {}

// ---- start / stop ----------------------------------------------------------------------------------------------------------

pub fn start(app: AppHandle, id: String, options: Value) -> Result<Value, String> {
    let opts = parse(&options)?;
    if !ext::is_running(&id) { return Err("the engine is not running".into()); }
    let gen = GEN.fetch_add(1, Ordering::Relaxed);
    let sh = Arc::new(Shared { gen, stop: AtomicBool::new(false), audible: AtomicBool::new(false), level: AtomicU32::new(0),
        pieces: AtomicU64::new(0), screens: AtomicU64::new(0), rate: AtomicU32::new(0), nbuf: AtomicU32::new(0),
        info: Mutex::new(Info { mode: "none", status: "waiting".into(), ..Default::default() }) });
    {
        let mut m = caps().lock().map_err(|e| e.to_string())?;
        if m.contains_key(&id) { return Err("already capturing".into()); }
        m.insert(id.clone(), sh.clone());
    }
    let (tx, rx) = channel::<Vec<f32>>();
    { let (sh2, o2) = (sh.clone(), opts.clone()); std::thread::Builder::new().name("cap-worker".into()).spawn(move || worker_loop(sh2, o2, tx)).map_err(|e| e.to_string())?; }
    { let (sh2, o2, id2) = (sh, opts, id); std::thread::Builder::new().name("cap-writer".into()).spawn(move || writer_loop(app, id2, sh2, o2, rx)).map_err(|e| e.to_string())?; }
    Ok(json!({ "ok": true, "gen": gen }))
}

pub fn stop(id: &str) {
    let sh = caps().lock().ok().and_then(|mut m| m.remove(id));
    if let Some(sh) = sh { sh.stop.store(true, Ordering::Relaxed); }
}

// ---- what ScreenCaptureKit shows ---------------------------------------------------------------------------------------------

struct Content { displays: Vec<Retained<SCDisplay>>, apps: Vec<Retained<SCRunningApplication>> }

fn error_text(e: *mut NSError) -> String {
    if e.is_null() { return "unknown error".into(); }
    let e = unsafe { &*e };
    format!("{} (code {})", e.localizedDescription(), e.code())
}

/// -3801 = the user (or a missing permission) said no to the screen recording
fn is_permission(text: &str) -> bool { text.contains("-3801") || text.to_ascii_lowercase().contains("declined") }

fn shareable() -> Result<Content, String> {
    let (tx, rx) = channel::<Result<Sx<Content>, String>>();
    let block = RcBlock::new(move |c: *mut SCShareableContent, e: *mut NSError| {
        let r = match unsafe { Retained::retain(c) } {
            Some(c) => unsafe { Ok(Sx(Content { displays: c.displays().to_vec(), apps: c.applications().to_vec() })) },
            None => Err(error_text(e)),
        };
        let _ = tx.send(r);
    });
    unsafe { SCShareableContent::getShareableContentWithCompletionHandler(&block) };
    match rx.recv_timeout(Duration::from_secs(10)) {
        Ok(Ok(c)) => Ok(c.0),
        Ok(Err(e)) => Err(if is_permission(&e) { "screen recording permission is needed (System Settings -> Privacy & Security -> Screen Recording)".to_string() } else { e }),
        Err(_) => Err("ScreenCaptureKit did not answer".into()),
    }
}

/// every program that can be picked (the list of the options): the programs ScreenCaptureKit lists, without this one. The sound they make
/// cannot be told beforehand (macOS has no sound sessions to read), so every row is "playing" and the loudness is 0.
pub fn list_apps() -> Result<Value, String> {
    let c = shareable()?;
    let me = std::process::id() as i64;
    let mut rows: Vec<Value> = Vec::new();
    for a in &c.apps {
        let (pid, name) = unsafe { (a.processID() as i64, a.applicationName().to_string()) };
        if pid == me || name.trim().is_empty() { continue; }
        rows.push(json!({ "pid": pid, "ppid": 0, "exe": name, "role": "", "sub": "", "cmd_known": false, "device": "", "default": true, "system": false,
            "state": 1, "active": false, "peak": 0.0, "bundle": unsafe { a.bundleIdentifier().to_string() } }));
    }
    Ok(Value::Array(rows))
}

// ---- the stream ------------------------------------------------------------------------------------------------------------

struct Ivars {
    tx: Mutex<Sender<Vec<f32>>>,
    resampler: Mutex<Option<(u32, Resampler)>>,
    level: Arc<Shared>,
    dead: Arc<Mutex<String>>,      // the stream ended by itself (the program quit, the permission was taken away ...): why
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "CMRAudioOutput"]
    #[ivars = Ivars]
    struct AudioOutput;

    unsafe impl NSObjectProtocol for AudioOutput {}

    unsafe impl SCStreamOutput for AudioOutput {
        #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
        unsafe fn did_output(&self, _stream: &SCStream, sample: &CMSampleBuffer, kind: SCStreamOutputType) {
            let iv = self.ivars();
            if kind != SCStreamOutputType::Audio { iv.level.screens.fetch_add(1, Ordering::Relaxed); return; }   // (the pictures are only counted)
            let Some((mut x, rate, nbuf)) = pull(sample) else { return };
            iv.level.pieces.fetch_add(1, Ordering::Relaxed);
            iv.level.rate.store(rate.round() as u32, Ordering::Relaxed);
            iv.level.nbuf.store(nbuf as u32, Ordering::Relaxed);
            if (rate - 16000.0).abs() > 1.0 {
                if let Ok(mut r) = iv.resampler.lock() {
                    let want = rate.round() as u32;
                    if r.as_ref().map(|(k, _)| *k != want).unwrap_or(true) { *r = Some((want, Resampler::new(want))); }
                    if let Some((_, rs)) = r.as_mut() { x = rs.process(&x); }
                }
            }
            if x.is_empty() { return; }
            let pk = peak_of(&x);
            iv.level.level.store(pk.to_bits(), Ordering::Relaxed);
            if pk > 0.0005 { iv.level.audible.store(true, Ordering::Relaxed); }
            if let Ok(tx) = iv.tx.lock() { let _ = tx.send(x); }
        }
    }

    unsafe impl SCStreamDelegate for AudioOutput {
        #[unsafe(method(stream:didStopWithError:))]
        unsafe fn did_stop(&self, _stream: &SCStream, error: &NSError) {
            if let Ok(mut d) = self.ivars().dead.lock() { *d = format!("{} (code {})", error.localizedDescription(), error.code()); }
        }
    }
);

impl AudioOutput {
    fn new(iv: Ivars) -> Retained<Self> {
        let this = Self::alloc().set_ivars(iv);
        unsafe { msg_send![super(this), init] }
    }
}

/// the sound of one piece as mono float and its rate. ScreenCaptureKit answers with 32 bit float, one buffer per channel (we ask for one channel).
unsafe fn pull(sample: &CMSampleBuffer) -> Option<(Vec<f32>, f64, usize)> {
    let mut need: usize = 0;
    // the first call only says how big the list is (it answers "too small" on purpose)
    let _ = sample.audio_buffer_list_with_retained_block_buffer(&mut need, std::ptr::null_mut(), 0, None, None, 0, std::ptr::null_mut());
    if need == 0 { return None; }
    let mut mem = vec![0u64; need.div_ceil(8)];          // (u64: the list wants 8 byte alignment)
    let list = mem.as_mut_ptr() as *mut AudioBufferList;
    let mut block: *mut CMBlockBuffer = std::ptr::null_mut();
    let st = sample.audio_buffer_list_with_retained_block_buffer(std::ptr::null_mut(), list, need, None, None, 0, &mut block);
    let _hold = NonNull::new(block).map(|p| CFRetained::from_raw(p));      // (released when this function ends: the sound is copied before)
    if st != 0 { return None; }
    let (rate, float, bits) = match sample.format_description() {
        Some(fd) => {
            let p = CMAudioFormatDescriptionGetStreamBasicDescription(&fd);
            if p.is_null() { (16000.0, true, 32) } else { let d: AudioStreamBasicDescription = *p; (d.mSampleRate, d.mFormatFlags & 1 != 0, d.mBitsPerChannel) }
        }
        None => (16000.0, true, 32),
    };
    let n = (*list).mNumberBuffers as usize;
    let bufs = std::slice::from_raw_parts((*list).mBuffers.as_ptr(), n);
    let mut chans: Vec<Vec<f32>> = Vec::new();
    for b in bufs {
        if b.mData.is_null() || b.mDataByteSize == 0 { continue; }
        let ch = (b.mNumberChannels as usize).max(1);
        let m = if float && bits == 32 {
            mono_f32(std::slice::from_raw_parts(b.mData as *const f32, b.mDataByteSize as usize / 4), ch)
        } else if bits == 16 {
            mono_i16(std::slice::from_raw_parts(b.mData as *const i16, b.mDataByteSize as usize / 2), ch)
        } else { return None };
        chans.push(m);
    }
    let len = chans.iter().map(|c| c.len()).min()?;
    if len == 0 { return None; }
    // one buffer per channel: the mean of them is the mono sound
    let k = chans.len() as f32;
    Some(((0..len).map(|i| chans.iter().map(|c| c[i]).sum::<f32>() / k).collect(), rate, n))
}

/// a running stream (it lives on the worker thread only) with what keeps it going
struct Running { stream: Retained<SCStream>, _out: Retained<AudioOutput>, dead: Arc<Mutex<String>> }

impl Running {
    fn stop(self) {
        let (tx, rx) = channel::<()>();
        let block = RcBlock::new(move |_e: *mut NSError| { let _ = tx.send(()); });
        unsafe { self.stream.stopCaptureWithCompletionHandler(Some(&block)) };
        let _ = rx.recv_timeout(Duration::from_secs(3));
    }
}

fn open(content: &Content, apps: Option<&[Retained<SCRunningApplication>]>, sh: &Arc<Shared>, tx: &Sender<Vec<f32>>) -> Result<Running, String> {
    let display = content.displays.first().ok_or("no display found")?;
    let none_w: Retained<NSArray<SCWindow>> = NSArray::new();
    let filter = unsafe {
        match apps {
            Some(list) => {
                let arr = NSArray::from_retained_slice(list);
                SCContentFilter::initWithDisplay_includingApplications_exceptingWindows(SCContentFilter::alloc(), display, &arr, &none_w)
            }
            None => SCContentFilter::initWithDisplay_excludingWindows(SCContentFilter::alloc(), display, &none_w),
        }
    };
    let cfg = unsafe { SCStreamConfiguration::new() };
    unsafe {
        cfg.setCapturesAudio(true);
        cfg.setExcludesCurrentProcessAudio(true);
        // as OBS does it: the rate ScreenCaptureKit chooses itself (48 kHz) and two channels; the change to 16 kHz mono is made here, not by the system
        cfg.setChannelCount(2);
        cfg.setQueueDepth(8);
        cfg.setWidth(2);
        cfg.setHeight(2);
        cfg.setShowsCursor(false);
        cfg.setMinimumFrameInterval(CMTime { value: 1, timescale: 1, flags: CMTimeFlags::Valid, epoch: 0 });
    }
    let dead = Arc::new(Mutex::new(String::new()));
    let out = AudioOutput::new(Ivars { tx: Mutex::new(tx.clone()), resampler: Mutex::new(None), level: sh.clone(), dead: dead.clone() });
        let stream = unsafe { SCStream::initWithFilter_configuration_delegate(SCStream::alloc(), &filter, &cfg, Some(ProtocolObject::from_ref(&*out))) };
    // (a picture output as well, as OBS does: without one ScreenCaptureKit complains about every picture; they are dropped in did_output)
    for kind in [SCStreamOutputType::Screen, SCStreamOutputType::Audio] {
        unsafe { stream.addStreamOutput_type_sampleHandlerQueue_error(ProtocolObject::from_ref(&*out), kind, None) }
            .map_err(|e| format!("addStreamOutput: {} (code {})", e.localizedDescription(), e.code()))?;
    }
    let (stx, srx) = channel::<String>();
    let block = RcBlock::new(move |e: *mut NSError| { let _ = stx.send(if e.is_null() { String::new() } else { error_text(e) }); });
    unsafe { stream.startCaptureWithCompletionHandler(Some(&block)) };
    match srx.recv_timeout(Duration::from_secs(10)) {
        Ok(s) if s.is_empty() => Ok(Running { stream, _out: out, dead }),
        Ok(s) => Err(s),
        Err(_) => Err("the capture did not start in 10 s".into()),
    }
}

// ---- worker thread -----------------------------------------------------------------------------------------------------------

/// what is wanted now: nothing yet (the program is not running), the whole Mac, or these programs
#[derive(PartialEq, Clone)]
enum Want { Nothing, System, Apps(Vec<i32>) }

fn worker_loop(sh: Arc<Shared>, o: Options, tx: Sender<Vec<f32>>) {
    let t0 = Instant::now();
    let mut running: Option<(Running, Want)> = None;
    let mut next_look = 0.0f64;
    while !sh.stop.load(Ordering::Relaxed) {
        let now = t0.elapsed().as_secs_f64();
        // a stream that ended by itself: forget it, the next look opens a new one
        if let Some((r, _)) = &running {
            let why = r.dead.lock().map(|d| d.clone()).unwrap_or_default();
            if !why.is_empty() {
                if let Some((r, _)) = running.take() { r.stop(); }
                set_info(&sh, |i| { i.mode = "none"; i.status = "retry".into(); i.reason = why; });
                next_look = now + 1.0;
            }
        }
        if now >= next_look {
            match shareable() {
                Err(e) => {
                    if let Some((r, _)) = running.take() { r.stop(); }
                    set_info(&sh, |i| { i.mode = "none"; i.device.clear(); i.program.clear(); i.pid = 0; i.status = "retry".into(); i.reason = e; });
                    next_look = now + 2.0;
                }
                Ok(content) => {
                    let (want, apps) = decide(&content, &o);
                    let same = running.as_ref().map(|(_, w)| *w == want).unwrap_or(false);
                    if !same {
                        if let Some((r, _)) = running.take() { r.stop(); }
                        running = begin(&sh, &o, &content, &want, apps, &tx);
                    }
                    next_look = now + if running.is_some() { 2.0 } else { 1.0 };
                }
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    if let Some((r, _)) = running.take() { r.stop(); }
}

/// the programs that match the names (or the whole Mac)
fn decide(content: &Content, o: &Options) -> (Want, Vec<Retained<SCRunningApplication>>) {
    let Some(names) = &o.names else { return (Want::System, Vec::new()) };
    if o.method == Method::System { return (Want::System, Vec::new()); }
    let me = std::process::id() as i32;
    let mut hit: Vec<(i32, Retained<SCRunningApplication>)> = Vec::new();
    for a in &content.apps {
        let (pid, name, bundle) = unsafe { (a.processID(), a.applicationName().to_string(), a.bundleIdentifier().to_string()) };
        if pid != me && name_ok(names, &name, &bundle) { hit.push((pid, a.clone())); }
    }
    if hit.is_empty() { return (Want::Nothing, Vec::new()); }
    hit.sort_by_key(|h| h.0);
    (Want::Apps(hit.iter().map(|h| h.0).collect()), hit.into_iter().map(|h| h.1).collect())
}

fn begin(sh: &Arc<Shared>, o: &Options, content: &Content, want: &Want, apps: Vec<Retained<SCRunningApplication>>, tx: &Sender<Vec<f32>>) -> Option<(Running, Want)> {
    match want {
        Want::Nothing => {
            set_info(sh, |i| { i.mode = "none"; i.device.clear(); i.program.clear(); i.pid = 0; i.reason.clear(); i.status = "waiting for the program to run".into(); });
            None
        }
        Want::System => match open(content, None, sh, tx) {
            Ok(r) => {
                set_info(sh, |i| { i.mode = "system"; i.device = "ScreenCaptureKit".into(); i.program.clear(); i.pid = 0; i.status = "listening".into(); i.reason.clear(); });
                Some((r, want.clone()))
            }
            Err(e) => { set_info(sh, |i| { i.mode = "none"; i.status = "retry".into(); i.reason = e; }); None }
        },
        Want::Apps(pids) => {
            let first = unsafe { apps[0].applicationName().to_string() };
            match open(content, Some(&apps), sh, tx) {
                Ok(r) => {
                    set_info(sh, |i| { i.mode = "process"; i.device = "ScreenCaptureKit".into(); i.program = first; i.pid = pids[0] as u32; i.status = "listening".into(); i.reason.clear(); });
                    Some((r, want.clone()))
                }
                Err(e) if o.method == Method::Auto => {
                    // the program alone cannot be had: the whole Mac, and the page is told why (it says "the whole system" then)
                    match open(content, None, sh, tx) {
                        Ok(r) => {
                            set_info(sh, |i| { i.mode = "system"; i.device = "ScreenCaptureKit".into(); i.program = first; i.pid = 0; i.status = "listening".into(); i.reason = e; });
                            Some((r, want.clone()))
                        }
                        Err(e2) => { set_info(sh, |i| { i.mode = "none"; i.status = "retry".into(); i.reason = e2; }); None }
                    }
                }
                Err(e) => { set_info(sh, |i| { i.mode = "none"; i.status = "retry".into(); i.reason = e; }); None }
            }
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
        let now = t0.elapsed().as_secs_f64();
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
            // what arrives from ScreenCaptureKit, for the line of the options: pieces of sound (rate, buffers), the loudest sample of the last one, pictures
            let diag = format!("{} pieces, {} Hz x{}, last peak {:.4}, {} pictures", sh.pieces.load(Ordering::Relaxed), sh.rate.load(Ordering::Relaxed), sh.nbuf.load(Ordering::Relaxed),
                load(&sh.level), sh.screens.load(Ordering::Relaxed));
            let _ = app.emit("capture-state", json!({ "id": id, "gen": sh.gen, "mode": i.mode, "device": i.device, "program": i.program, "pid": i.pid, "status": i.status, "reason": i.reason, "diag": diag,
                "gate": true, "level": (load(&sh.level) * 1000.0).round() / 1000.0, "peak": 0 }));
        }
    }
    sh.stop.store(true, Ordering::Relaxed);
    if let Ok(mut m) = caps().lock() { if m.get(&id).map(|s| Arc::ptr_eq(s, &sh)).unwrap_or(false) { m.remove(&id); } }
    let _ = app.emit("capture-state", json!({ "id": id, "gen": sh.gen, "mode": "off", "device": "", "program": "", "pid": 0, "status": end, "reason": "", "gate": false, "level": 0, "peak": 0 }));
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn names() {
        let n = vec!["world of warcraft*".to_string(), "com.blizzard.worldofwarcraft*".to_string()];
        assert!(name_ok(&n, "World of Warcraft", "com.blizzard.worldofwarcraft"));
        assert!(name_ok(&n, "World of Warcraft Classic", ""));
        assert!(!name_ok(&n, "Discord", "com.hnc.Discord"));
        let d = vec!["discord".to_string()];
        assert!(name_ok(&d, "Discord", "com.hnc.Discord") && !name_ok(&d, "Discord Helper", ""));
        assert!(name_ok(&d, "Discord.app", ""));
    }
}
