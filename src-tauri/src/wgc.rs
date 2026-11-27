//! Windows Graphics Capture of ONE window: the game. The picture is the window's own (what the game drew), so nothing that stands over it on the screen is in it: not the task bar, not another window, not
//! our own translation windows. `capture(hwnd, x, y, w, h)` answers like `win::capture` (the same rectangle in SCREEN pixels, 8 bytes of header + BGRA), so the readers need no other code; what lies outside the window
//! is black. Only the asked rectangle is copied from the graphics card (a game window can be 4K).
//!
//! One session is kept for the window (a new one when the window is another): the newest picture of the window is kept in a texture of our own, and the rectangle is cut out of it at every call.
//! A window that does not change sends no new pictures: the last one stays. Nothing is written anywhere.
use std::ffi::c_void;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use windows::core::{factory, Interface};
use windows::core::HSTRING;
use windows::Foundation::Metadata::ApiInformation;
use windows::Graphics::Capture::{Direct3D11CaptureFramePool, GraphicsCaptureAccess, GraphicsCaptureAccessKind, GraphicsCaptureItem, GraphicsCaptureSession};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Win32::Foundation::{HMODULE, HWND, RECT};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, D3D11_BOX, D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAP_READ, D3D11_MAPPED_SUBRESOURCE,
    D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
use windows::Win32::System::WinRT::Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;

const FORMAT: DirectXPixelFormat = DirectXPixelFormat::B8G8R8A8UIntNormalized;
const FIRST_FRAME_WAIT: Duration = Duration::from_millis(700);

struct Session {
    hwnd: isize,
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    d3d: IDirect3DDevice,
    pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
    size: (i32, i32),
    latest: Option<ID3D11Texture2D>,                     // a copy of the newest picture of the window
    stage: Option<((u32, u32), ID3D11Texture2D)>,        // where the asked rectangle is read from
    frames: u64,                                         // how many pictures were taken into `latest` (the blur of the translation windows draws only when this has moved)
}
// (the objects are used only while SESSION is locked: one thread at a time)
unsafe impl Send for Session {}
static SESSION: Mutex<Option<Session>> = Mutex::new(None);
/// What happened to the yellow frame the last time a session was made (for the log and the test of the options).
static BORDER: Mutex<String> = Mutex::new(String::new());

/// Can this Windows switch the yellow frame of a capture off? It can from Windows 11 (the property `IsBorderRequired` is there); on Windows 10 the frame cannot be removed (the capture is used there all the same).
pub fn can_hide_border() -> bool {
    unsafe { let _ = CoInitializeEx(None, COINIT_MULTITHREADED); }
    ApiInformation::IsPropertyPresent(&HSTRING::from("Windows.Graphics.Capture.GraphicsCaptureSession"), &HSTRING::from("IsBorderRequired")).unwrap_or(false)
}
pub fn border_status() -> String { BORDER.lock().map(|b| b.clone()).unwrap_or_default() }

fn err<E: std::fmt::Display>(what: &str) -> impl FnOnce(E) -> String + '_ { move |e| format!("{what}: {e}") }

impl Session {
    fn open(hwnd: isize) -> Result<Session, String> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>().map_err(err("graphics capture is not available"))?;
            let item: GraphicsCaptureItem = interop.CreateForWindow(HWND(hwnd as *mut c_void)).map_err(err("the window cannot be captured"))?;
            let (mut device, mut context) = (None, None);
            D3D11CreateDevice(None, D3D_DRIVER_TYPE_HARDWARE, HMODULE::default(), D3D11_CREATE_DEVICE_BGRA_SUPPORT, None, D3D11_SDK_VERSION, Some(&mut device), None, Some(&mut context))
                .map_err(err("no graphics device"))?;
            let (device, context) = (device.ok_or("no graphics device")?, context.ok_or("no graphics context")?);
            let dxgi: IDXGIDevice = device.cast().map_err(err("no dxgi device"))?;
            let d3d: IDirect3DDevice = CreateDirect3D11DeviceFromDXGIDevice(&dxgi).map_err(err("no winrt device"))?.cast().map_err(err("no winrt device"))?;
            let size = item.Size().map_err(err("no window size"))?;
            let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(&d3d, FORMAT, 2, size).map_err(err("no frame pool"))?;
            let session = pool.CreateCaptureSession(&item).map_err(err("no capture session"))?;
            let _ = session.SetIsCursorCaptureEnabled(false);          // (the mouse pointer is not a part of the picture)
            // The yellow frame around the game: where the system has the switch (Windows 11) it is asked for the way OBS does it (the access first, then the switch); where it has not (Windows 10) the frame stays and
            // the capture goes on all the same. What happened is kept for the log and the test (border_status).
            let status = if can_hide_border() {
                let access = GraphicsCaptureAccess::RequestAccessAsync(GraphicsCaptureAccessKind::Borderless).and_then(|a| a.get());
                let set = session.SetIsBorderRequired(false);
                let still = session.IsBorderRequired().unwrap_or(true);
                format!("Windows 11 switch: access {:?}, switch {:?}; the frame is {}", access.as_ref().map(|s| s.0).map_err(|e| e.to_string()), set.as_ref().map_err(|e| e.to_string()), if still { "still on" } else { "off" })
            } else {
                "this Windows has no switch for the yellow frame (Windows 10): the frame stays".to_string()
            };
            if let Ok(mut b) = BORDER.lock() { *b = status; }
            session.StartCapture().map_err(err("the capture did not start"))?;
            Ok(Session { hwnd, device, context, d3d, pool, session, size: (size.Width, size.Height), latest: None, stage: None, frames: 0 })
        }
    }

    /// Takes the pictures that have come and keeps the newest one. Ok(true): there is a picture to read.
    fn refresh(&mut self) -> Result<bool, String> {
        unsafe {
            let mut newest = None;
            while let Ok(frame) = self.pool.TryGetNextFrame() {
                if let Some(old) = newest.replace(frame) { let _ = old.Close(); }
            }
            let Some(frame) = newest else { return Ok(self.latest.is_some()) };
            let content = frame.ContentSize().map_err(err("no picture size"))?;
            if (content.Width, content.Height) != self.size {                       // the window was made larger or smaller: the pool is made again, the next picture is the right size
                self.size = (content.Width, content.Height);
                let _ = frame.Close();
                self.pool.Recreate(&self.d3d, FORMAT, 2, content).map_err(err("the frame pool could not be made again"))?;
                self.latest = None; self.stage = None;
                return Ok(false);
            }
            let access: IDirect3DDxgiInterfaceAccess = frame.Surface().map_err(err("no surface"))?.cast().map_err(err("no surface"))?;
            let tex: ID3D11Texture2D = access.GetInterface().map_err(err("no texture"))?;
            let mut desc = D3D11_TEXTURE2D_DESC::default();
            tex.GetDesc(&mut desc);
            let keep = match &self.latest { Some(t) => { let mut d = D3D11_TEXTURE2D_DESC::default(); t.GetDesc(&mut d); d.Width == desc.Width && d.Height == desc.Height } None => false };
            if !keep {
                let mut mine = D3D11_TEXTURE2D_DESC { Usage: D3D11_USAGE_DEFAULT, BindFlags: 0, CPUAccessFlags: 0, MiscFlags: 0, ..desc };
                mine.MipLevels = 1; mine.ArraySize = 1;
                let mut t = None;
                self.device.CreateTexture2D(&mine, None, Some(&mut t)).map_err(err("no texture of our own"))?;
                self.latest = t;
            }
            if let Some(t) = &self.latest { self.context.CopyResource(t, &tex); self.frames += 1; }
            let _ = frame.Close();
            Ok(self.latest.is_some())
        }
    }

    /// The rectangle (x, y, w, h) of the picture of the window, copied into `out` (w * h * 4 bytes, BGRA, the place of the pixel (px, py) of the picture is (px - x, py - y)).
    fn read(&mut self, x: i32, y: i32, w: i32, h: i32, out: &mut [u8]) -> Result<(), String> {
        unsafe {
            let Some(latest) = self.latest.clone() else { return Ok(()) };
            let mut desc = D3D11_TEXTURE2D_DESC::default();
            latest.GetDesc(&mut desc);
            let (tw, th) = (desc.Width as i32, desc.Height as i32);
            let (sx0, sy0, sx1, sy1) = (x.max(0), y.max(0), (x + w).min(tw), (y + h).min(th));
            if sx1 <= sx0 || sy1 <= sy0 { return Ok(()); }                          // (nothing of the rectangle is in the window: black)
            let (cw, ch) = ((sx1 - sx0) as u32, (sy1 - sy0) as u32);
            if self.stage.as_ref().map(|(s, _)| *s) != Some((cw, ch)) {
                let sd = D3D11_TEXTURE2D_DESC { Width: cw, Height: ch, MipLevels: 1, ArraySize: 1, Usage: D3D11_USAGE_STAGING, BindFlags: 0, CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32, MiscFlags: 0, ..desc };
                let mut t = None;
                self.device.CreateTexture2D(&sd, None, Some(&mut t)).map_err(err("no texture to read from"))?;
                self.stage = t.map(|t| ((cw, ch), t));
            }
            let Some((_, stage)) = &self.stage else { return Ok(()) };
            let region = D3D11_BOX { left: sx0 as u32, top: sy0 as u32, front: 0, right: sx1 as u32, bottom: sy1 as u32, back: 1 };
            self.context.CopySubresourceRegion(stage, 0, 0, 0, 0, &latest, 0, Some(&region));
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            self.context.Map(stage, 0, D3D11_MAP_READ, 0, Some(&mut mapped)).map_err(err("the picture could not be read"))?;
            let (pitch, base) = (mapped.RowPitch as usize, mapped.pData as *const u8);
            for row in 0..ch as usize {
                let src = std::slice::from_raw_parts(base.add(row * pitch), cw as usize * 4);
                let at = (((sy0 - y) as usize + row) * w as usize + (sx0 - x) as usize) * 4;
                out[at..at + cw as usize * 4].copy_from_slice(src);
            }
            self.context.Unmap(stage, 0);
            Ok(())
        }
    }
}

/// Where the picture of the window starts on the screen (the frame without its invisible border: the picture and this are the same rectangle).
fn frame_origin(hwnd: isize) -> Result<(i32, i32), String> {
    let mut r = RECT::default();
    unsafe { DwmGetWindowAttribute(HWND(hwnd as *mut c_void), DWMWA_EXTENDED_FRAME_BOUNDS, &mut r as *mut RECT as *mut c_void, std::mem::size_of::<RECT>() as u32) }
        .map_err(err("the place of the window is not known"))?;
    Ok((r.left, r.top))
}

/// The rectangle (screen pixels) of the game window `hwnd`: 8 bytes header (width, height as u32 little endian) + width*height*4 bytes BGRA, like win::capture. A rectangle (or a part of it) outside the window is black.
pub fn capture(hwnd: isize, x: i32, y: i32, w: i32, h: i32) -> Result<Vec<u8>, String> {
    if w <= 0 || h <= 0 || w > 16384 || h > 16384 { return Err(format!("bad size {w}x{h}")); }
    if !GraphicsCaptureSession::IsSupported().unwrap_or(false) { return Err("this Windows has no capture of a window (Windows 10 version 1903 or later is needed)".into()); }
    let mut out = vec![0u8; 8 + (w as usize) * (h as usize) * 4];
    out[0..4].copy_from_slice(&(w as u32).to_le_bytes());
    out[4..8].copy_from_slice(&(h as u32).to_le_bytes());
    let (ox, oy) = frame_origin(hwnd)?;
    let mut guard = SESSION.lock().map_err(|_| "the capture is locked")?;
    if guard.as_ref().map(|s| s.hwnd) != Some(hwnd) { *guard = None; *guard = Some(Session::open(hwnd)?); }
    let s = guard.as_mut().ok_or("no capture session")?;
    let started = Instant::now();
    loop {
        if s.refresh()? { break; }
        if started.elapsed() > FIRST_FRAME_WAIT { *guard = None; return Err("the window sent no picture (minimized, or a mode of the game that cannot be captured)".into()); }
        std::thread::sleep(Duration::from_millis(8));
    }
    let s = guard.as_mut().ok_or("no capture session")?;
    s.read(x - ox, y - oy, w, h, &mut out[8..])?;
    Ok(out)
}

/// Gives `f` the newest picture of the window (a texture of the graphics card that is NOT read back to the processor) with the device and context it lives on, and where the picture starts on the
/// screen (the same origin `capture` uses), and how many pictures the session has taken so far (it is the same number as long as the window has sent nothing new). The capture session is kept as it is (opened here if it is not there). The session is locked while `f` runs: keep it short.
/// (For the blur of the translation windows, docs/HANDOFF.md 4-0aq.)
pub fn with_frame<R>(hwnd: isize, f: impl FnOnce(&ID3D11Device, &ID3D11DeviceContext, &ID3D11Texture2D, (i32, i32), u64) -> Result<R, String>) -> Result<R, String> {
    if !GraphicsCaptureSession::IsSupported().unwrap_or(false) { return Err("this Windows has no capture of a window (Windows 10 version 1903 or later is needed)".into()); }
    let origin = frame_origin(hwnd)?;
    let mut guard = SESSION.lock().map_err(|_| "the capture is locked")?;
    if guard.as_ref().map(|s| s.hwnd) != Some(hwnd) { *guard = None; *guard = Some(Session::open(hwnd)?); }
    let started = Instant::now();
    loop {
        let s = guard.as_mut().ok_or("no capture session")?;
        if s.refresh()? { break; }
        if started.elapsed() > FIRST_FRAME_WAIT { *guard = None; return Err("the window sent no picture (minimized, or a mode of the game that cannot be captured)".into()); }
        std::thread::sleep(Duration::from_millis(8));
    }
    let s = guard.as_mut().ok_or("no capture session")?;
    let latest = s.latest.clone().ok_or("no picture")?;
    f(&s.device, &s.context, &latest, origin, s.frames)
}

/// Ends the capture session (the option is off, or the game is gone).
pub fn stop() { if let Ok(mut g) = SESSION.lock() { if let Some(s) = g.take() { let _ = s.session.Close(); } } }
