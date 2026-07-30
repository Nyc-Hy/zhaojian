using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Antiforgery;
using Zhaojian.Api.Authorization;
using Zhaojian.Api.Contracts;
using Zhaojian.Api.Data;
using Zhaojian.Api.Services;
using Zhaojian.Api.Infrastructure;

namespace Zhaojian.Api.Endpoints;

public static class AnalysisHistoryEndpoints
{
    public static IEndpointRouteBuilder MapAnalysisHistoryEndpoints(this IEndpointRouteBuilder endpoints)
    {
        var tasks = endpoints.MapGroup("/v1/analysis-tasks").RequireAuthorization(AuthorizationPolicies.AnalysisCreate);
        tasks.MapGet("/", ListAsync);
        tasks.MapGet("/{taskId}", GetAsync);
        tasks.MapPost("/{taskId}/creative-intents", CreateCreativeIntentAsync).WithMetadata(new RequireAntiforgeryTokenAttribute());
        tasks.MapPost("/{taskId}/cancel", CancelAsync).WithMetadata(new RequireAntiforgeryTokenAttribute());
        tasks.MapDelete("/{taskId}", DeleteAsync).WithMetadata(new RequireAntiforgeryTokenAttribute());

        var intents = endpoints.MapGroup("/v1/creative-intents").RequireAuthorization(AuthorizationPolicies.AnalysisCreate);
        intents.MapGet("/", ListCreativeIntentsAsync);
        intents.MapGet("/{intentId}", GetCreativeIntentAsync);
        intents.MapDelete("/{intentId}", DeleteCreativeIntentAsync).WithMetadata(new RequireAntiforgeryTokenAttribute());

        endpoints.MapGet("/v1/reference-images/{imageId}", GetImageAsync)
            .RequireAuthorization(AuthorizationPolicies.AnalysisCreate);
        return endpoints;
    }

    private static async Task<IResult> CreateCreativeIntentAsync(
        HttpContext context,
        string taskId,
        CreateCreativeIntentRequest request,
        CreativeIntentService service,
        CancellationToken cancellationToken)
    {
        var intent = await service.CreateAsync(
            CurrentUser.Id(context.User),
            taskId,
            request.SelectedInterpretationId,
            cancellationToken);
        return Results.Json(intent, SceneJson.Provider);
    }

    private static async Task<IResult> ListCreativeIntentsAsync(
        HttpContext context,
        CreativeIntentService service,
        int limit = 100,
        CancellationToken cancellationToken = default)
    {
        var items = await service.ListAsync(CurrentUser.Id(context.User), limit, cancellationToken);
        return Results.Json(new { Items = items }, SceneJson.Provider);
    }

    private static async Task<IResult> GetCreativeIntentAsync(
        HttpContext context,
        string intentId,
        CreativeIntentService service,
        CancellationToken cancellationToken)
    {
        var intent = await service.FindAsync(CurrentUser.Id(context.User), intentId, cancellationToken);
        return intent is null ? TypedResults.NotFound() : Results.Json(intent, SceneJson.Provider);
    }

    private static async Task<IResult> DeleteCreativeIntentAsync(
        HttpContext context,
        string intentId,
        CreativeIntentService service,
        CancellationToken cancellationToken)
    {
        await service.DeleteAsync(CurrentUser.Id(context.User), intentId, cancellationToken);
        return TypedResults.NoContent();
    }

    private static async Task<IResult> ListAsync(
        HttpContext context,
        IAnalysisTaskStore store,
        string? imageId,
        int limit = 30,
        CancellationToken cancellationToken = default)
    {
        var items = await store.ListAsync(CurrentUser.Id(context.User), imageId, limit, cancellationToken);
        return TypedResults.Ok(new AnalysisTaskListResponse(items));
    }

    private static async Task<IResult> GetAsync(
        HttpContext context,
        string taskId,
        IAnalysisTaskStore store,
        IAuthorizationService authorization,
        CancellationToken cancellationToken)
    {
        var task = await store.FindTaskAsync(taskId, cancellationToken);
        if (task is null || !(await authorization.AuthorizeAsync(context.User, task, AuthorizationPolicies.OwnResource)).Succeeded)
        {
            return TypedResults.NotFound();
        }
        return TypedResults.Ok(store.ToDetail(task));
    }

    private static async Task<IResult> GetImageAsync(
        HttpContext context,
        string imageId,
        IAnalysisTaskStore store,
        IAuthorizationService authorization,
        CancellationToken cancellationToken)
    {
        var image = await store.FindImageAsync(imageId, cancellationToken);
        if (image is null || image.Content is null || !(await authorization.AuthorizeAsync(context.User, image, AuthorizationPolicies.OwnResource)).Succeeded)
        {
            return TypedResults.NotFound();
        }
        context.Response.Headers.CacheControl = "private, max-age=300";
        context.Response.Headers.ETag = $"\"{image.Sha256}\"";
        return TypedResults.Bytes(image.Content, image.ContentType);
    }

    private static async Task<IResult> DeleteAsync(
        HttpContext context,
        string taskId,
        IAnalysisTaskStore store,
        IAuthorizationService authorization,
        CancellationToken cancellationToken)
    {
        var task = await store.FindTaskAsync(taskId, cancellationToken);
        if (task is null || !(await authorization.AuthorizeAsync(context.User, task, AuthorizationPolicies.OwnResource)).Succeeded)
        {
            return TypedResults.NotFound();
        }
        if (task.Status is AnalysisTaskStatuses.Queued or AnalysisTaskStatuses.Understanding or AnalysisTaskStatuses.Generating)
        {
            return TypedResults.Conflict(new { code = "TASK_STILL_RUNNING", detail = "请先取消这次分析，待任务进入终态后再删除。" });
        }
        await store.DeleteAsync(task, cancellationToken);
        return TypedResults.NoContent();
    }

    private static async Task<IResult> CancelAsync(
        HttpContext context,
        string taskId,
        IAnalysisTaskStore store,
        AnalysisTaskCancellation cancellation,
        IAuthorizationService authorization,
        CancellationToken cancellationToken)
    {
        var task = await store.FindTaskAsync(taskId, cancellationToken);
        if (task is null || !(await authorization.AuthorizeAsync(context.User, task, AuthorizationPolicies.OwnResource)).Succeeded) return TypedResults.NotFound();
        if (task.Status is AnalysisTaskStatuses.Completed or AnalysisTaskStatuses.NeedsInput or AnalysisTaskStatuses.Failed or AnalysisTaskStatuses.Canceled)
        {
            return TypedResults.Conflict(new { code = "TASK_ALREADY_FINISHED", detail = "这次分析已经结束。" });
        }
        cancellation.Request(taskId);
        await store.CancelAsync(task, "TASK_CANCELLED", cancellationToken);
        return TypedResults.Ok(store.ToDetail(task));
    }
}
