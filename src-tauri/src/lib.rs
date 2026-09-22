pub mod audio;
pub mod characters;
mod credentials;
pub mod domain;
mod jobs;
pub mod providers;
mod samples;
pub mod sound;
mod store;
mod text_provider;
pub mod timing;
pub mod voice_design;
use base64::{engine::general_purpose::STANDARD, Engine};
use domain::*;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicU8, Ordering},
        Arc, Mutex,
    },
};
use store::Store;
use tauri::{Manager, State};

struct AppState {
    store: Mutex<Store>,
    client: reqwest::Client,
    audio_dir: PathBuf,
    preview_lock: tokio::sync::Mutex<()>,
    samples_dir: PathBuf,
    render_lock: Arc<tokio::sync::Mutex<()>>,
    render_signal: AtomicU8,
    cancel_render: tokio::sync::Notify,
    active_render: Mutex<Option<String>>,
    clone_lock: tokio::sync::Mutex<()>,
    cancel_clone: tokio::sync::Notify,
}
impl AppState {
    fn db(&self) -> Result<std::sync::MutexGuard<'_, Store>, String> {
        self.store
            .lock()
            .map_err(|_| "Database lock unavailable".into())
    }
}
#[tauri::command]
fn list_projects(state: State<AppState>) -> Result<Vec<Project>, String> {
    state.db()?.projects()
}
#[tauri::command]
fn save_project(state: State<AppState>, project: Project, reason: String) -> Result<(), String> {
    state.db()?.save(&project, &reason)
}
#[tauri::command]
fn list_revisions(state: State<AppState>, project_id: String) -> Result<Vec<Revision>, String> {
    state.db()?.revisions(&project_id)
}
#[tauri::command]
fn list_takes(state: State<AppState>, project_id: String) -> Result<Vec<Take>, String> {
    state.db()?.takes(&project_id)
}
#[tauri::command]
fn local_voices(state: State<AppState>) -> Result<Vec<Voice>, String> {
    state.db()?.voices()
}
#[tauri::command]
async fn key_status() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        json!({"openai":text_provider::status().map(|s| s["configured"] == true).unwrap_or(false),"elevenlabs":providers::credential("elevenlabs").is_ok()})
    }).await.map_err(|_| "Could not check saved keys".into())
}
#[tauri::command]
fn text_connection() -> Result<Value, String> {
    text_provider::status()
}
#[tauri::command]
fn save_text_connection(config: text_provider::Config, key: String) -> Result<Value, String> {
    text_provider::save(config, key)
}
#[tauri::command]
fn save_key(provider: String, key: String) -> Result<(), String> {
    providers::set_credential(&provider, &key)
}
#[tauri::command]
async fn refresh_voices(state: State<'_, AppState>) -> Result<Vec<Voice>, String> {
    let voices = providers::list_voices(&state.client).await?;
    let db = state.db()?;
    db.replace_voices(&voices)?;
    Ok(voices)
}
#[tauri::command]
async fn create_voice(
    state: State<'_, AppState>,
    name: String,
    description: String,
    paths: Vec<String>,
    consent: bool,
) -> Result<Voice, String> {
    let _guard = state
        .clone_lock
        .try_lock()
        .map_err(|_| "Voice creation is still running")?;
    let previous = state.db()?.get_state("clone-attempt")?;
    if previous["state"] == "unknown" || previous["state"] == "requesting" {
        return Err(
            "Sync your voices and review the previous attempt before creating another voice."
                .into(),
        );
    }
    if !consent {
        return Err("Confirm you have permission to clone this voice".into());
    }
    if name.trim().is_empty() || name.chars().count() > 100 {
        return Err("Voice name must contain 1–100 characters".into());
    }
    if paths.is_empty() {
        return Err("Select between 1 and 10 audio samples".into());
    }
    samples::inspect(paths.clone())?;
    providers::credential("elevenlabs")?;
    let cancellation = state.cancel_clone.notified();
    tokio::pin!(cancellation);
    cancellation.as_mut().enable();
    let mut attempt =
        json!({"state":"requesting", "name":name, "startedAt":chrono::Utc::now().to_rfc3339()});
    state.db()?.set_state("clone-attempt", &attempt)?;
    let result = match futures_util::future::select(
        Box::pin(providers::clone_voice(&state.client, name, description, paths, consent)),
        cancellation,
    ).await {
        futures_util::future::Either::Left((result, _)) => result,
        futures_util::future::Either::Right(_) => Err("Voice creation cancelled locally. Sync voices before retrying; the provider may have created the voice.".into()),
    };
    match result {
        Ok(voice) => {
            state.db()?.put_voice(&voice)?;
            attempt["state"] = json!("complete");
            attempt["voiceId"] = json!(voice.id);
            state.db()?.set_state("clone-attempt", &attempt)?;
            Ok(voice)
        }
        Err(error) => {
            attempt["state"] = json!(if error.contains("HTTP 4") {
                "failed"
            } else {
                "unknown"
            });
            state.db()?.set_state("clone-attempt", &attempt)?;
            Err(error)
        }
    }
}
#[tauri::command]
fn cancel_voice_creation(state: State<AppState>) {
    state.cancel_clone.notify_waiters();
}
#[tauri::command]
fn restore_recording(state: State<AppState>, id: String) -> Result<(), String> {
    samples::restore(&state.samples_dir, &id)
}
#[tauri::command]
async fn sample_quality(path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || samples::quality(&path))
        .await
        .map_err(|_| "Sample analysis failed")?
}
#[tauri::command]
fn list_recordings(state: State<AppState>) -> Result<Vec<samples::Sample>, String> {
    samples::list(&state.samples_dir)
}
#[tauri::command]
fn recording_trash(state: State<AppState>) -> Result<Vec<samples::Sample>, String> {
    let root = state.samples_dir.join("trash");
    if !root.exists() {
        return Ok(vec![]);
    }
    samples::list(&root)
}
#[tauri::command]
fn save_recording(state: State<AppState>, audio: String) -> Result<samples::Sample, String> {
    samples::save(&state.samples_dir, &audio)
}
#[tauri::command]
fn remove_recording(state: State<AppState>, id: String) -> Result<(), String> {
    samples::remove(&state.samples_dir, &id)
}
#[tauri::command]
fn inspect_samples(paths: Vec<String>) -> Result<Vec<samples::Sample>, String> {
    samples::inspect(paths)
}
#[tauri::command]
fn preview_sample(path: String) -> Result<String, String> {
    samples::preview(path)
}
#[tauri::command]
async fn develop_characters(
    state: State<'_, AppState>,
    project: Project,
) -> Result<characters::CharacterPlan, String> {
    characters::develop(&state.client, &project).await
}
#[tauri::command]
async fn generate_script(
    state: State<'_, AppState>,
    project: Project,
) -> Result<Vec<Turn>, String> {
    providers::generate_script(&state.client, &project).await
}
fn validate_voices(state: &AppState, project: &Project) -> Result<(), String> {
    let voices = state.db()?.voices()?;
    for speaker in &project.speakers {
        let voice = voices
            .iter()
            .find(|v| v.id == speaker.voice_id)
            .ok_or_else(|| {
                format!(
                    "Voice unavailable for {}. Sync and choose a voice.",
                    speaker.name
                )
            })?;
        if voice.requires_verification {
            return Err(format!(
                "{} needs voice verification in ElevenLabs",
                speaker.name
            ));
        }
    }
    Ok(())
}
fn launch_render(
    app: tauri::AppHandle,
    state: &AppState,
    take: Take,
    guard: tokio::sync::OwnedMutexGuard<()>,
) -> Result<Take, String> {
    state.render_signal.store(0, Ordering::SeqCst);
    *state
        .active_render
        .lock()
        .map_err(|_| "Render lock unavailable")? = Some(take.id.clone());
    state.db()?.put_take(&take)?;
    let initial = take.clone();
    tauri::async_runtime::spawn(async move {
        let _guard = guard;
        jobs::run(app, take).await;
    });
    Ok(initial)
}
#[tauri::command]
async fn render_audio(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    mut project: Project,
) -> Result<Take, String> {
    let guard = state
        .render_lock
        .clone()
        .try_lock_owned()
        .map_err(|_| "A render is already running")?;
    // Normalize only new takes; resumed legacy takes retain their original requests.
    project.performance.get_or_insert_with(Performance::default);
    validate_voices(&state, &project)?;
    state.db()?.save(&project, "Before render")?;
    launch_render(app, &state, jobs::prepare(project)?, guard)
}
#[tauri::command]
async fn resume_render(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    take_id: String,
    acknowledge_charge: bool,
) -> Result<Take, String> {
    let guard = state
        .render_lock
        .clone()
        .try_lock_owned()
        .map_err(|_| "A render is already running")?;
    let mut take = state.db()?.take(&take_id)?;
    jobs::reconcile(&mut take, &state.audio_dir)?;
    if take.status == "complete" {
        state.db()?.put_take(&take)?;
        return Ok(take);
    }
    if take.plan.iter().any(|j| j.status == "unknown") && !acknowledge_charge {
        return Err("An earlier request may have been billed. Confirm before retrying.".into());
    }
    validate_voices(&state, &take.script)?;
    take.status = "rendering".into();
    take.error = None;
    launch_render(app, &state, take, guard)
}
#[tauri::command]
fn control_render(state: State<AppState>, take_id: String, action: String) -> Result<(), String> {
    if state
        .active_render
        .lock()
        .map_err(|_| "Render lock unavailable")?
        .as_deref()
        != Some(&take_id)
    {
        return Err("This render is no longer active".into());
    }
    match action.as_str() {
        "pause" => state.render_signal.store(1, Ordering::SeqCst),
        "cancel" => {
            state.render_signal.store(2, Ordering::SeqCst);
            state.cancel_render.notify_waiters();
        }
        _ => return Err("Unknown render action".into()),
    }
    Ok(())
}
#[tauri::command]
async fn analyze_reference(path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path=std::path::Path::new(&path);
        let mime=samples::mime(path)?;
        let meta=std::fs::metadata(path).map_err(|_| "Could not read sample file")?;
        if !meta.is_file() || meta.len()>100*1024*1024 { return Err("Reference audio must be under 100 MB and 30 minutes".into()); }
        let bytes=std::fs::read(path).map_err(|_| "Could not read sample file")?;
        let pcm=audio::decode(&bytes,path.extension().and_then(|s|s.to_str()).unwrap_or("wav"))?;
        Ok(json!({"name":path.file_name().unwrap_or_default().to_string_lossy(),
            "src":format!("data:{mime};base64,{}",STANDARD.encode(bytes)),"timing":timing::analyze(&pcm)?}))
    }).await.map_err(|_| "Reference analysis failed")?
}
#[tauri::command]
async fn prepare_take(
    state: State<'_, AppState>,
    take_id: String,
    recording: Option<Recording>,
    pauses: Option<std::collections::HashMap<String, u32>>,
) -> Result<audio::Prepared, String> {
    let _guard = state.preview_lock.lock().await;
    let mut take = state.db()?.take(&take_id)?;
    audio::preview_settings(&mut take, recording, pauses)?;
    let root = state.audio_dir.clone();
    tauri::async_runtime::spawn_blocking(move || audio::prepare_cached(&take, &root))
        .await
        .map_err(|_| "Audio preparation failed")?
}
#[tauri::command]
async fn export_take(
    state: State<'_, AppState>,
    take_id: String,
    recording: Option<Recording>,
    pauses: Option<std::collections::HashMap<String, u32>>,
    path: String,
) -> Result<(), String> {
    let mut take = state.db()?.take(&take_id)?;
    audio::preview_settings(&mut take, recording, pauses)?;
    let root = state.audio_dir.clone();
    tauri::async_runtime::spawn_blocking(move || {
        audio::export(&take, &root, std::path::Path::new(&path))
    })
    .await
    .map_err(|_| "Audio export failed")?
}
#[tauri::command]
fn get_voice_draft(state: State<AppState>) -> Result<Value, String> {
    state.db()?.get_state("voice-draft")
}
#[tauri::command]
fn save_voice_draft(state: State<AppState>, draft: Value) -> Result<(), String> {
    if draft.to_string().len() > 100000 {
        return Err("Voice draft is too large".into());
    }
    state.db()?.set_state("voice-draft", &draft)
}
#[tauri::command]
fn clone_status(state: State<AppState>) -> Result<Value, String> {
    state.db()?.get_state("clone-attempt")
}
#[tauri::command]
fn acknowledge_clone_retry(state: State<AppState>) -> Result<(), String> {
    let mut status = state.db()?.get_state("clone-attempt")?;
    if status["state"] == "requesting" {
        return Err("Voice creation is still running".into());
    }
    status["state"] = json!("acknowledged");
    state.db()?.set_state("clone-attempt", &status)
}
#[tauri::command]
async fn audition_voice(
    state: State<'_, AppState>,
    voice_id: String,
    text: String,
) -> Result<Value, String> {
    if text.trim().is_empty() || text.chars().count() > 300 {
        return Err("Use 1–300 characters for a voice audition".into());
    }
    let voice = state
        .db()?
        .voices()?
        .into_iter()
        .find(|v| v.id == voice_id)
        .ok_or("Voice is unavailable")?;
    if voice.requires_verification {
        return Err("Complete voice verification in ElevenLabs first".into());
    }
    let body = providers::render_chunk(
        &state.client,
        &[DialogueInput {
            voice_id: voice_id.clone(),
            text: text.clone(),
        }],
        "en",
    )
    .await?;
    let bytes = STANDARD
        .decode(
            body["audio_base64"]
                .as_str()
                .ok_or("Missing audio in provider response")?,
        )
        .map_err(|_| "Invalid audio")?;
    audio::decode(&bytes, "mp3")?;
    let id = uuid::Uuid::new_v4().to_string();
    jobs::atomic_write(&state.audio_dir.join(format!("{id}.mp3")), &bytes)?;
    let meta = json!({"id":id,"voiceId":voice_id,"model":"eleven_v3","text":text,"createdAt":chrono::Utc::now().to_rfc3339()});
    jobs::atomic_write(
        &state.audio_dir.join(format!("{id}.audition.json")),
        meta.to_string().as_bytes(),
    )?;
    Ok(json!({"src":format!("data:audio/mpeg;base64,{}",STANDARD.encode(bytes)),"metadata":meta}))
}
fn audio_path(state: &AppState, id: &str) -> Result<PathBuf, String> {
    uuid::Uuid::parse_str(id).map_err(|_| "Invalid audio identifier")?;
    Ok(state.audio_dir.join(format!("{id}.mp3")))
}
#[tauri::command]
async fn read_audio(state: State<'_, AppState>, chunk_id: String) -> Result<String, String> {
    let bytes = tokio::fs::read(audio_path(&state, &chunk_id)?)
        .await
        .map_err(|_| "Saved audio is unavailable")?;
    Ok(format!("data:audio/mpeg;base64,{}", STANDARD.encode(bytes)))
}
#[tauri::command]
async fn export_audio(
    state: State<'_, AppState>,
    chunk_id: String,
    path: String,
) -> Result<(), String> {
    let source = audio_path(&state, &chunk_id)?;
    if std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        != Some("mp3")
    {
        return Err("Choose an .mp3 file".into());
    }
    tokio::fs::copy(source, path)
        .await
        .map(|_| ())
        .map_err(|_| "Could not export audio".into())
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let root = app.path().app_data_dir()?;
            std::fs::create_dir_all(root.join("audio"))?;
            std::fs::create_dir_all(root.join("voice-samples"))?;
            credentials::initialize(&root).map_err(std::io::Error::other)?;
            let store = Store::open(&root.join("convo.sqlite3")).map_err(std::io::Error::other)?;
            for mut take in store.all_takes().map_err(std::io::Error::other)? {
                if !take.plan.is_empty() {
                    if let Err(error) = jobs::reconcile(&mut take, &root.join("audio")) {
                        take.status = "failed".into();
                        take.error = Some(error);
                    }
                    store.put_take(&take).map_err(std::io::Error::other)?;
                }
            }
            let mut attempt = store
                .get_state("clone-attempt")
                .map_err(std::io::Error::other)?;
            if attempt["state"] == "requesting" {
                attempt["state"] = json!("unknown");
                store
                    .set_state("clone-attempt", &attempt)
                    .map_err(std::io::Error::other)?;
            }
            app.manage(AppState {
                store: Mutex::new(store),
                client: providers::client().map_err(std::io::Error::other)?,
                audio_dir: root.join("audio"),
                preview_lock: tokio::sync::Mutex::new(()),
                samples_dir: root.join("voice-samples"),
                render_lock: Arc::new(tokio::sync::Mutex::new(())),
                render_signal: AtomicU8::new(0),
                cancel_render: tokio::sync::Notify::new(),
                active_render: Mutex::new(None),
                clone_lock: tokio::sync::Mutex::new(()),
                cancel_clone: tokio::sync::Notify::new(),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_projects,
            save_project,
            list_revisions,
            list_takes,
            local_voices,
            key_status,
            text_connection,
            save_text_connection,
            save_key,
            refresh_voices,
            create_voice,
            voice_design::voice_design_state,
            voice_design::design_voice,
            voice_design::save_designed_voice,
            voice_design::acknowledge_design_retry,
            list_recordings,
            save_recording,
            remove_recording,
            inspect_samples,
            preview_sample,
            develop_characters,
            generate_script,
            render_audio,
            read_audio,
            export_audio,
            resume_render,
            control_render,
            prepare_take,
            analyze_reference,
            export_take,
            get_voice_draft,
            save_voice_draft,
            clone_status,
            acknowledge_clone_retry,
            audition_voice,
            restore_recording,
            sample_quality,
            cancel_voice_creation,
            recording_trash
        ])
        .run(tauri::generate_context!())
        .expect("Failed to start Convo")
}
