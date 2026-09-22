use crate::{domain::Voice, providers, AppState};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignRequest {
    pub description: String,
    pub text: String,
    pub guidance: f64,
}
impl DesignRequest {
    pub fn payload(&self) -> Result<Value, String> {
        if !(20..=1000).contains(&self.description.trim().chars().count()) {
            return Err("Voice description must contain 20–1000 characters".into());
        }
        if !self.text.trim().is_empty() && !(100..=1000).contains(&self.text.trim().chars().count())
        {
            return Err(
                "Preview text must contain 100–1000 characters, or be empty for automatic text"
                    .into(),
            );
        }
        if !self.guidance.is_finite() || !(0.0..=100.0).contains(&self.guidance) {
            return Err("Guidance must be between 0 and 100".into());
        }
        let mut body = json!({"model_id":"eleven_ttv_v3", "voice_description":self.description.trim(),
            "guidance_scale":self.guidance, "auto_generate_text":self.text.trim().is_empty(), "stream_previews":false});
        if !self.text.trim().is_empty() {
            body["text"] = json!(self.text.trim());
        }
        Ok(body)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Preview {
    pub generated_voice_id: String,
    pub audio_base_64: String,
    pub duration_secs: f64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesignResponse {
    pub previews: Vec<Preview>,
    pub text: String,
}

pub async fn generate(
    client: &reqwest::Client,
    request: &DesignRequest,
) -> Result<DesignResponse, String> {
    let payload = request.payload()?;
    let response = client
        .post("https://api.elevenlabs.io/v1/text-to-voice/design")
        .query(&[("output_format", "mp3_44100_128")])
        .header("xi-api-key", providers::credential("elevenlabs")?)
        .json(&payload)
        .send()
        .await
        .map_err(providers::network_error)?;
    let result: DesignResponse = providers::checked(response, "ElevenLabs")
        .await?
        .json()
        .await
        .map_err(|_| "Invalid voice design response; no automatic retry was made")?;
    if result.previews.is_empty()
        || result.previews.len() > 10
        || result.previews.iter().any(|p| {
            p.generated_voice_id.is_empty()
                || p.audio_base_64.is_empty()
                || !p.duration_secs.is_finite()
        })
    {
        return Err("Invalid voice design previews; no automatic retry was made".into());
    }
    Ok(result)
}

fn unresolved(status: &Value) -> bool {
    status["state"] == "requesting" || status["state"] == "unknown"
}
fn recover(db: &crate::store::Store) -> Result<(), String> {
    let mut attempt = db.get_state("design-attempt")?;
    if let Some(receipt) = attempt
        .get("voice")
        .filter(|_| attempt["state"] == "received")
    {
        let voice: Voice =
            serde_json::from_value(receipt.clone()).map_err(|_| "Invalid saved voice receipt")?;
        db.put_voice(&voice)?;
        let mut batch = db.get_state("design-previews")?;
        let id = attempt["generatedId"]
            .as_str()
            .ok_or("Invalid saved voice receipt")?;
        if !batch.is_null() {
            if !batch["saved"].is_object() {
                batch["saved"] = json!({});
            }
            batch["saved"][id] = json!(voice.id);
            db.set_state("design-previews", &batch)?;
        }
        attempt["state"] = json!("complete");
        db.set_state("design-attempt", &attempt)?;
    } else if attempt["state"] == "requesting" {
        attempt["state"] = json!("unknown");
        db.set_state("design-attempt", &attempt)?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn voice_design_state(state: State<AppState>) -> Result<Value, String> {
    if let Ok(_guard) = state.clone_lock.try_lock() {
        recover(&*state.db()?)?;
    }
    let db = state.db()?;
    Ok(json!({"batch":db.get_state("design-previews")?, "attempt":db.get_state("design-attempt")?}))
}

#[tauri::command]
pub(crate) async fn design_voice(
    state: State<'_, AppState>,
    request: DesignRequest,
) -> Result<Value, String> {
    let _guard = state
        .clone_lock
        .try_lock()
        .map_err(|_| "Voice creation is still running")?;
    recover(&*state.db()?)?;
    if unresolved(&state.db()?.get_state("design-attempt")?) {
        return Err("Review the previous voice design attempt before retrying".into());
    }
    request.payload()?;
    providers::credential("elevenlabs")?;
    state.db()?.set_state(
        "design-attempt",
        &json!({"state":"requesting","stage":"preview"}),
    )?;
    match generate(&state.client, &request).await {
        Ok(response) => {
            let batch = json!({"request":request,"result":response,"saved":{}});
            state.db()?.set_state("design-previews", &batch)?;
            state.db()?.set_state(
                "design-attempt",
                &json!({"state":"complete","stage":"preview"}),
            )?;
            Ok(batch)
        }
        Err(error) => {
            state.db()?.set_state("design-attempt", &json!({"state":if error.contains("HTTP 4") {"failed"} else {"unknown"},"stage":"preview"}))?;
            Err(error)
        }
    }
}

#[tauri::command]
pub(crate) async fn save_designed_voice(
    state: State<'_, AppState>,
    generated_id: String,
    name: String,
) -> Result<Voice, String> {
    let _guard = state
        .clone_lock
        .try_lock()
        .map_err(|_| "Voice creation is still running")?;
    recover(&*state.db()?)?;
    if unresolved(&state.db()?.get_state("design-attempt")?) {
        return Err("Review the previous voice design attempt before retrying".into());
    }
    if name.trim().is_empty() || name.chars().count() > 100 {
        return Err("Voice name must contain 1–100 characters".into());
    }
    let batch = state.db()?.get_state("design-previews")?;
    if batch["saved"].get(&generated_id).is_some() {
        return Err("This preview is already saved in your voice library".into());
    }
    let response: DesignResponse = serde_json::from_value(batch["result"].clone())
        .map_err(|_| "Generate a voice preview first")?;
    if !response
        .previews
        .iter()
        .any(|p| p.generated_voice_id == generated_id)
    {
        return Err("Generate a voice preview first".into());
    }
    let description = batch["request"]["description"]
        .as_str()
        .ok_or("Missing voice description")?
        .to_string();
    let key = providers::credential("elevenlabs")?;
    state.db()?.set_state(
        "design-attempt",
        &json!({"state":"requesting","stage":"save","name":name,"generatedId":generated_id}),
    )?;
    let result = async {
        let response = state.client.post("https://api.elevenlabs.io/v1/text-to-voice")
            .header("xi-api-key", key).json(&json!({"voice_name":name.trim(),"voice_description":description,"generated_voice_id":generated_id}))
            .send().await.map_err(providers::network_error)?;
        let body: Value = providers::checked(response, "ElevenLabs").await?.json().await.map_err(|_| "Invalid saved voice response")?;
        let id = body["voice_id"].as_str().filter(|s| !s.is_empty()).ok_or("Missing saved voice identifier")?;
        Ok::<Voice, String>(Voice { id:id.into(), name:name.trim().into(), description, category:"generated".into(), requires_verification:false })
    }.await;
    match result {
        Ok(voice) => {
            // Persist provider receipt before updating the library; reopen can finish locally.
            state.db()?.set_state("design-attempt", &json!({"state":"received","stage":"save","generatedId":generated_id,"voice":voice}))?;
            recover(&*state.db()?)?;
            Ok(voice)
        }
        Err(error) => {
            state.db()?.set_state("design-attempt", &json!({"state":if error.contains("HTTP 4") {"failed"} else {"unknown"},"stage":"save","name":name}))?;
            Err(error)
        }
    }
}

#[tauri::command]
pub(crate) fn acknowledge_design_retry(state: State<AppState>) -> Result<(), String> {
    let _guard = state
        .clone_lock
        .try_lock()
        .map_err(|_| "Voice creation is still running")?;
    recover(&*state.db()?)?;
    state
        .db()?
        .set_state("design-attempt", &json!({"state":"acknowledged"}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn interrupted_saves_recover_receipts_locally_and_unknown_requests_stay_blocked() {
        let db = crate::store::Store::open(std::path::Path::new(":memory:")).unwrap();
        db.set_state(
            "design-attempt",
            &json!({"state":"requesting","stage":"save"}),
        )
        .unwrap();
        recover(&db).unwrap();
        assert!(unresolved(&db.get_state("design-attempt").unwrap()));
        db.set_state("design-previews", &json!({"saved":{}}))
            .unwrap();
        let voice = Voice {
            id: "saved-id".into(),
            name: "Test".into(),
            description: "Designed test voice".into(),
            category: "generated".into(),
            requires_verification: false,
        };
        db.set_state(
            "design-attempt",
            &json!({"state":"received","generatedId":"preview-id","voice":voice}),
        )
        .unwrap();
        recover(&db).unwrap();
        recover(&db).unwrap();
        assert_eq!(db.voices().unwrap().len(), 1);
        assert_eq!(
            db.get_state("design-previews").unwrap()["saved"]["preview-id"],
            "saved-id"
        );
        assert!(!unresolved(&db.get_state("design-attempt").unwrap()));
        db.db.execute("DELETE FROM voices", []).unwrap();
        recover(&db).unwrap();
        assert!(
            db.voices().unwrap().is_empty(),
            "A completed receipt must not resurrect a removed voice"
        );
    }
    #[test]
    fn design_uses_v3_and_exact_prompt_with_no_reference_upload() {
        let mut request = DesignRequest {
            description: "Native English. Warm adult voice, curious and conversational.".into(),
            text: String::new(),
            guidance: 5.0,
        };
        let body = request.payload().unwrap();
        assert_eq!(body["model_id"], "eleven_ttv_v3");
        assert_eq!(body["voice_description"], request.description);
        assert_eq!(body["auto_generate_text"], true);
        assert!(body.get("reference_audio_base64").is_none());
        request.text = "A".repeat(100);
        assert_eq!(request.payload().unwrap()["auto_generate_text"], false);
        request.text = "短".repeat(99);
        assert!(request.payload().is_err());
        request.text.clear();
        request.guidance = f64::NAN;
        assert!(request.payload().is_err());
        request.guidance = 101.0;
        assert!(request.payload().is_err());
    }
}
