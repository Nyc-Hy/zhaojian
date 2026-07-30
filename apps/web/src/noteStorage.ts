import type { Note } from "./types";

const DATABASE_NAME = "zhaojian-local";
const STORE_NAME = "notes";
const DATABASE_VERSION = 1;

export type StoredNote = Omit<Note, "thumbnail"> & { thumbnailBlob?: Blob };
type PersistedNote = Omit<Note, "thumbnail"> & {
  thumbnailBlob?: Blob;
  thumbnailBytes?: Uint8Array;
  thumbnailMimeType?: string;
};

function databaseName(ownerId?: string): string {
  return ownerId ? `${DATABASE_NAME}:${ownerId}` : DATABASE_NAME;
}

function openDatabase(ownerId?: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName(ownerId), DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("无法打开本地摄影笔记"));
    request.onblocked = () => reject(new Error("本地摄影笔记正在被其他页面占用"));
  });
}

function waitForTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("本地摄影笔记写入失败"));
    transaction.onabort = () => reject(transaction.error ?? new Error("本地摄影笔记写入已取消"));
  });
}

export async function saveStoredNote(note: Note, thumbnailBlob?: Blob, ownerId?: string): Promise<void> {
  const thumbnailBytes = thumbnailBlob ? new Uint8Array(await thumbnailBlob.arrayBuffer()) : undefined;
  const database = await openDatabase(ownerId);
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const { thumbnail: _displayUrl, ...metadata } = note;
    transaction.objectStore(STORE_NAME).put({
      ...metadata,
      thumbnailBytes,
      thumbnailMimeType: thumbnailBlob?.type,
    } satisfies PersistedNote);
    await waitForTransaction(transaction);
  } finally {
    database.close();
  }
}

export async function listStoredNotes(ownerId?: string): Promise<StoredNote[]> {
  const database = await openDatabase(ownerId);
  try {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).getAll();
    const records = await new Promise<PersistedNote[]>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result as PersistedNote[]);
      request.onerror = () => reject(request.error ?? new Error("无法读取本地摄影笔记"));
    });
    await waitForTransaction(transaction);
    return records
      .map(({ thumbnailBytes, thumbnailMimeType, ...record }) => ({
        ...record,
        thumbnailBlob: record.thumbnailBlob
          ?? (thumbnailBytes ? new Blob([Uint8Array.from(thumbnailBytes).buffer], { type: thumbnailMimeType || "image/jpeg" }) : undefined),
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } finally {
    database.close();
  }
}

export async function deleteStoredNote(id: string, ownerId?: string): Promise<void> {
  const database = await openDatabase(ownerId);
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(id);
    await waitForTransaction(transaction);
  } finally {
    database.close();
  }
}

export async function clearStoredNotes(ownerId?: string): Promise<void> {
  const database = await openDatabase(ownerId);
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).clear();
    await waitForTransaction(transaction);
  } finally {
    database.close();
  }
}

function dataUrlToBlob(value: string): Blob | undefined {
  const match = /^data:([^;,]+);base64,(.+)$/.exec(value);
  if (!match) return undefined;
  const bytes = Uint8Array.from(atob(match[2]!), (character) => character.charCodeAt(0));
  return new Blob([bytes], { type: match[1] });
}

export async function migrateLegacyNotes(): Promise<void> {
  const value = localStorage.getItem("zhaojian.notes");
  if (!value) return;
  let notes: Note[];
  try {
    notes = JSON.parse(value) as Note[];
    if (!Array.isArray(notes)) return;
  } catch {
    return;
  }
  for (const note of notes) await saveStoredNote(note, note.thumbnail ? dataUrlToBlob(note.thumbnail) : undefined);
  localStorage.removeItem("zhaojian.notes");
}
