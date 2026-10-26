use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub(super) fn check_optional_directory(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => Ok(true),
        Ok(_) => Err("backup_path_invalid".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err("backup_io".into()),
    }
}
pub(super) fn check_directory(path: &Path) -> Result<(), String> {
    if check_optional_directory(path)? { Ok(()) } else { Err("backup_path_invalid".into()) }
}

pub(super) fn read_optional(path: &Path, limit: usize) -> Result<Option<Vec<u8>>, String> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_file() => return Err("backup_path_invalid".into()),
        Ok(meta) if meta.len() > limit as u64 => return Err("backup_too_large".into()),
        Ok(_) => {},
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("backup_io".into()),
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)] {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(path).map_err(|_| "backup_io")?;
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1).read_to_end(&mut bytes).map_err(|_| "backup_io")?;
    if bytes.len() > limit { return Err("backup_too_large".into()); }
    Ok(Some(bytes))
}

pub(super) fn create_directory(path: &Path) -> Result<(), String> {
    #[cfg(test)]
    crate::test_support::guard_test_write(path)?;
    if check_optional_directory(path)? { return Ok(()); }
    fs::create_dir(path).map_err(|_| "backup_io")?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|_| "backup_io")?;
    }
    Ok(())
}

pub(super) fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    #[cfg(test)]
    crate::test_support::guard_test_write(path)?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)] {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists { "backup_path_invalid" } else { "backup_io" }
    })?;
    if file.write_all(bytes).and_then(|_| file.sync_all()).is_err() {
        drop(file);
        let _ = fs::remove_file(path);
        return Err("backup_io".into());
    }
    Ok(())
}

fn replace_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temp = path.with_file_name(format!(".config-restore-{}.tmp", uuid::Uuid::new_v4()));
    write_new(&temp, bytes)?;
    if fs::rename(&temp, path).is_err() {
        let _ = fs::remove_file(&temp);
        return Err("backup_io".into());
    }
    Ok(())
}

#[cfg(test)]
thread_local! { pub(super) static FAIL_AFTER: std::cell::Cell<Option<usize>> = const { std::cell::Cell::new(None) }; }

pub(super) fn apply_files(files: &BTreeMap<PathBuf, Vec<u8>>) -> Result<(), String> {
    let mut staged: Vec<(PathBuf, PathBuf, Option<Vec<u8>>)> = Vec::new();
    let stage = (|| {
        for (path, content) in files {
            check_directory(path.parent().ok_or("backup_path_invalid")?)?;
            let original = read_optional(path, super::crypto::MAX_PAYLOAD)?;
            let temp = path.with_file_name(format!(".config-restore-{}.tmp", uuid::Uuid::new_v4()));
            write_new(&temp, content)?;
            staged.push((path.clone(), temp, original));
        }
        Ok::<_, String>(())
    })();
    if let Err(error) = stage {
        for (_, temp, _) in &staged { let _ = fs::remove_file(temp); }
        return Err(error);
    }
    let mut committed = 0;
    let result = (|| {
        for (path, temp, _) in &staged {
            #[cfg(test)]
            if FAIL_AFTER.with(|point| point.get() == Some(committed)) { return Err("backup_io".to_string()); }
            check_directory(path.parent().ok_or("backup_path_invalid")?)?;
            fs::rename(temp, path).map_err(|_| "backup_io")?;
            committed += 1;
        }
        Ok::<_, String>(())
    })();
    if result.is_err() {
        let mut rollback_failed = false;
        for (path, _, original) in staged[..committed].iter().rev() {
            let restored = match original {
                Some(bytes) => replace_file(path, bytes),
                None => fs::remove_file(path).map_err(|_| "backup_io".to_string()),
            };
            rollback_failed |= restored.is_err();
        }
        for (_, temp, _) in &staged { let _ = fs::remove_file(temp); }
        if rollback_failed { return Err("backup_rollback_failed".into()); }
    }
    result
}
