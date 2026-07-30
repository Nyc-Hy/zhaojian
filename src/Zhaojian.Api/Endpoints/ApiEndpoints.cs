using System.Text.Json;
using System.Reflection;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Http.Timeouts;
using Microsoft.Extensions.Options;
using Zhaojian.Api.Authorization;
using Zhaojian.Api.Contracts;
using Zhaojian.Api.Infrastructure;
using Zhaojian.Api.Services;
using Zhaojian.Api.Skills;

namespace Zhaojian.Api.Endpoints;

public static partial class ApiEndpoints
{
    public static IEndpointRouteBuilder MapZhaojianApi(this IEndpointRouteBuilder endpoints)
    {
        var group = endpoints.MapGroup("/v1");
        group.MapGet("/models/status", (SceneAnalysisService service) => Results.Json(service.Status, SceneJson.Provider));
        group.MapGet("/operations/status", OperationsStatus)
            .RequireAuthorization(AuthorizationPolicies.AnalysisCreate);
        group.MapGet("/skills/status", SkillStatus)
            .RequireAuthorization(AuthorizationPolicies.AnalysisCreate);
        group.MapPost("/scene-analyses", AnalyzeAsync)
            .RequireAuthorization(AuthorizationPolicies.AnalysisCreate)
            .WithMetadata(new RequireAntiforgeryTokenAttribute())
            .RequireRateLimiting("analysis")
            .WithRequestTimeout("analysis");
        group.MapPost("/capture-plans", CreateCapturePlanAsync)
            .RequireAuthorization(AuthorizationPolicies.AnalysisCreate)
            .WithMetadata(new RequireAntiforgeryTokenAttribute());
        return endpoints;
    }

    private static IResult OperationsStatus(IOptions<ModelOptions> model, IOptions<DataRetentionOptions> retention, IAccountRecoveryNotifier recovery)
    {
        var pricing = model.Value.Qwen;
        return TypedResults.Ok(new OperationalCapabilitiesResponse(
            typeof(ApiEndpoints).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "unknown",
            "sqlite", "in_process_channel", "in_memory", "sqlite_blob", false, recovery.IsConfigured,
            retention.Value.AnalysisImageDays, pricing.PricingVersion, pricing.InputPerMillionCny > 0 || pricing.OutputPerMillionCny > 0,
            ["PostgreSQL 主数据库", "Redis 分布式额度与频率限制", "对象存储", "持久化任务队列", "共享 Data Protection 密钥"]));
    }

    private static IResult SkillStatus(ISkillRegistry registry) =>
        TypedResults.Ok(new SkillRegistryStatusResponse(
            registry.CloudSkillsEnabled,
            registry.RuntimeVersion,
            registry.List().Select(value => new SkillRegistryEntryResponse(
                value.Definition.SkillId,
                value.Definition.SkillVersion,
                value.EffectiveStatus,
                value.Active && registry.CloudSkillsEnabled,
                value.Definition.ContentHash,
                value.Definition.CreatedAt)).ToArray()));

    private static async Task<IResult> CreateCapturePlanAsync(HttpContext context, CapturePlanRequest request, CapturePlanService service, CancellationToken cancellationToken)
    {
        var response = await service.BuildAsync(CurrentUser.Id(context.User), request, cancellationToken);
        return TypedResults.Ok(response);
    }

    private static async Task<IResult> AnalyzeAsync(
        HttpContext context,
        UploadGuard uploadGuard,
        SceneContractValidator validator,
        SceneAnalysisService service,
        CancellationToken cancellationToken)
    {
        if (!context.Request.HasFormContentType)
        {
            throw new ApiException(StatusCodes.Status415UnsupportedMediaType, "INVALID_REQUEST", "请求必须使用 multipart/form-data。");
        }
        if (context.Request.ContentLength > UploadPolicy.MaxRequestBytes)
        {
            throw new ApiException(StatusCodes.Status413PayloadTooLarge, "REQUEST_TOO_LARGE", "请求超过服务端允许的大小。");
        }

        IFormCollection form;
        try
        {
            form = await context.Request.ReadFormAsync(cancellationToken);
        }
        catch (InvalidDataException)
        {
            throw new ApiException(StatusCodes.Status413PayloadTooLarge, "REQUEST_TOO_LARGE", "请求超过服务端允许的大小或 multipart 格式不正确。");
        }
        if (form.Files.Count != 1 || form.Files[0].Name != "image")
        {
            throw new ApiException(StatusCodes.Status400BadRequest, "INVALID_IMAGE", "请求必须包含且只能包含一张 image 分析图。");
        }
        if (form.Keys.Any(key => key is not ("request")))
        {
            throw new ApiException(StatusCodes.Status400BadRequest, "INVALID_REQUEST", "请求包含未允许的表单字段。");
        }
        if (form["request"].Count != 1)
        {
            throw new ApiException(StatusCodes.Status400BadRequest, "INVALID_REQUEST", "请求必须包含且只能包含一个 request 字段。");
        }
        var requestJson = form["request"].ToString();
        if (string.IsNullOrWhiteSpace(requestJson) || requestJson.Length > UploadPolicy.MaxRequestJsonChars)
        {
            throw new ApiException(StatusCodes.Status400BadRequest, "INVALID_REQUEST", "请求信息为空或过长。");
        }

        SceneRequest sceneRequest;
        try
        {
            sceneRequest = JsonSerializer.Deserialize<SceneRequest>(requestJson, SceneJson.Request)
                ?? throw new JsonException("请求为空");
        }
        catch (JsonException)
        {
            throw new ApiException(StatusCodes.Status400BadRequest, "INVALID_REQUEST", "请求信息不是受支持的 JSON 契约。");
        }
        validator.ValidateRequest(sceneRequest);

        var rawIdempotencyKey = context.Request.Headers["Idempotency-Key"].ToString();
        if (!IdempotencyKeyPattern().IsMatch(rawIdempotencyKey))
        {
            throw new ApiException(StatusCodes.Status400BadRequest, "INVALID_REQUEST", "Idempotency-Key 必须是 8～128 位字母、数字、下划线或连字符。");
        }
        var clientId = CurrentUser.Id(context.User);
        var image = await uploadGuard.ReadAndValidateAsync(form.Files[0], cancellationToken);
        var response = await service.EnqueueAsync(clientId, rawIdempotencyKey, sceneRequest, image, cancellationToken);
        return Results.Json(response, SceneJson.Provider, statusCode: StatusCodes.Status202Accepted);
    }

    [GeneratedRegex("^[A-Za-z0-9_-]{8,128}$")]
    private static partial Regex IdempotencyKeyPattern();
}
