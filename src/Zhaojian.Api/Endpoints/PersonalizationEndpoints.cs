using Microsoft.AspNetCore.Antiforgery;
using Zhaojian.Api.Authorization;
using Zhaojian.Api.Contracts;
using Zhaojian.Api.Services;

namespace Zhaojian.Api.Endpoints;

public static class PersonalizationEndpoints
{
    public static IEndpointRouteBuilder MapPersonalizationEndpoints(this IEndpointRouteBuilder endpoints)
    {
        var group = endpoints.MapGroup("/v1/personalization")
            .RequireAuthorization(AuthorizationPolicies.AnalysisCreate);
        group.MapGet("/", GetAsync);
        group.MapPut("/settings", UpdateSettingsAsync).WithMetadata(new RequireAntiforgeryTokenAttribute());
        group.MapPost("/feedback/sync", SyncFeedbackAsync).WithMetadata(new RequireAntiforgeryTokenAttribute());
        group.MapDelete("/feedback/{feedbackId}", DeleteFeedbackAsync).WithMetadata(new RequireAntiforgeryTokenAttribute());
        group.MapPut("/preferences/{preferenceId}", UpdatePreferenceAsync).WithMetadata(new RequireAntiforgeryTokenAttribute());
        group.MapDelete("/preferences/{preferenceId}", DeletePreferenceAsync).WithMetadata(new RequireAntiforgeryTokenAttribute());
        group.MapDelete("/", ClearAsync).WithMetadata(new RequireAntiforgeryTokenAttribute());
        return endpoints;
    }

    private static async Task<IResult> GetAsync(
        HttpContext context,
        PersonalizationService service,
        CancellationToken cancellationToken)
    {
        return TypedResults.Ok(await service.GetSnapshotAsync(CurrentUser.Id(context.User), cancellationToken));
    }

    private static async Task<IResult> UpdateSettingsAsync(
        HttpContext context,
        UpdatePersonalizationSettingsRequest request,
        PersonalizationService service,
        CancellationToken cancellationToken)
    {
        return TypedResults.Ok(await service.UpdateSettingsAsync(CurrentUser.Id(context.User), request, cancellationToken));
    }

    private static async Task<IResult> SyncFeedbackAsync(
        HttpContext context,
        FeedbackSyncRequest request,
        PersonalizationService service,
        CancellationToken cancellationToken)
    {
        return TypedResults.Ok(await service.SyncFeedbackAsync(CurrentUser.Id(context.User), request, cancellationToken));
    }

    private static async Task<IResult> DeleteFeedbackAsync(
        HttpContext context,
        string feedbackId,
        PersonalizationService service,
        CancellationToken cancellationToken)
    {
        await service.DeleteFeedbackAsync(CurrentUser.Id(context.User), feedbackId, cancellationToken);
        return TypedResults.NoContent();
    }

    private static async Task<IResult> UpdatePreferenceAsync(
        HttpContext context,
        string preferenceId,
        UpdateCreativePreferenceRequest request,
        PersonalizationService service,
        CancellationToken cancellationToken)
    {
        return TypedResults.Ok(await service.UpdatePreferenceAsync(
            CurrentUser.Id(context.User),
            preferenceId,
            request,
            cancellationToken));
    }

    private static async Task<IResult> DeletePreferenceAsync(
        HttpContext context,
        string preferenceId,
        PersonalizationService service,
        CancellationToken cancellationToken)
    {
        await service.DeletePreferenceAsync(CurrentUser.Id(context.User), preferenceId, cancellationToken);
        return TypedResults.NoContent();
    }

    private static async Task<IResult> ClearAsync(
        HttpContext context,
        PersonalizationService service,
        CancellationToken cancellationToken)
    {
        await service.ClearAsync(CurrentUser.Id(context.User), cancellationToken);
        return TypedResults.NoContent();
    }
}
