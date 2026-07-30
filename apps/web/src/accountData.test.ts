import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteAccountGear,
  deleteAccountJournal,
  listAccountJournals,
  migrateLegacyAccountData,
  syncPendingAccountJournals,
} from "./accountData";
import { listStoredNotes, saveStoredNote } from "./noteStorage";

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

describe("旧账号数据迁移", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", new MemoryStorage());
  });

  it("只迁移给首个认领账号且完成后不重复上传", async () => {
    localStorage.setItem("zhaojian.gears", JSON.stringify([{
      id: "kit_legacy", name: "旧摄影包", camera: "旧机身", sensorWidth: 36, sensorHeight: 24,
      cropFactor: 1, lensName: "35mm", focalMin: 35, focalMax: 35, aperture: 2,
      minimumAperture: 16, ibisStops: 0, tripod: false, ndStops: [], minIso: 100, maxIso: 3200,
    }]));
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await migrateLegacyAccountData("user-a", "csrf");
    await migrateLegacyAccountData("user-a", "csrf");
    await migrateLegacyAccountData("user-b", "csrf");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("zhaojian.account-data-migrated:user-a")).toBe("1");
    expect(localStorage.getItem("zhaojian.legacy-data-owner")).toBe("user-a");
    expect(localStorage.getItem("zhaojian.gears")).toBeNull();
  });
});

describe("账号数据 API", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("读取摄影日记时保留明确的分页上限", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listAccountJournals()).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/journal-entries?limit=200", {
      credentials: "same-origin",
    });
  });

  it("删除器材和日记时编码资源 ID 并携带防伪令牌", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await deleteAccountGear("kit/山野", "csrf-token");
    await deleteAccountJournal("note/晨雾", "csrf-token");

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/gear-kits/kit%2F%E5%B1%B1%E9%87%8E", {
      method: "DELETE",
      credentials: "same-origin",
      headers: { "X-CSRF-TOKEN": "csrf-token" },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/journal-entries/note%2F%E6%99%A8%E9%9B%BE", {
      method: "DELETE",
      credentials: "same-origin",
      headers: { "X-CSRF-TOKEN": "csrf-token" },
    });
  });

  it("离线日记先建立服务端 CreativeIntent 再完成账号同步", async () => {
    const ownerId = `pending-${crypto.randomUUID()}`;
    await saveStoredNote({
      id: "note_pending",
      createdAt: "2026-07-28T00:00:00Z",
      intent: "保留层次",
      gearName: "随身摄影包",
      direction: "空间与遮挡",
      focal: "35mm",
      method: "先观察",
      reflection: "",
      syncStatus: "pending",
      pendingCreativeIntent: { analysisTaskId: "scene_001", selectedInterpretationId: "direction_001" },
    }, undefined, ownerId);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/creative-intents")) {
        return new Response(JSON.stringify({
          schema_version: "1.0",
          creative_intent_id: "intent_001",
          source_analysis_id: "scene_001",
          selected_interpretation_id: "direction_001",
          subject_relations: ["前后层次"],
          attention_path: ["亮部"],
          keep: ["空间关系"],
          reduce: [],
          framing_intent: "保留空间关系",
          tonal_intent: null,
          color_intent: null,
          motion_intent: null,
          depth_intent: null,
          texture_intent: null,
          uncertainties: [],
          tradeoffs: ["主体占比会变化"],
          skill_versions: [],
          gear_snapshot: null,
          created_at: "2026-07-28T00:00:00Z",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        id: "note_pending",
        createdAt: "2026-07-28T00:00:00Z",
        updatedAt: "2026-07-28T00:01:00Z",
        intent: "保留层次",
        gearName: "随身摄影包",
        direction: "空间与遮挡",
        focal: "35mm",
        method: "先观察",
        reflection: "",
        creativeIntentId: "intent_001",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(syncPendingAccountJournals(ownerId, "csrf")).resolves.toBe(1);
    const stored = await listStoredNotes(ownerId);
    expect(stored[0]).toMatchObject({ syncStatus: "synced", creativeIntentId: "intent_001" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("单条离线日记失败时继续同步后续记录并保留失败副本", async () => {
    const ownerId = `pending-partial-${crypto.randomUUID()}`;
    await saveStoredNote({
      id: "note_failing",
      createdAt: "2026-07-28T00:02:00Z",
      intent: "失败记录",
      gearName: "随身摄影包",
      direction: "空间与遮挡",
      focal: "35mm",
      method: "先观察",
      reflection: "",
      syncStatus: "pending",
      pendingCreativeIntent: { analysisTaskId: "scene_failing", selectedInterpretationId: "direction_failing" },
    }, undefined, ownerId);
    await saveStoredNote({
      id: "note_succeeding",
      createdAt: "2026-07-28T00:01:00Z",
      intent: "继续同步",
      gearName: "随身摄影包",
      direction: "明暗与色彩",
      focal: "50mm",
      method: "等待光线",
      reflection: "",
      syncStatus: "pending",
      pendingCreativeIntent: { analysisTaskId: "scene_succeeding", selectedInterpretationId: "direction_succeeding" },
    }, undefined, ownerId);

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("scene_failing")) {
        return new Response(JSON.stringify({ title: "暂时失败" }), {
          status: 503,
          headers: { "Content-Type": "application/problem+json" },
        });
      }
      if (url.includes("/creative-intents")) {
        return new Response(JSON.stringify({
          schema_version: "1.0",
          creative_intent_id: "intent_succeeding",
          source_analysis_id: "scene_succeeding",
          selected_interpretation_id: "direction_succeeding",
          subject_relations: [],
          attention_path: [],
          keep: [],
          reduce: [],
          framing_intent: "保留关系",
          tonal_intent: null,
          color_intent: null,
          motion_intent: null,
          depth_intent: null,
          texture_intent: null,
          uncertainties: [],
          tradeoffs: [],
          skill_versions: [],
          gear_snapshot: null,
          created_at: "2026-07-28T00:01:00Z",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        id: "note_succeeding",
        createdAt: "2026-07-28T00:01:00Z",
        updatedAt: "2026-07-28T00:03:00Z",
        intent: "继续同步",
        gearName: "随身摄影包",
        direction: "明暗与色彩",
        focal: "50mm",
        method: "等待光线",
        reflection: "",
        creativeIntentId: "intent_succeeding",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(syncPendingAccountJournals(ownerId, "csrf")).rejects.toThrow("有 1 条设备日记");
    const stored = await listStoredNotes(ownerId);
    expect(stored.find((note) => note.id === "note_failing")).toMatchObject({ syncStatus: "pending" });
    expect(stored.find((note) => note.id === "note_succeeding")).toMatchObject({
      syncStatus: "synced",
      creativeIntentId: "intent_succeeding",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("缺少创作意图的待同步日记明确保留为失败记录", async () => {
    const ownerId = `pending-malformed-${crypto.randomUUID()}`;
    await saveStoredNote({
      id: "note_malformed",
      createdAt: "2026-07-28T00:04:00Z",
      intent: "保留现场感",
      gearName: "随身摄影包",
      direction: "空间与遮挡",
      focal: "35mm",
      method: "先观察",
      reflection: "",
      syncStatus: "pending",
    }, undefined, ownerId);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(syncPendingAccountJournals(ownerId, "csrf")).rejects.toThrow("有 1 条设备日记");
    const stored = await listStoredNotes(ownerId);
    expect(stored[0]).toMatchObject({ id: "note_malformed", syncStatus: "pending" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
