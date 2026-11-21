use super::*;

#[test]
fn rejects_truncated_packet_before_opening_printer() {
    assert!(packet(&[255; 10]).is_err());
}

/// Explicit opt-in, ONLY the system PDF file printer on the local PORTPROMPT port.
/// No real printer, user destination, current queue or shared inbox is touched by this test.
#[test]
#[ignore = "requires the local Microsoft Print to PDF optional feature"]
fn spool_to_pdf_and_decode_two_nonblank_sheets() -> Res<()> {
    use windows::{
        core::HSTRING,
        Data::Pdf::PdfDocument,
        Graphics::Imaging::{
            BitmapAlphaMode, BitmapDecoder, BitmapPixelFormat, BitmapTransform,
            ColorManagementMode, ExifOrientationMode,
        },
        Storage::{StorageFile, Streams::InMemoryRandomAccessStream},
    };
    let name = "Microsoft Print to PDF";
    let (driver, port) = driver_port(name)?.ok_or("Microsoft PDF printer missing")?;
    assert!(
        driver.eq_ignore_ascii_case("Microsoft Print To PDF")
            && port.eq_ignore_ascii_case("PORTPROMPT:"),
        "Not the expected local PDF printer; refusing to spool"
    );
    let data = include_bytes!("../../tests/paper-ocr.png");
    let o = Options {
        copies: 1,
        duplex: "simplex".into(),
        landscape: false,
        collate: true,
        pages_per_sheet: 1,
        scale_factor: 100.,
        sizing: Sizing::Fit,
        color: true,
        device_name: Some(name.into()),
        margins: "default".into(),
        paper_size: Some("a4".into()),
        page_border: false,
    };
    let doc = Packet {
        options: o,
        pages: (0..2)
            .map(|_| Page {
                width_pt: 640.,
                height_pt: 128.,
                size: data.len(),
            })
            .collect(),
    };
    let dc = named_dc(name, &doc.options, &doc.pages[0])?;
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("proof.pdf");
    let p = path.to_str().unwrap();
    submit(&dc, &doc, &[data, data], 1, Some(&wide(p)))?;
    drop(dc);
    let mut ready = false;
    for _ in 0..100 {
        if std::fs::read(&path).is_ok_and(|b| b.trim_ascii_end().ends_with(b"%%EOF")) {
            ready = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100))
    }
    assert!(ready, "spooler did not finish generating PDF");
    let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(p))?.get()?;
    let pdf = PdfDocument::LoadFromFileAsync(&file)?.get()?;
    assert_eq!(pdf.PageCount()?, 2);
    for i in 0..2 {
        let page = pdf.GetPage(i)?;
        let stream = InMemoryRandomAccessStream::new()?;
        page.RenderToStreamAsync(&stream)?.get()?;
        stream.Seek(0)?;
        let bitmap = BitmapDecoder::CreateAsync(&stream)?.get()?;
        // WinRT codecs only guarantee BGRA8/RGBA8 for pixel format conversion.
        let bgra = bitmap
            .GetPixelDataTransformedAsync(
                BitmapPixelFormat::Bgra8,
                BitmapAlphaMode::Ignore,
                &BitmapTransform::new()?,
                ExifOrientationMode::IgnoreExifOrientation,
                ColorManagementMode::DoNotColorManage,
            )?
            .get()?
            .DetachPixelData()?;
        let count = bgra
            .chunks_exact(4)
            .filter(|p| p[0] < 128 && p[1] < 128 && p[2] < 128)
            .count();
        assert!(count > 100, "sheet {i} lost its raster text");
        assert!(count < bgra.len() / 16, "sheet {i} rendered black");
    }
    Ok(())
}
