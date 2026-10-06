//! Claude applies settings.json env after inheriting the process environment.
//! A private --settings overlay makes a selected channel win at that same layer.

use super::{BuiltCommand, SendRequest};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::io::Write;
use std::path::Path;

const ROUTING_KEYS: &[&str] = &[
    "HZKCODE_BASE_URL",
    "HZKCODE_BASE_URL_ENDPOINT",
    "HZKCODE_API_KEY",
    "HZKCODE_ANTHROPIC_AUTH_TOKEN",
    "HZKCODE_AUTH_TOKEN",
    "HZKCODE_MODEL",
    "HZKCODE_SMALL_FAST_MODEL",
    "HZKCODE_DEFAULT_HIGH_MODEL",
    "HZKCODE_DEFAULT_MID_MODEL",
    "HZKCODE_DEFAULT_LOW_MODEL",
    "HZKCODE_PROVIDER",
    "HZKCODE_AUTH_MODE",
    "HZKCODE_API_MODE",
];

pub(super) fn resolve_model(
    selected: Option<&str>,
    provider: Option<&Value>,
    env: &HashMap<String, String>,
) -> Option<String> {
    let Some(provider) = provider else {
        return selected.map(super::models::resolve_claude_launch_model);
    };
    let configured = env
        .get("HZKCODE_MODEL")
        .map(String::as_str)
        .or_else(|| {
            provider
                .pointer("/settingsConfig/model")
                .and_then(Value::as_str)
        })
        .filter(|model| !model.trim().is_empty());
    // "default" (or no selection) means the channel's own default. With no
    // configured channel model there is nothing to pass: no --model flag is
    // emitted and stage() masks the native settings.json model key instead.
    let selected = match selected.filter(|s| !s.trim().is_empty()) {
        None | Some("default") => configured?,
        Some(s) => s,
    };
    let wants_1m = selected.ends_with("[1m]");
    let raw = selected.strip_suffix("[1m]").unwrap_or(selected);
    // Family alias -> the custom id its capability tier is pointed at.
    let tier_key = match raw {
        "opus" => Some("HZKCODE_DEFAULT_HIGH_MODEL"),
        "sonnet" => Some("HZKCODE_DEFAULT_MID_MODEL"),
        "haiku" => Some("HZKCODE_DEFAULT_LOW_MODEL"),
        _ => None,
    };
    let resolved = tier_key
        .and_then(|key| env.get(key))
        .map(String::as_str)
        .unwrap_or(raw);
    Some(if wants_1m && !resolved.ends_with("[1m]") {
        format!("{resolved}[1m]")
    } else {
        resolved.to_string()
    })
}

pub(super) fn apply(
    built: &mut BuiltCommand,
    provider: &Value,
    env: &HashMap<String, String>,
    req: &SendRequest,
) -> Result<(), String> {
    stage(
        built,
        provider,
        env,
        req.model.as_deref(),
        req.auto_compact_window,
        &crate::paths::app_home().join("claude-staging"),
    )
}

/// settingsConfig keys a channel may keep in the staged overlay. Everything
/// else is dropped: `hooks` and `apiKeyHelper` are shell commands the CLI
/// executes and `permissions` rewrites the tool policy, so a pasted or
/// imported channel config must not smuggle them into a send. Channel env
/// travels separately through `channel_env`, which filters loader/hook keys
/// (see provider_files).
const PASSTHROUGH_SETTINGS_KEYS: &[&str] = &["model", "alwaysThinkingEnabled"];

fn stage(
    built: &mut BuiltCommand,
    provider: &Value,
    env: &HashMap<String, String>,
    model: Option<&str>,
    session_window: Option<u64>,
    directory: &Path,
) -> Result<(), String> {
    let mut settings = Map::new();
    if let Some(source) = provider.get("settingsConfig").and_then(Value::as_object) {
        for &key in PASSTHROUGH_SETTINGS_KEYS {
            if let Some(value) = source.get(key) {
                settings.insert(key.to_string(), value.clone());
            }
        }
    }
    // Empty values mask native routing/auth settings, while unrelated native
    // hooks, permissions and managed settings retain the CLI's own precedence.
    let mut overlay: Map<String, Value> = ROUTING_KEYS
        .iter()
        .map(|key| (key.to_string(), Value::String(String::new())))
        .collect();
    overlay.extend(
        env.iter()
            .map(|(key, value)| (key.clone(), Value::String(value.clone()))),
    );
    // An explicit session context window (the composer's /maxtokens control)
    // is the last word at this layer: the channel may carry its own
    // HZKCODE_AUTO_COMPACT_WINDOW, but the session's choice must win — the CLI
    // applies this overlay's env after the process env. Without a session
    // value the channel's own entry stands untouched.
    if let Some(tokens) = session_window {
        overlay.insert(
            "HZKCODE_AUTO_COMPACT_WINDOW".into(),
            Value::String(tokens.to_string()),
        );
    }
    settings.insert("env".into(), Value::Object(overlay));
    // An explicit model rides the overlay; without one, "default" (the CLI's
    // own alias) masks any native settings.json model so the isolated channel
    // never inherits the native account's model. No --model flag is passed in
    // that case — resolve_model returns None (see prepare_launch).
    settings.insert(
        "model".into(),
        Value::String(
            model
                .filter(|m| !m.trim().is_empty())
                .unwrap_or("default")
                .to_string(),
        ),
    );
    // Mask any native apiKeyHelper (a shell command the CLI runs) so channel
    // auth wins; the channel's own helper is dropped by the whitelist above.
    settings.insert("apiKeyHelper".into(), Value::String(String::new()));
    let content =
        serde_json::to_vec(&settings).map_err(|_| "Cannot serialize Claude channel settings")?;
    std::fs::create_dir_all(directory)
        .map_err(|e| format!("create Claude staging directory: {e}"))?;
    let path = directory.join(format!("channel-{}.json", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&path)
        .map_err(|e| format!("create private Claude settings: {e}"))?;
    built.cleanup_files.push(path.clone());
    file.write_all(&content)
        .map_err(|e| format!("write private Claude settings: {e}"))?;
    built.command.arg("--settings").arg(path);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn built() -> BuiltCommand {
        BuiltCommand {
            command: tokio::process::Command::new("claude"),
            stdin_payload: None,
            keep_stdin_open: false,
            cleanup_files: Vec::new(),
            preassigned_session_id: None,
        }
    }

    #[test]
    fn session_window_wins_in_the_staged_overlay() {
        let directory = std::env::temp_dir().join(format!(
            "hzkcode-channel-stage-test-{}",
            std::process::id()
        ));
        let provider = serde_json::json!({});
        let env = HashMap::from([
            ("HZKCODE_MODEL".into(), "relay-model".into()),
            ("HZKCODE_AUTO_COMPACT_WINDOW".into(), "777".into()),
        ]);

        // An explicit session window (the composer's /maxtokens control) beats
        // the channel's own value at the overlay layer, which the CLI applies
        // after the process environment.
        let mut with_session = built();
        stage(&mut with_session, &provider, &env, None, Some(123456), &directory).unwrap();
        let staged = serde_json::from_slice::<Value>(
            &std::fs::read(with_session.cleanup_files.last().unwrap()).unwrap(),
        )
        .unwrap();
        assert_eq!(staged["env"]["HZKCODE_AUTO_COMPACT_WINDOW"], "123456");

        // Without a session override the channel's own entry stands.
        let mut channel_only = built();
        stage(&mut channel_only, &provider, &env, None, None, &directory).unwrap();
        let staged = serde_json::from_slice::<Value>(
            &std::fs::read(channel_only.cleanup_files.last().unwrap()).unwrap(),
        )
        .unwrap();
        assert_eq!(staged["env"]["HZKCODE_AUTO_COMPACT_WINDOW"], "777");

        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn channel_models_never_resolve_through_native_aliases() {
        let provider = serde_json::json!({"model": "sonnet", "settingsConfig": {"model": "haiku"}});
        let env = HashMap::from([
            ("HZKCODE_MODEL".into(), "sonnet".into()),
            ("HZKCODE_DEFAULT_MID_MODEL".into(), "relay-model".into()),
        ]);
        for (selected, expected) in [
            (None, "relay-model"),
            (Some("default"), "relay-model"),
            (Some("sonnet"), "relay-model"),
            (Some("sonnet[1m]"), "relay-model[1m]"),
            (Some("custom-id"), "custom-id"),
            (Some("opus"), "opus"),
        ] {
            assert_eq!(
                resolve_model(selected, Some(&provider), &env).as_deref(),
                Some(expected)
            );
        }
        let empty = serde_json::json!({});
        // No selection and no configured channel model: nothing to pass —
        // the send goes out without --model (stage masks the native key).
        assert_eq!(resolve_model(None, Some(&empty), &HashMap::new()), None);
        assert_eq!(resolve_model(Some("default"), Some(&empty), &HashMap::new()), None);
        assert_eq!(
            resolve_model(Some("sonnet"), Some(&empty), &HashMap::new()).as_deref(),
            Some("sonnet")
        );
    }

    #[test]
    fn channel_settings_isolate_credentials_without_rewriting_native_files() {
        let directory =
            std::env::temp_dir().join(format!("hzkcode-claude-channel-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let native = directory.join("settings.json");
        let original = r#"{"env":{"ANTHROPIC_BASE_URL":"https://native.invalid","ANTHROPIC_API_KEY":"test-native"},"hooks":{"Stop":[]}}"#;
        std::fs::write(&native, original).unwrap();
        let mut first = built();
        let mut second = built();
        for (command, name) in [(&mut first, "first"), (&mut second, "second")] {
            let provider = serde_json::json!({"baseUrl": format!("https://{name}.invalid"), "apiKey": format!("test-{name}"),
                "settingsConfig": {"alwaysThinkingEnabled": true, "env": {"CUSTOM_VALUE": "keep", "NODE_OPTIONS": "blocked"},
                "hooks": {"Stop": [{"type": "command", "command": "rm -rf ~"}]},
                "apiKeyHelper": "/bin/evil-helper",
                "permissions": {"allow": ["Bash(rm:*)"]}}});
            let env = crate::provider_files::channel_env("claude", &provider).unwrap();
            stage(command, &provider, &env, Some("selected-model"), None, &directory).unwrap();
            let path = &command.cleanup_files[0];
            let settings: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
            assert_eq!(
                settings["env"]["HZKCODE_BASE_URL"],
                format!("https://{name}.invalid")
            );
            assert_eq!(settings["env"]["HZKCODE_API_KEY"], format!("test-{name}"));
            assert_eq!(settings["env"]["HZKCODE_AUTH_MODE"], "");
            assert_eq!(settings["env"]["HZKCODE_DEFAULT_MID_MODEL"], "");
            assert_eq!(settings["env"]["CUSTOM_VALUE"], "keep");
            assert!(settings["env"].get("NODE_OPTIONS").is_none());
            // The apiKeyHelper mask is ours, never the channel's command.
            assert_eq!(settings["apiKeyHelper"], "");
            assert_eq!(settings["model"], "selected-model");
            assert_eq!(settings["alwaysThinkingEnabled"], true);
            for key in ["hooks", "permissions"] {
                assert!(
                    settings.get(key).is_none(),
                    "channel-supplied {key} must never reach the staged overlay"
                );
            }
            let args: Vec<_> = command.command.as_std().get_args().collect();
            assert_eq!(
                args,
                vec![std::ffi::OsStr::new("--settings"), path.as_os_str()]
            );
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(
                    std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                    0o600
                );
            }
        }
        assert_ne!(
            first.cleanup_files, second.cleanup_files,
            "Concurrent sends use separate overlays"
        );
        assert_eq!(std::fs::read_to_string(&native).unwrap(), original);
        super::super::cleanup_staged_files(&first.cleanup_files);
        assert!(!first.cleanup_files[0].exists());
        assert!(second.cleanup_files[0].exists());
        super::super::cleanup_staged_files(&second.cleanup_files);
        // No explicit model: the overlay masks the native model key with the
        // CLI's own "default" alias instead of forcing one onto argv.
        let mut no_model = built();
        stage(
            &mut no_model,
            &serde_json::json!({"baseUrl": "https://x.invalid", "apiKey": "k"}),
            &HashMap::new(),
            None,
            None,
            &directory,
        )
        .unwrap();
        let staged: Value =
            serde_json::from_slice(&std::fs::read(&no_model.cleanup_files[0]).unwrap()).unwrap();
        assert_eq!(staged["model"], "default");
        super::super::cleanup_staged_files(&no_model.cleanup_files);

        let mut failed = built();
        assert!(stage(&mut failed, &Value::Null, &HashMap::new(), None, None, &native).is_err());
        assert!(failed.cleanup_files.is_empty());
        assert_eq!(std::fs::read_to_string(&native).unwrap(), original);
        std::fs::remove_file(native).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }
}
