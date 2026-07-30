import { afterEach, describe, expect, it, vi } from "vitest";
import { saveStoredAnalysisFeedback } from "./feedbackStorage";
import { syncPendingFeedback, updatePersonalizationSettings } from "./personalizationApi";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

describe("创作记忆 API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("只移除服务端明确接受的当前账号反馈", async () => {
    const storage = new MemoryStorage();
    const accepted = saveStoredAnalysisFeedback(storage, "user-a", "scene_001", "helpful");
    saveStoredAnalysisFeedback(storage, "user-b", "scene_002", "too_generic");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      acceptedClientFeedbackIds: [accepted.clientFeedbackId],
      preferences: [],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(syncPendingFeedback(storage, "user-a", "csrf")).resolves.toBe(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/personalization/feedback/sync", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": "csrf" },
    }));
    await expect(syncPendingFeedback(storage, "user-a", "csrf")).resolves.toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("撤销同意使用明确设置请求", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      memoryEnabled: true,
      feedbackSyncConsent: false,
      updatedAt: "2026-07-28T00:00:00Z",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await updatePersonalizationSettings({ memoryEnabled: true, feedbackSyncConsent: false }, "csrf");
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/personalization/settings", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ memoryEnabled: true, feedbackSyncConsent: false }),
    }));
  });
});
