//! Process jail for type-B external engines (docs/hub-harness-swap/PLAN.md, "外部 CLI 型",
//! decision 4, 2026-10-18 owner-approved).
//!
//! The Hub Desktop executable doubles as the jail: the engine bridge starts
//! `hub-local-runner.exe --hub-engine-jail --parent <pid> --cwd <dir> --stats <file>
//! [--low-dir <dir>]... -- <program> [args...]`, and the jail
//!
//! 1. labels every `--low-dir` Low integrity (object and container inherit), so the engine can
//!    write its own scratch, HOME and config there and nowhere else the user can write;
//! 2. starts `<program>` suspended with a Low integrity copy of the caller's token, the jail's
//!    standard handles and no console window;
//! 3. puts it in a job object that allows exactly one active process (the engine cannot start a
//!    shell or any other child), kills the whole job when the jail's handle closes, and blocks
//!    clipboard, desktop and system-setting changes;
//! 4. resumes it and waits; if the parent (the bridge) exits first, it terminates the job;
//! 5. writes `{totalProcesses, processLimitHits, exitCode, endedBy}` to `--stats`, which must
//!    live outside every low directory so the engine cannot rewrite it.
//!
//! It does not block reads or network connections. That limit is stated in the engine picker.

/// Runs the jail when argv[1] is `--hub-engine-jail`; `None` means "start the app as usual".
pub fn dispatch() -> Option<i32> {
    let args: Vec<std::ffi::OsString> = std::env::args_os().collect();
    if args.get(1).map(|arg| arg == "--hub-engine-jail") != Some(true) {
        return None;
    }
    Some(match Options::parse(&args[2..]) {
        Ok(options) => run(options),
        Err(error) => {
            eprintln!("hub-engine-jail: {error}");
            2
        }
    })
}

#[derive(Debug, Default, PartialEq)]
pub(crate) struct Options {
    pub parent: u32,
    pub cwd: std::path::PathBuf,
    pub stats: std::path::PathBuf,
    pub low_dirs: Vec<std::path::PathBuf>,
    pub program: std::ffi::OsString,
    pub args: Vec<std::ffi::OsString>,
}

impl Options {
    pub(crate) fn parse(args: &[std::ffi::OsString]) -> Result<Self, &'static str> {
        let mut options = Options::default();
        let mut index = 0;
        let mut parent = None;
        while index < args.len() {
            let flag = args[index].to_str().ok_or("jail_arguments_invalid")?;
            if flag == "--" {
                index += 1;
                break;
            }
            let value = args.get(index + 1).ok_or("jail_arguments_invalid")?;
            match flag {
                "--parent" => parent = Some(value.to_str().and_then(|v| v.parse::<u32>().ok()).ok_or("jail_arguments_invalid")?),
                "--cwd" => options.cwd = value.into(),
                "--stats" => options.stats = value.into(),
                "--low-dir" => options.low_dirs.push(value.into()),
                _ => return Err("jail_arguments_invalid"),
            }
            index += 2;
        }
        let program = args.get(index).ok_or("jail_program_missing")?;
        options.program = program.clone();
        options.args = args[index + 1..].to_vec();
        options.parent = parent.ok_or("jail_arguments_invalid")?;
        if options.cwd.as_os_str().is_empty() || options.stats.as_os_str().is_empty() || !options.cwd.is_absolute()
            || !options.stats.is_absolute() || options.low_dirs.iter().any(|dir| !dir.is_absolute()) {
            return Err("jail_arguments_invalid");
        }
        // The stats file must not be writable by the engine.
        if options.low_dirs.iter().any(|dir| options.stats.starts_with(dir)) {
            return Err("jail_stats_inside_low_dir");
        }
        Ok(options)
    }
}

/// One argv element in the quoting `CommandLineToArgvW` and the MSVC runtime read back.
pub(crate) fn quote_arg(arg: &str) -> String {
    if !arg.is_empty() && !arg.chars().any(|c| matches!(c, ' ' | '\t' | '\n' | '\u{b}' | '"')) {
        return arg.to_owned();
    }
    let mut quoted = String::from("\"");
    let mut backslashes = 0usize;
    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                quoted.extend(std::iter::repeat('\\').take(backslashes * 2 + 1));
                quoted.push('"');
                backslashes = 0;
            }
            _ => {
                quoted.extend(std::iter::repeat('\\').take(backslashes));
                quoted.push(c);
                backslashes = 0;
            }
        }
    }
    quoted.extend(std::iter::repeat('\\').take(backslashes * 2));
    quoted.push('"');
    quoted
}

#[cfg(not(windows))]
fn run(_options: Options) -> i32 {
    eprintln!("hub-engine-jail: engine_jail_unsupported");
    3
}

#[cfg(windows)]
fn run(options: Options) -> i32 {
    match windows_jail::run(&options) {
        Ok(code) => code,
        Err(error) => {
            eprintln!("hub-engine-jail: {error}");
            let _ = std::fs::write(&options.stats, serde_json::json!({"error": error}).to_string());
            4
        }
    }
}

#[cfg(windows)]
mod windows_jail {
    use super::{quote_arg, Options};
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, LocalFree, SetHandleInformation, BOOL, HANDLE,
        HANDLE_FLAG_INHERIT, WAIT_OBJECT_0};
    use windows_sys::Win32::Security::Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW,
        ConvertStringSidToSidW, SetNamedSecurityInfoW, SE_FILE_OBJECT};
    use windows_sys::Win32::Security::{DuplicateTokenEx, GetLengthSid, GetSecurityDescriptorSacl, SecurityImpersonation,
        SetTokenInformation, TokenIntegrityLevel, TokenPrimary, ACL, LABEL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
        PSID, SID_AND_ATTRIBUTES, TOKEN_ADJUST_DEFAULT, TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE,
        TOKEN_MANDATORY_LABEL, TOKEN_QUERY};
    use windows_sys::Win32::System::Console::{GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE};
    use windows_sys::Win32::System::IO::{CreateIoCompletionPort, GetQueuedCompletionStatus, OVERLAPPED};
    use windows_sys::Win32::System::JobObjects::{AssignProcessToJobObject, CreateJobObjectW,
        JobObjectAssociateCompletionPortInformation, JobObjectBasicAccountingInformation, JobObjectBasicUIRestrictions,
        JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
        JOBOBJECT_ASSOCIATE_COMPLETION_PORT, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_BASIC_UI_RESTRICTIONS,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_ACTIVE_PROCESS, JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION,
        JOB_OBJECT_LIMIT_JOB_MEMORY, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_UILIMIT_DESKTOP,
        JOB_OBJECT_UILIMIT_DISPLAYSETTINGS, JOB_OBJECT_UILIMIT_EXITWINDOWS, JOB_OBJECT_UILIMIT_GLOBALATOMS,
        JOB_OBJECT_UILIMIT_HANDLES, JOB_OBJECT_UILIMIT_READCLIPBOARD, JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS,
        JOB_OBJECT_UILIMIT_WRITECLIPBOARD};
    use windows_sys::Win32::System::Threading::{CreateProcessAsUserW, GetCurrentProcess, GetExitCodeProcess,
        OpenProcess, OpenProcessToken, ResumeThread, WaitForSingleObject, CREATE_NO_WINDOW, CREATE_SUSPENDED,
        CREATE_UNICODE_ENVIRONMENT, PROCESS_INFORMATION, PROCESS_SYNCHRONIZE, STARTF_USESTDHANDLES, STARTUPINFOW};

    /// `JOB_OBJECT_MSG_ACTIVE_PROCESS_LIMIT`: a process creation the limit refused.
    const MSG_ACTIVE_PROCESS_LIMIT: u32 = 3;
    const MEMORY_LIMIT: usize = 4 << 30;

    fn wide(value: &std::ffi::OsStr) -> Vec<u16> {
        value.encode_wide().chain(Some(0)).collect()
    }

    struct Owned(HANDLE);
    impl Drop for Owned {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CloseHandle(self.0) };
            }
        }
    }

    fn last(what: &str) -> String {
        format!("{what}_failed:{}", unsafe { GetLastError() })
    }

    /// Low integrity, inherited by every file and folder below.
    pub(crate) fn label_low(dir: &std::path::Path) -> Result<(), String> {
        unsafe {
            let sddl = wide(std::ffi::OsStr::new("S:(ML;OICI;NW;;;LW)"));
            let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
            if ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), 1, &mut descriptor, std::ptr::null_mut()) == 0 {
                return Err(last("label_descriptor"));
            }
            let mut present: BOOL = 0;
            let mut defaulted: BOOL = 0;
            let mut sacl: *mut ACL = std::ptr::null_mut();
            let ok = GetSecurityDescriptorSacl(descriptor, &mut present, &mut sacl, &mut defaulted);
            let result = if ok == 0 || present == 0 {
                Err(last("label_sacl"))
            } else {
                let path = wide(dir.as_os_str());
                match SetNamedSecurityInfoW(path.as_ptr(), SE_FILE_OBJECT, LABEL_SECURITY_INFORMATION, std::ptr::null_mut(),
                    std::ptr::null_mut(), std::ptr::null(), sacl) {
                    0 => Ok(()),
                    code => Err(format!("label_set_failed:{code}")),
                }
            };
            LocalFree(descriptor as _);
            result
        }
    }

    fn low_token() -> Result<Owned, String> {
        unsafe {
            let mut token: HANDLE = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ADJUST_DEFAULT | TOKEN_ASSIGN_PRIMARY, &mut token) == 0 {
                return Err(last("open_token"));
            }
            let token = Owned(token);
            let mut low: HANDLE = std::ptr::null_mut();
            if DuplicateTokenEx(token.0, TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ADJUST_DEFAULT | TOKEN_ASSIGN_PRIMARY,
                std::ptr::null(), SecurityImpersonation, TokenPrimary, &mut low) == 0 {
                return Err(last("duplicate_token"));
            }
            let low = Owned(low);
            let sid_text = wide(std::ffi::OsStr::new("S-1-16-4096"));
            let mut sid: PSID = std::ptr::null_mut();
            if ConvertStringSidToSidW(sid_text.as_ptr(), &mut sid) == 0 {
                return Err(last("low_sid"));
            }
            let label = TOKEN_MANDATORY_LABEL { Label: SID_AND_ATTRIBUTES { Sid: sid, Attributes: 0x20 /* SE_GROUP_INTEGRITY */ } };
            let size = std::mem::size_of::<TOKEN_MANDATORY_LABEL>() as u32 + GetLengthSid(sid);
            let ok = SetTokenInformation(low.0, TokenIntegrityLevel, &label as *const _ as *const _, size);
            LocalFree(sid as _);
            if ok == 0 {
                return Err(last("set_integrity"));
            }
            Ok(low)
        }
    }

    fn job(port: HANDLE) -> Result<Owned, String> {
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(last("create_job"));
            }
            let job = Owned(job);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION | JOB_OBJECT_LIMIT_JOB_MEMORY;
            limits.BasicLimitInformation.ActiveProcessLimit = 1;
            limits.JobMemoryLimit = MEMORY_LIMIT;
            if SetInformationJobObject(job.0, JobObjectExtendedLimitInformation, &limits as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32) == 0 {
                return Err(last("job_limits"));
            }
            let ui = JOBOBJECT_BASIC_UI_RESTRICTIONS { UIRestrictionsClass: JOB_OBJECT_UILIMIT_DESKTOP
                | JOB_OBJECT_UILIMIT_DISPLAYSETTINGS | JOB_OBJECT_UILIMIT_EXITWINDOWS | JOB_OBJECT_UILIMIT_GLOBALATOMS
                | JOB_OBJECT_UILIMIT_HANDLES | JOB_OBJECT_UILIMIT_READCLIPBOARD | JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS
                | JOB_OBJECT_UILIMIT_WRITECLIPBOARD };
            if SetInformationJobObject(job.0, JobObjectBasicUIRestrictions, &ui as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_BASIC_UI_RESTRICTIONS>() as u32) == 0 {
                return Err(last("job_ui"));
            }
            let association = JOBOBJECT_ASSOCIATE_COMPLETION_PORT { CompletionKey: std::ptr::null_mut(), CompletionPort: port };
            if SetInformationJobObject(job.0, JobObjectAssociateCompletionPortInformation, &association as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_ASSOCIATE_COMPLETION_PORT>() as u32) == 0 {
                return Err(last("job_port"));
            }
            Ok(job)
        }
    }

    pub(super) fn run(options: &Options) -> Result<i32, String> {
        for dir in &options.low_dirs {
            label_low(dir)?;
        }
        unsafe {
            let parent = Owned(OpenProcess(PROCESS_SYNCHRONIZE, 0, options.parent));
            if parent.0.is_null() {
                return Err(last("open_parent"));
            }
            let token = low_token()?;
            let port = Owned(CreateIoCompletionPort(-1isize as HANDLE, std::ptr::null_mut(), 0, 1));
            if port.0.is_null() {
                return Err(last("completion_port"));
            }
            let job = job(port.0)?;
            let mut line = quote_arg(&options.program.to_string_lossy());
            for arg in &options.args {
                line.push(' ');
                line.push_str(&quote_arg(&arg.to_string_lossy()));
            }
            let mut line: Vec<u16> = line.encode_utf16().chain(Some(0)).collect();
            let cwd = wide(options.cwd.as_os_str());
            let mut startup: STARTUPINFOW = std::mem::zeroed();
            startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
            startup.dwFlags = STARTF_USESTDHANDLES;
            startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
            startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
            startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
            for handle in [startup.hStdInput, startup.hStdOutput, startup.hStdError] {
                if !handle.is_null() && handle != -1isize as HANDLE {
                    SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
                }
            }
            let mut process: PROCESS_INFORMATION = std::mem::zeroed();
            if CreateProcessAsUserW(token.0, std::ptr::null(), line.as_mut_ptr(), std::ptr::null(), std::ptr::null(), 1,
                CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT, std::ptr::null(), cwd.as_ptr(), &startup,
                &mut process) == 0 {
                return Err(last("create_process"));
            }
            let child = Owned(process.hProcess);
            let thread = Owned(process.hThread);
            if AssignProcessToJobObject(job.0, child.0) == 0 {
                let error = last("assign_job");
                windows_sys::Win32::System::Threading::TerminateProcess(child.0, 1);
                return Err(error);
            }
            ResumeThread(thread.0);
            drop(thread);
            // For the escape suite's connection sampling (`scripts/engine-escape.mjs`).
            let _ = std::fs::write(options.stats.with_extension("pid"), process.dwProcessId.to_string());
            let mut limit_hits = 0u32;
            let ended_by = loop {
                let mut message = 0u32;
                let mut key = 0usize;
                let mut overlapped: *mut OVERLAPPED = std::ptr::null_mut();
                if GetQueuedCompletionStatus(port.0, &mut message, &mut key, &mut overlapped, 100) != 0
                    && message == MSG_ACTIVE_PROCESS_LIMIT {
                    limit_hits += 1;
                }
                if WaitForSingleObject(child.0, 0) == WAIT_OBJECT_0 {
                    break "exit";
                }
                if WaitForSingleObject(parent.0, 0) == WAIT_OBJECT_0 {
                    TerminateJobObject(job.0, 1);
                    WaitForSingleObject(child.0, 5000);
                    break "parent_exit";
                }
            };
            let mut code = 0u32;
            GetExitCodeProcess(child.0, &mut code);
            let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = std::mem::zeroed();
            QueryInformationJobObject(job.0, JobObjectBasicAccountingInformation, &mut accounting as *mut _ as *mut _,
                std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32, std::ptr::null_mut());
            let _ = std::fs::write(&options.stats, serde_json::json!({
                "totalProcesses": accounting.TotalProcesses,
                "processLimitHits": limit_hits,
                "exitCode": code,
                "endedBy": ended_by,
            }).to_string());
            Ok(code as i32)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    fn os(items: &[&str]) -> Vec<OsString> {
        items.iter().map(OsString::from).collect()
    }

    #[test]
    fn options_need_a_parent_absolute_paths_and_a_stats_file_outside_low_dirs() {
        let parsed = Options::parse(&os(&["--parent", "42", "--cwd", r"C:\r\e\scratch", "--stats", r"C:\r\stats.json",
            "--low-dir", r"C:\r\e", "--", "node.exe", "bin.js", "--x"])).unwrap();
        assert_eq!(parsed.parent, 42);
        assert_eq!(parsed.program, "node.exe");
        assert_eq!(parsed.args, os(&["bin.js", "--x"]));
        assert_eq!(Options::parse(&os(&["--cwd", r"C:\a", "--stats", r"C:\s", "--", "x"])).unwrap_err(), "jail_arguments_invalid");
        assert_eq!(Options::parse(&os(&["--parent", "1", "--cwd", "rel", "--stats", r"C:\s", "--", "x"])).unwrap_err(), "jail_arguments_invalid");
        assert_eq!(Options::parse(&os(&["--parent", "1", "--cwd", r"C:\r\e", "--stats", r"C:\r\e\stats.json", "--low-dir", r"C:\r\e", "--", "x"])).unwrap_err(),
            "jail_stats_inside_low_dir");
        assert_eq!(Options::parse(&os(&["--parent", "1", "--cwd", r"C:\a", "--stats", r"C:\s", "--bogus", "1", "--", "x"])).unwrap_err(), "jail_arguments_invalid");
        assert_eq!(Options::parse(&os(&["--parent", "1", "--cwd", r"C:\a", "--stats", r"C:\s", "--"])).unwrap_err(), "jail_program_missing");
    }

    #[test]
    fn arguments_round_trip_through_windows_quoting() {
        assert_eq!(quote_arg("plain"), "plain");
        assert_eq!(quote_arg(""), "\"\"");
        assert_eq!(quote_arg("a b"), "\"a b\"");
        assert_eq!(quote_arg(r#"say "hi""#), r#""say \"hi\"""#);
        assert_eq!(quote_arg(r"C:\dir with space\"), r#""C:\dir with space\\""#);
        assert_eq!(quote_arg(r"C:\no\space"), r"C:\no\space");
    }

    /// The real jail: a child that tries to spawn a process and to write outside the low folder.
    /// Needs the built app (`HUB_ENGINE_JAIL`), so it runs only from `scripts/engine-escape.mjs`.
    #[cfg(windows)]
    #[test]
    #[ignore = "needs the built hub-local-runner.exe in HUB_ENGINE_JAIL"]
    fn jail_blocks_child_processes_and_writes_outside_the_low_folder() {
        let jail = std::env::var("HUB_ENGINE_JAIL").expect("HUB_ENGINE_JAIL");
        let root = std::env::temp_dir().join(format!("hub-jail-{}", uuid::Uuid::new_v4()));
        let low = root.join("e");
        std::fs::create_dir_all(&low).unwrap();
        let outside = root.join("outside.txt");
        let script = format!(
            "const fs=require('fs');let spawned='no',outside='no',inside='no';\
             try{{require('child_process').execFileSync('cmd.exe',['/c','echo','x']);spawned='yes'}}catch{{}}\
             try{{fs.writeFileSync({:?},'x');outside='yes'}}catch{{}}\
             try{{fs.writeFileSync('inside.txt','x');inside='yes'}}catch{{}}\
             console.log(JSON.stringify({{spawned,outside,inside}}))",
            outside.to_string_lossy());
        let output = std::process::Command::new(&jail)
            .args(["--hub-engine-jail", "--parent", &std::process::id().to_string(), "--cwd"]).arg(&low)
            .arg("--stats").arg(root.join("stats.json")).arg("--low-dir").arg(&low)
            .args(["--", "node", "-e", &script]).output().unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(stdout.contains(r#""spawned":"no""#) && stdout.contains(r#""outside":"no""#) && stdout.contains(r#""inside":"yes""#), "{stdout} {}", String::from_utf8_lossy(&output.stderr));
        assert!(!outside.exists());
        let stats: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(root.join("stats.json")).unwrap()).unwrap();
        assert_eq!(stats["totalProcesses"], 1);
        assert!(stats["processLimitHits"].as_u64().unwrap() >= 1);
        let _ = std::fs::remove_dir_all(root);
    }
}
