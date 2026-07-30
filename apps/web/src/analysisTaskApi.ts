import { readApiProblem } from "./apiProblem";
import type { CreativeIntent } from "./skillContracts";

export type AnalysisTaskSkillVersion = {
  skillId: string;
  skillVersion: string;
  contentHash: string;
};

export type AnalysisTaskSummary = {
  id: string;
  imageId: string;
  status: string;
  intent: string;
  directionCount: number;
  provider?: string;
  model?: string;
  promptTokens: number;
  completionTokens: number;
  providerCalls: number;
  estimatedCostCny: number;
  pricingVersion?: string;
  chargeDisposition: string;
  durationMs: number;
  imageWidth: number;
  imageHeight: number;
  imageBytes: number;
  imageAvailable: boolean;
  createdAt: string;
  completedAt?: string;
  skillVersions: AnalysisTaskSkillVersion[];
  imageUrl: string;
};

export type AnalysisTaskDetail<TResult = unknown> = {
  task: AnalysisTaskSummary;
  request: Record<string, unknown>;
  result?: TResult;
  errorCode?: string;
  creativeIntents: CreativeIntent[];
};

export async function listAnalysisTasks(limit = 40): Promise<AnalysisTaskSummary[]> {
  const response = await fetch(`/api/v1/analysis-tasks?limit=${limit}`, { credentials: "same-origin" });
  if (!response.ok) throw await readApiProblem(response, "历史分析暂时无法读取。");
  return ((await response.json()) as { items: AnalysisTaskSummary[] }).items;
}

export async function getAnalysisTask<TResult>(taskId: string): Promise<AnalysisTaskDetail<TResult>> {
  const response = await fetch(`/api/v1/analysis-tasks/${encodeURIComponent(taskId)}`, { credentials: "same-origin" });
  if (!response.ok) throw await readApiProblem(response, "分析任务暂时无法读取。");
  return await response.json() as AnalysisTaskDetail<TResult>;
}

export async function cancelAnalysisTask(taskId: string, csrfToken: string): Promise<void> {
  const response = await fetch(`/api/v1/analysis-tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST", credentials: "same-origin", headers: { "X-CSRF-TOKEN": csrfToken } });
  if (!response.ok && response.status !== 409) throw await readApiProblem(response, "这次分析暂时无法取消。");
}

export async function deleteAnalysisTask(taskId: string, csrfToken: string): Promise<void> {
  const response = await fetch(`/api/v1/analysis-tasks/${encodeURIComponent(taskId)}`, { method: "DELETE", credentials: "same-origin", headers: { "X-CSRF-TOKEN": csrfToken } });
  if (!response.ok) throw await readApiProblem(response, "这次分析暂时无法删除。");
}

export async function createCreativeIntent(
  taskId: string,
  selectedInterpretationId: string,
  csrfToken: string,
): Promise<CreativeIntent> {
  const response = await fetch(`/api/v1/analysis-tasks/${encodeURIComponent(taskId)}/creative-intents`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": csrfToken },
    body: JSON.stringify({ selectedInterpretationId }),
  });
  if (!response.ok) throw await readApiProblem(response, "创作意图暂时无法保存。");
  return await response.json() as CreativeIntent;
}

export async function listCreativeIntents(): Promise<CreativeIntent[]> {
  const response = await fetch("/api/v1/creative-intents?limit=200", { credentials: "same-origin" });
  if (!response.ok) throw await readApiProblem(response, "创作意图暂时无法读取。");
  return ((await response.json()) as { items: CreativeIntent[] }).items;
}

export async function deleteCreativeIntent(intentId: string, csrfToken: string): Promise<void> {
  const response = await fetch(`/api/v1/creative-intents/${encodeURIComponent(intentId)}`, {
    method: "DELETE",
    credentials: "same-origin",
    headers: { "X-CSRF-TOKEN": csrfToken },
  });
  if (!response.ok) throw await readApiProblem(response, "这条创作意图暂时无法删除。");
}
