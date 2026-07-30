using System.ComponentModel.DataAnnotations;

namespace Zhaojian.Api.Infrastructure;

public sealed class ModelOptions
{
    public const string SectionName = "Model";

    [RegularExpression("^(mock|qwen)$")]
    public string Provider { get; init; } = "mock";

    public QwenOptions Qwen { get; init; } = new();
}

public sealed class QwenOptions
{
    public string ApiKey { get; init; } = "";

    [Required]
    public string Model { get; init; } = "qwen3.7-plus";

    [Url]
    public string BaseUrl { get; init; } = "https://dashscope.aliyuncs.com/compatible-mode/v1";

    [Range(10, 300)]
    public int TimeoutSeconds { get; init; } = 300;

    [Range(0, 3600)]
    public int UnderstandingCacheSeconds { get; init; } = 600;

    [Range(0, 10000)]
    public decimal InputPerMillionCny { get; init; }

    [Range(0, 10000)]
    public decimal OutputPerMillionCny { get; init; }

    [Required]
    public string PricingVersion { get; init; } = "unconfigured";

    public DateTimeOffset? PricingEffectiveAt { get; init; }
}

public sealed class DataRetentionOptions
{
    public const string SectionName = "DataRetention";

    [Range(1, 3650)]
    public int AnalysisImageDays { get; init; } = 30;

    [Range(5, 1440)]
    public int SweepMinutes { get; init; } = 60;
}
