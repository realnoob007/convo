import { useState } from "react";
import { Button } from "./ui/button";
import { Spinner } from "./ui/spinner";
import { api, desktop } from "@/lib/api";
import { translateError, type createTranslator } from "@/lib/i18n";
export function ReferenceAudio({
  t,
}: {
  t: ReturnType<typeof createTranslator>;
}) {
  const [reference, setReference] = useState<Awaited<
    ReturnType<typeof api.analyzeReference>
  > | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <div className="rounded-lg border border-border p-3 space-y-3">
      <Button
        size="sm"
        variant="outline"
        disabled={!desktop || busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            const { open } = await import("@tauri-apps/plugin-dialog");
            const path = await open({
              multiple: false,
              filters: [
                {
                  name: t("Audio samples"),
                  extensions: ["wav", "mp3", "m4a", "flac"],
                },
              ],
            });
            if (typeof path === "string")
              setReference(await api.analyzeReference(path));
          } catch (e) {
            setError(String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy && <Spinner />}
        {t("Compare with a recording")}
      </Button>
      <p className="small-note">
        {t("Analyzed locally. Your reference recording is not uploaded.")}
      </p>
      {reference && (
        <>
          <p className="text-sm break-all">
            {reference.name} · {Math.round(reference.timing.duration)} s
          </p>
          <audio
            className="w-full"
            controls
            src={reference.src}
            aria-label={t("Reference recording")}
          />
          <p className="small-note">
            {t("Quiet intervals ≥180 ms")}:{" "}
            {reference.timing.quietIntervals.length} · {t("Median")}:{" "}
            {Math.round(reference.timing.medianQuietMs)} ms
          </p>
          <p className="small-note">
            {t("Energy estimate, not speaker gaps or a naturalness score.")}
          </p>
        </>
      )}
      {error && (
        <p role="alert" className="take-error">
          {translateError(error, t)}
        </p>
      )}
    </div>
  );
}
