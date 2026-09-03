"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { AdvisorEntry } from "./api";

type Override = "available" | "busy" | "off" | null;

/**
 * The advisor's own switch. "Según mi horario" (null) hands control
 * back to the weekly schedule; the three overrides win over it. The
 * dot shows the computed result — what routing actually sees — not the
 * chosen option, so an advisor who set "available" but is offline sees
 * the truth.
 */
export function AvailabilityToggle({
  me,
  onChange,
}: {
  me: AdvisorEntry | null;
  onChange: (override: Override) => Promise<void>;
}) {
  const t = useTranslations("MyWork");
  const [saving, setSaving] = useState(false);
  const current: Override = me?.profile?.availability_override ?? null;
  const available = me?.availability.available ?? false;

  const set = async (value: string) => {
    setSaving(true);
    try {
      await onChange(value === "auto" ? null : (value as Override));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex items-center gap-3">
      <span
        aria-hidden
        className={cn(
          "size-2.5 rounded-full",
          available ? "bg-emerald-500" : "bg-muted-foreground/40",
        )}
      />
      <span className="text-sm text-muted-foreground">{t("availability.title")}</span>
      <Select value={current ?? "auto"} onValueChange={(v) => v && set(v)}>
        <SelectTrigger className="h-8 w-[190px]" disabled={saving}>
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : <SelectValue />}
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="auto">{t("availability.auto")}</SelectItem>
          <SelectItem value="available">{t("availability.available")}</SelectItem>
          <SelectItem value="busy">{t("availability.busy")}</SelectItem>
          <SelectItem value="off">{t("availability.off")}</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
