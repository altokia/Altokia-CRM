"use client";

import { useCallback, useEffect, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Sparkles } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useCan } from "@/hooks/use-can";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface Insight {
  conversation_id: string;
  intent: string | null;
  intent_level: "low" | "medium" | "high" | null;
  item_name: string | null;
  need: string | null;
  priority: string | null;
  next_action: string | null;
  action_type: string | null;
  needs_human: boolean;
  lead_label_key: string | null;
  lead_label_locked: boolean;
  preferred_contact_time: string | null;
  summary: { text?: string } | null;
  last_extracted_at: string | null;
}

interface LeadLabel {
  key: string;
  name: string;
  color: string;
}

/**
 * "Lectura de la IA" in the inbox sidebar: what the assistant
 * understood about this contact, and the one thing a person changes
 * most — the lead label. Reads by contact (one conversation per
 * contact since migration 036) through the browser client under RLS;
 * writes go through the insight API so a human's label is locked
 * against the assistant overwriting it.
 */
export function InsightPanel({ contactId }: { contactId: string }) {
  const t = useTranslations("Inbox.sidebar.insight");
  const format = useFormatter();
  const canEdit = useCan("send-messages");
  const [insight, setInsight] = useState<Insight | null | undefined>(undefined);
  const [labels, setLabels] = useState<LeadLabel[]>([]);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const supabase = createClient();
    const [{ data: row }, { data: labelRows }] = await Promise.all([
      supabase
        .from("conversation_insights")
        .select(
          "conversation_id, intent, intent_level, item_name, need, priority, next_action, action_type, needs_human, lead_label_key, lead_label_locked, preferred_contact_time, summary, last_extracted_at",
        )
        .eq("contact_id", contactId)
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase.from("lead_labels").select("key, name, color").order("position", { ascending: true }),
    ]);
    setInsight((row as Insight | null) ?? null);
    setLabels((labelRows as LeadLabel[] | null) ?? []);
  }, [contactId]);

  useEffect(() => {
    setInsight(undefined);
    load();
  }, [load]);

  // Live: the assistant rewrites the row on every inbound message.
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`insight:${contactId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "conversation_insights", filter: `contact_id=eq.${contactId}` },
        () => {
          load();
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [contactId, load]);

  const changeLabel = async (key: string) => {
    if (!insight && !key) return;
    setSaving(true);
    try {
      // Without an insight row yet there is no conversation id at hand;
      // the API upserts by conversation, so resolve it through the contact.
      let conversationId = insight?.conversation_id;
      if (!conversationId) {
        const supabase = createClient();
        const { data } = await supabase.from("conversations").select("id").eq("contact_id", contactId).limit(1).maybeSingle();
        conversationId = data?.id as string | undefined;
      }
      if (!conversationId) throw new Error(t("labelError"));
      const res = await fetch(`/api/conversations/${conversationId}/insight`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lead_label_key: key === "__none" ? null : key }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || t("labelError"));
      }
      toast.success(t("labelSaved"));
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("labelError"));
    } finally {
      setSaving(false);
    }
  };

  const current = labels.find((l) => l.key === insight?.lead_label_key) ?? null;
  const summaryText = insight?.summary && typeof insight.summary === "object" ? insight.summary.text : undefined;

  return (
    <div>
      <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <Sparkles className="h-3 w-3" />
        {t("title")}
      </div>

      <div className="mt-2 space-y-2 px-1 text-sm">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">{t("label")}</span>
          {canEdit ? (
            <Select value={insight?.lead_label_key ?? "__none"} onValueChange={(v) => v && changeLabel(v)} disabled={saving}>
              <SelectTrigger className="h-7 w-[170px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">{t("noLabel")}</SelectItem>
                {labels.map((l) => (
                  <SelectItem key={l.key} value={l.key}>
                    <span className="inline-flex items-center gap-2">
                      <span className="size-2 rounded-full" style={{ backgroundColor: l.color }} />
                      {l.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : current ? (
            <span className="rounded-full px-2 py-0.5 text-[10px] font-medium" style={{ backgroundColor: `${current.color}20`, color: current.color }}>
              {current.name}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">{t("noLabel")}</span>
          )}
        </div>
        {insight?.lead_label_locked && <p className="text-[10px] text-muted-foreground">{t("locked")}</p>}

        {insight === undefined ? null : insight === null || !insight.last_extracted_at ? (
          <p className="text-xs text-muted-foreground">{t("empty")}</p>
        ) : (
          <dl className="space-y-1.5 text-xs">
            {summaryText && (
              <div>
                <dt className="text-muted-foreground">{t("summary")}</dt>
                <dd className="text-foreground">{summaryText}</dd>
              </div>
            )}
            {insight.item_name && <Row label={t("interest")} value={insight.item_name} />}
            {insight.need && <Row label={t("need")} value={insight.need} />}
            {insight.intent && <Row label={t("intent")} value={`${insight.intent}${insight.intent_level ? ` · ${insight.intent_level}` : ""}`} />}
            {insight.next_action && <Row label={t("nextAction")} value={insight.next_action} />}
            {insight.preferred_contact_time && <Row label={t("preferredTime")} value={insight.preferred_contact_time} />}
            {insight.needs_human && <p className="font-medium text-amber-600 dark:text-amber-400">{t("needsHuman")}</p>}
            <p className="text-[10px] text-muted-foreground">
              {t("updated", { time: format.relativeTime(new Date(insight.last_extracted_at)) })}
            </p>
          </dl>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 text-muted-foreground">{label}:</dt>
      <dd className="text-foreground">{value}</dd>
    </div>
  );
}
