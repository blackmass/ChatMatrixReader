// A stand-in for the voice engine, only to try the sound capture (Build B2) before the real engine exists.
// It reads the sound the program sends on its standard input (16 kHz mono) and every 2 seconds tells, as a "recognised sentence" in the chat
// window, how much sound arrived and how loud it was. It recognises nothing.
//   build (Windows):  rustc -O tools/fake_stt.rs -o extensions/stt/engine-cpu/cmr-stt.exe
//   also needs a file extensions/stt/models/ggml-large-v3-turbo.bin (any content) so that the program thinks a model is installed.
use std::io::{Read, Write};
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let val = |k: &str| args.iter().position(|a| a == k).and_then(|i| args.get(i + 1)).cloned().unwrap_or_default();
    let out = std::io::stdout();
    if args.iter().any(|a| a == "--bench") {
        // the speed test: pretend to recognise the file in a fixed time
        std::thread::sleep(std::time::Duration::from_millis(1500));
        let model = val("--model");
        let _ = writeln!(out.lock(), "{{\"type\":\"bench\",\"dur\":10.0,\"ms\":4000,\"load_ms\":500,\"text\":\"fake engine ({})\"}}", model.replace('\\', "/").rsplit('/').next().unwrap_or(""));
        return;
    }
    let s16 = val("--pcm") != "f32";
    let bytes_per = if s16 { 2 } else { 4 };
    let _ = writeln!(out.lock(), "{{\"type\":\"status\",\"state\":\"ready\",\"device\":\"cpu\"}}");
    let _ = out.lock().flush();
    let mut stdin = std::io::stdin().lock();
    let mut buf = vec![0u8; 64000];
    let (mut total, mut window, mut peak, mut sq) = (0u64, 0u64, 0f64, 0f64);
    let mut t = Instant::now();
    loop {
        let n = match stdin.read(&mut buf) { Ok(0) | Err(_) => break, Ok(n) => n };
        for c in buf[..n].chunks_exact(bytes_per) {
            let v = if s16 { i16::from_le_bytes([c[0], c[1]]) as f64 / 32768.0 } else { f32::from_le_bytes([c[0], c[1], c[2], c[3]]) as f64 };
            peak = peak.max(v.abs()); sq += v * v; window += 1; total += 1;
        }
        if t.elapsed().as_secs_f64() >= 2.0 {
            let rms = if window > 0 { (sq / window as f64).sqrt() } else { 0.0 };
            let _ = writeln!(out.lock(), "{{\"type\":\"text\",\"text\":\"[fake] heard {:.1} s of sound in 2 s, peak {:.3}, rms {:.4}, total {:.0} s\",\"dur\":{:.1},\"ms\":200}}",
                window as f64 / 16000.0, peak, rms, total as f64 / 16000.0, window as f64 / 16000.0);
            let _ = out.lock().flush();
            window = 0; peak = 0.0; sq = 0.0; t = Instant::now();
        }
    }
}
