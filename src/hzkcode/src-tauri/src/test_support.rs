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
