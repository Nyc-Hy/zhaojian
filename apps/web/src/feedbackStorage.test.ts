import { describe, expect, it } from "vitest";
import {
  clearAccountFeedback,
  listAnalysisFeedback,
  listDirectionFeedback,
  listPendingFeedback,
  removePendingFeedback,
  saveStoredAnalysisFeedback,
  saveStoredDirectionFeedback,
} from "./feedbackStorage";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

describe("账号隔离反馈队列", () => {
  it("同一账号的后一次选择替换展示值与待同步值", () => {
    const storage = new MemoryStorage();
    saveStoredAnalysisFeedback(storage, "user-a", "scene_001", "too_generic", "2026-07-17T00:00:00.000Z");
    const pending = saveStoredAnalysisFeedback(storage, "user-a", "scene_001", "helpful", "2026-07-17T00:01:00.000Z");

    expect(listAnalysisFeedback(storage, "user-a")).toEqual([
      { analysisId: "scene_001", value: "helpful", createdAt: "2026-07-17T00:01:00.000Z" },
    ]);
    expect(listPendingFeedback(storage, "user-a")).toEqual([pending]);
  });

  it("不同账号永不读取彼此队列，并可按服务端确认逐条移除", () => {
    const storage = new MemoryStorage();
    const first = saveStoredDirectionFeedback(storage, "user-a", {
      analysisId: "scene_001",
      directionId: "direction_001",
      visualStrategy: "depth_occlusion",
      value: "worth_trying",
    });
    saveStoredDirectionFeedback(storage, "user-b", {
      analysisId: "scene_002",
      directionId: "direction_002",
      visualStrategy: "negative_space",
      value: "too_generic",
    });

    expect(listDirectionFeedback(storage, "user-a")).toHaveLength(1);
    expect(listDirectionFeedback(storage, "user-b")).toHaveLength(1);
    expect(listPendingFeedback(storage, "user-a")).toHaveLength(1);
    removePendingFeedback(storage, "user-a", [first.clientFeedbackId]);
    expect(listPendingFeedback(storage, "user-a")).toEqual([]);
    expect(listPendingFeedback(storage, "user-b")).toHaveLength(1);

    clearAccountFeedback(storage, "user-b");
    expect(listDirectionFeedback(storage, "user-b")).toEqual([]);
    expect(listPendingFeedback(storage, "user-b")).toEqual([]);
  });

  it("不认领无法确定归属的旧全局反馈", () => {
    const storage = new MemoryStorage();
    storage.setItem("zhaojian.analysisFeedback", JSON.stringify([{ analysisId: "old", value: "helpful", createdAt: "2026-07-17T00:00:00Z" }]));
    saveStoredAnalysisFeedback(storage, "user-a", "scene_new", "helpful");
    expect(storage.getItem("zhaojian.analysisFeedback")).toBeNull();
    expect(listAnalysisFeedback(storage, "user-b")).toEqual([]);
  });
});
