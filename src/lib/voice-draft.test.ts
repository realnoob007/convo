import { expect, it } from "vitest";
import {
  emptyVoiceDraft,
  parseVoiceDraft,
  recoverVoiceDraft,
} from "./voice-draft";
it("recovers the latest selected-person draft without automatically selecting the library", () => {
  const saved = { ...emptyVoiceDraft(), name: "Old", updatedAt: 1 };
  const local = { ...emptyVoiceDraft(), name: "New", updatedAt: 2 };
  expect(recoverVoiceDraft(local, saved).name).toBe("New");
  expect(recoverVoiceDraft(null, saved).name).toBe("Old");
  expect(recoverVoiceDraft(null, null).samples).toEqual([]);
});
it("rejects corrupt samples and duplicate selections", () => {
  expect(parseVoiceDraft({ name: 3, samples: [] })).toBeNull();
  const sample = {
    path: "recording.wav",
    name: "A",
    bytes: 44,
    id: null,
    duration: 1,
  };
  expect(
    parseVoiceDraft({ ...emptyVoiceDraft(), samples: [sample, sample] }),
  ).toBeNull();
});
