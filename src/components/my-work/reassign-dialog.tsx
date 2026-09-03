"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Sparkles, UserMinus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { AccountMember, Task } from "@/types";
import { memberLabel } from "@/lib/account/members";
import { type AssignTarget } from "./api";

/**
 * Pick who takes a task: a teammate, "let routing decide", or nobody.
 * Deliberately a list rather than a dropdown — the whole team fits on
 * screen, and a list makes "who is this going to" a single click.
 */
export function ReassignDialog({
  task,
  members,
  currentUserId,
  onSubmit,
  onOpenChange,
}: {
  task: Task | null;
  members: AccountMember[];
  currentUserId: string | null;
  onSubmit: (task: Task, target: AssignTarget) => Promise<void>;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("MyWork");
  const [pending, setPending] = useState<string | null>(null);

  const choose = async (target: AssignTarget) => {
    if (!task) return;
    setPending(target ?? "none");
    try {
      await onSubmit(task, target);
      onOpenChange(false);
    } finally {
      setPending(null);
    }
  };

  const eligible = members.filter((m) => m.role !== "viewer");

  return (
    <Dialog open={task !== null} onOpenChange={onOpenChange}>
      <DialogContent className="bg-popover border-border sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">{t("reassign.title")}</DialogTitle>
        </DialogHeader>
        <ul className="divide-y divide-border">
          <li>
            <button
              type="button"
              disabled={pending !== null}
              onClick={() => choose("auto")}
              className="flex w-full items-center gap-2 px-1 py-2.5 text-left text-sm hover:bg-muted disabled:opacity-60"
            >
              {pending === "auto" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Sparkles className="size-4 text-primary" />
              )}
              {t("reassign.auto")}
            </button>
          </li>
          {eligible.map((m) => (
            <li key={m.user_id}>
              <button
                type="button"
                disabled={pending !== null || task?.assigned_to === m.user_id}
                onClick={() => choose(m.user_id === currentUserId ? "me" : m.user_id)}
                className="flex w-full items-center justify-between gap-2 px-1 py-2.5 text-left text-sm hover:bg-muted disabled:opacity-60"
              >
                <span className="truncate">{memberLabel(m)}</span>
                {pending === m.user_id || (pending === "me" && m.user_id === currentUserId) ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : null}
              </button>
            </li>
          ))}
          {task?.assigned_to && (
            <li>
              <button
                type="button"
                disabled={pending !== null}
                onClick={() => choose(null)}
                className="flex w-full items-center gap-2 px-1 py-2.5 text-left text-sm text-muted-foreground hover:bg-muted disabled:opacity-60"
              >
                {pending === "none" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <UserMinus className="size-4" />
                )}
                {t("reassign.unassign")}
              </button>
            </li>
          )}
        </ul>
        <div className="flex justify-end">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending !== null}>
            {t("newTask.cancel")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
