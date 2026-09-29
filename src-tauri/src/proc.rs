//! Child-process spawning that stays invisible on Windows.
//!
//! Headroom is a GUI-subsystem binary, so it owns no console. When it spawns a
//! console-subsystem child (python.exe, pip, reg, powershell, taskkill) Windows
//! allocates a *new* console for that child and shows it. Because we pipe the
//! child's stdio, that window is an empty black rectangle the user has to look
//! at for the length of the install.
//!
//! `CREATE_NO_WINDOW` suppresses the console allocation without changing stdio,
//! exit-code, or lifetime semantics. Every spawn in this crate goes through
//! `command()` so a new call site can't reintroduce the flash;
//! `scripts/check-no-console.sh` fails the build if a bare `Command::new`
//! reappears.

use std::ffi::{OsStr, OsString};
use std::path::Path;
use std::process::Command;

/// <https://learn.microsoft.com/windows/win32/procthread/process-creation-flags>
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Drop-in replacement for `std::process::Command::new`.
pub fn command(program: impl AsRef<OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(resolve_system_tool(
        program.as_ref(),
        std::env::var_os("SystemRoot").as_deref(),
    ));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    // Python picks its stdio encoding from the locale, and we redirect every
    // child's stdout/stderr to a log file — so on Windows it resolves to the
    // ANSI codepage (cp1252), not UTF-8. Upstream's startup banner is not
    // ASCII, so `print()` raised UnicodeEncodeError and the backend died
    // before opening its port, with the app reporting only an opaque exit
    // 0xc000013a (Sentry RUST-7C). Applied to every spawn rather than the one
    // that crashed: the prefetch and smoke-test children print too, and a
    // POSIX box running under LC_ALL=C has the identical exposure.
    // `backslashreplace` over plain `utf-8` because a log stream must never be
    // the thing that kills the process (a lone surrogate still encodes).
    command.env("PYTHONIOENCODING", "utf-8:backslashreplace");
    command
}

/// How long a pipe may stay open after its child exited. A grandchild that
/// inherited the write end (a Windows `.exe` launcher's python, an agent
/// CLI's background updater) keeps it open for as long as it lives, so
/// reading to EOF would block the caller forever (RUST-BH: bootstrap sat at
/// "Configuring integrations" for 20+ minutes with the 120s timeout never
/// firing). What the child itself wrote is already in the pipe by then.
pub const PIPE_DRAIN_GRACE: std::time::Duration = std::time::Duration::from_secs(2);

/// Reads a child pipe on its own thread and hands back what arrived, without
/// ever waiting on EOF past a deadline. See [`PIPE_DRAIN_GRACE`].
pub struct PipeDrain {
    /// `None` once `finish` took it: an abandoned reader keeps draining the
    /// pipe (closing it would hand the writer a broken pipe) but stores nothing.
    buf: std::sync::Arc<std::sync::Mutex<Option<Vec<u8>>>>,
    done: std::sync::mpsc::Receiver<()>,
}

impl PipeDrain {
    pub fn spawn<R: std::io::Read + Send + 'static>(pipe: Option<R>) -> Self {
        let buf = std::sync::Arc::new(std::sync::Mutex::new(Some(Vec::new())));
        let (tx, done) = std::sync::mpsc::channel();
        let sink = buf.clone();
        std::thread::spawn(move || {
            if let Some(mut pipe) = pipe {
                let mut chunk = [0u8; 8192];
                loop {
                    match pipe.read(&mut chunk) {
                        Ok(0) => break,
                        Ok(n) => {
                            if let Some(buf) =
                                sink.lock().unwrap_or_else(|e| e.into_inner()).as_mut()
                            {
                                buf.extend_from_slice(&chunk[..n]);
                            }
                        }
                        Err(err) if err.kind() == std::io::ErrorKind::Interrupted => {}
                        Err(_) => break,
                    }
                }
            }
            let _ = tx.send(());
        });
        Self { buf, done }
    }

    /// Everything read by EOF or by `deadline`, whichever comes first. A
    /// reader still blocked at the deadline is left behind; it ends when the
    /// last writer closes.
    pub fn finish(self, deadline: std::time::Instant) -> Vec<u8> {
        let wait = deadline.saturating_duration_since(std::time::Instant::now());
        let _ = self.done.recv_timeout(wait);
        self.buf
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
            .unwrap_or_default()
    }
}

/// Kills `child` and, on Windows, everything it started. A venv `python.exe`
/// or an npm `.cmd` shim is only a launcher: killing it alone leaves the real
/// process running beside the caller's retry, holding the venv and the pipes.
/// Naming the pid is safe while we still hold the unreaped handle.
pub fn kill_tree(child: &mut std::process::Child) {
    #[cfg(windows)]
    {
        use std::process::Stdio;
        let spawned = command("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        if let Ok(mut taskkill) = spawned {
            // Bounded, and not via output_with_timeout (which calls this):
            // taskkill /T enumerates through the machinery a wedged WMI stalls.
            let started = std::time::Instant::now();
            while matches!(taskkill.try_wait(), Ok(None))
                && started.elapsed() < std::time::Duration::from_secs(5)
            {
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            let _ = taskkill.kill();
            let _ = taskkill.wait();
        }
    }
    let _ = child.kill();
}

/// Why a spawned child did not produce an `Output`.
#[derive(Debug)]
pub enum OutputError {
    Spawn(std::io::Error),
    TimedOut,
}

/// `Command::output()` with a deadline. `std` has no `wait_timeout`, so this
/// is the same try_wait/kill loop `tool_manager::run_command_with_timeout`
/// uses, minus the pip-specific error shaping, for probes that must never
/// hang the caller (a WSL distro that is still booting, a PowerShell that
/// blocks on a profile). Stdin is closed so a child that reads it cannot wait
/// on us either. On timeout the child is killed and reaped; whatever it
/// wrote is discarded, because a partial answer is not an answer.
pub fn output_with_timeout(
    mut command: Command,
    timeout: std::time::Duration,
) -> Result<std::process::Output, OutputError> {
    use std::process::Stdio;

    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(OutputError::Spawn)?;
    // Drain both pipes off-thread: a child that fills one while we wait on
    // the other deadlocks against the pipe buffer.
    let stdout = PipeDrain::spawn(child.stdout.take());
    let stderr = PipeDrain::spawn(child.stderr.take());

    let started = std::time::Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() >= timeout => {
                kill_tree(&mut child);
                let _ = child.wait();
                return Err(OutputError::TimedOut);
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(25)),
            Err(err) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(OutputError::Spawn(err));
            }
        }
    };
    let drained_by = std::time::Instant::now() + PIPE_DRAIN_GRACE;
    Ok(std::process::Output {
        status,
        stdout: stdout.finish(drained_by),
        stderr: stderr.finish(drained_by),
    })
}

/// The Windows tools we shell out to that live directly in `System32`.
/// `powershell` is handled separately: it sits one level deeper.
const SYSTEM32_TOOLS: [&str; 5] = ["netstat", "tasklist", "taskkill", "reg", "hostname"];

/// A Windows system tool by its canonical absolute path when `system_root` has
/// one.
///
/// A bare name resolves through PATH, and a user-edited PATH that lost
/// `System32\WindowsPowerShell\v1.0` turned every sweep, kill, and port-owner
/// lookup into "program not found" (RUST-CH/CJ/CK: one 0.9.7 host, three
/// issues, all this one spawn). A PATH that lost `System32` itself does the
/// same to the rest of the list, and the port paths fail SILENTLY when it
/// does: no `netstat` means no occupant to name, so a held 6767 reports as
/// "nothing is listening" and `reclaim_stranded_intercept_holder` bails before
/// its identity gate. Every other program passes through untouched; a missing
/// canonical file falls back to the bare name so the error stays the one it is
/// today.
fn resolve_system_tool(program: &OsStr, system_root: Option<&OsStr>) -> OsString {
    let Some(root) = system_root else {
        return program.to_os_string();
    };
    let full = if program.eq_ignore_ascii_case("powershell") {
        Path::new(root)
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe")
    } else if let Some(tool) = SYSTEM32_TOOLS
        .iter()
        .find(|tool| program.eq_ignore_ascii_case(tool))
    {
        Path::new(root).join("System32").join(format!("{tool}.exe"))
    } else {
        return program.to_os_string();
    };
    if full.is_file() {
        return full.into_os_string();
    }
    program.to_os_string()
}

/// Current PATH with `dir` prepended, joined with the platform separator
/// (':' on Unix, ';' on Windows). Hand-formatted `"{dir}:{existing}"` strings
/// were a recurring Windows bug: the colon fuses the new dir and the first
/// existing entry into one garbage path. On the (pathological) case where a
/// PATH entry contains the separator, returns the existing PATH unchanged
/// rather than corrupting it.
pub fn path_with_dir_prepended(dir: &Path) -> OsString {
    path_with_dir_prepended_to(dir, &std::env::var_os("PATH").unwrap_or_default())
}

/// As `path_with_dir_prepended`, but over a caller-supplied base instead of the
/// process PATH -- so a caller that has already filtered the inherited PATH can
/// still put the binary's own directory first (and keep it there, whatever the
/// filter dropped).
pub fn path_with_dir_prepended_to(dir: &Path, existing: &OsStr) -> OsString {
    std::env::join_paths(std::iter::once(dir.to_path_buf()).chain(std::env::split_paths(existing)))
        .unwrap_or_else(|_| existing.to_os_string())
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    #[test]
    fn output_with_timeout_returns_when_a_grandchild_holds_the_pipe() {
        // RUST-BH: the child exits, a background grandchild keeps stdout
        // open. Reading to EOF used to block until the grandchild died.
        let mut cmd = std::process::Command::new("sh");
        cmd.args(["-c", "sleep 30 & echo done"]);
        let started = std::time::Instant::now();
        let output = super::output_with_timeout(cmd, std::time::Duration::from_secs(20))
            .expect("child exits");
        assert!(output.status.success());
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "done");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(10),
            "waited on the grandchild: {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn path_with_dir_prepended_puts_dir_first_with_platform_separator() {
        let dir = std::env::temp_dir();
        let path = super::path_with_dir_prepended(&dir);
        let entries: Vec<_> = std::env::split_paths(&path).collect();
        assert_eq!(entries.first(), Some(&dir));
        let existing: Vec<_> =
            std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect();
        assert_eq!(entries.len(), existing.len() + 1);
    }

    /// RUST-CH/CJ/CK: "powershell" must not depend on the user's PATH.
    #[test]
    fn powershell_resolves_to_system_root_when_present() {
        use std::ffi::OsStr;
        let root = tempfile::tempdir().expect("tempdir");
        let dir = root
            .path()
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0");
        std::fs::create_dir_all(&dir).expect("mkdir");
        let exe = dir.join("powershell.exe");
        std::fs::write(&exe, b"x").expect("write");
        let root_os = Some(root.path().as_os_str());
        assert_eq!(
            super::resolve_system_tool(OsStr::new("powershell"), root_os),
            exe.as_os_str()
        );
        assert_eq!(
            super::resolve_system_tool(OsStr::new("PowerShell"), root_os),
            exe.as_os_str()
        );
        // The System32 tools the port paths depend on resolve the same way --
        // without netstat a held 6767 has no occupant to name at all.
        let system32 = root.path().join("System32");
        std::fs::create_dir_all(&system32).expect("mkdir");
        for tool in ["netstat", "tasklist", "taskkill", "reg", "hostname"] {
            let tool_exe = system32.join(format!("{tool}.exe"));
            std::fs::write(&tool_exe, b"x").expect("write");
            assert_eq!(
                super::resolve_system_tool(OsStr::new(tool), root_os),
                tool_exe.as_os_str()
            );
        }
        // Other programs, no SystemRoot, and a SystemRoot without the file all
        // pass the bare name through.
        assert_eq!(
            super::resolve_system_tool(OsStr::new("cmd"), root_os),
            OsStr::new("cmd")
        );
        assert_eq!(
            super::resolve_system_tool(OsStr::new("powershell"), None),
            OsStr::new("powershell")
        );
        let empty = tempfile::tempdir().expect("tempdir");
        assert_eq!(
            super::resolve_system_tool(OsStr::new("powershell"), Some(empty.path().as_os_str())),
            OsStr::new("powershell")
        );
        assert_eq!(
            super::resolve_system_tool(OsStr::new("netstat"), Some(empty.path().as_os_str())),
            OsStr::new("netstat")
        );
    }

    #[test]
    fn command_still_runs_and_captures_output() {
        // The flag must not disturb stdio or exit codes on any platform.
        let program = if cfg!(windows) { "cmd" } else { "/bin/echo" };
        let args: &[&str] = if cfg!(windows) {
            &["/C", "echo headroom"]
        } else {
            &["headroom"]
        };
        let out = super::command(program).args(args).output().expect("spawn");
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "headroom");
    }

    /// RUST-7C: the backend died printing a non-ASCII banner to a redirected
    /// stdout because Python fell back to the platform codepage. Deterministic
    /// half -- the variable must be on every command we hand out.
    #[test]
    fn command_forces_utf8_python_stdio() {
        let cmd = super::command("python3");
        let set = cmd
            .get_envs()
            .find(|(k, _)| *k == std::ffi::OsStr::new("PYTHONIOENCODING"))
            .and_then(|(_, v)| v)
            .expect("PYTHONIOENCODING is set");
        assert_eq!(set, std::ffi::OsStr::new("utf-8:backslashreplace"));
    }

    /// Behavioural half: the exact shape that crashed -- non-ASCII `print()`
    /// with stdout captured (not a tty), which is how we spawn the backend.
    /// Skipped where no interpreter is on PATH; the assert above still guards.
    #[test]
    fn python_prints_non_ascii_to_piped_stdout_without_dying() {
        let banner = "\u{250c}\u{2500} Headroom \u{2192} 100% \u{2713}";
        let script = format!("print('{banner}')");
        let out = match super::command("python3").args(["-c", &script]).output() {
            Ok(out) => out,
            // No python3 on PATH in this environment.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return,
            Err(e) => panic!("spawn failed: {e}"),
        };
        assert!(
            out.status.success(),
            "non-ASCII print killed the child: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(String::from_utf8_lossy(&out.stdout).contains("Headroom"));
    }
}
