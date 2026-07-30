using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Zhaojian.Api.Contracts;
using Zhaojian.Api.Data;
using Zhaojian.Api.Infrastructure;

namespace Zhaojian.Api.Services;

public interface IBeforeVisionHook
{
    Task<ResolvedGearContext> PrepareAsync(string userId, SceneRequest request, ValidatedImage image, CancellationToken cancellationToken);
}

public interface IAfterUnderstandingHook
{
    void Apply(SceneUnderstanding understanding);
}

public interface IAfterShotOptionsHook
{
    void Apply(SceneAnalysis analysis, SceneUnderstanding understanding, SceneRequest request);
}

public sealed class ValidatedModelOutputHooks(SceneContractValidator validator) : IAfterUnderstandingHook, IAfterShotOptionsHook
{
    public void Apply(SceneUnderstanding understanding)
    {
        if (understanding?.Observations?.AttentionCandidates is null)
            throw new ProviderOutputException("画面理解包含空的必填对象。", stage: "understanding");
        foreach (var candidate in understanding.Observations.AttentionCandidates)
        {
            if (candidate is null) throw new ProviderOutputException("关注元素不能为空。", stage: "understanding");
            candidate.Region = NormalizeOptionalRegion(candidate.Region);
        }
        validator.ValidateUnderstanding(understanding);
    }

    public void Apply(SceneAnalysis analysis, SceneUnderstanding understanding, SceneRequest request)
    {
        analysis.Observations = understanding.Observations;
        analysis.TechnicalObservations = understanding.TechnicalObservations;
        Providers.ModelOutputNormalizer.Normalize(analysis, request);
        validator.ValidateAnalysis(analysis, request);
    }

    private static double[]? NormalizeOptionalRegion(double[]? region)
    {
        if (region is null) return null;
        if (region.Length != 4 || region.Any(value => !double.IsFinite(value) || value < 0 || value > 1)) return null;
        var (x, y, width, height) = (region[0], region[1], region[2], region[3]);
        if (width > 0 && height > 0 && x + width <= 1.000001 && y + height <= 1.000001) return region;
        if (width > x && height > y) return [x, y, width - x, height - y];
        return null;
    }
}

public sealed class AccountAnalysisInputHook(ZhaojianDbContext database, SceneContractValidator validator) : IBeforeVisionHook
{
    public async Task<ResolvedGearContext> PrepareAsync(string userId, SceneRequest request, ValidatedImage image, CancellationToken cancellationToken)
    {
        validator.ValidateRequest(request);
        var photo = request.PhotoTechnicalContext;
        if (photo is not null && (photo.AnalysisWidth != image.Width || photo.AnalysisHeight != image.Height))
            throw new ApiException(400, "PHOTO_CONTEXT_MISMATCH", "图片技术信息与实际分析图尺寸不一致。");
        var gear = await database.GearKits.AsNoTracking().SingleOrDefaultAsync(
            value => value.Id == request.GearKitId && value.UserId == userId, cancellationToken)
            ?? throw new ApiException(404, "GEAR_KIT_NOT_FOUND", "所选摄影包不存在或不属于当前账号。");
        return new ResolvedGearContext(
            gear.Id, gear.Name, gear.Camera, gear.CameraMount, gear.SensorWidth, gear.SensorHeight, gear.CropFactor,
            gear.LensName, gear.FocalMin, gear.FocalMax, gear.Aperture, gear.MinimumAperture, gear.IbisStops,
            gear.Tripod, JsonSerializer.Deserialize<double[]>(gear.NdStopsJson) ?? [], gear.MinIso ?? 100, gear.MaxIso,
            gear.CameraSourceUrl, gear.CameraSpecsVerifiedAt);
    }
}
