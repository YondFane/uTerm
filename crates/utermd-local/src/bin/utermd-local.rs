fn main() -> anyhow::Result<()> {
    let mut arguments = std::env::args_os().skip(1);
    let mode = arguments.next();
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
