export interface DesignDraft {
  language: string;
  character: string;
  quality: string;
  persona: string;
  emotion: string;
  delivery: string;
  text: string;
  guidance: number;
  name: string;
}
export const defaultDesign: DesignDraft = {
  language: "Native English, United States",
  character: "Female, 25–35",
  quality: "Good",
  persona: "thoughtful, approachable",
  emotion: "curious, warm",
  delivery:
    "A warm, lightly textured mid-range voice. Speaks conversationally, varying pace as thoughts form, with gentle emphasis and understated reactions.",
  text: "",
  guidance: 5,
  name: "",
};
export function designPrompt(draft: DesignDraft) {
  return `${draft.language.trim()}. ${draft.character.trim()}. ${draft.quality} quality.\nPersona: ${draft.persona.trim()}. Emotion: ${draft.emotion.trim()}.\n${draft.delivery.trim()}`;
}
export interface DesignRequest {
  description: string;
  text: string;
  guidance: number;
}
export interface DesignBatch {
  request: DesignRequest;
  result: {
    text: string;
    previews: {
      generated_voice_id: string;
      audio_base_64: string;
      duration_secs: number;
    }[];
  };
  saved: Record<string, string>;
}
export interface DesignState {
  batch: DesignBatch | null;
  attempt: { state?: string; stage?: string; name?: string } | null;
}
