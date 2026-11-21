// Geometry and evidence checks for the local WinRT OCR refinement passes. All
// points here are in pixels of the same source bitmap; no PDF units or test data.
#[cfg(test)]
#[path = "ocr_refine_tests.rs"]
mod tests;
#[derive(Clone, Copy, Debug)]
pub(super) struct Rect {
    pub l: f64,
    pub t: f64,
    pub r: f64,
    pub b: f64,
}
impl Rect {
    pub fn area(self) -> f64 {
        (self.r - self.l).max(0.) * (self.b - self.t).max(0.)
    }
    pub fn intersection(self, b: Self) -> f64 {
        (self.r.min(b.r) - self.l.max(b.l)).max(0.) * (self.b.min(b.b) - self.t.max(b.t)).max(0.)
    }
    fn union(self, b: Self) -> Self {
        Self {
            l: self.l.min(b.l),
            t: self.t.min(b.t),
            r: self.r.max(b.r),
            b: self.b.max(b.b),
        }
    }
    fn pad(self, x: f64, y: f64) -> Self {
        Self {
            l: self.l - x,
            r: self.r + x,
            t: self.t - y,
            b: self.b + y,
        }
    }
    fn center(self) -> (f64, f64) {
        ((self.l + self.r) * 0.5, (self.t + self.b) * 0.5)
    }
    fn contains(self, (x, y): (f64, f64)) -> bool {
        x >= self.l && x <= self.r && y >= self.t && y <= self.b
    }
}
#[derive(Clone, Copy)]
pub(super) struct Map {
    pub a: f64,
    pub b: f64,
    pub c: f64,
    pub d: f64,
    pub x: f64,
    pub y: f64,
}
impl Map {
    pub const ID: Self = Self {
        a: 1.,
        b: 0.,
        c: 0.,
        d: 1.,
        x: 0.,
        y: 0.,
    };
    pub fn point(self, x: f64, y: f64) -> (f64, f64) {
        (
            self.a * x + self.c * y + self.x,
            self.b * x + self.d * y + self.y,
        )
    }
    pub fn inverse(self) -> Self {
        let k = self.a * self.d - self.b * self.c;
        Self {
            a: self.d / k,
            b: -self.b / k,
            c: -self.c / k,
            d: self.a / k,
            x: (self.c * self.y - self.d * self.x) / k,
            y: (self.b * self.x - self.a * self.y) / k,
        }
    }
    pub fn offset(self, x: f64, y: f64) -> Self {
        let (x, y) = self.point(x, y);
        Self { x, y, ..self }
    }
    pub fn rotation(deg: f64, cx: f64, cy: f64) -> Self {
        let (s, c) = deg.to_radians().sin_cos();
        Self {
            a: c,
            b: s,
            c: -s,
            d: c,
            x: cx - c * cx + s * cy,
            y: cy - s * cx - c * cy,
        }
    }
}
fn bounds(pts: &[(f64, f64); 4]) -> Rect {
    let mut r = Rect {
        l: f64::INFINITY,
        t: f64::INFINITY,
        r: f64::NEG_INFINITY,
        b: f64::NEG_INFINITY,
    };
    for &(x, y) in pts {
        r.l = r.l.min(x);
        r.t = r.t.min(y);
        r.r = r.r.max(x);
        r.b = r.b.max(y)
    }
    r
}
#[derive(Clone, Debug)]
pub(super) struct Hit {
    pub text: String,
    pub pts: [(f64, f64); 4],
    pub rect: Rect,
}
impl Hit {
    pub fn new(text: String, pts: [(f64, f64); 4]) -> Self {
        Self {
            text,
            rect: bounds(&pts),
            pts,
        }
    }
    fn mapped(&self, m: Map) -> Rect {
        bounds(&self.pts.map(|(x, y)| m.point(x, y)))
    }
}
pub(super) fn han(c: char) -> bool {
    matches!(c as u32,0x3400..=0x4dbf|0x4e00..=0x9fff|0xf900..=0xfaff|0x20000..=0x323af)
}
fn western(c: char) -> bool {
    c.is_ascii() || ('\u{ff01}'..='\u{ff5e}').contains(&c)
}
// With no engine confidence scores, don't arbitrate competing amounts, signs,
// decimal points or identifier characters. Only segmentation/width may differ.
fn numeric_spelling(s: &str) -> Option<String> {
    let key: String = s
        .chars()
        .filter(|c| !c.is_whitespace())
        .map(|c| {
            if ('\u{ff01}'..='\u{ff5e}').contains(&c) {
                char::from_u32(c as u32 - 0xfee0).unwrap_or(c)
            } else {
                c
            }
        })
        .collect();
    key.bytes().any(|b| b.is_ascii_digit()).then_some(key)
}

/// Spatial buckets keep multiple-engine alignment cheap. Very dense/abnormal
/// results are left to the primary recognizer, not exhaustively cross-compared.
struct Index {
    cells: Vec<Vec<usize>>,
    nx: usize,
    ny: usize,
}
impl Index {
    fn new(hits: &[Hit], w: usize, h: usize) -> Option<Self> {
        let nx = w.div_ceil(64).max(1);
        let ny = h.div_ceil(64).max(1);
        let mut s = Self {
            cells: vec![Vec::new(); nx * ny],
            nx,
            ny,
        };
        // The input count alone does not bound bucket entries for overlapping, page-wide boxes.
        let mut remaining = 256 * 1024usize;
        for (i, hit) in hits.iter().enumerate() {
            let (x0, y0, x1, y1) = s.range(hit.rect);
            remaining = remaining.checked_sub((x1 - x0 + 1) * (y1 - y0 + 1))?;
            for y in y0..=y1 {
                for x in x0..=x1 {
                    s.cells[y * nx + x].push(i)
                }
            }
        }
        Some(s)
    }
    fn range(&self, r: Rect) -> (usize, usize, usize, usize) {
        let x = |v: f64| ((v.max(0.) / 64.) as usize).min(self.nx - 1);
        let y = |v: f64| ((v.max(0.) / 64.) as usize).min(self.ny - 1);
        (x(r.l), y(r.t), x(r.r), y(r.b))
    }
    fn nearby(&self, r: Rect) -> Option<Vec<usize>> {
        let (x0, y0, x1, y1) = self.range(r);
        let mut a = Vec::new();
        for y in y0..=y1 {
            for x in x0..=x1 {
                let bucket = &self.cells[y * self.nx + x];
                if a.len() + bucket.len() > 8192 {
                    return None; // Too dense to align; this is not an empty region.
                }
                a.extend_from_slice(bucket);
            }
        }
        a.sort_unstable();
        a.dedup();
        Some(a)
    }
}
#[derive(Clone, Copy, PartialEq)]
pub(super) enum Supplemental {
    Latin,
    Han,
}
fn latin_token(s: &str) -> bool {
    s.is_ascii() && s.chars().any(|c| c.is_ascii_alphanumeric())
}
/// Use genuine candidates from the installed script-appropriate recognizer. A
/// number may change segmentation/separators, never a disagreeing digit value.
/// A candidate may not consume just the middle of an existing word or a Han run.
pub(super) fn merge_script(
    base: &mut Vec<Hit>,
    other: Vec<Hit>,
    script: Supplemental,
    w: usize,
    h: usize,
) {
    if base.len() > 12000 || other.len() > 12000 {
        return;
    }
    let Some(index) = Index::new(base, w, h) else {
        return;
    };
    let mut replaced = vec![false; base.len()];
    let mut add = Vec::new();
    for hit in other {
        let is_han = hit.text.chars().any(han);
        if (script == Supplemental::Han && !is_han)
            || (script == Supplemental::Latin && !latin_token(&hit.text))
        {
            continue;
        }
        let b = hit.rect;
        let area = b.area();
        if area < 2. {
            continue;
        }
        let Some(nearby) = index.nearby(b) else {
            continue;
        };
        let mut matched: Vec<usize> = nearby
            .into_iter()
            .filter(|&i| {
                let p = base[i].rect;
                p.intersection(b) > 0.28 * p.area().min(area)
            })
            .collect();
        if matched.is_empty() {
            // Do not fill gaps with an isolated Latin letter that may be a Han stroke.
            if is_han || hit.text.len() >= 2 || hit.text.bytes().all(|c| c.is_ascii_digit()) {
                add.push(hit)
            }
            continue;
        }
        // Han from another language pass may fill a hole. Do not overwrite a
        // valid original word based on an unsupported cross-script guess.
        if script == Supplemental::Han
            || matched
                .iter()
                .any(|&i| replaced[i] || !base[i].text.chars().all(western))
        {
            continue;
        }
        if matched.iter().any(|&i| {
            let p = base[i].rect;
            p.intersection(b) < p.area() * 0.60
        }) {
            continue;
        }
        matched.sort_by(|a, c| base[*a].rect.l.total_cmp(&base[*c].rect.l));
        let union = matched
            .iter()
            .map(|&i| base[i].rect)
            .reduce(Rect::union)
            .unwrap();
        let inter = union.intersection(b);
        if inter < union.area().max(area) * 0.56 {
            continue;
        }
        let prior = matched
            .iter()
            .map(|&i| base[i].text.as_str())
            .collect::<String>();
        let old = numeric_spelling(&prior);
        if old != numeric_spelling(&hit.text) {
            continue;
        }
        if prior == hit.text && matched.len() == 1 {
            continue;
        }
        if hit.text.len() == 1
            && matched.len() == 1
            && old.is_none()
            && !prior.eq_ignore_ascii_case(&hit.text)
        {
            continue;
        }
        for i in matched {
            replaced[i] = true
        }
        add.push(hit)
    }
    let mut i = 0;
    base.retain(|_| {
        let keep = !replaced[i];
        i += 1;
        keep
    });
    base.extend(add)
}

/// Make an upright gray raster only if a small, finite skew was actually measured.
/// Expand the canvas so corner text is not cropped. Each returned point can be
/// mapped straight back to the unmodified bitmap, including any size limit.
pub(super) fn upright(
    gray: &[u8],
    w: usize,
    h: usize,
    angle: f64,
    limit: usize,
) -> (Vec<u8>, usize, usize, Map) {
    let (s, c) = angle.to_radians().sin_cos();
    let ew = (w as f64 * c.abs() + h as f64 * s.abs()).ceil();
    let eh = (w as f64 * s.abs() + h as f64 * c.abs()).ceil();
    let k = (limit as f64 / ew.max(eh)).min(1.);
    let ow = ((ew * k).round() as usize).max(1);
    let oh = ((eh * k).round() as usize).max(1);
    let a = c * ew / ow as f64;
    let b = s * ew / ow as f64;
    let cc = -s * eh / oh as f64;
    let d = c * eh / oh as f64;
    let m = Map {
        a,
        b,
        c: cc,
        d,
        x: (w as f64 - a * ow as f64 - cc * oh as f64) * 0.5,
        y: (h as f64 - b * ow as f64 - d * oh as f64) * 0.5,
    };
    let mut dst = vec![255; ow * oh];
    for y in 0..oh {
        let (mut px, mut py) = m.point(0.5, y as f64 + 0.5);
        px -= 0.5;
        py -= 0.5;
        for out in &mut dst[y * ow..(y + 1) * ow] {
            if px >= 0. && py >= 0. && px <= (w - 1) as f64 && py <= (h - 1) as f64 {
                let ix = px as usize;
                let iy = py as usize;
                let fx = px - ix as f64;
                let fy = py - iy as f64;
                let j = (ix + 1).min(w - 1);
                let yy = (iy + 1).min(h - 1);
                let v0 =
                    f64::from(gray[iy * w + ix]) * (1. - fx) + f64::from(gray[iy * w + j]) * fx;
                let v1 =
                    f64::from(gray[yy * w + ix]) * (1. - fx) + f64::from(gray[yy * w + j]) * fx;
                *out = (v0 * (1. - fy) + v1 * fy).round() as u8
            }
            px += a;
            py += b;
        }
    }
    (dst, ow, oh, m)
}

/// Connected dark-ink components not accounted for by existing OCR. This is a
/// proposal stage only: pixels never turn into text without a second WinRT result.
/// Reject rules, large image regions, and flecks. Bounded grid and candidate count.
pub(super) fn missing_ink(
    gray: &[u8],
    w: usize,
    h: usize,
    hits: &[Hit],
    map: Map,
) -> (Vec<Rect>, f64) {
    let inverse = map.inverse();
    let boxes: Vec<_> = hits.iter().map(|v| v.mapped(inverse)).collect();
    let mut heights: Vec<_> = boxes
        .iter()
        .map(|r| r.b - r.t)
        .filter(|v| *v >= 5. && *v <= 150.)
        .collect();
    if heights.is_empty() {
        return (vec![], 20.);
    }
    heights.sort_by(f64::total_cmp);
    let em = heights[heights.len() / 2];
    let step = w.max(h).div_ceil(1200).max(2);
    let nw = w.div_ceil(step);
    let nh = h.div_ceil(step);
    let mut grid = vec![0u8; nw * nh];
    for b in boxes {
        let b = b.pad(2.5f64.max(em * 0.11), 2.5f64.max(em * 0.11));
        let x0 = (b.l.max(0.) as usize / step).min(nw - 1);
        let y0 = (b.t.max(0.) as usize / step).min(nh - 1);
        let x1 = (b.r.max(0.) as usize / step).min(nw - 1);
        let y1 = (b.b.max(0.) as usize / step).min(nh - 1);
        for y in y0..=y1 {
            grid[y * nw + x0..=y * nw + x1].fill(255)
        }
    }
    for (y, row) in gray.chunks_exact(w).enumerate() {
        for (x, p) in row.iter().enumerate() {
            if *p < 150 {
                let v = &mut grid[(y / step) * nw + x / step];
                if *v < 240 {
                    *v += 1
                }
            }
        }
    }
    let minink = ((step * step) / 6).max(1) as u8;
    for v in &mut grid {
        *v = u8::from(*v != 255 && *v >= minink)
    }
    let mut stack = Vec::new();
    let mut found = Vec::new();
    for i in 0..grid.len() {
        if grid[i] == 0 {
            continue;
        }
        stack.push(i);
        grid[i] = 0;
        let (mut l, mut t, mut r, mut b, mut n) = (nw, nh, 0, 0, 0usize);
        while let Some(j) = stack.pop() {
            let x = j % nw;
            let y = j / nw;
            l = l.min(x);
            t = t.min(y);
            r = r.max(x);
            b = b.max(y);
            n += 1;
            for yy in y.saturating_sub(1)..=(y + 1).min(nh - 1) {
                for xx in x.saturating_sub(1)..=(x + 1).min(nw - 1) {
                    let k = yy * nw + xx;
                    if grid[k] != 0 {
                        grid[k] = 0;
                        stack.push(k)
                    }
                }
            }
        }
        let rw = ((r - l + 1) * step) as f64;
        let rh = ((b - t + 1) * step) as f64;
        if rh >= em * 0.32
            && rh <= em * 2.1
            && rw >= em * 0.13
            && rw <= em * 4.
            && n * step * step >= ((em * em) * 0.065) as usize
        {
            found.push(Rect {
                l: (l * step) as f64,
                t: (t * step) as f64,
                r: ((r + 1) * step).min(w) as f64,
                b: ((b + 1) * step).min(h) as f64,
            });
            if found.len() > 128 {
                return (vec![], em);
            }
        }
    }
    found.sort_by(|a, b| a.l.total_cmp(&b.l));
    let mut groups: Vec<Rect> = vec![];
    for b in found {
        if let Some(p) = groups.iter_mut().find(|p| {
            let dy = (p.center().1 - b.center().1).abs();
            dy < em * 0.48 && b.l <= p.r + em * 0.52 && b.r >= p.l - em * 0.52
        }) {
            *p = p.union(b)
        } else {
            groups.push(b)
        }
    }
    groups.sort_by(|a, b| b.area().total_cmp(&a.area()));
    groups.truncate(12);
    (groups, em)
}
/// Read surrounding lines as context. Mild 3x3 binomial smoothing suppresses
/// stair-steps without morphological joins or dictionary-based guesses.
pub(super) fn crop(
    gray: &[u8],
    w: usize,
    h: usize,
    r: Rect,
    em: f64,
    smooth: bool,
    map: Map,
) -> (Vec<u8>, usize, usize, Map) {
    let b = r.pad(em * 2.0, em * 2.8);
    let x0 = b.l.floor().max(0.) as usize;
    let y0 = b.t.floor().max(0.) as usize;
    let x1 = (b.r.ceil() as usize).min(w);
    let y1 = (b.b.ceil() as usize).min(h);
    let pad = 16;
    let ow = x1 - x0 + 2 * pad;
    let oh = y1 - y0 + 2 * pad;
    let mut out = vec![255; ow * oh];
    for y in y0..y1 {
        for x in x0..x1 {
            let k = (y - y0 + pad) * ow + (x - x0 + pad);
            out[k] = if smooth && x > 0 && x + 1 < w && y > 0 && y + 1 < h {
                let mut s = 0u32;
                for (dy, a) in [1, 2, 1].into_iter().enumerate() {
                    for (dx, b) in [1, 2, 1].into_iter().enumerate() {
                        s += a * b * u32::from(gray[(y + dy - 1) * w + x + dx - 1])
                    }
                }
                ((s + 8) / 16) as u8
            } else {
                gray[y * w + x]
            }
        }
    }
    (
        out,
        ow,
        oh,
        map.offset(x0 as f64 - pad as f64, y0 as f64 - pad as f64),
    )
}
/// A second view for a still-unread patch: preserve surrounding baselines and
/// bring the measured x-height into the range of ordinary high-DPI printed text.
/// Consume the caller's remaining pixel budget before allocating the result.
pub(super) fn context_retry(
    gray: &[u8],
    w: usize,
    h: usize,
    region: Rect,
    em: f64,
    map: Map,
    limit: usize,
    budget: usize,
) -> Option<(Vec<u8>, usize, usize, Map)> {
    let (src, sw, sh, m) = crop(gray, w, h, region, em * 1.6, false, map);
    let scale = (40. / em)
        .clamp(1., 1.65)
        .min(limit as f64 / sw.max(sh) as f64);
    let dw = ((sw as f64 * scale).round() as usize).max(1);
    let dh = ((sh as f64 * scale).round() as usize).max(1);
    if dw * dh > budget {
        return None;
    }
    let image = image::GrayImage::from_raw(sw as u32, sh as u32, src)?;
    let out = image::imageops::resize(
        &image,
        dw as u32,
        dh as u32,
        // On the second (unblurred) view keep thin stroke junctions intact:
        // a second linear interpolation after deskew can erase them.
        image::imageops::FilterType::CatmullRom,
    );
    let sx = sw as f64 / dw as f64;
    let sy = sh as f64 / dh as f64;
    Some((
        out.into_raw(),
        dw,
        dh,
        Map {
            a: m.a * sx,
            b: m.b * sx,
            c: m.c * sy,
            d: m.d * sy,
            ..m
        },
    ))
}

pub(super) fn add_missing(
    base: &mut Vec<Hit>,
    mut candidates: Vec<Hit>,
    region: Rect,
    map: Map,
    em: f64,
) {
    let inv = map.inverse();
    let area = region.pad(em * 0.26, em * 0.20);
    candidates.retain(|v| {
        let b = v.mapped(inv);
        area.contains(b.center())
            && area.intersection(b) >= b.area() * 0.6
            && v.text.chars().any(|c| c.is_alphanumeric() || han(c))
    });
    for v in candidates {
        if !base
            .iter()
            .any(|a| a.rect.intersection(v.rect) > 0.22 * a.rect.area().min(v.rect.area()))
        {
            base.push(v)
        }
    }
}
