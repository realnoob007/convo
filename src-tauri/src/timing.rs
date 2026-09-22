//! Local energy measurements, not speaker diarization or a naturalness score.
use crate::audio::RATE;
use serde::{Deserialize, Serialize};
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Timing {
    pub duration: f64,
    pub threshold_db: f64,
    pub quiet_fraction: f64,
    pub quiet_intervals: Vec<[f64; 2]>,
    pub median_quiet_ms: f64,
    pub p90_quiet_ms: f64,
    pub peak: f32,
    pub clipped_fraction: f64,
}
pub fn analyze(pcm: &[f32]) -> Result<Timing, String> {
    if pcm.is_empty() || pcm.iter().any(|s| !s.is_finite()) {
        return Err("Audio sample is empty or invalid".into());
    }
    let frame = RATE as usize / 100;
    let rms: Vec<f64> = pcm
        .chunks(frame)
        .map(|c| {
            20.0 * ((c.iter().map(|x| (*x as f64).powi(2)).sum::<f64>() / c.len() as f64)
                .sqrt()
                .max(1e-8))
            .log10()
        })
        .collect();
    let mut sorted = rms.clone();
    sorted.sort_by(f64::total_cmp);
    let threshold_db = (sorted[sorted.len() / 10] + 10.0).clamp(-50.0, -30.0);
    let mut quiet_intervals = Vec::new();
    let mut start = None;
    for i in 0..=rms.len() {
        let quiet = i < rms.len() && rms[i] < threshold_db;
        if quiet && start.is_none() {
            start = Some(i);
        }
        if !quiet {
            if let Some(a) = start.take() {
                if i - a >= 18 {
                    quiet_intervals.push([
                        a as f64 * 0.01,
                        (i as f64 * 0.01).min(pcm.len() as f64 / RATE as f64),
                    ]);
                }
            }
        }
    }
    let mut lengths: Vec<f64> = quiet_intervals
        .iter()
        .map(|p| (p[1] - p[0]) * 1000.0)
        .collect();
    lengths.sort_by(f64::total_cmp);
    let quantile = |q: f64| {
        if lengths.is_empty() {
            0.0
        } else {
            lengths[((lengths.len() - 1) as f64 * q).round() as usize]
        }
    };
    Ok(Timing {
        duration: pcm.len() as f64 / RATE as f64,
        threshold_db,
        quiet_fraction: rms.iter().filter(|v| **v < threshold_db).count() as f64 / rms.len() as f64,
        median_quiet_ms: quantile(0.5),
        p90_quiet_ms: quantile(0.9),
        quiet_intervals,
        peak: pcm.iter().map(|s| s.abs()).fold(0.0, f32::max),
        clipped_fraction: pcm.iter().filter(|s| s.abs() >= 0.999).count() as f64 / pcm.len() as f64,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reports_known_pause_without_calling_it_a_speaker_gap() {
        let mut pcm = vec![0.2; RATE as usize];
        pcm.extend(vec![0.0; RATE as usize / 2]);
        pcm.extend(vec![0.2; RATE as usize]);
        let a = analyze(&pcm).unwrap();
        assert_eq!(a.quiet_intervals, vec![[1.0, 1.5]]);
        assert_eq!(a.median_quiet_ms, 500.0);
        assert!((a.duration - 2.5).abs() < 0.001);
    }
    #[test]
    fn rejects_invalid_audio_and_ignores_tiny_gaps() {
        assert!(analyze(&[]).is_err());
        assert!(analyze(&[f32::NAN]).is_err());
        let mut pcm = vec![0.2; 44100];
        pcm[1000..2000].fill(0.0);
        assert!(analyze(&pcm).unwrap().quiet_intervals.is_empty());
    }
}
