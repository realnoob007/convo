import type { Project } from "./types";
export class SaveQueue {
  private tail: Promise<void> = Promise.resolve();
  private write: (project: Project, reason: string) => Promise<void>;
  constructor(write: (project: Project, reason: string) => Promise<void>) {
    this.write = write;
  }
  save(project: Project, reason = "Autosave") {
    const snapshot = structuredClone(project);
    const result = this.tail
      .catch(() => {})
      .then(() => this.write(snapshot, reason));
    this.tail = result;
    return result;
  }
}
