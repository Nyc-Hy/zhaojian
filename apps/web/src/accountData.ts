import { clearStoredNotes, listStoredNotes, migrateLegacyNotes, saveStoredNote, type StoredNote } from "./noteStorage";
import { createCreativeIntent } from "./analysisTaskApi";
import type { Gear, Note } from "./types";
import { readApiProblem } from "./apiProblem";

type ListResponse<T> = { items: T[] };
type JournalResponse = Omit<Note, "thumbnail"> & { updatedAt: string; thumbnailUrl?: string };

async function requestJson<T>(url: string, init?: RequestInit, fallback = "账号数据暂时无法读取。"): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", ...init });
  if (!response.ok) throw await readApiProblem(response, fallback);
  return await response.json() as T;
}

function writeHeaders(csrfToken: string): HeadersInit {
  return { "Content-Type": "application/json", "X-CSRF-TOKEN": csrfToken };
}

async function blobToDataUrl(blob?: Blob): Promise<string | undefined> {
  if (!blob) return undefined;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return `data:${blob.type || "image/jpeg"};base64,${btoa(binary)}`;
}

export async function listAccountGears(): Promise<Gear[]> {
  return (await requestJson<ListResponse<Gear>>("/api/v1/gear-kits")).items;
}

export async function saveAccountGear(gear: Gear, csrfToken: string): Promise<Gear> {
  return await requestJson<Gear>("/api/v1/gear-kits", {
    method: "POST",
    headers: writeHeaders(csrfToken),
    body: JSON.stringify(gear),
  }, "摄影包暂时无法同步到账号。");
}

export async function deleteAccountGear(id: string, csrfToken: string): Promise<void> {
  const response = await fetch(`/api/v1/gear-kits/${encodeURIComponent(id)}`, { method: "DELETE", credentials: "same-origin", headers: { "X-CSRF-TOKEN": csrfToken } });
  if (!response.ok) throw await readApiProblem(response, "摄影包暂时无法删除。");
}

export async function listAccountJournals(): Promise<Note[]> {
  const payload = await requestJson<ListResponse<JournalResponse>>("/api/v1/journal-entries?limit=200");
  return payload.items.map(({ thumbnailUrl, updatedAt: _updatedAt, ...note }) => ({ ...note, thumbnail: thumbnailUrl }));
}

export async function saveAccountJournal(note: Note, thumbnailBlob: Blob | undefined, csrfToken: string): Promise<Note> {
  const payload = await requestJson<JournalResponse>("/api/v1/journal-entries", {
    method: "POST",
    headers: writeHeaders(csrfToken),
    body: JSON.stringify({
      id: note.id,
      createdAt: note.createdAt,
      intent: note.intent,
      gearName: note.gearName,
      direction: note.direction,
      focal: note.focal,
      method: note.method,
      reflection: note.reflection,
      creativeIntentId: note.creativeIntentId,
      thumbnailDataUrl: await blobToDataUrl(thumbnailBlob),
    }),
  }, "摄影日记暂时无法同步到账号。");
  const { thumbnailUrl, updatedAt: _updatedAt, ...saved } = payload;
  return { ...saved, syncStatus: "synced", thumbnail: thumbnailUrl };
}

export async function deleteAccountJournal(id: string, csrfToken: string): Promise<void> {
  const response = await fetch(`/api/v1/journal-entries/${encodeURIComponent(id)}`, { method: "DELETE", credentials: "same-origin", headers: { "X-CSRF-TOKEN": csrfToken } });
  if (!response.ok) throw await readApiProblem(response, "摄影日记暂时无法删除。");
}

export async function migrateLegacyAccountData(userId: string, csrfToken: string): Promise<void> {
  const marker = `zhaojian.account-data-migrated:${userId}`;
  if (localStorage.getItem(marker) === "1") return;

  const ownerMarker = "zhaojian.legacy-data-owner";
  const claimedOwner = localStorage.getItem(ownerMarker);
  if (claimedOwner && claimedOwner !== userId) return;
  localStorage.setItem(ownerMarker, userId);
  await migrateLegacyNotes();

  const storedGears = localStorage.getItem("zhaojian.gears");
  if (storedGears) {
    let gears: Gear[] = [];
    try {
      const parsed = JSON.parse(storedGears) as Gear[];
      if (Array.isArray(parsed)) gears = parsed;
    } catch {
      // 旧数据损坏时不阻止账号页面使用，仍保留原始本地值。
    }
    for (const gear of gears.filter((item) => item.id !== "kit_travel_001")) await saveAccountGear(gear, csrfToken);
  }
  const notes: StoredNote[] = await listStoredNotes();
  for (const { thumbnailBlob, ...note } of notes) await saveAccountJournal(note, thumbnailBlob, csrfToken);
  localStorage.removeItem("zhaojian.gears");
  await clearStoredNotes();
  localStorage.setItem(marker, "1");
}

export async function syncPendingAccountJournals(userId: string, csrfToken: string): Promise<number> {
  const notes = await listStoredNotes(userId);
  let synced = 0;
  const failures: unknown[] = [];
  for (const { thumbnailBlob, ...stored } of notes.filter((item) => item.syncStatus === "pending")) {
    try {
      let note: Note = stored;
      if (note.pendingCreativeIntent) {
        const intent = await createCreativeIntent(
          note.pendingCreativeIntent.analysisTaskId,
          note.pendingCreativeIntent.selectedInterpretationId,
          csrfToken,
        );
        note = {
          ...note,
          creativeIntentId: intent.creative_intent_id,
          creativeIntent: intent,
          pendingCreativeIntent: undefined,
        };
        await saveStoredNote({ ...note, syncStatus: "pending" }, thumbnailBlob, userId);
      }
      if (!note.creativeIntentId) {
        throw new Error("这条设备日记缺少可同步的创作意图。");
      }
      const saved = await saveAccountJournal(note, thumbnailBlob, csrfToken);
      await saveStoredNote({ ...note, ...saved, syncStatus: "synced" }, thumbnailBlob, userId);
      synced += 1;
    } catch (cause) {
      failures.push(cause);
    }
  }
  if (failures.length) throw new Error(`有 ${failures.length} 条设备日记暂时没有完成同步，其余记录已继续处理。`);
  return synced;
}
