import { TextConnectionSettings } from "@/components/text-connection";
import { SelectField, SelectItem } from "@/components/ui/select";
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AudioLines,
  BookOpen,
  ChevronRight,
  Clock3,
  FolderOpen,
  History,
  Layers3,
  Loader2,
  Mic2,
  Moon,
  Sun,
  Languages,
  Plus,
  Settings2,
  Sparkles,
  Trash2,
  Users,
  WandSparkles,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CharacterNotes } from "@/components/character-notes";
import { generateConversation } from "@/lib/characters";
import { api, desktop } from "@/lib/api";
import {
  newProject,
  defaultPerformance,
  renderCharacterCount,
} from "@/lib/project";
import { SaveQueue } from "@/lib/save-queue";
import type { Project, Voice, Revision, Take, KeyStatus } from "@/lib/types";
import {
  createTranslator,
  isLocale,
  locales,
  translateError,
} from "@/lib/i18n";
import {
  applyPreferences,
  readPreferences,
  writePreferences,
  type Preferences,
} from "@/lib/preferences";
import { VoiceWorkbench } from "@/components/voice-workbench";
import { TakeCard } from "@/components/take-card";
import { VoiceAudition } from "@/components/voice-audition";
import { RecordingControls } from "@/components/recording-controls";
import { ReferenceAudio } from "@/components/reference-audio";
import "./App.css";

const modelOptions = [
  ["gpt-6-astra", "GPT-6 Astra · quality"],
  ["gpt-5.6-terra", "GPT-5.6 Terra · balanced"],
  ["gpt-5.6-luna", "GPT-5.6 Luna · fast draft"],
];
const recoveryKey = "convo-recovery-v1";
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const VoiceDesigner = lazy(() =>
  import("@/components/voice-designer").then((module) => ({
    default: module.VoiceDesigner,
  })),
);

function App() {
  const [preferences, setPreferences] = useState(readPreferences);
  const t = useMemo(
    () => createTranslator(preferences.locale),
    [preferences.locale],
  );
  const date = (value: string) =>
    new Date(value).toLocaleString(preferences.locale, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  const [projects, setProjects] = useState<Project[]>([]),
    [project, setProject] = useState<Project | null>(null);
  const [voices, setVoices] = useState<Voice[]>([]),
    [takes, setTakes] = useState<Take[]>([]),
    [revisions, setRevisions] = useState<Revision[]>([]);
  const [page, setPage] = useState<"studio" | "voices">("studio"),
    [tab, setTab] = useState<"script" | "takes">("script");
  const [dialog, setDialog] = useState<
      "settings" | "history" | "clone" | "design" | null
    >(null),
    [keys, setKeys] = useState<KeyStatus>({ openai: null, elevenlabs: null });
  const [error, setError] = useState(""),
    [saveState, setSaveState] = useState("Loading"),
    [notice, setNotice] = useState("");
  const current = useRef<Project | null>(null),
    dirty = useRef(false),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queue = useRef(new SaveQueue(api.save)),
    closing = useRef(false);
  const [keyDraft, setKeyDraft] = useState({ openai: "", elevenlabs: "" });
  const [recordingActive, setRecordingActive] = useState(false);
  const recordingBusy = useRef(false);
  const [rendering, setRendering] = useState(false);
  const [renderControlError, setRenderControlError] = useState("");
  const [operation, setOperation] = useState("");
  const busy = operation || (rendering ? "Directing your performance" : "");
  const setBusy = setOperation;

  function changePreferences(update: Partial<Preferences>) {
    const next = { ...preferences, ...update };
    applyPreferences(next);
    setPreferences(next);
    try {
      writePreferences(next);
    } catch {
      setError(
        "Preferences could not be saved. Your selection applies until you close the app.",
      );
    }
  }
  useEffect(() => {
    if (!desktop) return;
    let active = true;
    void import("@tauri-apps/api/window")
      .then(async ({ getCurrentWindow }) => {
        if (!active) return;
        const win = getCurrentWindow();
        await win.setTheme(preferences.theme);
        if (active) await win.setTitle(`Convo — ${t("Conversation studio")}`);
      })
      .catch(() => {
        if (active) setError("Window appearance could not be updated.");
      });
    return () => {
      active = false;
    };
  }, [preferences.theme, t]);

  const save = useCallback(async (reason = "Autosave") => {
    if (timer.current) clearTimeout(timer.current);
    const snapshot = current.current;
    if (!snapshot || !dirty.current) return;
    setSaveState("Saving…");
    try {
      await queue.current.save(snapshot, reason);
      if (current.current === snapshot) {
        dirty.current = false;
        localStorage.removeItem(recoveryKey);
        setSaveState("All changes saved");
      }
      setProjects((ps) => [
        snapshot,
        ...ps.filter((p) => p.id !== snapshot.id),
      ]);
    } catch (e) {
      setSaveState("Save failed");
      setError(message(e));
      throw e;
    }
  }, []);
  const activate = useCallback((p: Project) => {
    current.current = p;
    dirty.current = false;
    setProject(p);
    setSaveState("All changes saved");
  }, []);
  useEffect(() => {
    let active = true;
    Promise.all([api.projects(), api.voices(), api.keyStatus()])
      .then(async ([ps, vs, ks]) => {
        const recovered = localStorage.getItem(recoveryKey);
        let draft: Project | null = null;
        if (recovered) {
          try {
            const candidate = JSON.parse(recovered) as Project;
            if (
              typeof candidate.id !== "string" ||
              !Array.isArray(candidate.speakers) ||
              !Array.isArray(candidate.turns)
            ) {
              throw new Error("Invalid recovery draft");
            }
            draft = candidate;
            ps = [candidate, ...ps.filter((p) => p.id !== candidate.id)];
          } catch {
            if (active)
              setError(
                "The recovery draft could not be opened. Your saved projects are still available.",
              );
          }
        }
        if (!ps.length) {
          const p = newProject(true);
          await api.save(p, "Example project");
          ps = [p];
        }
        if (active) {
          setProjects(ps);
          setVoices(vs);
          setKeys(ks);
          activate(ps[0]);
          if (draft) {
            dirty.current = true;
            setSaveState("Recovered unsaved draft");
            setNotice(
              "Recovered your last edits. Review them and continue editing.",
            );
            timer.current = setTimeout(() => {
              void save("Recovered draft").catch(() => {});
            }, 650);
          }
        }
      })
      .catch((e) => {
        if (active) {
          setError(message(e));
          setSaveState("Could not load");
        }
      });
    return () => {
      active = false;
    };
  }, [activate, save]);
  const upsertTake = useCallback((take: Take) => {
    if (take.projectId !== current.current?.id) return;
    setTakes((items) =>
      [take, ...items.filter((item) => item.id !== take.id)].sort((a, b) =>
        b.createdAt.localeCompare(a.createdAt),
      ),
    );
    setRendering(take.status === "rendering");
  }, []);
  useEffect(() => {
    if (!project?.id) return;
    let active = true;
    let off: (() => void) | undefined;
    const refresh = () =>
      api
        .takes(project.id)
        .then((items) => {
          if (active) {
            setTakes(items);
            setRendering(items.some((take) => take.status === "rendering"));
          }
        })
        .catch((e) => {
          if (active) setError(message(e));
        });
    void refresh();
    // Polling is a fallback if a WebView misses an event while suspended.
    const poll = setInterval(() => void refresh(), 3000);
    if (desktop)
      void import("@tauri-apps/api/event").then(async ({ listen }) => {
        const stop = await listen<Take>("render-progress", ({ payload }) => {
          if (active) upsertTake(payload);
        });
        if (active) off = stop;
        else stop();
      });
    return () => {
      active = false;
      clearInterval(poll);
      off?.();
    };
  }, [project?.id, upsertTake]);
  useEffect(() => {
    const blur = () => {
      void save().catch(() => {});
    };
    const unload = (e: BeforeUnloadEvent) => {
      if (dirty.current || recordingBusy.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("blur", blur);
    window.addEventListener("beforeunload", unload);
    let unlisten: (() => void) | undefined;
    let disposed = false;
    if (desktop)
      void import("@tauri-apps/api/window")
        .then(async ({ getCurrentWindow }) => {
          const win = getCurrentWindow();
          const off = await win.onCloseRequested(async (event) => {
            if (closing.current) return;
            if (recordingBusy.current) {
              event.preventDefault();
              setError("Stop or discard the recording before closing the app.");
              return;
            }
            event.preventDefault();
            try {
              await save();
              closing.current = true;
              await win.close();
            } catch {
              /* Keep the window open and retain the unsaved draft. */
            }
          });
          if (disposed) off();
          else unlisten = off;
        })
        .catch((e) => setError(message(e)));
    return () => {
      disposed = true;
      unlisten?.();
      window.removeEventListener("blur", blur);
      window.removeEventListener("beforeunload", unload);
    };
  }, [save]);
  function edit(p: Project) {
    try {
      localStorage.setItem(recoveryKey, JSON.stringify(p));
    } catch {
      setError(
        "Recovery draft could not be written. Keep the app open until autosave completes.",
      );
    }
    current.current = p;
    setProject(p);
    dirty.current = true;
    setSaveState("Unsaved changes");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void save().catch(() => {});
    }, 650);
  }
  async function work(label: string, fn: () => Promise<void>) {
    if (busy) return;
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy("");
    }
  }
  async function switchProject(p: Project) {
    await work("Opening project", async () => {
      await save();
      activate(p);
      setPage("studio");
    });
  }
  async function createProject() {
    await work("Creating project", async () => {
      await save();
      const p = { ...newProject(), title: t("Untitled conversation") };
      await api.save(p, "Created");
      setProjects((ps) => [p, ...ps]);
      activate(p);
      setPage("studio");
      setTab("script");
    });
  }
  async function history() {
    await work("Loading history", async () => {
      await save();
      setRevisions(await api.revisions(current.current!.id));
      setDialog("history");
    });
  }
  async function script() {
    await work("Developing your cast", async () => {
      await save();
      await generateConversation(current.current!, {
        develop: api.developCharacters,
        script: api.script,
        stage: setBusy,
        persist: async (updated, reason) => {
          edit(updated);
          await save(reason);
        },
      });
      setTab("script");
    });
  }
  async function render() {
    await work("Directing your performance", async () => {
      await save();
      const take = await api.render(current.current!);
      upsertTake(take);
      setTab("takes");
      if (take.error) setError(take.error);
    });
  }
  async function refreshVoices() {
    await work("Syncing voices", async () => {
      setVoices(await api.refreshVoices());
      setNotice("Your account voices are available across all projects.");
    });
  }
  const p = project,
    performance = { ...defaultPerformance(), ...p?.performance },
    chars = p ? renderCharacterCount(p) : 0;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <AudioLines size={23} />
          </div>
          <span>
            convo<span className="brand-dot">.</span>
          </span>
          <Badge variant="outline">{t("STUDIO")}</Badge>
        </div>
        <Button
          className="new-project"
          variant="outline"
          onClick={createProject}
          disabled={!!busy}
        >
          <Plus size={16} /> {t("New conversation")}
        </Button>
        <div className="nav-label">{t("WORKSPACE")}</div>
        <button
          className={`nav-item ${page === "studio" ? "active" : ""}`}
          onClick={() => setPage("studio")}
        >
          <Layers3 size={17} /> {t("Conversation studio")}{" "}
          <span>{projects.length}</span>
        </button>
        <button
          className={`nav-item ${page === "voices" ? "active" : ""}`}
          onClick={() => setPage("voices")}
        >
          <Users size={17} /> {t("Voice library")} <span>{voices.length}</span>
        </button>
        <div className="nav-label projects-label">
          {t("YOUR PROJECTS")} <FolderOpen size={13} />
        </div>
        <div className="project-list">
          {projects.map((item) => (
            <button
              key={item.id}
              disabled={!!busy}
              className={`project-link ${p?.id === item.id ? "selected" : ""}`}
              onClick={() => void switchProject(item)}
            >
              <span className="project-dot" />
              <span>{item.title}</span>
              <ChevronRight size={13} />
            </button>
          ))}
        </div>
        <div className="sidebar-bottom">
          <div className="local-badge">
            <span />{" "}
            {desktop ? t("Saved on this device") : t("Browser preview")}
            <p>
              {desktop
                ? t("Your ideas stay close.")
                : t("Local editing · APIs in desktop app")}
            </p>
          </div>
          <button className="nav-item" onClick={() => setDialog("settings")}>
            <Settings2 size={17} /> {t("Settings")}{" "}
            <span
              className="key-dot"
              data-ready={keys.openai && keys.elevenlabs}
            />
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            {t("Workspace")} <ChevronRight size={13} />{" "}
            <span>
              {page === "studio"
                ? t("Conversation studio")
                : t("Voice library")}
            </span>
          </div>
          <div className="topbar-right">
            <div className="appearance-controls">
              <Button
                variant="ghost"
                size="icon"
                className="theme-toggle"
                aria-label={t(
                  preferences.theme === "light"
                    ? "Switch to dark mode"
                    : "Switch to light mode",
                )}
                title={t(
                  preferences.theme === "light"
                    ? "Switch to dark mode"
                    : "Switch to light mode",
                )}
                onClick={() =>
                  changePreferences({
                    theme: preferences.theme === "light" ? "dark" : "light",
                  })
                }
              >
                {preferences.theme === "light" ? (
                  <Moon size={16} />
                ) : (
                  <Sun size={16} />
                )}
              </Button>
              <label className="locale-picker">
                <Languages size={16} aria-hidden="true" />
                <SelectField
                  aria-label={t("Interface language")}
                  value={preferences.locale}
                  onValueChange={(value) => {
                    if (isLocale(value)) changePreferences({ locale: value });
                  }}
                >
                  {locales.map(([id, name]) => (
                    <SelectItem key={id} value={id} lang={id}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectField>
              </label>
            </div>
            <span className="save-indicator">
              <span data-error={saveState.includes("failed")} />
              {t(saveState)}
            </span>
            {saveState === "Save failed" && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void save().catch(() => {})}
              >
                {t("Retry save")}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              onClick={history}
              disabled={!p || !!busy}
            >
              <History size={16} /> {t("History")}
            </Button>
          </div>
        </header>
        {renderControlError && (
          <div role="alert" className="banner error">
            <span>{t(renderControlError)}</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setRenderControlError("")}
            >
              {t("Close")}
            </Button>
          </div>
        )}
        {error && (
          <div role="alert" className="banner error">
            <span>{translateError(error, t)}</span>
            <button
              aria-label={t("Dismiss error")}
              onClick={() => setError("")}
            >
              <X size={15} />
            </button>
          </div>
        )}
        {notice && (
          <div role="status" className="banner notice">
            {t(notice)}
            <button
              aria-label={t("Dismiss notice")}
              onClick={() => setNotice("")}
            >
              <X size={15} />
            </button>
          </div>
        )}
        {busy && (
          <div role="status" className="busy-banner">
            <Loader2 className="spin" size={15} />
            {t(busy)}…
          </div>
        )}
        {page === "voices" ? (
          <main className="voice-page">
            <div className="eyebrow">{t("YOUR REUSABLE CAST")}</div>
            <div className="page-heading">
              <div>
                <h1>{t("Every voice has a story.")}</h1>
                <p>
                  {t(
                    "Build a library of people, personalities, and possibilities.",
                  )}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={() => setDialog("design")}
                  disabled={!!busy}
                >
                  {t("Design a voice")}
                </Button>
                <Button onClick={() => setDialog("clone")} disabled={!!busy}>
                  <Plus size={16} /> {t("Create a voice")}
                </Button>
              </div>
            </div>
            <div className="library-toolbar">
              <span>
                {t("{count} voices · available in every project", {
                  count: voices.length,
                })}
              </span>
              <Button
                variant="outline"
                onClick={refreshVoices}
                disabled={!!busy}
              >
                <Users size={15} /> {t("Sync ElevenLabs voices")}
              </Button>
            </div>
            {voices.length ? (
              <div className="voice-grid">
                {voices.map((v, i) => (
                  <article className="voice-card" key={v.id}>
                    <div className={`avatar color-${i % 4}`}>
                      <Mic2 size={22} />
                    </div>
                    <h3>{v.name}</h3>
                    <Badge variant="outline" className="rounded-md">
                      {t(v.category)}
                    </Badge>
                    <p>
                      {v.description || t("Ready for your next conversation.")}
                    </p>
                    <VoiceAudition voice={v} t={t} disabled={!!busy} />
                    {v.requiresVerification && (
                      <span className="verification">
                        {t("Verification required")}
                      </span>
                    )}
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty-state">
                <div className="empty-icon">
                  <Users size={30} />
                </div>
                <h2>{t("Meet your next cast.")}</h2>
                <p>
                  {t(
                    "Sync the voices in your ElevenLabs account, or upload recordings of one person to create a reusable voice.",
                  )}
                </p>
                <Button
                  variant="outline"
                  onClick={refreshVoices}
                  disabled={!!busy}
                >
                  {t("Load account voices")}
                </Button>
              </div>
            )}
          </main>
        ) : p ? (
          <div className="studio-grid">
            <main className="editor-pane">
              <div className="eyebrow">
                {t("CONVERSATION /")}{" "}
                {String(projects.findIndex((x) => x.id === p.id) + 1).padStart(
                  2,
                  "0",
                )}
              </div>
              <div className="title-row">
                <Input
                  aria-label={t("Project title")}
                  className="project-title"
                  value={p.title}
                  disabled={!!busy}
                  onChange={(e) => edit({ ...p, title: e.target.value })}
                />
                <Badge variant="outline">{t("DRAFT")}</Badge>
              </div>
              <p className="subtitle">
                {t("A little less scripted. A little more human.")}
              </p>
              <section className="brief-card">
                <div className="section-label">
                  <Sparkles size={15} /> {t("Set the scene")}{" "}
                  <span>{t("THE STARTING POINT")}</span>
                </div>
                <Textarea
                  aria-label={t("Scene brief")}
                  placeholder={t(
                    "Who’s talking? Where are they? What’s left unsaid?",
                  )}
                  value={p.brief}
                  disabled={!!busy}
                  onChange={(e) => edit({ ...p, brief: e.target.value })}
                />
                <div className="brief-footer">
                  <span>
                    <span className="tiny-dot" />{" "}
                    {t("Emotion lives in the details.")}
                  </span>
                  <Button
                    size="sm"
                    onClick={script}
                    disabled={!!busy || !p.brief.trim()}
                  >
                    <WandSparkles size={14} /> {t("Generate script")}
                  </Button>
                </div>
              </section>
              <div className="editor-tabs">
                <div>
                  <button
                    className={tab === "script" ? "selected" : ""}
                    onClick={() => setTab("script")}
                  >
                    <BookOpen size={15} /> {t("Script")}{" "}
                    <span>{p.turns.length}</span>
                  </button>
                  <button
                    className={tab === "takes" ? "selected" : ""}
                    onClick={() => setTab("takes")}
                  >
                    <AudioLines size={15} /> {t("Audio takes")}{" "}
                    <span>{takes.length}</span>
                  </button>
                </div>
                <span>{t("{count} characters", { count: chars })}</span>
              </div>
              {tab === "script" ? (
                <>
                  <div className="script-heading">
                    <span>{t("SPEAKER / DIALOGUE")}</span>
                    <span>{t("DELIVERY")}</span>
                  </div>
                  <div className="turn-list">
                    {p.turns.map((turn, index) => {
                      const speaker = p.speakers.find(
                        (s) => s.id === turn.speakerId,
                      );
                      const color =
                        p.speakers.findIndex((s) => s.id === turn.speakerId) %
                        4;
                      return (
                        <article className="turn-card" key={turn.id}>
                          <span className="turn-number">
                            {String(index + 1).padStart(2, "0")}
                          </span>
                          <div className={`avatar color-${color}`}>
                            {speaker?.name.slice(0, 1) || "?"}
                          </div>
                          <div className="turn-content">
                            <div className="turn-meta">
                              <SelectField
                                aria-label={t("Speaker for turn {number}", {
                                  number: index + 1,
                                })}
                                value={turn.speakerId}
                                disabled={!!busy}
                                onValueChange={(value) =>
                                  edit({
                                    ...p,
                                    turns: p.turns.map((t) =>
                                      t.id === turn.id
                                        ? { ...t, speakerId: value }
                                        : t,
                                    ),
                                  })
                                }
                              >
                                {p.speakers.map((s) => (
                                  <SelectItem key={s.id} value={s.id}>
                                    {s.name}
                                  </SelectItem>
                                ))}
                              </SelectField>
                              <Input
                                className="direction"
                                aria-label={t("Delivery for turn {number}", {
                                  number: index + 1,
                                })}
                                placeholder={t("Natural")}
                                value={turn.direction}
                                disabled={!!busy}
                                maxLength={100}
                                onChange={(e) =>
                                  edit({
                                    ...p,
                                    turns: p.turns.map((t) =>
                                      t.id === turn.id
                                        ? { ...t, direction: e.target.value }
                                        : t,
                                    ),
                                  })
                                }
                              />
                              <button
                                aria-label={t("Delete turn {number}", {
                                  number: index + 1,
                                })}
                                disabled={!!busy}
                                className="delete-turn"
                                onClick={() =>
                                  edit({
                                    ...p,
                                    turns: p.turns.filter(
                                      (t) => t.id !== turn.id,
                                    ),
                                  })
                                }
                              >
                                <Trash2 size={13} />
                              </button>
                            </div>
                            <Textarea
                              aria-label={t("Dialogue turn {number}", {
                                number: index + 1,
                              })}
                              value={turn.text}
                              disabled={!!busy}
                              onChange={(e) =>
                                edit({
                                  ...p,
                                  turns: p.turns.map((t) =>
                                    t.id === turn.id
                                      ? { ...t, text: e.target.value }
                                      : t,
                                  ),
                                })
                              }
                            />
                            <label className="mt-2 flex items-center justify-end gap-2 text-xs text-muted-foreground">
                              {t("Additional pause after line")}
                              <SelectField
                                aria-label={t("Pause after turn {number}", {
                                  number: index + 1,
                                })}
                                className="w-28"
                                value={String(turn.pauseAfterMs ?? 0)}
                                disabled={!!busy}
                                onValueChange={(value) =>
                                  edit({
                                    ...p,
                                    turns: p.turns.map((line) =>
                                      line.id === turn.id
                                        ? {
                                            ...line,
                                            pauseAfterMs: Number(value),
                                          }
                                        : line,
                                    ),
                                  })
                                }
                              >
                                {[
                                  ...new Set([
                                    0,
                                    200,
                                    400,
                                    700,
                                    1200,
                                    2000,
                                    3000,
                                    5000,
                                    turn.pauseAfterMs ?? 0,
                                  ]),
                                ]
                                  .sort((a, b) => a - b)
                                  .map((ms) => (
                                    <SelectItem key={ms} value={String(ms)}>
                                      {ms === 0 ? t("None") : `${ms / 1000} s`}
                                    </SelectItem>
                                  ))}
                              </SelectField>
                            </label>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                  <Button
                    className="add-turn"
                    variant="ghost"
                    disabled={!!busy}
                    onClick={() =>
                      edit({
                        ...p,
                        turns: [
                          ...p.turns,
                          {
                            id: crypto.randomUUID(),
                            speakerId:
                              p.speakers[p.turns.length % p.speakers.length].id,
                            text: "",
                            direction: "",
                          },
                        ],
                      })
                    }
                  >
                    <Plus size={15} /> {t("Add a dialogue turn")}
                  </Button>
                </>
              ) : (
                <div className="takes-list">
                  {!takes.length ? (
                    <div className="empty-state">
                      <AudioLines size={32} />
                      <h2>{t("The room is quiet. For now.")}</h2>
                      <p>
                        {t(
                          "Assign your cast’s voices, then generate a performance. Every take stays here.",
                        )}
                      </p>
                    </div>
                  ) : (
                    takes.map((take, i) => (
                      <TakeCard
                        key={take.id}
                        take={take}
                        number={takes.length - i}
                        t={t}
                        date={date(take.createdAt)}
                        onUpdate={upsertTake}
                        onError={setRenderControlError}
                        anotherRender={rendering && take.status !== "rendering"}
                      />
                    ))
                  )}
                </div>
              )}
              <div className="editor-note">
                <span className="tiny-dot" />{" "}
                {p.turns.length
                  ? t("Edit any line. Give every voice room to breathe.")
                  : t("Start with a scene, or write your first line.")}
              </div>
            </main>
            <aside className="director-pane">
              <div className="director-title">
                <span>{t("Director’s desk")}</span>
                <Settings2 size={16} />
              </div>
              <section>
                <div className="section-label">
                  {t("Cast")}{" "}
                  <span>
                    {t("{count} PEOPLE", { count: p.speakers.length })}
                  </span>
                </div>
                <div className="cast-list">
                  {p.speakers.map((s, i) => (
                    <div className="cast-card" key={s.id}>
                      <div className="cast-name">
                        <div className={`avatar color-${i % 4}`}>
                          {s.name.slice(0, 1) || "?"}
                        </div>
                        <Input
                          aria-label={t("Speaker {number} name", {
                            number: i + 1,
                          })}
                          value={s.name}
                          disabled={!!busy}
                          onChange={(e) =>
                            edit({
                              ...p,
                              speakers: p.speakers.map((x) =>
                                x.id === s.id
                                  ? { ...x, name: e.target.value }
                                  : x,
                              ),
                            })
                          }
                        />
                        <span>0{i + 1}</span>
                      </div>
                      <label
                        className="mt-3 mb-2 block text-xs font-medium"
                        htmlFor={`cast-background-${s.id}`}
                      >
                        {t("Background")}
                      </label>
                      <Textarea
                        id={`cast-background-${s.id}`}
                        aria-label={t("{name} background", { name: s.name })}
                        aria-describedby={`cast-background-help-${s.id}`}
                        placeholder={t(
                          "Age, ethnicity, education, personality, and any other details that shape how this person speaks.",
                        )}
                        rows={5}
                        value={s.personality}
                        disabled={!!busy}
                        onChange={(e) =>
                          edit({
                            ...p,
                            speakers: p.speakers.map((x) =>
                              x.id === s.id
                                ? { ...x, personality: e.target.value }
                                : x,
                            ),
                          })
                        }
                      />
                      <p
                        id={`cast-background-help-${s.id}`}
                        className="small-note mt-2 mb-3"
                      >
                        {t(
                          "Background shapes character and experiences before dialogue is written.",
                        )}
                      </p>
                      <SelectField
                        className="voice-select"
                        aria-label={t("{name} voice", { name: s.name })}
                        value={s.voiceId}
                        disabled={!!busy}
                        onValueChange={(value) =>
                          edit({
                            ...p,
                            speakers: p.speakers.map((x) =>
                              x.id === s.id ? { ...x, voiceId: value } : x,
                            ),
                          })
                        }
                      >
                        <SelectItem value="">{t("Choose a voice")}</SelectItem>
                        {s.voiceId &&
                          !voices.some((v) => v.id === s.voiceId) && (
                            <SelectItem value={s.voiceId}>
                              {t("Previously selected voice")}
                            </SelectItem>
                          )}
                        {voices.map((v) => (
                          <SelectItem
                            key={v.id}
                            value={v.id}
                            disabled={v.requiresVerification}
                          >
                            {v.name}
                            {v.requiresVerification ? t(" · verify first") : ""}
                          </SelectItem>
                        ))}
                      </SelectField>
                      <CharacterNotes project={p} speakerId={s.id} t={t} />
                    </div>
                  ))}
                </div>
                <Button
                  className="add-speaker"
                  variant="outline"
                  size="sm"
                  disabled={!!busy || p.speakers.length >= 10}
                  onClick={() =>
                    edit({
                      ...p,
                      speakers: [
                        ...p.speakers,
                        {
                          id: crypto.randomUUID(),
                          name: t("Speaker {number}", {
                            number: p.speakers.length + 1,
                          }),
                          personality: "",
                          voiceId: "",
                        },
                      ],
                    })
                  }
                >
                  <Plus size={14} /> {t("Add speaker")}
                </Button>
                <button className="text-link" onClick={() => setPage("voices")}>
                  {t("Manage voice library")} <ChevronRight size={13} />
                </button>
              </section>
              <section className="generation-settings">
                <div className="section-label">{t("Creative settings")}</div>
                <label>
                  {t("Target length")}
                  <SelectField
                    aria-label={t("Target length")}
                    value={String(performance.targetSeconds)}
                    disabled={!!busy}
                    onValueChange={(value) =>
                      edit({
                        ...p,
                        performance: {
                          ...performance,
                          targetSeconds: Number(value),
                        },
                      })
                    }
                  >
                    {[60, 90, 180, 600, 900].map((seconds) => (
                      <SelectItem key={seconds} value={String(seconds)}>
                        {seconds < 120
                          ? t("{count} seconds", { count: seconds })
                          : t("{count} minutes", { count: seconds / 60 })}
                      </SelectItem>
                    ))}
                  </SelectField>
                </label>
                <label>
                  {t("Pacing")}
                  <SelectField
                    aria-label={t("Pacing")}
                    value={performance.pacing ?? "conversational"}
                    disabled={!!busy}
                    onValueChange={(value) =>
                      edit({
                        ...p,
                        performance: {
                          ...performance,
                          pacing: value as
                            "measured" | "conversational" | "brisk",
                        },
                      })
                    }
                  >
                    <SelectItem value="measured">{t("Measured")}</SelectItem>
                    <SelectItem value="conversational">
                      {t("Conversational")}
                    </SelectItem>
                    <SelectItem value="brisk">{t("Brisk")}</SelectItem>
                  </SelectField>
                </label>
                <label>
                  {t("Emotional expression")}
                  <SelectField
                    aria-label={t("Emotional expression")}
                    value={performance.expression ?? "natural"}
                    disabled={!!busy}
                    onValueChange={(value) =>
                      edit({
                        ...p,
                        performance: {
                          ...performance,
                          expression: value as
                            "restrained" | "natural" | "expressive",
                        },
                      })
                    }
                  >
                    <SelectItem value="restrained">{t("Subtle")}</SelectItem>
                    <SelectItem value="natural">{t("Natural")}</SelectItem>
                    <SelectItem value="expressive">
                      {t("Expressive")}
                    </SelectItem>
                  </SelectField>
                </label>
                <p className="small-note">
                  {t(
                    "Pacing and emotion guide new scripts. Edit line delivery to change an existing script.",
                  )}
                </p>
                <label>
                  {t("Delivery")}
                  <SelectField
                    aria-label={t("Delivery")}
                    value={String(performance.stability)}
                    disabled={!!busy}
                    onValueChange={(value) =>
                      edit({
                        ...p,
                        performance: {
                          ...performance,
                          stability: Number(value),
                        },
                      })
                    }
                  >
                    <SelectItem value="0.5">{t("Natural")}</SelectItem>
                    <SelectItem value="0">{t("Creative")}</SelectItem>
                    <SelectItem value="1">{t("Robust")}</SelectItem>
                  </SelectField>
                </label>
                <label>
                  {t("Variation seed")}
                  <Input
                    type="number"
                    min={0}
                    max={4294967295}
                    step={1}
                    value={performance.seed ?? ""}
                    disabled={!!busy}
                    placeholder={t("Random")}
                    onChange={(e) => {
                      const n =
                        e.target.value === "" ? null : Number(e.target.value);
                      if (
                        n === null ||
                        (Number.isInteger(n) && n >= 0 && n <= 4294967295)
                      )
                        edit({
                          ...p,
                          performance: { ...performance, seed: n },
                        });
                    }}
                  />
                </label>
                <p className="small-note">
                  {t(
                    "Length is approximate. Seeds aid comparison, but do not guarantee identical audio.",
                  )}
                </p>
                <RecordingControls
                  t={t}
                  disabled={!!busy}
                  value={
                    performance.recording ?? { style: "clean", ambience: 0 }
                  }
                  onChange={(recording) =>
                    edit({ ...p, performance: { ...performance, recording } })
                  }
                />
                <ReferenceAudio key={p.id} t={t} />
                <label>
                  {t("Script model")}
                  <Input
                    aria-label={t("Script model")}
                    value={p.model}
                    disabled={!!busy}
                    list="script-models"
                    onChange={(e) => edit({ ...p, model: e.target.value })}
                    placeholder={t("Enter model ID")}
                  />
                  <datalist id="script-models">
                    {modelOptions.map(([id, name]) => (
                      <option key={id} value={id}>
                        {t(name)}
                      </option>
                    ))}
                  </datalist>
                </label>
                <label>
                  {t("Conversation language")}
                  <SelectField
                    aria-label={t("Conversation language")}
                    value={p.language}
                    disabled={!!busy}
                    onValueChange={(value) => edit({ ...p, language: value })}
                  >
                    {[
                      ["en", "English"],
                      ["zh", "Chinese"],
                      ["es", "Spanish"],
                      ["fr", "French"],
                      ["de", "German"],
                      ["ja", "Japanese"],
                      ["ko", "Korean"],
                    ].map(([id, name]) => (
                      <SelectItem key={id} value={id}>
                        {t(name)}
                      </SelectItem>
                    ))}
                  </SelectField>
                </label>
                <div className="audio-model">
                  <AudioLines size={16} />
                  <div>
                    Eleven v3<span>{t("Expressive, multi-speaker audio")}</span>
                  </div>
                  <span className="tiny-dot" />
                </div>
              </section>
              <div className="director-tip">
                <span>{t("MAKE IT FEEL REAL")}</span>
                <p>
                  {t(
                    "A pause. A quiet laugh. The thing they almost said. Small moments make a conversation.",
                  )}
                </p>
              </div>
              <div className="render-box">
                <div>
                  <span>{t("Ready for a performance?")}</span>
                  <span>{t("{count} chars", { count: chars })}</span>
                </div>
                <Button disabled={!!busy || !p.turns.length} onClick={render}>
                  <AudioLines size={17} /> {t("Generate audio")}
                </Button>
                <p>{t("Each generation creates a new, saved take.")}</p>
              </div>
            </aside>
          </div>
        ) : (
          <div className="empty-state">
            <Loader2 className="spin" />
            <p>{t("Opening your studio…")}</p>
          </div>
        )}
        <footer className="statusbar">
          <span>
            <span className="tiny-dot" /> {t("CONVO STUDIO")}{" "}
            <span className="footer-divider">/</span>{" "}
            {desktop ? t("LOCAL WORKSPACE") : t("BROWSER PREVIEW")}
          </span>
          <span>{t("Made for conversations worth hearing.")}</span>
        </footer>
      </div>
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open && !busy && !recordingActive) {
            setDialog(null);
          }
        }}
      >
        <DialogContent
          className="studio-dialog"
          closeLabel={t("Close")}
          showCloseButton={!recordingActive}
        >
          <DialogHeader>
            <DialogTitle>
              {dialog === "settings"
                ? t("Your studio settings")
                : dialog === "history"
                  ? t("Project history")
                  : dialog === "design"
                    ? t("Design a voice")
                    : t("Create a reusable voice")}
            </DialogTitle>
            <DialogDescription>
              {dialog === "settings"
                ? t("Personalize your workspace and connect your accounts.")
                : dialog === "history"
                  ? t(
                      "Restore a saved version. Your current work and older audio takes are preserved.",
                    )
                  : dialog === "design"
                    ? t(
                        "Describe a new voice, compare previews, and save your favorite to the global library.",
                      )
                    : t(
                        "Upload clear recordings of one person. Samples are sent to ElevenLabs to create your voice.",
                      )}
            </DialogDescription>
          </DialogHeader>
          {dialog === "settings" && (
            <div className="settings-form">
              <div className="preference-row">
                <label htmlFor="theme-preference">{t("Appearance")}</label>
                <SelectField
                  id="theme-preference"
                  value={preferences.theme}
                  onValueChange={(value) =>
                    changePreferences({
                      theme: value === "dark" ? "dark" : "light",
                    })
                  }
                >
                  <SelectItem value="light">{t("Light")}</SelectItem>
                  <SelectItem value="dark">{t("Dark")}</SelectItem>
                </SelectField>
              </div>
              <div className="preference-row">
                <label htmlFor="locale-preference">
                  {t("Interface language")}
                </label>
                <SelectField
                  id="locale-preference"
                  value={preferences.locale}
                  onValueChange={(value) => {
                    if (isLocale(value)) changePreferences({ locale: value });
                  }}
                >
                  {locales.map(([id, name]) => (
                    <SelectItem key={id} value={id} lang={id}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectField>
              </div>
              <p className="small-note">
                {t(
                  "Interface language does not change your scripts or conversation language.",
                )}
              </p>
              <div className="settings-section-heading">
                <h3>{t("API connections")}</h3>
                <p className="small-note">
                  {t(
                    "Keys are stored in a local SQLite database on this device.",
                  )}
                </p>
              </div>
              <TextConnectionSettings
                t={t}
                disabled={!!busy}
                onSaved={(configured) =>
                  setKeys((current) => ({ ...current, openai: configured }))
                }
              />
              {(["elevenlabs"] as const).map((provider) => (
                <div key={provider}>
                  <label htmlFor={`${provider}-key`}>
                    {"ElevenLabs"}{" "}
                    <Badge variant="outline">
                      {keys[provider] === null
                        ? t("Not checked")
                        : keys[provider]
                          ? t("Configured")
                          : t("Not configured")}
                    </Badge>
                  </label>
                  <div className="key-row">
                    <Input
                      id={`${provider}-key`}
                      type="password"
                      autoComplete="off"
                      placeholder={t("Paste API key")}
                      value={keyDraft[provider]}
                      disabled={!desktop || !!busy}
                      onChange={(e) =>
                        setKeyDraft((k) => ({
                          ...k,
                          [provider]: e.target.value,
                        }))
                      }
                    />
                    <Button
                      disabled={!desktop || !!busy || !keyDraft[provider]}
                      onClick={() =>
                        void work("Saving key", async () => {
                          await api.saveKey(provider, keyDraft[provider]);
                          setKeyDraft((k) => ({ ...k, [provider]: "" }));
                          setKeys((current) => ({
                            ...current,
                            [provider]: true,
                          }));
                          setNotice("Key saved to the local database.");
                        })
                      }
                    >
                      {t("Save")}
                    </Button>
                  </div>
                </div>
              ))}
              <p className="small-note">
                {t(
                  "Saved keys are read from the local database without keychain prompts.",
                )}
              </p>
              <Button
                variant="outline"
                disabled={!desktop || !!busy}
                onClick={() =>
                  void work("Checking saved keys", async () => {
                    setKeys(await api.keyStatus());
                  })
                }
              >
                {t("Check saved keys")}
              </Button>
              {!desktop && (
                <p className="small-note">
                  {t(
                    "Provider connections are available in the desktop app. This browser preview saves editing changes locally.",
                  )}
                </p>
              )}
              <Button
                variant="outline"
                disabled={!desktop || !!busy}
                onClick={refreshVoices}
              >
                <Users size={15} /> {t("Load account voices")}
              </Button>
            </div>
          )}
          {dialog === "history" && (
            <div className="history-list">
              {revisions.map((r) => (
                <div className="revision" key={r.id}>
                  <Clock3 size={16} />
                  <div>
                    <strong>{t(r.reason)}</strong>
                    <p>
                      {date(r.createdAt)} ·{" "}
                      {t("{count} turns", { count: r.project.turns.length })}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!!busy}
                    onClick={() =>
                      void work("Restoring revision", async () => {
                        await save();
                        await api.save(r.project, "Restored revision");
                        activate(r.project);
                        setProjects((ps) => [
                          r.project,
                          ...ps.filter((x) => x.id !== r.project.id),
                        ]);
                        setDialog(null);
                        setNotice(
                          "Revision restored. Previous versions are still in history.",
                        );
                      })
                    }
                  >
                    {t("Restore")}
                  </Button>
                </div>
              ))}
            </div>
          )}
          {dialog === "design" && (
            <Suspense fallback={<p>{t("Opening your studio…")}</p>}>
              <VoiceDesigner
                t={t}
                onSynced={setVoices}
                onActiveChange={(active) => {
                  recordingBusy.current = active;
                  setRecordingActive(active);
                }}
                onCreated={(voice) => {
                  setVoices((vs) => [
                    voice,
                    ...vs.filter((v) => v.id !== voice.id),
                  ]);
                  setNotice("Voice created and saved to your global library.");
                }}
              />
            </Suspense>
          )}
          {dialog === "clone" && (
            <VoiceWorkbench
              t={t}
              onSynced={setVoices}
              onActiveChange={(active) => {
                recordingBusy.current = active;
                setRecordingActive(active);
              }}
              onCreated={(voice) => {
                setVoices((vs) => [
                  voice,
                  ...vs.filter((v) => v.id !== voice.id),
                ]);
                setNotice(
                  voice.requiresVerification
                    ? "Voice saved. Complete verification in ElevenLabs before rendering."
                    : "Voice created and saved to your global library.",
                );
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
export default App;
