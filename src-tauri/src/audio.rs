use crate::{domain::Take, jobs::atomic_write};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{io::Cursor, path::Path};
use symphonia::core::{
    audio::SampleBuffer, codecs::DecoderOptions, errors::Error, formats::FormatOptions,
    io::MediaSourceStream, meta::MetadataOptions, probe::Hint,
};
pub const RATE: u32 = 44100;
const MAX_FRAMES: usize = RATE as usize * 1800;

pub fn decode(bytes: &[u8], extension: &str) -> Result<Vec<f32>, String> {
    let stream = MediaSourceStream::new(Box::new(Cursor::new(bytes.to_vec())), Default::default());
    let mut hint = Hint::new();
    hint.with_extension(extension);
    let mut format = symphonia::default::get_probe()
        .format(
            &hint,
            stream,
            &FormatOptions {
                enable_gapless: true,
                ..Default::default()
            },
            &MetadataOptions::default(),
        )
        .map_err(|_| "Could not decode audio sample")?
        .format;
    let track = format
        .default_track()
        .ok_or("Audio has no playable track")?;
    let id = track.id;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|_| "Unsupported audio codec")?;
    let mut output = Vec::new();
    let mut rate = 0;
    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(Error::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(_) => return Err("Audio file is damaged or incomplete".into()),
        };
        if packet.track_id() != id {
            continue;
        }
        let decoded = decoder
            .decode(&packet)
            .map_err(|_| "Audio file is damaged or incomplete")?;
        if rate != 0 && rate != decoded.spec().rate {
            return Err("Audio sample rate changed inside file".into());
        }
        rate = decoded.spec().rate;
        let channels = decoded.spec().channels.count();
        let mut samples = SampleBuffer::<f32>::new(decoded.capacity() as u64, *decoded.spec());
        samples.copy_interleaved_ref(decoded);
        output.extend(
            samples
                .samples()
                .chunks(channels)
                .map(|frame| frame.iter().sum::<f32>() / channels as f32),
        );
        if rate == 0 || output.len() > rate as usize * 1800 {
            return Err("Audio exceeds the 30-minute limit".into());
        }
    }
    if output.is_empty() || output.iter().any(|s| !s.is_finite()) {
        return Err("Audio sample is empty or invalid".into());
    }
    if rate == RATE {
        return Ok(output);
    }
    // Imported samples are downmixed/resampled for analysis; originals remain unchanged.
    let frames = (output.len() as u64 * RATE as u64 / rate as u64) as usize;
    Ok((0..frames)
        .map(|i| {
            let pos = i as f64 * rate as f64 / RATE as f64;
            let a = pos as usize;
            let b = (a + 1).min(output.len() - 1);
            output[a] + (output[b] - output[a]) * (pos - a as f64) as f32
        })
        .collect())
}
pub fn wav(samples: &[f32]) -> Vec<u8> {
    let size = samples.len() as u32 * 2;
    let mut out = Vec::with_capacity(44 + size as usize);
    out.extend(b"RIFF");
    out.extend((36 + size).to_le_bytes());
    out.extend(b"WAVEfmt ");
    out.extend(16u32.to_le_bytes());
    out.extend(1u16.to_le_bytes());
    out.extend(1u16.to_le_bytes());
    out.extend(RATE.to_le_bytes());
    out.extend((RATE * 2).to_le_bytes());
    out.extend(2u16.to_le_bytes());
    out.extend(16u16.to_le_bytes());
    out.extend(b"data");
    out.extend(size.to_le_bytes());
    for sample in samples {
        out.extend(((sample.clamp(-1.0, 1.0) * 32767.0).round() as i16).to_le_bytes());
    }
    out
}
pub fn mp3(samples: &[f32]) -> Result<Vec<u8>, String> {
    use mp3lame_encoder::{Bitrate, Builder, FlushGap, MonoPcm, Quality};
    let mut builder = Builder::new().ok_or("Could not initialize MP3 encoder")?;
    builder
        .set_num_channels(1)
        .map_err(|e| format!("MP3 configuration: {e:?}"))?;
    builder
        .set_sample_rate(RATE)
        .map_err(|e| format!("MP3 configuration: {e:?}"))?;
    builder
        .set_brate(Bitrate::Kbps128)
        .map_err(|e| format!("MP3 configuration: {e:?}"))?;
    builder
        .set_quality(Quality::Best)
        .map_err(|e| format!("MP3 configuration: {e:?}"))?;
    let mut encoder = builder
        .build()
        .map_err(|e| format!("MP3 configuration: {e:?}"))?;
    let mut output = Vec::new();
    for block in samples.chunks(44100) {
        let pcm: Vec<i16> = block
            .iter()
            .map(|v| (v.clamp(-1.0, 1.0) * 32767.0) as i16)
            .collect();
        output.reserve(mp3lame_encoder::max_required_buffer_size(pcm.len()));
        encoder
            .encode_to_vec(MonoPcm(&pcm), &mut output)
            .map_err(|_| "MP3 encoding failed")?;
    }
    output.reserve(7200);
    encoder
        .flush_to_vec::<FlushGap>(&mut output)
        .map_err(|_| "MP3 finalization failed")?;
    // Replace the reserved first frame with final duration/delay metadata for gapless playback.
    let mut tag = Vec::with_capacity(encoder.lame_tag_size());
    if let Some(size) = encoder.lame_tag_encode_to_vec(&mut tag) {
        let start = encoder.id3v2_tag_size();
        if start + size.get() > output.len() {
            return Err("Invalid MP3 timing metadata".into());
        }
        output[start..start + size.get()].copy_from_slice(&tag);
    }
    Ok(output)
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cue {
    pub turn: usize,
    pub start: f64,
    pub end: f64,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Prepared {
    pub src: String,
    pub duration: f64,
    pub cues: Vec<Cue>,
    pub partial: bool,
    pub timing: crate::timing::Timing,
}

// Cache the rendered preview, not the provider's original audio. Bump this version
// whenever the assembly or effects algorithm changes.
pub fn prepare_cached(take: &Take, root: &Path) -> Result<Prepared, String> {
    let mut hash = Sha256::new();
    hash.update(b"convo-preview-v1");
    hash.update(serde_json::to_vec(take).map_err(|_| "Invalid take")?);
    for chunk in &take.chunks {
        uuid::Uuid::parse_str(&chunk.id).map_err(|_| "Invalid audio identifier")?;
        let metadata = std::fs::metadata(root.join(format!("{}.mp3", chunk.id)))
            .map_err(|_| "Saved audio is unavailable")?;
        hash.update(metadata.len().to_le_bytes());
        let modified = metadata
            .modified()
            .map_err(|_| "Could not inspect saved audio")?
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default();
        hash.update(modified.as_nanos().to_le_bytes());
    }
    let key = hash
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let cache = root.join("previews");
    std::fs::create_dir_all(&cache).map_err(|_| "Could not create audio preview cache")?;
    let path = cache.join(format!("{key}.wav"));
    let manifest = cache.join(format!("{key}.json"));
    if let Ok(bytes) = std::fs::read(&manifest) {
        if let Ok(mut prepared) = serde_json::from_slice::<Prepared>(&bytes) {
            let expected = 44.0 + (prepared.duration * RATE as f64).round() * 2.0;
            if prepared.duration.is_finite()
                && prepared.duration > 0.0
                && prepared.duration <= 1800.0
                && std::fs::metadata(&path).is_ok_and(|m| m.is_file() && m.len() as f64 == expected)
            {
                prepared.src = path.to_string_lossy().into_owned();
                return Ok(prepared);
            }
        }
    }
    let (samples, cues) = assemble(take, root)?;
    let prepared = Prepared {
        src: path.to_string_lossy().into_owned(),
        duration: samples.len() as f64 / RATE as f64,
        cues,
        partial: take.status != "complete",
        timing: crate::timing::analyze(&samples)?,
    };
    atomic_write(&path, &wav(&samples))?;
    atomic_write(
        &manifest,
        &serde_json::to_vec(&prepared).map_err(|_| "Could not save audio preview")?,
    )?;
    Ok(prepared)
}
pub fn preview_settings(
    take: &mut Take,
    recording: Option<crate::domain::Recording>,
    pauses: Option<std::collections::HashMap<String, u32>>,
) -> Result<(), String> {
    if let Some(recording) = recording {
        take.script
            .performance
            .get_or_insert_with(Default::default)
            .recording = Some(recording);
    }
    if let Some(pauses) = pauses {
        for (id, ms) in pauses {
            if ms > 5000 {
                return Err("Additional pauses must be between 0 and 5000 ms".into());
            }
            let turn = take
                .script
                .turns
                .iter_mut()
                .find(|t| t.id == id)
                .ok_or("Unknown turn in pause settings")?;
            turn.pause_after_ms = Some(ms);
        }
    }
    crate::domain::validate_project(&take.script)
}
pub fn assemble(take: &Take, root: &Path) -> Result<(Vec<f32>, Vec<Cue>), String> {
    let mut chunks = take.chunks.clone();
    chunks.sort_by_key(|c| c.index);
    if take.status == "complete"
        && (chunks.iter().enumerate().any(|(i, c)| i != c.index)
            || chunks.iter().map(|c| c.turn_count).sum::<usize>() != take.script.turns.len())
    {
        return Err("Complete take has missing audio parts".into());
    }
    let mut samples = Vec::new();
    let mut cues = Vec::new();
    for (expected, chunk) in chunks.iter().enumerate() {
        // Only a continuous prefix is playable. Never hide a missing middle part.
        if expected != chunk.index {
            break;
        }
        uuid::Uuid::parse_str(&chunk.id).map_err(|_| "Invalid audio identifier")?;
        let bytes = std::fs::read(root.join(format!("{}.mp3", chunk.id)))
            .map_err(|_| "Saved audio is unavailable")?;
        let mut pcm = decode(&bytes, "mp3")?;
        let offset = samples.len() as f64 / RATE as f64;
        let duration = pcm.len() as f64 / RATE as f64;
        let cue_start = cues.len();
        if let Some(segments) = chunk.alignment["voice_segments"].as_array() {
            for segment in segments {
                if let (Some(local), Some(start), Some(end)) = (
                    segment["dialogue_input_index"].as_u64(),
                    segment["start_time_seconds"].as_f64(),
                    segment["end_time_seconds"].as_f64(),
                ) {
                    if local < chunk.turn_count as u64
                        && start.is_finite()
                        && end.is_finite()
                        && end >= start
                    {
                        cues.push(Cue {
                            turn: chunk.first_turn + local as usize,
                            start: offset + start.clamp(0.0, duration),
                            end: offset + end.clamp(0.0, duration),
                        });
                    }
                }
            }
        }
        // Add explicit pauses at provider turn boundaries without trimming source audio.
        let local_cues = &mut cues[cue_start..];
        let mut insertions = Vec::new();
        for local in 0..chunk.turn_count {
            let turn = chunk.first_turn + local;
            let ms = take
                .script
                .turns
                .get(turn)
                .and_then(|t| t.pause_after_ms)
                .unwrap_or(0);
            if ms == 0 {
                continue;
            }
            if ms > 5000 {
                return Err("Additional pauses must be between 0 and 5000 ms".into());
            }
            let matches: Vec<_> = local_cues.iter().filter(|c| c.turn == turn).collect();
            if matches.len() != 1 {
                return Err("Cannot place pause: missing or ambiguous speaker timing".into());
            }
            let boundary = ((matches[0].end - offset) * RATE as f64).round() as usize;
            if local_cues.iter().any(|c| {
                c.turn != turn && c.start < matches[0].end - 0.001 && c.end > matches[0].end + 0.001
            }) {
                return Err("Cannot place pause inside overlapping speech".into());
            }
            insertions.push((boundary.min(pcm.len()), ms as usize * RATE as usize / 1000));
        }
        insertions.sort_by_key(|x| x.0);
        let extra: usize = insertions.iter().map(|x| x.1).sum();
        if samples.len() + pcm.len() + extra > MAX_FRAMES {
            return Err("Audio exceeds the 30-minute limit".into());
        }
        if !insertions.is_empty() {
            for cue in local_cues {
                let start = ((cue.start - offset) * RATE as f64).round() as usize;
                let end = ((cue.end - offset) * RATE as f64).round() as usize;
                cue.start += insertions
                    .iter()
                    .filter(|x| x.0 <= start)
                    .map(|x| x.1)
                    .sum::<usize>() as f64
                    / RATE as f64;
                cue.end += insertions
                    .iter()
                    .filter(|x| x.0 < end)
                    .map(|x| x.1)
                    .sum::<usize>() as f64
                    / RATE as f64;
            }
            let mut padded = Vec::with_capacity(pcm.len() + extra);
            let mut cursor = 0;
            for (boundary, count) in insertions {
                padded.extend_from_slice(&pcm[cursor..boundary]);
                padded.resize(padded.len() + count, 0.0);
                cursor = boundary;
            }
            padded.extend_from_slice(&pcm[cursor..]);
            pcm = padded;
        }
        if samples.len() + pcm.len() > MAX_FRAMES {
            return Err("Audio exceeds the 30-minute limit".into());
        }
        samples.extend(pcm);
    }
    if samples.is_empty() {
        return Err("No completed audio to play".into());
    }
    if let Some(settings) = take
        .script
        .performance
        .as_ref()
        .and_then(|p| p.recording.as_ref())
    {
        crate::sound::process(&mut samples, settings)?;
    }
    Ok((samples, cues))
}
pub fn export(take: &Take, root: &Path, destination: &Path) -> Result<(), String> {
    if take.status != "complete" {
        return Err("Finish this take before exporting the complete conversation".into());
    }
    if destination.parent().and_then(|p| p.canonicalize().ok()) == root.canonicalize().ok() {
        return Err("Choose a destination outside the app's audio storage".into());
    }
    let extension = destination
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !["wav", "mp3"].contains(&extension.as_str()) {
        return Err("Choose a WAV or MP3 file".into());
    }
    let (samples, _) = assemble(take, root)?;
    let bytes = if extension == "wav" {
        wav(&samples)
    } else {
        mp3(&samples)?
    };
    atomic_write(destination, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::*;
    pub fn tone(seconds: f64, frequency: f32) -> Vec<f32> {
        (0..(seconds * RATE as f64) as usize)
            .map(|i| (i as f32 * std::f32::consts::TAU * frequency / RATE as f32).sin() * 0.25)
            .collect()
    }
    #[test]
    fn mp3_gapless_roundtrip_and_wave_duration() {
        let pcm = tone(1.0, 440.0);
        let bytes = mp3(&pcm).unwrap();
        let decoded = decode(&bytes, "mp3").unwrap();
        assert_eq!(
            decoded.len(),
            pcm.len(),
            "LAME delay and padding must be removed"
        );
        let wave = wav(&pcm);
        assert_eq!(decode(&wave, "wav").unwrap().len(), RATE as usize);
        assert!(decode(b"broken", "mp3").is_err());
    }
    #[test]
    fn fifteen_minute_local_mix_exports_without_timing_drift() {
        let dir = tempfile::tempdir().unwrap();
        let part = mp3(&tone(10.0, 440.0)).unwrap();
        let mut turns = Vec::new();
        let mut chunks = Vec::new();
        for index in 0..90 {
            let id = uuid::Uuid::new_v4().to_string();
            std::fs::write(dir.path().join(format!("{id}.mp3")), &part).unwrap();
            turns.push(Turn {
                id: index.to_string(),
                speaker_id: "a".into(),
                text: "Synthetic duration test".into(),
                direction: String::new(),
                pause_after_ms: None,
            });
            chunks.push(AudioChunk { id, index, first_turn:index, turn_count:1, alignment:serde_json::json!({"voice_segments":[{"dialogue_input_index":0,"start_time_seconds":0,"end_time_seconds":10}]}) });
        }
        let project = Project {
            character_plan: None,
            id: uuid::Uuid::new_v4().to_string(),
            title: "Duration test".into(),
            brief: String::new(),
            language: "en".into(),
            model: "test".into(),
            speakers: vec![Speaker {
                id: "a".into(),
                name: "A".into(),
                personality: String::new(),
                voice_id: "v".into(),
            }],
            turns,
            performance: Some(Performance {
                recording: Some(Recording {
                    distance: None,
                    style: RecordingStyle::PhoneRoom,
                    ambience: 35,
                }),
                ..Default::default()
            }),
        };
        let take = Take {
            id: uuid::Uuid::new_v4().to_string(),
            project_id: project.id.clone(),
            created_at: "now".into(),
            status: "complete".into(),
            script: project,
            chunks,
            error: None,
            plan: vec![],
            audio_model: audio_model(),
        };
        let (pcm, cues) = assemble(&take, dir.path()).unwrap();
        assert_eq!(pcm.len(), RATE as usize * 900);
        assert_eq!(cues.last().unwrap().start, 890.0);
        assert_eq!(cues.last().unwrap().end, 900.0);
        assert!(pcm.iter().all(|s| s.is_finite() && s.abs() <= 0.97));
        let encoded = mp3(&pcm).unwrap();
        assert_eq!(decode(&encoded, "mp3").unwrap().len(), pcm.len());
        assert_eq!(wav(&pcm).len(), 44 + pcm.len() * 2);
        let mut preview = take.clone();
        preview_settings(&mut preview, None, Some([(String::from("0"), 700)].into())).unwrap();
        assert_eq!(preview.script.turns[0].pause_after_ms, Some(700));
        assert_eq!(take.script.turns[0].pause_after_ms, None);
        assert!(preview_settings(
            &mut preview,
            None,
            Some([(String::from("missing"), 700)].into())
        )
        .is_err());
    }
    #[test]
    fn three_part_export_preserves_order_cues_and_source_files() {
        let dir = tempfile::tempdir().unwrap();
        let speaker = Speaker {
            id: "s".into(),
            name: "Test".into(),
            personality: String::new(),
            voice_id: "voice".into(),
        };
        let mut take = Take {
            id: uuid::Uuid::new_v4().to_string(),
            project_id: uuid::Uuid::new_v4().to_string(),
            created_at: "now".into(),
            status: "complete".into(),
            script: Project {
                character_plan: None,
                performance: None,
                id: uuid::Uuid::new_v4().to_string(),
                title: "Audio test".into(),
                brief: String::new(),
                language: "en".into(),
                model: "test".into(),
                speakers: vec![speaker],
                turns: vec![],
            },
            chunks: vec![],
            error: None,
            plan: vec![],
            audio_model: audio_model(),
        };
        for i in 0..3 {
            let id = uuid::Uuid::new_v4().to_string();
            take.script.turns.push(Turn {
                pause_after_ms: None,
                id: i.to_string(),
                speaker_id: "s".into(),
                text: format!("Part {i}"),
                direction: String::new(),
            });
            std::fs::write(
                dir.path().join(format!("{id}.mp3")),
                mp3(&tone(0.5, 220.0 * (i + 1) as f32)).unwrap(),
            )
            .unwrap();
            take.chunks.push(AudioChunk{id,index:i,first_turn:i,turn_count:1,alignment:serde_json::json!({"voice_segments":[{"dialogue_input_index":0,"start_time_seconds":0.0,"end_time_seconds":0.5}]})});
        }
        let (pcm, cues) = assemble(&take, dir.path()).unwrap();
        assert_eq!(pcm.len(), 66150);
        assert_eq!(
            cues.iter().map(|c| c.start).collect::<Vec<_>>(),
            vec![0.0, 0.5, 1.0]
        );
        let exports = dir.path().join("exports");
        std::fs::create_dir(&exports).unwrap();
        for ext in ["wav", "mp3"] {
            let destination = exports.join(format!("complete.{ext}"));
            export(&take, dir.path(), &destination).unwrap();
            let decoded = decode(&std::fs::read(&destination).unwrap(), ext).unwrap();
            assert_eq!(decoded.len(), pcm.len());
            // Crossing counts independently detect swapped or missing tone segments.
            for i in 0..3 {
                let segment = &decoded[i * 22050 + 1000..(i + 1) * 22050 - 1000];
                let crossings = segment
                    .windows(2)
                    .filter(|v| v[0] < 0.0 && v[1] >= 0.0)
                    .count();
                assert!((crossings as f32 - 100.0 * (i + 1) as f32).abs() < 5.0);
            }
        }
        assert!(export(&take, dir.path(), &dir.path().join("missing/out.wav")).is_err());
        assert!(take
            .chunks
            .iter()
            .all(|c| dir.path().join(format!("{}.mp3", c.id)).exists()));
        let original_files: Vec<_> = take
            .chunks
            .iter()
            .map(|c| std::fs::read(dir.path().join(format!("{}.mp3", c.id))).unwrap())
            .collect();
        // A warm preview reads only metadata, preserving the cached file and cues.
        let preview = prepare_cached(&take, dir.path()).unwrap();
        assert_eq!(std::fs::read(&preview.src).unwrap(), wav(&pcm));
        let old_time = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1000);
        std::fs::File::open(&preview.src)
            .unwrap()
            .set_modified(old_time)
            .unwrap();
        let warm = prepare_cached(&take, dir.path()).unwrap();
        assert_eq!(warm.src, preview.src);
        assert_eq!(warm.cues[2].start, 1.0);
        assert_eq!(
            std::fs::metadata(&warm.src).unwrap().modified().unwrap(),
            old_time
        );
        // Incomplete cache writes must be repaired, never returned as playable.
        std::fs::write(&preview.src, b"truncated").unwrap();
        let repaired = prepare_cached(&take, dir.path()).unwrap();
        assert_eq!(std::fs::read(&repaired.src).unwrap(), wav(&pcm));
        let mut colored = take.clone();
        colored.script.performance = Some(Performance {
            recording: Some(Recording {
                style: RecordingStyle::PhoneRoom,
                ambience: 10,
                distance: Some(40),
            }),
            ..Default::default()
        });
        assert_ne!(
            prepare_cached(&colored, dir.path()).unwrap().src,
            preview.src
        );
        let mut partial = take.clone();
        partial.status = "paused".into();
        partial.chunks.truncate(1);
        let partial_preview = prepare_cached(&partial, dir.path()).unwrap();
        assert!(partial_preview.partial);
        assert_eq!(partial_preview.duration, 0.5);
        assert_ne!(partial_preview.src, preview.src);
        let mut paused = take.clone();
        paused.script.turns[0].pause_after_ms = Some(200);
        paused.script.turns[1].pause_after_ms = Some(700);
        let pause_preview = prepare_cached(&paused, dir.path()).unwrap();
        assert_ne!(pause_preview.src, preview.src);
        assert!((pause_preview.duration - 2.4).abs() < 1e-9);
        let (padded, shifted) = assemble(&paused, dir.path()).unwrap();
        assert_eq!(padded.len(), pcm.len() + (RATE as usize * 9 / 10));
        assert_eq!(&padded[..22050], &pcm[..22050]);
        assert!(padded[22050..30870].iter().all(|s| *s == 0.0));
        assert_eq!(&padded[30870..52920], &pcm[22050..44100]);
        assert!((shifted[1].start - 0.7).abs() < 1e-9);
        assert!((shifted[1].end - 1.2).abs() < 1e-9);
        assert!((shifted[2].start - 1.9).abs() < 1e-9);
        for (chunk, original) in paused.chunks.iter().zip(original_files) {
            assert_eq!(
                std::fs::read(dir.path().join(format!("{}.mp3", chunk.id))).unwrap(),
                original
            );
        }
        paused.chunks[0].alignment = serde_json::json!({});
        assert!(assemble(&paused, dir.path())
            .unwrap_err()
            .contains("missing or ambiguous"));
        // Two turns inside one provider part must shift later cues by the inserted silence.
        paused.chunks.truncate(2);
        paused.chunks[0].turn_count = 2;
        paused.chunks[1].first_turn = 2;
        paused.chunks[0].alignment = serde_json::json!({"voice_segments":[
            {"dialogue_input_index":0,"start_time_seconds":0.0,"end_time_seconds":0.25},
            {"dialogue_input_index":1,"start_time_seconds":0.25,"end_time_seconds":0.5}]});
        let (padded, shifted) = assemble(&paused, dir.path()).unwrap();
        assert_eq!(padded.len(), RATE as usize * 19 / 10);
        assert!((shifted[1].start - 0.45).abs() < 1e-9);
        assert!((shifted[1].end - 0.7).abs() < 1e-9);
        assert!((shifted[2].start - 1.4).abs() < 1e-9);
        paused.chunks[0].alignment["voice_segments"][1]["start_time_seconds"] =
            serde_json::json!(0.2);
        assert!(assemble(&paused, dir.path())
            .unwrap_err()
            .contains("overlapping"));
        take.chunks.remove(1);
        assert!(export(&take, dir.path(), &dir.path().join("bad.wav")).is_err());
    }
}
