import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { clearStoredNotes, deleteStoredNote, listStoredNotes, saveStoredNote } from "./noteStorage";

describe("本地摄影笔记", () => {
  it("以跨浏览器字节格式保存缩略图，并在读取时还原为 Blob", async () => {
    class DelayedBlob extends Blob {
      override async arrayBuffer(): Promise<ArrayBuffer> {
        await new Promise((resolve) => setTimeout(resolve, 0));
        return super.arrayBuffer();
      }
    }
    const thumbnail = new DelayedBlob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" });
    await saveStoredNote({
      id: "note_storage_001",
      createdAt: "2026-07-16T10:00:00.000Z",
      intent: "一束光",
      gearName: "旅行摄影包",
      direction: "留下天空的力量",
      focal: "28–40mm",
      method: "仅保存观看方向",
      reflection: "",
      thumbnail: "blob:display-only",
    }, thumbnail);
    const records = await listStoredNotes();
    expect(records).toHaveLength(1);
    expect(records[0]?.thumbnailBlob).toBeInstanceOf(Blob);
    expect(records[0]).not.toHaveProperty("thumbnail");
    await deleteStoredNote("note_storage_001");
    expect(await listStoredNotes()).toHaveLength(0);
  });

  it("按账号隔离设备副本", async () => {
    const note = {
      id: "note_shared_id",
      createdAt: "2026-07-22T10:00:00.000Z",
      intent: "一束光",
      gearName: "摄影包",
      direction: "观察边缘",
      focal: "35mm",
      method: "仅保存观看方向",
      reflection: "",
    };
    await saveStoredNote(note, undefined, "user-a");
    expect(await listStoredNotes("user-a")).toHaveLength(1);
    expect(await listStoredNotes("user-b")).toHaveLength(0);
    await clearStoredNotes("user-a");
  });
});
