using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Zhaojian.Api.Data;
using Zhaojian.Api.Infrastructure;

namespace Zhaojian.Api.Services;

public sealed class DataRetentionWorker(IServiceScopeFactory scopeFactory, IOptions<DataRetentionOptions> options, ILogger<DataRetentionWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await SweepAsync(stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception error) { logger.LogError(error, "分析图保留策略执行失败"); }
            await Task.Delay(TimeSpan.FromMinutes(options.Value.SweepMinutes), stoppingToken);
        }
    }

    internal async Task<int> SweepAsync(CancellationToken cancellationToken)
    {
        await using var scope = scopeFactory.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ZhaojianDbContext>();
        var cutoff = DateTimeOffset.UtcNow.AddDays(-options.Value.AnalysisImageDays);
        var cutoffUnixMs = cutoff.ToUnixTimeMilliseconds();
        var imageIds = await database.ReferenceImages.AsNoTracking()
            .Where(image => image.Content != null
                && image.AnalysisTasks.All(task => task.CompletedAtUnixMs != null && task.CompletedAtUnixMs < cutoffUnixMs))
            .OrderBy(image => image.Id)
            .Select(image => image.Id)
            .Take(100)
            .ToListAsync(cancellationToken);
        if (imageIds.Count == 0) return 0;
        var purgedAt = DateTimeOffset.UtcNow;
        var changed = await database.ReferenceImages
            .Where(image => imageIds.Contains(image.Id))
            .ExecuteUpdateAsync(update => update
                .SetProperty(image => image.Content, (byte[]?)null)
                .SetProperty(image => image.ByteLength, 0)
                .SetProperty(image => image.PurgedAt, purgedAt), cancellationToken);
        logger.LogInformation("分析图保留策略清理 {ImageCount} 份到期副本，保留任务结构化结果", changed);
        return changed;
    }
}
