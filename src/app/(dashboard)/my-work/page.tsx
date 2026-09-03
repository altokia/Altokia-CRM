"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useCan } from "@/hooks/use-can";
import { fetchAccountMembers } from "@/lib/account/members";
import type { AccountMember, Task } from "@/types";
import { TaskCard } from "@/components/my-work/task-card";
import { ReassignDialog } from "@/components/my-work/reassign-dialog";
import { NewTaskDialog } from "@/components/my-work/new-task-dialog";
import { AvailabilityToggle } from "@/components/my-work/availability-toggle";
import { FollowUpInput } from "@/components/tasks/follow-up-input";
import {
  assignTaskTo,
  attendTask,
  createTask,
  getAdvisors,
  listTasks,
  patchTask,
  setMyAvailability,
  type AdvisorEntry,
  type AssignTarget,
  type CreateTaskBody,
} from "@/components/my-work/api";

type Scope = "mine" | "queue" | "waiting";

/**
 * "Mi trabajo" — the per-advisor work queue.
 *
 * Three views of the same table: what I hold (mine), what nobody holds
 * (queue), and the subset of the queue that is a customer waiting for a
 * person (waiting = HUMAN_CHAT). The server sorts by priority, then age.
 * Everything a person can do here goes through the tasks API, which
 * keeps HUMAN_CHAT tasks in step with their conversation.
 */
export default function MyWorkPage() {
  const t = useTranslations("MyWork");
  const tf = useTranslations("FollowUp");
  const format = useFormatter();
  const router = useRouter();
  const { user, accountId } = useAuth();
  const canAct = useCan("send-messages");

  const [scope, setScope] = useState<Scope>("mine");
  const [tasks, setTasks] = useState<Task[] | null>(null);
  // "Now" is sampled per refresh rather than read during render so the
  // overdue check stays pure and consistent across the list.
  const [now, setNow] = useState(() => Date.now());
  const [members, setMembers] = useState<AccountMember[]>([]);
  const [advisors, setAdvisors] = useState<AdvisorEntry[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reassigning, setReassigning] = useState<Task | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const { tasks } = await listTasks(
        scope === "mine" ? "mine" : "queue",
        scope === "waiting" ? "HUMAN_CHAT" : undefined,
      );
      setTasks(tasks);
      setNow(Date.now());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("toast.error"));
      setTasks([]);
    }
  }, [scope, t]);

  const loadTeam = useCallback(async () => {
    const [m, a] = await Promise.all([
      fetchAccountMembers(),
      getAdvisors().catch(() => null),
    ]);
    setMembers(m);
    if (a) setAdvisors(a.advisors);
  }, []);

  useEffect(() => {
    setTasks(null);
    load();
  }, [load]);

  useEffect(() => {
    loadTeam();
  }, [loadTeam]);

  // Live: any change to the account's tasks refreshes the current tab.
  // Cheap refetch rather than patching state — the server owns the sort.
  useEffect(() => {
    if (!accountId) return;
    const supabase = createClient();
    const channel = supabase
      .channel(`tasks:${accountId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "tasks", filter: `account_id=eq.${accountId}` },
        () => {
          load();
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [accountId, load]);

  const me = useMemo(
    () => advisors.find((a) => a.user_id === user?.id) ?? null,
    [advisors, user?.id],
  );

  const run = async (task: Task, fn: () => Promise<void>) => {
    setBusyId(task.id);
    try {
      await fn();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("toast.error"));
    } finally {
      setBusyId(null);
    }
  };

  const onAttend = (task: Task) =>
    run(task, async () => {
      const { conversation_id } = await attendTask(task.id);
      toast.success(t("toast.attended"));
      if (conversation_id) router.push(`/inbox?c=${conversation_id}`);
      else load();
    });

  const onViewConversation = (task: Task) => {
    if (task.conversation_id) router.push(`/inbox?c=${task.conversation_id}`);
  };

  const onDone = (task: Task) =>
    run(task, async () => {
      await patchTask(task.id, { status: "done" });
      toast.success(t("toast.done"));
      load();
    });

  const onReassignSubmit = async (task: Task, target: AssignTarget) => {
    await run(task, async () => {
      const result = await assignTaskTo(task.id, target);
      if (target === "auto" && !result.assigned_to) {
        toast.info(
          result.next_available_at
            ? `${t("toast.queued")} ${t("nextAvailable", {
                time: format.dateTime(new Date(result.next_available_at), {
                  hour: "2-digit",
                  minute: "2-digit",
                }),
              })}`
            : t("toast.queued"),
        );
      } else {
        toast.success(t("toast.reassigned"));
      }
      load();
    });
  };

  const onCreate = async (body: CreateTaskBody) => {
    try {
      const result = await createTask(body);
      toast.success(t("toast.created"));
      if (body.assign_to === "auto" && !result.assigned_to) toast.info(t("toast.queued"));
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("toast.error"));
      throw err;
    }
  };

  const onAvailability = async (override: "available" | "busy" | "off" | null) => {
    try {
      await setMyAvailability(override);
      await loadTeam();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("toast.error"));
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">{t("title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("description")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {canAct && <AvailabilityToggle me={me} onChange={onAvailability} />}
          {canAct && (
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" />
              {t("actions.newTask")}
            </Button>
          )}
        </div>
      </div>

      {canAct && (
        <div className="rounded-lg border border-border bg-card p-3">
          <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {tf("title")}
          </p>
          <FollowUpInput onCreated={load} />
          <p className="mt-1.5 text-[11px] text-muted-foreground">{tf("hint")}</p>
        </div>
      )}

      <Tabs value={scope} onValueChange={(v) => setScope(v as Scope)}>
        <TabsList>
          <TabsTrigger value="mine">{t("tabs.mine")}</TabsTrigger>
          <TabsTrigger value="queue">{t("tabs.queue")}</TabsTrigger>
          <TabsTrigger value="waiting">{t("tabs.waiting")}</TabsTrigger>
        </TabsList>
        {(["mine", "queue", "waiting"] as Scope[]).map((s) => (
          <TabsContent key={s} value={s} className="mt-4">
            {tasks === null ? (
              <div className="flex justify-center py-12">
                <Loader2 className="size-6 animate-spin text-primary" />
              </div>
            ) : tasks.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border py-12 text-center text-sm text-muted-foreground">
                {t(`empty.${s}`)}
              </p>
            ) : (
              <ul className="space-y-3">
                {tasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    members={members}
                    canAct={canAct}
                    currentUserId={user?.id ?? null}
                    now={now}
                    busy={busyId === task.id}
                    onAttend={onAttend}
                    onReassign={setReassigning}
                    onDone={onDone}
                    onViewConversation={onViewConversation}
                  />
                ))}
              </ul>
            )}
          </TabsContent>
        ))}
      </Tabs>

      <ReassignDialog
        task={reassigning}
        members={members}
        currentUserId={user?.id ?? null}
        onSubmit={onReassignSubmit}
        onOpenChange={(open) => {
          if (!open) setReassigning(null);
        }}
      />
      <NewTaskDialog
        open={creating}
        onOpenChange={setCreating}
        members={members}
        accountId={accountId}
        onSubmit={onCreate}
      />
    </div>
  );
}
