import { useState } from "react";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { Spinner } from "./ui/spinner";
import { api, desktop } from "@/lib/api";
import type { Voice } from "@/lib/types";
import type { createTranslator } from "@/lib/i18n";
export function VoiceAudition({
  voice,
  t,
  disabled,
}: {
  voice: Voice;
  t: ReturnType<typeof createTranslator>;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false);
  const [text, setText] = useState(
    "I wasn't expecting to see you here. It's good to hear your voice again.",
  );
  const [src, setSrc] = useState(""),
    [error, setError] = useState("");
  return (
    <div className="voice-audition">
      <Button
        size="sm"
        variant="outline"
        disabled={disabled || voice.requiresVerification || !desktop}
        onClick={() => setOpen(!open)}
      >
        {t("Audition voice")}
      </Button>
      {open && (
        <>
          <Textarea
            aria-label={t("Audition text")}
            maxLength={300}
            value={text}
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
          />
          <p className="small-note">
            {t("English preview · Eleven v3 · uses API credits")}
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !text.trim()}
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                setSrc((await api.audition(voice.id, text)).src);
              } catch (e) {
                setError(String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy && <Spinner />}
            {t("Generate preview")}
          </Button>
          {error && (
            <p role="alert" className="take-error">
              {t(error)}
            </p>
          )}
          {src && (
            <audio
              controls
              src={src}
              autoPlay
              aria-label={t("Voice preview")}
            />
          )}
        </>
      )}
    </div>
  );
}
