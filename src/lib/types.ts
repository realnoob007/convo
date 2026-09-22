export interface Speaker {
  id: string;
  name: string;
  personality: string;
  voiceId: string;
}
export interface Turn {
  id: string;
  speakerId: string;
  text: string;
  direction: string;
  pauseAfterMs?: number;
}
export interface Recording {
  style: "clean" | "phoneRoom" | "phoneCall";
  ambience: number;
  distance?: number;
}
export interface Performance {
  targetSeconds: number;
  stability: number;
  seed: number | null;
  pacing?: "measured" | "conversational" | "brisk";
  expression?: "restrained" | "natural" | "expressive";
  recording?: Recording;
}
export interface Project {
  id: string;
  title: string;
  brief: string;
  language: string;
  model: string;
  speakers: Speaker[];
  turns: Turn[];
  performance?: Performance;
  characterPlan?: CharacterPlan;
}
export interface Voice {
  id: string;
  name: string;
  description: string;
  category: string;
  requiresVerification: boolean;
}
export interface Revision {
  id: number;
  createdAt: string;
  reason: string;
  project: Project;
}
export interface AudioChunk {
  id: string;
  index: number;
  firstTurn: number;
  turnCount: number;
  alignment: unknown;
}
export interface Take {
  id: string;
  projectId: string;
  createdAt: string;
  status: string;
  script: Project;
  chunks: AudioChunk[];
  error: string | null;
  plan?: {
    id: string;
    status: string;
    firstTurn: number;
    inputs: unknown[];
    fingerprint: string;
  }[];
  audioModel?: string;
}
export interface AudioTiming {
  duration: number;
  thresholdDb: number;
  quietFraction: number;
  quietIntervals: [number, number][];
  medianQuietMs: number;
  p90QuietMs: number;
  peak: number;
  clippedFraction: number;
}
export interface PreparedAudio {
  src: string;
  duration: number;
  cues: { turn: number; start: number; end: number }[];
  partial: boolean;
  timing?: AudioTiming;
}
export interface VoiceDraft {
  name: string;
  description: string;
  samples: VoiceSample[];
  updatedAt: number;
}
export interface KeyStatus {
  openai: boolean | null;
  elevenlabs: boolean | null;
}
export interface VoiceSample {
  path: string;
  name: string;
  bytes: number;
  id: string | null;
  duration: number | null;
}

export interface CharacterPlan {
  source: {
    brief: string;
    language: string;
    cast: { id: string; name: string; background: string }[];
  };
  characters: {
    speakerId: string;
    establishedFacts: string;
    personality: string;
    perspective: string;
    speakingStyle: string;
    knowledgeLimits: string;
    experiences: {
      basis: "supplied" | "fictional";
      situation: string;
      motivation: string;
      actions: string;
      outcome: string;
      uncertainty: string;
    }[];
  }[];
}
