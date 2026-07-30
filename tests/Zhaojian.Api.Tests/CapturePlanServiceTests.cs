using Zhaojian.Api.Contracts;
using Zhaojian.Api.Data;
using Zhaojian.Api.Infrastructure;
using Zhaojian.Api.Services;

namespace Zhaojian.Api.Tests;

public sealed class CapturePlanServiceTests
{
    [Fact]
    public async Task Extreme_Valid_Inputs_Preserve_Required_Iso_Above_Int32()
    {
        var service = new CapturePlanService(new FixedHook(tripod: false));

        var result = await service.BuildAsync("user", new CapturePlanRequest(
            "scene_test", "direction-1", false,
            new CurrentMeteringContext(-10, "camera_meter", DateTimeOffset.UtcNow)), CancellationToken.None);

        Assert.True(result.RequiredIso > int.MaxValue);
        Assert.Equal(1_000_000, result.SelectedIso);
        Assert.False(result.IsoWithinRange);
    }

    [Fact]
    public async Task Tripod_Plan_Requires_Tripod_In_Account_Gear()
    {
        var service = new CapturePlanService(new FixedHook(tripod: false));

        var error = await Assert.ThrowsAsync<ApiException>(() => service.BuildAsync("user", new CapturePlanRequest(
            "scene_test", "direction-1", true,
            new CurrentMeteringContext(10, "camera_meter", DateTimeOffset.UtcNow)), CancellationToken.None));

        Assert.Equal("TRIPOD_NOT_IN_GEAR_KIT", error.Code);
    }

    private sealed class FixedHook(bool tripod) : IBeforeParameterEngineHook
    {
        public Task<(AnalysisTaskRecord Task, SceneRequest Request, SceneAnalysis Analysis, ResolvedGearContext Gear)> PrepareAsync(
            string userId, CapturePlanRequest input, CancellationToken cancellationToken)
        {
            var direction = new Interpretation
            {
                Id = "direction-1", Title = "方向", Intention = "观察", ViewingQuestion = "远山与云层会怎样变化？",
                Grounding = new Grounding { Elements = ["远山", "云层"], Relationship = "远山与云层分离", IntentConnection = "回应关注" },
                VisualStrategy = "scale_context", Keep = ["远山"], Reduce = [], ViewWidth = "detail",
                Viewpoint = new Viewpoint { Height = "similar", Lateral = "similar", Distance = "similar", Orientation = "keep", Description = "保持机位", ViewfinderCheck = "观察关系" },
                FieldSteps = [new("保持当前机位", "观察画面关系"), new("收窄取景范围", "观察边缘变化")],
                FramingPlan = "收窄画面", DepthOfFieldIntent = "保持可辨", MotionIntent = "保持静止", HighlightShadowIntent = "保留亮部", Uncertainty = "光线变化",
                EquivalentFocalHintMm = new FocalRange(800, 800), VisualEffect = "突出关系", Tradeoffs = "环境减少"
            };
            var analysis = new SceneAnalysis
            {
                SchemaVersion = "4.3", RequestId = "scene_test", Language = "zh-CN", Outcome = "analysis",
                Observations = null!, Interpretations = [direction],
                TechnicalObservations = new TechnicalObservations { Motion = "static", DynamicRange = "low", LightChange = "stable", Confidence = 1 }
            };
            var task = new AnalysisTaskRecord
            {
                Id = "scene_test", UserId = userId, ReferenceImageId = "image_test", IdempotencyKey = "idem_test",
                Fingerprint = "fingerprint", Status = AnalysisTaskStatuses.Completed, RequestJson = "{}"
            };
            var gear = new ResolvedGearContext(
                "gear", "极端测试", "测试机身", null, 10, 10, 10, "2000mm F64", 2000, 2000, 64, 64,
                0, tripod, [], 25, 1_000_000, null, null);
            return Task.FromResult((task, new SceneRequest(), analysis, gear));
        }
    }
}
