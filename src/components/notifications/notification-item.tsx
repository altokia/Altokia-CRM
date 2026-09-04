"use client";

import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import {
  AlarmClock,
  Bell,
  CalendarClock,
  Check,
  ChevronRight,
  ClipboardList,
  Eye,
  Hourglass,
  UserPlus,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useTerm } from "@/hooks/use-term";
import { cn } from "@/lib/utils";
import { TASK_ACTION_TYPES, type Notification, type NotificationType } from "@/types";

/**
 * One alert in the list.
 *
 * LANGUAGE — read this before "fixing" the fallbacks: `title` and `body`
 * are written by the database, in English. Migration 027 spells out
 * "New conversation assigned" inside the trigger, and 041 / the task
 * cron store the task's own title and details. Nothing on the client can
 * translate a sentence that arrived already built, so this component
 * rebuilds the wording from `type` + `metadata` + the names the page
 * resolved, and only falls back to the stored text for a type whose
 * sentence cannot be rebuilt. Translating the rest at the source means
 * changing the trigger to store metadata and no prose — a migration, and
 * deliberately out of scope for this change.
 *
 * A task's stored title is a different case: a person or the AI wrote it
 * in the account's own language, so it is shown as-is on purpose.
 */

/** Type-specific payload added by migration 040 (`notifications.metadata`). */
export interface NotificationMetadata {
  task_id?: string;
  action_type?: string;
  priority?: string;
  due_at?: string | null;
}

/**
 * The shared `Notification` interface in `@/types` predates the metadata
 * column, so the row is widened here instead of editing that file.
 */
export type NotificationRow = Notification & {
  metadata?: NotificationMetadata | null;
};

// Icon per notification type. The set was widened in migration 040 for
// the work queue; a type without an entry here fails typecheck, which
// is the point — every type ships with its icon.
const TYPE_ICON: Record<NotificationType, typeof Bell> = {
  conversation_assigned: UserPlus,
  conversation_waiting: Hourglass,
  task_assigned: ClipboardList,
  task_due: AlarmClock,
  follow_up_due: CalendarClock,
  review_required: Eye,
};

// Only these two are worth a chip: "normal" and "low" are the default
// state of most work and would just add noise to every row.
const PRIORITY_CHIP: Record<"urgent" | "high", string> = {
  urgent: "bg-red-500/10 text-red-600 dark:text-red-400",
  high: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
};

// `action_type` is free text in the database (a business may add its
// own), so only the built-ins have a translated label.
const KNOWN_ACTION_TYPES = new Set<string>(TASK_ACTION_TYPES);

export type NotificationTarget = {
  href: string;
  /** Key under `Notifications.open` naming where the row leads. */
  label: "conversation" | "work";
};

/**
 * Where an alert takes the advisor. Returning `null` is a real answer:
 * the row then renders as plain text instead of pretending to be
 * pressable, which is what today's task alerts did.
 */
export function notificationTarget(n: NotificationRow): NotificationTarget | null {
  // The chat is the most useful landing place whenever there is one —
  // it carries the task's context as well as the conversation's.
  if (n.conversation_id) {
    return { href: `/inbox?c=${n.conversation_id}`, label: "conversation" };
  }
  switch (n.type) {
    case "task_assigned":
    case "task_due":
    case "follow_up_due":
      // A task with no chat behind it is still actionable in "Mi trabajo".
      return { href: "/my-work", label: "work" };
    case "conversation_waiting":
      // The waiting queue is "Mi trabajo" → "Esperando asesor". The
      // inbox's filter is component state rather than a URL parameter,
      // so there is no filtered-inbox link to hand out (yet).
      return { href: "/my-work", label: "work" };
    default:
      // conversation_assigned whose conversation is gone, review_required
      // with nothing attached: nothing to open.
      return null;
  }
}

export interface NotificationItemProps {
  notification: NotificationRow;
  /** Contact name resolved by the page, when the contact still exists. */
  contactName: string | null;
  /** Teammate who triggered it, when they are still an account member. */
  actorName: string | null;
  /** Epoch ms sampled per refresh by the page — keeps render pure. */
  now: number;
  onOpen: (n: NotificationRow) => void;
  onMarkRead: (n: NotificationRow) => void;
}

export function NotificationItem({
  notification,
  contactName,
  actorName,
  now,
  onOpen,
  onMarkRead,
}: NotificationItemProps) {
  const t = useTranslations("Notifications");
  // Priority and action-type labels already exist for the work queue;
  // duplicating them under this namespace would let the two drift.
  const tWork = useTranslations("MyWork");
  const tTerms = useTranslations("Terms");
  const term = useTerm();
  const format = useFormatter();

  const isUnread = !notification.read_at;
  const Icon = TYPE_ICON[notification.type] ?? Bell;
  // A row written by a migration newer than this screen: keep its stored
  // wording rather than rendering a missing-message keypath.
  const known = Boolean(TYPE_ICON[notification.type]);

  const headline = known
    ? t(`type.${notification.type}.title`, { term: term("lead", tTerms("lead")) })
    : notification.title;

  // `detail` is the sentence; `note` the extra line a task carries.
  let detail: string | null = null;
  let note: string | null = null;
  switch (notification.type) {
    case "conversation_assigned":
      detail =
        actorName && contactName
          ? t("type.conversation_assigned.byActorWithContact", {
              actor: actorName,
              contact: contactName,
            })
          : contactName
            ? t("type.conversation_assigned.withContact", { contact: contactName })
            : actorName
              ? t("type.conversation_assigned.byActor", { actor: actorName })
              : t("type.conversation_assigned.generic");
      break;
    case "conversation_waiting":
      detail = contactName
        ? t("type.conversation_waiting.withContact", { contact: contactName })
        : t("type.conversation_waiting.generic");
      break;
    case "task_assigned":
    case "task_due":
    case "follow_up_due":
      detail = notification.title;
      note = notification.body ?? null;
      break;
    default:
      // review_required (and anything newer): the stored text is all we
      // have, so it stands in until the trigger stops writing prose.
      detail = known ? (notification.body ?? notification.title) : (notification.body ?? null);
  }

  const meta = notification.metadata ?? null;
  const rawAction = meta?.action_type;
  const actionType = rawAction && KNOWN_ACTION_TYPES.has(rawAction) ? rawAction : null;
  const rawPriority = meta?.priority;
  const priority =
    rawPriority === "urgent" || rawPriority === "high" ? rawPriority : null;
  const dueDate = meta?.due_at ? new Date(meta.due_at) : null;
  const dueAt = dueDate && !Number.isNaN(dueDate.getTime()) ? dueDate : null;
  const overdue = !!dueAt && dueAt.getTime() < now;

  // The conversation sentences already name the contact; repeating it
  // under them would read like a stutter.
  const namedInDetail =
    notification.type === "conversation_assigned" ||
    notification.type === "conversation_waiting";

  const target = notificationTarget(notification);

  const content = (
    <>
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "truncate text-sm font-semibold",
            isUnread ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {headline}
        </span>
        {isUnread && (
          <>
            <span className="size-2 shrink-0 rounded-full bg-primary" aria-hidden />
            <span className="sr-only">{t("unreadState")}</span>
          </>
        )}
      </div>

      {(priority || actionType) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {priority && (
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
                PRIORITY_CHIP[priority],
              )}
            >
              {tWork(`priority.${priority}`)}
            </span>
          )}
          {actionType && (
            <Badge variant="outline" className="font-normal">
              {tWork(`actionType.${actionType}`)}
            </Badge>
          )}
        </div>
      )}

      {detail && (
        <p
          className={cn(
            "mt-1 line-clamp-2 text-sm",
            isUnread ? "text-foreground/80" : "text-muted-foreground",
          )}
        >
          {detail}
        </p>
      )}
      {note && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{note}</p>}
      {contactName && !namedInDetail && (
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {t("contactLine", { name: contactName })}
        </p>
      )}

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span>{format.relativeTime(new Date(notification.created_at), now)}</span>
        {dueAt && (
          <span className={cn("inline-flex items-center gap-1", overdue && "text-red-500")}>
            <AlarmClock className="size-3" />
            {t(overdue ? "overdue" : "due", { time: format.relativeTime(dueAt, now) })}
          </span>
        )}
        {target ? (
          <span className="inline-flex items-center gap-0.5 font-medium text-primary">
            {t(`open.${target.label}`)}
            <ChevronRight className="size-3" />
          </span>
        ) : (
          // Said out loud, because a dead row that merely *looks* dead
          // reads as a bug to the person staring at it.
          <span className="italic">{t("open.none")}</span>
        )}
      </div>
    </>
  );

  return (
    <li
      className={cn(
        "rounded-xl border transition-colors",
        isUnread ? "border-primary/30 bg-primary/5" : "border-border bg-card",
        target && (isUnread ? "hover:border-primary/60" : "hover:border-border/60 hover:bg-muted/40"),
      )}
    >
      <div className="flex items-start gap-3 p-4">
        <div
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-lg",
            isUnread ? "bg-primary/15" : "bg-muted",
          )}
          aria-hidden
        >
          <Icon className={cn("size-5", isUnread ? "text-primary" : "text-muted-foreground")} />
        </div>

        {target ? (
          <Link
            href={target.href}
            onClick={() => onOpen(notification)}
            className="block min-w-0 flex-1 rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {content}
          </Link>
        ) : (
          <div className="min-w-0 flex-1">{content}</div>
        )}

        {isUnread ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("markRead")}
            title={t("markRead")}
            onClick={() => onMarkRead(notification)}
          >
            <Check className="size-4" />
          </Button>
        ) : (
          <span className="inline-flex shrink-0 items-center gap-1 pt-1 text-[11px] text-muted-foreground">
            <Check className="size-3" />
            {t("readState")}
          </span>
        )}
      </div>
    </li>
  );
}
