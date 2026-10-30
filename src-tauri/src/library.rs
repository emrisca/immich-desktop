//! Sizes and counts measured from the library on disk.
//!
//! The Storage screen used to print fixed numbers. Every value here is read from
//! the folder the app is actually pointed at, so an empty library reports zero
//! and a full one reports what is there.

use std::fs;
use std::path::Path;

use crate::layout::Layout;

/// Extensions Immich treats as video.
const VIDEO: [&str; 15] = [
    "3gp", "avi", "flv", "m2ts", "m4v", "mkv", "mov", "mp4", "mpeg", "mpg", "mts", "mxf", "ts",
    "webm", "wmv",
];

/// Extensions it treats as photos, camera raw included.
const PHOTO: [&str; 31] = [
    "3fr", "arw", "avif", "bmp", "cr2", "cr3", "crw", "dng", "erf", "gif", "heic", "heif", "iiq",
    "jpeg", "jpg", "jxl", "k25", "kdc", "mos", "mrw", "nef", "orf", "pef", "png", "raf", "rw2",
    "sr2", "srf", "srw", "tif", "tiff",
];

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub folder: String,
    /// Originals only. Thumbnails, encoded video and sidecars are not counted.
    pub photos: u64,
    pub videos: u64,
    /// Everything in the library folder: originals, thumbnails, database, logs.
    pub bytes: u64,
    /// Space left on the volume the library sits on.
    pub free: u64,
    pub total: u64,
}

pub fn usage(folder: &Path) -> Usage {
    let layout = Layout::new(folder);

    let mut photos = 0;
    let mut videos = 0;
    // `upload` holds what the app imported, `library` what Immich's storage
    // template moved into place. A library normally uses one or the other.
    for originals in [layout.media.join("upload"), layout.media.join("library")] {
        walk(&originals, &mut |path, _| match kind(path) {
            Some(true) => videos += 1,
            Some(false) => photos += 1,
            None => {}
        });
    }

    let mut bytes = 0;
    walk(&layout.root, &mut |_, meta| bytes += meta.len());

    let (free, total) = volume(folder);
    Usage {
        folder: crate::layout::plain(folder),
        photos,
        videos,
        bytes,
        free,
        total,
    }
}

/// Whether a file is a photo (false) or a video (true). Sidecars such as `.json`
/// and `.xmp` are neither and must not inflate the counts.
fn kind(path: &Path) -> Option<bool> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    if VIDEO.contains(&extension.as_str()) {
        Some(true)
    } else if PHOTO.contains(&extension.as_str()) {
        Some(false)
    } else {
        None
    }
}

fn walk(dir: &Path, visit: &mut impl FnMut(&Path, &fs::Metadata)) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        let path = entry.path();
        if meta.is_dir() {
            walk(&path, visit);
        } else if meta.is_file() {
            visit(&path, &meta);
        }
    }
}

/// Free and total bytes of the volume holding `path`. A folder that does not
/// exist yet is walked up to its nearest parent, because the picker allows
/// choosing a new one.
#[cfg(unix)]
fn volume(path: &Path) -> (u64, u64) {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let mut probe = path.to_path_buf();
    while !probe.exists() {
        if !probe.pop() {
            return (0, 0);
        }
    }
    let Ok(c_path) = CString::new(probe.as_os_str().as_bytes()) else {
        return (0, 0);
    };
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c_path.as_ptr(), &mut stat) } != 0 {
        return (0, 0);
    }
    let unit = if stat.f_frsize > 0 {
        stat.f_frsize as u64
    } else {
        stat.f_bsize as u64
    };
    (stat.f_bavail as u64 * unit, stat.f_blocks as u64 * unit)
}

#[cfg(windows)]
fn volume(path: &Path) -> (u64, u64) {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let mut probe = path.to_path_buf();
    while !probe.exists() {
        if !probe.pop() {
            return (0, 0);
        }
    }
    let mut wide: Vec<u16> = probe.as_os_str().encode_wide().collect();
    wide.push(0);

    let mut available = 0u64;
    let mut total = 0u64;
    let mut free = 0u64;
    let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut available, &mut total, &mut free) };
    if ok == 0 {
        (0, 0)
    } else {
        (free, total)
    }
}

#[cfg(not(any(unix, windows)))]
fn volume(_path: &Path) -> (u64, u64) {
    (0, 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_originals_and_ignores_sidecars_and_thumbnails() {
        let folder = std::env::temp_dir().join(format!("immich-usage-{}", std::process::id()));
        let _ = fs::remove_dir_all(&folder);
        let layout = Layout::new(&folder);
        layout.create().expect("layout");

        let upload = layout.media.join("upload").join("user-1");
        fs::create_dir_all(upload.join("nested")).expect("upload");
        fs::write(upload.join("a.jpg"), b"x").expect("write");
        fs::write(upload.join("b.HEIC"), b"x").expect("write");
        fs::write(upload.join("nested").join("c.mp4"), b"x").expect("write");
        fs::write(upload.join("d.json"), b"{}").expect("write");
        fs::write(layout.media.join("thumbs").join("t.webp"), b"x").expect("write");
        fs::write(layout.media.join("library").join("moved.png"), b"x").expect("write");

        let measured = usage(&folder);
        assert_eq!(measured.photos, 3, "a.jpg, b.HEIC and library/moved.png");
        assert_eq!(measured.videos, 1);
        assert!(measured.bytes >= 6);
        assert!(!measured.folder.is_empty());

        let _ = fs::remove_dir_all(&folder);
    }

    #[test]
    fn an_absent_folder_measures_zero_rather_than_failing() {
        let missing = std::env::temp_dir().join("immich-usage-not-there");
        let measured = usage(&missing);
        assert_eq!(measured.photos, 0);
        assert_eq!(measured.videos, 0);
        assert_eq!(measured.bytes, 0);
    }
}
