using System.Text.Json;
using System.Text.Json.Serialization;

namespace Zhaojian.Api.Contracts;

public sealed record AnalysisTaskSummaryResponse(
    string Id,
    string ImageId,
    string Status,
    string Intent,
    int DirectionCount,
    string? Provider,
    string? Model,
    int PromptTokens,
    int CompletionTokens,
    int ProviderCalls,
    decimal EstimatedCostCny,
    string? PricingVersion,
    string ChargeDisposition,
    long DurationMs,
    int ImageWidth,
    int ImageHeight,
    int ImageBytes,
    bool ImageAvailable,
    DateTimeOffset CreatedAt,
    DateTimeOffset? CompletedAt,
    IReadOnlyList<SkillVersionSnapshot> SkillVersions,
    [property: JsonPropertyName("imageUrl")] string ImageUrl);

public sealed record AnalysisTaskDetailResponse(
    AnalysisTaskSummaryResponse Task,
    JsonElement Request,
    JsonElement? Result,
    string? ErrorCode,
    IReadOnlyList<JsonElement> CreativeIntents);

public sealed record AnalysisTaskListResponse(IReadOnlyList<AnalysisTaskSummaryResponse> Items);
