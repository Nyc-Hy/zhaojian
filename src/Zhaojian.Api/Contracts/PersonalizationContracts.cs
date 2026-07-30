namespace Zhaojian.Api.Contracts;

public sealed record PersonalizationSettingsResponse(
    bool MemoryEnabled,
    bool FeedbackSyncConsent,
    DateTimeOffset UpdatedAt);

public sealed record UpdatePersonalizationSettingsRequest(
    bool MemoryEnabled,
    bool FeedbackSyncConsent);

public sealed record FeedbackSyncItemRequest(
    string ClientFeedbackId,
    string AnalysisTaskId,
    string? DirectionId,
    string FeedbackType,
    string Value,
    DateTimeOffset CreatedAt);

public sealed record FeedbackSyncRequest(IReadOnlyList<FeedbackSyncItemRequest> Items);

public sealed record FeedbackRecordResponse(
    string Id,
    string ClientFeedbackId,
    string AnalysisTaskId,
    string? DirectionId,
    string? VisualStrategy,
    string FeedbackType,
    string Value,
    IReadOnlyList<SkillVersionSnapshot> SkillVersions,
    DateTimeOffset CreatedAt,
    DateTimeOffset SyncedAt);

public sealed record CreativePreferenceResponse(
    string Id,
    string PreferenceKind,
    string VisualStrategy,
    int EvidenceCount,
    bool Enabled,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt);

public sealed record PersonalizationSnapshotResponse(
    PersonalizationSettingsResponse Settings,
    IReadOnlyList<CreativePreferenceResponse> Preferences,
    IReadOnlyList<FeedbackRecordResponse> RecentFeedback,
    int IsolatedGlobalCandidateCount);

public sealed record FeedbackSyncResponse(
    IReadOnlyList<string> AcceptedClientFeedbackIds,
    IReadOnlyList<CreativePreferenceResponse> Preferences);

public sealed record UpdateCreativePreferenceRequest(bool Enabled);

public sealed record CreateCreativeIntentRequest(string SelectedInterpretationId);
