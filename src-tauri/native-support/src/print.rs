//! Printer discovery and real raster jobs through the Windows spooler (no shell or PDF viewer).
use super::{Res, MAX_BINARY};
use image::{ImageFormat, ImageReader};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    io::Cursor,
    mem::size_of,
    ptr::{null, null_mut},
};
use windows_sys::{
    core::w,
    Win32::{
        Foundation::*,
        Graphics::{Gdi::*, Printing::*},
        Storage::Xps::{AbortDoc, EndDoc, EndPage, StartDocW, StartPage, DOCINFOW},
        System::Memory::{GlobalLock, GlobalSize, GlobalUnlock},
        UI::Controls::Dialogs::*,
    },
};

fn os_error(context: &str) -> super::Failure {
    format!("{context}：{}", std::io::Error::last_os_error()).into()
}
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}
// Native variable-length buffers hold both aligned records and trailing UTF-16 strings.
fn buffer(n: u32) -> Res<Vec<usize>> {
    if n == 0 || n > 16 * 1024 * 1024 {
        return Err("打印驱动返回无效的数据大小".into());
    }
    Ok(vec![0; (n as usize).div_ceil(size_of::<usize>())])
}
fn text(buffer: &[usize], p: *const u16) -> String {
    let base = buffer.as_ptr() as usize;
    let limit = base + std::mem::size_of_val(buffer);
    let pos = p as usize;
    if !(base..limit).contains(&pos) || !pos.is_multiple_of(2) {
        return String::new();
    }
    // SAFETY: validated aligned pointer within the live response buffer; never scan beyond its end.
    let data = unsafe { std::slice::from_raw_parts(p, (limit - pos) / 2) };
    String::from_utf16_lossy(&data[..data.iter().position(|x| *x == 0).unwrap_or(data.len())])
}
fn default_name() -> String {
    let mut buf = vec![0u16; 16384];
    let mut len = buf.len() as u32;
    // SAFETY: len is the allocated buffer capacity in wide characters.
    if unsafe { GetDefaultPrinterW(buf.as_mut_ptr(), &mut len) } == 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buf[..buf.iter().position(|x| *x == 0).unwrap_or(buf.len())])
}
pub(super) fn list() -> Res<Value> {
    let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
    let (mut n, mut count) = (0, 0);
    // SAFETY: standard two-call spooler query. Variable-size records are aligned, counted and bounded below.
    unsafe {
        let first = EnumPrintersW(flags, null(), 2, null_mut(), 0, &mut n, &mut count);
        if n == 0 {
            if first == 0 && GetLastError() != ERROR_INSUFFICIENT_BUFFER {
                return Err(os_error("读取打印机失败"));
            }
            return Ok(json!([]));
        }
        let mut buf = buffer(n)?;
        if EnumPrintersW(
            flags,
            null(),
            2,
            buf.as_mut_ptr().cast(),
            n,
            &mut n,
            &mut count,
        ) == 0
        {
            return Err(os_error("读取打印机失败"));
        }
        if (count as usize) > std::mem::size_of_val(buf.as_slice()) / size_of::<PRINTER_INFO_2W>() {
            return Err("打印机列表无效".into());
        }
        let default = default_name();
        let mut printers = Vec::new();
        for p in std::slice::from_raw_parts(buf.as_ptr().cast::<PRINTER_INFO_2W>(), count as usize)
        {
            let name = text(&buf, p.pPrinterName);
            if !name.is_empty() {
                printers.push(json!({"name":name,"displayName":name,"description":text(&buf,p.pComment),"status":p.Status,"isDefault":name.eq_ignore_ascii_case(&default)}))
            }
        }
        Ok(Value::Array(printers))
    }
}
struct Printer(PRINTER_HANDLE);
impl Printer {
    fn open(name: &[u16]) -> Result<Self, std::io::Error> {
        let mut p = PRINTER_HANDLE::default();
        // SAFETY: caller supplies a NUL-terminated name; returned handle is owned by the guard.
        if unsafe { OpenPrinterW(name.as_ptr(), &mut p, null()) } == 0 {
            Err(std::io::Error::last_os_error())
        } else {
            Ok(Self(p))
        }
    }

    // Some spoolers return success from EndPage/EndDoc for a job the user just deleted.
    // Check only our own still-open job. Lack of status access is not a cancellation.
    fn is_deleting(&self, job: u32) -> bool {
        // SAFETY: the spooler sizes the aligned buffer; the fixed header must fit before reading.
        unsafe {
            let mut n = 0;
            GetJobW(self.0, job, 1, null_mut(), 0, &mut n);
            if (n as usize) < size_of::<JOB_INFO_1W>() {
                return false;
            }
            let Ok(mut buf) = buffer(n) else { return false };
            if GetJobW(self.0, job, 1, buf.as_mut_ptr().cast(), n, &mut n) == 0 {
                return false;
            }
            let info = &*buf.as_ptr().cast::<JOB_INFO_1W>();
            info.JobId == job && info.Status & (JOB_STATUS_DELETING | JOB_STATUS_DELETED) != 0
        }
    }
}
impl Drop for Printer {
    fn drop(&mut self) {
        // SAFETY: this guard owns the successful OpenPrinterW result.
        unsafe {
            ClosePrinter(self.0);
        }
    }
}
pub(super) fn driver_port(name: &str) -> Res<Option<(String, String)>> {
    let p = match Printer::open(&wide(name)) {
        Ok(p) => p,
        Err(e) if matches!(e.raw_os_error(), Some(1801 | 3012 | 2)) => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    // SAFETY: standard two-call spooler query; verify the fixed record fits before dereferencing.
    unsafe {
        let mut n = 0;
        GetPrinterW(p.0, 2, null_mut(), 0, &mut n);
        let mut buf = buffer(n)?;
        if (n as usize) < size_of::<PRINTER_INFO_2W>()
            || GetPrinterW(p.0, 2, buf.as_mut_ptr().cast(), n, &mut n) == 0
        {
            return Err(os_error("无法检查虚拟打印端口"));
        }
        let info = &*buf.as_ptr().cast::<PRINTER_INFO_2W>();
        Ok(Some((
            text(&buf, info.pDriverName),
            text(&buf, info.pPortName),
        )))
    }
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Sizing {
    #[default]
    Fit,
    Actual,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Options {
    copies: i16,
    duplex: String,
    landscape: bool,
    collate: bool,
    pages_per_sheet: u8,
    scale_factor: f64,
    #[serde(default)]
    sizing: Sizing,
    color: bool,
    device_name: Option<String>,
    margins: String,
    paper_size: Option<String>,
    #[serde(default)]
    page_border: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Page {
    width_pt: f64,
    height_pt: f64,
    size: usize,
}
#[derive(Deserialize)]
struct Packet {
    options: Options,
    pages: Vec<Page>,
}
fn packet(bytes: &[u8]) -> Res<(Packet, Vec<&[u8]>)> {
    let n = u32::from_le_bytes(bytes.get(..4).ok_or("打印数据不完整")?.try_into()?) as usize;
    if n > 512 * 1024 {
        return Err("打印任务头过大".into());
    }
    let p: Packet = serde_json::from_slice(bytes.get(4..4 + n).ok_or("打印清单不完整")?)?;
    let o = &p.options;
    if p.pages.is_empty()
        || p.pages.len() > 2000
        || !(1..=99).contains(&o.copies)
        || !matches!(o.pages_per_sheet, 1 | 2 | 4 | 6 | 9 | 16)
        || !(50.0..=150.0).contains(&o.scale_factor)
        || !matches!(o.duplex.as_str(), "simplex" | "longEdge" | "shortEdge")
        || !matches!(o.margins.as_str(), "none" | "default" | "printableArea")
        || !matches!(
            o.paper_size.as_deref().unwrap_or("auto"),
            "auto" | "a4" | "a5" | "b5" | "letter" | "legal"
        )
        || o.device_name
            .as_ref()
            .is_some_and(|d| d.len() > 1024 || d.contains('\0'))
    {
        return Err("打印设置不合法".into());
    }
    let mut body = &bytes[4 + n..];
    let mut images = Vec::with_capacity(p.pages.len());
    for page in &p.pages {
        if !(0.1..=20_000.0).contains(&page.width_pt)
            || !(0.1..=20_000.0).contains(&page.height_pt)
            || page.size > 64 * 1024 * 1024
        {
            return Err("打印页尺寸过大".into());
        }
        let (data, rest) = body.split_at_checked(page.size).ok_or("打印页数据不完整")?;
        body = rest;
        let (w, h) =
            ImageReader::with_format(Cursor::new(data), ImageFormat::Png).into_dimensions()?;
        if w == 0 || h == 0 || w > 30_000 || h > 30_000 || u64::from(w) * u64::from(h) > 48_000_000
        {
            return Err("打印页超过 4800 万像素，请降低 DPI".into());
        }
        images.push(data);
    }
    if !body.is_empty() {
        return Err("打印数据长度错误".into());
    }
    Ok((p, images))
}
// Windows DMPAPER_B5 is JIS (182 × 257 mm); the app's B5 is ISO (176 × 250 mm).
// A zero form ID requests the dimensions explicitly, never the similarly named stock.
fn requested_media(o: &Options, page: &Page) -> (u32, f64, f64) {
    const PT_PER_MM: f64 = 72. / 25.4;
    const FORMS: [(&str, u32, f64, f64); 5] = [
        ("a4", DMPAPER_A4, 210. * PT_PER_MM, 297. * PT_PER_MM),
        ("a5", DMPAPER_A5, 148. * PT_PER_MM, 210. * PT_PER_MM),
        ("b5", 0, 176. * PT_PER_MM, 250. * PT_PER_MM),
        ("letter", DMPAPER_LETTER, 612., 792.),
        ("legal", DMPAPER_LEGAL, 612., 1008.),
    ];
    let fixed = FORMS.iter().find(|f| Some(f.0) == o.paper_size.as_deref());
    let (id, w, h) = if let Some(&(_, id, w, h)) = fixed {
        (id, w, h)
    } else {
        let w = page.width_pt.min(page.height_pt);
        let h = page.width_pt.max(page.height_pt);
        let id = FORMS
            .iter()
            .find(|f| (w - f.2).abs() < 3. && (h - f.3).abs() < 3.)
            .map_or(0, |f| f.1);
        (id, w, h)
    };
    if o.landscape || (fixed.is_none() && page.width_pt > page.height_pt) {
        (id, h, w)
    } else {
        (id, w, h)
    }
}

fn configure(dm: &mut DEVMODEW, o: &Options, page: &Page, driver_copies: bool) {
    let (paper, w, h) = requested_media(o, page);
    dm.Anonymous1.Anonymous1.dmOrientation = if w > h {
        DMORIENT_LANDSCAPE
    } else {
        DMORIENT_PORTRAIT
    } as i16;
    // A stale default form name can conflict with the selected size or custom dimensions.
    dm.dmFields &= !DM_FORMNAME;
    if paper != 0 {
        dm.Anonymous1.Anonymous1.dmPaperSize = paper as i16;
        dm.dmFields |= DM_PAPERSIZE;
        dm.dmFields &= !(DM_PAPERLENGTH | DM_PAPERWIDTH)
    } else {
        // Native custom media sizes are expressed in tenths of a millimetre; a driver
        // that substitutes its default is detected after the DC has been created.
        dm.Anonymous1.Anonymous1.dmPaperSize = 0;
        dm.Anonymous1.Anonymous1.dmPaperWidth = (w.min(h) * (254. / 72.)).round() as i16;
        dm.Anonymous1.Anonymous1.dmPaperLength = (w.max(h) * (254. / 72.)).round() as i16;
        dm.dmFields &= !DM_PAPERSIZE;
        dm.dmFields |= DM_PAPERLENGTH | DM_PAPERWIDTH;
    }
    dm.dmColor = if o.color {
        DMCOLOR_COLOR
    } else {
        DMCOLOR_MONOCHROME
    };
    dm.dmDuplex = match o.duplex.as_str() {
        "longEdge" => DMDUP_VERTICAL,
        "shortEdge" => DMDUP_HORIZONTAL,
        _ => DMDUP_SIMPLEX,
    };
    dm.Anonymous1.Anonymous1.dmCopies = if driver_copies { o.copies } else { 1 };
    dm.dmCollate = if o.collate {
        DMCOLLATE_TRUE
    } else {
        DMCOLLATE_FALSE
    };
    dm.dmFields |= DM_ORIENTATION | DM_COLOR | DM_DUPLEX | DM_COPIES | DM_COLLATE;
}
// The optional handle names the same queue as the DC; it is never the default by inference.
struct Dc(HDC, Option<Printer>);
impl Drop for Dc {
    fn drop(&mut self) {
        // SAFETY: this context is owned by this guard (CreateDCW / PD_RETURNDC).
        unsafe {
            DeleteDC(self.0);
        }
    }
}
fn named_dc(name: &str, o: &Options, page: &Page) -> Res<Dc> {
    let wname = wide(name);
    let printer = Printer::open(&wname)?;
    // SAFETY: use a driver-sized, aligned DEVMODE including its private data; retain buffers through CreateDCW.
    unsafe {
        let size =
            DocumentPropertiesW(null_mut(), printer.0, wname.as_ptr(), null_mut(), null(), 0);
        if size < size_of::<DEVMODEW>() as i32 {
            return Err(os_error("不能读取打印驱动参数"));
        }
        let mut input = buffer(size as u32)?;
        let mut output = buffer(size as u32)?;
        let dm = input.as_mut_ptr().cast::<DEVMODEW>();
        if DocumentPropertiesW(
            null_mut(),
            printer.0,
            wname.as_ptr(),
            dm,
            null(),
            DM_OUT_BUFFER,
        ) != 1
        {
            return Err(os_error("无法读取打印设置"));
        }
        configure(&mut *dm, o, page, false);
        let validated = output.as_mut_ptr().cast::<DEVMODEW>();
        if DocumentPropertiesW(
            null_mut(),
            printer.0,
            wname.as_ptr(),
            validated,
            dm,
            DM_IN_BUFFER | DM_OUT_BUFFER,
        ) != 1
        {
            return Err(os_error("驱动不接受打印设置"));
        }
        if o.duplex != "simplex"
            && ((*validated).dmFields & DM_DUPLEX == 0 || (*validated).dmDuplex != (*dm).dmDuplex)
        {
            return Err("所选打印机不支持请求的双面方式，请选择单面或系统对话框".into());
        }
        let dc = CreateDCW(w!("WINSPOOL"), wname.as_ptr(), null(), validated);
        if dc.is_null() {
            return Err(os_error("创建打印机绘图上下文失败"));
        }
        let dc = Dc(dc, Some(printer));
        // A driver can accept our DEVMODE and silently substitute its default stock.
        let pts = |axis, dpi| {
            f64::from(GetDeviceCaps(dc.0, axis as i32)) * 72.
                / f64::from(GetDeviceCaps(dc.0, dpi as i32))
        };
        let w = pts(PHYSICALWIDTH, LOGPIXELSX);
        let h = pts(PHYSICALHEIGHT, LOGPIXELSY);
        let (_, want_w, want_h) = requested_media(o, page);
        let tol = if o.paper_size.as_deref().unwrap_or("auto") == "auto" {
            4.
        } else {
            1.
        };
        if !w.is_finite() || !h.is_finite() || (w - want_w).abs() > tol || (h - want_h).abs() > tol
        {
            return Err(format!("打印驱动不支持请求的纸张尺寸（请求 {want_w:.1} × {want_h:.1} pt，驱动 {w:.1} × {h:.1} pt）。请选择其他纸张或在系统对话框中选择介质。").into());
        }
        Ok(dc)
    }
}
struct Dialog(PRINTDLGW);
impl Dialog {
    fn selected_printer(&self) -> Option<Printer> {
        let names = self.0.hDevNames;
        // SAFETY: the common dialog owns this moveable DEVNAMES block. Its UTF-16
        // offsets are relative to the block; bound both offset and terminator while locked.
        unsafe {
            if names.is_null() {
                return None;
            }
            let n = GlobalSize(names);
            if n < size_of::<DEVNAMES>() {
                return None;
            }
            let p = GlobalLock(names).cast::<DEVNAMES>();
            if p.is_null() {
                return None;
            }
            let words = std::slice::from_raw_parts(p.cast::<u16>(), n / 2);
            let printer = words.get(usize::from((*p).wDeviceOffset)..).and_then(|s| {
                let end = s.iter().position(|&ch| ch == 0)?;
                if end == 0 {
                    return None;
                }
                Printer::open(&s[..=end]).ok()
            });
            GlobalUnlock(names);
            printer
        }
    }
}
impl Drop for Dialog {
    fn drop(&mut self) {
        // SAFETY: the common dialog transfers ownership of both moveable handles to the caller.
        unsafe {
            if !self.0.hDevMode.is_null() {
                GlobalFree(self.0.hDevMode);
            }
            if !self.0.hDevNames.is_null() {
                GlobalFree(self.0.hDevNames);
            }
        }
    }
}
fn dialog_dc(owner: usize, o: &Options, page: &Page) -> Res<Dc> {
    let mut d = Dialog(PRINTDLGW {
        lStructSize: size_of::<PRINTDLGW>() as u32,
        hwndOwner: owner as HWND,
        Flags: PD_RETURNDEFAULT,
        ..Default::default()
    });
    // SAFETY: owner comes from Tauri, never IPC; initialize from the OS's default settings (including driver bytes).
    unsafe {
        let _ = PrintDlgW(&mut d.0);
        if !d.0.hDevMode.is_null() && GlobalSize(d.0.hDevMode) >= size_of::<DEVMODEW>() {
            let ptr = GlobalLock(d.0.hDevMode).cast::<DEVMODEW>();
            if !ptr.is_null() {
                configure(&mut *ptr, o, page, true);
                GlobalUnlock(d.0.hDevMode);
            }
        }
        d.0.Flags = PD_RETURNDC
            | PD_NOPAGENUMS
            | PD_NOSELECTION
            | PD_HIDEPRINTTOFILE
            | PD_USEDEVMODECOPIESANDCOLLATE;
        d.0.nCopies = o.copies as u16;
        if PrintDlgW(&mut d.0) == 0 {
            let code = CommDlgExtendedError();
            if code == 0 {
                return Err("已取消系统打印，未提交任务".into());
            }
            return Err(format!("系统打印对话框错误 0x{code:04x}").into());
        }
        if d.0.hDC.is_null() {
            return Err("未取得选定打印机".into());
        }
        Ok(Dc(d.0.hDC, d.selected_printer()))
    }
}
struct Doc<'a> {
    dc: &'a Dc,
    id: u32,
    finished: bool,
}
impl<'a> Doc<'a> {
    fn start(dc: &'a Dc, output: Option<&[u16]>) -> Res<Self> {
        let info = DOCINFOW {
            cbSize: size_of::<DOCINFOW>() as i32,
            lpszDocName: w!("Paperwork PDF Studio"),
            lpszOutput: output.map_or(null(), |s| s.as_ptr()),
            ..Default::default()
        };
        // SAFETY: both strings remain live through StartDocW; the guard borrows this DC.
        let job = unsafe { StartDocW(dc.0, &info) };
        if job <= 0 {
            return Err(os_error("未提交打印任务（可能已取消）"));
        }
        Ok(Self {
            dc,
            id: job as u32,
            finished: false,
        })
    }

    fn finish(mut self) -> Res<()> {
        if self.dc.1.as_ref().is_some_and(|p| p.is_deleting(self.id)) {
            return Err("打印任务已取消".into());
        }
        // SAFETY: only this job guard can commit its own DC.
        if unsafe { EndDoc(self.dc.0) } <= 0 {
            return Err(os_error("打印任务未完成"));
        }
        self.finished = true;
        Ok(())
    }
}
impl Drop for Doc<'_> {
    fn drop(&mut self) {
        if !self.finished {
            // SAFETY: this guard only exists after successful StartDocW on its live borrowed DC.
            unsafe {
                AbortDoc(self.dc.0);
            }
        }
    }
}
fn submit(
    dc: &Dc,
    doc: &Packet,
    images: &[&[u8]],
    copies: usize,
    output: Option<&[u16]>,
) -> Res<()> {
    let opts = &doc.options;
    let guard = Doc::start(dc, output)?;
    // SAFETY: the live job borrows this DC; bitmap buffers remain valid through each synchronous blit.
    unsafe {
        let area = (
            GetDeviceCaps(dc.0, HORZRES as i32),
            GetDeviceCaps(dc.0, VERTRES as i32),
        );
        let dx = GetDeviceCaps(dc.0, LOGPIXELSX as i32);
        let dy = GetDeviceCaps(dc.0, LOGPIXELSY as i32);
        if area.0 <= 0 || area.1 <= 0 || dx <= 0 || dy <= 0 {
            return Err("打印机报告的纸张尺寸无效".into());
        }
        let (pad_x, pad_y) = if opts.margins == "default" {
            (
                (f64::from(dx) / 6.).round() as i32,
                (f64::from(dy) / 6.).round() as i32,
            )
        } else {
            (0, 0)
        };
        let n = opts.pages_per_sheet as usize;
        let sheets = images.len().div_ceil(n);
        let (mut cols, mut rows) = match n {
            2 => (1, 2),
            4 => (2, 2),
            6 => (2, 3),
            9 => (3, 3),
            16 => (4, 4),
            _ => (1, 1),
        };
        if area.0 > area.1 {
            std::mem::swap(&mut cols, &mut rows)
        }
        for k in 0..sheets * copies {
            let index = if opts.collate { k % sheets } else { k / copies };
            if StartPage(dc.0) <= 0 {
                return Err(os_error("无法开始打印页"));
            }
            SetStretchBltMode(dc.0, HALFTONE);
            SetBrushOrgEx(dc.0, 0, 0, null_mut());
            for cell in 0..n {
                let i = index * n + cell;
                let Some(data) = images.get(i) else { break };
                let mut img = ImageReader::with_format(Cursor::new(*data), ImageFormat::Png)
                    .decode()?
                    .into_rgba8();
                let (w, h) = img.dimensions();
                for px in img.chunks_exact_mut(4) {
                    let a = u32::from(px[3]);
                    for c in &mut px[..3] {
                        *c = ((u32::from(*c) * a + 255 * (255 - a) + 127) / 255) as u8
                    }
                    if opts.color {
                        px.swap(0, 2); // RGB -> GDI's BGR
                    } else {
                        // Some color drivers accept DMCOLOR_MONOCHROME but still emit RGB ink.
                        let gray = (2126 * u32::from(px[0])
                            + 7152 * u32::from(px[1])
                            + 722 * u32::from(px[2])
                            + 5000)
                            / 10000;
                        px[..3].fill(gray as u8);
                    }
                }
                let left = (cell as i32 % cols) * area.0 / cols + pad_x;
                let right = (cell as i32 % cols + 1) * area.0 / cols - pad_x;
                let top = (cell as i32 / cols) * area.1 / rows + pad_y;
                let bottom = (cell as i32 / cols + 1) * area.1 / rows - pad_y;
                if right <= left || bottom <= top {
                    return Err("安全留白超过可打印区域，请减少每张页数或更改边距".into());
                }
                let pg = &doc.pages[i];
                // Inches per source PDF point; device X/Y DPI need not be equal.
                let scale = match opts.sizing {
                    Sizing::Fit => {
                        let cw = f64::from(right - left) / f64::from(dx);
                        let ch = f64::from(bottom - top) / f64::from(dy);
                        (cw / pg.width_pt).min(ch / pg.height_pt)
                    }
                    Sizing::Actual => 1. / 72.,
                } * opts.scale_factor
                    / 100.;
                let dw = (scale * pg.width_pt * f64::from(dx)).round().max(1.) as i32;
                let dh = (scale * pg.height_pt * f64::from(dy)).round().max(1.) as i32;
                let x = left + (right - left - dw) / 2;
                let y = top + (bottom - top - dh) / 2;
                let bmp = BITMAPINFO {
                    bmiHeader: BITMAPINFOHEADER {
                        biSize: size_of::<BITMAPINFOHEADER>() as u32,
                        biWidth: w as i32,
                        biHeight: -(h as i32),
                        biPlanes: 1,
                        biBitCount: 32,
                        biCompression: BI_RGB,
                        ..Default::default()
                    },
                    ..Default::default()
                };
                let saved = SaveDC(dc.0);
                if saved == 0 {
                    return Err(os_error("打印机无法保存绘图状态"));
                }
                if IntersectClipRect(dc.0, left, top, right, bottom) == 0 {
                    let err = os_error("打印机无法裁切页面");
                    RestoreDC(dc.0, saved);
                    return Err(err);
                }
                let drawn = StretchDIBits(
                    dc.0,
                    x,
                    y,
                    dw,
                    dh,
                    0,
                    0,
                    w as i32,
                    h as i32,
                    img.as_ptr().cast(),
                    &bmp,
                    DIB_RGB_COLORS,
                    SRCCOPY,
                );
                if opts.page_border {
                    let rect = RECT {
                        left: x,
                        top: y,
                        right: x + dw,
                        bottom: y + dh,
                    };
                    FrameRect(dc.0, &rect, GetStockObject(BLACK_BRUSH).cast());
                }
                RestoreDC(dc.0, saved);
                if drawn == 0 || drawn == -1 {
                    return Err(os_error("打印驱动未接收页面图像"));
                }
            }
            if EndPage(dc.0) <= 0 {
                return Err(os_error("打印页未完成"));
            }
        }
        guard.finish()
    }
}
#[cfg(test)]
mod geometry_tests;
#[cfg(test)]
mod tests;

pub(super) fn print_packet(owner: usize, bytes: &[u8]) -> Res<()> {
    if bytes.len() > MAX_BINARY {
        return Err("打印任务大于 128 MiB，请分批打印".into());
    }
    let (packet, images) = packet(bytes)?;
    let o = &packet.options;
    let (dc, copies) = if let Some(name) = o.device_name.as_deref().filter(|s| !s.is_empty()) {
        if o.paper_size.as_deref().unwrap_or("auto") == "auto" {
            let (_, w, h) = requested_media(o, &packet.pages[0]);
            if packet.pages.iter().any(|p| {
                let (_, pw, ph) = requested_media(o, p);
                (pw - w).abs() > 3. || (ph - h).abs() > 3.
            }) {
                return Err(
                    "所选页面的纸张尺寸不统一。请为本任务选择固定纸张或按尺寸分批打印。".into(),
                );
            }
        }
        let installed = list()?;
        if !installed
            .as_array()
            .is_some_and(|v| v.iter().any(|p| p["name"] == name))
        {
            return Err("打印机不在已安装列表中，请刷新打印机".into());
        }
        (named_dc(name, o, &packet.pages[0])?, o.copies as usize)
    } else {
        (dialog_dc(owner, o, &packet.pages[0])?, 1)
    };
    // When no output path is supplied a file printer, e.g. Microsoft Print to PDF,
    // opens its own native Save Print Output As dialog. Cancellation is a spooler failure, not success.
    submit(&dc, &packet, &images, copies, None)
}
