//! Windows-only: is there a coding agent living inside WSL on this machine?
//!
//! Why this exists. 36% of Windows installs have no detectable agent and
//! save at 15%, against 13% of macOS installs. A Claude Code or Codex that
//! runs inside a WSL distro reads a Linux home; every Windows-side write the
//! setup makes (`%USERPROFILE%\.claude\settings.json`, `.codex\config.toml`)
//! is invisible to it, and Windows-side detection sees nothing in return. If
//! that is what the agent-less bucket is, it is fixable; if not, no code fixes
//! it. Nobody knows which, so this measures it: one probe per app run, its
//! verdict rides along on the identity payload as `wslAgents`.
//!
//! Verdicts: `absent` (no wsl.exe, or no user distro), `no_agent`, a comma
//! list of `claude` / `codex` whose home directory exists in the distro,
//! `timeout` (a distro that would not boot inside the budget), `error`.
//!
//! Deliberately a measurement, not a router: it never writes into the distro.

use std::sync::OnceLock;

static RESULT: OnceLock<String> = OnceLock::new();

/// The verdict, once the background probe has one. `None` until then and on
/// every non-Windows platform, so the payload field is simply omitted.
pub fn result() -> Option<String> {
    RESULT.get().cloned()
}

/// Kick off the probe on a background thread. Booting a distro can take
/// seconds, and this runs at app start next to the other warmers.
pub fn spawn_probe() {
    #[cfg(windows)]
    std::thread::spawn(|| {
        let verdict = probe();
        log::info!("wsl probe: {verdict}");
        let _ = RESULT.set(verdict);
    });
}

/// Sub-verdict from the check script's stdout: one line per agent home that
/// exists in the distro.
fn classify_check_output(stdout: &str) -> String {
    let mut found: Vec<&str> = Vec::new();
    for line in stdout.lines().map(str::trim) {
        match line {
            ".claude" => found.push("claude"),
            ".codex" => found.push("codex"),
            _ => {}
        }
    }
    if found.is_empty() {
        "no_agent".to_string()
    } else {
        found.join(",")
    }
}

/// User distros from `wsl --list --quiet`. Docker Desktop registers two
/// distros of its own that no human codes in; with only those present the
/// machine has no WSL to speak of, and probing docker-desktop's busybox
/// would report a confident `no_agent` for the wrong reason.
fn user_distros(list_stdout: &str) -> Vec<String> {
    list_stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with("docker-desktop"))
        .map(str::to_string)
        .collect()
}

/// `wsl.exe` itself prints UTF-16LE (with a BOM), while anything the distro's
/// shell prints comes back UTF-8. Sniff the NUL pattern rather than trusting
/// either: the two are mixed across the two calls this module makes.
fn decode_wsl_output(bytes: &[u8]) -> String {
    let looks_utf16 =
        bytes.len() >= 2 && (bytes.starts_with(&[0xFF, 0xFE]) || (bytes[1] == 0 && bytes[0] != 0));
    if looks_utf16 {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        String::from_utf16_lossy(&units)
            .trim_start_matches('\u{feff}')
            .to_string()
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

#[cfg(windows)]
fn probe() -> String {
    use crate::proc::{command, output_with_timeout, OutputError};
    use std::time::Duration;

    let listed = match output_with_timeout(
        {
            let mut c = command("wsl.exe");
            c.args(["--list", "--quiet"]);
            c
        },
        Duration::from_secs(15),
    ) {
        Ok(out) if out.status.success() => decode_wsl_output(&out.stdout),
        // No wsl.exe, WSL feature off, or "no installed distributions"
        // (which wsl reports as a failure): all "absent" for our purposes.
        Ok(_) | Err(OutputError::Spawn(_)) => return "absent".to_string(),
        Err(OutputError::TimedOut) => return "timeout".to_string(),
    };
    let Some(distro) = user_distros(&listed).into_iter().next() else {
        return "absent".to_string();
    };
    // `-e` runs the command without the distro's login shell, so a slow or
    // broken profile cannot eat the budget. No double quotes inside the
    // script: they would have to survive both the Windows argv quoting and
    // wsl's own re-parse.
    const CHECK: &str = "for d in .claude .codex; do [ -e $HOME/$d ] && echo $d; done; exit 0";
    match output_with_timeout(
        {
            let mut c = command("wsl.exe");
            c.args(["-d", &distro, "-e", "sh", "-c", CHECK]);
            c
        },
        Duration::from_secs(30),
    ) {
        Ok(out) if out.status.success() => classify_check_output(&decode_wsl_output(&out.stdout)),
        Ok(_) | Err(OutputError::Spawn(_)) => "error".to_string(),
        Err(OutputError::TimedOut) => "timeout".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::{classify_check_output, decode_wsl_output, user_distros};

    #[test]
    fn check_output_names_the_agents_it_finds() {
        assert_eq!(classify_check_output(""), "no_agent");
        assert_eq!(classify_check_output(".claude\n"), "claude");
        assert_eq!(classify_check_output(".claude\n.codex\n"), "claude,codex");
        assert_eq!(classify_check_output("  .codex  \n"), "codex");
        // Anything else the shell might print is not an agent.
        assert_eq!(
            classify_check_output("bash: warning: setlocale\n"),
            "no_agent"
        );
    }

    /// wsl.exe prints UTF-16LE with a BOM; the distro's sh prints UTF-8. Both
    /// pass through the same decoder.
    #[test]
    fn decodes_utf16_from_wsl_and_utf8_from_the_distro() {
        let mut utf16 = vec![0xFF, 0xFE];
        for unit in "Ubuntu\r\n".encode_utf16() {
            utf16.extend_from_slice(&unit.to_le_bytes());
        }
        assert_eq!(decode_wsl_output(&utf16), "Ubuntu\r\n");
        // Without BOM, the NUL-after-first-byte pattern still identifies it.
        assert_eq!(decode_wsl_output(&utf16[2..]), "Ubuntu\r\n");
        assert_eq!(decode_wsl_output(b".claude\n"), ".claude\n");
        assert_eq!(decode_wsl_output(b""), "");
    }

    /// Docker Desktop's distros do not count as "the user has WSL".
    #[test]
    fn docker_desktop_distros_do_not_count() {
        assert!(user_distros("docker-desktop\r\ndocker-desktop-data\r\n").is_empty());
        assert_eq!(
            user_distros("Ubuntu-22.04\r\ndocker-desktop\r\n"),
            vec!["Ubuntu-22.04".to_string()]
        );
        assert!(user_distros("").is_empty());
    }
}
