// Match the desktop subsystem so host tests cover Windows console attachment.
// 与桌面程序的子系统保持一致，使宿主测试覆盖 Windows 控制台附加。
#![cfg_attr(windows, windows_subsystem = "windows")]

fn main() -> anyhow::Result<()> {
    if utermd_local::ssh_askpass::requested() {
        return utermd_local::ssh_askpass::run();
    }
    let mut arguments = std::env::args_os().skip(1);
    let mode = arguments.next();
    if mode.as_deref() == Some(std::ffi::OsStr::new("--local-task")) {
        let directory = arguments
            .next()
            .or_else(|| std::env::var_os("UTERM_TASK_ROOT"))
            .ok_or_else(|| anyhow::anyhow!("JAVA_TASK_INVALID"))?;
        let id = arguments
            .next()
            .or_else(|| std::env::var_os("UTERM_TASK_ID"))
            .ok_or_else(|| anyhow::anyhow!("JAVA_TASK_INVALID"))?;
        std::process::exit(utermd_local::tasks::run(
            std::path::Path::new(&directory),
            &id.to_string_lossy(),
        )?);
    }
    if mode.as_deref() == Some(std::ffi::OsStr::new("--agent-report")) {
        utermd_local::daemon::report_from_environment(
            arguments
                .next()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
        )?;
        println!("{{}}");
        return Ok(());
    }
    if mode.as_deref() != Some(std::ffi::OsStr::new("--local-daemon")) {
        anyhow::bail!("Usage: utermd-local --local-daemon <state-directory>");
    }
    let directory = arguments
        .next()
        .ok_or_else(|| anyhow::anyhow!("Missing state directory"))?;
    utermd_local::daemon::serve(std::path::Path::new(&directory))
}
