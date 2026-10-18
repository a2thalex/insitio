//! Test-only helper for changing environment variables.
//!
//! Environment variables are process-wide and tests run on parallel threads,
//! so every test that changes one takes `EnvGuard`, which holds a single
//! lock for its whole life. Dropping the guard puts the variables back as
//! they were, even when the test panics.
//!
//! ```ignore
//! let _env = EnvGuard::lock().set("NSIT_CONFIG_DIR", dir.path()).unset("NSIT_HOST");
//! ```

use std::ffi::{OsStr, OsString};
use std::sync::{Mutex, MutexGuard};

static ENV_LOCK: Mutex<()> = Mutex::new(());

pub(crate) struct EnvGuard {
    /// Original value of every variable this guard changed, oldest first.
    saved: Vec<(OsString, Option<OsString>)>,
    /// Dropped after `saved` is restored (fields drop after `Drop::drop`).
    _lock: MutexGuard<'static, ()>,
}

impl EnvGuard {
    /// Take the lock. A panic in an earlier test poisons it; that is fine
    /// because the guard of that test already restored the variables.
    pub(crate) fn lock() -> EnvGuard {
        EnvGuard {
            saved: Vec::new(),
            _lock: ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner()),
        }
    }

    /// Set a variable until the guard is dropped.
    pub(crate) fn set(mut self, key: &str, value: impl AsRef<OsStr>) -> EnvGuard {
        self.remember(key);
        std::env::set_var(key, value);
        self
    }

    /// Remove a variable until the guard is dropped.
    pub(crate) fn unset(mut self, key: &str) -> EnvGuard {
        self.remember(key);
        std::env::remove_var(key);
        self
    }

    fn remember(&mut self, key: &str) {
        if !self.saved.iter().any(|(k, _)| k == key) {
            self.saved.push((key.into(), std::env::var_os(key)));
        }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        for (key, value) in self.saved.drain(..).rev() {
            match value {
                Some(value) => std::env::set_var(&key, value),
                None => std::env::remove_var(&key),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROBE: &str = "NSIT_TEST_ENV_GUARD_PROBE";

    #[test]
    fn set_and_unset_apply_then_restore_the_original_values() {
        let guard = EnvGuard::lock();
        std::env::set_var(PROBE, "original");
        let guard = guard.set(PROBE, "changed");
        assert_eq!(std::env::var(PROBE).unwrap(), "changed");
        let guard = guard.set(PROBE, "changed again").unset(PROBE);
        assert!(std::env::var_os(PROBE).is_none());
        drop(guard);
        let guard = EnvGuard::lock();
        assert_eq!(std::env::var(PROBE).unwrap(), "original");
        std::env::remove_var(PROBE);
        drop(guard);
    }

    #[test]
    fn a_variable_that_was_unset_is_unset_again() {
        drop(EnvGuard::lock().set(PROBE, "temporary"));
        let guard = EnvGuard::lock();
        assert!(std::env::var_os(PROBE).is_none());
        drop(guard);
    }

    #[test]
    fn restores_and_releases_the_lock_when_the_test_panics() {
        let outcome = std::panic::catch_unwind(|| {
            let _env = EnvGuard::lock().set(PROBE, "leaked?");
            panic!("simulated failed assertion");
        });
        assert!(outcome.is_err());
        // Re-locking must not deadlock, and the variable must be gone.
        let guard = EnvGuard::lock();
        assert!(std::env::var_os(PROBE).is_none());
        drop(guard);
    }
}
