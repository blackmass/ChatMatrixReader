//! Sound diagnostics (Build A of the voice extension). Windows only, written against the `windows` crate 0.61.
//!
//!  * `list_sessions()`  every program that has an audio session right now: pid, program, role (main / renderer / utility+AudioService),
//!                       parent pid, output device, state, peak level (max over ~0.2 s).
//!  * `probe(pid, secs)` tries "process loopback" (capture only that program's sound, no Windows build check, just try it) and reports
//!                       what came out. Optionally writes a short WAV into `extensions/stt/tmp/` next to the exe.
//!
//! Nothing here leaves the program folder. The rest of the capture work (gate, resample, pipe to the engine) comes in Build B.

use serde_json::Value;

#[cfg(target_os = "macos")]
pub fn list_sessions() -> Result<Value, String> { crate::capture::list_apps() }      // (macOS: the programs ScreenCaptureKit lists; no sound sessions to read)
#[cfg(not(any(windows, target_os = "macos")))]
pub fn list_sessions() -> Result<Value, String> { Err("Windows only".into()) }
#[cfg(not(windows))]
pub fn probe(_pid: u32, _secs: f64, _save: bool, _full: bool, _device: &str) -> Result<Value, String> { Err("Windows only".into()) }
#[cfg(not(windows))]
pub fn probe_device(_name: &str, _secs: f64, _save: bool) -> Result<Value, String> { Err("Windows only".into()) }

#[cfg(windows)]
pub fn list_sessions() -> Result<Value, String> { win::list_sessions().map(Value::Array) }
#[cfg(windows)]
pub fn probe_device(name: &str, secs: f64, save: bool) -> Result<Value, String> { win::probe_device(name, secs.clamp(0.5, 15.0), save) }
#[cfg(windows)]
pub fn probe(pid: u32, secs: f64, save: bool, full: bool, device: &str) -> Result<Value, String> { win::probe(pid, secs.clamp(0.5, 15.0), save, full, device) }

#[cfg(windows)]
pub(crate) mod win {
    use std::collections::HashMap;
    use std::sync::mpsc;
    use std::sync::Mutex;
    use std::time::{Duration, Instant};

    use serde_json::{json, Value};
    use windows::core::{implement, Interface, PCWSTR};
    use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Media::Audio::Endpoints::IAudioMeterInformation;
    use windows::Win32::Media::Audio::*;
    use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED, STGM_READ};
    use windows::Win32::System::Diagnostics::ToolHelp::*;
    use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};

    pub(crate) fn com() { unsafe { let _ = CoInitializeEx(None, COINIT_MULTITHREADED); } }

    fn pv_string(pv: &PROPVARIANT) -> String {
        // PROPVARIANT, string case: vt (u16) at 0 == VT_LPWSTR (31), the pointer at 8
        #[repr(C)] struct Raw { vt: u16, _r: [u16; 3], p: *const u16 }
        unsafe {
            let raw = &*(pv as *const PROPVARIANT as *const Raw);
            if raw.vt == 31 && !raw.p.is_null() { PCWSTR(raw.p).to_string().unwrap_or_default() } else { String::new() }
        }
    }

    pub(crate) fn device_name(dev: &IMMDevice) -> String {
        unsafe {
            let Ok(store) = dev.OpenPropertyStore(STGM_READ) else { return String::new() };
            match store.GetValue(&PKEY_Device_FriendlyName) { Ok(pv) => pv_string(&pv), Err(_) => String::new() }
        }
    }

    pub(crate) fn device_id(dev: &IMMDevice) -> String {
        unsafe {
            match dev.GetId() {
                Ok(p) => { let s = p.to_string().unwrap_or_default(); CoTaskMemFree(Some(p.0 as *const core::ffi::c_void)); s }
                Err(_) => String::new(),
            }
        }
    }

    /// pid -> (parent pid, exe file name) for every process
    pub(crate) fn process_table() -> HashMap<u32, (u32, String)> {
        let mut map = HashMap::new();
        unsafe {
            let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return map };
            let mut e = PROCESSENTRY32W::default();
            e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            if Process32FirstW(snap, &mut e).is_ok() {
                loop {
                    let n = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
                    map.insert(e.th32ProcessID, (e.th32ParentProcessID, String::from_utf16_lossy(&e.szExeFile[..n])));
                    if Process32NextW(snap, &mut e).is_err() { break; }
                }
            }
            let _ = CloseHandle(snap);
        }
        map
    }

    /// Command line of another process (64 bit PEB layout). "" when it cannot be read.
    pub(crate) mod cmdline {
        #[link(name = "kernel32")]
        extern "system" {
            fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
            fn CloseHandle(h: isize) -> i32;
            fn ReadProcessMemory(h: isize, base: usize, buf: *mut u8, size: usize, read: *mut usize) -> i32;
        }
        #[link(name = "ntdll")]
        extern "system" {
            fn NtQueryInformationProcess(h: isize, class: u32, info: *mut u8, len: u32, ret: *mut u32) -> i32;
        }
        #[repr(C)]
        struct Pbi { exit: isize, peb: usize, affinity: usize, prio: isize, pid: usize, ppid: usize }

        unsafe fn read(h: isize, addr: usize, buf: &mut [u8]) -> bool {
            let mut got = 0usize;
            ReadProcessMemory(h, addr, buf.as_mut_ptr(), buf.len(), &mut got) != 0 && got == buf.len()
        }

        #[cfg(target_pointer_width = "64")]
        pub fn of(pid: u32) -> String {
            unsafe {
                let h = OpenProcess(0x1000 | 0x0010, 0, pid); // QUERY_LIMITED_INFORMATION | VM_READ
                if h == 0 { return String::new(); }
                let mut out = String::new();
                let mut pbi = Pbi { exit: 0, peb: 0, affinity: 0, prio: 0, pid: 0, ppid: 0 };
                let mut ret = 0u32;
                if NtQueryInformationProcess(h, 0, &mut pbi as *mut Pbi as *mut u8, std::mem::size_of::<Pbi>() as u32, &mut ret) >= 0 && pbi.peb != 0 {
                    let mut b8 = [0u8; 8];
                    if read(h, pbi.peb + 0x20, &mut b8) {                      // PEB.ProcessParameters
                        let params = usize::from_le_bytes(b8);
                        let mut us = [0u8; 16];                                // RTL_USER_PROCESS_PARAMETERS.CommandLine (UNICODE_STRING)
                        if params != 0 && read(h, params + 0x70, &mut us) {
                            let len = (u16::from_le_bytes([us[0], us[1]]) as usize).min(16384) & !1;
                            let buf = usize::from_le_bytes([us[8], us[9], us[10], us[11], us[12], us[13], us[14], us[15]]);
                            if len > 0 && buf != 0 {
                                let mut bytes = vec![0u8; len];
                                if read(h, buf, &mut bytes) {
                                    let w: Vec<u16> = bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
                                    out = String::from_utf16_lossy(&w);
                                }
                            }
                        }
                    }
                }
                CloseHandle(h);
                out
            }
        }
        #[cfg(not(target_pointer_width = "64"))]
        pub fn of(_pid: u32) -> String { String::new() }
    }

    struct Row { pid: u32, device: String, is_default: bool, system: bool, state: i32, peak: f32, meter: Option<IAudioMeterInformation> }

    pub fn list_sessions() -> Result<Vec<Value>, String> {
        com();
        let mut rows: Vec<Row> = Vec::new();
        unsafe {
            let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| format!("MMDeviceEnumerator: {e}"))?;
            let default_id = en.GetDefaultAudioEndpoint(eRender, eConsole).map(|d| device_id(&d)).unwrap_or_default();
            let coll = en.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE).map_err(|e| format!("EnumAudioEndpoints: {e}"))?;
            let n = coll.GetCount().map_err(|e| e.to_string())?;
            for i in 0..n {
                let Ok(dev) = coll.Item(i) else { continue };
                let name = device_name(&dev);
                let is_default = !default_id.is_empty() && device_id(&dev) == default_id;
                let Ok(mgr) = dev.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else { continue };
                let Ok(list) = mgr.GetSessionEnumerator() else { continue };
                let Ok(count) = list.GetCount() else { continue };
                for k in 0..count {
                    let Ok(ctl) = list.GetSession(k) else { continue };
                    let Ok(c2) = ctl.cast::<IAudioSessionControl2>() else { continue };
                    let pid = c2.GetProcessId().unwrap_or(0);
                    let system = c2.IsSystemSoundsSession().0 == 0;
                    let state = ctl.GetState().map(|s| s.0).unwrap_or(-1);
                    let meter = ctl.cast::<IAudioMeterInformation>().ok();
                    rows.push(Row { pid, device: name.clone(), is_default, system, state, peak: 0.0, meter });
                }
            }
            // peak: the highest value seen over ~0.2 s (a single reading is mostly 0 between words)
            for _ in 0..10 {
                for r in rows.iter_mut() {
                    if let Some(m) = &r.meter { if let Ok(p) = m.GetPeakValue() { if p > r.peak { r.peak = p; } } }
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
        let table = process_table();
        let mut cmd_cache: HashMap<u32, String> = HashMap::new();
        let mut out = Vec::new();
        for r in &rows {
            if r.pid == std::process::id() { continue; } // our own capture session (shows up while a check runs)
            let (ppid, exe) = table.get(&r.pid).cloned().unwrap_or((0, String::new()));
            let cmd = cmd_cache.entry(r.pid).or_insert_with(|| if r.pid != 0 { cmdline::of(r.pid) } else { String::new() }).clone();
            let (kind, sub) = crate::procrole::roles_of(&cmd);
            out.push(json!({
                "pid": r.pid, "ppid": ppid, "exe": exe, "role": kind, "sub": sub,
                "cmd_known": !cmd.is_empty(), "device": r.device, "default": r.is_default, "system": r.system,
                // AudioSessionState: 0 inactive, 1 active, 2 expired
                "state": r.state, "active": r.state == 1, "peak": (r.peak * 10000.0).round() / 10000.0,
            }));
        }
        Ok(out)
    }

    // ---- probes ----------------------------------------------------------------------------------------------------

    #[repr(C)] struct OsVer { size: u32, major: u32, minor: u32, build: u32, platform: u32, csd: [u16; 128] }
    #[link(name = "ntdll")]
    extern "system" { fn RtlGetVersion(v: *mut OsVer) -> i32; }
    fn os_build() -> String {
        unsafe {
            let mut v = OsVer { size: std::mem::size_of::<OsVer>() as u32, major: 0, minor: 0, build: 0, platform: 0, csd: [0; 128] };
            RtlGetVersion(&mut v);
            format!("{}.{}.{}", v.major, v.minor, v.build)
        }
    }

    #[implement(IActivateAudioInterfaceCompletionHandler)]
    struct Handler { tx: Mutex<mpsc::Sender<()>> }

    impl IActivateAudioInterfaceCompletionHandler_Impl for Handler_Impl {
        fn ActivateCompleted(&self, _op: windows::core::Ref<'_, IActivateAudioInterfaceAsyncOperation>) -> windows::core::Result<()> {
            if let Ok(tx) = self.tx.lock() { let _ = tx.send(()); }
            Ok(())
        }
    }

    #[repr(C)] struct LoopbackParams { activation_type: u32, target_pid: u32, mode: u32 }   // AUDIOCLIENT_ACTIVATION_PARAMS
    #[repr(C)] struct BlobVariant { vt: u16, r1: u16, r2: u16, r3: u16, size: u32, ptr: *const LoopbackParams } // PROPVARIANT as VT_BLOB (65)

    fn wav(path: &std::path::Path, pcm: &[i16], rate: u32, ch: u16) -> std::io::Result<()> {
        use std::io::Write;
        let data = (pcm.len() * 2) as u32;
        let mut f = std::fs::File::create(path)?;
        f.write_all(b"RIFF")?; f.write_all(&(36 + data).to_le_bytes())?; f.write_all(b"WAVEfmt ")?;
        f.write_all(&16u32.to_le_bytes())?; f.write_all(&1u16.to_le_bytes())?; f.write_all(&ch.to_le_bytes())?;
        f.write_all(&rate.to_le_bytes())?; f.write_all(&(rate * ch as u32 * 2).to_le_bytes())?;
        f.write_all(&(ch * 2).to_le_bytes())?; f.write_all(&16u16.to_le_bytes())?; f.write_all(b"data")?; f.write_all(&data.to_le_bytes())?;
        let mut bytes = Vec::with_capacity(pcm.len() * 2);
        for s in pcm { bytes.extend_from_slice(&s.to_le_bytes()); }
        f.write_all(&bytes)
    }

    fn save_wav(name: &str, pcm: &[i16], rate: u32, ch: u16) -> Value {
        if pcm.is_empty() { return Value::Null; }
        let Ok(exe) = std::env::current_exe() else { return Value::Null };
        let Some(dir) = exe.parent() else { return Value::Null };
        let d = dir.join("extensions").join("stt").join("tmp");
        if std::fs::create_dir_all(&d).is_err() { return Value::Null; }
        if wav(&d.join(name), pcm, rate, ch).is_ok() { json!(format!("extensions/stt/tmp/{name}")) } else { Value::Null }
    }

    fn r4(v: f64) -> f64 { (v * 10000.0).round() / 10000.0 }
    pub(crate) fn err_of(e: &windows::core::Error) -> String { format!("{:#010x} {}", e.code().0 as u32, e.message().trim()) }

    /// the virtual "process loopback" device of one program (mode 0 = that program and its children, 1 = everything except them)
    pub(crate) fn activate(pid: u32, mode: u32) -> Result<IAudioClient, String> {
        unsafe {
            let params = LoopbackParams { activation_type: 1, target_pid: pid, mode };
            let pv = BlobVariant { vt: 65, r1: 0, r2: 0, r3: 0, size: std::mem::size_of::<LoopbackParams>() as u32, ptr: &params };
            let (tx, rx) = mpsc::channel();
            let handler: IActivateAudioInterfaceCompletionHandler = Handler { tx: Mutex::new(tx) }.into();
            let op = ActivateAudioInterfaceAsync(
                windows::core::w!("VAD\\Process_Loopback"), &IAudioClient::IID,
                Some(&pv as *const BlobVariant as *const PROPVARIANT), &handler,
            ).map_err(|e| format!("activate {}", err_of(&e)))?;
            rx.recv_timeout(Duration::from_secs(5)).map_err(|_| "activate timeout".to_string())?;
            let mut hr = windows::core::HRESULT(0);
            let mut unk: Option<windows::core::IUnknown> = None;
            op.GetActivateResult(&mut hr, &mut unk).map_err(|e| format!("result {}", err_of(&e)))?;
            if hr.is_err() { return Err(format!("result {:#010x}", hr.0 as u32)); }
            let unk = unk.ok_or_else(|| "result: no interface".to_string())?;
            unk.cast::<IAudioClient>().map_err(|e| format!("cast {}", err_of(&e)))
        }
    }

    struct Heard { pcm: Vec<i16>, dev_peak: f32, packets: u32 }

    /// reads packets for `secs` seconds. `ch` / `float` / `bytes_per_frame` describe the stream format; the sound is kept as 16 bit.
    unsafe fn listen(cap: &IAudioCaptureClient, event: Option<HANDLE>, secs: f64, ch: usize, float: bool, dev_meter: &Option<IAudioMeterInformation>) -> Heard {
        let mut h = Heard { pcm: Vec::new(), dev_peak: 0.0, packets: 0 };
        let started = Instant::now();
        while started.elapsed().as_secs_f64() < secs {
            match event { Some(e) => { WaitForSingleObject(e, 100); } None => std::thread::sleep(Duration::from_millis(10)) }
            if let Some(m) = dev_meter { if let Ok(p) = m.GetPeakValue() { if p > h.dev_peak { h.dev_peak = p; } } }
            loop {
                let n = cap.GetNextPacketSize().unwrap_or(0);
                if n == 0 { break; }
                let mut data: *mut u8 = std::ptr::null_mut();
                let (mut frames, mut fl) = (0u32, 0u32);
                if cap.GetBuffer(&mut data, &mut frames, &mut fl, None, None).is_err() { break; }
                h.packets += 1;
                let count = frames as usize * ch;
                if fl & 2 != 0 || data.is_null() { h.pcm.extend(std::iter::repeat(0i16).take(count)); }
                else if float { for &x in std::slice::from_raw_parts(data as *const f32, count) { h.pcm.push((x.clamp(-1.0, 1.0) * 32767.0) as i16); } }
                else { h.pcm.extend_from_slice(std::slice::from_raw_parts(data as *const i16, count)); }
                let _ = cap.ReleaseBuffer(frames);
                if h.pcm.len() > 48000 * ch * 20 { break; }
            }
        }
        h
    }

    fn levels(pcm: &[i16]) -> (f64, f64) {
        let (mut peak, mut sq) = (0i32, 0f64);
        for &s in pcm { let a = (s as i32).abs(); if a > peak { peak = a; } sq += (s as f64) * (s as f64); }
        (peak as f64 / 32768.0, if pcm.is_empty() { 0.0 } else { (sq / pcm.len() as f64).sqrt() / 32768.0 })
    }

    /// level meter of the output device with this name (the default device when the name is empty or not found)
    fn meter_of(name: &str) -> Option<IAudioMeterInformation> {
        unsafe {
            let en = CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
            let mut dev: Option<IMMDevice> = None;
            if !name.is_empty() {
                if let Ok(coll) = en.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE) {
                    for i in 0..coll.GetCount().unwrap_or(0) { if let Ok(d) = coll.Item(i) { if device_name(&d) == name { dev = Some(d); break; } } }
                }
            }
            let dev = match dev { Some(d) => d, None => en.GetDefaultAudioEndpoint(eRender, eConsole).ok()? };
            dev.Activate::<IAudioMeterInformation>(CLSCTX_ALL, None).ok()
        }
    }

    pub(crate) fn wfx(tag: u16, ch: u16, rate: u32, bits: u16) -> WAVEFORMATEX {
        let block = ch * bits / 8;
        WAVEFORMATEX { wFormatTag: tag, nChannels: ch, nSamplesPerSec: rate, nAvgBytesPerSec: rate * block as u32, nBlockAlign: block, wBitsPerSample: bits, cbSize: 0 }
    }

    /// Process loopback of one program: every combination of activation mode, format, stream flags and buffer length is tried, each result is
    /// reported (a list of the ones that work, and how often each error came), and the first working one records `secs` seconds.
    pub fn probe(pid: u32, secs: f64, save: bool, full: bool, device: &str) -> Result<Value, String> {
        com();
        const LB: u32 = 0x0002_0000; const EV: u32 = 0x0004_0000; const NP: u32 = 0x0008_0000; const AUTO: u32 = 0x8000_0000; const SRC: u32 = 0x0800_0000;
        let formats_all: [(&str, u16, u32, u16); 4] = [("i16/44100", 1, 44100, 16), ("i16/48000", 1, 48000, 16), ("f32/48000", 3, 48000, 32), ("f32/44100", 3, 44100, 32)];
        let flagsets_all: [(&str, u32); 7] = [("LB+EV+NP", LB | EV | NP), ("LB+EV", LB | EV), ("LB", LB), ("LB+AUTO+SRC", LB | AUTO | SRC),
            ("LB+EV+AUTO+SRC", LB | EV | AUTO | SRC), ("EV+NP", EV | NP), ("none", 0)];
        let durations_all: [i64; 2] = [200_000, 0];
        // the quick check uses the one combination that works on Windows 10 19045 (measured): 16 bit 44.1 kHz, LOOPBACK + EVENTCALLBACK, 20 ms buffer
        let formats: &[(&str, u16, u32, u16)] = if full { &formats_all[..] } else { &formats_all[..1] };
        let flagsets: &[(&str, u32)] = if full { &flagsets_all[..] } else { &flagsets_all[1..2] };
        let durations: &[i64] = if full { &durations_all[..] } else { &durations_all[..1] };
        let modes: &[u32] = if full { &[0, 1] } else { &[0] };
        let mut works: Vec<String> = Vec::new();
        let mut errors: HashMap<String, (usize, String)> = HashMap::new();
        let mut first: Option<(IAudioClient, usize, u32, bool, String)> = None; // client, format index, flags, ...
        let mut activate_errors: HashMap<String, usize> = HashMap::new();
        let mut tried = 0usize;
        unsafe {
            for &mode in modes {
                for (fi, f) in formats.iter().enumerate() {
                    for (name, flags) in flagsets.iter() {
                        for &dur in durations {
                            let combo = format!("mode{} {} {} dur{}", mode, f.0, name, dur);
                            let client = match activate(pid, mode) { Ok(c) => c, Err(e) => { *activate_errors.entry(e).or_insert(0) += 1; continue; } };
                            tried += 1;
                            let fmt = wfx(f.1, 2, f.2, f.3);
                            match client.Initialize(AUDCLNT_SHAREMODE_SHARED, *flags, dur, 0, &fmt, None) {
                                Ok(()) => {
                                    works.push(combo.clone());
                                    if first.is_none() && mode == 0 { first = Some((client, fi, *flags, f.1 == 3, combo)); }
                                }
                                Err(e) => { let en = errors.entry(err_of(&e)).or_insert((0, combo)); en.0 += 1; }
                            }
                        }
                    }
                }
            }
        }
        let errs: Vec<Value> = { let mut v: Vec<_> = errors.into_iter().collect(); v.sort_by(|a, b| b.1 .0.cmp(&a.1 .0)); v.into_iter().map(|(k, (n, ex))| json!({"error": k, "count": n, "example": ex})).collect() };
        let aerrs: Vec<Value> = activate_errors.into_iter().map(|(k, n)| json!({"error": k, "count": n})).collect();
        let mut out = json!({"ok": false, "pid": pid, "build": os_build(), "tried": tried, "works": works, "errors": errs, "activate_errors": aerrs});
        let Some((client, fi, flags, float, combo)) = first else { return Ok(out) };
        unsafe {
            let cap: IAudioCaptureClient = client.GetService().map_err(|e| e.to_string())?;
            let event = if flags & EV != 0 {
                let ev = CreateEventW(None, false, false, None).map_err(|e| e.to_string())?;
                client.SetEventHandle(ev).map_err(|e| e.to_string())?;
                Some(ev)
            } else { None };
            let meter = meter_of(device);
            client.Start().map_err(|e| e.to_string())?;
            let heard = listen(&cap, event, secs, 2, float, &meter);
            let _ = client.Stop();
            if let Some(ev) = event { let _ = CloseHandle(ev); }
            let (peak, rms) = levels(&heard.pcm);
            let wav_path = if save { save_wav(&format!("probe-{pid}.wav"), &heard.pcm, formats[fi].2, 2) } else { Value::Null };
            out["ok"] = json!(true); out["used"] = json!(combo); out["seconds"] = json!(secs); out["packets"] = json!(heard.packets);
            out["frames"] = json!(heard.pcm.len() / 2); out["rate"] = json!(formats[fi].2);
            out["capture_peak"] = json!(r4(peak)); out["capture_rms"] = json!(r4(rms)); out["device_peak"] = json!(r4(heard.dev_peak as f64)); out["wav"] = wav_path;
        }
        Ok(out)
    }

    /// Plain loopback of a whole output device (found by its name): what the device plays, in the device's own format.
    pub fn probe_device(name: &str, secs: f64, save: bool) -> Result<Value, String> {
        com();
        unsafe {
            let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| format!("MMDeviceEnumerator: {e}"))?;
            let coll = en.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE).map_err(|e| e.to_string())?;
            let n = coll.GetCount().map_err(|e| e.to_string())?;
            let mut found: Option<IMMDevice> = None;
            for i in 0..n { if let Ok(d) = coll.Item(i) { if device_name(&d) == name { found = Some(d); break; } } }
            let Some(dev) = found else { return Ok(json!({"ok": false, "error": "device not found", "device": name})) };
            let client: IAudioClient = dev.Activate(CLSCTX_ALL, None).map_err(|e| format!("activate {}", err_of(&e)))?;
            let pf = client.GetMixFormat().map_err(|e| format!("mixformat {}", err_of(&e)))?;
            let f = std::ptr::read_unaligned(pf);
            let (tag, ch, rate, bits) = (f.wFormatTag, f.nChannels, f.nSamplesPerSec, f.wBitsPerSample);
            let float = bits == 32 && (tag == 3 || tag == 0xFFFE);
            if !(bits == 16 || float) { CoTaskMemFree(Some(pf as *const core::ffi::c_void)); return Ok(json!({"ok": false, "error": format!("format not handled: tag {tag} bits {bits}")})); }
            let init = client.Initialize(AUDCLNT_SHAREMODE_SHARED, 0x0002_0000, 1_000_000, 0, pf, None);
            CoTaskMemFree(Some(pf as *const core::ffi::c_void));
            if let Err(e) = init { return Ok(json!({"ok": false, "step": "initialize", "error": err_of(&e)})); }
            let cap: IAudioCaptureClient = client.GetService().map_err(|e| e.to_string())?;
            let meter = meter_of(name);
            client.Start().map_err(|e| e.to_string())?;
            let heard = listen(&cap, None, secs, ch as usize, float, &meter);
            let _ = client.Stop();
            let (peak, rms) = levels(&heard.pcm);
            let wav_path = if save { save_wav("probe-device.wav", &heard.pcm, rate, ch) } else { Value::Null };
            Ok(json!({"ok": true, "device": name, "build": os_build(), "format": format!("{} ch {} Hz {} bit{}", ch, rate, bits, if float { " float" } else { "" }),
                "seconds": secs, "packets": heard.packets, "frames": heard.pcm.len() / ch.max(1) as usize, "rate": rate,
                "capture_peak": r4(peak), "capture_rms": r4(rms), "device_peak": r4(heard.dev_peak as f64), "wav": wav_path}))
        }
    }
}
