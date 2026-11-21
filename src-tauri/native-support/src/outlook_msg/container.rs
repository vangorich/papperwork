//! Resource limits applied *before* cfb builds its allocation tables. cfb then validates
//! sector references, duplicate links/cycles and the directory tree. Only requested MSG
//! streams are read: never walk into attached messages or open attachment payloads.
use super::{Res, MAX_OUTLOOK_MSG_BYTES};
use cfb::CompoundFile;
use std::io::{Cursor, Read};

const BAD: &str = "不是有效的 MSG 复合文档，或文件结构已损坏";
const LIMIT: &str = "MSG 内部目录、存储流或文本大小超出支持范围";
const MAX_ENTRIES: usize = 8192;
const END: u32 = 0xffff_fffe;
const FREE: u32 = 0xffff_ffff;

fn word(data: &[u8], i: usize) -> Res<u32> {
    Ok(u32::from_le_bytes(
        data.get(i..i + 4)
            .and_then(|s| s.try_into().ok())
            .ok_or(BAD)?,
    ))
}

fn preflight(data: &[u8]) -> Res<usize> {
    if data.len() > MAX_OUTLOOK_MSG_BYTES {
        return Err("MSG 文件超过 32 MiB 上限".into());
    }
    if data.len() < 512 || !data.starts_with(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1") {
        return Err(BAD.into());
    }
    let size: usize = match (&data[26..28], &data[30..32]) {
        ([3, 0], [9, 0]) => 512,
        ([4, 0], [12, 0]) => 4096,
        _ => return Err(BAD.into()),
    };
    if data.len() < 2 * size || !data.len().is_multiple_of(size) {
        return Err(BAD.into());
    }
    let sectors = data.len() / size - 1;
    let per_fat = size / 4;
    let sector = |id: u32| -> Res<&[u8]> {
        if id as usize >= sectors {
            return Err(BAD.into());
        }
        let start = (id as usize + 1) * size;
        Ok(&data[start..start + size])
    };
    let fat_len = word(data, 44)? as usize;
    let difat_len = word(data, 72)? as usize;
    if fat_len == 0
        || fat_len > sectors.div_ceil(per_fat) + 1
        || difat_len > fat_len.saturating_sub(109).div_ceil(per_fat - 1) + 1
        || word(data, 64)? as usize > (data.len() / 64).div_ceil(per_fat) + 1
    {
        return Err(LIMIT.into());
    }
    let mut fat = Vec::with_capacity(fat_len);
    let mut add_fat = |entries: &[u8]| -> Res<()> {
        for entry in entries.chunks_exact(4) {
            let id = word(entry, 0)?;
            if id == FREE {
                break;
            }
            if fat.len() == fat_len {
                return Err(BAD.into());
            }
            fat.push(sector(id)?);
        }
        Ok(())
    };
    add_fat(&data[76..512])?;
    let mut difat = word(data, 68)?;
    for _ in 0..difat_len {
        let ids = sector(difat)?;
        add_fat(&ids[..size - 4])?;
        difat = word(ids, size - 4)?;
    }
    if !(difat == END || (difat_len == 0 && difat == FREE)) || fat.len() != fat_len {
        return Err(BAD.into());
    }
    let chain_len = |mut id: u32, max: usize| -> Res<usize> {
        let mut n = 0;
        while id != END {
            if n >= max {
                return Err(LIMIT.into());
            }
            if id as usize >= sectors {
                return Err(BAD.into());
            }
            let table = fat.get(id as usize / per_fat).ok_or(BAD)?;
            id = word(table, id as usize % per_fat * 4)?;
            n += 1;
        }
        Ok(n)
    };
    let dir = word(data, 48)?;
    chain_len(dir, MAX_ENTRIES / (size / 128))?;
    let root = sector(dir)?;
    let mini_len = if size == 512 {
        u64::from(word(root, 120)?)
    } else {
        u64::from_le_bytes(root[120..128].try_into()?)
    };
    if mini_len > data.len() as u64 {
        return Err(BAD.into());
    }
    let expected = (mini_len as usize).div_ceil(size);
    let mini_sectors = chain_len(word(root, 116)?, expected + 1)?;
    if mini_sectors < expected {
        return Err(BAD.into());
    }
    Ok(mini_sectors)
}

pub(super) struct Container<'a> {
    pub file: CompoundFile<Cursor<&'a [u8]>>,
    bytes_left: usize,
    mini_sectors: usize,
    mini_ids: usize,
    mini_work_left: usize,
}
impl<'a> Container<'a> {
    pub fn open(data: &'a [u8]) -> Res<Self> {
        let mini_sectors = preflight(data)?;
        let file = CompoundFile::open(Cursor::new(data)).map_err(|_| BAD)?;
        let mini_ids = file.root_entry().len() as usize / 64; // Preflight bounded the root stream to the input.
        Ok(Self {
            file,
            bytes_left: 8 * 1024 * 1024,
            mini_sectors,
            mini_ids,
            mini_work_left: 24_000_000,
        })
    }
    pub fn bytes(&mut self, path: &str, limit: usize) -> Res<Option<Vec<u8>>> {
        if !self.file.is_stream(path) {
            return Ok(None);
        }
        let mut stream = self.file.open_stream(path).map_err(|_| BAD)?;
        let len = usize::try_from(stream.len()).map_err(|_| LIMIT)?;
        if len > limit {
            return Err(LIMIT.into());
        }
        self.bytes_left = self.bytes_left.checked_sub(len).ok_or(LIMIT)?;
        if (1..4096).contains(&len) {
            // cfb 0.7 opens a MiniFAT chain, then reopens the root chain per 64-byte read.
            // Charge the full possible chain once too: short directory lengths need not be honest.
            let cost = self.mini_ids + self.mini_sectors * len.div_ceil(64);
            self.mini_work_left = self.mini_work_left.checked_sub(cost).ok_or(LIMIT)?;
        }
        let mut buf = vec![0; len];
        stream.read_exact(&mut buf).map_err(|_| BAD)?;
        Ok(Some(buf))
    }
}
