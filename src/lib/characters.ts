import type { CharacterPlan, Project, Turn } from "./types";

export function characterSource(project: Project): CharacterPlan["source"] {
  return {
    brief: project.brief,
    language: project.language,
    cast: project.speakers.map(({ id, name, personality }) => ({
      id,
      name,
      background: personality,
    })),
  };
}

export function currentCharacterPlan(project: Project): boolean {
  return (
    !!project.characterPlan &&
    JSON.stringify(project.characterPlan.source) ===
      JSON.stringify(characterSource(project))
  );
}

export async function generateConversation(
  project: Project,
  dependencies: {
    develop: (project: Project) => Promise<CharacterPlan>;
    script: (project: Project) => Promise<Turn[]>;
    persist: (project: Project, reason: string) => Promise<void>;
    stage: (label: string) => void;
  },
): Promise<void> {
  dependencies.stage("Developing your cast");
  const characterPlan = await dependencies.develop(project);
  const planned = { ...project, characterPlan };
  // Persist this independently so a failed dialogue request can reuse the plan.
  await dependencies.persist(planned, "Developed cast");
  dependencies.stage("Writing your conversation");
  const turns = await dependencies.script(planned);
  await dependencies.persist({ ...planned, turns }, "Generated script");
}
