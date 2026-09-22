import { useEffect, useState } from "react";
import { api, desktop } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { SelectField, SelectItem } from "@/components/ui/select";

export type TextConnection = {
  config: { baseUrl: string; apiStyle: "responses" | "chatCompletions" };
  configured: boolean;
};

export function TextConnectionSettings({
  t,
  disabled,
  onSaved,
}: {
  t: (text: string) => string;
  disabled: boolean;
  onSaved: (configured: boolean) => void;
}) {
  const [config, setConfig] = useState<TextConnection["config"]>({
    baseUrl: "https://api.openai.com/v1",
    apiStyle: "responses",
  });
  const [key, setKey] = useState("");
  const [ready, setReady] = useState(!desktop);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (!desktop) return;
    let active = true;
    api
      .textConnection()
      .then((result) => {
        if (active) {
          setConfig(result.config);
          setReady(true);
        }
      })
      .catch((error) => {
        if (active) setMessage(String(error));
      });
    return () => {
      active = false;
    };
  }, []);
  const locked = disabled || saving || !ready || !desktop;
  return (
    <fieldset disabled={locked} className="space-y-3">
      <legend className="mb-3 font-medium">
        {t("OpenAI-compatible text provider")}
      </legend>
      <label className="block">
        {t("API base URL")}
        <Input
          value={config.baseUrl}
          onChange={(e) => setConfig({ ...config, baseUrl: e.target.value })}
          placeholder="https://api.openai.com/v1"
          autoComplete="off"
        />
      </label>
      <label className="block">
        {t("API format")}
        <SelectField
          value={config.apiStyle}
          disabled={locked}
          onValueChange={(apiStyle) =>
            setConfig({
              ...config,
              apiStyle: apiStyle as TextConnection["config"]["apiStyle"],
            })
          }
        >
          <SelectItem value="responses">Responses</SelectItem>
          <SelectItem value="chatCompletions">Chat Completions</SelectItem>
        </SelectField>
      </label>
      <label className="block">
        {t("API key")}
        <Input
          type="password"
          autoComplete="off"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={t("Leave blank to keep this endpoint's saved key")}
        />
      </label>
      <p className="small-note">
        {t(
          "Changing the address requires a new key. Local HTTP endpoints may omit a key. The model must support structured JSON output.",
        )}
      </p>
      <Button
        disabled={locked || !config.baseUrl.trim()}
        onClick={async () => {
          setSaving(true);
          setMessage("");
          try {
            const result = await api.saveTextConnection(config, key);
            setConfig(result.config);
            setKey("");
            onSaved(result.configured);
            setMessage("Connection saved. Select your model in the studio.");
          } catch (error) {
            setMessage(String(error));
          } finally {
            setSaving(false);
          }
        }}
      >
        {t(saving ? "Saving" : "Save connection")}
      </Button>
      {message && (
        <p role="status" className="small-note">
          {t(message)}
        </p>
      )}
    </fieldset>
  );
}
