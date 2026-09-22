use crate::{domain::*, providers, AppState};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{future::Future, path::Path, sync::atomic::Ordering};
use tauri::Emitter;

fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn fingerprint(
    inputs: &[DialogueInput],
    language: &str,
    model: &str,
    performance: Option<&Performance>,
) -> String {
    // Preserve old receipts exactly; new requests include their immutable settings.
    match performance {
        None => hash(&serde_json::to_vec(&(inputs, language, model)).unwrap()),
        Some(p) => hash(&serde_json::to_vec(&(inputs, language, model, p)).unwrap()),
    }
}
pub fn prepare(project: Project) -> Result<Take, String> {
    let mut first_turn = 0;
    let plan = dialogue_chunks(&project)?
        .into_iter()
        .map(|inputs| {
            let job = ChunkJob {
                id: uuid::Uuid::new_v4().to_string(),
                fingerprint: fingerprint(
                    &inputs,
                    &project.language,
                    "eleven_v3",
                    project.performance.as_ref(),
                ),
                first_turn,
                inputs,
                status: "queued".into(),
            };
            first_turn += job.inputs.len();
            job
        })
        .collect();
    Ok(Take {
        id: uuid::Uuid::new_v4().to_string(),
        project_id: project.id.clone(),
        created_at: chrono::Utc::now().to_rfc3339(),
        status: "rendering".into(),
        script: project,
        chunks: vec![],
        error: None,
        plan,
        audio_model: audio_model(),
    })
}
#[derive(Serialize, Deserialize)]
struct Receipt {
    fingerprint: String,
    audio_hash: String,
    chunk: AudioChunk,
}
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let mut temp = tempfile::NamedTempFile::new_in(path.parent().ok_or("Invalid output path")?)
        .map_err(|_| "Could not create temporary audio file")?;
    temp.write_all(bytes)
        .and_then(|_| temp.as_file().sync_all())
        .map_err(|_| "Could not save audio; check free disk space")?;
    temp.persist(path)
        .map_err(|_| "Could not finalize audio file")?;
    Ok(())
}
pub fn reconcile(take: &mut Take, dir: &Path) -> Result<(), String> {
    if take.plan.is_empty() {
        // Upgrade an old take using its immutable script and already saved parts.
        take.plan = prepare(take.script.clone())?.plan;
        for chunk in &take.chunks {
            if let Some(job) = take.plan.get_mut(chunk.index) {
                job.id = chunk.id.clone();
                job.status = "complete".into();
            }
        }
    }
    for (index, job) in take.plan.iter_mut().enumerate() {
        uuid::Uuid::parse_str(&job.id).map_err(|_| "Invalid audio identifier")?;
        if job.fingerprint
            != fingerprint(
                &job.inputs,
                &take.script.language,
                &take.audio_model,
                take.script.performance.as_ref(),
            )
        {
            return Err("Saved render inputs do not match their fingerprint".into());
        }
        let audio = dir.join(format!("{}.mp3", job.id));
        if job.status == "complete" && !audio.is_file() {
            job.status = "failed".into();
            take.chunks.retain(|c| c.index != index);
        }
        let receipt = dir.join(format!("{}.receipt.json", job.id));
        if receipt.exists() {
            let result = (|| -> Result<Receipt, String> {
                let receipt: Receipt = serde_json::from_slice(
                    &std::fs::read(receipt).map_err(|_| "Missing render receipt")?,
                )
                .map_err(|_| "Invalid render receipt")?;
                let bytes = std::fs::read(&audio).map_err(|_| "Saved audio is unavailable")?;
                if receipt.fingerprint != job.fingerprint
                    || receipt.audio_hash != hash(&bytes)
                    || receipt.chunk.id != job.id
                    || receipt.chunk.index != index
                {
                    return Err("Saved audio failed integrity verification".into());
                }
                Ok(receipt)
            })();
            match result {
                Ok(r) => {
                    take.chunks.retain(|c| c.index != index);
                    take.chunks.push(r.chunk);
                    job.status = "complete".into();
                }
                Err(e) => {
                    job.status = "unknown".into();
                    take.chunks.retain(|c| c.index != index);
                    take.error = Some(e);
                }
            }
        } else if job.status == "requesting" {
            job.status = "unknown".into();
        }
    }
    take.chunks.sort_by_key(|c| c.index);
    if take.plan.iter().all(|j| j.status == "complete") {
        take.status = "complete".into();
        take.error = None;
    } else if take.status == "complete" {
        take.status = "interrupted".into();
    }
    Ok(())
}
pub async fn execute<F, Fut, S>(
    state: &AppState,
    mut take: Take,
    mut render: F,
    mut changed: S,
) -> Result<Take, String>
where
    F: FnMut(Vec<DialogueInput>, String) -> Fut,
    Fut: Future<Output = Result<Value, String>>,
    S: FnMut(&Take),
{
    let persist = |take: &Take, changed: &mut S| -> Result<(), String> {
        state.db()?.put_take(take)?;
        changed(take);
        Ok(())
    };
    for index in 0..take.plan.len() {
        if take.plan[index].status == "complete" {
            continue;
        }
        match state.render_signal.load(Ordering::SeqCst) {
            1 => {
                take.status = "paused".into();
                break;
            }
            2 => {
                take.status = "cancelled".into();
                break;
            }
            _ => {}
        }
        take.plan[index].status = "requesting".into();
        persist(&take, &mut changed)?;
        let cancelled = state.cancel_render.notified();
        tokio::pin!(cancelled);
        cancelled.as_mut().enable();
        if state.render_signal.load(Ordering::SeqCst) == 2 {
            take.plan[index].status = "queued".into();
            take.status = "cancelled".into();
            break;
        }
        let request = render(
            take.plan[index].inputs.clone(),
            take.script.language.clone(),
        );
        let result = match futures_util::future::select(Box::pin(request), cancelled).await {
            futures_util::future::Either::Left((result, _)) => result,
            futures_util::future::Either::Right(_) => {
                Err("Cancelled locally. The in-flight request may still be billed.".into())
            }
        };
        let outcome = (|| -> Result<AudioChunk, String> {
            let mut body = result?;
            let bytes = STANDARD
                .decode(
                    body["audio_base64"]
                        .as_str()
                        .ok_or("Missing audio in provider response")?,
                )
                .map_err(|_| "Provider returned invalid audio encoding")?;
            crate::audio::decode(&bytes, "mp3")?;
            let job = &take.plan[index];
            atomic_write(&state.audio_dir.join(format!("{}.mp3", job.id)), &bytes)?;
            if let Some(body) = body.as_object_mut() {
                body.remove("audio_base64");
            }
            let chunk = AudioChunk {
                id: job.id.clone(),
                index,
                first_turn: job.first_turn,
                turn_count: job.inputs.len(),
                alignment: body,
            };
            let receipt = Receipt {
                fingerprint: job.fingerprint.clone(),
                audio_hash: hash(&bytes),
                chunk: chunk.clone(),
            };
            atomic_write(
                &state.audio_dir.join(format!("{}.receipt.json", job.id)),
                &serde_json::to_vec(&receipt).map_err(|e| e.to_string())?,
            )?;
            Ok(chunk)
        })();
        match outcome {
            Ok(chunk) => {
                take.plan[index].status = "complete".into();
                take.chunks.push(chunk);
            }
            Err(error) => {
                // Conservatively require acknowledgement: a response may have been lost after billing.
                take.plan[index].status = if error.contains("HTTP 4") {
                    "failed"
                } else {
                    "unknown"
                }
                .into();
                take.status = if state.render_signal.load(Ordering::SeqCst) == 2 {
                    "cancelled"
                } else {
                    "failed"
                }
                .into();
                take.error = Some(error);
                persist(&take, &mut changed)?;
                return Ok(take);
            }
        }
        persist(&take, &mut changed)?;
    }
    if take.plan.iter().all(|j| j.status == "complete") {
        take.status = "complete".into();
    }
    persist(&take, &mut changed)?;
    Ok(take)
}
pub async fn run(app: tauri::AppHandle, take: Take) {
    use tauri::Manager;
    let state = app.state::<AppState>();
    let id = take.id.clone();
    let performance = take.script.performance.clone();
    let result = execute(
        &state,
        take,
        |inputs, language| {
            let client = state.client.clone();
            let performance = performance.clone();
            async move {
                providers::render_chunk_configured(
                    &client,
                    &inputs,
                    &language,
                    performance.as_ref(),
                )
                .await
            }
        },
        |take| {
            let _ = app.emit("render-progress", take);
        },
    )
    .await;
    if let Err(error) = result {
        if let Ok(db) = state.db() {
            if let Ok(mut take) = db.take(&id) {
                take.status = "interrupted".into();
                take.error = Some(error);
                let _ = db.put_take(&take);
                let _ = app.emit("render-progress", take);
            }
        }
    }
    if let Ok(mut active) = state.active_render.lock() {
        *active = None;
    };
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{audio, store::Store};
    use std::sync::{atomic::AtomicU8, Arc, Mutex};
    fn fixture(root: &Path) -> (AppState, Take) {
        let mut db = Store::open(&root.join("test.sqlite3")).unwrap();
        let project = Project {
            character_plan: None,
            performance: None,
            id: uuid::Uuid::new_v4().to_string(),
            title: "Recovery test".into(),
            brief: "Test".into(),
            language: "en".into(),
            model: "test".into(),
            speakers: vec![Speaker {
                id: "a".into(),
                name: "A".into(),
                personality: String::new(),
                voice_id: "voice".into(),
            }],
            turns: (0..3)
                .map(|i| Turn {
                    pause_after_ms: None,
                    id: i.to_string(),
                    speaker_id: "a".into(),
                    text: "a".repeat(1900),
                    direction: String::new(),
                })
                .collect(),
        };
        db.save(&project, "Created").unwrap();
        let take = prepare(project).unwrap();
        db.put_take(&take).unwrap();
        (
            AppState {
                store: Mutex::new(db),
                client: providers::client().unwrap(),
                audio_dir: root.into(),
                preview_lock: tokio::sync::Mutex::new(()),
                samples_dir: root.into(),
                render_lock: Arc::new(tokio::sync::Mutex::new(())),
                render_signal: AtomicU8::new(0),
                cancel_render: tokio::sync::Notify::new(),
                active_render: Mutex::new(None),
                clone_lock: tokio::sync::Mutex::new(()),
                cancel_clone: tokio::sync::Notify::new(),
            },
            take,
        )
    }
    fn response() -> Value {
        let pcm: Vec<f32> = (0..4410).map(|i| (i as f32 / 10.0).sin() * 0.1).collect();
        serde_json::json!({"audio_base64":STANDARD.encode(audio::mp3(&pcm).unwrap())})
    }
    #[test]
    fn receipt_fingerprint_includes_performance_but_preserves_legacy_hashes() {
        let inputs = vec![DialogueInput {
            text: "Hello".into(),
            voice_id: "voice".into(),
        }];
        assert_eq!(
            fingerprint(&inputs, "en", "eleven_v3", None),
            hash(&serde_json::to_vec(&(&inputs, "en", "eleven_v3")).unwrap())
        );
        let mut p = Performance {
            pacing: None,
            expression: None,
            recording: None,
            legacy_interview: None,
            target_seconds: 90,
            stability: 0.5,
            seed: Some(1),
        };
        assert!(serde_json::to_value(&p).unwrap().get("interview").is_none());
        let old_json = r#"{"interview":true,"targetSeconds":90,"stability":0.5,"seed":1}"#;
        let legacy: Performance = serde_json::from_str(old_json).unwrap();
        let old_request = format!(
            "[{},\"en\",\"eleven_v3\",{}]",
            serde_json::to_string(&inputs).unwrap(),
            old_json
        );
        assert_eq!(
            fingerprint(&inputs, "en", "eleven_v3", Some(&legacy)),
            hash(old_request.as_bytes())
        );
        let before = fingerprint(&inputs, "en", "eleven_v3", Some(&p));
        p.seed = Some(2);
        assert_ne!(before, fingerprint(&inputs, "en", "eleven_v3", Some(&p)));
    }
    #[test]
    fn pause_resume_skips_saved_requests_and_recovers_receipts() {
        let root = tempfile::tempdir().unwrap();
        let (state, take) = fixture(root.path());
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let calls = std::cell::Cell::new(0);
        let body = response();
        let mut paused = rt
            .block_on(execute(
                &state,
                take,
                |_, _| {
                    calls.set(calls.get() + 1);
                    std::future::ready(Ok(body.clone()))
                },
                |take| {
                    if take.chunks.len() == 1 {
                        state.render_signal.store(1, Ordering::SeqCst);
                    }
                },
            ))
            .unwrap();
        assert_eq!(paused.status, "paused");
        assert_eq!(calls.get(), 1);
        // Simulate crash after receipt write but before SQLite marks the chunk complete.
        paused.chunks.clear();
        paused.plan[0].status = "requesting".into();
        reconcile(&mut paused, root.path()).unwrap();
        assert_eq!(paused.chunks.len(), 1);
        state.render_signal.store(0, Ordering::SeqCst);
        paused.status = "rendering".into();
        let finished = rt
            .block_on(execute(
                &state,
                paused,
                |_, _| {
                    calls.set(calls.get() + 1);
                    std::future::ready(Ok(body.clone()))
                },
                |_| {},
            ))
            .unwrap();
        assert_eq!(finished.status, "complete");
        assert_eq!(calls.get(), 3);
        assert_eq!(finished.chunks.len(), 3);
        let mut corrupt = finished.clone();
        std::fs::write(
            root.path().join(format!("{}.mp3", corrupt.plan[1].id)),
            b"corrupt",
        )
        .unwrap();
        reconcile(&mut corrupt, root.path()).unwrap();
        assert_eq!(corrupt.plan[1].status, "unknown");
        assert_eq!(corrupt.chunks.len(), 2);
    }
    #[test]
    fn timeout_is_unknown_and_never_retried_automatically() {
        let root = tempfile::tempdir().unwrap();
        let (state, take) = fixture(root.path());
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let calls = std::cell::Cell::new(0);
        let failed = rt
            .block_on(execute(
                &state,
                take,
                |_, _| {
                    calls.set(calls.get() + 1);
                    std::future::ready(Err("Network timed out".into()))
                },
                |_| {},
            ))
            .unwrap();
        assert_eq!(calls.get(), 1);
        assert_eq!(failed.plan[0].status, "unknown");
        assert_eq!(failed.plan[1].status, "queued");
        let mut invalid = failed;
        invalid.plan[0].inputs[0].text = "changed".into();
        assert!(reconcile(&mut invalid, root.path()).is_err());
    }
    #[test]
    fn cancel_before_submission_does_not_call_provider() {
        let root = tempfile::tempdir().unwrap();
        let (state, take) = fixture(root.path());
        state.render_signal.store(2, Ordering::SeqCst);
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let result = rt
            .block_on(execute(
                &state,
                take,
                |_, _| {
                    panic!("Provider must not be called");
                    #[allow(unreachable_code)]
                    std::future::ready(Ok(Value::Null))
                },
                |_| {},
            ))
            .unwrap();
        assert_eq!(result.status, "cancelled");
        assert!(result.chunks.is_empty());
    }
    #[test]
    fn cancelling_in_flight_leaves_an_unknown_outcome() {
        let root = tempfile::tempdir().unwrap();
        let (state, take) = fixture(root.path());
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let result = rt.block_on(async {
            tokio::time::timeout(
                std::time::Duration::from_secs(1),
                execute(
                    &state,
                    take,
                    |_, _| {
                        state.render_signal.store(2, Ordering::SeqCst);
                        state.cancel_render.notify_waiters();
                        std::future::pending::<Result<Value, String>>()
                    },
                    |_| {},
                ),
            )
            .await
            .unwrap()
            .unwrap()
        });
        assert_eq!(result.status, "cancelled");
        assert_eq!(result.plan[0].status, "unknown");
    }
    #[test]
    fn database_write_failure_prevents_billable_submission() {
        let root = tempfile::tempdir().unwrap();
        let (state, take) = fixture(root.path());
        state
            .db()
            .unwrap()
            .db
            .pragma_update(None, "query_only", true)
            .unwrap();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let result = rt.block_on(execute(
            &state,
            take,
            |_, _| {
                panic!("No request before durable job state");
                #[allow(unreachable_code)]
                std::future::ready(Ok(Value::Null))
            },
            |_| {},
        ));
        assert!(result.is_err());
        assert_eq!(state.db().unwrap().all_takes().unwrap().len(), 1);
    }
}
