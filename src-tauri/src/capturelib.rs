//! The parts of the sound capture that need no Windows call (so they can be tested alone: `rustc --test capturelib.rs`). Ported from the 2.x
//! Python reader (`sttcore/audio.py`, `sttcore/capture.py` SessionSource), where they were measured on a real machine.
//!
//!   Resampler      any rate -> 16 kHz, streaming (linear interpolation, a light low-pass in front when the rate goes down)
//!   Pacer          keeps the stream on the wall clock: a loopback sends NOTHING while nothing plays, but the recogniser measures silence in
//!                  samples, so the gaps are filled with zeros
//!   Gate           "the program is audibly playing" (its session peak above a limit, held for a while): only then does the sound pass
//!   Router         which output device (and which process) to listen to, from what the audio sessions say
//!   SilenceWatch   no sound at all for N seconds -> one warning (and a note when it comes back)
//!   Spec           which sessions belong to the chosen program
//!   encode         16 kHz mono f32 -> bytes for the engine (16 bit or float)

pub const RATE: u32 = 16000;

// ---- format --------------------------------------------------------------------------------------------------------------

/// What the engine reads on its standard input: 16 kHz mono, little endian.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Pcm { S16, F32 }

impl Pcm {
    pub fn parse(s: &str) -> Pcm { if s.eq_ignore_ascii_case("f32") { Pcm::F32 } else { Pcm::S16 } }
}

pub fn encode(x: &[f32], pcm: Pcm) -> Vec<u8> {
    match pcm {
        Pcm::S16 => {
            let mut out = Vec::with_capacity(x.len() * 2);
            for &v in x { out.extend_from_slice(&((v.clamp(-1.0, 1.0) * 32767.0).round() as i16).to_le_bytes()); }
            out
        }
        Pcm::F32 => {
            let mut out = Vec::with_capacity(x.len() * 4);
            for &v in x { out.extend_from_slice(&v.clamp(-1.0, 1.0).to_le_bytes()); }
            out
        }
    }
}

/// One frame of the engine's framed input (engine/stt/src/protocol.h): "CMRFA" + the length as 8 hexadecimal digits + the sound.
pub fn frame(sound: &[u8]) -> Vec<u8> {
    let mut v = format!("CMRFA{:08x}", sound.len()).into_bytes();
    v.extend_from_slice(sound);
    v
}

/// interleaved 16 bit -> mono float (the channels are averaged); a partial frame at the end is dropped
pub fn mono_i16(pcm: &[i16], ch: usize) -> Vec<f32> {
    let ch = ch.max(1);
    pcm.chunks_exact(ch).map(|f| f.iter().map(|&s| s as f32 / 32768.0).sum::<f32>() / ch as f32).collect()
}
pub fn mono_f32(pcm: &[f32], ch: usize) -> Vec<f32> {
    let ch = ch.max(1);
    pcm.chunks_exact(ch).map(|f| {
        let v = f.iter().sum::<f32>() / ch as f32;
        if v.is_finite() { v.clamp(-1.0, 1.0) } else { 0.0 }
    }).collect()
}

pub fn peak_of(x: &[f32]) -> f32 { x.iter().fold(0.0f32, |m, &v| m.max(v.abs())) }

// ---- resampler ------------------------------------------------------------------------------------------------------------

pub struct Resampler {
    rate_in: u32,
    step: f64,
    buf: Vec<f32>,
    pos: f64,       // where the next output sample lies, in input samples from buf[0]
}

impl Resampler {
    pub fn new(rate_in: u32) -> Resampler { Resampler { rate_in, step: rate_in as f64 / RATE as f64, buf: Vec::new(), pos: 0.0 } }

    pub fn process(&mut self, x: &[f32]) -> Vec<f32> {
        if self.rate_in == RATE { return x.to_vec(); }
        self.buf.extend_from_slice(x);
        let buf = &self.buf;
        let n = buf.len();
        // anti-aliasing when the rate goes down: a 3-tap smoothing (the first and last sample stay as they are)
        let filt: Vec<f32> = if self.step > 1.0 && n >= 3 {
            (0..n).map(|i| if i == 0 || i == n - 1 { buf[i] } else { 0.25 * buf[i - 1] + 0.5 * buf[i] + 0.25 * buf[i + 1] }).collect()
        } else { buf.clone() };
        if n < 2 { return Vec::new(); }
        let last = (n - 2) as f64;                      // the last 2 samples are not final (filter edge): wait for more
        if last <= self.pos { return Vec::new(); }
        let mut out = Vec::new();
        let mut p = self.pos;
        while p < last {
            let i0 = p.floor() as usize;
            let frac = (p - i0 as f64) as f32;
            out.push(filt[i0] * (1.0 - frac) + filt[i0 + 1] * frac);
            p += self.step;
        }
        let keep = p.floor() as usize;
        self.pos = p - keep as f64;
        self.buf = self.buf[keep.min(n)..].to_vec();
        out
    }
}

// ---- pacer ----------------------------------------------------------------------------------------------------------------

/// Called every tick with the samples that arrived since the last one and the time (seconds, any origin). Gives back what to send: the
/// samples, plus zeros when fewer than the clock says have arrived (more than `slack` seconds behind).
pub struct Pacer { start: Option<f64>, sent: u64, slack: f64 }

impl Pacer {
    pub fn new(slack: f64) -> Pacer { Pacer { start: None, sent: 0, slack } }
    pub fn tick(&mut self, now: f64, mut got: Vec<f32>) -> Vec<f32> {
        let start = *self.start.get_or_insert(now);
        self.sent += got.len() as u64;
        let want = ((now - start) * RATE as f64) as i64;
        let behind = want - self.sent as i64;
        if behind as f64 > self.slack * RATE as f64 {
            got.extend(std::iter::repeat(0.0f32).take(behind as usize));
            self.sent += behind as u64;
        }
        got
    }
}

// ---- gate -----------------------------------------------------------------------------------------------------------------

/// Open while the program is audible on the device we listen to: its session peak above `limit`, held `hold` seconds after the last time.
/// limit 0 = always open (no gate).
pub struct Gate { pub limit: f32, pub hold: f64, until: f64 }

impl Gate {
    pub fn new(limit: f32, hold: f64) -> Gate { Gate { limit, hold, until: f64::NEG_INFINITY } }
    /// `peak` = the program's session peak now (None: the program has no session on this device)
    pub fn update(&mut self, now: f64, peak: Option<f32>) -> bool {
        if self.limit <= 0.0 { return true; }
        if let Some(p) = peak { if p > self.limit { self.until = now + self.hold; } }
        now < self.until
    }
}

// ---- which sessions belong to the program ---------------------------------------------------------------------------------

/// What the user picked, as the reader needs it (core/voice_target.js builds it from the options).
///   names: file names of the program ("discord.exe"; a trailing * = any ending: "wow*"); role / sub: only that job of the program
///   ("renderer", "utility" + "AudioService"); skip_audio_service: leave out the video / web sound of a Chromium program.
#[derive(Clone, Default, Debug)]
pub struct Spec { pub names: Vec<String>, pub role: String, pub sub: String, pub skip_audio_service: bool }

impl Spec {
    pub fn name_ok(&self, exe: &str) -> bool {
        let e = exe.to_ascii_lowercase();
        let e = e.strip_suffix(".exe").unwrap_or(&e);
        self.names.iter().any(|n| {
            let n = n.to_ascii_lowercase();
            let n = n.strip_suffix(".exe").unwrap_or(&n).to_string();
            match n.strip_suffix('*') { Some(prefix) => e.starts_with(prefix), None => e == n }
        })
    }
    pub fn role_ok(&self, kind: &str, sub: &str) -> bool {
        if self.skip_audio_service && kind == "utility" && sub == "AudioService" { return false; }
        if self.role.is_empty() { return true; }
        kind == self.role && (self.sub.is_empty() || sub == self.sub)
    }
}

// ---- router ---------------------------------------------------------------------------------------------------------------

/// A sound session of a program that matches the Spec (sessions of other programs and expired ones are left out before).
#[derive(Clone, Debug)]
pub struct Sess { pub pid: u32, pub device: String, pub peak: f32 }

#[derive(Clone, Debug, PartialEq, Default)]
pub struct Want {
    pub device: Option<String>,     // the output device to listen to (None: the program has none yet)
    pub pid: Option<u32>,           // the process whose sound is the program's on that device
    pub peak: f32,                  // how loud the program is on it now
}

/// Decides, every poll, where to listen. Behaves like the 2.x `_resolve`:
///   first sight of the program -> its (loudest) device; it starts to play somewhere else -> follow; no session for `lose_after` seconds -> let go.
pub struct Router { gate_peak: f32, lose_after: f64, dev: Option<String>, pid: Option<u32>, last_seen: f64 }

impl Router {
    pub fn new(gate_peak: f32, lose_after: f64) -> Router { Router { gate_peak, lose_after, dev: None, pid: None, last_seen: f64::NEG_INFINITY } }

    pub fn step(&mut self, now: f64, sessions: &[Sess]) -> Want {
        // device -> (peak, loudest pid, pids)
        let mut by_dev: Vec<(String, f32, u32, Vec<u32>)> = Vec::new();
        for s in sessions {
            match by_dev.iter_mut().find(|d| d.0 == s.device) {
                Some(d) => { if s.peak > d.1 { d.1 = s.peak; d.2 = s.pid; } d.3.push(s.pid); }
                None => by_dev.push((s.device.clone(), s.peak, s.pid, vec![s.pid])),
            }
        }
        if !by_dev.is_empty() { self.last_seen = now; }
        let has = |name: &Option<String>| name.as_ref().map(|n| by_dev.iter().any(|d| &d.0 == n)).unwrap_or(false);
        let current_ok = has(&self.dev);
        let loud: Vec<&String> = by_dev.iter().filter(|d| d.1 > self.gate_peak).map(|d| &d.0).collect();
        if !current_ok && self.dev.is_some() && now - self.last_seen > self.lose_after { self.dev = None; self.pid = None; }
        let mut want: Option<String> = None;
        if !current_ok && !by_dev.is_empty() {
            want = Some(loud.first().map(|s| (*s).clone()).unwrap_or_else(|| by_dev[0].0.clone()));
        } else if current_ok {
            let cur = self.dev.clone().unwrap_or_default();
            if !loud.is_empty() && !loud.iter().any(|d| **d == cur) { want = Some(loud[0].clone()); }
        }
        if let Some(w) = want { if self.dev.as_deref() != Some(w.as_str()) { self.dev = Some(w); self.pid = None; } }
        // the process: keep the one we have while it still has a session on the device, else the loudest
        let mut peak = 0.0;
        if let Some(d) = self.dev.as_ref().and_then(|n| by_dev.iter().find(|d| &d.0 == n)) {
            peak = d.1;
            if !self.pid.map(|p| d.3.contains(&p)).unwrap_or(false) { self.pid = Some(d.2); }
        }
        Want { device: self.dev.clone(), pid: self.pid, peak }
    }
}

// ---- silence watch --------------------------------------------------------------------------------------------------------

#[derive(Debug, PartialEq)]
pub enum Silence { None, Warn, Back }

/// "no sound for `limit` seconds" once, and "back" when something is heard again. `audible`: the sound we passed on is not silence.
pub struct SilenceWatch { limit: f64, last: Option<f64>, warned: bool }

impl SilenceWatch {
    pub fn new(limit: f64) -> SilenceWatch { SilenceWatch { limit, last: None, warned: false } }
    pub fn tick(&mut self, now: f64, audible: bool) -> Silence {
        let last = *self.last.get_or_insert(now);
        if audible {
            self.last = Some(now);
            if self.warned { self.warned = false; return Silence::Back; }
            return Silence::None;
        }
        if self.limit > 0.0 && !self.warned && now - last >= self.limit { self.warned = true; return Silence::Warn; }
        Silence::None
    }
}

// ---- tests ----------------------------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(n: usize, rate: f64, hz: f64) -> Vec<f32> { (0..n).map(|i| (2.0 * std::f64::consts::PI * hz * i as f64 / rate).sin() as f32 * 0.5).collect() }

    #[test]
    fn encode_formats() {
        assert_eq!(encode(&[0.0, 1.0, -1.0, 2.0], Pcm::S16), vec![0, 0, 0xff, 0x7f, 0x01, 0x80, 0xff, 0x7f]);
        assert_eq!(encode(&[0.5], Pcm::F32), 0.5f32.to_le_bytes().to_vec());
        assert_eq!(Pcm::parse("F32"), Pcm::F32);
        assert_eq!(Pcm::parse("whatever"), Pcm::S16);
    }

    #[test]
    fn frames_for_the_engine() {
        assert_eq!(frame(&[1, 2, 3]), b"CMRFA00000003\x01\x02\x03".to_vec());
        assert_eq!(frame(&[]), b"CMRFA00000000".to_vec());
        assert_eq!(&frame(&vec![0u8; 640])[..13], b"CMRFA00000280");
    }

    #[test]
    fn downmix() {
        assert_eq!(mono_i16(&[16384, -16384, 8192, 8192, 5], 2), vec![0.0, 0.25]);         // the odd sample at the end is a partial frame
        assert_eq!(mono_f32(&[1.0, 0.0, f32::NAN, 0.0], 2), vec![0.5, 0.0]);
        assert_eq!(mono_f32(&[0.3, 0.4], 1), vec![0.3, 0.4]);
        assert!((peak_of(&[0.1, -0.7, 0.3]) - 0.7).abs() < 1e-6);
    }

    #[test]
    fn resample_length_and_pitch() {
        // 44.1 kHz -> 16 kHz in chunks of 20 ms: about 16000 samples out for one second in, and the same tone
        let x = sine(44100, 44100.0, 440.0);
        let mut r = Resampler::new(44100);
        let mut out = Vec::new();
        for c in x.chunks(882) { out.extend(r.process(c)); }
        assert!((out.len() as i64 - 16000).abs() < 8, "got {}", out.len());
        // count zero crossings of the middle: 440 Hz -> about 880 per second
        let mid = &out[2000..14000];
        let zc = mid.windows(2).filter(|w| (w[0] < 0.0) != (w[1] < 0.0)).count() as f64;
        assert!((zc / 0.75 - 880.0).abs() < 25.0, "crossings {}", zc);
        // the same result however the input is cut into chunks
        let mut r2 = Resampler::new(44100);
        let one = r2.process(&x);
        let n = one.len().min(out.len()) - 20;
        for i in 0..n { assert!((one[i] - out[i]).abs() < 1e-3, "at {i}"); }
    }

    #[test]
    fn resample_same_rate_and_up() {
        let mut r = Resampler::new(16000);
        assert_eq!(r.process(&[0.1, 0.2]), vec![0.1, 0.2]);
        let mut up = Resampler::new(8000);          // 8 kHz -> 16 kHz: twice as many
        let out = up.process(&sine(8000, 8000.0, 100.0));
        assert!((out.len() as i64 - 16000).abs() < 8, "got {}", out.len());
        assert!(Resampler::new(48000).process(&[0.5]).is_empty());           // too short: waits for more
    }

    #[test]
    fn pacer_fills_gaps_with_silence() {
        let mut p = Pacer::new(0.04);
        assert_eq!(p.tick(10.0, vec![0.5; 320]).len(), 320);             // the first tick starts the clock
        // 20 ms later 320 samples arrive: right on time, nothing added
        assert_eq!(p.tick(10.02, vec![0.5; 320]).len(), 320);
        // nothing arrives for a second: the clock says 16320 samples should be there, 640 are: 15680 are missing
        let gap = p.tick(11.02, vec![]);
        assert!((gap.len() as i64 - 15680).abs() <= 1, "got {}", gap.len());
        assert!(gap.iter().all(|&v| v == 0.0));
        // a little jitter (below the slack) adds nothing
        assert!(p.tick(11.03, vec![]).is_empty());
        // a burst (more than the clock) is passed on as it is
        assert_eq!(p.tick(11.04, vec![0.1; 1600]).len(), 1600);
    }

    #[test]
    fn gate_opens_holds_and_closes() {
        let mut g = Gate::new(0.002, 1.0);
        assert!(!g.update(0.0, None));
        assert!(!g.update(0.1, Some(0.001)));
        assert!(g.update(0.2, Some(0.05)));
        assert!(g.update(1.1, Some(0.0)), "held 1 s after the last loud reading");
        assert!(!g.update(1.3, Some(0.0)));
        assert!(Gate::new(0.0, 1.0).update(5.0, None), "limit 0 = no gate");
    }

    fn s(pid: u32, dev: &str, peak: f32) -> Sess { Sess { pid, device: dev.to_string(), peak } }

    #[test]
    fn router_follows_the_program() {
        let mut r = Router::new(0.002, 10.0);
        assert_eq!(r.step(0.0, &[]), Want::default());
        // first sight: the loudest device, and its loudest process
        let w = r.step(1.0, &[s(10, "Speakers", 0.0), s(11, "Headset", 0.2), s(12, "Headset", 0.5)]);
        assert_eq!((w.device.as_deref(), w.pid), (Some("Headset"), Some(12)));
        // it stays while the program is still there, even when quiet
        let w = r.step(2.0, &[s(11, "Headset", 0.0), s(12, "Headset", 0.0)]);
        assert_eq!((w.device.as_deref(), w.pid), (Some("Headset"), Some(12)));
        // it starts to play on another device: follow
        let w = r.step(3.0, &[s(11, "Headset", 0.0), s(10, "Speakers", 0.3)]);
        assert_eq!(w.device.as_deref(), Some("Speakers"));
        assert_eq!(w.pid, Some(10));
        // no session at all: kept for lose_after seconds, then let go
        assert_eq!(r.step(5.0, &[]).device.as_deref(), Some("Speakers"));
        assert_eq!(r.step(12.0, &[]).device.as_deref(), Some("Speakers"));
        assert_eq!(r.step(14.5, &[]), Want::default());
        // and it finds the program again
        assert_eq!(r.step(20.0, &[s(30, "Speakers", 0.1)]).pid, Some(30));
    }

    #[test]
    fn router_keeps_its_process() {
        let mut r = Router::new(0.002, 10.0);
        r.step(0.0, &[s(1, "A", 0.1), s(2, "A", 0.3)]);
        // process 1 is not the loudest any more, but it is still the one we listen to as long as it exists... unless it is gone
        let w = r.step(1.0, &[s(1, "A", 0.5), s(2, "A", 0.1)]);
        assert_eq!(w.pid, Some(2));
        let w = r.step(2.0, &[s(1, "A", 0.5)]);
        assert_eq!(w.pid, Some(1), "its process ended: the next one");
    }

    #[test]
    fn spec_matches_programs_and_jobs() {
        let d = Spec { names: vec!["discord.exe".into(), "discordptb.exe".into()], skip_audio_service: true, ..Default::default() };
        assert!(d.name_ok("Discord.exe") && d.name_ok("DISCORDPTB") && !d.name_ok("discord_helper.exe"));
        assert!(d.role_ok("main", "") && d.role_ok("renderer", ""));
        assert!(!d.role_ok("utility", "AudioService"), "video / web sound of Discord is not the voice chat");
        assert!(d.role_ok("utility", "Network"));
        let w = Spec { names: vec!["wow*".into()], ..Default::default() };
        assert!(w.name_ok("Wow.exe") && w.name_ok("WowClassic.exe") && w.name_ok("wow-64.exe") && !w.name_ok("show.exe"));
        let job = Spec { names: vec!["chrome.exe".into()], role: "utility".into(), sub: "AudioService".into(), ..Default::default() };
        assert!(job.role_ok("utility", "AudioService") && !job.role_ok("utility", "Network") && !job.role_ok("renderer", ""));
        let any_sub = Spec { names: vec!["x".into()], role: "renderer".into(), ..Default::default() };
        assert!(any_sub.role_ok("renderer", "anything") && !any_sub.role_ok("main", ""));
    }

    #[test]
    fn silence_watch_warns_once() {
        let mut w = SilenceWatch::new(8.0);
        assert_eq!(w.tick(0.0, false), Silence::None);
        assert_eq!(w.tick(7.9, false), Silence::None);
        assert_eq!(w.tick(8.0, false), Silence::Warn);
        assert_eq!(w.tick(20.0, false), Silence::None, "only once");
        assert_eq!(w.tick(21.0, true), Silence::Back);
        assert_eq!(w.tick(22.0, true), Silence::None);
        assert_eq!(w.tick(30.0, false), Silence::Warn, "and again after a sound");
        let mut off = SilenceWatch::new(0.0);
        assert_eq!(off.tick(0.0, false), Silence::None);
        assert_eq!(off.tick(100.0, false), Silence::None);
    }
}
