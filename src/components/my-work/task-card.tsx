"use client";

import { useFormatter, useTranslations } from "next-intl";
import {
  AlarmClock,
  ArrowRightLeft,
  Check,
  MessageSquare,
  Phone,
  Play,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AccountMember, Task } from "@/types";
import { memberLabel } from "@/lib/account/members";

/**
 * One item of work. The card answers, top to bottom: how urgent, what
 * kind of action, for whom, what we know, how long it has waited, and
 * who holds it — then the three things a person can do about it.
 *
 * Priority is encoded twice (a colour stripe and the chip text) so it
 * reads at a glance and still works without colour.
 */

const PRIORITY_STRIPE: Record<Task["priority"], string> = {
  urgent: "border-l-red-500",
  high: "border-l-amber-500",
  normal: "border-l-primary",
  low: "border-l-border",
};

const PRIORITY_CHIP: Record<Task["priority"], string> = {
  urgent: "bg-red-500/10 text-red-600 dark:text-red-400",
  high: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  normal: "bg-primary/10 text-primary",
  low: "bg-muted text-muted-foreground",
};

const KNOWN_TYPES = new Set([
  "HUMAN_CHAT",
  "CALL",
  "FOLLOW_UP",
  "APPOINTMENT",
  "QUOTE",
  "REVIEW_REQUIRED",
  "AI_CONTINUE",
]);

export interface TaskCardProps {
  task: Task;
  members: AccountMember[];
  /** Whether the viewer may act (agents+); viewers see the card read-only. */
  canAct: boolean;
  currentUserId: string | null;
  /** Epoch ms captured by the page per refresh — keeps render pure. */
  now: number;
  busy: boolean;
  onAttend: (task: Task) => void;
  onReassign: (task: Task) => void;
  onDone: (task: Task) => void;
  onViewConversation: (task: Task) => void;
}

export function TaskCard({
  task,
  members,
  canAct,
  currentUserId,
  now,
  busy,
  onAttend,
  onReassign,
  onDone,
  onViewConversation,
}: TaskCardProps) {
  const t = useTranslations("MyWork");
  const format = useFormatter();

  const typeKey = KNOWN_TYPES.has(task.action_type) ? task.action_type : "OTHER";
  const assignee = task.assigned_to
    ? members.find((m) => m.user_id === task.assigned_to)
    : null;
  const isMine = !!currentUserId && task.assigned_to === currentUserId;
  const dueDate = task.due_at ? new Date(task.due_at) : null;
  const overdue = !!dueDate && dueDate.getTime() < now;
  const summaryReason =
    typeof task.summary?.handoff_reason === "string"
      ? (task.summary.handoff_reason as string)
      : null;
  const contactLine = task.contact
    ? [task.contact.name, task.contact.phone].filter(Boolean).join(" · ")
    : null;
  const window = task.preferred_window;
  const windowText =
    window && (window.after || window.before)
      ? [window.after ? `≥ ${window.after}` : null, window.before ? `≤ ${window.before}` : null]
          .filter(Boolean)
          .join(" ")
      : null;

  return (
    <li
      className={cn(
        "rounded-lg border border-border border-l-4 bg-card p-4 transition-colors",
        PRIORITY_STRIPE[task.priority],
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
                PRIORITY_CHIP[task.priority],
              )}
            >
              {t(`priority.${task.priority}`)}
            </span>
            <Badge variant="outline" className="gap-1 font-normal">
              {task.action_type === "CALL" ? (
                <Phone className="size-3" />
              ) : (
                <MessageSquare className="size-3" />
              )}
              {t(`actionType.${typeKey}`)}
            </Badge>
            {task.source !== "manual" && (
              <span className="text-xs text-muted-foreground">
                {t(`card.createdBy.${task.source}`)}
              </span>
            )}
          </div>

          <h3 className="truncate font-medium text-foreground">{task.title}</h3>
          {contactLine && (
            <p className="truncate text-sm text-muted-foreground">{contactLine}</p>
          )}
          {task.details && (
            <p className="line-clamp-3 text-sm text-foreground/80">{task.details}</p>
          )}
          {!task.details && summaryReason && (
            <p className="text-xs text-muted-foreground">{summaryReason}</p>
          )}

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>
              {t("card.waitingSince", {
                time: format.relativeTime(new Date(task.created_at)),
              })}
            </span>
            {dueDate && (
              <span className={cn("inline-flex items-center gap-1", overdue && "text-red-500")}>
                <AlarmClock className="size-3" />
                {t(overdue ? "card.overdue" : "card.due", {
                  time: format.relativeTime(dueDate),
                })}
              </span>
            )}
            {windowText && <span>{t("card.preferredWindow", { window: windowText })}</span>}
            <span>
              {assignee
                ? t("card.assignedTo", { name: memberLabel(assignee) })
                : t("card.unassigned")}
            </span>
          </div>
        </div>

        {canAct && (
          <div className="flex shrink-0 flex-wrap gap-2">
            {!isMine && (
              <Button size="sm" disabled={busy} onClick={() => onAttend(task)}>
                <Play className="size-3.5" />
                {t("actions.attend")}
              </Button>
            )}
            {task.conversation_id && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => onViewConversation(task)}
              >
                <MessageSquare className="size-3.5" />
                {t("actions.viewConversation")}
              </Button>
            )}
            <Button size="sm" variant="outline" disabled={busy} onClick={() => onReassign(task)}>
              <ArrowRightLeft className="size-3.5" />
              {t("actions.reassign")}
            </Button>
            {task.action_type !== "HUMAN_CHAT" && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDone(task)}>
                <Check className="size-3.5" />
                {t("actions.done")}
              </Button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
