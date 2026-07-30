export type AnalysisFeedback = "helpful" | "too_generic" | "recognition_wrong";
export type DirectionFeedback = "worth_trying" | "too_generic" | "recognition_wrong";
export type DirectionVisualStrategy = "depth_occlusion" | "scale_context" | "rhythm_line" | "light_color" | "negative_space" | "frame_edge";

export type StoredAnalysisFeedback = {
  analysisId: string;
  value: AnalysisFeedback;
  createdAt: string;
};

export type StoredDirectionFeedback = {
  analysisId: string;
  directionId: string;
  visualStrategy: DirectionVisualStrategy;
  value: DirectionFeedback;
  createdAt: string;
};

export type PendingFeedback = {
  clientFeedbackId: string;
  analysisTaskId: string;
  directionId?: string;
  feedbackType: "analysis" | "direction";
  value: AnalysisFeedback | DirectionFeedback;
  createdAt: string;
};

const ANALYSIS_KEY = "zhaojian.analysisFeedback.v2";
const DIRECTION_KEY = "zhaojian.directionFeedback.v2";
const QUEUE_KEY = "zhaojian.feedbackQueue.v1";
const LEGACY_KEYS = ["zhaojian.analysisFeedback", "zhaojian.directionFeedback"];
const directionFeedbackValues = new Set<DirectionFeedback>(["worth_trying", "too_generic", "recognition_wrong"]);
const analysisFeedbackValues = new Set<AnalysisFeedback>(["helpful", "too_generic", "recognition_wrong"]);
const visualStrategies = new Set<DirectionVisualStrategy>(["depth_occlusion", "scale_context", "rhythm_line", "light_color", "negative_space", "frame_edge"]);

function accountKey(prefix: string, userId: string): string {
  if (!userId) throw new Error("反馈必须绑定到明确账号。");
  return `${prefix}:${encodeURIComponent(userId)}`;
}

function readArray(storage: Pick<Storage, "getItem">, key: string): unknown[] {
  try {
    const value = JSON.parse(storage.getItem(key) ?? "[]") as unknown;
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function purgeLegacyUnownedFeedback(storage: Pick<Storage, "removeItem">): void {
  for (const key of LEGACY_KEYS) storage.removeItem(key);
}

function clientFeedbackId(): string {
  const random = globalThis.crypto?.randomUUID?.().replaceAll("-", "")
    ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `feedback_${random}`.slice(0, 96);
}

export function listAnalysisFeedback(storage: Pick<Storage, "getItem">, userId: string): StoredAnalysisFeedback[] {
  return readArray(storage, accountKey(ANALYSIS_KEY, userId)).filter((item): item is StoredAnalysisFeedback => {
    if (!item || typeof item !== "object") return false;
    const candidate = item as Partial<StoredAnalysisFeedback>;
    return typeof candidate.analysisId === "string"
      && typeof candidate.createdAt === "string"
      && analysisFeedbackValues.has(candidate.value as AnalysisFeedback);
  });
}

export function saveStoredAnalysisFeedback(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  userId: string,
  analysisId: string,
  value: AnalysisFeedback,
  createdAt = new Date().toISOString(),
): PendingFeedback {
  purgeLegacyUnownedFeedback(storage);
  const records = listAnalysisFeedback(storage, userId);
  const next = [{ analysisId, value, createdAt }, ...records.filter((item) => item.analysisId !== analysisId)].slice(0, 100);
  storage.setItem(accountKey(ANALYSIS_KEY, userId), JSON.stringify(next));
  return enqueuePendingFeedback(storage, userId, {
    clientFeedbackId: clientFeedbackId(),
    analysisTaskId: analysisId,
    feedbackType: "analysis",
    value,
    createdAt,
  });
}

export function listDirectionFeedback(storage: Pick<Storage, "getItem">, userId: string): StoredDirectionFeedback[] {
  return readArray(storage, accountKey(DIRECTION_KEY, userId)).filter((item): item is StoredDirectionFeedback => {
    if (!item || typeof item !== "object") return false;
    const candidate = item as Partial<StoredDirectionFeedback>;
    return typeof candidate.analysisId === "string"
      && typeof candidate.directionId === "string"
      && typeof candidate.createdAt === "string"
      && directionFeedbackValues.has(candidate.value as DirectionFeedback)
      && visualStrategies.has(candidate.visualStrategy as DirectionVisualStrategy);
  });
}

export function saveStoredDirectionFeedback(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  userId: string,
  record: Omit<StoredDirectionFeedback, "createdAt">,
  createdAt = new Date().toISOString(),
): PendingFeedback {
  purgeLegacyUnownedFeedback(storage);
  const records = listDirectionFeedback(storage, userId);
  const next = [
    { ...record, createdAt },
    ...records.filter((item) => item.analysisId !== record.analysisId || item.directionId !== record.directionId),
  ].slice(0, 300);
  storage.setItem(accountKey(DIRECTION_KEY, userId), JSON.stringify(next));
  return enqueuePendingFeedback(storage, userId, {
    clientFeedbackId: clientFeedbackId(),
    analysisTaskId: record.analysisId,
    directionId: record.directionId,
    feedbackType: "direction",
    value: record.value,
    createdAt,
  });
}

export function listPendingFeedback(storage: Pick<Storage, "getItem">, userId: string): PendingFeedback[] {
  return readArray(storage, accountKey(QUEUE_KEY, userId)).filter((item): item is PendingFeedback => {
    if (!item || typeof item !== "object") return false;
    const candidate = item as Partial<PendingFeedback>;
    return typeof candidate.clientFeedbackId === "string"
      && typeof candidate.analysisTaskId === "string"
      && typeof candidate.createdAt === "string"
      && (candidate.feedbackType === "analysis" || candidate.feedbackType === "direction")
      && typeof candidate.value === "string";
  });
}

export function removePendingFeedback(
  storage: Pick<Storage, "getItem" | "setItem">,
  userId: string,
  acceptedClientFeedbackIds: readonly string[],
): void {
  const accepted = new Set(acceptedClientFeedbackIds);
  const remaining = listPendingFeedback(storage, userId).filter((item) => !accepted.has(item.clientFeedbackId));
  storage.setItem(accountKey(QUEUE_KEY, userId), JSON.stringify(remaining));
}

export function clearAccountFeedback(storage: Pick<Storage, "removeItem">, userId: string): void {
  storage.removeItem(accountKey(ANALYSIS_KEY, userId));
  storage.removeItem(accountKey(DIRECTION_KEY, userId));
  storage.removeItem(accountKey(QUEUE_KEY, userId));
}

function enqueuePendingFeedback(
  storage: Pick<Storage, "getItem" | "setItem">,
  userId: string,
  feedback: PendingFeedback,
): PendingFeedback {
  const queue = listPendingFeedback(storage, userId);
  const remaining = queue.filter((item) => item.feedbackType !== feedback.feedbackType
    || item.analysisTaskId !== feedback.analysisTaskId
    || item.directionId !== feedback.directionId);
  storage.setItem(accountKey(QUEUE_KEY, userId), JSON.stringify([feedback, ...remaining].slice(0, 300)));
  return feedback;
}
