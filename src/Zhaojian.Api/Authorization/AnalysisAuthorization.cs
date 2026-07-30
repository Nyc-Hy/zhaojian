using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Zhaojian.Api.Data;

namespace Zhaojian.Api.Authorization;

public static class AuthorizationPolicies
{
    public const string AnalysisCreate = "analysis:create";
    public const string OwnResource = "resource:own";
}

public sealed class OwnResourceRequirement : IAuthorizationRequirement;

public sealed class OwnResourceAuthorizationHandler : AuthorizationHandler<OwnResourceRequirement, IUserOwnedResource>
{
    protected override Task HandleRequirementAsync(AuthorizationHandlerContext context, OwnResourceRequirement requirement, IUserOwnedResource resource)
    {
        var userId = context.User.FindFirstValue(ClaimTypes.NameIdentifier);
        if (context.User.IsInRole(ApplicationRoles.Admin) || string.Equals(userId, resource.UserId, StringComparison.Ordinal))
        {
            context.Succeed(requirement);
        }
        return Task.CompletedTask;
    }
}

public static class CurrentUser
{
    public static string Id(ClaimsPrincipal user) => user.FindFirstValue(ClaimTypes.NameIdentifier)
        ?? throw new InvalidOperationException("已授权请求缺少用户标识。");
}
