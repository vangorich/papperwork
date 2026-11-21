#[path = "ocr_refine.rs"]
mod refine;
use self::refine::{Hit, Map, Supplemental};
use super::{Res, MAX_OCR_PIXELS};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Instant;
use windows::{
    Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap},
    Media::Ocr::OcrEngine,
    Storage::Streams::DataWriter,
};

const ENGINE: &str = "Windows.Media.Ocr";
// WinRT activation factories may remain cached after each command. Uninitializing the last
// MTA between requests invalidates those factories. Hold exactly one usage cookie for the
// native process lifetime, just like the factories; Windows releases it on process teardown.
fn ensure_runtime() -> Res<()> {
    use std::sync::OnceLock;
    use windows::Win32::System::Com::CoIncrementMTAUsage;
    static MTA: OnceLock<Result<usize, String>> = OnceLock::new();
    let pinned = MTA.get_or_init(|| {
        // SAFETY: no pointers are supplied, the returned cookie is retained and never dereferenced.
        unsafe { CoIncrementMTAUsage() }
            .map(|cookie| cookie.0 as usize)
            .map_err(|e| e.to_string())
    });
    match pinned {
        Ok(_) => Ok(()),
        Err(e) => Err(e.clone().into()),
    }
}
fn languages() -> Res<Vec<String>> {
    let langs = OcrEngine::AvailableRecognizerLanguages()?;
    let mut names = Vec::new();
    for i in 0..langs.Size()? {
        names.push(langs.GetAt(i)?.LanguageTag()?.to_string())
    }
    Ok(names)
}
fn engine() -> Res<OcrEngine> {
    if let Ok(e) = OcrEngine::TryCreateFromUserProfileLanguages() {
        return Ok(e);
    }
    let langs = OcrEngine::AvailableRecognizerLanguages()?;
    if langs.Size()? != 0 {
        return Ok(OcrEngine::TryCreateFromLanguage(&langs.GetAt(0)?)?);
    }
    Err("未安装 Windows OCR 语言包。请在 Windows 设置 → 时间和语言 → 语言和区域中安装文字识别功能。".into())
}
pub(super) fn status() -> Value {
    let result = (|| -> Res<String> {
        ensure_runtime()?;
        let e = engine()?;
        let lang = e.RecognizerLanguage()?;
        let tag = lang.LanguageTag()?.to_string();
        Ok(tag)
    })();
    match result {
        Ok(tag) => {
            json!({"engine":ENGINE,"model":format!("Windows OCR ({tag})"),"available":true,"ready":true,"loading":false})
        }
        Err(e) => {
            json!({"engine":ENGINE,"model":"Windows OCR","available":false,"ready":false,"loading":false,"error":e.to_string()})
        }
    }
}
pub(super) fn capabilities() -> Value {
    let langs = (|| -> Res<Vec<String>> {
        ensure_runtime()?;
        languages()
    })()
    .unwrap_or_default();
    json!({"engine":ENGINE,"model":"Windows OCR","local":!langs.is_empty(),"languages":langs,"modes":["auto","printed"],"input":"rgba","maxPixels":MAX_OCR_PIXELS,"models":langs.iter().map(|tag|json!({"id":format!("windows-ocr-{tag}"),"label":tag,"role":"printed","available":true})).collect::<Vec<_>>()})
}
#[derive(Deserialize)]
struct Input {
    width: usize,
    height: usize,
    mode: String,
}
struct Pass {
    words: Vec<Hit>,
    text: String,
    angle: f64,
}

// WinRT boxes are in the deskewed image's frame. Compose its reported angle
// with the crop/scale transform exactly once; WinRT objects do not outlive a pass.
fn run_engine(engine: &OcrEngine, gray: &[u8], w: usize, h: usize, to_page: Map) -> Res<Pass> {
    let writer = DataWriter::new()?;
    writer.WriteBytes(gray)?;
    let bitmap = SoftwareBitmap::CreateCopyFromBuffer(
        &writer.DetachBuffer()?,
        BitmapPixelFormat::Gray8,
        w as i32,
        h as i32,
    )?;
    let output = engine.RecognizeAsync(&bitmap)?.get()?;
    let angle = output.TextAngle().and_then(|v| v.Value()).unwrap_or(0.);
    if !angle.is_finite() {
        return Err("OCR 引擎返回了无效角度".into());
    }
    let map = Map::rotation(angle, w as f64 / 2., h as f64 / 2.);
    let mut words = Vec::new();
    let mut text = Vec::new();
    for line in output.Lines()? {
        text.push(line.Text()?.to_string());
        for word in line.Words()? {
            if words.len() >= 64_000 {
                return Err("单页 OCR 词数过多，请裁剪后重试".into());
            }
            let b = word.BoundingRect()?;
            if !(b.Width > 0. && b.Height > 0. && (b.X + b.Y + b.Width + b.Height).is_finite()) {
                continue;
            }
            let l = f64::from(b.X);
            let t = f64::from(b.Y);
            let r = l + f64::from(b.Width);
            let bottom = t + f64::from(b.Height);
            let pts = [(l, t), (r, t), (r, bottom), (l, bottom)].map(|(x, y)| {
                let (u, v) = map.point(x, y);
                to_page.point(u, v)
            });
            let value = word.Text()?.to_string();
            if !value.trim().is_empty() {
                words.push(Hit::new(value, pts))
            }
        }
    }
    Ok(Pass {
        words,
        text: text.join("\n"),
        angle,
    })
}
fn installed_engine(prefix: &str) -> Option<OcrEngine> {
    for lang in OcrEngine::AvailableRecognizerLanguages().ok()? {
        if lang
            .LanguageTag()
            .ok()?
            .to_string()
            .split('-')
            .next()
            .is_some_and(|v| v.eq_ignore_ascii_case(prefix))
        {
            if let Ok(e) = OcrEngine::TryCreateFromLanguage(&lang) {
                return Some(e);
            }
        }
    }
    None
}
fn output_word(hit: Hit, sx: f64, sy: f64) -> Value {
    let p = hit.pts.map(|(x, y)| (x * sx, y * sy));
    let b = hit.rect;
    let angle = (p[1].1 - p[0].1).atan2(p[1].0 - p[0].0).to_degrees();
    json!({"text":hit.text,"confidence":0,"box":{"x":b.l*sx,"y":b.t*sy,"width":(b.r-b.l)*sx,"height":(b.b-b.t)*sy,"rotation":angle,"points":p.map(|(x,y)|json!({"x":x,"y":y}))}})
}
pub(super) fn recognize(meta: &str, rgba: &[u8]) -> Res<Value> {
    let Input {
        width,
        height,
        mode,
    } = serde_json::from_str(meta)?;
    if !matches!(mode.as_str(), "printed" | "auto") {
        return Err("Windows 离线 OCR 仅支持印刷文本，不支持专用手写或版式模型".into());
    }
    if width == 0
        || height == 0
        || width > 32_768
        || height > 32_768
        || width * height > MAX_OCR_PIXELS
        || rgba.len() != width * height * 4
    {
        return Err("OCR 图像尺寸或 RGBA 字节数无效（最大 2200 万像素）".into());
    }
    let started = Instant::now();
    ensure_runtime()?;
    let engine = engine()?;
    let tag = engine.RecognizerLanguage()?.LanguageTag()?.to_string();
    let limit = OcrEngine::MaxImageDimension()? as usize;
    if limit == 0 {
        return Err("Windows OCR 不可用".into());
    }
    let k = (limit as f64 / width.max(height) as f64).min(1.0);
    let w = ((width as f64 * k).round() as usize).max(1);
    let h = ((height as f64 * k).round() as usize).max(1);
    let mut gray = Vec::with_capacity(w * h);
    for y in 0..h {
        let row = (y * height / h) * width;
        for x in 0..w {
            let i = 4 * (row + x * width / w);
            let p = &rgba[i..i + 4];
            let lum =
                (77 * u32::from(p[0]) + 150 * u32::from(p[1]) + 29 * u32::from(p[2]) + 128) / 256;
            let a = u32::from(p[3]);
            gray.push(((lum * a + 255 * (255 - a) + 127) / 255) as u8)
        }
    }
    let first = run_engine(&engine, &gray, w, h, Map::ID)?;
    let raw = first.text;
    let mut words = first.words;
    let mut region_calls = 0;
    let mut recovered = 0;
    let mut second_language = None;
    let mut warnings =
        vec!["Windows OCR 不提供置信度；0 表示未提供评分，而非识别准确率。".to_string()];
    if !words.is_empty() && words.len() <= 12_000 && w * h <= 10_000_000 && first.angle.abs() <= 15.
    {
        // Restrict the optional pixel analysis to printed pages within a bounded budget.
        // Large/dense pages, unsupported orientations and additional engine errors keep
        // the original result; never reject or replace the page just because refinement failed.
        let upright =
            (first.angle.abs() >= 0.5).then(|| refine::upright(&gray, w, h, first.angle, limit));
        let (plane, pw, ph, map) = upright
            .as_ref()
            .map(|(v, x, y, m)| (v.as_slice(), *x, *y, *m))
            .unwrap_or((&gray, w, h, Map::ID));
        let (gaps, em) = refine::missing_ink(plane, pw, ph, &words, map);
        let cjk = tag.to_ascii_lowercase().starts_with("zh");
        let english = tag.to_ascii_lowercase().starts_with("en");
        let supplemental = if cjk
            && words
                .iter()
                .filter(|v| v.text.bytes().any(|c| c.is_ascii_alphanumeric()))
                .take(3)
                .count()
                >= 3
        {
            Some(("en", Supplemental::Latin))
        } else if english && !gaps.is_empty() {
            Some(("zh", Supplemental::Han))
        } else {
            None
        };
        let mut budget = 1_500_000usize;
        for gap in gaps.iter().take(6) {
            let (crop, cw, ch, m) = refine::crop(plane, pw, ph, *gap, em, true, map);
            if cw > limit || ch > limit || cw * ch > budget {
                continue;
            }
            budget -= cw * ch;
            region_calls += 1;
            let before = words.len();
            if let Ok(pass) = run_engine(&engine, &crop, cw, ch, m) {
                refine::add_missing(&mut words, pass.words, *gap, map, em);
            }
            // A small tilted field can be missed on the first smoothed crop. Only
            // retry a real unexplained patch, from a wider, unsharpened view.
            if words.len() == before && upright.is_some() && region_calls < 7 {
                if let Some((view, vw, vh, transform)) =
                    refine::context_retry(plane, pw, ph, *gap, em, map, limit, budget)
                {
                    budget -= vw * vh;
                    region_calls += 1;
                    if let Ok(pass) = run_engine(&engine, &view, vw, vh, transform) {
                        refine::add_missing(&mut words, pass.words, *gap, map, em);
                    }
                }
            }
            recovered += words.len() - before;
        }
        if let Some((prefix, script)) = supplemental {
            if let Some(alt) = installed_engine(prefix) {
                if let Ok(pass) = run_engine(&alt, &gray, w, h, Map::ID) {
                    refine::merge_script(&mut words, pass.words, script, w, h);
                    second_language = alt
                        .RecognizerLanguage()
                        .and_then(|v| v.LanguageTag())
                        .ok()
                        .map(|s| s.to_string());
                }
            }
        }
        if recovered > 0 {
            warnings.push(format!(
                "已从未覆盖的文字区域补识 {recovered} 个词块，请核对小字。"
            ));
        }
    }
    let items = words
        .into_iter()
        .map(|v| output_word(v, width as f64 / w as f64, height as f64 / h as f64))
        .collect::<Vec<_>>();
    // `text` preserves the engine's raw transcript; the editor constructs its
    // authoritative reading/clipboard/search text from the positioned, refined items.
    Ok(
        json!({"text":raw,"rawText":raw,"confidence":0,"items":items,"mode":mode,"elapsedMs":started.elapsed().as_millis() as u64,"engine":ENGINE,"model":format!("Windows OCR ({tag})"),"documentType":"printed","warnings":warnings,"refinement":{"regionCalls":region_calls,"recoveredWords":recovered,"supplementalLanguage":second_language}}),
    )
}
