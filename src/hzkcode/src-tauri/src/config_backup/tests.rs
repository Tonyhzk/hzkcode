use super::*;
use std::fs;
use std::path::PathBuf;

struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("config-backup-{}", uuid::Uuid::new_v4()));
        crate::test_support::guard_test_write(&root).unwrap();
        fs::create_dir_all(&root).unwrap();
        Self(root)
    }
    fn write(&self, name: &str, value: &[u8]) {
        let path = self.0.join(name);
        crate::test_support::guard_test_write(&path).unwrap();
        if let Some(parent) = path.parent() { fs::create_dir_all(parent).unwrap(); }
        fs::write(path, value).unwrap();
    }
}

const PASSWORD: &str = "fixture-pass-测试";
fn archive(root: &Path) -> Vec<u8> {
    let preferences = [("hzkcode.zoom:v1".into(), "120".into())].into_iter().collect();
    let snapshot = collect(root, preferences).unwrap();
    crypto::BackupKey::new(PASSWORD).unwrap().seal(&serde_json::to_vec(&snapshot).unwrap()).unwrap()
}

#[test]
fn two_computers_restore_settings_credentials_agents_prompts_and_backup_originals() {
    let source = Scratch::new();
    let target = Scratch::new();
    source.write("settings.json", br#"{"theme":"dark","cliEnv":{"HZKCODE_OSS_ACCESS_KEY_SECRET":"fixture-oss"},"customFutureField":{"enabled":true},"workspaceAliases":{"old":"source"},"webRelayOn":true}"#);
    source.write("config.json", br#"{"claude":{"current":"channel","providers":{"channel":{"apiKey":"fixture-provider","settingsConfig":{"env":{"HZKCODE_MODEL":"mid","HZKCODE_DEFAULT_MID_MODEL":"fixture-model"}}}},"future":42},"futureRoot":true}"#);
    source.write("agents.json", br#"{"agents":[{"id":"agent","name":"role","prompt":"keep spaces  ","tools":["Read"],"future":42}],"futureRoot":true}"#);
    source.write("prompts/计划.md", "---\ndescription: 中文\n---\n  正文🧪\n".as_bytes());
    target.write("settings.json", br#"{"theme":"light","workspaceAliases":{"local":"mine"}}"#);
    target.write("prompts/local.md", b"local-only");
    let encrypted = archive(&source.0);
    let original_digest = digest(&collect(&target.0, Preferences::new()).unwrap());
    let (pending, preview) = prepare(&target.0, &encrypted, PASSWORD).unwrap();
    assert_eq!((preview.provider_count, preview.agent_count, preview.prompt_count, preview.preference_count), (1, 1, 1, 1));
    assert_eq!(original_digest, digest(&collect(&target.0, Preferences::new()).unwrap()));
    let result = import_prepared(&target.0, &pending, [("hzkcode.zoom:v1".into(), "90".into())].into_iter().collect()).unwrap();
    let restored = collect(&target.0, result.preferences).unwrap();
    assert_eq!(restored.settings["theme"], "dark");
    assert_eq!(restored.settings["cliEnv"]["HZKCODE_OSS_ACCESS_KEY_SECRET"], "fixture-oss");
    assert_eq!(restored.settings["customFutureField"]["enabled"], true);
    assert_eq!(restored.settings["workspaceAliases"], json!({"local":"mine"}));
    assert_eq!(restored.settings["webRelayOn"], false);
    assert_eq!(restored.config["claude"]["providers"]["channel"]["apiKey"], "fixture-provider");
    assert_eq!(restored.config["claude"]["future"], 42);
    assert_eq!(restored.agents["agents"][0]["future"], 42);
    assert_eq!(restored.prompts["计划.md"], "---\ndescription: 中文\n---\n  正文🧪\n");
    assert_eq!(restored.prompts["local.md"], "local-only");
    assert_eq!(restored.preferences["hzkcode.zoom:v1"], "120");
    let (before, _) = crypto::open(&fs::read(result.backup_path).unwrap(), PASSWORD).unwrap();
    let before: Snapshot = serde_json::from_slice(&before).unwrap();
    assert_eq!(before.settings["theme"], "light");
    assert_eq!(before.preferences["hzkcode.zoom:v1"], "90");
}

#[test]
fn encryption_is_randomized_and_authenticated() {
    let payload = br#"{"apiKey":"fixture-secret"}"#;
    let key = crypto::BackupKey::new(PASSWORD).unwrap();
    let first = key.seal(payload).unwrap();
    let second = key.seal(payload).unwrap();
    assert_ne!(first, second);
    assert!(!String::from_utf8_lossy(&first).contains("fixture-secret"));
    assert_eq!(crypto::open(&first, PASSWORD).unwrap().0, payload);
    assert!(matches!(crypto::open(&first, "wrong-password"), Err(error) if error == "backup_decrypt_failed"));
    let mut changed: Value = serde_json::from_slice(&first).unwrap();
    let ciphertext = changed["ciphertext"].as_str().unwrap();
    changed["ciphertext"] = json!(format!("{}{}", if ciphertext.starts_with('A') { "B" } else { "A" }, &ciphertext[1..]));
    assert!(matches!(crypto::open(&serde_json::to_vec(&changed).unwrap(), PASSWORD), Err(error) if error == "backup_decrypt_failed"));
    changed["version"] = json!(2);
    assert!(matches!(crypto::open(&serde_json::to_vec(&changed).unwrap(), PASSWORD), Err(error) if error == "backup_version"));
    assert!(crypto::BackupKey::new("short").is_err());
}

#[test]
fn malformed_or_oversized_backup_does_not_modify_target() {
    let target = Scratch::new();
    target.write("settings.json", br#"{"theme":"dark"}"#);
    let before = fs::read(target.0.join("settings.json")).unwrap();
    assert!(prepare(&target.0, b"not-json", PASSWORD).is_err());
    assert!(prepare(&target.0, &vec![0; crypto::MAX_ARCHIVE + 1], PASSWORD).is_err());
    assert_eq!(fs::read(target.0.join("settings.json")).unwrap(), before);
    assert!(!target.0.join("config-backups").exists());
}

#[test]
fn stale_preview_refuses_overwrite_and_expired_preview_refuses_write() {
    let source = Scratch::new();
    let target = Scratch::new();
    let (mut pending, _) = prepare(&target.0, &archive(&source.0), PASSWORD).unwrap();
    target.write("settings.json", br#"{"theme":"dark"}"#);
    assert!(matches!(import_prepared(&target.0, &pending, Preferences::new()), Err(error) if error == "backup_stale"));
    pending.created = Instant::now() - PREVIEW_TTL - Duration::from_secs(1);
    assert!(matches!(import_prepared(&target.0, &pending, Preferences::new()), Err(error) if error == "backup_stale"));
    assert_eq!(read_json(&target.0.join("settings.json"), Value::Null).unwrap()["theme"], "dark");
    assert!(!target.0.join("config-backups").exists());
}

#[test]
fn invalid_prompt_names_and_preference_keys_are_rejected() {
    for name in ["../settings.md", "..\\settings.md", "/tmp/file.md", "nul\0.md", "test.txt", ".md"] {
        assert!(validate_prompt_file(name).is_err(), "{name}");
    }
    for name in ["中文.md", "CON.md", "a:b.md", "a. .md", ".hidden.md", "UPPER.MD"] {
        assert!(validate_prompt_file(name).is_ok(), "{name}");
    }
    assert!(validate_preferences(&[("hzkcode.promptHistory".into(), "secret".into())].into_iter().collect()).is_err());
    assert!(validate_preferences(&[("hzkcode.zoom:v1".into(), "x".repeat(1024 * 1024 + 1))].into_iter().collect()).is_err());
}

#[cfg(unix)]
#[test]
fn existing_prompt_names_can_be_exported_and_restored_on_unix() {
    let source = Scratch::new();
    let target = Scratch::new();
    let names = ["周报:v1.md".to_string(), "CON.md".into(), ".hidden.md".into(),
        "a. .md".into(), "UPPER.MD".into(), format!("{}.md", "x".repeat(129))];
    for name in &names { source.write(&format!("prompts/{name}"), name.as_bytes()); }
    target.write("prompts/local:prompt.md", b"local");
    let (pending, preview) = prepare(&target.0, &archive(&source.0), PASSWORD).unwrap();
    assert_eq!(preview.prompt_count, names.len());
    assert!(!preview.warnings.iter().any(|warning| warning.code == "prompt_skipped"));
    import_prepared(&target.0, &pending, Preferences::new()).unwrap();
    let restored = collect(&target.0, Preferences::new()).unwrap();
    for name in &names { assert_eq!(&restored.prompts[name], name); }
    assert_eq!(restored.prompts["local:prompt.md"], "local");
}

#[test]
fn prompt_filter_uses_target_platform_and_reports_each_skipped_name() {
    let root = Scratch::new();
    let mut current = collect(&root.0, Preferences::new()).unwrap();
    current.prompts.insert("SAFE.md".into(), "existing".into());
    let mut source = current.clone();
    source.prompts = ["CON.md", "周报:v1.md", "Safe.md", "safe.md", ".hidden.md", "normal.md"]
        .into_iter().map(|name| (name.into(), "content".into())).collect();
    for (platform, expected) in [("windows", 2), ("macos", 4), ("linux", 6)] {
        let mut snapshot = source.clone();
        let mut warnings = Vec::new();
        filter_target_prompts(&mut snapshot, &current, platform, &mut warnings);
        assert_eq!(snapshot.prompts.len(), expected, "{platform}");
        assert_eq!(warnings.len(), source.prompts.len() - expected, "{platform}");
        for warning in warnings {
            assert_eq!(warning.code, "prompt_skipped");
            let name = warning.field.unwrap();
            assert!(source.prompts.contains_key(&name));
            assert!(!snapshot.prompts.contains_key(&name));
        }
    }
    let mut duplicates = source.clone();
    let mut warnings = Vec::new();
    current.prompts.clear();
    filter_target_prompts(&mut duplicates, &current, "windows", &mut warnings);
    assert!(duplicates.prompts.contains_key("Safe.md"));
    assert!(!duplicates.prompts.contains_key("safe.md"));
    for name in ["NUL.md", "com1.md", "LPT².md", "con.extra.md", "name?.md", "tab\t.md"] {
        assert!(!prompt_name_supported(name, "windows"), "{name}");
        assert!(prompt_name_supported(name, "linux"), "{name}");
    }
    assert!(prompt_name_supported(&format!("{}.md", "x".repeat(252)), "windows"));
    assert!(!prompt_name_supported(&format!("{}.md", "x".repeat(253)), "windows"));
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[test]
fn case_conflict_is_skipped_in_preview_and_keeps_target_prompt() {
    let source = Scratch::new();
    let target = Scratch::new();
    source.write("prompts/shared.md", b"replacement");
    target.write("prompts/SHARED.md", b"original");
    let (pending, preview) = prepare(&target.0, &archive(&source.0), PASSWORD).unwrap();
    assert_eq!(preview.prompt_count, 0);
    assert!(preview.warnings.iter().any(|warning|
        warning.code == "prompt_skipped" && warning.field.as_deref() == Some("shared.md")));
    import_prepared(&target.0, &pending, Preferences::new()).unwrap();
    assert_eq!(fs::read(target.0.join("prompts/SHARED.md")).unwrap(), b"original");
}

#[test]
fn malformed_existing_files_are_not_exported_as_empty() {
    let source = Scratch::new();
    source.write("agents.json", b"broken");
    assert!(collect(&source.0, Preferences::new()).is_err());
    source.write("agents.json", br#"{"agents":[{"id":"x","name":"test"},{"id":"x","name":"duplicate"}]}"#);
    assert!(collect(&source.0, Preferences::new()).is_err());
}

#[test]
fn invalid_machine_paths_are_skipped_and_source_is_unchanged() {
    let source = Scratch::new();
    source.write("settings.json", br#"{"claudeBin":"/missing/engine","terminalShellPath":"Z:\\missing.exe"}"#);
    let current = collect(&source.0, Preferences::new()).unwrap();
    let (next, warnings) = prepare_import(current.clone(), &current).unwrap();
    assert!(next.settings.get("claudeBin").is_none());
    assert!(next.settings.get("terminalShellPath").is_none());
    assert_eq!(warnings.iter().filter(|w| w.code == "path_skipped").count(), 2);
    assert_eq!(current.settings["claudeBin"], "/missing/engine");
}

#[test]
fn write_failure_rolls_back_all_committed_files_and_keeps_encrypted_recovery() {
    let source = Scratch::new();
    let target = Scratch::new();
    source.write("settings.json", br#"{"theme":"dark"}"#);
    target.write("config.json", br#"{"claude":{"providers":{}}}"#);
    target.write("settings.json", br#"{"theme":"light"}"#);
    let original = digest(&collect(&target.0, Preferences::new()).unwrap());
    let (pending, _) = prepare(&target.0, &archive(&source.0), PASSWORD).unwrap();
    storage::FAIL_AFTER.with(|point| point.set(Some(2)));
    let result = import_prepared(&target.0, &pending, Preferences::new());
    storage::FAIL_AFTER.with(|point| point.set(None));
    assert!(result.is_err());
    assert_eq!(digest(&collect(&target.0, Preferences::new()).unwrap()), original);
    assert!(!target.0.join("agents.json").exists());
    assert_eq!(fs::read_dir(target.0.join("config-backups")).unwrap().count(), 1);
}

#[test]
fn output_never_overwrites_an_existing_file() {
    let target = Scratch::new();
    let path = target.0.join("existing.hzkbackup");
    storage::write_new(&path, b"original").unwrap();
    assert!(storage::write_new(&path, b"replacement").is_err());
    assert_eq!(fs::read(path).unwrap(), b"original");
    assert!(check_archive_path(Path::new("relative.hzkbackup")).is_err());
    assert!(check_archive_path(&target.0.join("settings.json")).is_err());
}

#[cfg(unix)]
#[test]
fn symlinks_are_refused_and_backups_are_private() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let source = Scratch::new();
    let target = Scratch::new();
    let outside = Scratch::new();
    source.write("prompts/ok.md", b"text");
    symlink(outside.0.join("missing.md"), source.0.join("prompts/link.md")).unwrap();
    assert!(collect(&source.0, Preferences::new()).is_err());
    let clean_source = Scratch::new();
    let (pending, _) = prepare(&target.0, &archive(&clean_source.0), PASSWORD).unwrap();
    symlink(&outside.0, target.0.join("config-backups")).unwrap();
    assert!(import_prepared(&target.0, &pending, Preferences::new()).is_err());
    assert!(!target.0.join("settings.json").exists());
    assert_eq!(fs::read_dir(&outside.0).unwrap().count(), 0);
    let private = outside.0.join("private.hzkbackup");
    storage::write_new(&private, b"ciphertext").unwrap();
    assert_eq!(fs::metadata(private).unwrap().permissions().mode() & 0o777, 0o600);
}

