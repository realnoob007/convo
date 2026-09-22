import { describe, it, expect } from "vitest";
import { defaultPerformance, newProject } from "./project";
import { SaveQueue } from "./save-queue";
describe("conversation performance settings", () => {
  it("keeps generic settings across save snapshots", async () => {
    const p = newProject();
    p.brief = "Two colleagues disagree about a design, then find a compromise.";
    p.performance!.seed = 123;
    p.performance!.recording = { style: "phoneRoom", ambience: 35 };
    p.performance!.pacing = "measured";
    p.performance!.expression = "expressive";
    p.turns[0] = {
      id: "test-line",
      speakerId: p.speakers[0].id,
      text: "Well, let me think.",
      direction: "",
      pauseAfterMs: 700,
    };
    const saved: (typeof p)[] = [];
    const q = new SaveQueue(async (p) => {
      saved.push(p);
    });
    const done = q.save(p);
    p.performance!.seed = 999;
    p.performance!.recording.ambience = 80;
    p.turns[0].pauseAfterMs = 0;
    await done;
    expect(saved[0].performance?.seed).toBe(123);
    expect(saved[0].performance?.recording).toEqual({
      style: "phoneRoom",
      ambience: 35,
    });
    expect(saved[0].turns[0].pauseAfterMs).toBe(700);
    expect(saved[0].brief).toBe(p.brief);
    expect(saved[0].speakers.every((s) => !s.voiceId)).toBe(true);
  });
  it("offers the same controls to empty and example conversations without a task-specific mode", () => {
    for (const p of [newProject(), newProject(true)]) {
      expect(p.performance).toEqual(defaultPerformance());
      expect(p.performance).not.toHaveProperty("interview");
      expect(p.brief).not.toMatch(/NotebookLM|CEN4722|UX research/);
    }
    const first = defaultPerformance();
    first.seed = 123;
    expect(defaultPerformance().seed).toBeNull();
  });
});
