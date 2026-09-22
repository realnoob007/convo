import { useEffect, useState } from "react";
import { WandSparkles, Check } from "lucide-react";
import { api } from "@/lib/api";
import {
  defaultDesign,
  designPrompt,
  type DesignDraft,
  type DesignState,
} from "@/lib/voice-design";
import type { Voice } from "@/lib/types";
import { translateError, type createTranslator } from "@/lib/i18n";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { SelectField, SelectItem } from "./ui/select";
import { Slider } from "./ui/slider";
import { Checkbox } from "./ui/checkbox";
import { Spinner } from "./ui/spinner";

const draftKey = "convo-voice-design-v1";
function loadDraft(): DesignDraft {
  try {
    const saved = JSON.parse(localStorage.getItem(draftKey) || "null");
    if (
      saved &&
      Object.entries(defaultDesign).every(
        ([key, value]) => typeof saved[key] === typeof value,
      )
    )
      return saved;
  } catch {
    /* Start with a usable template if the local draft is unavailable. */
  }
  return { ...defaultDesign };
}
export function VoiceDesigner({
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
  const [draft, setDraft] = useState(loadDraft);
  const [state, setState] = useState<DesignState>({
    batch: null,
    attempt: null,
  });
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [synced, setSynced] = useState(false);
  const description = designPrompt(draft);
  const count = [...description].length,
    textCount = [...draft.text.trim()].length;
  const unknown =
    state.attempt?.state === "unknown" || state.attempt?.state === "requesting";
  useEffect(() => {
    let active = true;
    api
      .designState()
      .then((value) => {
        if (active) {
          setState(value);
          setReady(true);
        }
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, []);
  function update(value: Partial<DesignDraft>) {
    const next = { ...draft, ...value };
    setDraft(next);
    try {
      localStorage.setItem(draftKey, JSON.stringify(next));
    } catch {
      setError("Voice draft could not be saved locally.");
    }
  }
  async function work(label: string, action: () => Promise<void>) {
    if (busy) return;
    setBusy(label);
    setError("");
    onActiveChange(true);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      try {
        setState(await api.designState());
      } catch (e) {
        setError(String(e));
      }
      setBusy("");
      onActiveChange(false);
    }
  }
  const disabled = !!busy || !ready;
  return (
    <div className="clone-form">
      <div className="grid gap-4 sm:grid-cols-2">
        {(
          [
            ["language", "Language and dialect"],
            ["character", "Gender and age"],
            ["persona", "Persona"],
            ["emotion", "Emotion"],
          ] as const
        ).map(([key, label]) => (
          <label key={key}>
            {t(label)}
            <Input
              value={draft[key]}
              maxLength={150}
              disabled={disabled}
              onChange={(e) => update({ [key]: e.target.value })}
            />
          </label>
        ))}
      </div>
      <label>
        {t("Voice quality")}
        <SelectField
          value={draft.quality}
          disabled={disabled}
          onValueChange={(quality) => update({ quality })}
        >
          {["Ok", "Good", "Excellent", "Studio"].map((q) => (
            <SelectItem key={q} value={q}>
              {t(q)}
            </SelectItem>
          ))}
        </SelectField>
      </label>
      <label>
        {t("Timbre, pacing and delivery")}
        <Textarea
          value={draft.delivery}
          maxLength={600}
          disabled={disabled}
          onChange={(e) => update({ delivery: e.target.value })}
        />
      </label>
      <p className="small-note">
        {t(
          "Describe the voice and its delivery here. Add phone effects and room tone in Recording style.",
        )}
      </p>
      <details>
        <summary className="cursor-pointer text-sm">
          {t("Voice prompt")} · {count}/1000
        </summary>
        <p className="mt-3 whitespace-pre-wrap rounded-lg border p-3 text-sm">
          {description}
        </p>
      </details>
      <label>
        {t("Preview text")}
        <Textarea
          value={draft.text}
          maxLength={1000}
          disabled={disabled}
          onChange={(e) => update({ text: e.target.value })}
          placeholder={t(
            "Leave empty for a preview written to match this voice.",
          )}
        />
      </label>
      <p className="small-note">
        {t(
          "Use 100–1000 characters. Match the preview's emotion to the voice you want.",
        )}
      </p>
      <div className="space-y-3">
        <p className="flex justify-between text-sm">
          <span>{t("Prompt guidance")}</span>
          <span>{draft.guidance}</span>
        </p>
        <Slider
          aria-label={t("Prompt guidance")}
          value={[draft.guidance]}
          min={0}
          max={100}
          step={1}
          disabled={disabled}
          onValueChange={([guidance]) => update({ guidance })}
        />
        <p className="small-note">
          {t(
            "Higher guidance follows the prompt more closely, but can sound robotic. Start low with a detailed description.",
          )}
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {translateError(error, t)}
        </p>
      )}
      {unknown && (
        <div className="space-y-3 rounded-lg border p-4 text-sm">
          <p>
            {t(
              "The previous request has an uncertain outcome. No automatic retry was made. Review your ElevenLabs usage and sync voices before trying again.",
            )}
          </p>
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() =>
              void work("Syncing voices", async () => {
                onSynced(await api.refreshVoices());
                setSynced(true);
              })
            }
          >
            {t("Sync ElevenLabs voices")}
          </Button>
          <label className="flex items-center gap-2">
            <Checkbox
              checked={reviewed}
              disabled={disabled}
              onCheckedChange={(v) => setReviewed(v === true)}
            />
            {t(
              "I reviewed the previous attempt and accept a possible duplicate charge or voice.",
            )}
          </label>
          <Button
            variant="outline"
            disabled={disabled || !reviewed || !synced}
            onClick={() =>
              void work("Reviewing attempt", async () => {
                await api.acknowledgeDesignRetry();
                setReviewed(false);
                setSynced(false);
              })
            }
          >
            {t("Allow another attempt")}
          </Button>
        </div>
      )}
      <Button
        disabled={
          disabled ||
          unknown ||
          count < 20 ||
          count > 1000 ||
          (textCount > 0 && textCount < 100)
        }
        onClick={() =>
          void work("Generating voice previews", async () => {
            await api.designVoice({
              description,
              text: draft.text,
              guidance: draft.guidance,
            });
          })
        }
      >
        {busy === "Generating voice previews" ? (
          <Spinner data-icon="inline-start" />
        ) : (
          <WandSparkles data-icon="inline-start" />
        )}
        {t("Generate voice previews")}
      </Button>
      <p className="small-note">
        {t(
          "Preview generation uses ElevenLabs credits. Saving a chosen voice uses a voice slot.",
        )}
      </p>
      {state.batch && (
        <div className="space-y-4 border-t pt-5">
          <h3 className="font-medium">{t("Voice previews")}</h3>
          <details>
            <summary className="cursor-pointer text-sm">
              {t("Prompt used for these previews")}
            </summary>
            <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
              {state.batch.request.description}
            </p>
          </details>
          <p className="text-sm text-muted-foreground">
            {state.batch.result.text}
          </p>
          <label>
            {t("Voice name")}
            <Input
              value={draft.name}
              maxLength={100}
              disabled={disabled}
              onChange={(e) => update({ name: e.target.value })}
            />
          </label>
          {state.batch.result.previews.map((preview, index) => {
            const saved = state.batch?.saved?.[preview.generated_voice_id];
            return (
              <div
                key={preview.generated_voice_id}
                className="space-y-3 rounded-lg border p-3"
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm">
                    {t("Preview {count}", { count: index + 1 })}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={
                      disabled || unknown || !!saved || !draft.name.trim()
                    }
                    onClick={() =>
                      void work("Saving designed voice", async () => {
                        onCreated(
                          await api.saveDesignedVoice(
                            preview.generated_voice_id,
                            draft.name,
                          ),
                        );
                      })
                    }
                  >
                    {saved && <Check data-icon="inline-start" />}
                    {t(saved ? "Saved" : "Save voice")}
                  </Button>
                </div>
                <audio
                  className="w-full"
                  controls
                  preload="none"
                  aria-label={t("Preview {count}", { count: index + 1 })}
                  src={`data:audio/mpeg;base64,${preview.audio_base_64}`}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
