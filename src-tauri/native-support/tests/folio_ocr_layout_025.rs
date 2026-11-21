//! Test adapter for scripts/verify-win-ocr-layout-025.cjs. No language preferences are changed.
#![cfg(windows)]
use native_support::{binary, feature};
use serde_json::{json, Value};
use std::{env, fs, path::PathBuf};
use windows::{
    Globalization::Language,
    Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap},
    Media::Ocr::OcrEngine,
    Storage::Streams::DataWriter,
};

// The application selects its profile language. Exercise additional installed recognizers
// explicitly, keeping their native, unrotated rectangles and angle intact in the evidence.
fn by_language(lang: &Language, img: &image::GrayImage) -> windows::core::Result<Value> {
    let engine = OcrEngine::TryCreateFromLanguage(lang)?;
    let writer = DataWriter::new()?;
    writer.WriteBytes(img.as_raw())?;
    let bitmap = SoftwareBitmap::CreateCopyFromBuffer(
        &writer.DetachBuffer()?,
        BitmapPixelFormat::Gray8,
        img.width() as i32,
        img.height() as i32,
    )?;
    let result = engine.RecognizeAsync(&bitmap)?.get()?;
    let angle = result.TextAngle().and_then(|a| a.Value()).unwrap_or(0.0);
    let mut rects = Vec::new();
    let mut text = Vec::new();
    for line in result.Lines()? {
        text.push(line.Text()?.to_string());
        for word in line.Words()? {
            let b = word.BoundingRect()?;
            rects.push(json!({"text":word.Text()?.to_string(),"rect":[b.X,b.Y,b.Width,b.Height]}));
        }
    }
    Ok(
        json!({"engine":"Windows.Media.Ocr", "language":engine.RecognizerLanguage()?.LanguageTag()?.to_string(),
        "angle":angle, "rects":rects, "text":text.join("\n")}),
    )
}

#[test]
#[ignore = "run via the layout-025 fixture generator on Windows with an installed OCR language"]
fn recognize_generated_sheets() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(env::var("PAPERWORK_LAYOUT_025_QA")?).canonicalize()?;
    assert_eq!(
        root.parent(),
        Some(env::temp_dir().canonicalize()?.as_path())
    );
    assert!(root
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("paperwork-layout-025-"));
    let caps = feature(&root, "getOcrCapabilities", json!({}))?;
    let status = feature(&root, "getOcrStatus", json!({}))?;
    assert_eq!(status["available"], true, "{status}");
    let langs = OcrEngine::AvailableRecognizerLanguages()?;
    let mut runs = Vec::new();
    for sheet in ["control", "mixed", "skew"] {
        let img = image::open(root.join(format!("{sheet}.png")))?;
        assert!(img.width().max(img.height()) <= OcrEngine::MaxImageDimension()? as u32);
        for lang in &langs {
            let tag = lang.LanguageTag()?.to_string();
            let profile = status["model"] == format!("Windows OCR ({tag})");
            let result = if profile {
                let meta = json!({"width":img.width(),"height":img.height(),"mode":"printed"});
                let bytes = binary(&root, 0, "ocr", &meta.to_string(), img.to_rgba8().as_raw())?;
                let data: Value = serde_json::from_slice(&bytes)?;
                assert_eq!(data["model"], status["model"]);
                data
            } else {
                let data = by_language(&lang, &img.to_luma8())?;
                assert_eq!(data["language"], tag);
                data
            };
            runs.push(json!({"sheet":sheet,"language":tag,"profile":profile,"result":result}));
        }
    }
    assert!(!runs.is_empty());
    fs::write(
        root.join("recognition.json"),
        serde_json::to_vec_pretty(&json!({"status":status,"caps":caps,"runs":runs}))?,
    )?;
    Ok(())
}
