using System.Text.Json;
using System.Text.Json.Serialization;

namespace Zhaojian.Api.Contracts;

public sealed class SceneRequest
{
    public string? Intent { get; init; }
    public string? AttentionOption { get; init; }
    public string? SceneDescription { get; init; }
    public string? EnvironmentNotes { get; init; }
    public string? MustKeep { get; init; }
    public string? CanReduce { get; init; }
    public string? DesiredMood { get; init; }
    public string? ClarificationQuestion { get; init; }
    public string? ClarificationAnswer { get; init; }
    public MovementFreedom? MovementFreedom { get; init; }
    public string? GearKitId { get; init; }
    public PhotoTechnicalContext? PhotoTechnicalContext { get; init; }
}

public sealed record MovementFreedom(bool ForwardBackward, bool Lateral, bool Height);
public sealed record PhotoTechnicalContext(
    int OriginalWidth,
    int OriginalHeight,
    int AnalysisWidth,
    int AnalysisHeight,
    string AspectRatio,
    string Orientation,
    bool CompositionPreserved,
    bool MetadataConsent,
    OriginalExifContext? OriginalExif,
    CurrentMeteringContext? CurrentMetering);
public sealed record OriginalExifContext(
    string? CameraMake,
    string? CameraModel,
    string? LensModel,
    double? FocalLengthMm,
    double? FocalLength35Mm,
    double? Aperture,
    double? ExposureSeconds,
    int? Iso,
    double? ExposureCompensationEv,
    string? CapturedAt);
public sealed record CurrentMeteringContext(double Ev100, string Source, DateTimeOffset MeasuredAt);
public sealed record ResolvedGearContext(
    string Id, string Name, string Camera, string? Mount, double SensorWidth, double SensorHeight, double CropFactor,
    string Lens, double FocalMin, double FocalMax, double MaximumAperture, double? MinimumAperture,
    double IbisStops, bool Tripod, double[] NdStops, int MinIso, int MaxIso, string? VerifiedSource, string? VerifiedAt);

public sealed class SceneUnderstanding
{
    public required string SchemaVersion { get; set; }
    public required string RequestId { get; set; }
    public required string Language { get; set; }
    public required SceneObservations Observations { get; set; }
    public required TechnicalObservations TechnicalObservations { get; set; }
}

public sealed class SceneAnalysis
{
    public required string SchemaVersion { get; set; }
    public required string RequestId { get; set; }
    public required string Language { get; set; }
    public required string Outcome { get; set; }
    public Clarification? Clarification { get; set; }
    public NoOptionsResult? NoOptions { get; set; }
    public required SceneObservations Observations { get; set; }
    public required List<Interpretation> Interpretations { get; set; }
    public required TechnicalObservations TechnicalObservations { get; set; }
}

public sealed class NoOptionsResult
{
    public required string Reason { get; set; }
    public required List<string> Evidence { get; set; }
    public string? NextStep { get; set; }
}

public sealed class SceneObservations
{
    public required string Summary { get; set; }
    public required List<AttentionCandidate> AttentionCandidates { get; set; }
    public required List<VisualRelation> VisualRelations { get; set; }
    public required List<string> SpatialLayers { get; set; }
    public required LightObservation Light { get; set; }
    public required List<string> Uncertainties { get; set; }
    public double FactualConfidence { get; set; }
}

public sealed class AttentionCandidate
{
    public required string Label { get; set; }
    public required string Evidence { get; set; }
    public double Confidence { get; set; }
    public double[]? Region { get; set; }
}

public sealed class VisualRelation
{
    public required List<string> Elements { get; set; }
    public required string Relation { get; set; }
    public required string Evidence { get; set; }
    public double Confidence { get; set; }
}

public sealed class LightObservation
{
    public required string Direction { get; set; }
    public required string Contrast { get; set; }
    public required string HighlightRisk { get; set; }
}

public sealed class TechnicalObservations
{
    public required string Motion { get; set; }
    public required string DynamicRange { get; set; }
    public required string LightChange { get; set; }
    public double Confidence { get; set; }
    public List<string>? Notes { get; set; }
}

public sealed class Clarification
{
    public required string Question { get; set; }
    public required string Reason { get; set; }
    public required List<string> Options { get; set; }
}

public sealed class Interpretation
{
    public required string Id { get; set; }
    public required string Title { get; set; }
    public required string Intention { get; set; }
    public required string ViewingQuestion { get; set; }
    public required Grounding Grounding { get; set; }
    public required string VisualStrategy { get; set; }
    public required List<string> Keep { get; set; }
    public required List<string> Reduce { get; set; }
    public required string ViewWidth { get; set; }
    public required Viewpoint Viewpoint { get; set; }
    public required List<FieldStep> FieldSteps { get; set; }
    public required string FramingPlan { get; set; }
    public required string DepthOfFieldIntent { get; set; }
    public required string MotionIntent { get; set; }
    public required string HighlightShadowIntent { get; set; }
    public required string Uncertainty { get; set; }
    public FocalRange? EquivalentFocalHintMm { get; set; }
    public double[]? SuggestedCrop { get; set; }
    public required string VisualEffect { get; set; }
    public required string Tradeoffs { get; set; }
}

public sealed class Grounding
{
    public required List<string> Elements { get; set; }
    public required string Relationship { get; set; }
    public required string IntentConnection { get; set; }
}

public sealed class Viewpoint
{
    public required string Height { get; set; }
    public required string Lateral { get; set; }
    public required string Distance { get; set; }
    public required string Orientation { get; set; }
    public required string Description { get; set; }
    public required string ViewfinderCheck { get; set; }
}

public sealed record FieldStep(string Action, string Check);
public sealed record FocalRange(double Min, double Max);

public sealed record ProviderTiming(long UnderstandingMs, long DirectionMs, bool UnderstandingCacheHit);
public sealed record ProviderUsage(
    [property: JsonPropertyName("promptTokens")] int PromptTokens,
    [property: JsonPropertyName("completionTokens")] int CompletionTokens,
    [property: JsonPropertyName("calls")] int Calls,
    [property: JsonPropertyName("estimatedCostCny")] decimal EstimatedCostCny);
public sealed record ProviderResult(SceneAnalysis Analysis, string Provider, string Model, long DurationMs, bool Degraded, ProviderTiming Timing, ProviderUsage Usage);

public sealed record ProviderStatusResponse(bool Available, string Provider, string Model, string Mode, string Message);
public sealed record AnalysisTimingResponse(
    [property: JsonPropertyName("totalMs")] long TotalMs,
    [property: JsonPropertyName("understandingMs")] long UnderstandingMs,
    [property: JsonPropertyName("directionMs")] long DirectionMs,
    [property: JsonPropertyName("understandingCacheHit")] bool UnderstandingCacheHit);
public sealed record AnalysisProviderResponse(
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("model")] string Model,
    [property: JsonPropertyName("mode")] string Mode,
    [property: JsonPropertyName("degraded")] bool Degraded,
    [property: JsonPropertyName("timing")] AnalysisTimingResponse Timing,
    [property: JsonPropertyName("usage")] ProviderUsage Usage);
public sealed record AnalysisResponse(
    [property: JsonPropertyName("analysis_id")] string AnalysisId,
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("analysis")] SceneAnalysis Analysis,
    [property: JsonPropertyName("provider")] AnalysisProviderResponse Provider,
    [property: JsonPropertyName("image_id")] string ImageId,
    [property: JsonPropertyName("created_at")] DateTimeOffset CreatedAt);
public sealed record AnalysisAcceptedResponse(
    [property: JsonPropertyName("analysis_id")] string AnalysisId,
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("image_id")] string ImageId,
    [property: JsonPropertyName("created_at")] DateTimeOffset CreatedAt);

public static class SceneJson
{
    public static readonly JsonSerializerOptions Provider = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        DictionaryKeyPolicy = JsonNamingPolicy.SnakeCaseLower,
        PropertyNameCaseInsensitive = false,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    public static readonly JsonSerializerOptions Request = new(JsonSerializerDefaults.Web)
    {
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };

    public static readonly JsonSerializerOptions StoredRequest = new(JsonSerializerDefaults.Web)
    {
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Skip
    };
}
