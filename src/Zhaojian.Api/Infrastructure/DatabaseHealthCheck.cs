using Microsoft.Extensions.Diagnostics.HealthChecks;
using Zhaojian.Api.Data;

namespace Zhaojian.Api.Infrastructure;

public sealed class DatabaseHealthCheck(IServiceScopeFactory scopeFactory) : IHealthCheck
{
    public async Task<HealthCheckResult> CheckHealthAsync(HealthCheckContext context, CancellationToken cancellationToken = default)
    {
        try
        {
            await using var scope = scopeFactory.CreateAsyncScope();
            var database = scope.ServiceProvider.GetRequiredService<ZhaojianDbContext>();
            return await database.Database.CanConnectAsync(cancellationToken)
                ? HealthCheckResult.Healthy("数据库可以连接。")
                : HealthCheckResult.Unhealthy("数据库无法连接。");
        }
        catch (Exception error)
        {
            return HealthCheckResult.Unhealthy("数据库健康检查失败。", error);
        }
    }
}
