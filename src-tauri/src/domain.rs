use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Speaker {
    pub id: String,
    pub name: String,
    pub personality: String,
    pub voice_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub id: String,
    pub speaker_id: String,
    pub text: String,
    pub direction: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pause_after_ms: Option<u32>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub title: String,
    pub brief: String,
    pub language: String,
    pub model: String,
    pub speakers: Vec<Speaker>,
    pub turns: Vec<Turn>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub performance: Option<Performance>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub character_plan: Option<crate::characters::CharacterPlan>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Performance {
    // Retain the old serialized field solely to preserve saved receipt hashes.
    #[serde(default, rename = "interview", skip_serializing_if = "Option::is_none")]
    pub legacy_interview: Option<bool>,
    pub target_seconds: u32,
    pub stability: f64,
    pub seed: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pacing: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expression: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recording: Option<Recording>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Recording {
    pub style: RecordingStyle,
    pub ambience: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub distance: Option<u32>,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum RecordingStyle {
    Clean,
    PhoneRoom,
    PhoneCall,
}
impl Default for Performance {
    fn default() -> Self {
        Self {
            legacy_interview: None,
            target_seconds: 90,
            stability: 0.5,
            seed: None,
            pacing: None,
            expression: None,
            recording: None,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Voice {
    pub id: String,
    pub name: String,
    pub description: String,
    pub category: String,
    #[serde(default)]
    pub requires_verification: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Revision {
    pub id: i64,
    pub created_at: String,
    pub reason: String,
    pub project: Project,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioChunk {
    pub id: String,
    pub index: usize,
    pub first_turn: usize,
    pub turn_count: usize,
    pub alignment: serde_json::Value,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Take {
    pub id: String,
    pub project_id: String,
    pub created_at: String,
    pub status: String,
    pub script: Project,
    pub chunks: Vec<AudioChunk>,
    pub error: Option<String>,
    #[serde(default)]
    pub plan: Vec<ChunkJob>,
    #[serde(default = "audio_model")]
    pub audio_model: String,
}
pub fn audio_model() -> String {
    "eleven_v3".into()
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkJob {
    pub id: String,
    pub inputs: Vec<DialogueInput>,
    pub first_turn: usize,
    pub fingerprint: String,
    pub status: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DialogueInput {
    pub text: String,
    pub voice_id: String,
}

pub fn validate_project(p: &Project) -> Result<(), String> {
    if let Some(plan) = &p.character_plan {
        crate::characters::validate(plan)?;
    }
    if let Some(performance) = &p.performance {
        if performance
            .pacing
            .as_deref()
            .is_some_and(|v| !["measured", "conversational", "brisk"].contains(&v))
            || performance
                .expression
                .as_deref()
                .is_some_and(|v| !["restrained", "natural", "expressive"].contains(&v))
            || performance
                .recording
                .as_ref()
                .is_some_and(|v| v.ambience > 100 || v.distance.is_some_and(|d| d > 100))
        {
            return Err("Invalid performance or recording settings".into());
        }
        if !(30..=1200).contains(&performance.target_seconds)
            || ![0.0, 0.5, 1.0].contains(&performance.stability)
        {
            return Err("Use a 30–1200 second target and a supported delivery setting".into());
        }
    }
    uuid::Uuid::parse_str(&p.id).map_err(|_| "Invalid project ID")?;
    if p.title.trim().is_empty() || p.title.chars().count() > 200 {
        return Err("Title must contain 1–200 characters".into());
    }
    if p.brief.chars().count() > 20000 || p.turns.len() > 500 {
        return Err("Project exceeds editor limits".into());
    }
    if p.speakers.is_empty() || p.speakers.len() > 10 {
        return Err("Use between 1 and 10 speakers".into());
    }
    let ids: HashSet<_> = p.speakers.iter().map(|s| &s.id).collect();
    if ids.len() != p.speakers.len() {
        return Err("Speaker IDs must be unique".into());
    }
    if p.speakers.iter().any(|s| s.name.trim().is_empty()) {
        return Err("Give every speaker a name".into());
    }
    let mut turns = HashSet::new();
    for t in &p.turns {
        if t.pause_after_ms.is_some_and(|ms| ms > 5000) {
            return Err("Additional pauses must be between 0 and 5000 ms".into());
        }
        if !ids.contains(&t.speaker_id) {
            return Err("A dialogue turn refers to an unknown speaker".into());
        }
        if !turns.insert(&t.id) {
            return Err("Turn IDs must be unique".into());
        }
        if t.text.chars().count() > 10000 || t.direction.chars().count() > 100 {
            return Err("A turn or direction is too long".into());
        }
        if t.direction.contains(['[', ']']) {
            return Err("Enter direction without square brackets".into());
        }
    }
    Ok(())
}

pub fn dialogue_chunks(p: &Project) -> Result<Vec<Vec<DialogueInput>>, String> {
    validate_project(p)?;
    if p.turns.is_empty() {
        return Err("Write or generate a script first".into());
    }
    let mut result = Vec::new();
    let mut chunk = Vec::new();
    let mut count = 0;
    for (index, t) in p.turns.iter().enumerate() {
        let speaker = p
            .speakers
            .iter()
            .find(|s| s.id == t.speaker_id)
            .ok_or("Unknown speaker")?;
        if speaker.voice_id.is_empty() {
            return Err(format!("Choose a voice for {}", speaker.name));
        }
        if t.text.trim().is_empty() {
            return Err(format!("Turn {} is empty", index + 1));
        }
        let text = if t.direction.trim().is_empty() {
            t.text.clone()
        } else {
            format!("[{}] {}", t.direction.trim(), t.text)
        };
        let length = text.chars().count();
        if length > 2000 {
            return Err(format!(
                "Turn {} exceeds 2,000 characters including direction; split this turn",
                index + 1
            ));
        }
        if count + length > 2000 {
            result.push(std::mem::take(&mut chunk));
            count = 0;
        }
        count += length;
        chunk.push(DialogueInput {
            text,
            voice_id: speaker.voice_id.clone(),
        });
    }
    if !chunk.is_empty() {
        result.push(chunk);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    pub fn project() -> Project {
        Project {
            character_plan: None,
            performance: None,
            id: uuid::Uuid::new_v4().to_string(),
            title: "Test".into(),
            brief: "A reunion".into(),
            language: "en".into(),
            model: "gpt-6-astra".into(),
            speakers: vec![Speaker {
                id: "a".into(),
                name: "A".into(),
                personality: "warm".into(),
                voice_id: "voice".into(),
            }],
            turns: vec![Turn {
                pause_after_ms: None,
                id: "1".into(),
                speaker_id: "a".into(),
                text: "你好🙂".repeat(600),
                direction: "".into(),
            }],
        }
    }
    #[test]
    fn counts_unicode_not_bytes() {
        assert_eq!(dialogue_chunks(&project()).unwrap().len(), 1);
    }
    #[test]
    fn splits_at_turn_boundary_and_counts_tags() {
        let mut p = project();
        let mut t = p.turns[0].clone();
        t.id = "2".into();
        t.text = "a".repeat(195);
        t.direction = "laughs".into();
        p.turns.push(t);
        assert_eq!(dialogue_chunks(&p).unwrap().len(), 2);
    }
    #[test]
    fn oversized_turn_rejected() {
        let mut p = project();
        p.turns[0].text = "a".repeat(2001);
        assert!(dialogue_chunks(&p).is_err());
    }
    #[test]
    fn bad_cast_and_missing_voice_rejected() {
        let mut p = project();
        p.turns[0].speaker_id = "missing".into();
        assert!(dialogue_chunks(&p).is_err());
        p.turns[0].speaker_id = "a".into();
        p.speakers[0].voice_id.clear();
        assert!(dialogue_chunks(&p).is_err());
    }
    #[test]
    fn exact_limit_accepted() {
        let mut p = project();
        p.turns[0].text = "a".repeat(2000);
        assert_eq!(dialogue_chunks(&p).unwrap().len(), 1);
    }
}
