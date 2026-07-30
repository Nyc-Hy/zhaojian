using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;

namespace Zhaojian.Api.Data;

public static class DatabaseInitializer
{
    public static async Task InitializeDatabaseAsync(this WebApplication app)
    {
        await using var scope = app.Services.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ZhaojianDbContext>();
        await database.Database.MigrateAsync();

        var roles = scope.ServiceProvider.GetRequiredService<RoleManager<IdentityRole>>();
        foreach (var role in new[] { ApplicationRoles.Member, ApplicationRoles.Admin })
        {
            if (!await roles.RoleExistsAsync(role))
            {
                var result = await roles.CreateAsync(new IdentityRole(role));
                if (!result.Succeeded)
                {
                    throw new InvalidOperationException($"无法建立角色 {role}：{string.Join('；', result.Errors.Select(error => error.Description))}");
                }
            }
        }
    }
}
