namespace Zhaojian.Api.Data;

public sealed class PersonalizationSettingsRecord : IUserOwnedResource
{
    public required string UserId { get; set; }
    public bool MemoryEnabled { get; set; }
    public bool FeedbackSyncConsent { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    public ApplicationUser? User { get; set; }
}

public sealed class FeedbackRecord : IUserOwnedResource
{
    public required string Id { get; set; }
    public required string UserId { get; set; }
    public required string ClientFeedbackId { get; set; }
    public required string AnalysisTaskId { get; set; }
    public string? DirectionId { get; set; }
    public string? VisualStrategy { get; set; }
    public required string FeedbackType { get; set; }
    public required string Value { get; set; }
    public required string SkillSnapshotsJson { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public long CreatedAtUnixMs { get; set; }
    public DateTimeOffset SyncedAt { get; set; }
    public long SyncedAtUnixMs { get; set; }
    public ApplicationUser? User { get; set; }
    public AnalysisTaskRecord? AnalysisTask { get; set; }
    public GlobalExperienceCandidateRecord? GlobalCandidate { get; set; }
}

public sealed class CreativePreferenceRecord : IUserOwnedResource
{
    public required string Id { get; set; }
    public required string UserId { get; set; }
    public required string PreferenceKind { get; set; }
    public required string VisualStrategy { get; set; }
    public int EvidenceCount { get; set; }
    public bool Enabled { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public long CreatedAtUnixMs { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    public long UpdatedAtUnixMs { get; set; }
    public ApplicationUser? User { get; set; }
}

public sealed class GlobalExperienceCandidateRecord
{
    public required string Id { get; set; }
    public required string SourceFeedbackId { get; set; }
    public required string CandidateType { get; set; }
    public required string PayloadJson { get; set; }
    public required string Status { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public FeedbackRecord? SourceFeedback { get; set; }
}

public sealed class CreativeIntentRecord : IUserOwnedResource
{
    public required string Id { get; set; }
    public required string UserId { get; set; }
    public string? SourceAnalysisTaskId { get; set; }
    public required string SelectedInterpretationId { get; set; }
    public required string PayloadJson { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public long CreatedAtUnixMs { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    public long UpdatedAtUnixMs { get; set; }
    public ApplicationUser? User { get; set; }
    public AnalysisTaskRecord? SourceAnalysisTask { get; set; }
    public List<JournalEntryRecord> JournalEntries { get; set; } = [];
}
