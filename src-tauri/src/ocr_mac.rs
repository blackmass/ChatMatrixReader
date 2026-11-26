//! macOS Vision OCR (docs/HANDOFF.md 4-0al): the letters of a picture, with Apple's text recognition (`VNRecognizeTextRequest`, macOS 12 or later; Korean needs 13). The commands `ocr_vision`
//! and `ocr_vision_info` of main.rs. The picture comes from the web page as a PNG in base64 (like the pictures of the AI reader): Vision reads the file as it is, no pixel format is made here.
//! The language list is the one of the options (`ocr_win_lang`, shared with Windows OCR: "ko, en-US"); a language Vision cannot read is left out, and with none left Vision finds the language itself.
//! The lines come from the top to the bottom, the parts of a line from the left to the right. There is no engine to start or to let go (Vision makes its own), and no permission is needed.
use objc2::rc::{autoreleasepool, Retained};
use objc2::runtime::NSObjectProtocol;
use objc2::{sel, AnyThread};
use objc2_foundation::{NSArray, NSData, NSDataBase64DecodingOptions, NSDictionary, NSString};
use objc2_vision::{VNImageRequestHandler, VNRecognizeTextRequest, VNRecognizedTextObservation, VNRequest, VNRequestTextRecognitionLevel};

fn strings(a: &NSArray<NSString>) -> Vec<String> { a.iter().map(|s| s.to_string()).collect() }

/// A picture file in base64 (what the web page sends) -> the bytes as an `NSData`.
pub fn decode_base64(b64: &str) -> Result<Retained<NSData>, String> {
    NSData::initWithBase64EncodedString_options(NSData::alloc(), &NSString::from_str(b64.trim()), NSDataBase64DecodingOptions::empty()).ok_or_else(|| "the picture is not base64".to_string())
}

/// The languages Vision can read now (the newest revision of the request knows).
pub fn languages() -> Result<Vec<String>, String> {
    autoreleasepool(|_| {
        let request = VNRecognizeTextRequest::new();
        let langs = unsafe { request.supportedRecognitionLanguagesAndReturnError() }.map_err(|e| e.localizedDescription().to_string())?;
        Ok(strings(&langs))
    })
}

/// Chooses from the languages that are wanted (a list "ko, en-US"; empty = Korean and English) those that Vision can read: "ko" matches "ko-KR".
fn pick(wanted: &str, have: &[String]) -> Vec<String> {
    let want: Vec<String> = if wanted.trim().is_empty() { vec!["ko-KR".into(), "en-US".into()] } else { wanted.split([',', ';', ' ']).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect() };
    let mut out: Vec<String> = Vec::new();
    for w in want {
        let wl = w.to_lowercase();
        for h in have {
            let hl = h.to_lowercase();
            if (hl == wl || hl.starts_with(&format!("{wl}-"))) && !out.contains(h) { out.push(h.clone()); }
        }
    }
    out
}

/// The letters of a picture file (PNG, JPEG ...: what the `NSData` holds) -> the text, the lines from the top to the bottom, the parts of one line from the left to the right (a line break between the lines).
pub fn recognize(data: &NSData, lang: &str) -> Result<String, String> {
    if data.is_empty() { return Err("no picture".into()); }
    autoreleasepool(|_| {
        let handler = VNImageRequestHandler::initWithData_options(VNImageRequestHandler::alloc(), data, &NSDictionary::new());
        let request = VNRecognizeTextRequest::new();
        request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
        request.setUsesLanguageCorrection(true);
        let have = unsafe { request.supportedRecognitionLanguagesAndReturnError() }.map(|a| strings(&a)).unwrap_or_default();
        let chosen = pick(lang, &have);
        if !chosen.is_empty() {
            let list: Vec<Retained<NSString>> = chosen.iter().map(|s| NSString::from_str(s)).collect();
            request.setRecognitionLanguages(&NSArray::from_retained_slice(&list));
        } else if request.respondsToSelector(sel!(setAutomaticallyDetectsLanguage:)) {                       // (macOS 13: the language is found by Vision itself)
            request.setAutomaticallyDetectsLanguage(true);
        }
        let as_request: Retained<VNRequest> = request.clone().into_super().into_super();
        handler.performRequests_error(&NSArray::from_retained_slice(&[as_request])).map_err(|e| e.localizedDescription().to_string())?;
        let Some(results) = request.results() else { return Ok(String::new()) };
        // (x, y of the middle, height, text) of every piece; Vision counts y from the bottom
        let mut items: Vec<(f64, f64, f64, String)> = Vec::new();
        for obs in results.iter() {
            let obs: &VNRecognizedTextObservation = &obs;
            let cands = obs.topCandidates(1);
            let Some(best) = cands.iter().next() else { continue };
            let text = best.string().to_string();
            if text.trim().is_empty() { continue; }
            let b = unsafe { obs.boundingBox() };
            items.push((b.origin.x, b.origin.y + b.size.height / 2.0, b.size.height, text));
        }
        items.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        let mut lines: Vec<(f64, f64, Vec<(f64, String)>)> = Vec::new();                  // (y of the middle, height, [(x, text)])
        for (x, y, h, t) in items {
            match lines.last_mut() {
                Some(l) if (l.0 - y).abs() < 0.5 * l.1.max(h) => { l.2.push((x, t)); }
                _ => lines.push((y, h, vec![(x, t)])),
            }
        }
        let out: Vec<String> = lines.into_iter().map(|mut l| { l.2.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal)); l.2.into_iter().map(|p| p.1).collect::<Vec<_>>().join(" ") }).collect();
        Ok(out.join("\n"))
    })
}
