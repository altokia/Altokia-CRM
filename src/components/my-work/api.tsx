"use client";

/**
 * Thin fetch wrapper for the "My work" page. Every /api/tasks and
 * /api/account/advisors endpoint answers `{ error: string }` on failure,
 * so one helper turns that into a thrown Error and the callers can keep
 * a single `catch → toast` path instead of re-checking `res.ok` in five
 * places.
 *
 * Client-side only (relative URLs against the Next API routes).
 */

import type { Task } from "@/types";

/** Value accepted by POST /api/tasks(/:id/assign) `assign_to`. */
export type AssignTarget = string | "me" | "auto" | null;

/** Shape returned by the assign / attend / create endpoints. */
export interface AssignResult {
  task: Task;
  assigned_to: string | null;
  /** ISO timestamp when nobody was available and routing knows the next shift. */
  next_available_at?: string | null;
}

export async function requestJson<T>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(url, {
    cache: "no-store",
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  // A 204 or a non-JSON body should not crash the caller — treat it as
  // an empty object and let the status code decide.
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(json?.error || `Request failed (${res.status})`);
  }
  return json;
}

export function listTasks(
  scope: "mine" | "queue",
  actionType?: string,
): Promise<{ tasks: Task[] }> {
  const params = new URLSearchParams({ scope });
  if (actionType) params.set("action_type", actionType);
  return requestJson<{ tasks: Task[] }>(`/api/tasks?${params.toString()}`);
}

export function attendTask(
  id: string,
): Promise<{ task: Task; conversation_id: string | null }> {
  return requestJson(`/api/tasks/${id}/attend`, { method: "POST" });
}

export function assignTaskTo(
  id: string,
  assignTo: AssignTarget,
): Promise<AssignResult> {
  return requestJson(`/api/tasks/${id}/assign`, {
    method: "POST",
    body: JSON.stringify({ assign_to: assignTo }),
  });
}

export function patchTask(
  id: string,
  patch: Partial<Pick<Task, "status" | "priority" | "due_at" | "details" | "title">>,
): Promise<{ task: Task }> {
  return requestJson(`/api/tasks/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export interface CreateTaskBody {
  action_type: string;
  title: string;
  details?: string | null;
  priority?: Task["priority"];
  contact_id?: string | null;
  conversation_id?: string | null;
  due_at?: string | null;
  assign_to?: AssignTarget;
}

export function createTask(body: CreateTaskBody): Promise<AssignResult> {
  return requestJson(`/api/tasks`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** One advisor as GET /api/account/advisors describes them. */
export interface AdvisorEntry {
  user_id: string;
  full_name: string;
  avatar_url: string | null;
  role: string;
  profile: {
    department: string | null;
    specialties: string[];
    item_ids: string[];
    capacity: number;
    availability_override: "available" | "busy" | "off" | null;
    accepts_assignments: boolean;
  } | null;
  schedules: Array<{ weekday: number; start: string; end: string }>;
  availability: {
    available: boolean;
    onShift: boolean;
    present: boolean;
    underCapacity: boolean;
    override: "available" | "busy" | "off" | null;
    reasons: string[];
  };
  next_shift_start: string | null;
  load: number;
}

export interface AdvisorsResponse {
  timezone: string;
  routing: { strategy?: string; fallback?: string; last_assigned_user_id?: string };
  advisors: AdvisorEntry[];
}

export function getAdvisors(): Promise<AdvisorsResponse> {
  return requestJson<AdvisorsResponse>(`/api/account/advisors`);
}

export function setMyAvailability(
  override: "available" | "busy" | "off" | null,
): Promise<{ ok: true }> {
  return requestJson(`/api/me/availability`, {
    method: "POST",
    body: JSON.stringify({ override }),
  });
}
