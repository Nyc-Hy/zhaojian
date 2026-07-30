using System.Text.Json;
using Zhaojian.Api.Contracts;
using Zhaojian.Api.Providers;

namespace Zhaojian.Api.Tests;

public sealed class SceneContractValidatorTests
{
    private readonly SceneContractValidator _validator = new();
    private readonly SceneRequest _request = new() { MovementFreedom = new(true, true, true) };

    [Fact]
    public void Analysis_Accepts_Two_Distinct_Directions()
    {
        var analysis = LoadMockAnalysis();
        analysis.Interpretations = analysis.Interpretations.Take(2).ToList();
        ModelOutputNormalizer.Normalize(analysis, _request);

        _validator.ValidateAnalysis(analysis, _request);
    }

    [Fact]
    public void Analysis_Rejects_One_Direction_Instead_Of_Padding()
    {
        var analysis = LoadMockAnalysis();
        analysis.Interpretations = analysis.Interpretations.Take(1).ToList();
        ModelOutputNormalizer.Normalize(analysis, _request);

        Assert.Throws<ProviderOutputException>(() => _validator.ValidateAnalysis(analysis, _request));
    }

    [Fact]
    public void Analysis_Rejects_Duplicate_Directions()
    {
        var analysis = LoadMockAnalysis();
        analysis.Interpretations = analysis.Interpretations.Take(2).ToList();
        ModelOutputNormalizer.Normalize(analysis, _request);
        analysis.Interpretations[1].Title = analysis.Interpretations[0].Title;

        Assert.Throws<ProviderOutputException>(() => _validator.ValidateAnalysis(analysis, _request));
    }

    [Fact]
    public void No_Options_Accepts_Reason_And_Empty_Directions()
    {
        var analysis = LoadMockAnalysis();
        analysis.Outcome = "no_options";
        analysis.Clarification = null;
        analysis.NoOptions = new NoOptionsResult
        {
            Reason = "当前不足以形成两种可靠方向。",
            Evidence = ["只有一个具体元素关系可以确认。"],
            NextStep = "可以补充现场中能够确认的其他元素。"
        };
        analysis.Interpretations = [];

        _validator.ValidateAnalysis(analysis, _request);
    }

    [Fact]
    public void Analysis_Rejects_Explicit_Null_Instead_Of_Throwing_NullReference()
    {
        var analysis = LoadMockAnalysis();
        analysis.Observations = null!;

        Assert.Throws<ProviderOutputException>(() => _validator.ValidateAnalysis(analysis, _request));
    }

    [Fact]
    public void Analysis_Rejects_Light_Values_Outside_Json_Schema()
    {
        var analysis = LoadMockAnalysis();
        analysis.Observations.Light.Direction = "diagonal";

        Assert.Throws<ProviderOutputException>(() => _validator.ValidateAnalysis(analysis, _request));
    }

    private static SceneAnalysis LoadMockAnalysis()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "Data", "mock-scene-analysis.example.json");
        return JsonSerializer.Deserialize<SceneAnalysis>(File.ReadAllText(path), SceneJson.Provider)
            ?? throw new InvalidOperationException("Mock 场景分析示例无法读取。");
    }
}
