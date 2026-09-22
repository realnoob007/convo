//! Local recording coloration. These are approximations, not measured device responses.
use crate::{
    audio::RATE,
    domain::{Recording, RecordingStyle},
};

// Parallel damped combs approximate a short room tail; no source recording is copied.
struct RoomTail {
    lines: Vec<Vec<f32>>,
    damping: [f32; 4],
    feedback: [f32; 4],
    cursor: usize,
}
impl RoomTail {
    fn new(distance: f32) -> Self {
        let lengths = [1319, 1637, 1811, 1999];
        let decay = 0.18 + distance * 0.32;
        Self {
            lines: lengths.iter().map(|n| vec![0.0; *n]).collect(),
            damping: [0.0; 4],
            feedback: lengths.map(|n| 10f32.powf(-3.0 * n as f32 / (RATE as f32 * decay))),
            cursor: 0,
        }
    }
    fn next(&mut self, input: f32) -> f32 {
        let mut wet = 0.0;
        for i in 0..4 {
            let index = self.cursor % self.lines[i].len();
            let delayed = self.lines[i][index];
            self.damping[i] += 0.28 * (delayed - self.damping[i]);
            self.lines[i][index] = input + self.damping[i] * self.feedback[i];
            wet += delayed * 0.25;
        }
        self.cursor += 1;
        wet
    }
}

pub fn process(samples: &mut [f32], settings: &Recording) -> Result<(), String> {
    if settings.ambience > 100
        || settings.distance.is_some_and(|d| d > 100)
        || samples.iter().any(|x| !x.is_finite())
    {
        return Err("Invalid performance or recording settings".into());
    }
    if samples.is_empty() || (settings.style == RecordingStyle::Clean && settings.ambience == 0) {
        return Ok(());
    }
    let rms = (samples.iter().map(|x| (*x as f64).powi(2)).sum::<f64>() / samples.len() as f64)
        .sqrt() as f32;
    let noise_gain = if settings.ambience == 0 {
        0.0
    } else {
        rms.clamp(0.01, 0.2) * 10f32.powf((-50.0 + settings.ambience as f32 * 0.3) / 20.0)
    };
    let distance = if settings.style == RecordingStyle::PhoneRoom {
        settings.distance.unwrap_or(0) as f32 / 100.0
    } else {
        0.0
    };
    let mut tail = RoomTail::new(distance);
    let (high, low) = match settings.style {
        RecordingStyle::Clean => (0.0, 0.0),
        RecordingStyle::PhoneRoom => (90.0 + distance * 100.0, 6200.0 - distance * 1800.0),
        RecordingStyle::PhoneCall => (300.0, 3400.0),
    };
    let hp = (-std::f32::consts::TAU * high / RATE as f32).exp();
    let lp = 1.0 - (-std::f32::consts::TAU * low / RATE as f32).exp();
    let mut previous = 0.0;
    let mut high_state = 0.0;
    let mut low_a = 0.0;
    let mut low_b = 0.0;
    let taps = [(838, 0.12), (1808, 0.07), (3043, 0.04)];
    let mut room = vec![0.0; 3044];
    let mut random = 0x6d2b79f5u32;
    let mut air = 0.0;
    for (i, sample) in samples.iter_mut().enumerate() {
        let mut x = *sample;
        if settings.style == RecordingStyle::PhoneRoom {
            let diffuse = if distance > 0.0 { tail.next(x) } else { 0.0 };
            room[i % 3044] = x;
            for (delay, gain) in taps {
                if i >= delay {
                    x += gain * room[(i - delay) % 3044];
                }
            }
            x /= 1.23;
            x = x * (1.0 - distance * 0.38) + diffuse * distance * 0.7;
        }
        if settings.style != RecordingStyle::Clean {
            high_state = hp * (high_state + x - previous);
            previous = x;
            low_a += lp * (high_state - low_a);
            low_b += lp * (low_a - low_b);
            x = low_b / (1.0 + 0.25 * low_b.abs());
        }
        // Continuous, deterministic low-level room tone, including during inserted pauses.
        random ^= random << 13;
        random ^= random >> 17;
        random ^= random << 5;
        let white = (random as f64 / u32::MAX as f64 * 2.0 - 1.0) as f32;
        air += 0.08 * (white - air);
        let noise = (air * 6.0 + white * 0.15) * noise_gain;
        let fade = (i as f32 / (RATE as f32 * 0.03)).min(1.0);
        *sample = (x + noise * fade).clamp(-0.97, 0.97);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn distance_adds_a_damped_tail_without_changing_duration_or_unbounded_feedback() {
        let mut near = vec![0.0; RATE as usize];
        near[100] = 0.7;
        let mut far = near.clone();
        process(
            &mut near,
            &Recording {
                style: RecordingStyle::PhoneRoom,
                ambience: 0,
                distance: Some(0),
            },
        )
        .unwrap();
        process(
            &mut far,
            &Recording {
                style: RecordingStyle::PhoneRoom,
                ambience: 0,
                distance: Some(100),
            },
        )
        .unwrap();
        assert_eq!(near.len(), far.len());
        assert!(energy(&far[5000..15000]) > energy(&near[5000..15000]) + 1e-10);
        assert!(energy(&far[35000..]) < energy(&far[5000..15000]));
        assert!(far.iter().all(|s| s.is_finite() && s.abs() < 0.97));
        assert!(process(
            &mut far,
            &Recording {
                style: RecordingStyle::PhoneRoom,
                ambience: 0,
                distance: Some(101)
            }
        )
        .is_err());
    }
    fn tone(hz: f32) -> Vec<f32> {
        (0..RATE)
            .map(|i| (i as f32 * std::f32::consts::TAU * hz / RATE as f32).sin() * 0.3)
            .collect()
    }
    fn energy(x: &[f32]) -> f32 {
        x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32
    }
    #[test]
    fn clean_is_exact_and_phone_filters_preserve_length() {
        let original = tone(8000.0);
        let mut clean = original.clone();
        process(
            &mut clean,
            &Recording {
                distance: None,
                style: RecordingStyle::Clean,
                ambience: 0,
            },
        )
        .unwrap();
        assert_eq!(clean, original);
        let mut call = original.clone();
        process(
            &mut call,
            &Recording {
                distance: None,
                style: RecordingStyle::PhoneCall,
                ambience: 0,
            },
        )
        .unwrap();
        assert_eq!(call.len(), original.len());
        assert!(energy(&call) < energy(&original) * 0.08);
    }
    #[test]
    fn room_tone_is_repeatable_continuous_and_bounded() {
        let settings = Recording {
            distance: None,
            style: RecordingStyle::PhoneRoom,
            ambience: 70,
        };
        let mut a = tone(500.0);
        a.extend(vec![0.0; RATE as usize]);
        let mut b = a.clone();
        process(&mut a, &settings).unwrap();
        process(&mut b, &settings).unwrap();
        assert_eq!(a, b);
        assert!(energy(&a[RATE as usize + 4000..]) > 1e-9);
        assert!(a.iter().all(|v| v.is_finite() && v.abs() <= 0.97));
        assert!(process(
            &mut a,
            &Recording {
                distance: None,
                style: RecordingStyle::Clean,
                ambience: 101
            }
        )
        .is_err());
    }
}
