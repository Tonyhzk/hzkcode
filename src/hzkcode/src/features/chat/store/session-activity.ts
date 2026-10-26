import { useSyncExternalStore } from "react";
import type { Message, SessionControlApply } from "@/lib/ipc";
import { newId } from "@/lib/id";
import { readStoredJson, writeStored } from "@/lib/storage";

/**
 * 用户在本机会话里实际提交的操作记录。记录与 CLI 转录、SessionState.messages
 * 完全分开：只用于聊天区展示，不写入会话文件，也不进入发送参数。
 */

export type SessionActivityKind =
  | "identity"
  | "interaction-mode"
  | "prompt-mode"
  | "api-mode"
  | "proxy"
  | "second-brain"
  | "context";

export type SessionActivityStatus = "success" | "error";

export interface SessionActivity {
  id: string;
  kind: SessionActivityKind;
  status: SessionActivityStatus;
  /** 用户提交的目标值；身份与持续模式已解析为显示名。 */
  value: string;
  /** 引擎回报的实际生效值。 */
  effective?: string;
  /** 身份/提示词的应用方式。 */
  apply?: SessionControlApply;
  /** 失败原因（status === "error"）。 */
  error?: string;
  at: number;
}

export type SessionActivityInput = Omit<SessionActivity, "id" | "at">;

/** 展示层专用消息：负 seq 与原消息序号隔离，绝不写回 SessionState.messages。 */
export type SessionActivityMessage = Message & {
  sessionActivity: SessionActivity;
};

const STORAGE_PREFIX = "hzkcode.sessionActivity:v1:";
const EMPTY_ACTIVITIES: readonly SessionActivity[] = [];
const KINDS = new Set<string>([
  "identity",
  "interaction-mode",
  "prompt-mode",
  "api-mode",
  "proxy",
  "second-brain",
  "context",
]);
const APPLY_METHODS = new Set<string>(["current", "clone", "append"]);
const activitiesByKey = new Map<string, SessionActivity[]>();
const storedByKey = new Map<string, string | null>();
const listeners = new Set<() => void>();
const messageCache = new WeakMap<SessionActivity, SessionActivityMessage>();

function storageKey(key: string): string {
  return STORAGE_PREFIX + key;
}

function isStoredActivity(value: unknown): value is SessionActivity {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<SessionActivity>;
  return (
    typeof item.id === "string" &&
    typeof item.kind === "string" &&
    KINDS.has(item.kind) &&
    (item.status === "success" || item.status === "error") &&
    typeof item.value === "string" &&
    Number.isFinite(item.at) &&
    (item.effective === undefined || typeof item.effective === "string") &&
    (item.apply === undefined ||
      (typeof item.apply === "string" && APPLY_METHODS.has(item.apply))) &&
    (item.error === undefined || typeof item.error === "string")
  );
}

function readActivities(key: string): SessionActivity[] {
  const cached = activitiesByKey.get(key);
  let raw: string | null;
  try {
    raw = localStorage.getItem(storageKey(key));
  } catch {
    if (cached) return cached;
    const empty: SessionActivity[] = [];
    activitiesByKey.set(key, empty);
    return empty;
  }
  if (cached && storedByKey.get(key) === raw) return cached;
  const stored =
    readStoredJson(storageKey(key), (value) =>
      Array.isArray(value) ? value.filter(isStoredActivity) : null,
    ) ?? [];
  activitiesByKey.set(key, stored);
  storedByKey.set(key, raw);
  return stored;
}

function saveActivities(key: string, activities: SessionActivity[]): void {
  activitiesByKey.set(key, activities);
  writeStored(storageKey(key), JSON.stringify(activities));
  try {
    storedByKey.set(key, localStorage.getItem(storageKey(key)));
  } catch {
    // 存储不可用时仍保留本次窗口内的操作反馈。
  }
}

export function clearSessionActivities(key: string): void {
  activitiesByKey.set(key, []);
  try {
    localStorage.removeItem(storageKey(key));
    storedByKey.set(key, null);
  } catch {
    // 与写入失败一样，不阻断已完成的会话操作。
  }
  emit();
}

function emit() {
  for (const listener of listeners) listener();
}

/** 一个会话的全部操作记录（按提交时间升序）。 */
export function getSessionActivities(key: string): readonly SessionActivity[] {
  return readActivities(key);
}

/** 追加一条已完成的用户操作记录。 */
export function recordSessionActivity(
  key: string,
  input: SessionActivityInput,
): void {
  if (!key) return;
  const activity: SessionActivity = {
    id: newId(),
    at: Date.now(),
    ...input,
  };
  saveActivities(key, [...readActivities(key), activity]);
  emit();
}

/** 草稿获得正式 sessionId 时把记录迁到新键，旧键不保留副本。 */
export function migrateSessionActivities(fromKey: string, toKey: string): void {
  if (!fromKey || !toKey || fromKey === toKey) return;
  const source = readActivities(fromKey);
  if (source.length === 0) return;
  const target = readActivities(toKey);
  const known = new Set(target.map((activity) => activity.id));
  const merged = [...target, ...source.filter((activity) => !known.has(activity.id))]
    .sort((a, b) => a.at - b.at);
  saveActivities(toKey, merged);
  clearSessionActivities(fromKey);
}

function onStorage(event: StorageEvent): void {
  if (event.key === null || event.key.startsWith(STORAGE_PREFIX)) emit();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) window.addEventListener("storage", onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}

export function useSessionActivities(
  key: string | null | undefined,
): readonly SessionActivity[] {
  return useSyncExternalStore(
    subscribe,
    () => (key ? getSessionActivities(key) : EMPTY_ACTIVITIES),
    () => EMPTY_ACTIVITIES,
  );
}

function messageTime(message: Message): number | null {
  if (!message.ts) return null;
  const ms = /^\d+$/.test(message.ts) ? Number(message.ts) : Date.parse(message.ts);
  return Number.isFinite(ms) ? ms : null;
}

function activityMessage(
  activity: SessionActivity,
  index: number,
): SessionActivityMessage {
  let message = messageCache.get(activity);
  if (!message) {
    message = {
      seq: -(index + 1),
      role: "notice",
      text: "",
      level: activity.status === "error" ? "error" : "info",
      ts: new Date(activity.at).toISOString(),
      sessionActivity: activity,
    };
    messageCache.set(activity, message);
  }
  return message;
}

/** 只合并已加载时间窗口内的记录，原消息的内容、引用与顺序不变。 */
export function mergeSessionActivities(
  messages: readonly Message[],
  activities: readonly SessionActivity[],
  hasEarlier = false,
): Message[] {
  if (activities.length === 0) return messages as Message[];
  const sorted = [...activities].sort((a, b) => a.at - b.at);
  let cursor = 0;
  const merged: Message[] = [];
  const pageStart = messages.reduce<number | null>((earliest, message) => {
    const at = messageTime(message);
    if (at === null) return earliest;
    return earliest === null ? at : Math.min(earliest, at);
  }, null);
  if (hasEarlier && pageStart !== null) {
    while (cursor < sorted.length && sorted[cursor].at < pageStart) cursor += 1;
  }
  for (const message of messages) {
    const at = messageTime(message);
    if (at !== null) {
      while (cursor < sorted.length && sorted[cursor].at < at) {
        merged.push(activityMessage(sorted[cursor], cursor));
        cursor += 1;
      }
    }
    merged.push(message);
  }
  while (cursor < sorted.length) {
    merged.push(activityMessage(sorted[cursor], cursor));
    cursor += 1;
  }
  return merged;
}

export function isSessionActivityMessage(
  message: Message,
): message is SessionActivityMessage {
  return "sessionActivity" in message;
}
