import type { Project, Performance } from "./types";
export function defaultPerformance(): Performance {
  return { targetSeconds: 90, stability: 0.5, seed: null };
}
export function newProject(example = false): Project {
  const a = crypto.randomUUID(),
    b = crypto.randomUUID();
  return {
    id: crypto.randomUUID(),
    title: example ? "The last train home" : "Untitled conversation",
    brief: example
      ? "Two old friends unexpectedly meet on the last train home. Maya is moving away tomorrow and hasn’t told Leo. Start with gentle teasing, let the news slip out, then find a small, hopeful moment. Intimate, understated, and human."
      : "",
    language: "en",
    model: "gpt-6-astra",
    performance: defaultPerformance(),
    speakers: [
      {
        id: a,
        name: "Maya",
        personality: "Warm, quick-witted; hides nerves behind humor.",
        voiceId: "",
      },
      {
        id: b,
        name: "Leo",
        personality: "Thoughtful, a little dry; notices what goes unsaid.",
        voiceId: "",
      },
    ],
    turns: example
      ? [
          {
            id: crypto.randomUUID(),
            speakerId: a,
            direction: "amused",
            text: "You still take this train? I thought you were a responsible adult now.",
          },
          {
            id: crypto.randomUUID(),
            speakerId: b,
            direction: "",
            text: "I tried it. Terrible hours.\n\nHey—what’s with the suitcase?",
          },
          {
            id: crypto.randomUUID(),
            speakerId: a,
            direction: "sighs",
            text: "Oh. Yeah. I was going to call you.",
          },
          {
            id: crypto.randomUUID(),
            speakerId: b,
            direction: "softly",
            text: "Maya. Where are you going?",
          },
          {
            id: crypto.randomUUID(),
            speakerId: a,
            direction: "",
            text: "Portland. Tomorrow. And I know, I know—it’s a ridiculous thing to mention between stations.",
          },
          {
            id: crypto.randomUUID(),
            speakerId: b,
            direction: "",
            text: "Well... we’ve got three stops. Start with the ridiculous part.",
          },
        ]
      : [],
  };
}
export function renderCharacterCount(p: Project) {
  return p.turns.reduce(
    (n, t) =>
      n +
      [...t.text].length +
      (t.direction.trim() ? [...t.direction.trim()].length + 3 : 0),
    0,
  );
}
