//! SFTP server paths; callers still resolve server symlinks and validate roots before containment.
//! SFTP 服务端路径；调用方仍须解析服务端符号链接，并在包含检查前校验根目录。
use anyhow::{bail, Result};

pub fn canonical(path: &str, windows: bool) -> Result<String> {
    if path.is_empty() || path.contains(['\0', '\r', '\n']) {
        bail!("SSH_INVALID_ROOT");
    }
    let mut value = if windows {
        path.replace('\\', "/")
    } else {
        path.to_owned()
    };
    if windows {
        if value.starts_with('/') && value.as_bytes().get(2) == Some(&b':') {
            value.remove(0);
        }
        if value.starts_with("//")
            || !value
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphabetic)
            || value.as_bytes().get(1) != Some(&b':')
            || value.as_bytes().get(2) != Some(&b'/')
        {
            bail!("SSH_INVALID_ROOT");
        }
        value.replace_range(..1, &value[..1].to_ascii_uppercase());
    } else if !value.starts_with('/') {
        bail!("SSH_INVALID_ROOT");
    }
    if value.split('/').any(|part| part == ".." || part == ".") {
        bail!("SSH_INVALID_ROOT");
    }
    while value.ends_with('/') && value.len() > if windows { 3 } else { 1 } {
        value.pop();
    }
    Ok(value)
}
pub fn relative(path: &str) -> Result<()> {
    if path.len() > 4096
        || (!path.is_empty()
            && path
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == ".."))
        || path.contains(['\\', ':', '\0', '\r', '\n'])
    {
        bail!("SSH_PATH_OUTSIDE_ROOT");
    }
    Ok(())
}
pub fn within(root: &str, path: &str) -> bool {
    path == root
        || path
            .strip_prefix(root)
            .is_some_and(|tail| root.ends_with('/') || tail.starts_with('/'))
}
pub fn join(root: &str, path: &str) -> String {
    if path.is_empty() {
        root.to_owned()
    } else {
        format!("{}/{path}", root.trim_end_matches('/'))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn remote_path_validation_retains_literal_names_error_codes_and_utf8_byte_bounds() {
        assert_eq!(canonical("/srv/项目 & %/", false).unwrap(), "/srv/项目 & %");
        assert_eq!(
            canonical("/srv/back\\slash", false).unwrap(),
            "/srv/back\\slash"
        );
        assert_eq!(join("/", "文件.txt"), "/文件.txt");
        assert_eq!(join("C:/", "文件.txt"), "C:/文件.txt");
        assert_eq!(join("/srv/project/", ""), "/srv/project/");
        assert!(within("/", "/other"));
        assert!(within("C:/", "C:/data"));
        assert!(!within("C:/data", "c:/data/file"));
        assert!(relative("").is_ok());
        assert!(relative(&"文".repeat(1365)).is_ok());
        assert_eq!(
            relative(&"文".repeat(1366)).unwrap_err().to_string(),
            "SSH_PATH_OUTSIDE_ROOT"
        );
        for path in [
            "relative",
            "/srv/../private",
            "/srv/./file",
            "/srv/\nfile",
            "/srv/\rfile",
            "/srv/\0file",
        ] {
            assert_eq!(
                canonical(path, false).unwrap_err().to_string(),
                "SSH_INVALID_ROOT"
            );
        }
        for path in ["a/./b", "a\rfile", "a\nfile", "\\file", "file:name"] {
            assert_eq!(
                relative(path).unwrap_err().to_string(),
                "SSH_PATH_OUTSIDE_ROOT"
            );
        }
    }
    #[test]
    fn remote_paths_use_server_rules_and_component_boundaries() {
        assert_eq!(canonical("/srv/app/", false).unwrap(), "/srv/app");
        assert_eq!(canonical("c:\\Users\\测试", true).unwrap(), "C:/Users/测试");
        assert_eq!(canonical("/c:/data/", true).unwrap(), "C:/data");
        for path in ["\\\\server\\share", "C:relative", "/", "C:/a/../b"] {
            assert!(canonical(path, true).is_err());
        }
        for path in [
            "../escape",
            "/etc/passwd",
            "x/../y",
            "C:/x",
            "x\\y",
            "x\0",
            "x//y",
        ] {
            assert!(relative(path).is_err());
        }
        assert!(within("C:/data", "C:/data/file"));
        assert!(!within("C:/data", "C:/database/file"));
        assert!(!within("/data", "/data-other"));
    }
}
