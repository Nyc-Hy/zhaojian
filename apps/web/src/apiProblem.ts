export type ApiProblem = { detail?: string; code?: string; request_id?: string };

const recovery: Record<string, string> = {
  RATE_LIMITED: "请稍等片刻后再试。",
  DAILY_QUOTA_EXCEEDED: "今天的免费分析额度已经用完，器材与日记仍可离线使用。",
  TOO_MANY_ANALYSES: "当前模型队列较忙，保留当前输入后稍后重试。",
  TASK_TIMEOUT: "任务已超时终止，可以从“我的分析”确认状态后重新提交。",
  MODEL_INVALID_OUTPUT: "模型结构连续不合规，可以稍后重新分析；不会展示部分错误结果。",
  MODEL_UPSTREAM_ERROR: "模型供应商暂时不可用，当前图片和文字不会被清空。",
  REQUEST_TOO_LARGE: "请让浏览器重新压缩图片，或换用尺寸较小的 JPEG。",
  INVALID_CSRF: "请刷新页面以重新建立安全会话。",
  PASSWORD_RESET_FAILED: "请重新申请一次恢复码。",
};

export function apiProblemMessage(problem: ApiProblem | undefined, fallback: string): string {
  const detail = problem?.detail ?? fallback;
  const action = problem?.code ? recovery[problem.code] : undefined;
  const request = problem?.request_id ? ` 请求编号：${problem.request_id}` : "";
  return `${detail}${action && !detail.includes(action) ? ` ${action}` : ""}${request}`;
}

export async function readApiProblem(response: Response, fallback: string): Promise<Error> {
  try { return new Error(apiProblemMessage(await response.json() as ApiProblem, fallback)); }
  catch { return new Error(fallback); }
}
