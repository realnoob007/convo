import { SelectField, SelectItem } from "./ui/select";
import { Slider } from "./ui/slider";
import type { Recording } from "@/lib/types";
import type { createTranslator } from "@/lib/i18n";

export function RecordingControls({
  value,
  onChange,
  disabled,
  t,
}: {
  value: Recording;
  onChange: (value: Recording) => void;
  disabled?: boolean;
  t: ReturnType<typeof createTranslator>;
}) {
  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <label className="space-y-2 text-sm">
        <span>{t("Recording style")}</span>
        <SelectField
          aria-label={t("Recording style")}
          value={value.style}
          disabled={disabled}
          onValueChange={(style) =>
            onChange({
              ...value,
              style: style as Recording["style"],
              ...(style === "phoneRoom" && value.distance === undefined
                ? { distance: 65 }
                : {}),
            })
          }
        >
          <SelectItem value="clean">{t("Clean recording")}</SelectItem>
          <SelectItem value="phoneRoom">{t("Phone in a room")}</SelectItem>
          <SelectItem value="phoneCall">{t("Telephone call")}</SelectItem>
        </SelectField>
      </label>
      {value.style === "phoneRoom" && (
        <div className="space-y-3">
          <p className="flex justify-between text-sm">
            <span>{t("Microphone distance")}</span>
            <span>{value.distance ?? 0}%</span>
          </p>
          <Slider
            aria-label={t("Microphone distance")}
            value={[value.distance ?? 0]}
            min={0}
            max={100}
            step={5}
            disabled={disabled}
            onValueChange={([distance]) => onChange({ ...value, distance })}
          />
          <p className="flex justify-between text-xs text-muted-foreground">
            <span>{t("Near microphone")}</span>
            <span>{t("Across the table")}</span>
          </p>
        </div>
      )}
      <div className="space-y-3">
        <p className="flex justify-between text-sm">
          <span>{t("Room tone")}</span>
          <span>{value.ambience}%</span>
        </p>
        <Slider
          aria-label={t("Room tone")}
          value={[value.ambience]}
          min={0}
          max={100}
          step={5}
          disabled={disabled}
          onValueChange={([ambience]) => onChange({ ...value, ambience })}
        />
      </div>
      <p className="small-note">
        {t(
          "Local recording effects and synthetic room tone. Original audio is preserved.",
        )}
      </p>
    </div>
  );
}
