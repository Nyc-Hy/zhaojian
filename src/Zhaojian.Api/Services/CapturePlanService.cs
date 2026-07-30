using System.Text.Json;
using Zhaojian.Api.Contracts;
using Zhaojian.Api.Data;
using Zhaojian.Api.Infrastructure;

namespace Zhaojian.Api.Services;

public interface IBeforeParameterEngineHook
{
    Task<(AnalysisTaskRecord Task, SceneRequest Request, SceneAnalysis Analysis, ResolvedGearContext Gear)> PrepareAsync(
        string userId, CapturePlanRequest input, CancellationToken cancellationToken);
}

public sealed class BeforeParameterEngineHook(IAnalysisTaskStore store, IBeforeVisionHook beforeVision) : IBeforeParameterEngineHook
{
    public async Task<(AnalysisTaskRecord, SceneRequest, SceneAnalysis, ResolvedGearContext)> PrepareAsync(string userId, CapturePlanRequest input, CancellationToken cancellationToken)
    {
        if (input.CurrentMetering is { } meter && (meter.Ev100 is < -20 or > 30 || meter.Source is not ("manual_meter" or "camera_meter")))
            throw new ApiException(400, "INVALID_METERING", "当前测光必须来自相机或测光表，且 EV100 范围有效。");
        var task = await store.FindTaskAsync(input.TaskId, cancellationToken);
        if (task is null || task.UserId != userId || task.ResultJson is null || task.ReferenceImage is null)
            throw new ApiException(404, "ANALYSIS_NOT_FOUND", "分析任务不存在或不属于当前账号。");
        var request = JsonSerializer.Deserialize<SceneRequest>(task.RequestJson, SceneJson.Request)!;
        var response = JsonSerializer.Deserialize<AnalysisResponse>(task.ResultJson, SceneJson.Provider)!;
        if (response.Analysis.Interpretations.All(value => value.Id != input.DirectionId))
            throw new ApiException(404, "DIRECTION_NOT_FOUND", "所选观看方向不属于这次分析。");
        var image = new ValidatedImage(task.ReferenceImage.Content ?? [], task.ReferenceImage.Width, task.ReferenceImage.Height, task.ReferenceImage.ContentType);
        var gear = await beforeVision.PrepareAsync(userId, request, image, cancellationToken);
        return (task, request, response.Analysis, gear);
    }
}

public sealed class CapturePlanService(IBeforeParameterEngineHook beforeParameterEngine)
{
    public async Task<CapturePlanResponse> BuildAsync(string userId, CapturePlanRequest input, CancellationToken cancellationToken)
    {
        var (_, _, analysis, gear) = await beforeParameterEngine.PrepareAsync(userId, input, cancellationToken);
        if (input.UsingTripod && !gear.Tripod)
            throw new ApiException(400, "TRIPOD_NOT_IN_GEAR_KIT", "当前摄影包没有记录三脚架，请先更新摄影包或改用手持方案。");
        var direction = analysis.Interpretations.Single(value => value.Id == input.DirectionId);
        var requested = direction.EquivalentFocalHintMm ?? new FocalRange(35, 50);
        var desiredMin = requested.Min / gear.CropFactor;
        var desiredMax = requested.Max / gear.CropFactor;
        var overlapMin = Math.Max(desiredMin, gear.FocalMin);
        var overlapMax = Math.Min(desiredMax, gear.FocalMax);
        var achievable = overlapMin <= overlapMax;
        var nearest = Math.Clamp((desiredMin + desiredMax) / 2, gear.FocalMin, gear.FocalMax);
        var actual = achievable ? new FocalRange(overlapMin, overlapMax) : new FocalRange(nearest, nearest);
        var focal = (actual.Min + actual.Max) / 2;
        var creditedStops = Math.Clamp(gear.IbisStops, 0, 3);
        var shakeShutter = 1 / ((focal * gear.CropFactor * 1.25) / Math.Pow(2, creditedStops));
        var motionLimit = analysis.TechnicalObservations.Motion switch { "significant" => 1d / 500, "subtle" => 1d / 125, _ => double.PositiveInfinity };
        var safeShutter = Math.Min(shakeShutter, motionLimit);
        var aperture = Math.Min(Math.Max(8, gear.MaximumAperture), gear.MinimumAperture ?? 22);
        var baseIso = gear.MinIso;
        long? requiredIso = null; int? selectedIso = null; bool? withinRange = null; double? meteredShutter = null;
        if (input.CurrentMetering is { } metering)
        {
            if (input.UsingTripod)
                meteredShutter = 100 * aperture * aperture / (baseIso * Math.Pow(2, metering.Ev100));
            else
            {
                var rawIso = 100 * aperture * aperture / (safeShutter * Math.Pow(2, metering.Ev100));
                var roundedIso = 100 * Math.Pow(2, Math.Round(Math.Log2(rawIso / 100) * 3) / 3);
                requiredIso = !double.IsFinite(roundedIso) || roundedIso >= long.MaxValue
                    ? long.MaxValue
                    : Math.Max(1, (long)Math.Round(roundedIso));
                selectedIso = (int)Math.Clamp(requiredIso.Value, baseIso, gear.MaxIso);
                withinRange = requiredIso >= baseIso && requiredIso <= gear.MaxIso;
            }
        }
        var note = achievable ? "当前账号摄影包可以覆盖这段视角。" : $"无法完整覆盖；{nearest:0.#}mm 是当前镜头最近的实际焦段。";
        return new CapturePlanResponse(gear.Id, direction.Id, requested, actual, achievable, aperture, safeShutter, baseIso, gear.MaxIso,
            input.CurrentMetering?.Ev100, requiredIso, selectedIso, withinRange, meteredShutter, note);
    }
}
