import { SelectField, SelectItem } from "./ui/select";
import { RecordingControls } from "./recording-controls";
import { Slider } from "@/components/ui/slider";
import { Checkbox } from "@/components/ui/checkbox";
import { useRef, useState } from "react";
import { AudioLines, Pause, Play, Square, Download } from "lucide-react";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Spinner } from "./ui/spinner";
import { api } from "@/lib/api";
import type { Take, PreparedAudio, Recording } from "@/lib/types";
import { translateError, type createTranslator } from "@/lib/i18n";
export function TakeCard({
  take,
  number,
  t,
  date,
  onUpdate,
  onError,
  anotherRender,
}: {
  take: Take;
  number: number;
  t: ReturnType<typeof createTranslator>;
  date: string;
  onUpdate: (take: Take) => void;
  onError: (e: string) => void;
  anotherRender: boolean;
}) {
  const [recording, setRecording] = useState<Recording>(
    take.script.performance?.recording ?? { style: "clean", ambience: 0 },
  );
  const [pauses, setPauses] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false),
    [audio, setAudio] = useState<PreparedAudio | null>(null),
    [seconds, setSeconds] = useState(0);
  const [ack, setAck] = useState(false),
    [pausing, setPausing] = useState(false);
  const player = useRef<HTMLAudioElement>(null);
  const preparedFor = useRef("");
  const [playing, setPlaying] = useState(false);
  const clock = (value: number) =>
    `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}`;
  const running = take.status === "rendering";
  const unknown =
    take.plan?.some(
      (j) => j.status === "unknown" || j.status === "requesting",
    ) || false;
  async function work(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  function resetPlayback() {
    player.current?.pause();
    setPlaying(false);
    setAudio(null);
    setSeconds(0);
  }
  async function playPrepared(automatic = false) {
    try {
      await player.current?.play();
    } catch (error) {
      // A delayed preparation can outlive the browser's user gesture. Leave the
      // transport ready for a direct click rather than reporting broken audio.
      if (error instanceof DOMException &&
          (error.name === "AbortError" || (automatic && error.name === "NotAllowedError"))) return;
      onError(t("Audio playback failed. Try exporting the take."));
    }
  }
  const cue = audio?.cues.find((c) => seconds >= c.start && seconds < c.end);
  return (
    <article className="take-card">
      <div className="take-heading">
        <AudioLines size={20} />
        <div>
          <h3>{t("Take {number}", { number })}</h3>
          <p>
            {date} · {t("{count} turns", { count: take.script.turns.length })}
          </p>
        </div>
        <Badge variant="outline">{t(take.status)}</Badge>
      </div>
      {take.script.performance && (
        <p className="small-note">
          {t("Delivery")}:{" "}
          {t(
            take.script.performance.stability === 0.5
              ? "Natural"
              : take.script.performance.stability === 0
                ? "Creative"
                : "Robust",
          )}{" "}
          · {t("Variation seed")}: {take.script.performance.seed ?? t("Random")}
        </p>
      )}
      {take.error && (
        <p className="take-error">{translateError(take.error, t)}</p>
      )}
      {!!take.plan?.length && (
        <div className="render-progress">
          <progress
            value={take.chunks.length}
            max={take.plan.length}
            aria-label={t("Render progress")}
          />
          <span>
            {take.chunks.length} / {take.plan.length} {t("parts complete")}
          </span>
        </div>
      )}
      {take.chunks.length > 0 && !running && (
        <details className="my-3">
          <summary className="cursor-pointer text-sm">
            {t("Preview and export sound")}
          </summary>
          <div className="mt-3">
            <RecordingControls
              t={t}
              value={recording}
              disabled={busy}
              onChange={(value) => {
                resetPlayback();
                setRecording(value);
              }}
            />
          </div>
          <details className="my-3">
            <summary className="cursor-pointer text-sm">
              {t("Additional pauses")}
            </summary>
            <div className="mt-3 max-h-72 space-y-3 overflow-y-auto">
              {take.script.turns.map((turn, i) => (
                <div key={turn.id} className="flex items-center gap-3">
                  <p
                    className="min-w-0 flex-1 truncate text-sm"
                    title={turn.text}
                  >
                    {i + 1}. {turn.text}
                  </p>
                  <SelectField
                    className="w-28 shrink-0"
                    aria-label={t("Pause after turn {number}", {
                      number: i + 1,
                    })}
                    disabled={busy}
                    value={String(pauses[turn.id] ?? turn.pauseAfterMs ?? 0)}
                    onValueChange={(value) => {
                      resetPlayback();
                      setPauses({ ...pauses, [turn.id]: Number(value) });
                    }}
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
                </div>
              ))}
            </div>
          </details>
          <p className="small-note">
            {t(
              "Preview/export only. No regeneration or API credits. The saved take stays unchanged.",
            )}
          </p>
        </details>
      )}
      <div className="take-actions">
        {running ? (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || pausing}
              onClick={() =>
                void work(async () => {
                  await api.controlRender(take.id, "pause");
                  setPausing(true);
                })
              }
            >
              <Pause className="size-3.5" />
              {t(pausing ? "Pausing after current part…" : "Pause")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void work(() => api.controlRender(take.id, "cancel"))
              }
            >
              <Square className="size-3.5" />
              {t("Cancel")}
            </Button>
          </>
        ) : (
          take.status !== "complete" && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || anotherRender || (unknown && !ack)}
              onClick={() =>
                void work(async () => {
                  setPausing(false);
                  onUpdate(await api.resume(take.id, ack));
                  setAck(false);
                })
              }
            >
              <Play className="size-3.5" />
              {t("Resume")}
            </Button>
          )
        )}
        {take.chunks.length > 0 && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void work(async () => {
                const source = JSON.stringify([take.status, take.chunks]);
                if (audio && preparedFor.current === source && player.current) {
                  await playPrepared();
                  return;
                }
                player.current?.pause();
                setAudio(await api.prepareTake(take.id, recording, pauses));
                preparedFor.current = source;
                setSeconds(0);
              })
            }
          >
            {busy ? <Spinner /> : <Play className="size-3.5" />}
            {t(
              take.status === "complete"
                ? "Play conversation"
                : "Play saved parts",
            )}
          </Button>
        )}
        {take.status === "complete" &&
          (["wav", "mp3"] as const).map((format) => (
            <Button
              key={format}
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                void work(async () => {
                  const { save } = await import("@tauri-apps/plugin-dialog");
                  const path = await save({
                    defaultPath: `convo-take-${number}.${format}`,
                    filters: [
                      { name: format.toUpperCase(), extensions: [format] },
                    ],
                  });
                  if (path)
                    await api.exportTake(take.id, path, recording, pauses);
                })
              }
            >
              <Download className="size-3.5" />
              {t("Export")} {format.toUpperCase()}
            </Button>
          ))}
      </div>
      {audio?.timing && (
        <p className="small-note">
          {t("Quiet intervals ≥180 ms")}: {audio.timing.quietIntervals.length} ·{" "}
          {t("Median")}: {Math.round(audio.timing.medianQuietMs)} ms ·{" "}
          {t("Energy estimate, not speaker gaps or a naturalness score.")}
        </p>
      )}
      {running && (
        <p className="small-note">
          {t(
            "Cancel stops local work. An in-flight request may still be billed.",
          )}
        </p>
      )}
      {!running && unknown && (
        <label className="consent">
          <Checkbox
            checked={ack}
            onCheckedChange={(checked) => setAck(checked === true)}
          />
          <span>
            {t(
              "Retry the uncertain part. I understand this may use additional credits.",
            )}
          </span>
        </label>
      )}
      {audio && (
        <div className="take-player">
          {audio.partial && (
            <p className="small-note">
              {t(
                "Preview contains completed parts only. Reload after rendering finishes.",
              )}
            </p>
          )}
          <audio
            ref={player}
            key={audio.src}
            preload="metadata"
            src={audio.src}
            onLoadedMetadata={() => void playPrepared(true)}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
            onError={() =>
              onError(t("Audio playback failed. Try exporting the take."))
            }
            onTimeUpdate={(e) => setSeconds(e.currentTarget.currentTime)}
          />
          <div className="conversation-transport">
            <Button
              size="icon"
              variant="ghost"
              aria-label={t(playing ? "Pause" : "Play")}
              onClick={() => {
                if (!player.current) return;
                if (playing) player.current.pause();
                else
                  void player.current
                    .play()
                    .catch(() =>
                      onError(
                        t("Audio playback failed. Try exporting the take."),
                      ),
                    );
              }}
            >
              {playing ? (
                <Pause className="size-4" />
              ) : (
                <Play className="size-4" />
              )}
            </Button>
            <span>{clock(seconds)}</span>
            <Slider
              aria-label={t("Playback position")}
              min={0}
              max={audio.duration}
              step={0.1}
              value={[Math.min(seconds, audio.duration)]}
              onValueChange={([value]) => {
                if (player.current) {
                  player.current.currentTime = value;
                  setSeconds(value);
                }
              }}
            />
            <span>{clock(audio.duration)}</span>
          </div>
          <div className="playback-transcript">
            {take.script.turns.map((turn, index) => {
              const timing = audio.cues.find((c) => c.turn === index);
              const name = take.script.speakers.find(
                (s) => s.id === turn.speakerId,
              )?.name;
              return (
                <button
                  key={turn.id}
                  className={cue?.turn === index ? "active" : ""}
                  disabled={!timing}
                  aria-current={cue?.turn === index ? "true" : undefined}
                  onClick={() => {
                    if (player.current && timing) {
                      player.current.currentTime = timing.start;
                      void player.current
                        .play()
                        .catch(() =>
                          onError(
                            t("Audio playback failed. Try exporting the take."),
                          ),
                        );
                    }
                  }}
                >
                  <strong>{name}</strong>
                  <span>{turn.text}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </article>
  );
}
