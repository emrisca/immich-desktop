//! The one thing a phone needs that the app cannot grant itself: an inbound
//! Windows Firewall rule for the bundled node, which is the process that listens
//! on the LAN.
//!
//! Windows only ever lets an administrator change the firewall, so the honest
//! flow is: the app asks once through UAC, and the switch in the UI is honest
//! about whether the rule is there. Off Windows everything reports "allowed",
//! because there is no equivalent gate to open.

use std::path::Path;
use std::process::{Command, Stdio};

#[cfg(windows)]
const RULE: &str = "Immich Desktop server";

/// Whether the rule exists **and** points at this build's node.
///
/// The program path matters after a reinstall into another folder: the name would
/// still match while the rule pointed at an executable that is no longer there.
/// `netsh` exits non-zero when nothing matches — language independent — and the
/// path appears verbatim in its output whatever the display language.
pub fn allowed(_program: &Path) -> bool {
    #[cfg(not(windows))]
    {
        return true;
    }

    #[cfg(windows)]
    {
        match show() {
            Some(text) => text.contains(&native(_program).to_lowercase()),
            None => false,
        }
    }
}

/// The path as `netsh` and the registry spell it: backslashes, no verbatim
/// prefix. Forward slashes are refused outright — "the application contains
/// invalid characters" — even though Windows accepts them everywhere else.
fn native(path: &Path) -> String {
    crate::layout::plain(path).replace('/', "\\")
}

/// Whether a rule with our name exists at all, whatever program it points at.
pub fn present() -> bool {
    #[cfg(not(windows))]
    {
        return true;
    }

    #[cfg(windows)]
    {
        show().is_some()
    }
}

/// `netsh` output for our rule, or `None` when no rule matches.
#[cfg(windows)]
fn show() -> Option<String> {
    let output = Command::new("netsh")
        .args([
            "advfirewall",
            "firewall",
            "show",
            "rule",
            &format!("name={RULE}"),
            "verbose",
        ])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).to_lowercase())
}

/// Create the rule, asking for elevation. Returns whether it ended up in place.
///
/// The elevation is `ShellExecuteW` with the `runas` verb: one UAC prompt and no
/// interpreter in between. A PowerShell one-liner doing the same thing is what
/// Windows Defender deletes as `Trojan:PowerShell/Powdow`, and it deleted this
/// application the first time it tried.
pub fn install(program: &Path) -> bool {
    #[cfg(not(windows))]
    {
        let _ = program;
        return true;
    }

    #[cfg(windows)]
    {
        if allowed(program) {
            return true;
        }

        let target = native(program);
        let args = format!(
            "advfirewall firewall add rule name=\"{RULE}\" dir=in action=allow program=\"{target}\" enable=yes profile=any"
        );

        // A same-named rule pointing at an older install is replaced, not
        // duplicated; netsh takes one command per call, so this is two prompts.
        if present() {
            elevate(&format!("advfirewall firewall delete rule name=\"{RULE}\""));
        }
        elevate(&args);

        // The elevated process reports nothing back; the rule is the answer.
        allowed(program)
    }
}

#[cfg(windows)]
fn elevate(arguments: &str) {
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;

    let verb: Vec<u16> = "runas\0".encode_utf16().collect();
    let file: Vec<u16> = "netsh\0".encode_utf16().collect();
    let params: Vec<u16> = arguments.encode_utf16().chain(std::iter::once(0)).collect();

    // Returns a fake HINSTANCE; anything above 32 means it started. A declined
    // UAC prompt comes back as 5 (access denied), which `allowed` then catches.
    unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            file.as_ptr(),
            params.as_ptr(),
            std::ptr::null(),
            SW_HIDE,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn netsh_gets_backslashes() {
        // netsh refuses "C:/.../node.exe" with "invalid characters", and the
        // rule's own output comes back with backslashes, so both sides must agree.
        assert_eq!(
            native(Path::new("C:/Users/me/Immich Desktop/runtime/node/node.exe")),
            "C:\\Users\\me\\Immich Desktop\\runtime\\node\\node.exe"
        );
    }
}
