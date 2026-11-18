// SPDX-License-Identifier: BSD-3-Clause
use std::{ffi::OsString, time::Duration};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Config {
    pub grace: Duration,
    pub fatal_grace: Duration,
    pub deadline: Duration,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ControlEndpoint {
    Fd(u64),
    #[cfg(windows)]
    Handle(u64),
}

pub struct RunOptions {
    pub cleanup: Config,
    pub control: Option<ControlEndpoint>,
    pub retain_descendants: bool,
    pub quiet: bool,
    pub command_index: usize,
}
impl Default for Config {
    fn default() -> Self {
        Self::from_millis(6000, 3000, 7500).expect("default cleanup policy is valid")
    }
}
impl Config {
    pub fn from_millis(grace: u64, fatal: u64, deadline: u64) -> Result<Self, String> {
        let config = Self {
            grace: Duration::from_millis(grace),
            fatal_grace: Duration::from_millis(fatal),
            deadline: Duration::from_millis(deadline),
        };
        config.validate()?;
        Ok(config)
    }
    fn validate(self) -> Result<(), String> {
        if self.fatal_grace.is_zero()
            || self.fatal_grace > self.grace
            || self.grace >= self.deadline
        {
            return Err("require 0 < fatal-grace <= grace < cleanup-deadline".into());
        }
        Ok(())
    }
}

fn duration(text: &str) -> Result<Duration, String> {
    let (digits, multiplier) = if let Some(value) = text.strip_suffix("ms") {
        (value, 1)
    } else if let Some(value) = text.strip_suffix('s') {
        (value, 1000)
    } else {
        return Err("duration must be an integer with ms or s suffix".into());
    };
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("duration must be an integer with ms or s suffix".into());
    }
    let millis = digits
        .parse::<u64>()
        .ok()
        .and_then(|value| value.checked_mul(multiplier))
        .ok_or_else(|| "duration is too large".to_string())?;
    Ok(Duration::from_millis(millis))
}

pub fn options(args: &[OsString]) -> Result<RunOptions, (u8, String)> {
    let mut config = Config::default();
    let mut control = None;
    let mut retain_descendants = false;
    let mut quiet = false;
    let mut index = 0;
    let mut seen = 0;
    while let Some(option) = args.get(index) {
        if option == "--" {
            config.validate().map_err(|error| (2, error))?;
            if retain_descendants && control.is_none() {
                return Err((2, "--retain-descendants requires task control".into()));
            }
            return Ok(RunOptions {
                cleanup: config,
                control,
                retain_descendants,
                quiet,
                command_index: index + 1,
            });
        }
        if option == "--quiet" {
            if quiet {
                return Err((2, "duplicate --quiet option".into()));
            }
            quiet = true;
            index += 1;
            continue;
        }
        if option == "--retain-descendants" {
            if retain_descendants {
                return Err((2, "duplicate --retain-descendants option".into()));
            }
            retain_descendants = true;
            index += 1;
            continue;
        }
        let native_handle = cfg!(windows) && option == "--control-handle";
        if option == "--control-fd" || native_handle {
            if control.is_some() {
                return Err((2, "duplicate task control option".into()));
            }
            let raw = args
                .get(index + 1)
                .and_then(|v| v.to_str())
                .and_then(|v| v.parse::<u64>().ok())
                .filter(|n| *n > 2)
                .ok_or_else(|| (2, "task control needs a native endpoint".into()))?;
            let endpoint = ControlEndpoint::Fd(raw);
            #[cfg(windows)]
            let endpoint = if native_handle {
                ControlEndpoint::Handle(raw)
            } else {
                endpoint
            };
            control = Some(endpoint);
            index += 2;
            continue;
        }
        let (field, bit) = if option == "--grace" {
            (&mut config.grace, 1)
        } else if option == "--fatal-grace" {
            (&mut config.fatal_grace, 2)
        } else if option == "--cleanup-deadline" {
            (&mut config.deadline, 4)
        } else {
            return Err((
                125,
                "expected run [options] -- <command> [args...]; see --help".into(),
            ));
        };
        if seen & bit != 0 {
            return Err((2, "duplicate cleanup timing option".into()));
        }
        seen |= bit;
        let value = args
            .get(index + 1)
            .and_then(|value| value.to_str())
            .ok_or_else(|| (2, "cleanup timing option needs a duration".into()))?;
        *field = duration(value).map_err(|error| (2, error))?;
        index += 2;
    }
    Err((
        125,
        "expected run [options] -- <command> [args...]; see --help".into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::{ControlEndpoint, options};
    use std::ffi::OsString;

    #[test]
    fn control_fd_is_a_descriptor_not_a_native_handle() {
        let args = ["--control-fd", "3", "--", "payload"].map(OsString::from);
        assert_eq!(
            options(&args).unwrap().control,
            Some(ControlEndpoint::Fd(3))
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_native_handle_retains_its_distinct_type() {
        let args = ["--control-handle", "512", "--", "payload"].map(OsString::from);
        assert_eq!(
            options(&args).unwrap().control,
            Some(ControlEndpoint::Handle(512))
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_control_forms_are_mutually_exclusive_in_both_orders() {
        for flags in [
            ["--control-fd", "--control-handle"],
            ["--control-handle", "--control-fd"],
        ] {
            let args = [flags[0], "3", flags[1], "512", "--", "payload"].map(OsString::from);
            assert_eq!(
                options(&args).err().unwrap(),
                (2, "duplicate task control option".into())
            );
        }
    }
}
