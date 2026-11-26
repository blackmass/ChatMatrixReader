//! The picture of ONE window with ScreenCaptureKit (macOS 14 or later: `SCScreenshotManager`, docs/HANDOFF.md 4-0an): the window of the game without what stands over it on the screen (our own windows, the Dock ...).
//! The command `capture_game` of main.rs asks for it on a Mac, as `wgc.rs` does on Windows. The permission is the one the screen reading already needs (Screen Recording).
use std::ptr::NonNull;
use std::sync::mpsc::channel;
use std::sync::Mutex;
use std::time::Duration;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::AnyClass;
use objc2::AnyThread;
use objc2_core_foundation::CFRetained;
use objc2_core_graphics::{CGDataProvider, CGImage};
use objc2_foundation::NSError;
use objc2_screen_capture_kit::{SCContentFilter, SCScreenshotManager, SCShareableContent, SCStreamConfiguration, SCWindow};

/// what ScreenCaptureKit objects need to cross to another thread in a channel
struct Sx<T>(T);
unsafe impl<T> Send for Sx<T> {}

static WINDOW: Mutex<Option<(u32, Sx<Retained<SCWindow>>)>> = Mutex::new(None);          // the window of the game, found once (ScreenCaptureKit takes a moment to list the windows)

fn error_text(e: *mut NSError) -> String {
    if e.is_null() { return "unknown error".into(); }
    let e = unsafe { &*e };
    format!("{} (code {})", e.localizedDescription(), e.code())
}

/// -3801 = the user (or a missing permission) said no to the screen recording
fn permission(text: String) -> String {
    if text.contains("-3801") || text.to_ascii_lowercase().contains("declined") { "screen recording permission is needed (System Settings -> Privacy & Security -> Screen Recording)".to_string() } else { text }
}

fn find_window(id: u32) -> Result<Retained<SCWindow>, String> {
    if let Ok(g) = WINDOW.lock() { if let Some((i, w)) = g.as_ref() { if *i == id { return Ok(w.0.clone()); } } }
    let (tx, rx) = channel::<Result<Sx<Retained<SCWindow>>, String>>();
    let block = RcBlock::new(move |c: *mut SCShareableContent, e: *mut NSError| {
        let r = match unsafe { Retained::retain(c) } {
            Some(c) => {
                let list = unsafe { c.windows() };
                match list.iter().find(|w| unsafe { w.windowID() } == id) {
                    Some(w) => Ok(Sx(w)),
                    None => Err("the window of the game is not among the windows that ScreenCaptureKit shows (it is on another desktop, or hidden)".to_string()),
                }
            }
            None => Err(error_text(e)),
        };
        let _ = tx.send(r);
    });
    unsafe { SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(true, true, &block) };
    let w = match rx.recv_timeout(Duration::from_secs(10)) {
        Ok(Ok(w)) => w.0,
        Ok(Err(e)) => return Err(permission(e)),
        Err(_) => return Err("ScreenCaptureKit did not answer".into()),
    };
    if let Ok(mut g) = WINDOW.lock() { *g = Some((id, Sx(w.clone()))); }
    Ok(w)
}

fn forget() { if let Ok(mut g) = WINDOW.lock() { *g = None; } }

/// The picture of the window `id` (its place on the screen in pixels: `win` = [x, y, w, h]) -> a part of it: `x, y, w, h` in pixels of the screen. Result: 8 bytes header (width, height as u32 little endian)
/// + width*height*4 bytes BGRA, like `mac::capture`. The part has to lie inside the window.
pub fn capture(id: u32, win: [i32; 4], x: i32, y: i32, w: i32, h: i32) -> Result<Vec<u8>, String> {
    if w <= 0 || h <= 0 || w > 16384 || h > 16384 || win[2] <= 0 || win[3] <= 0 { return Err(format!("bad size {w}x{h}")); }
    if AnyClass::get(c"SCScreenshotManager").is_none() { return Err("the capture of one window needs macOS 14 or later".into()); }
    let (cx, cy) = (x - win[0], y - win[1]);
    if cx < 0 || cy < 0 || cx + w > win[2] || cy + h > win[3] { return Err(format!("the part is not inside the window ({}x{})", win[2], win[3])); }
    let window = find_window(id)?;
    let filter = unsafe { SCContentFilter::initWithDesktopIndependentWindow(SCContentFilter::alloc(), &window) };
    let cfg = unsafe { SCStreamConfiguration::new() };
    unsafe {
        cfg.setWidth(win[2] as usize);
        cfg.setHeight(win[3] as usize);
        cfg.setPixelFormat(0x4247_5241);                           // 'BGRA'
        cfg.setShowsCursor(false);
        cfg.setIgnoreShadowsSingleWindow(true);                    // (the picture is the window and not its shadow)
    }
    let (tx, rx) = channel::<Result<Sx<CFRetained<CGImage>>, String>>();
    let block = RcBlock::new(move |img: *mut CGImage, e: *mut NSError| {
        let r = match NonNull::new(img) { Some(p) => Ok(Sx(unsafe { CFRetained::retain(p) })), None => Err(error_text(e)) };
        let _ = tx.send(r);
    });
    unsafe { SCScreenshotManager::captureImageWithFilter_configuration_completionHandler(&filter, &cfg, Some(&block)) };
    let image = match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(i)) => i.0,
        Ok(Err(e)) => { forget(); return Err(permission(e)); }               // (the window may be gone: it is looked for again next time)
        Err(_) => { forget(); return Err("ScreenCaptureKit did not answer".into()); }
    };
    let (iw, ih) = (CGImage::width(Some(&image)), CGImage::height(Some(&image)));
    let (bpr, bpp) = (CGImage::bytes_per_row(Some(&image)), CGImage::bits_per_pixel(Some(&image)));
    if bpp != 32 || iw == 0 || ih == 0 { return Err(format!("unexpected picture {iw}x{ih} with {bpp} bits")); }
    let (cx, cy, w, h) = (cx as usize, cy as usize, w as usize, h as usize);
    if cx + w > iw || cy + h > ih { return Err(format!("the picture of the window is {iw}x{ih}: the part does not fit")); }
    let provider = CGImage::data_provider(Some(&image)).ok_or("the picture has no data")?;
    let data = CGDataProvider::data(Some(&provider)).ok_or("the picture has no data")?;
    let bytes = unsafe { data.as_bytes_unchecked() };
    if bytes.len() < bpr * (ih - 1) + iw * 4 { return Err("the picture is smaller than it says".into()); }
    let mut out = vec![0u8; 8 + w * h * 4];
    out[0..4].copy_from_slice(&(w as u32).to_le_bytes());
    out[4..8].copy_from_slice(&(h as u32).to_le_bytes());
    for row in 0..h {
        let s = (cy + row) * bpr + cx * 4;
        out[8 + row * w * 4..8 + (row + 1) * w * 4].copy_from_slice(&bytes[s..s + w * 4]);
    }
    Ok(out)
}
