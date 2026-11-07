use super::*;

#[test]
#[ignore = "Collect selected-JDK diagnostics explicitly; this does not replace the strict Unicode task test"]
fn selected_jvm_reports_encoding_for_ascii_and_unicode_jar_paths() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().canonicalize().unwrap();
    let host_root = root.join("local-daemon-v1");
    let _cleanup = HostCleanup(host_root.clone());
    let home = PathBuf::from(std::env::var_os("JAVA_HOME").unwrap());
    let tool = |name: &str| {
        home.join("bin").join(if cfg!(windows) {
            format!("{name}.exe")
        } else {
            name.into()
        })
    };
    std::fs::write(root.join("LauncherProbe.java"), r#"
public class LauncherProbe {
    public static void main(String[] args) {
        for (String name : new String[]{"sun.jnu.encoding", "file.encoding", "java.class.path", "java.home", "qa.value"})
            System.out.println("PROPERTY:" + name + "=" + System.getProperty(name));
        for (int i = 0; i < args.length; i++) System.out.println("ARG:" + i + "=" + args[i]);
        System.exit(7);
    }
}
"#).unwrap();
    for (name, arguments) in [
        ("javac", vec!["-encoding", "UTF-8", "LauncherProbe.java"]),
        (
            "jar",
            vec!["cfe", "probe.jar", "LauncherProbe", "LauncherProbe.class"],
        ),
    ] {
        let output = std::process::Command::new(tool(name))
            .args(arguments)
            .current_dir(uterm_core::java::path_text(&root))
            .output()
            .unwrap();
        assert!(output.status.success(), "{:?}", output);
    }
    std::fs::copy(root.join("probe.jar"), root.join("探针 中文.jar")).unwrap();
    std::fs::write(root.join("pom.xml"), "<project><modelVersion>4.0.0</modelVersion><groupId>qa</groupId><artifactId>encoding</artifactId><version>1</version></project>").unwrap();
    let core = Core::open(root.join("shared-state-v1")).unwrap();
    call(&core, "host.configure", json!({"helper":helper()}));
    let mut config =
        call(&core, "java.configuration", json!({"directory":root}))["project"].clone();
    config["java_home"] = json!(home);
    config["java_version"] = json!(uterm_core::java::probe(&home).unwrap().version);
    config["mode"] = json!("jar");
    config["offline"] = json!(true);
    config["arguments"] = json!(["文字 😀 & %PATH%", ""]);
    config["vm_arguments"] = json!(["-Dqa.value=属性 中文", "-XshowSettings:properties"]);
    let mut variants = Vec::new();
    for jar in ["probe.jar", "探针 中文.jar"] {
        config["jar"] = json!(jar);
        let task = call(
            &core,
            "java.start",
            json!({"directory":root,"action":"run","config":config,"environment":{"_JAVA_LAUNCHER_DEBUG":"1"}}),
        );
        let client = Client::connect(&host_root).unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        let mut after = None;
        let mut bytes = Vec::new();
        let code = loop {
            let Reply::Frame(frame) = client
                .request(Operation::Read {
                    id: task["spec"]["id"].as_str().unwrap().into(),
                    generation: task["generation"].as_str().unwrap().into(),
                    after,
                })
                .unwrap()
            else {
                panic!("Expected a diagnostic task frame")
            };
            assert!(frame.error.is_none(), "{:?}", frame.error);
            after = Some(frame.sequence);
            bytes.extend(frame.data);
            assert!(
                bytes.len() <= 256 * 1024,
                "Diagnostic output exceeded its bound"
            );
            if frame.exited {
                break frame.code;
            }
            assert!(Instant::now() < deadline, "Diagnostic task did not exit");
            std::thread::sleep(Duration::from_millis(25));
        };
        let output = String::from_utf8_lossy(&bytes).into_owned();
        variants.push(json!({"jar":jar,"exitCode":code,"output":output,
            "literalArgumentPreserved":output.contains("ARG:0=文字 😀 & %PATH%"),
            "vmPropertyPreserved":output.contains("PROPERTY:qa.value=属性 中文")}));
        call(
            &core,
            "host.close",
            json!({"id":task["spec"]["id"],"generation":task["generation"]}),
        );
    }
    core.close();
    let mut stock_paths = Vec::new();
    for name in ["stock 目录", "stock 目录 😀"] {
        let directory = root.join(name);
        std::fs::create_dir(&directory).unwrap();
        let jar = directory.join("probe.jar");
        std::fs::copy(root.join("probe.jar"), &jar).unwrap();
        let output = std::process::Command::new(tool("java"))
            .args([
                "-Dsun.stdout.encoding=UTF-8",
                "-jar",
                &uterm_core::java::path_text(&jar),
                "literal",
                "",
            ])
            .current_dir(uterm_core::java::path_text(&directory))
            .output()
            .unwrap();
        stock_paths.push(json!({"directory":name,"viaUTermHost":false,"exitCode":output.status.code(),
            "stdout":String::from_utf8_lossy(&output.stdout).chars().take(16384).collect::<String>(),
            "stderr":String::from_utf8_lossy(&output.stderr).chars().take(16384).collect::<String>()}));
    }
    let git = |arguments: &[&str]| {
        let output = std::process::Command::new("git")
            .args(arguments)
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .output()
            .unwrap();
        assert!(output.status.success());
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    };
    let tested = git(&["rev-parse", "HEAD"]);
    let report = json!({
        "kind":"Selected-JDK encoding diagnostics, not task acceptance",
        "sourceHeadSHA":std::env::var("PR_HEAD_SHA").unwrap_or_else(|_|tested.clone()),
        "testedMergeSHA":tested,"sourceTreeDirty":!git(&["status","--porcelain","--untracked-files=no"]).is_empty(),
        "platform":std::env::consts::OS,"architecture":std::env::consts::ARCH,
        "java":uterm_core::java::probe(&home).unwrap().version,"variants":variants,"stockJVMPathDiagnostics":stock_paths
    });
    if let Some(path) = std::env::var_os("UTERM_JAVA_ENCODING_REPORT") {
        std::fs::write(path, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    }
    println!("{}", serde_json::to_string_pretty(&report).unwrap());
}
