using System.ComponentModel.DataAnnotations;

namespace Zhaojian.Api.Infrastructure;

public sealed class SkillRegistryOptions
{
    public const string SectionName = "SkillRegistry";

    [Required]
    public string RootPath { get; init; } = "SkillModules";

    [Required]
    public string StatePath { get; init; } = "App_Data/skill-registry-state.json";

    [Required]
    public string EvaluationRootPath { get; init; } = "../../.local/skill-evaluations";

    [Required]
    public string EvaluationDatasetId { get; init; } = "photography-skill-v3";

    [Required]
    [RegularExpression(@"^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$")]
    public string EvaluationDatasetVersion { get; init; } = "3.0.0";

    [Required]
    [RegularExpression(@"^sha256:[0-9a-f]{64}$")]
    public string EvaluationDatasetContentHash { get; init; } =
        "sha256:887c338ab37c715e087822db8d73d7253485dbcc522f5126b573c57f31efb335";

    [Required]
    [RegularExpression(@"^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$")]
    public string RuntimeVersion { get; init; } = "1.0.0";

    public bool CloudSkillsEnabled { get; init; } = true;

    [Range(1, 500)]
    public int MaxDefinitions { get; init; } = 100;

    [Range(1024, 1048576)]
    public int MaxDefinitionBytes { get; init; } = 128 * 1024;

    [Range(1024, 10485760)]
    public int MaxArtifactBytes { get; init; } = 2 * 1024 * 1024;

    [Range(1, 256)]
    public int MaxArtifactCount { get; init; } = 100;

    [Range(4096, 4194304)]
    public int MaxBundleBytes { get; init; } = 256 * 1024;

    [Range(4096, 4194304)]
    public int MaxEvaluationReportBytes { get; init; } = 1024 * 1024;

    [Range(10, 5000)]
    public int MaxAuditEntries { get; init; } = 500;
}
