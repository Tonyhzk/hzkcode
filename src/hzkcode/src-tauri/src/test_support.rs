//! Test-only process-wide lock for tests that steer process-global
//! environment variables (HOME, USERPROFILE, HZKCODE_CONFIG_DIR, …).
//!
//! Module-local locks (the previous pattern) let tests from different
//! modules hold "their" lock at the same time while both mutate the same
//! process globals — one module's scratch HOME could observe another
//! module's mid-run teardown, surfacing as flaky failures. One lock for the
//! whole test binary removes that race.

/// Serializes every test that mutates process-global environment state.
pub(crate) static HOME_ENV_LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

/// Test builds must never write outside the OS temp root: every legitimate
/// test steers HOME / config dirs to a scratch under `temp_dir()`, and real
/// user files never live there. A pre-merge lock race once leaked fixture
/// writes into the real `~/.hzkcode/gui` config (2026-10-04); the app's
/// persistence choke points refuse anything else so a regression is loud
/// instead of silent.
pub(crate) fn guard_test_write(path: &std::path::Path) -> Result<(), String> {
    if path.starts_with(std::env::temp_dir()) || path.starts_with("/tmp") {
        return Ok(());
    }
    Err(format!(
        "test build refuses to write outside the temp dir: {}",
        path.display()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guard_allows_temp_and_refuses_real_paths() {
        assert!(guard_test_write(&std::env::temp_dir().join("scratch/config.json")).is_ok());
        assert!(guard_test_write(std::path::Path::new("/tmp/hzkcode-x/config.json")).is_ok());
        assert!(
            guard_test_write(std::path::Path::new("/home/user/.hzkcode/gui/config.json"))
                .is_err()
        );
    }
}
