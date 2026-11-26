//! Windows OCR (Windows.Media.Ocr, the text recognition of Windows itself): the letters of a small picture, for the OCR assist (docs/HANDOFF.md 4-0j). The picture comes from the web page as BGRA bytes (base64
//! in the call), already made ready there (larger, light ground, dark letters). The engine reads in the languages whose language packs are installed in Windows ("Text recognition" of the pack must be on);
//! with no language asked it takes the first language of the user's profile that Windows can read. The engine is kept between the calls (making it is the slow part).
//! The base64 decoding is here for every system (the call exists everywhere; the reading is for Windows).

/// base64 -> bytes (the standard alphabet, `=` padding, white space allowed)
#[cfg_attr(not(windows), allow(dead_code))]      // (the call is made on every system, the reading is for Windows)
pub fn decode_base64(text: &str) -> Result<Vec<u8>, String> {
    fn val(c: u8) -> Option<u32> {
        match c { b'A'..=b'Z' => Some((c - b'A') as u32), b'a'..=b'z' => Some((c - b'a') as u32 + 26), b'0'..=b'9' => Some((c - b'0') as u32 + 52), b'+' | b'-' => Some(62), b'/' | b'_' => Some(63), _ => None }
    }
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in text.bytes() {
        if c == b'=' || c == b'\n' || c == b'\r' || c == b' ' { continue; }
        let v = val(c).ok_or_else(|| "the picture is not base64".to_string())?;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 { bits -= 8; out.push(((acc >> bits) & 0xff) as u8); acc &= (1 << bits) - 1; }
    }
    Ok(out)
}

#[cfg(windows)]
mod imp {
    use std::sync::Mutex;
    use windows::core::HSTRING;
    use windows::Globalization::Language;
    use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::Streams::{DataWriter, InMemoryRandomAccessStream};
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

    struct Cached { lang: String, engine: OcrEngine }
    // (the engine is used only while ENGINE is locked: one thread at a time)
    unsafe impl Send for Cached {}
    static ENGINE: Mutex<Option<Cached>> = Mutex::new(None);

    fn err<E: std::fmt::Display>(what: &str) -> impl FnOnce(E) -> String + '_ { move |e| format!("{what}: {e}") }

    fn make_engine(lang: &str) -> Result<OcrEngine, String> {
        if lang.is_empty() {
            OcrEngine::TryCreateFromUserProfileLanguages().map_err(err("Windows OCR has no language pack for the languages of this user (Settings > Time & language > Language & region)"))
        } else {
            let language = Language::CreateLanguage(&HSTRING::from(lang)).map_err(err("the language tag"))?;
            if !OcrEngine::IsLanguageSupported(&language).unwrap_or(false) { return Err(format!("Windows OCR cannot read the language {lang} (its language pack is not installed, or its text recognition is off)")); }
            OcrEngine::TryCreateFromLanguage(&language).map_err(err("Windows OCR"))
        }
    }

    /// The letters of the picture (BGRA, `width` x `height`), the lines joined by a space. `lang`: a language tag ("ko", "en-US") or "" for the languages of the user.
    pub fn recognize(bgra: &[u8], width: u32, height: u32, lang: &str) -> Result<String, String> {
        unsafe { let _ = CoInitializeEx(None, COINIT_MULTITHREADED); }
        if width == 0 || height == 0 || bgra.len() != (width as usize) * (height as usize) * 4 { return Err("the picture does not fit its size".into()); }
        let max = OcrEngine::MaxImageDimension().unwrap_or(10000);
        if width > max || height > max { return Err(format!("the picture is too large for Windows OCR ({width}x{height}, at most {max})")); }
        let stream = InMemoryRandomAccessStream::new().map_err(err("stream"))?;
        let writer = DataWriter::CreateDataWriter(&stream).map_err(err("writer"))?;
        writer.WriteBytes(bgra).map_err(err("write"))?;
        let buffer = writer.DetachBuffer().map_err(err("buffer"))?;
        let bitmap = SoftwareBitmap::CreateCopyFromBuffer(&buffer, BitmapPixelFormat::Bgra8, width as i32, height as i32).map_err(err("bitmap"))?;
        let mut guard = ENGINE.lock().map_err(|_| "Windows OCR is busy".to_string())?;
        let lang = lang.trim();
        if guard.as_ref().map(|c| c.lang != lang).unwrap_or(true) { *guard = Some(Cached { lang: lang.to_string(), engine: make_engine(lang)? }); }
        let engine = &guard.as_ref().ok_or("no engine")?.engine;
        let result = engine.RecognizeAsync(&bitmap).map_err(err("recognize"))?.get().map_err(err("recognize"))?;
        let mut out: Vec<String> = Vec::new();
        for line in result.Lines().map_err(err("lines"))? { out.push(line.Text().map_err(err("text"))?.to_string()); }
        Ok(out.join(" "))
    }

    /// Makes the engine for the language now and reads a small blank picture with it, so that the first real reading does not wait for the language data to be loaded ("resident", and the start of a restriction).
    pub fn warm(lang: &str) -> Result<(), String> {
        unsafe { let _ = CoInitializeEx(None, COINIT_MULTITHREADED); }
        let lang = lang.trim();
        {
            let mut guard = ENGINE.lock().map_err(|_| "Windows OCR is busy".to_string())?;
            if guard.as_ref().map(|c| c.lang != lang).unwrap_or(true) { *guard = Some(Cached { lang: lang.to_string(), engine: make_engine(lang)? }); }
        }
        recognize(&vec![255u8; 64 * 64 * 4], 64, 64, lang).map(|_| ())
    }

    /// Lets the engine go (the memory it holds is given back: "only when needed", and when the OCR is turned off).
    pub fn release() { if let Ok(mut g) = ENGINE.lock() { *g = None; } }

    /// The languages Windows can read now (language tags), and the one it takes for the user.
    pub fn languages() -> Result<(Vec<String>, String), String> {
        unsafe { let _ = CoInitializeEx(None, COINIT_MULTITHREADED); }
        let mut tags = Vec::new();
        for l in OcrEngine::AvailableRecognizerLanguages().map_err(err("languages"))? { tags.push(l.LanguageTag().map_err(err("tag"))?.to_string()); }
        let current = OcrEngine::TryCreateFromUserProfileLanguages().ok().and_then(|e| e.RecognizerLanguage().ok()).and_then(|l| l.LanguageTag().ok()).map(|t| t.to_string()).unwrap_or_default();
        Ok((tags, current))
    }
}
#[cfg(windows)]
pub use imp::{languages, recognize, release, warm};

#[cfg(test)]
mod tests {
    use super::decode_base64;
    #[test]
    fn base64_decodes() {
        assert_eq!(decode_base64("").unwrap(), b"");
        assert_eq!(decode_base64("TWFu").unwrap(), b"Man");
        assert_eq!(decode_base64("TWE=").unwrap(), b"Ma");
        assert_eq!(decode_base64("TQ==").unwrap(), b"M");
        assert_eq!(decode_base64("TWFu\nTWE=").unwrap(), b"ManMa");
        assert!(decode_base64("T*Fu").is_err());
    }
}
