# How Convo works

Convo is a local desktop application with two external generation stages: structured text planning/writing and expressive audio synthesis.

## Boundaries

| Layer | Responsibility |
|---|---|
| React editor | Scene, cast, script editing, voice library, recording controls, take playback, themes and translations |
| Tauri commands | Validated interface between the WebView and Rust |
| Rust domain + character planner | Project constraints, cast plans, schema-validated dialogue, delivery cues and bounded render parts |
| Text-provider adapter | Endpoint configuration, credential scoping, Responses / Chat Completions translation |
| ElevenLabs adapters | Voice library, Instant Voice Cloning, Voice Design, auditions, Text to Dialogue |
| Render jobs | Save progress and receipts, preserve completed parts, handle pause/cancel/recovery |
| Audio layer | Decode, assemble, apply recording treatments and pauses, cache previews, encode WAV/MP3 |
| SQLite + local files | Projects, revisions, plans, takes, recordings and audio assets |

## Character continuity

A character plan is bound to the scene, conversation language, speaker identities and backgrounds. Changing those inputs makes the plan stale. Changing only a voice or delivery setting does not rewrite a person's biography. Generated experiences carry supplied/fictional provenance, and factual-only characters may have no invented experiences.

Script generation receives that plan and the current scene. Save orchestration persists the plan before requesting dialogue so successful planning is retained if the next stage fails. Delivery cues are contextual rather than a fixed quota of tags.

## Rendering and playback

Long scripts are divided at turn boundaries within a 2,000-character request budget. Each completed audio part and its timing data is saved before proceeding. Interrupted requests are not automatically replayed when billing outcome is uncertain.

Audio takes preserve their source script and source audio. Preview/export applies local recording effects and additional pauses; it does not consume generation credits. A cached assembled preview avoids repeating expensive processing for unchanged inputs.

## Persistence and privacy

Projects use debounced, serialized autosave plus an immediate recovery draft. History restores create a new revision rather than deleting the past. Credentials live in a separate database and are never part of project revisions.

Provider networking stays in Rust. The renderer does not receive saved secrets. A text-provider key is retained only for the same normalized base URL; redirects are disabled. No automatic protocol fallback is attempted for billable requests.

## Current limits

Duration targets are approximate. Phone/room treatments are local effects, not a physical recording or a guarantee of realism. There is no cloud project sync, overlapping-speech timeline editor, or Professional Voice Clone workflow. Windows/Linux device behavior still requires validation beyond build checks.
