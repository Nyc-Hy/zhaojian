namespace Zhaojian.Api.Data;

public interface IUserOwnedResource
{
    string UserId { get; }
}

public sealed class ReferenceImageRecord : IUserOwnedResource
{
    public required string Id { get; set; }
    public required string UserId { get; set; }
    public required string Sha256 { get; set; }
    public required string ContentType { get; set; }
    public byte[]? Content { get; set; }
    public int Width { get; set; }
    public int Height { get; set; }
    public int ByteLength { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset? PurgedAt { get; set; }
    public ApplicationUser? User { get; set; }
    public List<AnalysisTaskRecord> AnalysisTasks { get; set; } = [];
}

public sealed class AnalysisTaskRecord : IUserOwnedResource
{
    public required string Id { get; set; }
    public required string UserId { get; set; }
    public required string ReferenceImageId { get; set; }
    public required string IdempotencyKey { get; set; }
    public required string Fingerprint { get; set; }
    public required string Status { get; set; }
    public required string RequestJson { get; set; }
    public string? SkillSnapshotsJson { get; set; }
    public string? GearSnapshotJson { get; set; }
    public string? ResultJson { get; set; }
    public string? Provider { get; set; }
    public string? Model { get; set; }
    public int PromptTokens { get; set; }
    public int CompletionTokens { get; set; }
    public int ProviderCalls { get; set; }
    public decimal EstimatedCostCny { get; set; }
    public string? PricingVersion { get; set; }
    public string? ChargeDisposition { get; set; }
    public long DurationMs { get; set; }
    public long UnderstandingMs { get; set; }
    public long DirectionMs { get; set; }
    public bool UnderstandingCacheHit { get; set; }
    public string? ErrorCode { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public long CreatedAtUnixMs { get; set; }
    public DateTimeOffset? CompletedAt { get; set; }
    public long? CompletedAtUnixMs { get; set; }
    public ApplicationUser? User { get; set; }
    public ReferenceImageRecord? ReferenceImage { get; set; }
    public List<FeedbackRecord> FeedbackRecords { get; set; } = [];
    public List<CreativeIntentRecord> CreativeIntents { get; set; } = [];
}

public static class AnalysisTaskStatuses
{
    public const string Queued = "queued";
    public const string Understanding = "understanding";
    public const string Generating = "generating";
    public const string Completed = "completed";
    public const string NeedsInput = "needs_input";
    public const string Failed = "failed";
    public const string Canceled = "canceled";
}
