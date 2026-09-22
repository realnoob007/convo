import type { TextConnection } from "@/components/text-connection";
import type { DesignRequest, DesignState, DesignBatch } from "./voice-design";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import type {
  Project,
  CharacterPlan,
  Revision,
  Voice,
  Take,
  Turn,
  KeyStatus,
  VoiceSample,
  VoiceDraft,
  PreparedAudio,
  AudioTiming,
  Recording,
} from "./types";
export const desktop = isTauri();
const previewKey = "convo-preview-v1";
interface Preview {
  projects: Project[];
  revisions: Revision[];
}
function readPreview(): Preview {
  const raw = localStorage.getItem(previewKey);
  return raw ? JSON.parse(raw) : { projects: [], revisions: [] };
}
function previewSave(project: Project, reason: string) {
  const data = readPreview(),
    previous = data.projects.find((p) => p.id === project.id);
  if (JSON.stringify(previous) === JSON.stringify(project)) return;
  data.projects = [
    project,
    ...data.projects.filter((p) => p.id !== project.id),
  ];
  data.revisions.unshift({
    id: Date.now(),
    createdAt: new Date().toISOString(),
    reason,
    project,
  });
  localStorage.setItem(previewKey, JSON.stringify(data));
}
function native<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!desktop)
    return Promise.reject(
      new Error(
        "Open the desktop app to use provider APIs. Browser preview supports editing and local history.",
      ),
    );
  return invoke<T>(command, args);
}
export const api = {
  textConnection: (): Promise<TextConnection> => native("text_connection"),
  saveTextConnection: (
    config: TextConnection["config"],
    key: string,
  ): Promise<TextConnection> => native("save_text_connection", { config, key }),
  designState: (): Promise<DesignState> =>
    desktop
      ? invoke("voice_design_state")
      : Promise.resolve({ batch: null, attempt: null }),
  designVoice: (request: DesignRequest): Promise<DesignBatch> =>
    native("design_voice", { request }),
  saveDesignedVoice: (generatedId: string, name: string): Promise<Voice> =>
    native("save_designed_voice", { generatedId, name }),
  acknowledgeDesignRetry: (): Promise<void> =>
    native("acknowledge_design_retry"),
  analyzeReference: (
    path: string,
  ): Promise<{ name: string; src: string; timing: AudioTiming }> =>
    native("analyze_reference", { path }),
  voiceDraft: (): Promise<VoiceDraft | null> =>
    desktop ? invoke("get_voice_draft") : Promise.resolve(null),
  saveVoiceDraft: (draft: VoiceDraft): Promise<void> =>
    desktop ? invoke("save_voice_draft", { draft }) : Promise.resolve(),
  cloneStatus: (): Promise<{ state?: string; name?: string }> =>
    desktop
      ? (invoke("clone_status").then((value) => value || {}) as Promise<{
          state?: string;
          name?: string;
        }>)
      : Promise.resolve({}),
  acknowledgeCloneRetry: (): Promise<void> => native("acknowledge_clone_retry"),
  cancelVoiceCreation: (): Promise<void> => native("cancel_voice_creation"),
  restoreRecording: (id: string): Promise<void> =>
    native("restore_recording", { id }),
  sampleQuality: (
    path: string,
  ): Promise<{ duration: number; clipped: number; silent: number }> =>
    native("sample_quality", { path }),
  audition: (
    voiceId: string,
    text: string,
  ): Promise<{ src: string; metadata: { voiceId: string; model: string } }> =>
    native("audition_voice", { voiceId, text }),
  resume: (takeId: string, acknowledgeCharge: boolean): Promise<Take> =>
    native("resume_render", { takeId, acknowledgeCharge }),
  controlRender: (takeId: string, action: "pause" | "cancel"): Promise<void> =>
    native("control_render", { takeId, action }),
  prepareTake: (
    takeId: string,
    recording?: Recording,
    pauses?: Record<string, number>,
  ): Promise<PreparedAudio> =>
    native<PreparedAudio>("prepare_take", { takeId, recording, pauses }).then(
      (audio) => ({ ...audio, src: convertFileSrc(audio.src) }),
    ),
  exportTake: (
    takeId: string,
    path: string,
    recording?: Recording,
    pauses?: Record<string, number>,
  ): Promise<void> =>
    native("export_take", { takeId, path, recording, pauses }),
  projects: (): Promise<Project[]> =>
    desktop ? invoke("list_projects") : Promise.resolve(readPreview().projects),
  save: (project: Project, reason = "Autosave"): Promise<void> =>
    desktop
      ? invoke("save_project", { project, reason })
      : Promise.resolve().then(() => previewSave(project, reason)),
  revisions: (projectId: string): Promise<Revision[]> =>
    desktop
      ? invoke("list_revisions", { projectId })
      : Promise.resolve(
          readPreview().revisions.filter((r) => r.project.id === projectId),
        ),
  voices: (): Promise<Voice[]> =>
    desktop ? invoke("local_voices") : Promise.resolve([]),
  refreshVoices: (): Promise<Voice[]> => native("refresh_voices"),
  createVoice: (
    name: string,
    description: string,
    paths: string[],
    consent: boolean,
  ): Promise<Voice> =>
    native("create_voice", { name, description, paths, consent }),
  recordingTrash: (): Promise<VoiceSample[]> =>
    desktop ? invoke("recording_trash") : Promise.resolve([]),
  recordings: (): Promise<VoiceSample[]> =>
    desktop ? invoke("list_recordings") : Promise.resolve([]),
  saveRecording: (audio: string): Promise<VoiceSample> =>
    native("save_recording", { audio }),
  removeRecording: (id: string): Promise<void> =>
    native("remove_recording", { id }),
  inspectSamples: (paths: string[]): Promise<VoiceSample[]> =>
    native("inspect_samples", { paths }),
  previewSample: (path: string): Promise<string> =>
    native("preview_sample", { path }),
  keyStatus: (): Promise<KeyStatus> =>
    desktop
      ? invoke("key_status")
      : Promise.resolve({ openai: false, elevenlabs: false }),
  saveKey: (provider: string, key: string): Promise<void> =>
    native("save_key", { provider, key }),
  developCharacters: (project: Project): Promise<CharacterPlan> =>
    native("develop_characters", { project }),
  script: (project: Project): Promise<Turn[]> =>
    native("generate_script", { project }),
  render: (project: Project): Promise<Take> =>
    native("render_audio", { project }),
  takes: (projectId: string): Promise<Take[]> =>
    desktop ? invoke("list_takes", { projectId }) : Promise.resolve([]),
  audio: (chunkId: string): Promise<string> =>
    native("read_audio", { chunkId }),
  exportAudio: (chunkId: string, path: string): Promise<void> =>
    native("export_audio", { chunkId, path }),
};
