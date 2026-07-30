import { useEffect, useId, useMemo, useRef, useState } from "react";
import { formatShutter, mapEquivalentFocalRange, shutterForExposure } from "@zhaojian/parameter-engine";
import { deleteAccountGear, deleteAccountJournal, listAccountGears, listAccountJournals, migrateLegacyAccountData, saveAccountGear, saveAccountJournal, syncPendingAccountJournals } from "./accountData";
import { cancelAnalysisTask, createCreativeIntent, deleteAnalysisTask, deleteCreativeIntent, getAnalysisTask, listAnalysisTasks, listCreativeIntents, type AnalysisTaskDetail, type AnalysisTaskSummary } from "./analysisTaskApi";
import { apiProblemMessage, type ApiProblem } from "./apiProblem";
import { buildPhotoTechnicalContext } from "./analysisRequest";
import { AccountPanel, AnalysisHistory, JournalLibrary, ProfileCenter, type AccountMode, type AccountUser, type OperationsStatus, type UsageSummary } from "./accountViews";
import { searchCameras, type CameraCatalogItem } from "./cameraCatalog";
import { clearAccountFeedback, saveStoredAnalysisFeedback, saveStoredDirectionFeedback, type AnalysisFeedback, type DirectionFeedback } from "./feedbackStorage";
import { createCropPreviewGeometry, derivePreviewCrop, formatAspectRatio, formatImageBytes, prepareReferenceImage, referenceImageAspectRatio, type NormalizedCrop, type ReferenceImageInfo } from "./image";
import { clearStoredNotes, deleteStoredNote, listStoredNotes, saveStoredNote } from "./noteStorage";
import { clearPersonalization, deleteCreativePreference, deleteSyncedFeedback, getPersonalization, syncPendingFeedback, updateCreativePreference, updatePersonalizationSettings, type PersonalizationSnapshot } from "./personalizationApi";
import { formatExposureSeconds } from "./photoMetadata";
import type { Analysis, Gear, Interpretation, Note } from "./types";
import type { CreativeIntent } from "./skillContracts";

const exampleGear: Gear = {
  id: "kit_travel_001", name: "旅行摄影包", camera: "示例全画幅机身", sensorWidth: 35.9, sensorHeight: 23.9,
  cropFactor: 1, lensName: "24–70mm F4", focalMin: 24, focalMax: 70, aperture: 4, minimumAperture: 22, ibisStops: 5,
  tripod: true, ndStops: [3, 6], minIso: 100, maxIso: 1600,
};

const focusOptions = ["一束光", "一个形状", "色彩关系", "空间层次", "某个细节", "说不清"];
const moodOptions = ["安静", "辽阔", "克制", "有张力", "有层次", "更抽象"];
const viewLabels: Record<string, string> = { very_wide: "很宽广", wide: "宽广", normal: "自然", narrow: "较窄", detail: "细节" };
const strategyLabels: Record<Interpretation["visual_strategy"], string> = {
  depth_occlusion: "空间与遮挡",
  scale_context: "尺度与环境",
  rhythm_line: "节奏与线条",
  light_color: "明暗与色彩",
  negative_space: "疏密与留白",
  frame_edge: "画框与边缘",
};
const heightLabels: Record<Interpretation["viewpoint"]["height"], string> = { lower: "略低机位", similar: "相近高度", higher: "略高机位", unknown: "高度待现场判断" };
const lateralLabels: Record<Interpretation["viewpoint"]["lateral"], string> = { left: "偏左观察", similar: "左右位置相近", right: "偏右观察", unknown: "左右位置待判断" };
const distanceLabels: Record<Interpretation["viewpoint"]["distance"], string> = { closer: "稍微靠近", similar: "保持距离", farther: "略微退远", unknown: "距离待现场判断" };
const orientationLabels: Record<Interpretation["viewpoint"]["orientation"], string> = { landscape: "横向画幅", portrait: "竖向画幅", square: "方形关系", keep: "保持当前画幅", unknown: "画幅待尝试" };
type Step = "prepare" | "possibilities" | "direction" | "capture" | "saved" | "history" | "profile" | "gears" | "journal";
type AnalysisTiming = { totalMs: number; understandingMs?: number; directionMs?: number; understandingCacheHit: boolean };
type AccountSession = { authenticated: boolean; user?: AccountUser; csrfToken: string };
type AnalysisApiResponse = { analysis_id: string; status: string; analysis: Analysis; provider: { mode: string; timing?: AnalysisTiming }; image_id: string; created_at: string };
type AnalysisAcceptedResponse = { analysis_id: string; status: string; image_id: string; created_at: string };
type CapturePlanApiResponse = {
  gearKitId: string; directionId: string; requestedEquivalentMm: { min: number; max: number }; actualMm: { min: number; max: number }; achievable: boolean;
  aperture: number; safeShutterSeconds: number; baseIso: number; maxIso: number; meteredEv100?: number | null;
  requiredIso?: number | null; selectedIso?: number | null; isoWithinRange?: boolean | null; meteredShutterSeconds?: number | null; note: string;
};

function formatAnalysisDuration(milliseconds: number): string {
  const seconds = milliseconds / 1000;
  return seconds < 10 ? `${seconds.toFixed(1)} 秒` : `${Math.round(seconds)} 秒`;
}

async function loadReferenceImage(imageId: string): Promise<{ response: Response; url: string }> {
  const encodedImageId = encodeURIComponent(imageId);
  const response = await fetch(`/api/v1/reference-images/${encodeURIComponent(imageId)}`, { credentials: "same-origin" });
  return { response, url: `/api/v1/reference-images/${encodedImageId}` };
}

function resolveDirectionPreview(item: Interpretation, analysis: Analysis, imageInfo?: ReferenceImageInfo) {
  if (item.suggested_crop) return { crop: item.suggested_crop, derived: false };
  return {
    crop: derivePreviewCrop({
      viewWidth: item.view_width,
      orientation: item.viewpoint.orientation,
      groundingElements: item.grounding.elements,
    }, analysis.observations.attention_candidates, imageInfo?.analysisWidth ?? 0, imageInfo?.analysisHeight ?? 0),
    derived: true,
  };
}

const sensorPresets = {
  full_frame: { label: "全画幅", width: 35.9, height: 23.9, crop: 1 },
  aps_c: { label: "APS-C", width: 23.5, height: 15.6, crop: 1.5 },
  micro_four_thirds: { label: "M4/3", width: 17.3, height: 13, crop: 2 },
} as const;

const lensPresets = {
  aps_c_18_55: { label: "18–55mm F3.5–5.6", name: "18–55mm F3.5–5.6", min: 18, max: 55, aperture: 5.6, minimumAperture: 22 },
  standard_24_70: { label: "24–70mm F4", name: "24–70mm F4", min: 24, max: 70, aperture: 4, minimumAperture: 22 },
  travel_24_105: { label: "24–105mm F4", name: "24–105mm F4", min: 24, max: 105, aperture: 4, minimumAperture: 22 },
  prime_35: { label: "35mm F1.8", name: "35mm F1.8", min: 35, max: 35, aperture: 1.8, minimumAperture: 16 },
} as const;

type GearDraft = {
  sensorWidth: number; sensorHeight: number; cropFactor: number;
  lensName: string; focalMin: number; focalMax: number; aperture: number; minimumAperture: number;
  ibisStops: number; minIso: number; maxIso: number;
};

function readLocal<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) ?? "") as T; } catch { return fallback; }
}

function App() {
  const [gears, setGears] = useState<Gear[]>([exampleGear]);
  const [gearId, setGearId] = useState(() => gears[0]?.id ?? exampleGear.id);
  const [editingGear, setEditingGear] = useState<Gear | "new" | null>(null);
  const [step, setStep] = useState<Step>("prepare");
  const [imageBlob, setImageBlob] = useState<Blob>();
  const [thumbnailBlob, setThumbnailBlob] = useState<Blob>();
  const [imageInfo, setImageInfo] = useState<ReferenceImageInfo>();
  const [preview, setPreview] = useState("");
  const [imageError, setImageError] = useState("");
  const [imagePreparing, setImagePreparing] = useState(false);
  const [intent, setIntent] = useState("");
  const [focus, setFocus] = useState("");
  const [sceneDescription, setSceneDescription] = useState("");
  const [environmentNotes, setEnvironmentNotes] = useState("");
  const [mustKeep, setMustKeep] = useState("");
  const [canReduce, setCanReduce] = useState("");
  const [desiredMood, setDesiredMood] = useState("");
  const [movementFreedom, setMovementFreedom] = useState({ forwardBackward: false, lateral: false, height: false });
  const [clarification, setClarification] = useState<NonNullable<Analysis["clarification"]>>();
  const [clarificationAnswer, setClarificationAnswer] = useState("");
  const [analysis, setAnalysis] = useState<Analysis>();
  const [currentTaskId, setCurrentTaskId] = useState("");
  const [analysisTiming, setAnalysisTiming] = useState<AnalysisTiming>();
  const [analysisFeedback, setAnalysisFeedback] = useState<AnalysisFeedback>();
  const [directionFeedbackById, setDirectionFeedbackById] = useState<Record<string, DirectionFeedback>>({});
  const [selected, setSelected] = useState<Interpretation>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [serverCapturePlan, setServerCapturePlan] = useState<CapturePlanApiResponse>();
  const [capturePlanLoading, setCapturePlanLoading] = useState(false);
  const [provider, setProvider] = useState<{ mode: string; message: string }>({ mode: "checking", message: "正在确认观察服务…" });
  const [ev, setEv] = useState("");
  const [usingTripod, setUsingTripod] = useState(false);
  const [reflection, setReflection] = useState("");
  const [notes, setNotes] = useState<Note[]>([]);
  const [notesLoading, setNotesLoading] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [journalSynced, setJournalSynced] = useState(true);
  const [accountLoading, setAccountLoading] = useState(true);
  const [account, setAccount] = useState<AccountUser>();
  const [csrfToken, setCsrfToken] = useState("");
  const [accountMode, setAccountMode] = useState<AccountMode>("login");
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountError, setAccountError] = useState("");
  const [accountNotice, setAccountNotice] = useState("");
  const [recoveryEmail, setRecoveryEmail] = useState("");
  const [developmentRecoveryCode, setDevelopmentRecoveryCode] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileMessage, setProfileMessage] = useState("");
  const [accountDataLoading, setAccountDataLoading] = useState(false);
  const [tasks, setTasks] = useState<AnalysisTaskSummary[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [taskError, setTaskError] = useState("");
  const [usageSummary, setUsageSummary] = useState<UsageSummary>();
  const [operationsStatus, setOperationsStatus] = useState<OperationsStatus>();
  const [personalization, setPersonalization] = useState<PersonalizationSnapshot>();
  const [personalizationError, setPersonalizationError] = useState("");
  const [creativeIntents, setCreativeIntents] = useState<CreativeIntent[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const analysisKeyRef = useRef("");
  const analysisRunRef = useRef(0);
  const capturePlanRequestRef = useRef(0);
  const noteUrlsRef = useRef(new Set<string>());
  const accountGenerationRef = useRef(0);
  const sessionAbortRef = useRef<AbortController | undefined>(undefined);
  const tasksRequestRef = useRef(0);
  const taskViewRequestRef = useRef(0);
  const gear = gears.find((item) => item.id === gearId) ?? gears[0] ?? exampleGear;

  useEffect(() => {
    fetch("/api/v1/models/status").then((r) => r.json()).then(setProvider).catch(() => setProvider({ mode: "offline", message: "观察服务暂不可用；器材换算和设备上的离线副本仍可使用。" }));
  }, []);

  useEffect(() => { void refreshSession(); }, []);

  useEffect(() => () => {
    sessionAbortRef.current?.abort();
    releaseNoteUrls();
  }, []);

  useEffect(() => {
    if (!account || step !== "history" || !tasks.some((task) => ["queued", "understanding", "generating"].includes(task.status))) return;
    let stopped = false;
    const poll = async () => {
      while (!stopped) {
        await new Promise((resolve) => window.setTimeout(resolve, 2000));
        if (!stopped) await loadTasks(accountGenerationRef.current);
      }
    };
    void poll();
    return () => { stopped = true; };
  }, [account, step, tasks]);

  const localMapping = useMemo(() => {
    if (!selected) return undefined;
    const requested = selected.equivalent_focal_hint_mm ?? ({ min: 35, max: 50 });
    return mapEquivalentFocalRange(requested, gear.cropFactor, [{
      id: gear.id, name: gear.lensName, focalLength: { min: gear.focalMin, max: gear.focalMax },
      maximumAperture: { min: gear.aperture, max: gear.aperture }, minimumAperture: 22,
    }]);
  }, [selected, gear]);
  const mapping = useMemo(() => serverCapturePlan && localMapping ? {
    ...localMapping,
    requestedEquivalent: serverCapturePlan.requestedEquivalentMm,
    actual: serverCapturePlan.actualMm,
    achievable: serverCapturePlan.achievable,
    note: serverCapturePlan.note,
  } : localMapping, [localMapping, serverCapturePlan]);

  const capturePlan = useMemo(() => {
    if (!mapping || !analysis || !serverCapturePlan) return undefined;
    const focal = (serverCapturePlan.actualMm.min + serverCapturePlan.actualMm.max) / 2;
    const measuredEv = serverCapturePlan.meteredEv100 ?? undefined;
    const exposure = serverCapturePlan.requiredIso == null || serverCapturePlan.selectedIso == null || serverCapturePlan.isoWithinRange == null ? undefined : {
      requiredIso: serverCapturePlan.requiredIso,
      selectedIso: serverCapturePlan.selectedIso,
      withinRange: serverCapturePlan.isoWithinRange,
      differenceEv: Math.abs(Math.log2(serverCapturePlan.requiredIso / serverCapturePlan.selectedIso)),
    };
    const correctedShutter = measuredEv === undefined || !exposure || exposure.withinRange ? undefined : shutterForExposure(measuredEv, serverCapturePlan.aperture, exposure.selectedIso);
    return { focal, handheldShutter: serverCapturePlan.safeShutterSeconds, aperture: serverCapturePlan.aperture, measuredEv, exposure, tripodShutter: serverCapturePlan.meteredShutterSeconds ?? undefined, correctedShutter };
  }, [mapping, analysis, serverCapturePlan]);

  async function pickImage(file?: File) {
    if (!file) return;
    setImageError(""); setImagePreparing(true);
    try {
      const prepared = await prepareReferenceImage(file);
      setImageBlob(prepared.blob); setThumbnailBlob(prepared.thumbnail); setImageInfo(prepared.info); setPreview(prepared.preview); setAnalysis(undefined); setCurrentTaskId(""); setServerCapturePlan(undefined); setAnalysisTiming(undefined); setSelected(undefined); setClarification(undefined); setClarificationAnswer(""); setAnalysisFeedback(undefined); setDirectionFeedbackById({}); analysisKeyRef.current = "";
    } catch (cause) { setImageError(cause instanceof Error ? cause.message : "无法读取这张图片。"); }
    finally { setImagePreparing(false); }
  }

  async function refreshSession() {
    const generation = ++accountGenerationRef.current;
    sessionAbortRef.current?.abort();
    const controller = new AbortController();
    sessionAbortRef.current = controller;
    setAccountLoading(true);
    try {
      const response = await fetch("/api/v1/account/session", { credentials: "same-origin", signal: controller.signal });
      const session = await response.json() as AccountSession;
      if (generation !== accountGenerationRef.current) return;
      setCsrfToken(session.csrfToken);
      setAccount(session.authenticated ? session.user : undefined);
      if (session.authenticated && session.user) {
        await Promise.all([loadTasks(generation), loadAccountData(session.user.id, session.csrfToken, generation)]);
      } else {
        releaseNoteUrls();
        setAccountDataLoading(false);
        setTasks([]); setNotes([]); setGears([exampleGear]); setGearId(exampleGear.id); setPersonalization(undefined); setCreativeIntents([]); setPersonalizationError("");
      }
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      if (generation !== accountGenerationRef.current) return;
      setAccountError("账号服务暂时无法连接。");
    } finally {
      if (generation === accountGenerationRef.current) setAccountLoading(false);
    }
  }

  async function loadAccountData(userId: string, token: string, generation: number) {
    setAccountDataLoading(true);
    try {
      await migrateLegacyAccountData(userId, token);
      let pendingJournalError = "";
      try {
        await syncPendingAccountJournals(userId, token);
      } catch (cause) {
        pendingJournalError = cause instanceof Error ? cause.message : "设备中的待同步日记暂时没有完成同步。";
      }
      const [accountGears, accountNotes, usageResponse, operationsResponse, intentResult, personalizationResult] = await Promise.all([
        listAccountGears(),
        listAccountJournals(),
        fetch("/api/v1/account/usage", { credentials: "same-origin" }),
        fetch("/api/v1/operations/status", { credentials: "same-origin" }),
        listCreativeIntents().then((items) => ({ items, error: "" })).catch((cause) => ({ items: [] as CreativeIntent[], error: cause instanceof Error ? cause.message : "创作意图暂时无法读取。" })),
        getPersonalization().then((snapshot) => ({ snapshot, error: "" })).catch((cause) => ({ snapshot: undefined, error: cause instanceof Error ? cause.message : "创作记忆暂时无法读取。" })),
      ]);
      if (generation !== accountGenerationRef.current) return;
      let nextPersonalization = personalizationResult.snapshot;
      if (nextPersonalization?.settings.feedbackSyncConsent) {
        try {
          if (await syncPendingFeedback(localStorage, userId, token)) nextPersonalization = await getPersonalization();
        } catch (cause) {
          if (!personalizationResult.error) personalizationResult.error = cause instanceof Error ? cause.message : "设备反馈暂时没有完成同步。";
        }
      }
      if (generation !== accountGenerationRef.current) return;
      const [nextUsageSummary, nextOperationsStatus]: [UsageSummary | undefined, OperationsStatus | undefined] = await Promise.all([
        usageResponse.ok ? usageResponse.json() as Promise<UsageSummary> : Promise.resolve(undefined),
        operationsResponse.ok ? operationsResponse.json() as Promise<OperationsStatus> : Promise.resolve(undefined),
      ]);
      if (generation !== accountGenerationRef.current) return;
      const nextGears = accountGears.length ? accountGears : [exampleGear];
      setGears(nextGears);
      setGearId((current) => nextGears.some((item) => item.id === current) ? current : nextGears[0]!.id);
      releaseNoteUrls();
      setNotes(accountNotes);
      setCreativeIntents(intentResult.items);
      setPersonalization(nextPersonalization);
      setPersonalizationError(personalizationResult.error || intentResult.error);
      if (pendingJournalError) setStorageError(`${pendingJournalError} 设备副本会保留，稍后可重试。`);
      if (nextUsageSummary) setUsageSummary(nextUsageSummary);
      if (nextOperationsStatus) setOperationsStatus(nextOperationsStatus);
      localStorage.setItem(`zhaojian.gears:${userId}`, JSON.stringify(accountGears));
    } catch (cause) {
      if (generation !== accountGenerationRef.current) return;
      setStorageError(cause instanceof Error ? `${cause.message} 当前仍可使用这台设备上的副本。` : "账号数据暂时无法读取，当前仍可使用设备副本。");
      const localGears = readLocal<Gear[]>(`zhaojian.gears:${userId}`, [exampleGear]);
      const safeGears = localGears.length ? localGears : [exampleGear];
      setGears(safeGears);
      setGearId((current) => safeGears.some((item) => item.id === current) ? current : safeGears[0]!.id);
      try {
        const localNotes = (await listStoredNotes(userId)).map(({ thumbnailBlob: storedThumbnail, ...note }) => {
          const thumbnail = storedThumbnail ? URL.createObjectURL(storedThumbnail) : undefined;
          return { ...note, thumbnail };
        });
        if (generation !== accountGenerationRef.current) {
          for (const note of localNotes) if (note.thumbnail) URL.revokeObjectURL(note.thumbnail);
          return;
        }
        releaseNoteUrls();
        for (const note of localNotes) if (note.thumbnail) noteUrlsRef.current.add(note.thumbnail);
        setNotes(localNotes);
      } catch { /* 设备副本不可用时保留上面的账号服务错误。 */ }
      setPersonalization(undefined);
      setCreativeIntents([]);
    } finally {
      if (generation === accountGenerationRef.current) setAccountDataLoading(false);
    }
  }

  async function loadTasks(generation = accountGenerationRef.current) {
    const requestId = ++tasksRequestRef.current;
    setTasksLoading(true); setTaskError("");
    try {
      const nextTasks = await listAnalysisTasks();
      if (generation === accountGenerationRef.current && requestId === tasksRequestRef.current) setTasks(nextTasks);
    } catch (cause) {
      if (generation === accountGenerationRef.current && requestId === tasksRequestRef.current) setTaskError(cause instanceof Error ? cause.message : "历史分析暂时无法读取。");
    } finally {
      if (generation === accountGenerationRef.current && requestId === tasksRequestRef.current) setTasksLoading(false);
    }
  }

  function releaseNoteUrls() {
    for (const url of noteUrlsRef.current) URL.revokeObjectURL(url);
    noteUrlsRef.current.clear();
  }

  function invalidateAccountSession() {
    accountGenerationRef.current += 1;
    tasksRequestRef.current += 1;
    taskViewRequestRef.current += 1;
    analysisRunRef.current += 1;
    sessionAbortRef.current?.abort();
    releaseNoteUrls();
    setAccountDataLoading(false);
  }

  async function submitAccount(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setAccountBusy(true); setAccountError(""); setAccountNotice("");
    const data = new FormData(event.currentTarget);
    try {
      if (accountMode === "recover") {
        const email = String(data.get("email"));
        const response = await fetch("/api/v1/account/request-password-reset", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": csrfToken }, body: JSON.stringify({ email }) });
        const payload = await response.json() as { detail?: string; deliveryConfigured?: boolean; developmentRecoveryCode?: string };
        if (!response.ok) throw new Error(payload.detail ?? "暂时无法申请密码恢复。");
        setRecoveryEmail(email); setDevelopmentRecoveryCode(payload.developmentRecoveryCode ?? "");
        if (payload.deliveryConfigured || payload.developmentRecoveryCode) setAccountMode("reset");
        setAccountNotice(payload.deliveryConfigured ? "恢复码已发送，请检查邮箱。" : payload.developmentRecoveryCode ? "本机开发模式已生成一次性恢复码。" : "当前没有配置邮件恢复服务，请联系服务维护者。");
        return;
      }
      if (accountMode === "reset") {
        const response = await fetch("/api/v1/account/reset-password", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": csrfToken }, body: JSON.stringify({ email: String(data.get("email")), recoveryCode: String(data.get("recoveryCode")), newPassword: String(data.get("password")) }) });
        if (!response.ok) { const payload = await response.json() as { detail?: string }; throw new Error(payload.detail ?? "密码没有重置成功。"); }
        setAccountMode("login"); setAccountNotice("密码已重置，现在可以登录。"); setDevelopmentRecoveryCode("");
        return;
      }
      const accountBody = JSON.stringify(accountMode === "register"
        ? { email: String(data.get("email")), password: String(data.get("password")), displayName: String(data.get("displayName") ?? "") }
        : { email: String(data.get("email")), password: String(data.get("password")), rememberMe: true });
      const response = accountMode === "register"
        ? await fetch("/api/v1/account/register", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": csrfToken }, body: accountBody })
        : await fetch("/api/v1/account/login", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": csrfToken }, body: accountBody });
      const payload = response.status === 204 ? undefined : await response.json();
      if (!response.ok) throw new Error(payload?.detail ?? "账号操作没有完成，请稍后重试。");
      await refreshSession();
    } catch (cause) {
      setAccountError(cause instanceof Error ? cause.message : "账号操作没有完成，请稍后重试。");
    } finally {
      setAccountBusy(false);
    }
  }

  async function changePassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setProfileBusy(true); setProfileMessage("");
    const data = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/v1/account/change-password", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": csrfToken }, body: JSON.stringify({ currentPassword: String(data.get("currentPassword")), newPassword: String(data.get("newPassword")) }) });
      if (!response.ok) { const payload = await response.json() as { detail?: string }; throw new Error(payload.detail ?? "密码没有修改成功。"); }
      event.currentTarget.reset(); setProfileMessage("密码已修改，当前登录状态继续有效。");
    } catch (cause) { setProfileMessage(cause instanceof Error ? cause.message : "密码没有修改成功。"); }
    finally { setProfileBusy(false); }
  }

  async function exportAccountData() {
    setProfileMessage("正在整理账号数据…");
    try {
      const response = await fetch("/api/v1/account/export", { credentials: "same-origin" });
      if (!response.ok) throw new Error("账号数据暂时无法导出。");
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = `zhaojian-account-${new Date().toISOString().slice(0, 10)}.zip`; anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000); setProfileMessage("账号数据已经导出。");
    } catch (cause) { setProfileMessage(cause instanceof Error ? cause.message : "账号数据暂时无法导出。"); }
  }

  async function deleteAccount() {
    if (!window.confirm("注销会永久删除账号、摄影包、摄影日记、分析任务和云端分析图，且无法恢复。确认继续吗？")) return;
    const password = window.prompt("请输入当前密码，确认永久注销账号：");
    if (!password) return;
    const response = await fetch("/api/v1/account/delete", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": csrfToken }, body: JSON.stringify({ password }) });
    if (!response.ok) { const payload = await response.json() as { detail?: string }; setProfileMessage(payload.detail ?? "账号没有删除。"); return; }
    if (account) {
      try { await clearStoredNotes(account.id); } catch { /* 服务端注销已完成，本地数据库可能被浏览器占用。 */ }
      clearAccountFeedback(localStorage, account.id);
      localStorage.removeItem(`zhaojian.gears:${account.id}`);
      localStorage.removeItem(`zhaojian.account-data-migrated:${account.id}`);
    }
    invalidateAccountSession(); setAccount(undefined); setTasks([]); setNotes([]); setGears([exampleGear]); setPersonalization(undefined); setCreativeIntents([]); setStep("prepare"); await refreshSession();
  }

  async function logout() {
    setAccountError("");
    const response = await fetch("/api/v1/account/logout", { method: "POST", credentials: "same-origin", headers: { "X-CSRF-TOKEN": csrfToken } });
    if (!response.ok) { setAccountError("暂时无法退出，请刷新页面后重试。"); return; }
    invalidateAccountSession(); setAccount(undefined); setTasks([]); setNotes([]); setGears([exampleGear]); setGearId(exampleGear.id); setPersonalization(undefined); setCreativeIntents([]); setStep("prepare"); setAnalysis(undefined); setSelected(undefined);
    await refreshSession();
  }

  async function openTask(taskId: string) {
    const requestId = ++taskViewRequestRef.current;
    const generation = accountGenerationRef.current;
    analysisRunRef.current += 1;
    setLoading(false);
    setTaskError("");
    const isCurrent = () =>
      requestId === taskViewRequestRef.current && generation === accountGenerationRef.current;
    try {
      const detail = await getAnalysisTask<AnalysisApiResponse>(taskId);
      if (!isCurrent()) return;
      if (!detail.result) throw new Error(detail.errorCode ? `这次任务没有可查看的结果（${detail.errorCode}）。` : "这次任务还没有可查看的结果。");
      const { response: imageResponse, url: imageUrl } = await loadReferenceImage(detail.task.imageId);
      if (!isCurrent()) return;
      if (!imageResponse.ok) throw new Error("这次任务的分析图暂时无法读取。");
      const image = await imageResponse.blob();
      if (!isCurrent()) return;
      setImageBlob(image);
      setThumbnailBlob(undefined);
      setAnalysis(detail.result.analysis);
      setCurrentTaskId(taskId);
      setCreativeIntents((current) => [
        ...(detail.creativeIntents ?? []),
        ...current.filter((item) => !(detail.creativeIntents ?? []).some((saved) => saved.creative_intent_id === item.creative_intent_id)),
      ]);
      setAnalysisTiming(detail.result.provider.timing);
      setProvider((current) => ({ ...current, mode: detail.result?.provider.mode ?? current.mode }));
      setPreview(imageUrl);
      setImageInfo({
        originalBytes: detail.task.imageBytes, originalWidth: detail.task.imageWidth, originalHeight: detail.task.imageHeight,
        analysisBytes: detail.task.imageBytes, analysisWidth: detail.task.imageWidth, analysisHeight: detail.task.imageHeight,
        originalAspectRatio: formatAspectRatio(detail.task.imageWidth, detail.task.imageHeight),
        analysisAspectRatio: formatAspectRatio(detail.task.imageWidth, detail.task.imageHeight),
        compositionPreserved: true,
        scalePercent: 100,
      });
      setIntent(typeof detail.request.intent === "string" ? detail.request.intent : detail.task.intent);
      setSelected(undefined); setStep("possibilities"); window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (cause) {
      if (isCurrent()) setTaskError(cause instanceof Error ? cause.message : "历史结果暂时无法打开。");
    }
  }

  async function reuseTaskImage(task: AnalysisTaskSummary) {
    const requestId = ++taskViewRequestRef.current;
    const generation = accountGenerationRef.current;
    analysisRunRef.current += 1;
    setLoading(false);
    setTaskError("");
    const isCurrent = () =>
      requestId === taskViewRequestRef.current && generation === accountGenerationRef.current;
    try {
      const detail = await getAnalysisTask(task.id);
      if (!isCurrent()) return;
      const { response, url } = await loadReferenceImage(task.imageId);
      if (!isCurrent()) return;
      if (!response.ok) throw new Error("这张分析图暂时无法读取。");
      const blob = await response.blob();
      if (!isCurrent()) return;
      setImageBlob(blob); setThumbnailBlob(undefined); setPreview(url);
      setImageInfo({
        originalBytes: task.imageBytes, originalWidth: task.imageWidth, originalHeight: task.imageHeight,
        analysisBytes: task.imageBytes, analysisWidth: task.imageWidth, analysisHeight: task.imageHeight,
        originalAspectRatio: formatAspectRatio(task.imageWidth, task.imageHeight), analysisAspectRatio: formatAspectRatio(task.imageWidth, task.imageHeight),
        compositionPreserved: true, scalePercent: 100,
      });
      const request = detail.request;
      const text = (key: string) => typeof request[key] === "string" ? request[key] as string : "";
      const freedom = request.movementFreedom && typeof request.movementFreedom === "object"
        ? request.movementFreedom as Partial<typeof movementFreedom>
        : {};
      setIntent(text("intent") || (task.intent === "未填写吸引点" ? "" : task.intent));
      setFocus(text("attentionOption"));
      setSceneDescription(text("sceneDescription"));
      setEnvironmentNotes(text("environmentNotes"));
      setMustKeep(text("mustKeep"));
      setCanReduce(text("canReduce"));
      setDesiredMood(text("desiredMood"));
      setMovementFreedom({
        forwardBackward: Boolean(freedom.forwardBackward),
        lateral: Boolean(freedom.lateral),
        height: Boolean(freedom.height),
      });
      setAnalysis(undefined); setSelected(undefined); setCurrentTaskId(""); analysisKeyRef.current = ""; setStep("prepare");
    } catch (cause) {
      if (isCurrent()) setTaskError(cause instanceof Error ? cause.message : "这张分析图暂时无法读取。");
    }
  }

  async function deleteTask(task: AnalysisTaskSummary) {
    if (!window.confirm("删除这次分析结果？如果这是该图片最后一条结果，服务端分析图也会删除。")) return;
    try { await deleteAnalysisTask(task.id, csrfToken); await loadTasks(); }
    catch (cause) { setTaskError(cause instanceof Error ? cause.message : "这次分析暂时无法删除。"); }
  }

  async function cancelTask(taskId = currentTaskId) {
    if (!taskId) return;
    try { await cancelAnalysisTask(taskId, csrfToken); }
    catch (cause) { setTaskError(cause instanceof Error ? cause.message : "这次分析暂时无法取消。"); return; }
    if (taskId === currentTaskId) {
      analysisRunRef.current += 1;
      analysisKeyRef.current = "";
      setLoading(false);
      setError("这次分析已由你取消；图片和文字仍保留在当前页面。");
    }
    await loadTasks();
  }

  async function analyze() {
    if (!imageBlob) { setImageError("请先选择一张风景参考图。"); return; }
    taskViewRequestRef.current += 1;
    const runId = ++analysisRunRef.current;
    setLoading(true); setError(""); setAnalysisTiming(undefined);
    try {
      const body = new FormData();
      body.append("image", imageBlob, "reference.jpg");
      body.append("request", JSON.stringify({
        intent,
        attentionOption: focus,
        sceneDescription,
        environmentNotes,
        mustKeep,
        canReduce,
        desiredMood,
        movementFreedom,
        clarificationQuestion: clarification?.question,
        clarificationAnswer,
        gearKitId: gear.id,
        photoTechnicalContext: buildPhotoTechnicalContext(imageInfo),
      }));
      if (!analysisKeyRef.current) analysisKeyRef.current = crypto.randomUUID();
      const response = await fetch("/api/v1/scene-analyses", { method: "POST", credentials: "same-origin", headers: { "Idempotency-Key": analysisKeyRef.current, "X-CSRF-TOKEN": csrfToken }, body });
      const payload = await response.json() as AnalysisAcceptedResponse & ApiProblem & { error?: { message?: string } };
      if (runId !== analysisRunRef.current) return;
      if (!response.ok) throw new Error(apiProblemMessage(payload, payload.error?.message ?? "这次没有看清，我们可以稍后再试。"));
      setCurrentTaskId(payload.analysis_id);
      await loadTasks();
      let detail: AnalysisTaskDetail<AnalysisApiResponse> | undefined;
      const deadline = Date.now() + 6 * 60_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 1500));
        if (runId !== analysisRunRef.current) return;
        detail = await getAnalysisTask<AnalysisApiResponse>(payload.analysis_id);
        if (runId !== analysisRunRef.current) return;
        setTasks((current) => current.map((item) => item.id === detail!.task.id ? detail!.task : item));
        if (detail.task.status === "failed") throw new Error(`后台分析没有完成（${detail.errorCode ?? "UNKNOWN"}）。`);
        if (detail.task.status === "canceled") throw new Error("这次分析已取消，图片和文字仍保留在当前页面。");
        if (detail.result) break;
      }
      if (!detail?.result) throw new Error("分析仍在后台继续，你可以稍后从“我的分析”查看结果。");
      const completed = detail.result;
      const nextAnalysis = completed.analysis as Analysis;
      setProvider((current) => ({ ...current, mode: completed.provider.mode }));
      setAnalysisTiming(completed.provider.timing as AnalysisTiming | undefined);
      if (nextAnalysis.outcome === "clarification" && nextAnalysis.clarification) {
        setClarification(nextAnalysis.clarification); setClarificationAnswer(""); setAnalysis(undefined); setSelected(undefined); analysisKeyRef.current = ""; setStep("prepare");
      } else {
        setClarification(undefined); setAnalysis(nextAnalysis); setSelected(undefined); setAnalysisFeedback(undefined); setDirectionFeedbackById({}); setStep("possibilities");
      }
      await loadTasks();
    } catch (cause) {
      if (runId === analysisRunRef.current) setError(cause instanceof Error ? cause.message : "这次没有看清，我们可以稍后再试。");
    } finally {
      if (runId === analysisRunRef.current) setLoading(false);
    }
  }

  function choose(item: Interpretation) {
    capturePlanRequestRef.current += 1;
    setServerCapturePlan(undefined);
    setSelected(item);
    setStep("direction");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function refreshCapturePlan(): Promise<boolean> {
    if (!selected || !currentTaskId) throw new Error("这次分析任务还没有可用的参数上下文。");
    const requestId = ++capturePlanRequestRef.current;
    setCapturePlanLoading(true);
    try {
      const measuredEv = ev.trim() === "" ? undefined : Number(ev);
      const response = await fetch("/api/v1/capture-plans", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": csrfToken },
        body: JSON.stringify({ taskId: currentTaskId, directionId: selected.id, usingTripod, currentMetering: Number.isFinite(measuredEv) ? { ev100: measuredEv, source: "camera_meter", measuredAt: new Date().toISOString() } : undefined }),
      });
      const payload = await response.json() as CapturePlanApiResponse & { detail?: string };
      if (requestId !== capturePlanRequestRef.current) return false;
      if (!response.ok) throw new Error(payload.detail ?? "当前器材参数暂时无法核对。");
      if (payload.directionId !== selected.id) throw new Error("参数结果与当前观看方向不一致，请重新核对。");
      setServerCapturePlan(payload);
      return true;
    } catch (cause) {
      if (requestId !== capturePlanRequestRef.current) return false;
      throw cause;
    } finally {
      if (requestId === capturePlanRequestRef.current) setCapturePlanLoading(false);
    }
  }

  async function openCapture() {
    setError("");
    try { if (await refreshCapturePlan()) setStep("capture"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "当前器材参数暂时无法核对。"); }
  }

  useEffect(() => {
    if (step !== "capture" || !selected || !currentTaskId) return;
    const timer = window.setTimeout(() => { void refreshCapturePlan().catch((cause) => setError(cause instanceof Error ? cause.message : "当前器材参数暂时无法核对。")); }, 250);
    return () => window.clearTimeout(timer);
  }, [step, selected, currentTaskId, ev, usingTripod]);

  async function flushFeedbackForCurrentAccount() {
    if (!account || !personalization?.settings.feedbackSyncConsent) return;
    try {
      await syncPendingFeedback(localStorage, account.id, csrfToken);
      setPersonalization(await getPersonalization());
      setPersonalizationError("");
    } catch (cause) {
      setPersonalizationError(cause instanceof Error ? `${cause.message} 反馈仍保留在当前账号的设备队列中。` : "反馈暂时没有同步，仍保留在设备队列中。");
    }
  }

  function saveAnalysisFeedback(value: AnalysisFeedback) {
    if (!analysis || !account || !currentTaskId) return;
    try {
      saveStoredAnalysisFeedback(localStorage, account.id, currentTaskId, value);
      setAnalysisFeedback(value);
      void flushFeedbackForCurrentAccount();
    } catch {
      setStorageError("这次反馈没有保存在本机，但不会影响当前分析。");
    }
  }

  function saveDirectionFeedback(value: DirectionFeedback) {
    if (!analysis || !selected || !account || !currentTaskId) return;
    try {
      saveStoredDirectionFeedback(localStorage, account.id, {
        analysisId: currentTaskId,
        directionId: selected.id,
        visualStrategy: selected.visual_strategy,
        value,
      });
      setDirectionFeedbackById((current) => ({ ...current, [selected.id]: value }));
      void flushFeedbackForCurrentAccount();
    } catch {
      setStorageError("这个方向的反馈没有保存在本机，但不会影响当前分析。");
    }
  }

  async function saveGear(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const existing = editingGear && editingGear !== "new" ? editingGear : undefined;
    const created: Gear = {
      id: existing?.id ?? `kit_${crypto.randomUUID()}`, name: String(data.get("name")), camera: String(data.get("camera")),
      cameraCatalogId: String(data.get("cameraCatalogId")) || existing?.cameraCatalogId,
      cameraMount: String(data.get("cameraMount")) || existing?.cameraMount,
      cameraSourceUrl: String(data.get("cameraSourceUrl")) || existing?.cameraSourceUrl,
      cameraSpecsVerifiedAt: String(data.get("cameraSpecsVerifiedAt")) || existing?.cameraSpecsVerifiedAt,
      sensorWidth: Number(data.get("sensorWidth")), sensorHeight: Number(data.get("sensorHeight")), cropFactor: Number(data.get("cropFactor")),
      lensName: String(data.get("lensName")), focalMin: Number(data.get("focalMin")), focalMax: Number(data.get("focalMax")),
      aperture: Number(data.get("aperture")), minimumAperture: Number(data.get("minimumAperture")), ibisStops: Number(data.get("ibisStops")), tripod: data.get("tripod") === "on", ndStops: [], minIso: Number(data.get("minIso")), maxIso: Number(data.get("maxIso")),
    };
    if (created.sensorWidth <= 0 || created.sensorHeight <= 0 || created.focalMin <= 0 || created.focalMax < created.focalMin || created.cropFactor <= 0 || created.aperture > (created.minimumAperture ?? 22) || (created.minIso ?? 100) > created.maxIso) {
      setStorageError("器材范围前后不一致，请检查传感器、焦段、光圈与 ISO。")
      return;
    }
    const next = [...gears.filter((item) => item.id !== created.id && item.id !== exampleGear.id), created];
    setGears(next); setGearId(created.id); setEditingGear(null); setStorageError(""); analysisKeyRef.current = "";
    if (account) localStorage.setItem(`zhaojian.gears:${account.id}`, JSON.stringify(next));
    try {
      await saveAccountGear(created, csrfToken);
    } catch (cause) {
      setStorageError(cause instanceof Error ? `${cause.message} 已保存在这台设备，恢复连接后可再次同步。` : "摄影包已保存在设备，但暂时没有同步到账号。");
    }
  }

  async function removeGear(item: Gear) {
    if (!window.confirm(`从个人账号删除摄影包“${item.name}”？已有摄影日记中的器材快照不会改变。`)) return;
    try {
      if (item.id !== exampleGear.id) await deleteAccountGear(item.id, csrfToken);
      const next = gears.filter((value) => value.id !== item.id);
      const available = next.length ? next : [exampleGear];
      setGears(available);
      if (gearId === item.id) setGearId(available[0]!.id);
      if (account) localStorage.setItem(`zhaojian.gears:${account.id}`, JSON.stringify(next));
    } catch (cause) {
      setStorageError(cause instanceof Error ? cause.message : "摄影包暂时无法删除。");
    }
  }

  async function updateProfile(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const displayName = String(new FormData(event.currentTarget).get("displayName") ?? "").trim();
    setProfileBusy(true); setProfileMessage("");
    try {
      const response = await fetch("/api/v1/account/profile", { method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-TOKEN": csrfToken }, body: JSON.stringify({ displayName }) });
      const payload = await response.json() as AccountUser & { detail?: string };
      if (!response.ok) throw new Error(payload.detail ?? "个人资料暂时无法保存。");
      setAccount(payload); setProfileMessage("称呼已更新。");
    } catch (cause) {
      setProfileMessage(cause instanceof Error ? cause.message : "个人资料暂时无法保存。");
    } finally {
      setProfileBusy(false);
    }
  }

  async function removeJournal(note: Note) {
    if (!window.confirm("从个人账号删除这篇摄影日记？对应的分析任务不会被删除。")) return;
    try {
      await deleteAccountJournal(note.id, csrfToken);
      await deleteStoredNote(note.id, account?.id);
      if (note.thumbnail && noteUrlsRef.current.delete(note.thumbnail)) URL.revokeObjectURL(note.thumbnail);
      setNotes((current) => current.filter((item) => item.id !== note.id));
    } catch (cause) {
      setStorageError(cause instanceof Error ? cause.message : "摄影日记暂时无法删除。");
    }
  }

  async function reloadPersonalization() {
    if (!account) return;
    try {
      const snapshot = await getPersonalization();
      setPersonalization(snapshot);
      setPersonalizationError("");
    } catch (cause) {
      setPersonalizationError(cause instanceof Error ? cause.message : "创作记忆暂时无法读取。");
    }
  }

  async function changePersonalizationSettings(memoryEnabled: boolean, feedbackSyncConsent: boolean) {
    if (!account) return;
    setProfileBusy(true); setPersonalizationError("");
    try {
      await updatePersonalizationSettings({ memoryEnabled, feedbackSyncConsent }, csrfToken);
      if (feedbackSyncConsent) await syncPendingFeedback(localStorage, account.id, csrfToken);
      await reloadPersonalization();
    } catch (cause) {
      setPersonalizationError(cause instanceof Error ? cause.message : "创作记忆设置暂时无法保存。");
    } finally {
      setProfileBusy(false);
    }
  }

  async function toggleCreativePreference(id: string, enabled: boolean) {
    try {
      await updateCreativePreference(id, enabled, csrfToken);
      await reloadPersonalization();
    } catch (cause) {
      setPersonalizationError(cause instanceof Error ? cause.message : "这条创作记忆暂时无法更新。");
    }
  }

  async function removeCreativePreference(id: string) {
    if (!window.confirm("删除这条创作记忆？原始明确反馈仍会保留，之后只有新的独立证据才可能再次形成记忆。")) return;
    try {
      await deleteCreativePreference(id, csrfToken);
      await reloadPersonalization();
    } catch (cause) {
      setPersonalizationError(cause instanceof Error ? cause.message : "这条创作记忆暂时无法删除。");
    }
  }

  async function removeSyncedFeedback(id: string) {
    try {
      await deleteSyncedFeedback(id, csrfToken);
      await reloadPersonalization();
    } catch (cause) {
      setPersonalizationError(cause instanceof Error ? cause.message : "这条反馈暂时无法删除。");
    }
  }

  async function clearCreativeMemory() {
    if (!account || !window.confirm("清空账号中的创作记忆、明确反馈和隔离候选？摄影日记与分析任务不会删除。")) return;
    try {
      await clearPersonalization(csrfToken);
      clearAccountFeedback(localStorage, account.id);
      await reloadPersonalization();
    } catch (cause) {
      setPersonalizationError(cause instanceof Error ? cause.message : "创作记忆暂时无法清空。");
    }
  }

  async function removeCreativeIntent(intentId: string) {
    if (!window.confirm("删除这条可追溯创作意图？关联日记会保留，但会明确显示为没有 CreativeIntent 的兼容记录。")) return;
    try {
      await deleteCreativeIntent(intentId, csrfToken);
      setCreativeIntents((current) => current.filter((item) => item.creative_intent_id !== intentId));
      setNotes(await listAccountJournals());
    } catch (cause) {
      setProfileMessage(cause instanceof Error ? cause.message : "这条创作意图暂时无法删除。");
    }
  }

  async function saveNote(ideaOnly = false) {
    if (!selected || !mapping || !account || !currentTaskId || (!ideaOnly && !capturePlan)) return;
    let method = "仅保存观看方向，尚未生成技术起点。";
    if (!ideaOnly && capturePlan && capturePlan.measuredEv !== undefined && usingTripod && capturePlan.tripodShutter) {
      method = `现场 EV100 ${capturePlan.measuredEv} 条件下：三脚架、F${capturePlan.aperture}、${formatShutter(capturePlan.tripodShutter)}、ISO ${gear.minIso ?? 100} 起点`;
    } else if (!ideaOnly && capturePlan?.exposure?.withinRange) {
      method = `现场 EV100 ${capturePlan.measuredEv} 条件下：F${capturePlan.aperture}、${formatShutter(capturePlan.handheldShutter)}、ISO ${capturePlan.exposure.selectedIso} 起点`;
    } else if (!ideaOnly && capturePlan?.exposure && capturePlan.correctedShutter) {
      method = `现场条件需要约 ISO ${capturePlan.exposure.requiredIso}，超出可用范围；若使用 ISO ${capturePlan.exposure.selectedIso}，F${capturePlan.aperture} 需约 ${formatShutter(capturePlan.correctedShutter)}`;
    } else if (!ideaOnly && capturePlan) {
      method = `${usingTripod ? "三脚架、基础 ISO" : `手持不慢于 ${formatShutter(capturePlan.handheldShutter)}`}；先设 F${capturePlan.aperture}，让相机测光决定其余曝光`;
    }
    let note: Note = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      intent: intent || focus || "还没有说清",
      gearName: gear.name,
      direction: selected.title,
      focal: `${mapping.actual.min}–${mapping.actual.max}mm`,
      method,
      reflection,
      syncStatus: "pending",
      pendingCreativeIntent: { analysisTaskId: currentTaskId, selectedInterpretationId: selected.id },
      thumbnail: preview,
    };
    setSavingNote(true); setStorageError("");
    try {
      try {
        const traceableIntent = await createCreativeIntent(currentTaskId, selected.id, csrfToken);
        note = {
          ...note,
          creativeIntentId: traceableIntent.creative_intent_id,
          creativeIntent: traceableIntent,
          pendingCreativeIntent: undefined,
        };
        setCreativeIntents((current) => [
          traceableIntent,
          ...current.filter((item) => item.creative_intent_id !== traceableIntent.creative_intent_id),
        ]);
      } catch (cause) {
        setStorageError(cause instanceof Error ? `${cause.message} 日记会先留在当前账号的设备队列中。` : "创作意图暂时无法建立，日记会先留在设备队列中。");
      }
      await saveStoredNote(note, thumbnailBlob, account.id);
      const thumbnail = thumbnailBlob ? URL.createObjectURL(thumbnailBlob) : undefined;
      if (thumbnail) noteUrlsRef.current.add(thumbnail);
      setNotes((current) => [{ ...note, thumbnail }, ...current.filter((item) => item.id !== note.id)]);
      setJournalSynced(false);
      try {
        if (!note.creativeIntentId) throw new Error("等待恢复连接后建立可追溯创作意图。");
        const accountNote = await saveAccountJournal(note, thumbnailBlob, csrfToken);
        await saveStoredNote({ ...accountNote, syncStatus: "synced" }, thumbnailBlob, account.id);
        if (accountNote.thumbnail && thumbnail && noteUrlsRef.current.delete(thumbnail)) URL.revokeObjectURL(thumbnail);
        setNotes((current) => [{ ...accountNote, thumbnail: accountNote.thumbnail ?? thumbnail }, ...current.filter((item) => item.id !== note.id)]);
        setJournalSynced(true);
      } catch (cause) {
        setStorageError(cause instanceof Error ? `摄影日记已保存在这台设备：${cause.message} 系统会在下次连接账号时重试。` : "摄影日记已保存在设备，系统会在下次连接账号时重试。");
      }
      setStep("saved");
    } catch {
      setStorageError("摄影日记没有保存成功，请检查浏览器是否允许本地存储后重试。");
    } finally {
      setSavingNote(false);
    }
  }

  return <div className="app-shell">
    <header><button className="brand" onClick={() => account && setStep("prepare")}>照见 <span>ZHAOJIAN</span></button><div className="header-actions"><div className={`status ${provider.mode}`}>{provider.mode === "live" ? "真实模型" : provider.mode === "mock" ? "本地演示" : "离线"}</div>{account && <><button className="header-link" onClick={() => { void loadTasks(); setStep("history"); }}>我的分析</button><button className="account-name account-button" onClick={() => setStep("profile")}>{account.displayName}</button><button className="header-link" onClick={() => void logout()}>退出</button></>}</div></header>
    <main>
      {accountLoading && <section className="account-loading" role="status">正在确认个人账号…</section>}
      {!accountLoading && !account && (
        <AccountPanel mode={accountMode} busy={accountBusy} error={accountError} notice={accountNotice} recoveryEmail={recoveryEmail} developmentRecoveryCode={developmentRecoveryCode} onModeChange={setAccountMode} onSubmit={submitAccount}/>
      )}

      {account && step === "profile" && (
        <ProfileCenter account={account} gears={gears} notes={notes} tasks={tasks} usage={usageSummary} operations={operationsStatus} personalization={personalization} personalizationError={personalizationError} creativeIntents={creativeIntents} loading={accountDataLoading} message={profileMessage} busy={profileBusy} onSubmit={updateProfile} onChangePassword={changePassword} onExport={() => void exportAccountData()} onDeleteAccount={() => void deleteAccount()} onBack={() => setStep("prepare")} onOpenGears={() => setStep("gears")} onOpenJournal={() => setStep("journal")} onOpenHistory={() => { void loadTasks(); setStep("history"); }} onPersonalizationSettings={(memoryEnabled, feedbackSyncConsent) => void changePersonalizationSettings(memoryEnabled, feedbackSyncConsent)} onTogglePreference={(id, enabled) => void toggleCreativePreference(id, enabled)} onDeletePreference={(id) => void removeCreativePreference(id)} onDeleteFeedback={(id) => void removeSyncedFeedback(id)} onClearPersonalization={() => void clearCreativeMemory()} onRetryPersonalization={() => void reloadPersonalization()} onDeleteCreativeIntent={(id) => void removeCreativeIntent(id)} exampleGearId={exampleGear.id}/>
      )}
      {account && step === "gears" && (
        <GearLibrary gears={gears} activeId={gearId} editing={editingGear} error={storageError} onBack={() => setStep("profile")} onUse={(id) => { setGearId(id); setStep("prepare"); }} onCreate={() => setEditingGear("new")} onEdit={setEditingGear} onCancel={() => setEditingGear(null)} onSubmit={saveGear} onDelete={(item) => void removeGear(item)}/>
      )}
      {account && step === "journal" && (
        <JournalLibrary notes={notes} loading={notesLoading || accountDataLoading} error={storageError} onBack={() => setStep("profile")} onDelete={(note) => void removeJournal(note)}/>
      )}
      {account && step === "history" && <AnalysisHistory tasks={tasks} loading={tasksLoading} error={taskError} onBack={() => setStep("prepare")} onOpen={(task) => void openTask(task.id)} onReuse={(task) => void reuseTaskImage(task)} onCancel={(task) => void cancelTask(task.id)} onDelete={(task) => void deleteTask(task)}/>}

      {account && step === "prepare" && <>
        <section className="intro"><p className="eyebrow">先看见，再拍下</p><h1>是什么，让你停了下来？</h1><p>你负责感受与选择。照见只提供几种可能，再把你选中的表达翻译成器材可尝试的起点。</p></section>
        <section className="gear-strip"><div><span>此刻的摄影包</span><strong>{gear.name}</strong><small>{gear.camera} · {gear.lensName}（记录焦段 {gear.focalMin}–{gear.focalMax}mm） · {gear.cropFactor}×{gear.cameraMount ? ` · ${gear.cameraMount}` : ""}</small>{gear.warnings?.map((warning) => <small className="field-warning" key={warning}>{warning}</small>)}</div><div className="gear-actions"><select aria-label="选择摄影包" value={gearId} onChange={(e) => { setGearId(e.target.value); analysisKeyRef.current = ""; }}>{gears.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><button className="text-button" onClick={() => setEditingGear(editingGear ? null : "new")}>{editingGear ? "收起" : "＋ 新建"}</button></div></section>
        {editingGear && <GearForm initial={editingGear === "new" ? undefined : editingGear} onSubmit={saveGear} onCancel={() => setEditingGear(null)} />}
        <section className={`photo-stage ${preview ? "has-photo" : ""}`} aria-busy={imagePreparing} role={!preview ? "button" : undefined} tabIndex={!preview ? 0 : undefined} aria-label={!preview ? "选择一张风景参考图" : undefined} onKeyDown={(event) => { if (!preview && !imagePreparing && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); fileRef.current?.click(); } }} onClick={() => !preview && !imagePreparing && fileRef.current?.click()}>
          {preview ? <><img src={preview} alt="参考图预览"/><button className="change-photo" disabled={imagePreparing} onClick={(e) => { e.stopPropagation(); fileRef.current?.click(); }}>换一张</button></> : <div className="empty-photo"><span>＋</span><strong>选择一张风景参考图</strong><small>原图只在本地处理；模型收到的是去除元数据后的轻量分析图。</small></div>}
          {imagePreparing && <div className="image-preparing" role="status"><i className="spinner"/> 正在本地准备分析图…</div>}
          <input ref={fileRef} hidden type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => { void pickImage(e.target.files?.[0]); e.currentTarget.value = ""; }}/>
        </section>
        {imageInfo && (
          <PhotoPreparationDetails info={imageInfo}/>
        )}
        {imageError && <p className="field-error" role="alert">{imageError}</p>}
        <section className="intent"><label htmlFor="intent">眼前是什么吸引了你？</label><textarea id="intent" value={intent} onChange={(e) => { setIntent(e.target.value); analysisKeyRef.current = ""; }} placeholder="例如：远山后面那一点亮光……" maxLength={240}/><div className="chips">{focusOptions.map((item) => <button key={item} className={focus === item ? "selected" : ""} onClick={() => { setFocus(focus === item ? "" : item); analysisKeyRef.current = ""; }}>{item}</button>)}</div></section>
        <fieldset className="movement-field movement-visible"><legend>现场机位可以怎样调整？</legend><label className={movementFreedom.forwardBackward ? "selected" : ""}><input type="checkbox" checked={movementFreedom.forwardBackward} onChange={(event) => { setMovementFreedom((current) => ({ ...current, forwardBackward: event.target.checked })); analysisKeyRef.current = ""; }}/>可以前后移动</label><label className={movementFreedom.lateral ? "selected" : ""}><input type="checkbox" checked={movementFreedom.lateral} onChange={(event) => { setMovementFreedom((current) => ({ ...current, lateral: event.target.checked })); analysisKeyRef.current = ""; }}/>可以左右移动</label><label className={movementFreedom.height ? "selected" : ""}><input type="checkbox" checked={movementFreedom.height} onChange={(event) => { setMovementFreedom((current) => ({ ...current, height: event.target.checked })); analysisKeyRef.current = ""; }}/>可以降低或抬高机位</label><small>可多选。未勾选的方向会按“不确认可以移动”处理，建议会保持在参考图位置附近。</small></fieldset>
        <details className="scene-context">
          <summary><span>补充更多现场信息</span><small>可选，能帮助纠正识别和表达方向</small></summary>
          <div className="context-grid">
            <label className="wide-field">你能确认画面里有什么？<textarea value={sceneDescription} onChange={(event) => { setSceneDescription(event.target.value); analysisKeyRef.current = ""; }} maxLength={300} placeholder="例如：前景是黑色礁石，不是灌木；远处亮点是一艘船。"/><small>当图片模糊或主体容易混淆时，你的现场确认优先。</small></label>
            <label className="wide-field">现场环境有什么正在影响观看？<input value={environmentNotes} onChange={(event) => { setEnvironmentNotes(event.target.value); analysisKeyRef.current = ""; }} maxLength={240} placeholder="例如：傍晚、风正在变大、雾在移动；脚下湿滑，只能原地拍摄"/><small>只发送你确认的简短事实；不读取 GPS 或完整 EXIF，也不据此猜精确曝光。</small></label>
            <label>无论如何想保留什么？<input value={mustKeep} onChange={(event) => { setMustKeep(event.target.value); analysisKeyRef.current = ""; }} maxLength={180} placeholder="例如：右下角的树枝、天空的压迫感"/></label>
            <label>哪些内容愿意弱化？<input value={canReduce} onChange={(event) => { setCanReduce(event.target.value); analysisKeyRef.current = ""; }} maxLength={180} placeholder="例如：岸边杂物、空白天空"/></label>
            <fieldset className="mood-field"><legend>希望照片接近什么感受？</legend><div className="chips compact">{moodOptions.map((item) => <button type="button" key={item} className={desiredMood === item ? "selected" : ""} onClick={() => { setDesiredMood(desiredMood === item ? "" : item); analysisKeyRef.current = ""; }}>{item}</button>)}</div></fieldset>
          </div>
        </details>
        {clarification && <section className="clarification-panel" aria-labelledby="clarification-title">
          <p className="eyebrow">先确认一个关键关系</p><h2 id="clarification-title">{clarification.question}</h2><p>{clarification.reason}</p>
          <div className="clarification-options">{clarification.options.map((option) => <button type="button" key={option} className={clarificationAnswer === option ? "selected" : ""} onClick={() => { setClarificationAnswer(option); analysisKeyRef.current = ""; }}>{option}</button>)}</div>
          <label>也可以用自己的话补充<textarea value={clarificationAnswer} maxLength={240} onChange={(event) => { setClarificationAnswer(event.target.value); analysisKeyRef.current = ""; }} placeholder="只写你在现场能确认的事实或感受"/></label>
          <small>回答会作为你确认的信息重新参与画面理解；不会被当作图片识别事实。</small>
        </section>}
        <div className={`provider-note ${provider.mode === "mock" ? "mock-warning" : ""}`}><span>观察方式</span><p>{provider.message}</p></div>
        {error && <ErrorPanel message={error} onRetry={analyze}/>}
        <button className="primary" disabled={loading || imagePreparing || !imageBlob || Boolean(clarification && !clarificationAnswer.trim())} onClick={analyze}>{loading ? <><i className="spinner"/> 正在先看清画面，再寻找观看可能…</> : imagePreparing ? "正在准备分析图…" : clarification ? "带着补充再看看" : "看看可能性"}</button>
        {loading && currentTaskId && <button className="text-button cancel-analysis" onClick={() => void cancelTask()}>取消这次分析</button>}
        {storageError && <p className="field-error" role="alert">{storageError}</p>}
        <button className="journal-shortcut" onClick={() => setStep("journal")}>查看我的摄影日记 <span>{notes.length} 篇 →</span></button>
      </>}

      {account && step === "possibilities" && analysis && <>
        <Back onClick={() => setStep("prepare")}/><section className="result-heading"><p className="eyebrow">{analysis.outcome === "no_options" ? "不为了数量补齐" : `${analysis.interpretations.length} 种不排名的观看可能`}</p><h1>{analysis.outcome === "no_options" ? "这次没有足够可靠的观看方案" : "你还可以这样看"}</h1><p>{analysis.observations.summary}</p>{analysisTiming && <p className="analysis-timing">本次用时 {formatAnalysisDuration(analysisTiming.totalMs)}{analysisTiming.understandingCacheHit ? " · 已复用刚才的画面理解" : " · 完成画面理解与方向生成"}</p>}</section>
        {provider.mode === "mock" && <div className="mock-disclaimer" role="status"><strong>当前没有识别这张图片</strong><p>这是流程演示，只会有限引用你填写的文字。若要判断图片里的主体、光线与空间，需要启用真实视觉模型。</p></div>}
        {analysis.outcome === "no_options" && analysis.no_options && <section className="no-options-panel" role="status"><div><p className="eyebrow">如实停在这里</p><h2>{analysis.no_options.reason}</h2></div><div><strong>已经检查过</strong><ul>{analysis.no_options.evidence.map((item) => <li key={item}>{item}</li>)}</ul>{analysis.no_options.next_step && <p><strong>如果你愿意继续：</strong>{analysis.no_options.next_step}</p>}</div></section>}
        <section className="observation-basis"><div><p className="eyebrow">这次判断的依据</p><h2>先确认系统理解了什么</h2></div><div>{analysis.observations.attention_candidates.map((candidate) => <article key={`${candidate.label}-${candidate.evidence}`}><strong>{candidate.label}</strong><p>{candidate.evidence}</p></article>)}</div></section>
        {analysis.observations.uncertainties.length > 0 && <section className="uncertainties"><strong>这次仍无法确认</strong><ul>{analysis.observations.uncertainties.map((item) => <li key={item}>{item}</li>)}</ul></section>}
        <button className="text-button result-correction" onClick={() => setStep("prepare")}>识别不对？补充现场信息后再分析 →</button>
        <section className="analysis-feedback" aria-label="分析质量反馈"><div><strong>{analysis.outcome === "no_options" ? "这次选择不凑数，是否符合你对画面的判断？" : "这次是否打开了新的观看可能？"}</strong><small>只保存在本机，不包含图片或文字内容。</small></div><div>{([
          ["helpful", "有启发"], ["too_generic", "太泛"], ["recognition_wrong", "识别不对"],
        ] as const).map(([value, label]) => <button type="button" key={value} className={analysisFeedback === value ? "selected" : ""} onClick={() => saveAnalysisFeedback(value)}>{label}</button>)}</div></section>
        <div className="possibility-grid">{analysis.interpretations.map((item) => {
          const directionPreview = resolveDirectionPreview(item, analysis, imageInfo);
          return <button className="possibility" key={item.id} onClick={() => choose(item)}>
            <ReferenceCropPreview src={preview} crop={directionPreview.crop} imageInfo={imageInfo} label={directionPreview.derived ? "视角范围模拟" : "建议取景预览"}/>
            <div><small>{strategyLabels[item.visual_strategy]} · {viewLabels[item.view_width] ?? "一种视角"}</small><h2>{item.title}</h2><p>{item.intention}</p><p className="viewing-question-preview"><strong>带着这个问题看</strong><span>{item.viewing_question}</span></p><p className="grounding-preview"><strong>{item.grounding.elements.join(" × ")}</strong><span>{item.grounding.relationship}</span></p><ViewpointBadges viewpoint={item.viewpoint} compact/><p className="field-step-preview"><strong>现场先这样试</strong>{item.field_steps?.[0]?.action ?? item.viewpoint.description}<span>看：{item.field_steps?.[0]?.check ?? item.viewpoint.viewfinder_check}</span></p><b>查看完整试法与取舍 →</b></div>
          </button>;
        })}</div>
        <p className="gentle-note">{analysis.outcome === "no_options" ? "没有足够依据时停下来，也比给出相似方案更诚实。你可以补充现场信息，或保留自己的观看。" : "这些方向没有先后与高下。你也可以回到自己的吸引点，换一种说法。"}</p>
      </>}

      {account && step === "direction" && selected && analysis && <>
        <Back onClick={() => setStep("possibilities")}/><section className="direction-hero"><PreviewComparison src={preview} imageInfo={imageInfo} {...resolveDirectionPreview(selected, analysis, imageInfo)}/><div><p className="eyebrow">{strategyLabels[selected.visual_strategy]} · 你选择的方向</p><h1>{selected.title}</h1><p>{selected.visual_effect}</p></div></section>
        <section className="grounding-card"><div><p className="eyebrow">为什么是这张照片</p><h2>{selected.grounding.elements.join(" × ")}</h2></div><div><p>{selected.grounding.relationship}</p><strong>{selected.grounding.intent_connection}</strong></div></section>
        <section className="viewing-question-card"><p className="eyebrow">带着这个问题看</p><h2>{selected.viewing_question}</h2><small>它没有标准答案。改变一次取景范围，再由你判断哪种关系更接近当时的吸引。</small></section>
        <section className="viewpoint-card"><div><p className="eyebrow">相对参考图的机位关系</p><ViewpointBadges viewpoint={selected.viewpoint}/></div><div><h2>{selected.viewpoint.description}</h2><p><strong>在取景器里检查：</strong>{selected.viewpoint.viewfinder_check}</p><small>这是现场试看的相对方向，不是精确位置导航；地形与安全条件由你在现场判断。</small></div></section>
        <section className="field-test-card"><div><p className="eyebrow">带到现场的试法</p><h2>一步一步看它是否成立</h2><small>这些不是命令。任何一步没有回应你的吸引点，都可以停下或换回自己的方式。</small></div><ol>{(selected.field_steps?.length ? selected.field_steps : [{ action: selected.viewpoint.description, check: selected.viewpoint.viewfinder_check }]).map((stepItem) => <li key={`${stepItem.action}-${stepItem.check}`}><strong>{stepItem.action}</strong><span>取景器里看：{stepItem.check}</span></li>)}</ol></section>
        <section className="technical-intent-card"><p className="eyebrow">把观看方向翻译成拍摄意图</p><dl><div><dt>构图与取景</dt><dd>{selected.framing_plan}</dd></div><div><dt>景深</dt><dd>{selected.depth_of_field_intent}</dd></div><div><dt>运动</dt><dd>{selected.motion_intent}</dd></div><div><dt>高光与阴影</dt><dd>{selected.highlight_shadow_intent}</dd></div><div><dt>仍不确定</dt><dd>{selected.uncertainty}</dd></div></dl><small>这些是表达意图，不是模型给出的精确曝光参数；具体数值由摄影包约束和现场测光确定。</small><small>{creativeIntents.some((saved) => saved.source_analysis_id === currentTaskId && saved.selected_interpretation_id === selected.id) ? "这条方向已经保存为可追溯创作意图。" : "保存时会同时记录来源分析、Skill 版本和当时的摄影包快照。"}</small></section>
        <div className="tradeoffs"><article><small>保留</small><p>{selected.keep.join("、")}</p></article><article><small>可以减少</small><p>{selected.reduce.length ? selected.reduce.join("、") : "暂不减少，让关系保持开放"}</p></article><article><small>这种取舍也会失去</small><p>{selected.tradeoffs}</p></article></div>
        <section className="direction-feedback" aria-label="这个方向的现场价值"><div><strong>这个方向值得带到现场试一次吗？</strong><small>只记录方向编号、视觉组织和你的选择，不保存照片或文字。</small></div><div>{([
          ["worth_trying", "值得试一次"], ["too_generic", "还不够具体"], ["recognition_wrong", "画面依据不对"],
        ] as const).map(([value, label]) => <button type="button" key={value} className={directionFeedbackById[selected.id] === value ? "selected" : ""} onClick={() => saveDirectionFeedback(value)}>{label}</button>)}</div></section>
        <button className="primary" disabled={capturePlanLoading} onClick={openCapture}>{capturePlanLoading ? "正在按账号摄影包核对…" : "用我的器材怎么尝试？"}</button><button className="secondary" disabled={savingNote} onClick={() => saveNote(true)}>{savingNote ? "正在保存…" : "只保存这个想法"}</button>
      </>}

      {account && step === "capture" && selected && mapping && capturePlan && analysis && <>
        <Back onClick={() => setStep("direction")}/><section className="result-heading"><p className="eyebrow">从表达回到器材</p><h1>一个可试拍的起点</h1></section>
        <section className="focal-card"><small>建议等效视角</small><strong>{mapping.requestedEquivalent.min}–{mapping.requestedEquivalent.max}mm</strong><div className="rule"/><small>{gear.lensName} · 摄影包记录 {gear.focalMin}–{gear.focalMax}mm</small><strong>{mapping.actual.min}–{mapping.actual.max}mm 实际焦段</strong><p>{mapping.note} 视角是近似关系，透视仍主要由拍摄位置决定；如镜头名称与记录焦段不一致，请先在摄影包中核对。</p></section>
        <section className="constraints"><h2>补充现场条件</h2><label className="toggle"><input type="checkbox" checked={usingTripod} disabled={!gear.tripod} onChange={(e) => setUsingTripod(e.target.checked)}/><span/>使用三脚架 {gear.tripod ? "" : "（摄影包未记录）"}</label><label>相机测得的 EV100（可不填）<input type="number" step="0.1" min="-10" max="24" value={ev} onChange={(e) => setEv(e.target.value)} placeholder="例如 13"/><small>只有真实相机测光或可靠测光表读数，才用于计算曝光三元组。</small></label></section>
        <section className="plans"><article><p className="eyebrow">手持安全参照</p><h2>F{capturePlan.aperture} · 不慢于 {formatShutter(capturePlan.handheldShutter)}</h2><p>ISO Auto，上限 {gear.maxIso}。安全快门依据实际焦段、裁切系数、保守折算后的防抖与可见运动计算；防抖不能补偿主体运动。</p></article>
          {capturePlan.measuredEv !== undefined && usingTripod && capturePlan.tripodShutter ? <article className="measured"><p className="eyebrow">三脚架 · 现场 EV100 {capturePlan.measuredEv}</p><h2>F{capturePlan.aperture} · {formatShutter(capturePlan.tripodShutter)} · ISO {gear.minIso ?? 100}</h2><p>这是使用三脚架和基础 ISO 的确定性试拍起点。快门来自现场 EV，而不是手机参考图。</p></article> : capturePlan.exposure?.withinRange ? <article className="measured"><p className="eyebrow">手持 · 现场 EV100 {capturePlan.measuredEv}</p><h2>F{capturePlan.aperture} · {formatShutter(capturePlan.handheldShutter)} · ISO {capturePlan.exposure.selectedIso}</h2><p>这组参数在当前 ISO 范围内。试拍后仍可按高光、运动和个人表达调整。</p></article> : capturePlan.exposure && capturePlan.correctedShutter ? <article className="caution"><p className="eyebrow">当前约束无法同时满足</p><h2>需要约 ISO {capturePlan.exposure.requiredIso}，可用值为 ISO {capturePlan.exposure.selectedIso}</h2><p>两者相差约 {capturePlan.exposure.differenceEv.toFixed(1)} 档。若保持 F{capturePlan.aperture} 与 ISO {capturePlan.exposure.selectedIso}，快门需约 {formatShutter(capturePlan.correctedShutter)}；是否接受随之而来的抖动或运动变化，由你根据现场决定。</p></article> : <article className="caution"><p className="eyebrow">曝光仍待现场确认</p><h2>不从手机参考图猜测精确曝光</h2><p>{usingTripod ? `可先用三脚架、ISO ${gear.minIso ?? 100}、F${capturePlan.aperture}，让相机测光决定快门。` : `先设 F${capturePlan.aperture} 与安全快门，使用 Auto ISO。`} 试拍后查看直方图与高光警告，再按创作意图调整。</p></article>}
        </section>
        <div className="risk"><strong>试拍时留意</strong><p>{analysis.technical_observations.dynamic_range === "high" ? "画面反差可能较高，先保护你想保留的亮部；阴影是否提亮由你决定。" : "先检查直方图和你关心区域的细节。"}</p></div>
        <label className="reflection">留给之后的自己（可选）<textarea value={reflection} onChange={(e) => setReflection(e.target.value)} placeholder="我想尝试什么，或为什么没有采用某个建议……"/></label>
        {storageError && <p className="field-error" role="alert">{storageError}</p>}
        <button className="primary" disabled={savingNote} onClick={() => saveNote(false)}>{savingNote ? "正在保存…" : "保存为本地摄影笔记"}</button>
      </>}
      {account && step === "capture" && capturePlanLoading && <section className="history-empty"><h2>正在核对摄影包与现场条件…</h2><p>参数由服务端读取当前账号摄影包后确定，原图 EXIF 不会被当作当前测光。</p></section>}

      {account && step === "saved" && <section className="saved"><span>✓</span><p className="eyebrow">{journalSynced ? "已写入个人摄影日记" : "已保存在这台设备"}</p><h1>把决定留给现场的你</h1><p>{journalSynced ? "去元数据的缩略图、吸引点、所选方向与试拍方法已绑定到你的个人账号，同时保留设备副本。" : "设备副本已保存；账号同步暂时没有完成，恢复连接后可以再次同步。"}</p><div className="saved-actions"><button className="primary" onClick={() => { setStep("prepare"); setAnalysis(undefined); setAnalysisTiming(undefined); setSelected(undefined); setImageBlob(undefined); setThumbnailBlob(undefined); setImageInfo(undefined); setPreview(""); setIntent(""); setFocus(""); setSceneDescription(""); setEnvironmentNotes(""); setMustKeep(""); setCanReduce(""); setDesiredMood(""); setMovementFreedom({ forwardBackward: false, lateral: false, height: false }); setClarification(undefined); setClarificationAnswer(""); setAnalysisFeedback(undefined); setDirectionFeedbackById({}); setEv(""); setUsingTripod(false); analysisKeyRef.current = ""; }}>开始一次新的观看</button><button onClick={() => setStep("journal")}>查看摄影日记</button></div></section>}
    </main>
    <footer>照见是一位随行伙伴，不是摄影裁判。原图留在设备；摄影包、日记、去元数据分析图与结果按个人账号隔离保存。</footer>
  </div>;
}

function PhotoPreparationDetails({ info }: { info: ReferenceImageInfo }) {
  const metadata = info.metadata;
  const camera = metadata?.cameraModel
    ? metadata.cameraMake && !metadata.cameraModel.toLocaleLowerCase().includes(metadata.cameraMake.toLocaleLowerCase())
      ? `${metadata.cameraMake} ${metadata.cameraModel}`
      : metadata.cameraModel
    : metadata?.cameraMake;
  const exposure = metadata ? [
    metadata.focalLengthMm ? `${Number(metadata.focalLengthMm.toFixed(1))}mm${metadata.focalLength35Mm ? `（等效 ${metadata.focalLength35Mm}mm）` : ""}` : undefined,
    metadata.aperture ? `f/${Number(metadata.aperture.toFixed(1))}` : undefined,
    metadata.exposureSeconds ? formatExposureSeconds(metadata.exposureSeconds) : undefined,
    metadata.iso ? `ISO ${metadata.iso}` : undefined,
  ].filter(Boolean) : [];
  const localFacts = [
    camera ? `机身：${camera}` : undefined,
    metadata?.lensModel ? `镜头：${metadata.lensModel}` : undefined,
    exposure.length ? `曝光记录：${exposure.join(" · ")}` : undefined,
    metadata?.capturedAt ? `拍摄时间：${metadata.capturedAt.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3")}` : undefined,
    metadata?.orientation ? `原图方向：${metadata.orientation}` : undefined,
  ].filter(Boolean) as string[];

  return <section className="photo-preparation" aria-label="分析图处理说明">
    <div className="image-transfer-note" role="status">
      <span>原图 {info.originalWidth}×{info.originalHeight} · {info.originalAspectRatio} · {formatImageBytes(info.originalBytes)}</span>
      <b aria-hidden="true">→</b>
      <span>分析图 {info.analysisWidth}×{info.analysisHeight} · {info.analysisAspectRatio} · {formatImageBytes(info.analysisBytes)}</span>
    </div>
    <div className={`composition-check ${info.compositionPreserved ? "passed" : "warning"}`}>
      <strong>{info.compositionPreserved ? "✓ 完整画面按比例缩放，未裁切" : "比例发生异常，请重新选择图片"}</strong>
      <span>{info.scalePercent < 100 ? `边长约缩至原来的 ${info.scalePercent}%` : "尺寸保持不变，仅重新编码"}；尺寸仅做像素取整，画面边缘完整保留；像素方向已纠正。</span>
    </div>
    <div className="local-photo-facts">
      <strong>原图本地信息</strong>
      {metadata === undefined
        ? <p>这是账号中已去除元数据的分析图，服务端没有保存原图设备信息。</p>
        : !metadata.exifPresent
          ? <p>没有读取到 EXIF；截图、社交平台导出图或已清理图片通常不会包含这些信息。</p>
          : localFacts.length
            ? <ul>{localFacts.map((fact) => <li key={fact}>{fact}</li>)}</ul>
            : <p>检测到 EXIF，但没有可展示的常见设备或曝光字段。</p>}
      {metadata?.gpsPresent && <p className="privacy-fact">检测到原图包含定位字段；不会显示坐标，分析图已将其移除。</p>}
      <small>这些信息只在当前浏览器中展示，不会发送给 AI。原图曝光记录不等于当前现场测光，也不参与确定性曝光计算。</small>
    </div>
  </section>;
}

function GearLibrary({ gears, activeId, editing, error, onBack, onUse, onCreate, onEdit, onCancel, onSubmit, onDelete }: { gears: Gear[]; activeId: string; editing: Gear | "new" | null; error: string; onBack: () => void; onUse: (id: string) => void; onCreate: () => void; onEdit: (gear: Gear) => void; onCancel: () => void; onSubmit: (event: React.FormEvent<HTMLFormElement>) => void; onDelete: (gear: Gear) => void }) {
  const owned = gears.filter((item) => item.id !== exampleGear.id);
  return <>
    <Back onClick={onBack}/><section className="result-heading"><p className="eyebrow">个人账号中的器材</p><h1>我的摄影包</h1><p>摄影包跟随账号同步；摄影日记会保存当时使用的器材名称快照，之后修改或删除摄影包不会改写旧日记。</p></section>
    <div className="library-toolbar"><span>{owned.length ? `${owned.length} 套摄影包` : "还没有账号摄影包"}</span><button className="primary" onClick={onCreate}>＋ 新建摄影包</button></div>
    {error && <p className="field-error" role="alert">{error}</p>}
    {editing && (
      <GearForm initial={editing === "new" ? undefined : editing} onSubmit={onSubmit} onCancel={onCancel}/>
    )}
    {owned.length === 0 && !editing ? <section className="history-empty"><h2>先建立一套自己的摄影包</h2><p>当前拍摄页仍可使用示例摄影包，但示例不会算作你的账号资料。</p></section> : <div className="gear-library">{owned.map((item) => <article key={item.id} className={item.id === activeId ? "active" : ""}><div><small>{item.id === activeId ? "此刻正在使用" : `${item.cropFactor}× 画幅`}</small><h2>{item.name}</h2><p>{item.camera}</p><p>{item.lensName} · 记录焦段 {item.focalMin}–{item.focalMax}mm · ISO {item.minIso ?? 100}–{item.maxIso}{item.tripod ? " · 有三脚架" : ""}</p>{item.warnings?.map((warning) => <p className="field-warning" key={warning}>{warning}</p>)}</div><div><button onClick={() => onUse(item.id)}>{item.id === activeId ? "继续使用" : "设为此刻使用"}</button><button onClick={() => onEdit(item)}>编辑</button><button className="danger-link" onClick={() => onDelete(item)}>删除</button></div></article>)}</div>}
  </>;
}

function Back({ onClick }: { onClick: () => void }) { return <button className="back" onClick={onClick}>← 返回</button>; }
function ErrorPanel({ message, onRetry }: { message: string; onRetry: () => void }) { return <div className="error-panel" role="alert"><div><strong>这次没有看清</strong><p>{message} 你的图片和文字还在。</p></div><button onClick={onRetry}>重试</button></div>; }
function NotesList({ notes, loading }: { notes: Note[]; loading: boolean }) { return <section className="notes"><p className="eyebrow">这台设备上的摄影笔记</p>{loading ? <p className="empty-notes">正在读取本地笔记…</p> : notes.length === 0 ? <p className="empty-notes">还没有笔记。完成一次观看后，它会留在这里。</p> : notes.map((note) => <article key={note.id}>{note.thumbnail && <img src={note.thumbnail} alt="摄影笔记参考缩略图"/>}<div><small>{new Date(note.createdAt).toLocaleString("zh-CN")}</small><h3>{note.direction}</h3><p>{note.intent} · {note.focal}</p></div></article>)}</section>; }

function ReferenceCropPreview({ src, crop, imageInfo, mode = "crop", label }: { src: string; crop?: NormalizedCrop; imageInfo?: ReferenceImageInfo; mode?: "crop" | "location"; label?: string }) {
  const imageWidth = imageInfo?.analysisWidth ?? 0;
  const imageHeight = imageInfo?.analysisHeight ?? 0;
  const geometry = createCropPreviewGeometry(crop, imageWidth, imageHeight);
  const showsActualCrop = mode === "crop" && geometry.cropped;
  const aspectRatio = showsActualCrop ? geometry.aspectRatio : referenceImageAspectRatio(imageWidth, imageHeight);
  const cropStyle = crop ? {
    left: `${crop[0] * 100}%`,
    top: `${crop[1] * 100}%`,
    width: `${crop[2] * 100}%`,
    height: `${crop[3] * 100}%`,
  } : undefined;

  return <div className={`crop-preview ${showsActualCrop ? "actual-crop" : "full-location"}`} style={{ aspectRatio }}>
    <img src={src} alt={mode === "crop" ? "建议取景范围的本地裁切预览" : "完整参考图与建议取景位置"} style={showsActualCrop ? geometry.imageStyle : undefined}/>
    {mode === "location" && cropStyle && <span className="crop-frame" style={cropStyle} aria-hidden="true"/>}
    <span className="crop-preview-label">{label ?? (showsActualCrop ? "建议取景预览" : mode === "location" ? "完整原图位置" : "完整参考图")}</span>
  </div>;
}

function PreviewComparison({ src, crop, imageInfo, derived }: { src: string; crop: NormalizedCrop; imageInfo?: ReferenceImageInfo; derived: boolean }) {
  return <div className="preview-comparison">
    <ReferenceCropPreview src={src} crop={crop} imageInfo={imageInfo} label={derived ? "视角范围模拟" : "建议取景预览"}/>
    <ReferenceCropPreview src={src} crop={crop} imageInfo={imageInfo} mode="location" label="完整原图中的位置"/>
    <p>{derived ? "模型没有给出独立取景框；这里按建议的视角宽窄、画幅方向与可用关注区域，在浏览器本地模拟范围。" : "这里按模型给出的取景范围，在浏览器本地裁切预览。"} 不会修改原图；机位、透视、光线与最终成片仍由现场决定。</p>
  </div>;
}

function ViewpointBadges({ viewpoint, compact = false }: { viewpoint: Interpretation["viewpoint"]; compact?: boolean }) {
  return <div className={`viewpoint-badges ${compact ? "compact" : ""}`} aria-label="机位关系">
    <span>{heightLabels[viewpoint.height]}</span>
    <span>{lateralLabels[viewpoint.lateral]}</span>
    <span>{distanceLabels[viewpoint.distance]}</span>
    <span>{orientationLabels[viewpoint.orientation]}</span>
  </div>;
}

function CameraCombobox({ value, onChange, onSelect }: { value: string; onChange: (value: string) => void; onSelect: (camera: CameraCatalogItem) => void }) {
  const inputId = useId();
  const listboxId = `${inputId}-listbox`;
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const results = useMemo(() => searchCameras(value), [value]);

  function choose(camera: CameraCatalogItem) {
    onChange(camera.label);
    onSelect(camera);
    setOpen(false);
    setActiveIndex(0);
  }

  return <div className="camera-field">
    <label htmlFor={inputId}>相机名称</label>
    <div className="camera-combobox">
      <input
        id={inputId}
        name="camera"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={open && results[activeIndex] ? `${inputId}-${results[activeIndex].id}` : undefined}
        required
        value={value}
        placeholder="搜索品牌或型号，如 a7m4、富士 XT5"
        maxLength={120}
        autoComplete="off"
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onChange={(event) => { onChange(event.target.value); setOpen(true); setActiveIndex(0); }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && results.length) { event.preventDefault(); setOpen(true); setActiveIndex((current) => Math.min(results.length - 1, current + 1)); }
          else if (event.key === "ArrowUp" && results.length) { event.preventDefault(); setOpen(true); setActiveIndex((current) => Math.max(0, current - 1)); }
          else if (event.key === "Enter" && open && results[activeIndex]) { event.preventDefault(); choose(results[activeIndex]); }
          else if (event.key === "Escape") setOpen(false);
        }}
      />
      {open && <div className="camera-options" id={listboxId} role="listbox" aria-label="匹配的相机型号">
        {results.length ? results.map((camera, index) => <button
          key={camera.id}
          id={`${inputId}-${camera.id}`}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          className={index === activeIndex ? "active" : ""}
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => setActiveIndex(index)}
          onClick={() => choose(camera)}
        ><strong>{camera.label}</strong><small className={camera.specs ? "verified" : "name-only"}>{camera.specs ? `${camera.specs.sensor.formatLabel} · 已核验` : "仅型号"}</small></button>) : <p>没有匹配型号，可继续使用当前文字手动创建。</p>}
      </div>}
    </div>
    <small>“已核验”才会带入官方规格；“仅型号”只帮助搜索，不参与计算。也可以直接输入其他型号。</small>
  </div>;
}

function formatShutterLimit(seconds: number): string {
  if (seconds < 1) return `1/${Math.round(1 / seconds).toLocaleString("zh-CN")} 秒`;
  return `${seconds.toLocaleString("zh-CN")} 秒`;
}

function CameraSpecCard({ camera }: { camera: CameraCatalogItem }) {
  if (!camera.specs) return <aside className="camera-spec-card unverified" aria-live="polite">
    <div><span className="spec-badge">仅核验型号名称</span><strong>{camera.label}</strong></div>
    <p>这台机身的技术字段尚未逐项对照官方资料，因此不会自动填写传感器、防抖或 ISO。请在下方确认传感器规格，高级参数也可按说明书修改。</p>
  </aside>;

  const { specs } = camera;
  const isoExpanded = specs.iso.extendedMin !== undefined && specs.iso.extendedMax !== undefined
    ? `；扩展 ${specs.iso.extendedMin.toLocaleString("zh-CN")}–${specs.iso.extendedMax.toLocaleString("zh-CN")}`
    : "";
  return <aside className="camera-spec-card verified" aria-live="polite">
    <div className="camera-spec-heading"><div><span className="spec-badge">官方规格已核验</span><strong>{camera.label}</strong></div><a href={specs.source.url} target="_blank" rel="noreferrer">查看{specs.source.label} ↗</a></div>
    <dl>
      <div><dt>卡口</dt><dd>{specs.mount}</dd></div>
      <div><dt>传感器</dt><dd>{specs.sensor.formatLabel} · {specs.sensor.width}×{specs.sensor.height} mm · {specs.effectiveMegapixels} MP</dd></div>
      <div><dt>原生 ISO</dt><dd>{specs.iso.nativeMin.toLocaleString("zh-CN")}–{specs.iso.nativeMax.toLocaleString("zh-CN")}{isoExpanded}</dd></div>
      <div><dt>快门范围</dt><dd>机械最快 {formatShutterLimit(specs.shutter.mechanicalShortestSeconds)}{specs.shutter.electronicShortestSeconds ? `；电子最快 ${formatShutterLimit(specs.shutter.electronicShortestSeconds)}` : ""}；最长 {formatShutterLimit(specs.shutter.longestSeconds)}{specs.shutter.bulb ? "，支持 B 门" : ""}</dd></div>
      <div><dt>机身防抖</dt><dd>{specs.stabilization.note}</dd></div>
    </dl>
    {specs.shutter.note && <p>{specs.shutter.note}</p>}
    <p>核验于 {specs.verifiedAt}。安全快门规则对标称防抖最多保守折算 3 档，且防抖不能补偿主体运动。</p>
  </aside>;
}

function GearForm({ initial, onSubmit, onCancel }: { initial?: Gear; onSubmit: (event: React.FormEvent<HTMLFormElement>) => void; onCancel: () => void }) {
  const [sensorPreset, setSensorPreset] = useState<keyof typeof sensorPresets | "custom" | "">(() => {
    if (!initial) return "";
    const matched = Object.entries(sensorPresets).find(([, preset]) =>
      Math.abs(preset.width - initial.sensorWidth) < 0.15 && Math.abs(preset.height - initial.sensorHeight) < 0.15 && Math.abs(preset.crop - initial.cropFactor) < 0.05);
    return matched ? matched[0] as keyof typeof sensorPresets : "custom";
  });
  const [lensPreset, setLensPreset] = useState<keyof typeof lensPresets | "custom">(initial ? "custom" : "aps_c_18_55");
  const [cameraName, setCameraName] = useState(initial?.camera ?? "");
  const [selectedCamera, setSelectedCamera] = useState<CameraCatalogItem>();
  const [draft, setDraft] = useState<GearDraft>({
    sensorWidth: initial?.sensorWidth ?? 23.5, sensorHeight: initial?.sensorHeight ?? 15.6, cropFactor: initial?.cropFactor ?? 1.5,
    lensName: initial?.lensName ?? "18–55mm F3.5–5.6", focalMin: initial?.focalMin ?? 18, focalMax: initial?.focalMax ?? 55, aperture: initial?.aperture ?? 5.6, minimumAperture: initial?.minimumAperture ?? 22,
    ibisStops: initial?.ibisStops ?? 0, minIso: initial?.minIso ?? 100, maxIso: initial?.maxIso ?? 1600,
  });

  function chooseSensor(value: keyof typeof sensorPresets | "custom" | "") {
    setSensorPreset(value);
    if (value && value !== "custom") {
      const preset = sensorPresets[value];
      setDraft((current) => ({ ...current, sensorWidth: preset.width, sensorHeight: preset.height, cropFactor: preset.crop }));
    }
  }

  function chooseLens(value: keyof typeof lensPresets | "custom") {
    setLensPreset(value);
    if (value !== "custom") {
      const preset = lensPresets[value];
      setDraft((current) => ({ ...current, lensName: preset.name, focalMin: preset.min, focalMax: preset.max, aperture: preset.aperture, minimumAperture: preset.minimumAperture }));
    }
  }

  function chooseCamera(camera: CameraCatalogItem) {
    setSelectedCamera(camera);
    if (!camera.specs) {
      setSensorPreset("");
      return;
    }
    setSensorPreset(camera.specs.sensor.preset);
    setDraft((current) => ({
      ...current,
      sensorWidth: camera.specs!.sensor.width,
      sensorHeight: camera.specs!.sensor.height,
      cropFactor: camera.specs!.sensor.cropFactor,
      ibisStops: camera.specs!.stabilization.claimedStops ?? 0,
      minIso: camera.specs!.iso.nativeMin,
      maxIso: Math.max(current.maxIso, camera.specs!.iso.nativeMin),
    }));
  }

  function changeCameraName(value: string) {
    setCameraName(value);
    setSelectedCamera(undefined);
    setSensorPreset("");
  }

  const updateNumber = (key: Exclude<keyof GearDraft, "lensName">, value: string) => setDraft((current) => ({ ...current, [key]: Number(value) }));

  return <form className="gear-form simplified" onSubmit={onSubmit}>
    <div className="gear-form-heading"><div><p className="eyebrow">先确认影响计算的字段</p><h2>{initial ? "编辑摄影包" : "新建摄影包"}</h2><p>型号可以搜索；只有已经核验的官方规格会自动填写。</p></div><button className="text-button" type="button" onClick={onCancel}>取消</button></div>
    <div className="quick-gear-grid">
      <label>摄影包名称<input required name="name" defaultValue={initial?.name ?? "我的摄影包"} maxLength={80}/></label>
      <CameraCombobox value={cameraName} onChange={changeCameraName} onSelect={chooseCamera}/>
      <label>传感器规格<select required aria-label="传感器规格" value={sensorPreset} onChange={(event) => chooseSensor(event.target.value as keyof typeof sensorPresets | "custom" | "")}><option value="" disabled>请选择或确认</option><option value="full_frame">全画幅</option><option value="aps_c">APS-C（1.5×）</option><option value="micro_four_thirds">M4/3（2×）</option><option value="custom">自定义</option></select></label>
      <label>常用镜头<select aria-label="常用镜头" value={lensPreset} onChange={(event) => chooseLens(event.target.value as keyof typeof lensPresets | "custom")}><option value="aps_c_18_55">18–55mm F3.5–5.6</option><option value="standard_24_70">24–70mm F4</option><option value="travel_24_105">24–105mm F4</option><option value="prime_35">35mm F1.8</option><option value="custom">手动输入镜头</option></select></label>
    </div>

    {selectedCamera && <CameraSpecCard camera={selectedCamera}/>}

    {sensorPreset === "custom" && <fieldset className="custom-fields"><legend>自定义传感器</legend><div className="form-grid"><label>宽度 mm<input required type="number" min="1" max="100" step="0.1" value={draft.sensorWidth} onChange={(event) => updateNumber("sensorWidth", event.target.value)}/></label><label>高度 mm<input required type="number" min="1" max="100" step="0.1" value={draft.sensorHeight} onChange={(event) => updateNumber("sensorHeight", event.target.value)}/></label><label>裁切系数<input required type="number" min="0.5" max="10" step="0.1" value={draft.cropFactor} onChange={(event) => updateNumber("cropFactor", event.target.value)}/></label></div></fieldset>}

    {lensPreset === "custom" && <fieldset className="custom-fields"><legend>手动输入镜头</legend><div className="form-grid"><label>镜头名称<input required value={draft.lensName} onChange={(event) => setDraft((current) => ({ ...current, lensName: event.target.value }))} placeholder="例如 16–80mm F4"/></label><label>最短焦段 mm<input required type="number" min="4" max="2000" value={draft.focalMin} onChange={(event) => updateNumber("focalMin", event.target.value)}/></label><label>最长焦段 mm<input required type="number" min="4" max="2000" value={draft.focalMax} onChange={(event) => updateNumber("focalMax", event.target.value)}/></label><label>最大光圈 F<input required type="number" min="0.7" max="64" step="0.1" value={draft.aperture} onChange={(event) => updateNumber("aperture", event.target.value)}/></label></div></fieldset>}

    <label className="check quick-check"><input name="tripod" type="checkbox" defaultChecked={initial?.tripod}/>这套摄影包里有三脚架</label>

    <details className="advanced-gear"><summary>高级参数 <span>请按机身、镜头与个人可接受画质确认</span></summary><div className="form-grid"><label>防抖标称档数<input required type="number" min="0" max="10" step="0.5" value={draft.ibisStops} onChange={(event) => updateNumber("ibisStops", event.target.value)}/><small>规则引擎最多折算 3 档；不确定可填 0。</small></label><label>基础 ISO<input required type="number" min="25" value={draft.minIso} onChange={(event) => updateNumber("minIso", event.target.value)}/></label><label>Auto ISO 上限<input required type="number" min="100" value={draft.maxIso} onChange={(event) => updateNumber("maxIso", event.target.value)}/><small>这是个人画质偏好，不等于机身最高 ISO。</small></label><label>最小光圈 F<input required type="number" min="4" max="128" value={draft.minimumAperture} onChange={(event) => updateNumber("minimumAperture", event.target.value)}/></label></div></details>

    <input type="hidden" name="sensorWidth" value={draft.sensorWidth}/><input type="hidden" name="sensorHeight" value={draft.sensorHeight}/><input type="hidden" name="cropFactor" value={draft.cropFactor}/><input type="hidden" name="lensName" value={draft.lensName}/><input type="hidden" name="focalMin" value={draft.focalMin}/><input type="hidden" name="focalMax" value={draft.focalMax}/><input type="hidden" name="aperture" value={draft.aperture}/><input type="hidden" name="minimumAperture" value={draft.minimumAperture}/><input type="hidden" name="ibisStops" value={draft.ibisStops}/><input type="hidden" name="minIso" value={draft.minIso}/><input type="hidden" name="maxIso" value={draft.maxIso}/><input type="hidden" name="cameraCatalogId" value={selectedCamera?.id ?? ""}/><input type="hidden" name="cameraMount" value={selectedCamera?.specs?.mount ?? ""}/><input type="hidden" name="cameraSourceUrl" value={selectedCamera?.specs?.source.url ?? ""}/><input type="hidden" name="cameraSpecsVerifiedAt" value={selectedCamera?.specs?.verifiedAt ?? ""}/>
    <button className="primary" type="submit" disabled={!cameraName.trim() || (!sensorPreset && !initial)}>{initial ? "保存修改" : "保存并使用这套摄影包"}</button>
  </form>;
}

export default App;
