import { describe, expect, it, vi } from "vitest";
import {
  characterSource,
  currentCharacterPlan,
  generateConversation,
} from "./characters";
import { newProject } from "./project";
import type { CharacterPlan, Project } from "./types";

function plan(project: Project): CharacterPlan {
  return {
    source: characterSource(project),
    characters: project.speakers.map((s) => ({
      speakerId: s.id,
      establishedFacts: s.personality,
      personality: "Cautious",
      perspective: "Wants to understand",
      speakingStyle: "Short questions",
      knowledgeLimits: "Cannot know others' experiences",
      experiences: [],
    })),
  };
}

describe("character planning workflow", () => {
  it("saves the plan before writing and preserves the old script until success", async () => {
    const project = newProject();
    const events: string[] = [];
    const notes = plan(project);
    const turns = [
      {
        id: "new",
        speakerId: project.speakers[0].id,
        text: "A different experience",
        direction: "",
      },
    ];
    await generateConversation(project, {
      develop: async () => {
        events.push("plan");
        return notes;
      },
      persist: async (p, reason) => {
        events.push(reason);
        expect(p.characterPlan).toEqual(notes);
        expect(p.turns).toEqual(
          reason === "Developed cast" ? project.turns : turns,
        );
      },
      script: async (p) => {
        events.push("script");
        expect(p.characterPlan).toEqual(notes);
        return turns;
      },
      stage: () => {},
    });
    expect(events).toEqual([
      "plan",
      "Developed cast",
      "script",
      "Generated script",
    ]);
    expect(project.characterPlan).toBeUndefined();
  });
  it("retains completed planning after a dialogue failure for an explicit retry", async () => {
    let saved = newProject();
    const originalTurns = saved.turns;
    const develop = vi.fn(async (p: Project) => p.characterPlan ?? plan(p));
    const dependencies = {
      develop,
      script: vi
        .fn()
        .mockRejectedValueOnce(Error("timeout"))
        .mockResolvedValueOnce([]),
      persist: async (p: Project) => {
        saved = p;
      },
      stage: () => {},
    };
    await expect(generateConversation(saved, dependencies)).rejects.toThrow(
      "timeout",
    );
    expect(saved.turns).toEqual(originalTurns);
    expect(currentCharacterPlan(saved)).toBe(true);
    const retained = saved.characterPlan;
    expect(dependencies.script).toHaveBeenCalledTimes(1);
    await generateConversation(saved, dependencies);
    expect(develop.mock.calls[1][0].characterPlan).toBe(retained);
  });
  it("does not write a script if planning or checkpoint persistence fails", async () => {
    const project = newProject();
    const script = vi.fn();
    const persist = vi.fn();
    await expect(
      generateConversation(project, {
        develop: async () => {
          throw Error("planning failed");
        },
        script,
        persist,
        stage: () => {},
      }),
    ).rejects.toThrow("planning failed");
    expect(persist).not.toHaveBeenCalled();
    await expect(
      generateConversation(project, {
        develop: async () => plan(project),
        script,
        persist: async () => {
          throw Error("disk full");
        },
        stage: () => {},
      }),
    ).rejects.toThrow("disk full");
    expect(script).not.toHaveBeenCalled();
  });
  it("marks notes stale when scene or background changes, but not for a voice change", () => {
    const project = newProject();
    project.characterPlan = plan(project);
    project.speakers[0].voiceId = "new voice";
    expect(currentCharacterPlan(project)).toBe(true);
    project.speakers[0].personality += " New background";
    expect(currentCharacterPlan(project)).toBe(false);
    project.characterPlan = plan(project);
    project.brief += " Another task";
    expect(currentCharacterPlan(project)).toBe(false);
  });
});
