import { Badge } from "@/components/ui/badge";
import { currentCharacterPlan } from "@/lib/characters";
import type { Project } from "@/lib/types";
import type { createTranslator } from "@/lib/i18n";

export function CharacterNotes({
  project,
  speakerId,
  t,
}: {
  project: Project;
  speakerId: string;
  t: ReturnType<typeof createTranslator>;
}) {
  const character = project.characterPlan?.characters.find(
    (c) => c.speakerId === speakerId,
  );
  if (!character) return null;
  if (!currentCharacterPlan(project)) {
    return (
      <p className="small-note mt-3">
        {t("Character notes will update when you generate the script.")}
      </p>
    );
  }
  return (
    <details className="mt-3 rounded-md border border-border p-3 text-xs leading-relaxed">
      <summary className="cursor-pointer font-medium">
        {t("Character notes")}
      </summary>
      <p className="mt-2 text-muted-foreground">
        {t("AI-developed for this scene. Your background takes priority.")}
      </p>
      <dl className="mt-3 space-y-3 break-words">
        {(
          [
            ["Established facts", character.establishedFacts],
            ["Personality", character.personality],
            ["Perspective and motives", character.perspective],
            ["Speaking style", character.speakingStyle],
            ["Knowledge and limits", character.knowledgeLimits],
          ] as const
        ).map(([label, value]) => (
          <div key={label}>
            <dt className="font-medium">{t(label)}</dt>
            <dd className="mt-1 whitespace-pre-wrap text-muted-foreground">
              {value}
            </dd>
          </div>
        ))}
      </dl>
      {character.experiences.map((experience, index) => (
        <div
          key={index}
          className="mt-3 space-y-2 border-t border-border pt-3 break-words"
        >
          <Badge variant="outline">
            {t(
              experience.basis === "fictional"
                ? "Fictional experience"
                : "Supplied experience",
            )}
          </Badge>
          <dl className="space-y-2">
            {(
              [
                ["Situation", experience.situation],
                ["Motivation", experience.motivation],
                ["Actions", experience.actions],
                ["Outcome", experience.outcome],
                ["Uncertainty", experience.uncertainty],
              ] as const
            ).map(([label, value]) => (
              <div key={label}>
                <dt className="font-medium">{t(label)}</dt>
                <dd className="mt-1 whitespace-pre-wrap text-muted-foreground">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
    </details>
  );
}
