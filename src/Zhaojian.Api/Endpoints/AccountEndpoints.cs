using System.Net;
using System.Security.Claims;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Zhaojian.Api.Authorization;
using Zhaojian.Api.Services;
using Zhaojian.Api.Contracts;
using Zhaojian.Api.Data;
using Zhaojian.Api.Infrastructure;

namespace Zhaojian.Api.Endpoints;

public static partial class AccountEndpoints
{
    public static IEndpointRouteBuilder MapAccountEndpoints(this IEndpointRouteBuilder endpoints)
    {
        var group = endpoints.MapGroup("/v1/account");
        group.MapGet("/session", SessionAsync);
        group.MapPost("/register", RegisterAsync).WithMetadata(new RequireAntiforgeryTokenAttribute()).RequireRateLimiting("account");
        group.MapPost("/login", LoginAsync).WithMetadata(new RequireAntiforgeryTokenAttribute()).RequireRateLimiting("account");
        group.MapPost("/logout", LogoutAsync).RequireAuthorization().WithMetadata(new RequireAntiforgeryTokenAttribute());
        group.MapPut("/profile", UpdateProfileAsync).RequireAuthorization().WithMetadata(new RequireAntiforgeryTokenAttribute());
        group.MapPost("/change-password", ChangePasswordAsync).RequireAuthorization().WithMetadata(new RequireAntiforgeryTokenAttribute()).RequireRateLimiting("account");
        group.MapPost("/request-password-reset", RequestPasswordResetAsync).WithMetadata(new RequireAntiforgeryTokenAttribute()).RequireRateLimiting("account");
        group.MapPost("/reset-password", ResetPasswordAsync).WithMetadata(new RequireAntiforgeryTokenAttribute()).RequireRateLimiting("account");
        group.MapGet("/export", ExportAsync).RequireAuthorization().RequireRateLimiting("export");
        group.MapGet("/usage", UsageAsync).RequireAuthorization();
        group.MapPost("/delete", DeleteAccountAsync).RequireAuthorization().WithMetadata(new RequireAntiforgeryTokenAttribute()).RequireRateLimiting("account");
        return endpoints;
    }

    private static async Task<IResult> SessionAsync(HttpContext context, IAntiforgery antiforgery, UserManager<ApplicationUser> users)
    {
        var token = antiforgery.GetAndStoreTokens(context).RequestToken
            ?? throw new InvalidOperationException("无法生成 CSRF Token。");
        if (context.User.Identity?.IsAuthenticated != true)
        {
            return TypedResults.Ok(new AccountSessionResponse(false, null, token));
        }
        var user = await users.GetUserAsync(context.User);
        if (user is null)
        {
            return TypedResults.Ok(new AccountSessionResponse(false, null, token));
        }
        return TypedResults.Ok(new AccountSessionResponse(true, await ToResponseAsync(user, users), token));
    }

    private static async Task<IResult> RegisterAsync(
        RegisterRequest request,
        UserManager<ApplicationUser> users,
        SignInManager<ApplicationUser> signIn)
    {
        var email = request.Email.Trim();
        var displayName = request.DisplayName.Trim();
        if (!EmailPattern().IsMatch(email) || email.Length > 160 || displayName.Length is < 2 or > 40)
        {
            throw new ApiException(StatusCodes.Status400BadRequest, "INVALID_ACCOUNT", "请填写有效邮箱和 2～40 个字符的称呼。");
        }
        var user = new ApplicationUser
        {
            UserName = email,
            Email = email,
            DisplayName = displayName,
            CreatedAt = DateTimeOffset.UtcNow
        };
        var created = await users.CreateAsync(user, request.Password);
        if (!created.Succeeded)
        {
            var duplicate = created.Errors.Any(error => error.Code.Contains("Duplicate", StringComparison.OrdinalIgnoreCase));
            throw new ApiException(
                StatusCodes.Status400BadRequest,
                duplicate ? "ACCOUNT_EXISTS" : "INVALID_ACCOUNT",
                duplicate ? "这个邮箱已经注册，可以直接登录。" : "密码至少 10 位，并同时包含字母和数字。");
        }
        var roleResult = await users.AddToRoleAsync(user, ApplicationRoles.Member);
        if (!roleResult.Succeeded)
        {
            await users.DeleteAsync(user);
            throw new ApiException(StatusCodes.Status500InternalServerError, "ACCOUNT_SETUP_FAILED", "账号暂时无法建立，请稍后重试。");
        }
        await signIn.SignInAsync(user, isPersistent: true);
        return TypedResults.Ok(await ToResponseAsync(user, users));
    }

    private static async Task<IResult> LoginAsync(
        LoginRequest request,
        UserManager<ApplicationUser> users,
        SignInManager<ApplicationUser> signIn)
    {
        var user = await users.FindByEmailAsync(request.Email.Trim());
        if (user is null)
        {
            throw new ApiException(StatusCodes.Status401Unauthorized, "INVALID_CREDENTIALS", "邮箱或密码不正确。");
        }
        var result = await signIn.PasswordSignInAsync(user, request.Password, request.RememberMe, lockoutOnFailure: true);
        if (!result.Succeeded)
        {
            throw new ApiException(StatusCodes.Status401Unauthorized, "INVALID_CREDENTIALS", "邮箱或密码不正确，连续失败后账号会被暂时锁定。");
        }
        return TypedResults.Ok(await ToResponseAsync(user, users));
    }

    private static async Task<IResult> LogoutAsync(SignInManager<ApplicationUser> signIn)
    {
        await signIn.SignOutAsync();
        return TypedResults.NoContent();
    }

    private static async Task<IResult> UpdateProfileAsync(
        HttpContext context,
        UpdateProfileRequest request,
        UserManager<ApplicationUser> users)
    {
        var displayName = request.DisplayName.Trim();
        if (displayName.Length is < 2 or > 40)
        {
            throw new ApiException(StatusCodes.Status400BadRequest, "INVALID_PROFILE", "称呼需要 2～40 个字符。");
        }
        var user = await users.GetUserAsync(context.User);
        if (user is null) return TypedResults.Unauthorized();
        user.DisplayName = displayName;
        var result = await users.UpdateAsync(user);
        if (!result.Succeeded) throw new ApiException(StatusCodes.Status400BadRequest, "INVALID_PROFILE", "个人资料暂时无法保存。");
        return TypedResults.Ok(await ToResponseAsync(user, users));
    }

    private static async Task<IResult> ChangePasswordAsync(HttpContext context, ChangePasswordRequest request, UserManager<ApplicationUser> users, SignInManager<ApplicationUser> signIn)
    {
        var user = await users.GetUserAsync(context.User);
        if (user is null) return TypedResults.Unauthorized();
        var result = await users.ChangePasswordAsync(user, request.CurrentPassword, request.NewPassword);
        if (!result.Succeeded) throw new ApiException(StatusCodes.Status400BadRequest, "PASSWORD_CHANGE_FAILED", "当前密码不正确，或新密码未满足至少 10 位且包含字母和数字的要求。");
        await signIn.RefreshSignInAsync(user);
        return TypedResults.NoContent();
    }

    private static async Task<IResult> RequestPasswordResetAsync(HttpContext context, RequestPasswordResetRequest request, UserManager<ApplicationUser> users, IAccountRecoveryNotifier notifier, IHostEnvironment environment, IOptions<ApiProtectionOptions> protection, CancellationToken cancellationToken)
    {
        var user = await users.FindByEmailAsync(request.Email.Trim());
        string? developmentCode = null;
        if (user is not null)
        {
            var code = await users.GeneratePasswordResetTokenAsync(user);
            await notifier.SendAsync(user.Email ?? request.Email, code, cancellationToken);
            if (CanExposeDevelopmentRecoveryCode(environment.EnvironmentName, protection.Value.AllowLoopbackDevelopmentRecoveryCode, context.Connection.RemoteIpAddress) && !notifier.IsConfigured) developmentCode = code;
        }
        return TypedResults.Ok(new PasswordResetRequestedResponse(true, notifier.IsConfigured, developmentCode));
    }

    private static async Task<IResult> ResetPasswordAsync(ResetPasswordRequest request, UserManager<ApplicationUser> users)
    {
        var user = await users.FindByEmailAsync(request.Email.Trim());
        if (user is null) throw new ApiException(StatusCodes.Status400BadRequest, "PASSWORD_RESET_FAILED", "恢复码无效或已经过期。");
        var result = await users.ResetPasswordAsync(user, request.RecoveryCode, request.NewPassword);
        if (!result.Succeeded) throw new ApiException(StatusCodes.Status400BadRequest, "PASSWORD_RESET_FAILED", "恢复码无效、已经过期，或新密码不符合要求。");
        return TypedResults.NoContent();
    }

    private static async Task<IResult> ExportAsync(HttpContext context, UserManager<ApplicationUser> users, AccountDataExportService export, CancellationToken cancellationToken)
    {
        var user = await users.GetUserAsync(context.User);
        if (user is null) return TypedResults.Unauthorized();
        var bytes = await export.CreateAsync(user, cancellationToken);
        return TypedResults.File(bytes, "application/zip", $"zhaojian-account-{DateTime.UtcNow:yyyyMMdd}.zip");
    }

    private static async Task<IResult> UsageAsync(HttpContext context, ZhaojianDbContext database, CancellationToken cancellationToken)
    {
        var userId = CurrentUser.Id(context.User);
        var now = DateTimeOffset.UtcNow;
        var monthStartUnixMs = new DateTimeOffset(now.Year, now.Month, 1, 0, 0, 0, TimeSpan.Zero).ToUnixTimeMilliseconds();
        var tasks = await database.AnalysisTasks.AsNoTracking().Where(value => value.UserId == userId && value.CreatedAtUnixMs >= monthStartUnixMs).ToListAsync(cancellationToken);
        return TypedResults.Ok(new AccountUsageSummaryResponse(
            tasks.Count,
            tasks.Count(value => value.Status is AnalysisTaskStatuses.Completed or AnalysisTaskStatuses.NeedsInput),
            tasks.Count(value => value.Status == AnalysisTaskStatuses.Failed),
            tasks.Count(value => value.Status == AnalysisTaskStatuses.Canceled),
            tasks.Sum(value => value.PromptTokens),
            tasks.Sum(value => value.CompletionTokens),
            tasks.Sum(value => value.EstimatedCostCny),
            tasks.Count(value => value.ChargeDisposition == "unpriced" ||
                (value.ChargeDisposition == null && value.Provider != "mock" && (value.Status is AnalysisTaskStatuses.Completed or AnalysisTaskStatuses.NeedsInput)))));
    }

    private static async Task<IResult> DeleteAccountAsync(HttpContext context, DeleteAccountRequest request, UserManager<ApplicationUser> users, SignInManager<ApplicationUser> signIn)
    {
        var user = await users.GetUserAsync(context.User);
        if (user is null) return TypedResults.Unauthorized();
        if (!await users.CheckPasswordAsync(user, request.Password)) throw new ApiException(StatusCodes.Status400BadRequest, "ACCOUNT_DELETE_CONFIRMATION_FAILED", "密码不正确，账号没有删除。");
        var result = await users.DeleteAsync(user);
        if (!result.Succeeded) throw new ApiException(StatusCodes.Status500InternalServerError, "ACCOUNT_DELETE_FAILED", "账号暂时无法删除，请稍后重试。");
        await signIn.SignOutAsync();
        return TypedResults.NoContent();
    }

    private static async Task<AccountUserResponse> ToResponseAsync(ApplicationUser user, UserManager<ApplicationUser> users) =>
        new(user.Id, user.Email ?? "", user.DisplayName, user.CreatedAt, [.. await users.GetRolesAsync(user)]);

    internal static bool CanExposeDevelopmentRecoveryCode(string environmentName, bool explicitlyAllowed, IPAddress? remoteAddress) =>
        explicitlyAllowed && (string.Equals(environmentName, "Testing", StringComparison.Ordinal)
            || string.Equals(environmentName, Environments.Development, StringComparison.Ordinal) && remoteAddress is not null && IPAddress.IsLoopback(remoteAddress));

    [GeneratedRegex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", RegexOptions.CultureInvariant)]
    private static partial Regex EmailPattern();
}
