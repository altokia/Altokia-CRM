"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Bell, CheckCheck, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { fetchAccountMembers, memberLabel } from "@/lib/account/members";
import {
  NotificationItem,
  type NotificationRow,
} from "@/components/notifications/notification-item";

type Filter = "all" | "unread";

/**
 * The alerts screen.
 *
 * Every visible string comes from next-intl. The stored title/body do
 * not — the triggers write them in English — so `NotificationItem`
 * rebuilds the sentence per type; see the note there.
 */
export default function NotificationsPage() {
  const t = useTranslations("Notifications");
  const { accountId, accountStatus } = useAuth();
  const [notifications, setNotifications] = useState<NotificationRow[] | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [markingAll, setMarkingAll] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  // "Now" is sampled per refresh rather than read during render, so the
  // relative timestamps stay pure and consistent across the list.
  const [now, setNow] = useState(() => Date.now());
  // Names for the ids a notification row carries. Both are best-effort:
  // a missing name means the sentence is rendered in its shorter form,
  // never with a placeholder standing in for a real person.
  const [contactNames, setContactNames] = useState<Record<string, string>>({});
  const [actorNames, setActorNames] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    if (!accountId) {
      // Still resolving → keep the skeleton. Resolved without an account
      // → the global access alert already explains why; an empty list
      // beats a spinner that never stops.
      setNotifications(accountStatus === "loading" ? null : []);
      return;
    }
    const supabase = createClient();
    const { data, error: fetchErr } = await supabase
      .from("notifications")
      .select("*")
      .eq("account_id", accountId)
      .order("created_at", { ascending: false })
      .limit(100);
    if (fetchErr) {
      setError(fetchErr.message);
      return;
    }
    const rows = (data ?? []) as NotificationRow[];
    setError(null);
    setNotifications(rows);
    setNow(Date.now());

    // Resolve the contacts the rows point at so "te pasaron la
    // conversación con X" can name X. One query for the whole page.
    const contactIds = [
      ...new Set(rows.map((n) => n.contact_id).filter((id): id is string => !!id)),
    ];
    if (contactIds.length === 0) return;
    const { data: contacts } = await supabase
      .from("contacts")
      .select("id, name, phone")
      .in("id", contactIds);
    if (!contacts) return;
    const names: Record<string, string> = {};
    for (const c of contacts as { id: string; name: string | null; phone: string | null }[]) {
      const label = c.name?.trim() || c.phone?.trim();
      if (label) names[c.id] = label;
    }
    setContactNames(names);
  }, [accountId, accountStatus]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // Who triggered each alert. `actor_user_id` points at auth.users, which
  // has no readable join from the client, so the member list is what
  // turns an id into a name.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const members = await fetchAccountMembers();
      if (cancelled) return;
      const names: Record<string, string> = {};
      for (const m of members) names[m.user_id] = memberLabel(m);
      setActorNames(names);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Realtime — new assignments appear without a refresh, and a
  // "mark all read" fired from another tab/device stays in sync here.
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel("notifications-page")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "notifications" },
        (payload) => {
          if (payload.eventType === "INSERT") {
            const row = payload.new as NotificationRow;
            if (accountId && row.account_id !== accountId) return;
            // Refetch rather than append: the new row's contact name is
            // not in `contactNames` yet, and load() resolves it.
            load();
          } else if (payload.eventType === "UPDATE") {
            const row = payload.new as NotificationRow;
            setNotifications((prev) =>
              prev?.map((n) => (n.id === row.id ? { ...n, ...row } : n)) ?? prev,
            );
          } else if (payload.eventType === "DELETE") {
            const oldRow = payload.old as Partial<NotificationRow>;
            setNotifications(
              (prev) => prev?.filter((n) => n.id !== oldRow.id) ?? prev,
            );
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [accountId, load]);

  const markRead = useCallback(
    async (id: string) => {
      // Optimistic — the row is already visually "read" by the time the
      // request lands, so the UI doesn't wait on the round-trip.
      setNotifications(
        (prev) =>
          prev?.map((n) =>
            n.id === id && !n.read_at
              ? { ...n, read_at: new Date().toISOString() }
              : n,
          ) ?? prev,
      );
      const supabase = createClient();
      const { error: updateErr } = await supabase
        .from("notifications")
        .update({ read_at: new Date().toISOString() })
        .eq("id", id)
        .is("read_at", null);
      if (updateErr) {
        toast.error(t("toast.markReadFailed"));
        load();
      }
    },
    [load, t],
  );

  const handleOpen = useCallback(
    (n: NotificationRow) => {
      // Navigation itself is the <Link>'s job; opening an alert only
      // means it has been seen.
      if (!n.read_at) markRead(n.id);
    },
    [markRead],
  );

  const handleMarkRead = useCallback(
    (n: NotificationRow) => {
      markRead(n.id);
    },
    [markRead],
  );

  const unreadCount = notifications?.filter((n) => !n.read_at).length ?? 0;

  const markAllRead = useCallback(async () => {
    if (unreadCount === 0 || !accountId) return;
    setMarkingAll(true);
    const nowIso = new Date().toISOString();
    setNotifications(
      (prev) => prev?.map((n) => (n.read_at ? n : { ...n, read_at: nowIso })) ?? prev,
    );
    const supabase = createClient();
    // RLS already scopes the update to this user; the account filter
    // keeps it to the account whose list is on screen.
    const { error: updateErr } = await supabase
      .from("notifications")
      .update({ read_at: nowIso })
      .eq("account_id", accountId)
      .is("read_at", null);
    setMarkingAll(false);
    if (updateErr) {
      toast.error(t("toast.markAllFailed"));
      load();
    }
  }, [unreadCount, accountId, load, t]);

  const retry = useCallback(() => {
    setError(null);
    setNotifications(null);
    load();
  }, [load]);

  const header = (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          {t("title")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
      </div>
      {/* Nothing to count or clear until the list has actually arrived —
          "Estás al día" while still loading would be a lie. */}
      {notifications !== null && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-sm text-muted-foreground">
            {t("unreadSummary", { count: unreadCount })}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={unreadCount === 0 || markingAll}
            onClick={markAllRead}
          >
            {markingAll ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <CheckCheck className="size-4" />
            )}
            {t("markAll")}
          </Button>
        </div>
      )}
    </div>
  );

  if (error) {
    return (
      <div className="space-y-6">
        {header}
        <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-10 text-center">
          <p className="text-sm font-medium text-foreground">{t("error.title")}</p>
          <p className="text-sm text-muted-foreground">{t("error.body")}</p>
          {/* The raw database message: diagnostic detail, not copy. */}
          <p className="max-w-md text-xs text-muted-foreground/80">{error}</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={retry}>
            <RefreshCw className="size-4" />
            {t("error.retry")}
          </Button>
        </div>
      </div>
    );
  }

  if (notifications === null) {
    return (
      <div className="space-y-6">
        {header}
        <ul className="space-y-2" aria-busy>
          <li className="sr-only">{t("loading")}</li>
          {[0, 1, 2].map((i) => (
            <li
              key={i}
              className="h-24 animate-pulse rounded-xl border border-border bg-muted/40"
              aria-hidden
            />
          ))}
        </ul>
      </div>
    );
  }

  const visible =
    filter === "unread" ? notifications.filter((n) => !n.read_at) : notifications;

  return (
    <div className="space-y-6">
      {header}

      <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
        <TabsList>
          <TabsTrigger value="all">{t("filter.all")}</TabsTrigger>
          <TabsTrigger value="unread">{t("filter.unread")}</TabsTrigger>
        </TabsList>
      </Tabs>

      {visible.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-muted/30 p-10 text-center">
          <div className="flex size-12 items-center justify-center rounded-xl bg-primary/10">
            {filter === "unread" ? (
              <CheckCheck className="size-6 text-primary" />
            ) : (
              <Bell className="size-6 text-primary" />
            )}
          </div>
          <p className="mt-3 text-sm font-medium text-foreground">
            {filter === "unread" ? t("empty.unreadTitle") : t("empty.allTitle")}
          </p>
          <p className="mt-1 max-w-sm text-xs text-muted-foreground">
            {filter === "unread" ? t("empty.unreadBody") : t("empty.allBody")}
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {visible.map((n) => (
            <NotificationItem
              key={n.id}
              notification={n}
              contactName={(n.contact_id && contactNames[n.contact_id]) || null}
              actorName={(n.actor_user_id && actorNames[n.actor_user_id]) || null}
              now={now}
              onOpen={handleOpen}
              onMarkRead={handleMarkRead}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
