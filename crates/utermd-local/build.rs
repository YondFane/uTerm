fn main() {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../shared/windows/application.manifest");
    println!("cargo:rerun-if-changed={}", manifest.display());
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        println!("cargo:rustc-link-arg-bin=utermd-local=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg-bin=utermd-local=/MANIFESTINPUT:{}",
            manifest.display()
        );
    }
}
