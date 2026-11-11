use tauri::Emitter;
use tauri_plugin_dialog::DialogExt;
use uterm_core::java_components::Status;

#[tauri::command]
pub async fn java_components(
    app: tauri::AppHandle,
    action: String,
    id: Option<String>,
) -> Result<Status, String> {
    let service = crate::shared_core::core(&app)?
        .java_components()
        .map_err(|error| error.to_string())?;
    if action == "status" {
        return tauri::async_runtime::spawn_blocking(move || service.status())
            .await
            .map_err(|_| "JAVA_OPERATION_FAILED")?
            .map_err(|error| error.to_string());
    }
    if action == "cancel" {
        if let Some(operation) = service.active().map_err(|error| error.to_string())? {
            service
                .cancel(&operation.id, &operation.generation)
                .map_err(|error| error.to_string())?;
        }
        return service.status().map_err(|error| error.to_string());
    }
    if !["install", "import"].contains(&action.as_str()) {
        return Err("JAVA_TASK_INVALID".into());
    }
    let _pending = crate::content_operations::begin(&app)?;
    let source = if action == "import" {
        let picker = app.clone();
        let selected = tauri::async_runtime::spawn_blocking(move || {
            picker.dialog().file().blocking_pick_file()
        })
        .await
        .map_err(|_| "JAVA_OPERATION_FAILED")?;
        let Some(selected) = selected else {
            return service.status().map_err(|error| error.to_string());
        };
        Some(selected.into_path().map_err(|_| "JAVA_PROJECT_INVALID")?)
    } else {
        None
    };
    let operation = service
        .start(action, id.ok_or("JAVA_COMPONENT_MISSING")?, source)
        .map_err(|error| error.to_string())?;
    let mut last_progress = None;
    let mut event_error = false;
    loop {
        let value = service
            .read(&operation.id, &operation.generation, false)
            .map_err(|error| error.to_string())?;
        if let Some(progress) = service.progress().map_err(|error| error.to_string())? {
            let signature = (progress.id.clone(), progress.received, progress.total);
            if last_progress.as_ref() != Some(&signature) {
                event_error |= app.emit("java-component-progress", progress).is_err();
                last_progress = Some(signature);
            }
        }
        if value.state != "running" {
            service
                .read(&operation.id, &operation.generation, true)
                .map_err(|error| error.to_string())?;
            event_error |= app.emit("java-components-changed", ()).is_err();
            if let Some(error) = value.error {
                return Err(error);
            }
            if event_error {
                return Err("JAVA_COMPONENT_EVENTS_FAILED".into());
            }
            return value.result.ok_or_else(|| "JAVA_OPERATION_FAILED".into());
        }
        // Retain the pending-write guard until the real result, including after a cancel request.
        // 即使已请求取消，也保留写入保护直到实际结果返回。
        tokio::time::sleep(std::time::Duration::from_millis(40)).await;
    }
}
