use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::path::{Path, PathBuf};

pub const MAX_BYTES: u64 = 50 * 1024 * 1024;
// Stay below ElevenLabs’ per-file 11 MB upload limit.
pub const MAX_UPLOAD_FILE_BYTES: usize = 10 * 1024 * 1024;
const LARGE_SAMPLE_ERROR: &str = "This audio file exceeds the upload size limit. In-app recordings are split automatically; trim or compress other files to under 10 MB each.";
const MAX_RECORDING_BYTES: usize = 44 + 44100 * 2 * 180;
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub path: String,
    pub name: String,
    pub bytes: u64,
    pub id: Option<String>,
    pub duration: Option<f64>,
}
pub fn mime(path: &Path) -> Result<&'static str, String> {
    match path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "wav" => Ok("audio/wav"),
        "mp3" => Ok("audio/mpeg"),
        "m4a" => Ok("audio/mp4"),
        "flac" => Ok("audio/flac"),
        _ => Err("Use WAV, MP3, M4A or FLAC audio samples".into()),
    }
}
pub fn inspect(paths: Vec<String>) -> Result<Vec<Sample>, String> {
    if paths.len() > 10 {
        return Err("Select between 1 and 10 audio samples".into());
    }
    let mut total = 0;
    paths
        .into_iter()
        .map(|path| {
            let file = Path::new(&path);
            mime(file)?;
            let meta = std::fs::metadata(file).map_err(|_| "Could not read sample file")?;
            total += meta.len();
            if !meta.is_file() || meta.len() == 0 || total > MAX_BYTES {
                return Err("Samples must be nonempty files totaling at most 50 MB".into());
            }
            if meta.len() > MAX_UPLOAD_FILE_BYTES as u64 {
                let bytes = std::fs::read(file).map_err(|_| "Could not read sample file")?;
                validate_large_upload(&bytes, mime(file)?)?;
            }
            Ok(Sample {
                name: file
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into(),
                path,
                bytes: meta.len(),
                id: None,
                duration: None,
            })
        })
        .collect()
}
fn recording_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    let uuid = uuid::Uuid::parse_str(id).map_err(|_| "Invalid recording identifier")?;
    Ok(root.join(format!("{uuid}.wav")))
}
fn wav_duration(bytes: &[u8]) -> Result<f64, String> {
    // Only accept the bounded PCM WAV format produced by our recorder.
    if bytes.len() < 44
        || bytes.len() > MAX_RECORDING_BYTES
        || &bytes[0..4] != b"RIFF"
        || &bytes[8..16] != b"WAVEfmt "
        || &bytes[36..40] != b"data"
        || u32::from_le_bytes(bytes[16..20].try_into().unwrap()) != 16
        || u16::from_le_bytes(bytes[20..22].try_into().unwrap()) != 1
        || u16::from_le_bytes(bytes[22..24].try_into().unwrap()) != 1
        || u32::from_le_bytes(bytes[24..28].try_into().unwrap()) != 44100
        || u32::from_le_bytes(bytes[28..32].try_into().unwrap()) != 88200
        || u16::from_le_bytes(bytes[32..34].try_into().unwrap()) != 2
        || u16::from_le_bytes(bytes[34..36].try_into().unwrap()) != 16
        || u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize != bytes.len() - 8
        || u32::from_le_bytes(bytes[40..44].try_into().unwrap()) as usize != bytes.len() - 44
        || !(bytes.len() - 44).is_multiple_of(2)
    {
        return Err("Invalid recording audio".into());
    }
    let duration = (bytes.len() - 44) as f64 / 88200.0;
    if duration < 0.3 {
        return Err("Recording is too short. Record at least one second.".into());
    }
    Ok(duration)
}
fn validate_large_upload(bytes: &[u8], mime: &str) -> Result<(), String> {
    if mime != "audio/wav" || wav_duration(bytes).is_err() {
        return Err(LARGE_SAMPLE_ERROR.into());
    }
    Ok(())
}

pub fn upload_parts(bytes: Vec<u8>, mime: &str) -> Result<Vec<Vec<u8>>, String> {
    if bytes.len() <= MAX_UPLOAD_FILE_BYTES {
        return Ok(vec![bytes]);
    }
    validate_large_upload(&bytes, mime)?;
    // The recorder emits mono PCM16 WAV. Split at frame boundaries, copying
    // every PCM byte unchanged and replacing only each part's length fields.
    let max_pcm = (MAX_UPLOAD_FILE_BYTES - 44) / 2 * 2;
    let count = (bytes.len() - 44).div_ceil(max_pcm);
    let part_pcm = ((bytes.len() - 44) / 2).div_ceil(count) * 2;
    Ok(bytes[44..]
        .chunks(part_pcm)
        .map(|pcm| {
            let mut part = bytes[..44].to_vec();
            part[4..8].copy_from_slice(&((pcm.len() + 36) as u32).to_le_bytes());
            part[40..44].copy_from_slice(&(pcm.len() as u32).to_le_bytes());
            part.extend_from_slice(pcm);
            part
        })
        .collect())
}

pub fn list(root: &Path) -> Result<Vec<Sample>, String> {
    let entries = std::fs::read_dir(root).map_err(|_| "Could not load recordings")?;
    let mut files = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|_| "Could not load recordings")?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("wav") {
            continue;
        }
        let id = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or_default();
        if uuid::Uuid::parse_str(id).is_err() {
            continue;
        }
        let metadata = entry.metadata().map_err(|_| "Could not load recordings")?;
        let created: chrono::DateTime<chrono::Local> = metadata
            .modified()
            .map_err(|_| "Could not load recordings")?
            .into();
        files.push((
            created,
            Sample {
                path: path.to_string_lossy().into(),
                name: format!("Recording {}.wav", created.format("%Y-%m-%d %H-%M-%S")),
                bytes: metadata.len(),
                id: Some(id.into()),
                duration: Some(metadata.len().saturating_sub(44) as f64 / 88200.0),
            },
        ));
    }
    files.sort_by_key(|(created, _)| *created);
    Ok(files.into_iter().map(|(_, sample)| sample).collect())
}
pub fn save(root: &Path, encoded: &str) -> Result<Sample, String> {
    if encoded.len() > MAX_RECORDING_BYTES.div_ceil(3) * 4 {
        return Err("Recording exceeds the three-minute limit".into());
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| "Invalid recording audio")?;
    let duration = wav_duration(&bytes)?;
    let existing = list(root)?;
    if existing.iter().map(|s| s.bytes).sum::<u64>() + bytes.len() as u64 > 500 * 1024 * 1024 {
        return Err("Recording library exceeds 500 MB. Move old recordings to trash.".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let path = recording_path(root, &id)?;
    let temporary = path.with_extension("part");
    std::fs::write(&temporary, &bytes).map_err(|_| "Could not save recording")?;
    if std::fs::rename(&temporary, &path).is_err() {
        let _ = std::fs::remove_file(&temporary);
        return Err("Could not save recording".into());
    }
    Ok(Sample {
        path: path.to_string_lossy().into(),
        name: format!(
            "Recording {}.wav",
            chrono::Local::now().format("%Y-%m-%d %H-%M-%S")
        ),
        bytes: bytes.len() as u64,
        id: Some(id),
        duration: Some(duration),
    })
}
pub fn remove(root: &Path, id: &str) -> Result<(), String> {
    let trash = root.join("trash");
    std::fs::create_dir_all(&trash).map_err(|_| "Could not create recording trash")?;
    std::fs::rename(recording_path(root, id)?, recording_path(&trash, id)?)
        .map_err(|_| "Could not remove recording".into())
}
pub fn restore(root: &Path, id: &str) -> Result<(), String> {
    let path = recording_path(root, id)?;
    if path.exists() {
        return Err("Recording already exists".into());
    }
    std::fs::rename(recording_path(&root.join("trash"), id)?, path)
        .map_err(|_| "Could not restore recording".into())
}
pub fn quality(path: &str) -> Result<serde_json::Value, String> {
    inspect(vec![path.into()])?;
    let bytes = std::fs::read(path).map_err(|_| "Could not read sample file")?;
    let extension = Path::new(path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    let audio = crate::audio::decode(&bytes, &extension)?;
    let frames = audio.len() as f64;
    let clipped = audio.iter().filter(|v| v.abs() >= 0.995).count() as f64 / frames;
    let silent = audio.iter().filter(|v| v.abs() < 0.003).count() as f64 / frames;
    Ok(
        serde_json::json!({"duration": frames / crate::audio::RATE as f64, "clipped":clipped,"silent":silent}),
    )
}
pub fn preview(path: String) -> Result<String, String> {
    inspect(vec![path.clone()])?;
    let bytes = std::fs::read(&path).map_err(|_| "Could not read sample file")?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("Samples must be nonempty files totaling at most 50 MB".into());
    }
    Ok(format!(
        "data:{};base64,{}",
        mime(Path::new(&path))?,
        STANDARD.encode(bytes)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn wav() -> Vec<u8> {
        let mut data = vec![0u8; 44 + 88200];
        data[0..4].copy_from_slice(b"RIFF");
        data[4..8].copy_from_slice(&88236u32.to_le_bytes());
        data[8..16].copy_from_slice(b"WAVEfmt ");
        data[16..20].copy_from_slice(&16u32.to_le_bytes());
        data[20..22].copy_from_slice(&1u16.to_le_bytes());
        data[22..24].copy_from_slice(&1u16.to_le_bytes());
        data[24..28].copy_from_slice(&44100u32.to_le_bytes());
        data[28..32].copy_from_slice(&88200u32.to_le_bytes());
        data[32..34].copy_from_slice(&2u16.to_le_bytes());
        data[34..36].copy_from_slice(&16u16.to_le_bytes());
        data[36..40].copy_from_slice(b"data");
        data[40..44].copy_from_slice(&88200u32.to_le_bytes());
        data
    }
    fn sized_wav(size: usize) -> Vec<u8> {
        let mut data = wav();
        data.resize(size, 0);
        for (i, byte) in data[44..].iter_mut().enumerate() {
            *byte = (i % 251) as u8;
        }
        data[4..8].copy_from_slice(&((size - 8) as u32).to_le_bytes());
        data[40..44].copy_from_slice(&((size - 44) as u32).to_le_bytes());
        data
    }
    #[test]
    fn long_recording_upload_is_lossless_and_each_part_fits() {
        for size in [
            MAX_UPLOAD_FILE_BYTES,
            MAX_UPLOAD_FILE_BYTES + 2,
            MAX_RECORDING_BYTES,
        ] {
            let original = sized_wav(size);
            let parts = upload_parts(original.clone(), "audio/wav").unwrap();
            assert_eq!(
                parts.len(),
                if size > MAX_UPLOAD_FILE_BYTES { 2 } else { 1 }
            );
            let mut restored = Vec::new();
            let mut duration = 0.0;
            for part in parts {
                assert!(part.len() <= MAX_UPLOAD_FILE_BYTES);
                assert_eq!(
                    u32::from_le_bytes(part[4..8].try_into().unwrap()) as usize,
                    part.len() - 8
                );
                duration += wav_duration(&part).unwrap();
                restored.extend_from_slice(&part[44..]);
            }
            assert_eq!(restored, original[44..]);
            assert!((duration - wav_duration(&original).unwrap()).abs() < 1.0 / 44100.0);
        }
    }
    #[test]
    fn oversized_import_rejected_before_upload_without_modifying_source() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("large.mp3");
        let bytes = vec![1; MAX_UPLOAD_FILE_BYTES + 1];
        std::fs::write(&path, &bytes).unwrap();
        assert_eq!(
            inspect(vec![path.to_string_lossy().into_owned()])
                .err()
                .unwrap(),
            LARGE_SAMPLE_ERROR
        );
        assert_eq!(std::fs::read(path).unwrap(), bytes);
        assert!(upload_parts(bytes, "audio/mpeg").is_err());
        let mut invalid = sized_wav(MAX_RECORDING_BYTES);
        invalid[22] = 2; // Unsupported stereo header cannot be sliced as mono.
        assert!(upload_parts(invalid, "audio/wav").is_err());
    }
    #[test]
    fn recording_roundtrip_and_safe_removal() {
        let dir = tempfile::tempdir().unwrap();
        let first = save(dir.path(), &STANDARD.encode(wav())).unwrap();
        let second = save(dir.path(), &STANDARD.encode(wav())).unwrap();
        assert_eq!(list(dir.path()).unwrap().len(), 2);
        assert_eq!(first.duration, Some(1.0));
        assert!(preview(first.path.clone())
            .unwrap()
            .starts_with("data:audio/wav;base64,"));
        assert!(remove(dir.path(), "../other").is_err());
        remove(dir.path(), first.id.as_ref().unwrap()).unwrap();
        assert_eq!(list(dir.path()).unwrap()[0].id, second.id);
        restore(dir.path(), first.id.as_ref().unwrap()).unwrap();
        assert_eq!(list(dir.path()).unwrap().len(), 2);
        assert!(restore(dir.path(), "../../outside").is_err());
    }
    #[test]
    fn rejects_malformed_and_over_limit_recordings() {
        let dir = tempfile::tempdir().unwrap();
        assert!(save(dir.path(), "broken").is_err());
        let mut wrong = wav();
        wrong[24] = 0;
        assert!(save(dir.path(), &STANDARD.encode(wrong)).is_err());
        for _ in 0..10 {
            save(dir.path(), &STANDARD.encode(wav())).unwrap();
        }
        assert!(save(dir.path(), &STANDARD.encode(wav())).is_ok());
        assert_eq!(list(dir.path()).unwrap().len(), 11);
    }
}
