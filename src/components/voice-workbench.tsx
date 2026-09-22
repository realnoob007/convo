import { Disclosure } from "@/components/ui/collapsible";
import { Checkbox } from "@/components/ui/checkbox";
import { useEffect, useRef, useState } from "react";
import { Mic2, Trash2, Upload, X } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Spinner } from "./ui/spinner";
import { VoiceRecorder } from "./voice-recorder";
import { api, desktop } from "@/lib/api";
import { MAX_SAMPLE_BYTES } from "@/lib/recording";
import {
  emptyVoiceDraft,
  recoverVoiceDraft,
  voiceDraftKey,
} from "@/lib/voice-draft";
import type { Voice, VoiceDraft, VoiceSample } from "@/lib/types";
import { translateError, type createTranslator } from "@/lib/i18n";
const errorMessage = (e: unknown) =>
  e instanceof Error ? e.message : String(e);
export function VoiceWorkbench({
  t,
  onActiveChange,
  onCreated,
  onSynced,
}: {
  t: ReturnType<typeof createTranslator>;
  onActiveChange: (active: boolean) => void;
  onCreated: (voice: Voice) => void;
  onSynced: (voices: Voice[]) => void;
}) {
  const [draft, setDraft] = useState<VoiceDraft>(emptyVoiceDraft);
  const [library, setLibrary] = useState<VoiceSample[]>([]);
  const [ready, setReady] = useState(false),
    [busy, setBusy] = useState("");
  const [recording, setRecording] = useState(false),
    [consent, setConsent] = useState(false);
  const [error, setError] = useState("");
  const [player, setPlayer] = useState<{ path: string; src: string } | null>(
    null,
  );
  const [trash, setTrash] = useState<VoiceSample[]>([]);
  const [removed, setRemoved] = useState<VoiceSample | null>(null);
  const [unknown, setUnknown] = useState(false),
    [reviewed, setReviewed] = useState(false);
  const [matches, setMatches] = useState<Voice[]>([]);
  const [quality, setQuality] = useState<
    Record<string, { duration: number; silent: number; clipped: number }>
  >({});
  const persist = useRef(Promise.resolve());
  const samples = draft.samples;
  const bytes = samples.reduce((sum, s) => sum + s.bytes, 0);
  useEffect(() => {
    let active = true;
    Promise.all([
      api.voiceDraft(),
      api.recordings(),
      api.cloneStatus(),
      api.recordingTrash(),
    ])
      .then(([saved, recordings, status, deleted]) => {
        let local: unknown = null;
        try {
          local = JSON.parse(localStorage.getItem(voiceDraftKey) || "null");
        } catch {
          /* Recover from SQLite. */
        }
        if (active) {
          setDraft(recoverVoiceDraft(local, saved));
          setLibrary(recordings);
          setTrash(deleted);
          setUnknown(
            status.state === "unknown" || status.state === "requesting",
          );
          setReady(true);
        }
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      });
    return () => {
      active = false;
    };
  }, []);
  function update(next: VoiceDraft) {
    next = { ...next, updatedAt: Date.now() };
    setDraft(next);
    try {
      localStorage.setItem(voiceDraftKey, JSON.stringify(next));
    } catch {
      setError("Voice draft could not be saved locally.");
    }
    persist.current = persist.current
      .catch(() => {})
      .then(() => api.saveVoiceDraft(next));
    void persist.current.catch(() =>
      setError("Voice draft could not be saved locally."),
    );
  }
  async function work(label: string, action: () => Promise<void>) {
    if (busy || recording) return;
    setBusy(label);
    setError("");
    onActiveChange(true);
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
      onActiveChange(false);
    }
  }
  function add(sample: VoiceSample) {
    if (samples.some((s) => s.path === sample.path)) return;
    if (samples.length >= 10 || bytes + sample.bytes > MAX_SAMPLE_BYTES) {
      setError("Samples must be nonempty files totaling at most 50 MB");
      return;
    }
    update({ ...draft, samples: [...samples, sample] });
  }
  async function importSamples() {
    if (!desktop)
      throw Error("Audio sample import is available in the desktop app.");
    const { open } = await import("@tauri-apps/plugin-dialog");
    const paths = await open({
      multiple: true,
      filters: [
        { name: t("Audio samples"), extensions: ["wav", "mp3", "m4a", "flac"] },
      ],
    });
    if (!paths) return;
    const all = [
      ...new Set([
        ...samples.map((s) => s.path),
        ...(Array.isArray(paths) ? paths : [paths]),
      ]),
    ];
    const inspected = await api.inspectSamples(all);
    update({
      ...draft,
      samples: inspected.map(
        (s) => samples.find((old) => old.path === s.path) || s,
      ),
    });
  }
  async function create() {
    await persist.current;
    await api.inspectSamples(samples.map((s) => s.path));
    try {
      const voice = await api.createVoice(
        draft.name,
        draft.description,
        samples.map((s) => s.path),
        consent,
      );
      update(emptyVoiceDraft());
      setConsent(false);
      onCreated(voice);
    } finally {
      const status = await api.cloneStatus();
      setUnknown(status.state === "unknown" || status.state === "requesting");
      setReviewed(false);
    }
  }
  const durationKnown = samples.every(
    (s) => quality[s.path] || s.duration != null,
  );
  const duration = samples.reduce(
    (sum, s) => sum + (quality[s.path]?.duration || s.duration || 0),
    0,
  );
  return (
    <div className="clone-form">
      <label>
        {t("Voice name")}
        <Input
          disabled={!ready || !!busy}
          value={draft.name}
          maxLength={100}
          onChange={(e) => update({ ...draft, name: e.target.value })}
          placeholder={t("e.g. Alex — warm & conversational")}
        />
      </label>
      <label>
        {t("Description")}
        <Textarea
          disabled={!ready || !!busy}
          value={draft.description}
          onChange={(e) => update({ ...draft, description: e.target.value })}
          placeholder={t("Accent, tone, and personality")}
        />
      </label>
      <VoiceRecorder
        t={t}
        disabled={!ready || !!busy || samples.length >= 10}
        remainingBytes={MAX_SAMPLE_BYTES - bytes}
        onSaved={(sample) => {
          setLibrary((items) => [...items, sample]);
          add(sample);
        }}
        onActiveChange={(active) => {
          setRecording(active);
          onActiveChange(active);
          if (active) setPlayer(null);
        }}
      />
      <Button
        variant="outline"
        disabled={!ready || !!busy || recording || samples.length >= 10}
        onClick={() => void work("Selecting samples", importSamples)}
      >
        <Upload className="size-4" />
        {t("Choose audio samples")}
      </Button>
      {library.length > 0 && (
        <Disclosure
          title={
            <>
              {t("Saved recordings")} · {library.length}
            </>
          }
        >
          <p className="small-note">
            {t("Select recordings of this person only.")}
          </p>
          {library.map((sample) => (
            <div className="sample-library-row" key={sample.path}>
              <label>
                <Checkbox
                  disabled={!!busy || recording}
                  checked={samples.some((s) => s.path === sample.path)}
                  onCheckedChange={(checked) =>
                    checked === true
                      ? add(sample)
                      : update({
                          ...draft,
                          samples: samples.filter(
                            (s) => s.path !== sample.path,
                          ),
                        })
                  }
                />
                {sample.name}
              </label>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("Move recording to trash")}
                disabled={!!busy || recording}
                onClick={() =>
                  void work("Updating samples", async () => {
                    if (!sample.id) return;
                    await api.removeRecording(sample.id);
                    setRemoved(sample);
                    setTrash((items) => [...items, sample]);
                    setLibrary((items) =>
                      items.filter((s) => s.id !== sample.id),
                    );
                    update({
                      ...draft,
                      samples: samples.filter((s) => s.path !== sample.path),
                    });
                    setPlayer(null);
                  })
                }
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
        </Disclosure>
      )}
      {removed && (
        <div className="sample-library-row">
          <span>{t("Recording moved to trash")}</span>
          <Button
            size="sm"
            variant="outline"
            disabled={!!busy || recording}
            onClick={() =>
              void work("Updating samples", async () => {
                await api.restoreRecording(removed.id!);
                setLibrary(await api.recordings());
                setTrash(await api.recordingTrash());
                setRemoved(null);
              })
            }
          >
            {t("Undo")}
          </Button>
        </div>
      )}
      {trash.length > 0 && (
        <Disclosure
          title={
            <>
              {t("Recording trash")} · {trash.length}
            </>
          }
        >
          {trash.map((sample) => (
            <div className="sample-library-row" key={sample.id}>
              <span>{sample.name}</span>
              <Button
                size="sm"
                variant="ghost"
                disabled={!!busy || recording}
                onClick={() =>
                  void work("Updating samples", async () => {
                    await api.restoreRecording(sample.id!);
                    setLibrary(await api.recordings());
                    setTrash(await api.recordingTrash());
                    setRemoved(null);
                  })
                }
              >
                {t("Restore")}
              </Button>
            </div>
          ))}
        </Disclosure>
      )}
      {samples.length > 0 && (
        <div className="recorded-samples">
          <p className="small-note">
            {t("{count} samples · {size} MB / 50 MB", {
              count: samples.length,
              size: (bytes / 1048576).toFixed(1),
            })}{" "}
            ·{" "}
            {durationKnown
              ? `${Math.floor(duration / 60)}:${String(Math.floor(duration % 60)).padStart(2, "0")}`
              : t("Analyze samples for total duration")}
          </p>
          {samples.some((sample) => sample.bytes > 10 * 1024 * 1024) && (
            <p className="small-note">
              {t(
                "Long in-app recordings are uploaded in smaller, lossless parts. Your saved originals stay unchanged.",
              )}
            </p>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={!!busy || recording}
            onClick={() =>
              void work("Analyzing samples", async () => {
                const results = await Promise.all(
                  samples.map(
                    async (s) =>
                      [s.path, await api.sampleQuality(s.path)] as const,
                  ),
                );
                setQuality(Object.fromEntries(results));
              })
            }
          >
            {t("Check sample quality")}
          </Button>
          {samples.map((sample, index) => (
            <div className="recorded-sample" key={sample.path}>
              <div className="sample-summary">
                <strong>{sample.name}</strong>
                <span>{(sample.bytes / 1048576).toFixed(1)} MB</span>
                {quality[sample.path] && (
                  <span>
                    {t(
                      quality[sample.path].silent > 0.8
                        ? "Mostly silence. Try a clearer recording."
                        : quality[sample.path].clipped > 0.01
                          ? "Audio is clipping. Lower microphone gain."
                          : "Sample check passed",
                    )}
                  </span>
                )}
              </div>
              <Button
                variant="ghost"
                size="sm"
                disabled={!!busy || recording}
                onClick={() =>
                  void work("Loading audio", async () =>
                    setPlayer({
                      path: sample.path,
                      src: await api.previewSample(sample.path),
                    }),
                  )
                }
              >
                {t("Listen")}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                disabled={!!busy || recording}
                aria-label={t("Remove sample {number}", { number: index + 1 })}
                onClick={() => {
                  update({
                    ...draft,
                    samples: samples.filter((s) => s.path !== sample.path),
                  });
                  setPlayer(null);
                }}
              >
                <X className="size-3.5" />
              </Button>
              {player?.path === sample.path && (
                <audio
                  controls
                  autoPlay
                  src={player.src}
                  aria-label={t("Sample playback")}
                />
              )}
            </div>
          ))}
        </div>
      )}
      {unknown && (
        <div className="recovery-panel">
          <p>
            {t(
              "The previous request may have created a voice. Sync and review before retrying.",
            )}
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={!!busy || recording}
            onClick={() =>
              void work("Syncing voices", async () => {
                const voices = await api.refreshVoices();
                onSynced(voices);
                setMatches(voices.filter((v) => v.name === draft.name));
                setReviewed(true);
              })
            }
          >
            {t("Sync ElevenLabs voices")}
          </Button>
          {reviewed && (
            <>
              <p>
                {t("Matching voices")}:{" "}
                {matches.map((v) => `${v.name} (${v.id})`).join(", ") ||
                  t("None")}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void work("Updating samples", async () => {
                    await api.acknowledgeCloneRetry();
                    setUnknown(false);
                  })
                }
              >
                {t("Reviewed. Allow another creation request.")}
              </Button>
            </>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="take-error">
          {translateError(error, t)}
        </p>
      )}
      <label className="consent">
        <Checkbox
          checked={consent}
          disabled={!!busy}
          onCheckedChange={(checked) => setConsent(checked === true)}
        />
        <span>
          {t(
            "I own this voice or have the speaker’s permission to clone and use it.",
          )}
        </span>
      </label>
      <Button
        disabled={
          !ready ||
          !!busy ||
          recording ||
          !draft.name.trim() ||
          !samples.length ||
          !consent ||
          unknown
        }
        onClick={() => void work("Creating your voice", create)}
      >
        {busy === "Creating your voice" ? (
          <Spinner />
        ) : (
          <Mic2 className="size-4" />
        )}
        {t(
          busy === "Creating your voice"
            ? "Creating your voice"
            : "Create voice & save globally",
        )}
      </Button>
      {busy === "Creating your voice" && (
        <>
          <p className="small-note">
            {t("Uploading selected samples and creating your voice…")}
          </p>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void api
                .cancelVoiceCreation()
                .catch((e) => setError(errorMessage(e)))
            }
          >
            {t("Cancel")}
          </Button>
        </>
      )}
    </div>
  );
}
