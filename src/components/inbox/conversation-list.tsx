"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  CONVERSATION_SELECT,
  matchesContactFilters,
  normalizeConversations,
} from "@/lib/inbox/conversations";
import { fetchAccountMembers, memberLabel } from "@/lib/account/members";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import type {
  AccountMember,
  Conversation,
  ConversationStatus,
  Tag,
} from "@/types";
import { Search, ChevronDown, X, Clock, User } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";

interface ConversationListProps {
  activeConversationId: string | null;
  onSelect: (conversation: Conversation) => void;
  conversations: Conversation[];
  onConversationsLoaded: (conversations: Conversation[]) => void;
  /**
   * Increment to force the fetch effect below to refire. The parent
   * bumps this on realtime reconnect / tab visibility → visible so the
   * list catches up on any events sent while the WS was disconnected
   * or the tab was throttled. Optional so existing callers keep working.
   */
  resyncToken?: number;
}

const STATUS_COLORS: Record<ConversationStatus, string> = {
  open: "bg-primary",
  pending: "bg-amber-500",
  closed: "bg-muted-foreground",
};



type InboxFilter = ConversationStatus | "all" | "unread";

/**
 * Ownership slice of the inbox, kept in `?view=` so an agent's view
 * survives a reload and can be pasted to a teammate.
 *
 * Anything in that param that isn't one of these keywords is read as a
 * teammate's user id (the "specific advisor" picker below). Matching on
 * the raw id — instead of validating it against the member list — means
 * a shared link filters correctly even before the members request lands.
 */
const OWNER_VIEWS = ["all", "mine", "unassigned", "waiting"] as const;
type OwnerView = (typeof OWNER_VIEWS)[number];

function isOwnerView(value: string | null): value is OwnerView {
  return value !== null && (OWNER_VIEWS as readonly string[]).includes(value);
}

/** Up to two initials for the assignee bubble on a row. */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return parts
    .slice(0, 2)
    .map((p) => p.charAt(0).toUpperCase())
    .join("");
}

export function ConversationList({
  activeConversationId,
  onSelect,
  conversations,
  onConversationsLoaded,
  resyncToken = 0,
}: ConversationListProps) {
  const t = useTranslations("Inbox.conversationList");
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const myId = user?.id ?? null;

  const FILTER_OPTIONS: { label: string; value: InboxFilter }[] = useMemo(() => [
    { label: t("filterAll"), value: "all" },
    { label: t("filterUnread"), value: "unread" },
    { label: t("filterOpen"), value: "open" },
    { label: t("filterPending"), value: "pending" },
    { label: t("filterClosed"), value: "closed" },
  ], [t]);

  const OWNER_TABS: { label: string; value: OwnerView }[] = useMemo(() => [
    { label: t("viewAll"), value: "all" },
    { label: t("viewMine"), value: "mine" },
    { label: t("viewUnassigned"), value: "unassigned" },
    { label: t("viewWaiting"), value: "waiting" },
  ], [t]);

  // Ownership filter lives in the URL, not in state: the agent keeps their
  // slice across reloads and can share it as a link (issue: nobody could
  // isolate "my chats" in a multi-advisor account).
  const viewParam = searchParams.get("view");
  const ownerView: OwnerView = isOwnerView(viewParam) ? viewParam : "all";
  const agentFilter = viewParam && !isOwnerView(viewParam) ? viewParam : null;

  const setOwnerView = useCallback(
    (next: string) => {
      const params = new URLSearchParams(searchParams.toString());
      // "all" is the default — keep it out of the URL so the plain
      // /inbox link stays clean, and preserve `?c=` (the open thread).
      if (next === "all") params.delete("view");
      else params.set("view", next);
      const qs = params.toString();
      // replace(), not push(): flipping a filter shouldn't fill the back button.
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  // Account members power both the advisor picker and the per-row owner
  // bubble. Best-effort by design: fetchAccountMembers resolves to [] on
  // failure, which leaves the picker hidden and rows on a neutral bubble.
  const [members, setMembers] = useState<AccountMember[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetchAccountMembers().then((m) => {
      if (!cancelled) setMembers(m);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const membersById = useMemo(() => {
    const m = new Map<string, AccountMember>();
    for (const member of members) m.set(member.user_id, member);
    return m;
  }, [members]);

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [loading, setLoading] = useState(true);
  // Contact-based filters (issue #272). Tags use OR logic (a conversation
  // matches if its contact carries any selected tag), consistent with
  // Broadcast audience filtering. Company is an exact match on the field.
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<string | null>(null);

  // Keep the latest callback in a ref so the fetch effect below can
  // have a stable, empty-dep identity. Previously the fetch useCallback
  // depended on `onConversationsLoaded`, which depends on the parent's
  // `deepLinkConvId` — so every URL change (including one the parent
  // triggered via router.replace after a click) caused a fresh
  // conversations fetch. That extra refetch was the trigger for the
  // deep-link auto-select running a second time and wiping the active
  // thread's messages.
  // Mutation lives in an effect (not render) per React 19's refs rule;
  // the fetch runs once on mount so it's fine to read the slightly
  // older value — the very next render updates the ref for any
  // subsequent async completion.
  const onConversationsLoadedRef = useRef(onConversationsLoaded);
  useEffect(() => {
    onConversationsLoadedRef.current = onConversationsLoaded;
  });

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from("conversations")
        .select(CONVERSATION_SELECT)
        .order("last_message_at", { ascending: false });

      if (cancelled) return;

      if (error) {
        // Supabase errors have non-enumerable properties — log fields explicitly
        console.error("Failed to fetch conversations:", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        setLoading(false);
        return;
      }

      onConversationsLoadedRef.current(normalizeConversations(data ?? []));
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
    // `resyncToken` is included so the parent can force a refetch when
    // the realtime channel reconnects or the tab regains focus — catches
    // up on any events sent while the WS was disconnected or throttled.
  }, [resyncToken]);

  // Tag definitions for the filter picker — loaded once so labels/colours
  // stay stable regardless of which conversations happen to be loaded.
  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from("tags").select("*").order("name");
      if (!cancelled && data) setTags(data as Tag[]);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Company options are derived from the loaded conversations — there's no
  // separate companies table, and only companies with a live conversation
  // are worth offering as an inbox filter.
  const companies = useMemo(() => {
    const set = new Set<string>();
    for (const c of conversations) {
      const co = c.contact?.company?.trim();
      if (co) set.add(co);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [conversations]);

  const tagsById = useMemo(() => {
    const m = new Map<string, Tag>();
    for (const t of tags) m.set(t.id, t);
    return m;
  }, [tags]);

  // Everything except the ownership slice. Split out so the tab counts
  // below can be read off the same list the tabs switch between — the
  // number next to a tab always matches what clicking it shows.
  const baseFiltered = useMemo(() => {
    let result = conversations;

    if (filter === "unread") {
      result = result.filter((c) => c.unread_count > 0);
    } else if (filter !== "all") {
      result = result.filter((c) => c.status === filter);
    }

    // Contact-based filters (tags via OR logic, exact company match).
    if (selectedTagIds.length > 0 || selectedCompany !== null) {
      result = result.filter((c) =>
        matchesContactFilters(c, {
          tagIds: selectedTagIds,
          company: selectedCompany,
        })
      );
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((c) => {
        const name = c.contact?.name?.toLowerCase() ?? "";
        const phone = c.contact?.phone?.toLowerCase() ?? "";
        const lastMsg = c.last_message_text?.toLowerCase() ?? "";
        return name.includes(q) || phone.includes(q) || lastMsg.includes(q);
      });
    }

    return result;
  }, [conversations, filter, search, selectedTagIds, selectedCompany]);

  // One pass over the rows already in memory — no extra query. `mine` is
  // null (badge hidden) until the session resolves: a missing number is
  // honest, a "0" would read as "you have nothing".
  const ownerCounts = useMemo(() => {
    let mine = 0;
    let unassigned = 0;
    let waiting = 0;
    for (const c of baseFiltered) {
      if (myId && c.assigned_agent_id === myId) mine++;
      if (!c.assigned_agent_id) unassigned++;
      if (c.handoff_state === "waiting_for_human") waiting++;
    }
    return {
      all: baseFiltered.length,
      mine: myId ? mine : null,
      unassigned,
      waiting,
    };
  }, [baseFiltered, myId]);

  // Ownership slice, applied in memory like every other inbox filter —
  // the list already holds the account's conversations, so this costs a
  // pass over an array instead of a round-trip.
  const filtered = useMemo(() => {
    if (agentFilter) {
      return baseFiltered.filter((c) => c.assigned_agent_id === agentFilter);
    }
    switch (ownerView) {
      case "mine":
        // No session yet → show nothing rather than everyone's threads.
        return myId
          ? baseFiltered.filter((c) => c.assigned_agent_id === myId)
          : [];
      case "unassigned":
        return baseFiltered.filter((c) => !c.assigned_agent_id);
      case "waiting":
        return baseFiltered.filter(
          (c) => c.handoff_state === "waiting_for_human",
        );
      default:
        return baseFiltered;
    }
  }, [baseFiltered, ownerView, agentFilter, myId]);

  const toggleTag = useCallback((id: string) => {
    setSelectedTagIds((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );
  }, []);

  const clearContactFilters = useCallback(() => {
    setSelectedTagIds([]);
    setSelectedCompany(null);
  }, []);

  const hasContactFilters = selectedTagIds.length > 0 || selectedCompany !== null;

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearch(e.target.value);
    },
    []
  );

  const handleSelect = useCallback(
    (conv: Conversation) => {
      onSelect(conv);
    },
    [onSelect]
  );

  const activeFilter = FILTER_OPTIONS.find((o) => o.value === filter);

  // A filtered-by id we can't resolve to a member (left the account, or
  // the members request failed) still filters correctly — we just can't
  // put a name on it, and say so instead of guessing one.
  const agentFilterMember = agentFilter ? membersById.get(agentFilter) : undefined;
  const agentFilterLabel = agentFilter
    ? (agentFilterMember ? memberLabel(agentFilterMember) : t("agentUnknown"))
    : t("agentPicker");

  return (
    // w-full on mobile so the list occupies the whole viewport when it's
    // the single pane showing; fixed 320px on desktop where it shares the
    // row with the thread + contact sidebar.
    <div className="flex h-full w-full flex-col border-r border-border bg-card lg:w-80">
      {/* Search + Filter */}
      <div className="space-y-2 border-b border-border p-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={handleSearchChange}
            placeholder={t("searchPlaceholder")}
            className="border-border bg-muted pl-9 text-sm text-foreground placeholder-muted-foreground focus:border-primary/50"
          />
        </div>

        {/* Who has the thread. Separate row from the status/tag chips
            below because it answers a different question — "whose work is
            this", not "what state is it in" — and it's the one an agent
            flips constantly. */}
        <div className="flex flex-wrap items-center gap-1">
          <div className="flex flex-wrap items-center gap-0.5 rounded-md bg-muted/60 p-0.5">
            {OWNER_TABS.map((tab) => {
              // The advisor picker owns the highlight while it's set: the
              // tabs and the picker are the same axis, not two filters.
              const isActive = !agentFilter && ownerView === tab.value;
              const count = ownerCounts[tab.value];
              return (
                <button
                  key={tab.value}
                  type="button"
                  onClick={() => setOwnerView(tab.value)}
                  aria-pressed={isActive}
                  // The label is short so four tabs fit the 320px column;
                  // the tooltip carries the full meaning.
                  title={tab.value === "waiting" ? t("waitingTitle") : undefined}
                  className={cn(
                    "inline-flex h-6 items-center gap-1 rounded px-2 text-[11px] transition-colors",
                    isActive
                      ? "bg-background font-medium text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {tab.label}
                  {count !== null && (
                    <span
                      className={cn(
                        "tabular-nums",
                        // Anything waiting on a person is money on the
                        // table — keep the number warm even unselected.
                        tab.value === "waiting" && count > 0
                          ? "font-semibold text-amber-700 dark:text-amber-400"
                          : "text-muted-foreground/70",
                      )}
                    >
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Only worth showing with teammates to pick from — or when a
              shared link already points at one, so it can be cleared. */}
          {(members.length > 1 || agentFilter) && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex max-w-40 items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  agentFilter
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <span className="truncate">{agentFilterLabel}</span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-56 border-border bg-popover"
              >
                <DropdownMenuItem
                  onClick={() => setOwnerView("all")}
                  className={cn(
                    "text-sm",
                    agentFilter ? "text-popover-foreground" : "text-primary",
                  )}
                >
                  {t("anyAgent")}
                </DropdownMenuItem>
                {members.map((m) => (
                  <DropdownMenuItem
                    key={m.user_id}
                    onClick={() => setOwnerView(m.user_id)}
                    className={cn(
                      "text-sm",
                      agentFilter === m.user_id
                        ? "text-primary"
                        : "text-popover-foreground",
                    )}
                  >
                    <span className="truncate">
                      {m.user_id === myId
                        ? t("agentYou", { name: memberLabel(m) })
                        : memberLabel(m)}
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex items-center justify-center h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground rounded-md hover:bg-muted">
                {activeFilter?.label ?? t("filterAll")}
                <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="border-border bg-popover"
            >
              {FILTER_OPTIONS.map((opt) => (
                <DropdownMenuItem
                  key={opt.value}
                  onClick={() => setFilter(opt.value)}
                  className={cn(
                    "text-sm",
                    filter === opt.value
                      ? "text-primary"
                      : "text-popover-foreground"
                  )}
                >
                  {opt.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {tags.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  selectedTagIds.length > 0
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {t("tags")}
                {selectedTagIds.length > 0 && (
                  <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                    {selectedTagIds.length}
                  </span>
                )}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-56 border-border bg-popover"
              >
                {tags.map((t) => (
                  <DropdownMenuCheckboxItem
                    key={t.id}
                    checked={selectedTagIds.includes(t.id)}
                    onCheckedChange={() => toggleTag(t.id)}
                    className="text-sm text-popover-foreground"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: t.color }}
                      />
                      <span className="truncate">{t.name}</span>
                    </span>
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {companies.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex max-w-40 items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  selectedCompany
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <span className="truncate">{selectedCompany ?? t("company")}</span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-56 border-border bg-popover"
              >
                <DropdownMenuItem
                  onClick={() => setSelectedCompany(null)}
                  className={cn(
                    "text-sm",
                    selectedCompany === null
                      ? "text-primary"
                      : "text-popover-foreground"
                  )}
                >
                  {t("allCompanies")}
                </DropdownMenuItem>
                {companies.map((co) => (
                  <DropdownMenuItem
                    key={co}
                    onClick={() => setSelectedCompany(co)}
                    className={cn(
                      "text-sm",
                      selectedCompany === co
                        ? "text-primary"
                        : "text-popover-foreground"
                    )}
                  >
                    <span className="truncate">{co}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {hasContactFilters && (
          <div className="flex flex-wrap items-center gap-1">
            {selectedTagIds.map((id) => {
              const tag = tagsById.get(id);
              return (
                <button
                  key={id}
                  onClick={() => toggleTag(id)}
                  className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: tag?.color ?? "var(--muted-foreground)" }}
                  />
                  <span className="max-w-24 truncate">{tag?.name ?? t("tags")}</span>
                  <X className="h-3 w-3" />
                </button>
              );
            })}
            {selectedCompany && (
              <button
                onClick={() => setSelectedCompany(null)}
                className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
              >
                <span className="max-w-24 truncate">{selectedCompany}</span>
                <X className="h-3 w-3" />
              </button>
            )}
            <button
              onClick={clearContactFilters}
              className="px-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              {t("clearAll")}
            </button>
          </div>
        )}
      </div>

      {/* Conversation Items.
          `min-h-0` is load-bearing: a flex child defaults to
          min-height:auto, so without it this ScrollArea grows to fit
          every conversation instead of shrinking to the remaining
          space — the list then overflows and gets clipped by the
          parent's overflow-hidden with no scrollbar (issue #229). */}
      <ScrollArea className="min-h-0 flex-1">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-sm text-muted-foreground">{t("noConversations")}</p>
          </div>
        ) : (
          <div className="flex flex-col">
            {filtered.map((conv) => (
              <ConversationItem
                key={conv.id}
                conversation={conv}
                isActive={conv.id === activeConversationId}
                owner={
                  conv.assigned_agent_id
                    ? (membersById.get(conv.assigned_agent_id) ?? null)
                    : null
                }
                isOwnedByMe={
                  !!myId && conv.assigned_agent_id === myId
                }
                onSelect={handleSelect}
                t={t}
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  /** Account member holding the thread; null when unassigned OR when the
   *  assignee id doesn't resolve to a member we know about. */
  owner: AccountMember | null;
  isOwnedByMe: boolean;
  onSelect: (conversation: Conversation) => void;
  t: ReturnType<typeof useTranslations>;
}

function ConversationItem({
  conversation,
  isActive,
  owner,
  isOwnedByMe,
  onSelect,
  t,
}: ConversationItemProps) {
  const contact = conversation.contact;
  const displayName = contact?.name || contact?.phone || t("unknown");
  const initials = displayName.charAt(0).toUpperCase();

  // Two rows can't be worked twice by accident if the list says who has
  // each one. Kept to a bubble + title so the row doesn't get louder.
  const assignedAgentId = conversation.assigned_agent_id ?? null;
  const ownerName = owner ? memberLabel(owner) : null;
  const ownerTitle = !assignedAgentId
    ? t("unassignedTitle")
    : isOwnedByMe
      ? t("ownedByYou")
      : t("ownedBy", { name: ownerName ?? t("someoneElse") });

  // The customer is waiting on a person — the state that costs money and
  // had no signal anywhere in the list until now.
  const isWaiting = conversation.handoff_state === "waiting_for_human";

  const handleClick = useCallback(() => {
    onSelect(conversation);
  }, [onSelect, conversation]);

  const timeAgo = conversation.last_message_at
    ? formatDistanceToNow(new Date(conversation.last_message_at), {
        addSuffix: false,
      })
    : "";

  return (
    <button
      onClick={handleClick}
      className={cn(
        "flex w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-muted/50",
        // Warm tint for threads waiting on a person, so they stand out
        // while scanning. The active row keeps its own background.
        isWaiting && !isActive && "bg-amber-500/5",
        isActive && "border-l-2 border-primary bg-muted/70"
      )}
    >
      {/* Avatar */}
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium text-foreground">
        {contact?.avatar_url ? (
          <img
            src={contact.avatar_url}
            alt={displayName}
            className="h-10 w-10 rounded-full object-cover"
          />
        ) : (
          initials
        )}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            {displayName}
          </span>
          <div className="flex shrink-0 items-center gap-1.5">
            {/* Owner bubble. Assigned → initials (or photo); free →
                a dashed outline, so an unclaimed thread reads as an
                empty slot rather than as missing information. */}
            {assignedAgentId ? (
              <span
                title={ownerTitle}
                className={cn(
                  "flex h-5 w-5 items-center justify-center overflow-hidden rounded-full text-[9px] font-semibold",
                  isOwnedByMe
                    ? "bg-primary/15 text-primary"
                    : "bg-muted text-muted-foreground ring-1 ring-border"
                )}
              >
                {owner?.avatar_url ? (
                  <img
                    src={owner.avatar_url}
                    alt={ownerName ?? ""}
                    className="h-5 w-5 object-cover"
                  />
                ) : (
                  initialsOf(ownerName ?? "?")
                )}
              </span>
            ) : (
              <span
                title={ownerTitle}
                className="flex h-5 w-5 items-center justify-center rounded-full border border-dashed border-border text-muted-foreground/70"
              >
                <User className="h-2.5 w-2.5" />
              </span>
            )}
            <span className="text-[10px] text-muted-foreground">{timeAgo}</span>
          </div>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p className="truncate text-xs text-muted-foreground">
            {conversation.last_message_text || t("noMessagesYet")}
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            {isWaiting && (
              <span
                title={t("waitingTitle")}
                className="inline-flex items-center gap-0.5 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400"
              >
                <Clock className="h-2.5 w-2.5" />
                {t("waitingBadge")}
              </span>
            )}
            {conversation.unread_count > 0 && (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                {conversation.unread_count}
              </span>
            )}
            <span
              className={cn(
                "h-2 w-2 rounded-full",
                STATUS_COLORS[conversation.status]
              )}
              title={conversation.status}
            />
          </div>
        </div>
      </div>
    </button>
  );
}
