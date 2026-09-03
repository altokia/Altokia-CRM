"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createClient } from "@/lib/supabase/client";
import { memberLabel } from "@/lib/account/members";
import { TASK_ACTION_TYPES, type AccountMember, type TaskPriority } from "@/types";
import { type AssignTarget, type CreateTaskBody } from "./api";

const PRIORITIES: TaskPriority[] = ["urgent", "high", "normal", "low"];
// HUMAN_CHAT tasks are born from conversations, never typed by hand.
const CREATABLE_TYPES = TASK_ACTION_TYPES.filter((x) => x !== "HUMAN_CHAT");

interface ContactHit {
  id: string;
  name: string | null;
  phone: string;
}

/**
 * Manual task creation: "recuérdame llamar a Juan mañana". Contact is
 * optional and found by name through the browser client (RLS-scoped);
 * assignee defaults to "let routing decide".
 */
export function NewTaskDialog({
  open,
  onOpenChange,
  members,
  accountId,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  members: AccountMember[];
  accountId: string | null;
  onSubmit: (body: CreateTaskBody) => Promise<void>;
}) {
  const t = useTranslations("MyWork");
  const [title, setTitle] = useState("");
  const [type, setType] = useState<string>("CALL");
  const [priority, setPriority] = useState<TaskPriority>("normal");
  const [due, setDue] = useState("");
  const [details, setDetails] = useState("");
  const [assign, setAssign] = useState<string>("auto");
  const [contactQuery, setContactQuery] = useState("");
  const [contactHits, setContactHits] = useState<ContactHit[]>([]);
  const [contact, setContact] = useState<ContactHit | null>(null);
  const [saving, setSaving] = useState(false);

  // Reset on open so a second task starts clean.
  useEffect(() => {
    if (!open) return;
    setTitle("");
    setType("CALL");
    setPriority("normal");
    setDue("");
    setDetails("");
    setAssign("auto");
    setContactQuery("");
    setContactHits([]);
    setContact(null);
  }, [open]);

  // Debounced contact search against the account's own contacts.
  useEffect(() => {
    if (!accountId || contact || contactQuery.trim().length < 2) {
      setContactHits([]);
      return;
    }
    const q = contactQuery.trim();
    const handle = setTimeout(async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from("contacts")
        .select("id, name, phone")
        .eq("account_id", accountId)
        .or(`name.ilike.%${q}%,phone.ilike.%${q}%`)
        .limit(8);
      setContactHits((data ?? []) as ContactHit[]);
    }, 250);
    return () => clearTimeout(handle);
  }, [contactQuery, contact, accountId]);

  const submit = async () => {
    if (!title.trim()) return;
    setSaving(true);
    try {
      const assignTo: AssignTarget = assign === "auto" ? "auto" : assign === "none" ? null : assign;
      await onSubmit({
        action_type: type,
        title: title.trim(),
        details: details.trim() || null,
        priority,
        due_at: due ? new Date(due).toISOString() : null,
        contact_id: contact?.id ?? null,
        assign_to: assignTo,
      });
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-popover border-border sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">{t("newTask.title")}</DialogTitle>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="nt-title">{t("newTask.titleLabel")}</Label>
            <Input
              id="nt-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("newTask.titlePlaceholder")}
              autoFocus
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>{t("newTask.typeLabel")}</Label>
              <Select value={type} onValueChange={(v) => v && setType(v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CREATABLE_TYPES.map((k) => (
                    <SelectItem key={k} value={k}>
                      {t(`actionType.${k}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>{t("newTask.priorityLabel")}</Label>
              <Select value={priority} onValueChange={(v) => v && setPriority(v as TaskPriority)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRIORITIES.map((p) => (
                    <SelectItem key={p} value={p}>
                      {t(`priority.${p}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="nt-due">{t("newTask.dueLabel")}</Label>
            <Input
              id="nt-due"
              type="datetime-local"
              value={due}
              onChange={(e) => setDue(e.target.value)}
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="nt-contact">{t("newTask.contactLabel")}</Label>
            {contact ? (
              <div className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
                <span className="truncate">
                  {[contact.name, contact.phone].filter(Boolean).join(" · ")}
                </span>
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => setContact(null)}
                >
                  ×
                </button>
              </div>
            ) : (
              <div className="relative">
                <Input
                  id="nt-contact"
                  value={contactQuery}
                  onChange={(e) => setContactQuery(e.target.value)}
                  placeholder={t("newTask.contactPlaceholder")}
                  autoComplete="off"
                />
                {contactHits.length > 0 && (
                  <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-md border border-border bg-popover shadow-md">
                    {contactHits.map((c) => (
                      <li key={c.id}>
                        <button
                          type="button"
                          className="flex w-full justify-between px-3 py-2 text-left text-sm hover:bg-muted"
                          onClick={() => {
                            setContact(c);
                            setContactHits([]);
                          }}
                        >
                          <span className="truncate">{c.name || "—"}</span>
                          <span className="text-muted-foreground">{c.phone}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          <div className="grid gap-1.5">
            <Label>{t("newTask.assignLabel")}</Label>
            <Select value={assign} onValueChange={(v) => v && setAssign(v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{t("newTask.assignAuto")}</SelectItem>
                <SelectItem value="me">{t("newTask.assignMe")}</SelectItem>
                {members
                  .filter((m) => m.role !== "viewer")
                  .map((m) => (
                    <SelectItem key={m.user_id} value={m.user_id}>
                      {memberLabel(m)}
                    </SelectItem>
                  ))}
                <SelectItem value="none">{t("reassign.unassign")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="nt-details">{t("newTask.detailsLabel")}</Label>
            <Textarea
              id="nt-details"
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              placeholder={t("newTask.detailsPlaceholder")}
              rows={3}
            />
          </div>
        </div>

        <DialogFooter className="bg-popover border-border">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t("newTask.cancel")}
          </Button>
          <Button onClick={submit} disabled={saving || !title.trim()}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            {t("newTask.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
