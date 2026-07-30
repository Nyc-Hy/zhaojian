using Microsoft.AspNetCore.Identity;

namespace Zhaojian.Api.Data;

public sealed class ApplicationUser : IdentityUser
{
    public required string DisplayName { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
}

public static class ApplicationRoles
{
    public const string Member = "Member";
    public const string Admin = "Admin";
}
