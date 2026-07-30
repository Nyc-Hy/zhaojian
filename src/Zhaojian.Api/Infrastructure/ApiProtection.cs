using System.ComponentModel.DataAnnotations;
using System.Text.Json;
using System.Security.Claims;

namespace Zhaojian.Api.Infrastructure;

public sealed class ApiProtectionOptions
{
    public const string SectionName = "ApiProtection";

    [Range(1, 120)]
    public int AnalysesPerMinute { get; init; } = 6;

    [Range(2, 1000)]
    public int AccountRequestsPerFiveMinutes { get; init; } = 20;

    [Range(1, 32)]
    public int MaxConcurrentAnalyses { get; init; } = 4;

    [Range(1, 10000)]
    public int AnalysesPerDay { get; init; } = 30;

    [Range(1, 60)]
    public int IdempotencyMinutes { get; init; } = 10;

    [Range(30, 1800)]
    public int AnalysisTaskTimeoutSeconds { get; init; } = 360;

    [Range(16, 10000)]
    public int AnalysisQueueCapacity { get; init; } = 512;

    public bool AllowLoopbackDevelopmentRecoveryCode { get; init; }

    public string[] AllowedOrigins { get; init; } = ["http://127.0.0.1:5173", "http://localhost:5173"];
}

public interface IClientIdentityResolver
{
    string Resolve(HttpContext context);
}

public sealed class RequestClientIdentityResolver : IClientIdentityResolver
{
    public string Resolve(HttpContext context)
    {
        var userId = context.User.FindFirstValue(ClaimTypes.NameIdentifier);
        if (!string.IsNullOrWhiteSpace(userId)) return $"user:{userId}";
        return $"ip:{context.Connection.RemoteIpAddress?.ToString() ?? "unknown"}";
    }
}

public sealed class ApiException(int statusCode, string code, string message) : Exception(message)
{
    public int StatusCode { get; } = statusCode;
    public string Code { get; } = code;
}

public static class ApiProblems
{
    public static async Task WriteAsync(HttpContext context, int status, string code, string detail, CancellationToken cancellationToken)
    {
        context.Response.StatusCode = status;
        context.Response.ContentType = "application/problem+json";
        var payload = new
        {
            type = $"https://zhaojian.app/problems/{code.ToLowerInvariant()}",
            title = code,
            status,
            detail,
            code,
            request_id = context.TraceIdentifier
        };
        await JsonSerializer.SerializeAsync(context.Response.Body, payload, cancellationToken: cancellationToken);
    }
}
