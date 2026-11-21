//! Opt-in, headless readback of actual Microsoft Print to PDF output. No default printer or dialog.
//! From native-support: `cargo test --locked --lib print:: -- --include-ignored --nocapture --test-threads=1`.
//! `PAPERWORK_KEEP_PRINT_PROOFS=1` keeps the unique temp PDFs printed in the test log.
use super::*;
use image::{Rgb, RgbImage, RgbaImage};
use std::{ops::Range, path::Path, time::Duration};
use windows::{
    core::HSTRING,
    Data::Pdf::{PdfDocument, PdfPageRenderOptions},
    Graphics::Imaging::{
        BitmapAlphaMode, BitmapDecoder, BitmapPixelFormat, BitmapTransform, ColorManagementMode,
        ExifOrientationMode,
    },
    Storage::{StorageFile, Streams::InMemoryRandomAccessStream},
};

const PRINTER: &str = "Microsoft Print to PDF";
const RED: [u8; 3] = [224, 32, 48];
const GREEN: [u8; 3] = [32, 184, 64];
const BLUE: [u8; 3] = [32, 72, 208];
const SMALL: [f64; 2] = [180., 240.];

// Native input is a PNG plus its physical size in points. At SMALL this fixture has
// 4 px/pt: one off-center 36 × 24 pt patch and two perpendicular 0.5 pt rules.
fn fiducials(color: [u8; 3]) -> Res<Vec<u8>> {
    let mut img = RgbImage::from_pixel(720, 960, Rgb([255; 3]));
    for (x, y, w, h, rgb) in [
        (72, 120, 144, 96, color),
        (576, 384, 2, 192, [0; 3]),
        (360, 720, 240, 2, [0; 3]),
    ] {
        for row in y..y + h {
            for col in x..x + w {
                img.put_pixel(col, row, Rgb(rgb));
            }
        }
    }
    let mut png = Cursor::new(Vec::new());
    img.write_to(&mut png, ImageFormat::Png)?;
    Ok(png.into_inner())
}

fn options(extra: Value) -> Res<Options> {
    let mut value = json!({"deviceName": PRINTER, "copies": 1, "duplex": "simplex", "collate": true,
        "landscape": false, "pagesPerSheet": 1, "scaleFactor": 100, "color": true,
        "paperSize": "letter", "margins": "none"});
    value
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    Ok(serde_json::from_value(value)?)
}

fn pdf_dc(o: &Options, page: &Page) -> Res<Dc> {
    let (driver, port) = driver_port(PRINTER)?.ok_or("local Microsoft PDF printer missing")?;
    assert!(
        driver.eq_ignore_ascii_case(PRINTER) && port.eq_ignore_ascii_case("PORTPROMPT:"),
        "refusing to spool: {driver:?}, {port:?}"
    );
    named_dc(PRINTER, o, page)
}

fn print_file(
    label: &str,
    extra: Value,
    size: [f64; 2],
    colors: &[[u8; 3]],
) -> Res<(tempfile::TempDir, PdfDocument)> {
    let pngs: Vec<_> = colors.iter().copied().map(fiducials).collect::<Res<_>>()?;
    let doc = Packet {
        options: options(extra)?,
        pages: pngs
            .iter()
            .map(|p| Page {
                width_pt: size[0],
                height_pt: size[1],
                size: p.len(),
            })
            .collect(),
    };
    let dc = pdf_dc(&doc.options, &doc.pages[0])?;
    let dir = tempfile::Builder::new()
        .prefix("pdf-geometry-")
        .disable_cleanup(
            std::env::var_os("PAPERWORK_KEEP_PRINT_PROOFS").as_deref() == Some("1".as_ref()),
        )
        .tempdir()?;
    let path = dir.path().join(format!("{label}.pdf"));
    assert!(!path.exists());
    let p = path.to_str().ok_or("non-Unicode temp path")?;
    let images: Vec<_> = pngs.iter().map(Vec::as_slice).collect();
    submit(&dc, &doc, &images, 1, Some(&wide(p)))?;
    drop(dc);
    for _ in 0..100 {
        if complete(&path) {
            eprintln!("{label}: {}", path.display());
            let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(p))?.get()?;
            let pdf = PdfDocument::LoadFromFileAsync(&file)?.get()?;
            return Ok((dir, pdf));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err("timed out waiting for the spooler's PDF trailer".into())
}

fn complete(path: &Path) -> bool {
    std::fs::read(path)
        .is_ok_and(|b| b.starts_with(b"%PDF-") && b.trim_ascii_end().ends_with(b"%%EOF"))
}

fn size_pt(pdf: &PdfDocument, index: u32) -> Res<[f64; 2]> {
    let s = pdf.GetPage(index)?.Size()?; // Windows.Data.Pdf reports 96 DIPs/in.
    Ok([f64::from(s.Width) * 0.75, f64::from(s.Height) * 0.75])
}

fn render(pdf: &PdfDocument, index: u32) -> Res<RgbaImage> {
    let page = pdf.GetPage(index)?;
    let [w, h] = size_pt(pdf, index)?;
    let options = PdfPageRenderOptions::new()?;
    options.SetDestinationWidth((w * 4.).round() as u32)?;
    options.SetDestinationHeight((h * 4.).round() as u32)?;
    let stream = InMemoryRandomAccessStream::new()?;
    page.RenderWithOptionsToStreamAsync(&stream, &options)?
        .get()?;
    stream.Seek(0)?;
    let decoder = BitmapDecoder::CreateAsync(&stream)?.get()?;
    let (w, h) = (decoder.PixelWidth()?, decoder.PixelHeight()?);
    let bytes = decoder
        .GetPixelDataTransformedAsync(
            BitmapPixelFormat::Rgba8,
            BitmapAlphaMode::Ignore,
            &BitmapTransform::new()?,
            ExifOrientationMode::IgnoreExifOrientation,
            ColorManagementMode::DoNotColorManage,
        )?
        .get()?
        .DetachPixelData()?;
    Ok(RgbaImage::from_raw(w, h, bytes.to_vec()).ok_or("incomplete PDF readback bitmap")?)
}

// Find the ink, not just a sample at the expected position. Each fiducial occupies a
// separate band of rows. Bounds are top-left, right/bottom exclusive, in physical pt.
#[derive(Debug)]
struct Mark {
    bounds: [f64; 4],
    rgb: [u8; 3],
}
fn marks(img: &RgbaImage, xr: Range<u32>, yr: Range<u32>) -> Vec<Mark> {
    let mut bands: Vec<[u32; 4]> = Vec::new();
    for y in yr {
        let mut ink = xr
            .clone()
            .filter(|&x| img.get_pixel(x, y).0[..3].iter().any(|&v| v < 230));
        let Some(left) = ink.next() else { continue };
        let right = ink.next_back().unwrap_or(left) + 1;
        if let Some(b) = bands.last_mut().filter(|b| b[3] == y) {
            b[0] = b[0].min(left);
            b[2] = b[2].max(right);
            b[3] = y + 1;
        } else {
            bands.push([left, y, right, y + 1]);
        }
    }
    bands
        .into_iter()
        .map(|b| Mark {
            bounds: b.map(|n| f64::from(n) / 4.),
            rgb: img
                .get_pixel((b[0] + b[2] - 1) / 2, (b[1] + b[3] - 1) / 2)
                .0[..3]
                .try_into()
                .unwrap(),
        })
        .collect()
}

fn close<const N: usize>(label: &str, got: [f64; N], want: [f64; N], tol: f64) {
    assert!(
        got.iter().zip(want).all(|(a, b)| (*a - b).abs() <= tol),
        "{label}: got {got:?}, expected {want:?} ±{tol} pt"
    );
}

#[test]
fn unknown_sizing_is_not_silently_treated_as_fit() {
    assert!(options(json!({"sizing":"stretch"})).is_err());
}

#[test]
#[ignore = "spools only to a verified local Microsoft Print to PDF file device"]
fn fit_and_actual_at_100_and_50_percent() -> Res<()> {
    // Independent Letter worked examples: source 180 × 240 pt, page 612 × 792 pt.
    for (label, opts, scale, ox, oy) in [
        ("fit100", json!({}), 3.3, 9., 0.), // sizing omitted: legacy fit
        (
            "printable-fit100",
            json!({"margins":"printableArea"}),
            3.3,
            9.,
            0.,
        ),
        (
            "fit50",
            json!({"sizing":"fit", "scaleFactor":50}),
            1.65,
            157.5,
            198.,
        ),
        (
            "safe-fit100",
            json!({"sizing":"fit", "margins":"default"}),
            3.2,
            18.,
            12.,
        ),
        ("actual100", json!({"sizing":"actual"}), 1., 216., 276.),
        (
            "actual50",
            json!({"sizing":"actual", "scaleFactor":50}),
            0.5,
            261.,
            336.,
        ),
    ] {
        let (_dir, pdf) = print_file(label, opts, SMALL, &[RED])?;
        assert_eq!(pdf.PageCount()?, 1);
        close(label, size_pt(&pdf, 0)?, [612., 792.], 0.5);
        let img = render(&pdf, 0)?;
        assert_eq!(img.dimensions(), (2448, 3168));
        let ink = marks(&img, 0..img.width(), 0..img.height());
        eprintln!("{label}: {ink:?}");
        assert_eq!(ink.len(), 3, "{label}: missing or split marks");
        for (m, [l, t, r, b]) in ink.iter().zip([
            [18., 30., 54., 54.],
            [144., 96., 144.5, 144.],
            [90., 180., 150., 180.5],
        ]) {
            close(
                label,
                m.bounds,
                [
                    ox + l * scale,
                    oy + t * scale,
                    ox + r * scale,
                    oy + b * scale,
                ],
                0.75,
            );
        }
        let thickness = [
            ink[1].bounds[2] - ink[1].bounds[0],
            ink[2].bounds[3] - ink[2].bounds[1],
        ];
        close(label, thickness, [0.5 * scale; 2], 0.25);
    }
    Ok(())
}

#[test]
#[ignore = "spools only to a verified local Microsoft Print to PDF file device"]
fn requested_paper_and_orientation_reach_the_pdf() -> Res<()> {
    for (media, landscape, source, want) in [
        ("a4", false, SMALL, [595.276, 841.890]),
        ("a5", true, SMALL, [595.276, 419.528]),
        ("letter", false, SMALL, [612., 792.]),
        ("legal", true, SMALL, [1008., 612.]),
        ("auto", false, [792., 612.], [792., 612.]),
        ("b5", false, SMALL, [498.898, 708.661]), // ISO 176 × 250 mm, not JIS
    ] {
        let o = json!({"paperSize":media, "landscape":landscape});
        let (_dir, pdf) = match print_file(media, o, source, &[RED]) {
            Err(e) if media == "b5" && e.to_string().contains("不支持请求的纸张尺寸") => {
                eprintln!("{media}: rejected rather than substituted: {e}");
                continue;
            }
            result => result?,
        };
        assert_eq!(pdf.PageCount()?, 1);
        let got = size_pt(&pdf, 0)?;
        eprintln!("{media}: {got:?} pt");
        close(media, got, want, 0.55);
    }
    Ok(())
}

#[test]
#[ignore = "spools only to a verified local Microsoft Print to PDF file device"]
fn two_up_keeps_packet_order_and_leaves_the_last_cell_empty() -> Res<()> {
    for landscape in [true, false] {
        let label = if landscape {
            "two-up-wide"
        } else {
            "two-up-tall"
        };
        let (_dir, pdf) = print_file(
            label,
            json!({"landscape":landscape, "pagesPerSheet":2}),
            SMALL,
            &[BLUE, RED, GREEN],
        )?;
        assert_eq!(pdf.PageCount()?, 2);
        for n in 0..2 {
            let img = render(&pdf, n)?;
            let (w, h) = img.dimensions();
            for slot in 0..2 {
                let (xr, yr, want) = if landscape {
                    let x = 396. * f64::from(slot);
                    (
                        slot * w / 2..(slot + 1) * w / 2,
                        0..h,
                        [x + 39.6, 108., x + 118.8, 160.8],
                    )
                } else {
                    let y = 396. * f64::from(slot);
                    (
                        0..w,
                        slot * h / 2..(slot + 1) * h / 2,
                        [187.2, y + 49.5, 246.6, y + 89.1],
                    )
                };
                let ink = marks(&img, xr, yr);
                eprintln!("{label} sheet {n} slot {slot}: {:?}", ink.first());
                if let Some(rgb) = [BLUE, RED, GREEN].get((n * 2 + slot) as usize) {
                    assert_eq!(ink.len(), 3);
                    close(label, ink[0].bounds, want, 0.75);
                    assert!(ink[0].rgb.iter().zip(rgb).all(|(a, b)| a.abs_diff(*b) <= 5));
                } else {
                    assert!(ink.is_empty(), "unused slot contains ink");
                }
            }
        }
    }
    Ok(())
}

#[test]
#[ignore = "spools only to a verified local Microsoft Print to PDF file device"]
fn grayscale_is_neutral_in_the_driver_pdf_from_colored_input() -> Res<()> {
    let (_dir, pdf) = print_file(
        "gray",
        json!({"color":false, "landscape":true, "pagesPerSheet":2}),
        SMALL,
        &[RED, GREEN],
    )?;
    let img = render(&pdf, 0)?;
    let mut tones = Vec::new();
    for k in 0..2 {
        let ink = marks(
            &img,
            k * img.width() / 2..(k + 1) * img.width() / 2,
            0..img.height(),
        );
        assert_eq!(ink.len(), 3);
        let rgb = ink[0].rgb;
        eprintln!("gray patch {k}: {rgb:?}");
        assert!(
            rgb.iter().max().unwrap() - rgb.iter().min().unwrap() <= 2,
            "still colored: {rgb:?}"
        );
        assert!((1..254).contains(&rgb[0]));
        tones.push(rgb[0]);
    }
    assert!(
        tones[0] < tones[1],
        "red and green patches must retain distinct tones"
    );
    Ok(())
}

#[test]
#[ignore = "spools only to a verified local Microsoft Print to PDF file device"]
fn oversized_actual_is_clipped_to_its_safe_cell_not_the_adjacent_slot() -> Res<()> {
    let (_dir, pdf) = print_file(
        "actual-clip",
        json!({"sizing":"actual", "margins":"default", "landscape":true, "pagesPerSheet":2}),
        [720., 960.],
        &[BLUE],
    )?;
    let img = render(&pdf, 0)?;
    let ink = marks(&img, 0..img.width(), 0..img.height());
    eprintln!("actual-clip: {ink:?}");
    assert_eq!(ink.len(), 2);
    close("clipped patch", ink[0].bounds, [12., 12., 54., 42.], 0.75);
    close(
        "clipped rule",
        ink[1].bounds,
        [198., 546., 384., 548.],
        0.75,
    );
    Ok(())
}

#[test]
#[ignore = "cancels only a new local Microsoft Print to PDF file job"]
fn cancelled_spool_is_not_reported_as_success() -> Res<()> {
    let dc = pdf_dc(
        &options(json!({}))?,
        &Page {
            width_pt: 612.,
            height_pt: 792.,
            size: 0,
        },
    )?;
    let dir = tempfile::tempdir()?;
    let path = dir.path().join("cancel.pdf");
    assert!(!path.exists());
    let printer = dc.1.as_ref().unwrap();
    let active = Doc::start(&dc, Some(&wide(path.to_str().unwrap())))?;
    let id = active.id;
    // SAFETY: id comes only from our active StartDocW on this verified local queue.
    // Delete just that job (the spooler's Cancel action), never enumerate/purge a queue.
    assert!(unsafe { StartPage(dc.0) } > 0);
    assert_ne!(
        unsafe { SetJobW(printer.0, id, 0, null(), JOB_CONTROL_DELETE) },
        0,
        "spooler could not cancel our test job: {}",
        std::io::Error::last_os_error()
    );
    let page_result = unsafe { EndPage(dc.0) };
    let result = if page_result > 0 {
        active.finish()
    } else {
        Err(os_error("打印页未完成"))
    };
    eprintln!(
        "spooler cancelled own job {id}, EndPage={page_result}, finish={result:?}, complete PDF={}",
        complete(&path)
    );
    assert!(result.is_err(), "cancelled job was acknowledged");
    assert!(!complete(&path));
    Ok(())
}
