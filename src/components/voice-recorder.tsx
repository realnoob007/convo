import { SelectField, SelectItem } from "@/components/ui/select";
import { useEffect, useRef, useState } from "react";
import { Mic, Square, X } from "lucide-react";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";
import { api, desktop } from "@/lib/api";
import {
  MAX_RECORDING_SECONDS,
  MicrophoneRecorder,
  blobBase64,
  recordingError,
  recordingToWav,
} from "@/lib/recording";
import type { createTranslator } from "@/lib/i18n";
import type { VoiceSample } from "@/lib/types";

export function VoiceRecorder({
  t,
  disabled,
  remainingBytes,
  onSaved,
  onActiveChange,
}: {
  t: ReturnType<typeof createTranslator>;
  disabled: boolean;
  remainingBytes: number;
  onSaved: (sample: VoiceSample) => void;
  onActiveChange: (active: boolean) => void;
}) {
  const [phase, setPhase] = useState<
    "idle" | "permission" | "recording" | "saving" | "retry"
  >("idle");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [level, setLevel] = useState(0);
  useEffect(() => {
    const media = navigator.mediaDevices;
    if (!media?.enumerateDevices) return;
    let active = true;
    const refresh = () =>
      void media
        .enumerateDevices()
        .then((items) => {
          if (active) setDevices(items.filter((d) => d.kind === "audioinput"));
        })
        .catch(() => {});
    refresh();
    media.addEventListener("devicechange", refresh);
    return () => {
      active = false;
      media.removeEventListener("devicechange", refresh);
    };
  }, [phase]);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<Blob | null>(null);
  const capture = useRef<MicrophoneRecorder | null>(null);
  const interval = useRef<ReturnType<typeof setInterval> | null>(null);
  const finishing = useRef(false);
  const limit = useRef(MAX_RECORDING_SECONDS);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      capture.current?.cancel();
      if (interval.current) clearInterval(interval.current);
    };
  }, []);
  function clearTimer() {
    if (interval.current) clearInterval(interval.current);
    interval.current = null;
  }
  function idle() {
    setPhase("idle");
    onActiveChange(false);
  }
  async function persist(wav: Blob) {
    setPhase("saving");
    try {
      if (wav.size > remainingBytes)
        throw Error("Samples must be nonempty files totaling at most 50 MB");
      const sample = await api.saveRecording(await blobBase64(wav));
      if (!mounted.current) return;
      onSaved(sample);
      setDraft(null);
      setError("");
      idle();
    } catch (e) {
      if (!mounted.current) return;
      setError(recordingError(e));
      setDraft(wav);
      setPhase("retry");
    }
  }
  async function finish(current: MicrophoneRecorder) {
    if (!mounted.current || capture.current !== current || finishing.current)
      return;
    finishing.current = true;
    clearTimer();
    setPhase("saving");
    try {
      const blob = await current.stop();
      const wav = await recordingToWav(blob, limit.current);
      if (mounted.current && capture.current === current) await persist(wav);
    } catch (e) {
      if (mounted.current) {
        setError(recordingError(e));
        idle();
      }
    } finally {
      if (capture.current === current) capture.current = null;
      finishing.current = false;
    }
  }
  async function start() {
    if (capture.current || phase !== "idle") return;
    limit.current = Math.min(
      MAX_RECORDING_SECONDS,
      Math.floor((remainingBytes - 44) / 88200),
    );
    setError("");
    setSeconds(0);
    setPhase("permission");
    onActiveChange(true);
    const current = new MicrophoneRecorder();
    capture.current = current;
    try {
      const started = await current.start(() => {
        void finish(current);
      }, deviceId);
      if (!mounted.current || capture.current !== current || !started) return;
      setPhase("recording");
      const began = performance.now();
      interval.current = setInterval(() => {
        const elapsed = Math.floor((performance.now() - began) / 1000);
        setSeconds(Math.min(limit.current, elapsed));
        setLevel(current.level());
        if (elapsed >= limit.current) void finish(current);
      }, 250);
    } catch (e) {
      if (mounted.current && capture.current === current) {
        capture.current = null;
        setError(recordingError(e));
        idle();
      }
    }
  }
  function discard() {
    const previous = capture.current;
    capture.current = null;
    previous?.cancel();
    clearTimer();
    setDraft(null);
    setError("");
    idle();
  }
  return (
    <section className="recorder-panel" aria-label={t("Record samples")}>
      <div className="recorder-heading">
        <Mic size={17} />
        <strong>{t("Record samples")}</strong>
        <span
          className={
            phase === "recording" ? "recording-clock active" : "recording-clock"
          }
          role="timer"
        >
          {String(Math.floor(seconds / 60)).padStart(2, "0")}:
          {String(seconds % 60).padStart(2, "0")}
        </span>
      </div>
      <p className="small-note">
        {t(
          "Record several clips in your natural voice. Each clip can be up to 3 minutes.",
        )}
      </p>
      {devices.length > 0 && (
        <label className="microphone-select">
          {t("Microphone")}
          <SelectField
            aria-label={t("Microphone")}
            value={deviceId}
            disabled={phase !== "idle" || disabled}
            onValueChange={(value) => setDeviceId(value)}
          >
            <SelectItem value="">{t("System default")}</SelectItem>
            {devices
              .filter((device) => device.deviceId)
              .map((device, index) => (
                <SelectItem key={device.deviceId} value={device.deviceId}>
                  {device.label || `${t("Microphone")} ${index + 1}`}
                </SelectItem>
              ))}
          </SelectField>
        </label>
      )}
      {phase === "recording" && (
        <div
          role="meter"
          aria-label={t("Input level")}
          aria-valuemin={0}
          aria-valuemax={1}
          aria-valuenow={level}
          className="input-meter"
        >
          <span style={{ width: `${level * 100}%` }} />
        </div>
      )}
      <div className="recorder-actions" aria-live="polite">
        {phase === "idle" && (
          <Button
            variant="outline"
            size="sm"
            className="rounded-lg"
            disabled={!desktop || disabled || remainingBytes < 88244}
            onClick={() => void start()}
          >
            <Mic data-icon="inline-start" className="size-3.5" />
            {t("Start")}
          </Button>
        )}
        {phase === "permission" && (
          <>
            <Button
              variant="outline"
              size="sm"
              className="rounded-lg"
              disabled
              aria-busy="true"
            >
              <Spinner data-icon="inline-start" />
              {t("Waiting for microphone access…")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="rounded-lg text-muted-foreground"
              onClick={discard}
            >
              <X data-icon="inline-start" className="size-3.5" />
              {t("Cancel")}
            </Button>
          </>
        )}
        {phase === "recording" && (
          <>
            <Button
              variant="outline"
              size="sm"
              className="rounded-lg"
              onClick={() => capture.current && void finish(capture.current)}
            >
              <Square
                data-icon="inline-start"
                className="size-3"
                fill="currentColor"
                strokeWidth={0}
              />
              {t("Stop & save clip")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="rounded-lg text-muted-foreground"
              onClick={discard}
            >
              {t("Discard recording")}
            </Button>
          </>
        )}
        {phase === "saving" && (
          <Button
            variant="outline"
            size="sm"
            className="rounded-lg"
            disabled
            aria-busy="true"
          >
            <Spinner data-icon="inline-start" />
            {t("Saving recording…")}
          </Button>
        )}
        {phase === "retry" && (
          <>
            <Button
              variant="outline"
              size="sm"
              className="rounded-lg"
              onClick={() => draft && void persist(draft)}
            >
              {t("Retry save")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="rounded-lg text-muted-foreground"
              onClick={discard}
            >
              {t("Discard recording")}
            </Button>
          </>
        )}
      </div>
      {error && (
        <p role="alert" className="take-error">
          {t(error)}
        </p>
      )}
      <p className="small-note">
        {t(
          desktop
            ? "Recordings stay on this device until removed. Only Create voice uploads the selected samples."
            : "Recording is available in the desktop app.",
        )}
      </p>
    </section>
  );
}
