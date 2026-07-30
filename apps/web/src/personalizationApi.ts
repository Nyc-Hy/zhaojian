import { readApiProblem } from "./apiProblem";
import { listPendingFeedback, removePendingFeedback, type PendingFeedback } from "./feedbackStorage";

export type PersonalizationSettings = {
  memoryEnabled: boolean;
  feedbackSyncConsent: boolean;
  updatedAt: string;
};

export type CreativePreference = {
  id: string;
  preferenceKind: "explore_more" | "be_cautious";
  visualStrategy: string;
  evidenceCount: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type SyncedFeedback = PendingFeedback & {
  id: string;
  visualStrategy?: string;
  skillVersions: Array<{ skillId: string; skillVersion: string; contentHash: string }>;
  syncedAt: string;
};

export type PersonalizationSnapshot = {
  settings: PersonalizationSettings;
  preferences: CreativePreference[];
  recentFeedback: SyncedFeedback[];
  isolatedGlobalCandidateCount: number;
};

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", ...init });
  if (!response.ok) throw await readApiProblem(response, "创作记忆暂时无法读取。");
  return await response.json() as T;
}

function writeHeaders(csrfToken: string): HeadersInit {
  return { "Content-Type": "application/json", "X-CSRF-TOKEN": csrfToken };
}

export async function getPersonalization(): Promise<PersonalizationSnapshot> {
  return await requestJson<PersonalizationSnapshot>("/api/v1/personalization");
}

export async function updatePersonalizationSettings(
  settings: Pick<PersonalizationSettings, "memoryEnabled" | "feedbackSyncConsent">,
  csrfToken: string,
): Promise<PersonalizationSettings> {
  return await requestJson<PersonalizationSettings>("/api/v1/personalization/settings", {
    method: "PUT",
    headers: writeHeaders(csrfToken),
    body: JSON.stringify(settings),
  });
}

export async function syncPendingFeedback(
  storage: Pick<Storage, "getItem" | "setItem">,
  userId: string,
  csrfToken: string,
): Promise<number> {
  const items = listPendingFeedback(storage, userId);
  if (items.length === 0) return 0;
  const payload = await requestJson<{ acceptedClientFeedbackIds: string[] }>("/api/v1/personalization/feedback/sync", {
    method: "POST",
    headers: writeHeaders(csrfToken),
    body: JSON.stringify({ items }),
  });
  removePendingFeedback(storage, userId, payload.acceptedClientFeedbackIds);
  return payload.acceptedClientFeedbackIds.length;
}

export async function updateCreativePreference(id: string, enabled: boolean, csrfToken: string): Promise<CreativePreference> {
  return await requestJson<CreativePreference>(`/api/v1/personalization/preferences/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: writeHeaders(csrfToken),
    body: JSON.stringify({ enabled }),
  });
}

export async function deleteCreativePreference(id: string, csrfToken: string): Promise<void> {
  const response = await fetch(`/api/v1/personalization/preferences/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "same-origin",
    headers: { "X-CSRF-TOKEN": csrfToken },
  });
  if (!response.ok) throw await readApiProblem(response, "这条创作记忆暂时无法删除。");
}

export async function deleteSyncedFeedback(id: string, csrfToken: string): Promise<void> {
  const response = await fetch(`/api/v1/personalization/feedback/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "same-origin",
    headers: { "X-CSRF-TOKEN": csrfToken },
  });
  if (!response.ok) throw await readApiProblem(response, "这条反馈暂时无法删除。");
}

export async function clearPersonalization(csrfToken: string): Promise<void> {
  const response = await fetch("/api/v1/personalization", {
    method: "DELETE",
    credentials: "same-origin",
    headers: { "X-CSRF-TOKEN": csrfToken },
  });
  if (!response.ok) throw await readApiProblem(response, "创作记忆暂时无法清空。");
}
