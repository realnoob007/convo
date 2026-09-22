import type { VoiceDraft } from "./types";
export const voiceDraftKey = "convo-voice-draft-v2";
export const emptyVoiceDraft = (): VoiceDraft => ({
  name: "",
  description: "",
  samples: [],
  updatedAt: 0,
});
export function parseVoiceDraft(value: unknown): VoiceDraft | null {
  if (!value || typeof value !== "object") return null;
  const d = value as VoiceDraft;
  if (
    typeof d.name !== "string" ||
    typeof d.description !== "string" ||
    !Number.isFinite(d.updatedAt) ||
    !Array.isArray(d.samples) ||
    d.samples.length > 10
  )
    return null;
  if (
    d.samples.some(
      (s) =>
        typeof s.path !== "string" ||
        typeof s.name !== "string" ||
        !Number.isFinite(s.bytes) ||
        s.bytes <= 0,
    )
  )
    return null;
  if (new Set(d.samples.map((s) => s.path)).size !== d.samples.length)
    return null;
  return d;
}
export function recoverVoiceDraft(local: unknown, saved: unknown): VoiceDraft {
  const a = parseVoiceDraft(local),
    b = parseVoiceDraft(saved);
  return a && (!b || a.updatedAt >= b.updatedAt) ? a : b || emptyVoiceDraft();
}
