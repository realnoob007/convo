import { describe, it, expect } from "vitest";
import { SaveQueue } from "./save-queue";
import { newProject, renderCharacterCount } from "./project";
describe("save ordering", () => {
  it("serializes writes and captures the edited snapshot", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const writes: string[] = [];
    const q = new SaveQueue(async (p) => {
      if (!writes.length) await gate;
      writes.push(p.title);
    });
    const p = newProject();
    p.title = "First";
    const first = q.save(p);
    p.title = "Second";
    const second = q.save(p);
    p.title = "Third";
    release();
    await Promise.all([first, second]);
    expect(writes).toEqual(["First", "Second"]);
  });
  it("allows recovery after disk failure", async () => {
    let fail = true;
    const q = new SaveQueue(async () => {
      if (fail) throw Error("disk full");
    });
    await expect(q.save(newProject())).rejects.toThrow();
    fail = false;
    await expect(q.save(newProject())).resolves.toBeUndefined();
  });
  it("counts tags and unicode consistently with the renderer", () => {
    const p = newProject();
    p.turns = [
      {
        id: "1",
        speakerId: p.speakers[0].id,
        text: "你好🙂",
        direction: "sighs",
      },
    ];
    expect(renderCharacterCount(p)).toBe(11);
  });
});
