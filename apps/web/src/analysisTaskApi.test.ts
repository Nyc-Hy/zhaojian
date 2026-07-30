import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelAnalysisTask,
  createCreativeIntent,
  deleteAnalysisTask,
  deleteCreativeIntent,
  getAnalysisTask,
  listAnalysisTasks,
} from "./analysisTaskApi";

describe("分析任务 API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("使用分页上限读取列表并编码任务 ID", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("?limit=")) {
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ task: { id: "task/晨雾" }, request: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(listAnalysisTasks(25)).resolves.toEqual([]);
    await expect(getAnalysisTask("task/晨雾")).resolves.toMatchObject({ task: { id: "task/晨雾" } });
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/analysis-tasks?limit=25", { credentials: "same-origin" });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/analysis-tasks/task%2F%E6%99%A8%E9%9B%BE", { credentials: "same-origin" });
  });

  it("取消和删除任务时使用正确方法并携带防伪令牌", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await cancelAnalysisTask("task/1", "csrf-token");
    await deleteAnalysisTask("task/1", "csrf-token");

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/analysis-tasks/task%2F1/cancel", {
      method: "POST",
      credentials: "same-origin",
      headers: { "X-CSRF-TOKEN": "csrf-token" },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/analysis-tasks/task%2F1", {
      method: "DELETE",
      credentials: "same-origin",
      headers: { "X-CSRF-TOKEN": "csrf-token" },
    });
  });

  it("创作意图只使用服务端生成结果并编码资源 ID", async () => {
    const intent = {
      schema_version: "1.0",
      creative_intent_id: "intent_001",
      source_analysis_id: "task/晨雾",
      selected_interpretation_id: "direction/层次",
      skill_versions: [],
      gear_snapshot: null,
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Response(init?.method === "DELETE" ? null : JSON.stringify(intent), {
        status: init?.method === "DELETE" ? 204 : 200,
        headers: init?.method === "DELETE" ? undefined : { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createCreativeIntent("task/晨雾", "direction/层次", "csrf")).resolves.toMatchObject({ creative_intent_id: "intent_001" });
    await deleteCreativeIntent("intent/晨雾", "csrf");

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/analysis-tasks/task%2F%E6%99%A8%E9%9B%BE/creative-intents", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": "csrf" },
      body: JSON.stringify({ selectedInterpretationId: "direction/层次" }),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/creative-intents/intent%2F%E6%99%A8%E9%9B%BE", {
      method: "DELETE",
      credentials: "same-origin",
      headers: { "X-CSRF-TOKEN": "csrf" },
    });
  });
});
