using Zhaojian.Api.Contracts;
using Zhaojian.Api.Infrastructure;
using Zhaojian.Api.Skills;

namespace Zhaojian.Api.Providers;

public sealed record VisionInput(
    string RequestId,
    SceneRequest Request,
    ValidatedImage Image,
    ResolvedGearContext Gear,
    SceneAnalysisSkillPlan SkillPlan,
    Func<string, CancellationToken, Task>? ReportStatus = null);

public interface IVisionProvider
{
    string Name { get; }
    string Model { get; }
    string PromptVersion { get; }
    ProviderStatusResponse Status { get; }
    Task<ProviderResult> AnalyzeAsync(VisionInput input, CancellationToken cancellationToken);
}
