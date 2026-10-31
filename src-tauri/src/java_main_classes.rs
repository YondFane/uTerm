use anyhow::{bail, Context, Result};
use serde::Serialize;
use std::{fs, path::Path};

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct MainClass {
    pub name: String,
    pub spring_boot: bool,
}

// Ignore comments and literals so examples and commented-out code cannot become entry points.
// 忽略注释和字面量，避免示例或已注释的代码被识别为入口。
fn tokens(source: &str) -> Vec<String> {
    let chars: Vec<_> = source.chars().collect();
    let mut result = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '/' && chars.get(i + 1) == Some(&'/') {
            i += 2;
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
        } else if c == '/' && chars.get(i + 1) == Some(&'*') {
            i += 2;
            while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                i += 1;
            }
            i = (i + 2).min(chars.len());
        } else if c == '"' || c == '\'' {
            let block = c == '"' && chars.get(i..i + 3) == Some(&['"', '"', '"']);
            i += if block { 3 } else { 1 };
            while i < chars.len() {
                if chars[i] == '\\' {
                    i = (i + 2).min(chars.len());
                } else if block && chars.get(i..i + 3) == Some(&['"', '"', '"']) {
                    i += 3;
                    break;
                } else if !block && chars[i] == c {
                    i += 1;
                    break;
                } else {
                    i += 1;
                }
            }
        } else if c.is_alphanumeric() || c == '_' || c == '$' {
            let start = i;
            while i < chars.len()
                && (chars[i].is_alphanumeric() || chars[i] == '_' || chars[i] == '$')
            {
                i += 1;
            }
            result.push(chars[start..i].iter().collect());
        } else {
            if !c.is_whitespace() {
                result.push(c.to_string());
            }
            i += 1;
        }
    }
    result
}

fn parse(source: &str) -> Vec<MainClass> {
    let raw = tokens(source);
    let mut words = Vec::new();
    let mut position = 0;
    while position < raw.len() {
        if raw[position] == "@" {
            words.push(raw[position].clone());
            position += 1;
            while position < raw.len()
                && (raw[position] == "."
                    || raw[position]
                        .chars()
                        .all(|c| c.is_alphanumeric() || c == '_' || c == '$'))
            {
                words.push(raw[position].clone());
                position += 1;
                if raw.get(position).is_none_or(|v| v != ".") {
                    break;
                }
                words.push(raw[position].clone());
                position += 1;
            }
            if raw.get(position).is_some_and(|v| v == "(") {
                let mut parentheses = 1;
                position += 1;
                while position < raw.len() && parentheses > 0 {
                    if raw[position] == "(" {
                        parentheses += 1;
                    }
                    if raw[position] == ")" {
                        parentheses -= 1;
                    }
                    position += 1;
                }
            }
        } else {
            words.push(raw[position].clone());
            position += 1;
        }
    }
    let mut package = String::new();
    let mut depth = 0usize;
    let mut declaration = Vec::new();
    let mut class: Option<(String, bool)> = None;
    let mut result = Vec::new();
    for (i, word) in words.iter().enumerate() {
        if depth == 0 {
            declaration.push(word.as_str());
            if word == ";" {
                if declaration.first() == Some(&"package") {
                    package = declaration[1..declaration.len() - 1].concat();
                }
                declaration.clear();
            }
            if word == "{" {
                if let Some(position) = declaration.iter().position(|v| *v == "class") {
                    if let Some(name) = declaration.get(position + 1) {
                        let boot = declaration
                            .windows(2)
                            .any(|pair| pair == ["@", "SpringBootApplication"])
                            || declaration.iter().any(|v| *v == "SpringBootApplication")
                                && declaration.contains(&"@");
                        class = Some((
                            if package.is_empty() {
                                name.to_string()
                            } else {
                                format!("{package}.{name}")
                            },
                            boot,
                        ));
                    }
                }
                declaration.clear();
            }
        }
        if depth == 1 && word == "main" && words.get(i + 1).is_some_and(|v| v == "(") {
            let start = words[..i]
                .iter()
                .rposition(|v| ["{", "}", ";"].contains(&v.as_str()))
                .map_or(0, |v| v + 1);
            let modifiers = &words[start..i];
            let end = words[i + 2..]
                .iter()
                .position(|v| v == ")")
                .map(|v| v + i + 2);
            if let (Some((name, boot)), Some(end)) = (&class, end) {
                let parameters: Vec<_> = words[i + 2..end]
                    .iter()
                    .filter(|v| v.as_str() != "final")
                    .map(String::as_str)
                    .collect();
                let parameters = parameters
                    .strip_prefix(&["java", ".", "lang", "."])
                    .unwrap_or(&parameters);
                let string_array = matches!(
                    parameters,
                    ["String", "[", "]", _]
                        | ["String", _, "[", "]"]
                        | ["String", ".", ".", ".", _]
                );
                if modifiers.iter().any(|v| v == "public")
                    && modifiers.iter().any(|v| v == "static")
                    && words.get(i.wrapping_sub(1)).is_some_and(|v| v == "void")
                    && string_array
                {
                    result.push(MainClass {
                        name: name.clone(),
                        spring_boot: *boot,
                    });
                }
            }
        }
        if word == "{" {
            depth += 1;
        }
        if word == "}" {
            depth = depth.saturating_sub(1);
            if depth == 0 {
                class = None;
                declaration.clear();
            }
        }
    }
    result
}

pub fn discover(root: &Path, module: &Path) -> Result<Vec<MainClass>> {
    let source = module.join("src/main/java");
    if !source.exists() {
        return Ok(Vec::new());
    }
    let mut queue = vec![(source, 0)];
    let mut count = 0;
    let mut bytes = 0;
    let mut classes = Vec::new();
    while let Some((directory, depth)) = queue.pop() {
        if depth > 64 || !directory.canonicalize()?.starts_with(root) {
            bail!("JAVA_MAIN_SCAN_LIMIT");
        }
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            count += 1;
            if count > 5000 {
                bail!("JAVA_MAIN_SCAN_LIMIT");
            }
            let kind = entry.file_type()?;
            // Do not follow links, including source roots that escape through linked parents.
            // 不跟随链接，并检查源码目录的父级链接是否越过项目根目录。
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                queue.push((entry.path(), depth + 1));
            } else if kind.is_file() && entry.path().extension().is_some_and(|v| v == "java") {
                let size = entry.metadata()?.len();
                bytes += size;
                if size > 1024 * 1024 || bytes > 32 * 1024 * 1024 {
                    bail!("JAVA_MAIN_SCAN_LIMIT");
                }
                let text = fs::read_to_string(entry.path()).context("JAVA_MAIN_SCAN_FAILED")?;
                classes.extend(parse(&text));
            }
        }
    }
    classes.sort_by(|a, b| b.spring_boot.cmp(&a.spring_boot).then(a.name.cmp(&b.name)));
    classes.dedup_by(|a, b| a.name == b.name);
    Ok(classes)
}

pub fn automatic(classes: &[MainClass]) -> Result<Option<&str>> {
    let boot: Vec<_> = classes.iter().filter(|v| v.spring_boot).collect();
    let preferred: Vec<_> = if boot.is_empty() {
        classes.iter().collect()
    } else {
        boot
    };
    match preferred.as_slice() {
        [] => Ok(None),
        [class] => Ok(Some(&class.name)),
        _ => bail!("JAVA_MAIN_CLASS_AMBIGUOUS"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn discovers_boot_and_plain_main_without_comments_literals_or_nested_classes() {
        let classes = parse(
            r#"package com.example;
          // @SpringBootApplication class Fake { public static void main(String[] a) {} }
          @org.springframework.boot.autoconfigure.SpringBootApplication(exclude={Object.class}) public class App {
            String text = "public static void main(String[] args) {}";
            public static void main(final String[] args) {}
            class Nested { public static void main(String[] args) {} }
          }
          class Helper { public static void main(String... args) {} }
          class Wrong { public void main(String[] args) {} }
        "#,
        );
        assert_eq!(
            classes,
            vec![
                MainClass {
                    name: "com.example.App".into(),
                    spring_boot: true
                },
                MainClass {
                    name: "com.example.Helper".into(),
                    spring_boot: false
                }
            ]
        );
        assert_eq!(automatic(&classes).unwrap(), Some("com.example.App"));
        assert!(automatic(&[classes[0].clone(), classes[0].clone()]).is_err());
    }
    #[test]
    fn scans_only_main_java_and_bounds_source_files() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let source = root.join("src/main/java");
        fs::create_dir_all(&source).unwrap();
        fs::write(
            source.join("App.java"),
            "@SpringBootApplication class App { public static void main(String[] a) {} }",
        )
        .unwrap();
        assert_eq!(discover(&root, &root).unwrap().len(), 1);
        fs::write(source.join("Huge.java"), vec![b' '; 1024 * 1024 + 1]).unwrap();
        assert!(discover(&root, &root)
            .unwrap_err()
            .to_string()
            .contains("JAVA_MAIN_SCAN_LIMIT"));
    }
}
