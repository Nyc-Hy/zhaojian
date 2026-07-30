import { describe, expect, it } from "vitest";
import { apiProblemMessage } from "./apiProblem";

describe("apiProblemMessage", () => {
  it("为稳定错误码提供恢复动作和请求编号", () => {
    const message = apiProblemMessage({ code: "TASK_TIMEOUT", detail: "分析超时。", request_id: "req_123" }, "失败");
    expect(message).toContain("我的分析");
    expect(message).toContain("req_123");
  });

  it("未知错误保持服务端安全文案", () => {
    expect(apiProblemMessage({ code: "UNKNOWN", detail: "暂时不可用。" }, "失败")).toBe("暂时不可用。");
  });
});
