using System.Threading.Channels;
using System.Collections.Concurrent;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Zhaojian.Api.Data;
using Zhaojian.Api.Infrastructure;

namespace Zhaojian.Api.Services;

public interface IAnalysisTaskQueue
{
    ValueTask EnqueueAsync(string taskId, CancellationToken cancellationToken);
    IAsyncEnumerable<string> ReadAllAsync(CancellationToken cancellationToken);
    void Complete(string taskId);
}

public sealed class AnalysisTaskQueue(IOptions<ApiProtectionOptions> protection) : IAnalysisTaskQueue
{
    private readonly ConcurrentDictionary<string, byte> _scheduled = new(StringComparer.Ordinal);
    private readonly Channel<string> _channel = Channel.CreateBounded<string>(new BoundedChannelOptions(protection.Value.AnalysisQueueCapacity)
    {
        FullMode = BoundedChannelFullMode.Wait,
        SingleReader = false,
        SingleWriter = false
    });

    public async ValueTask EnqueueAsync(string taskId, CancellationToken cancellationToken)
    {
        if (!_scheduled.TryAdd(taskId, 0)) return;
        try { await _channel.Writer.WriteAsync(taskId, cancellationToken); }
        catch
        {
            _scheduled.TryRemove(taskId, out _);
            throw;
        }
    }
    public IAsyncEnumerable<string> ReadAllAsync(CancellationToken cancellationToken) => _channel.Reader.ReadAllAsync(cancellationToken);
    public void Complete(string taskId) => _scheduled.TryRemove(taskId, out _);
}

public sealed class AnalysisTaskWorker(IAnalysisTaskQueue queue, AnalysisTaskCancellation cancellation, IServiceScopeFactory scopeFactory, IOptions<ApiProtectionOptions> protection, ILogger<AnalysisTaskWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var consumerCount = protection.Value.MaxConcurrentAnalyses;
        var consumers = Enumerable.Range(0, consumerCount)
            .Select(_ => ConsumeAsync(stoppingToken))
            .ToArray();
        await Task.WhenAll([.. consumers, RecoverLoopAsync(stoppingToken)]);
    }

    private async Task ConsumeAsync(CancellationToken stoppingToken)
    {
        await foreach (var taskId in queue.ReadAllAsync(stoppingToken))
        {
            try
            {
                using var taskCancellation = cancellation.Register(taskId, stoppingToken, TimeSpan.FromSeconds(protection.Value.AnalysisTaskTimeoutSeconds));
                await using var scope = scopeFactory.CreateAsyncScope();
                await scope.ServiceProvider.GetRequiredService<SceneAnalysisService>().ProcessAsync(taskId, taskCancellation.Token);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception error) { logger.LogError(error, "分析后台工作器处理任务失败 {TaskId}", taskId); }
            finally { cancellation.Complete(taskId); queue.Complete(taskId); }
        }
    }

    private async Task RecoverLoopAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                await RecoverPendingAsync(cancellationToken);
                await Task.Delay(TimeSpan.FromSeconds(10), cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { break; }
            catch (Exception error)
            {
                logger.LogError(error, "分析任务恢复扫描失败");
                await Task.Delay(TimeSpan.FromSeconds(10), cancellationToken);
            }
        }
    }

    private async Task RecoverPendingAsync(CancellationToken cancellationToken)
    {
        await using var scope = scopeFactory.CreateAsyncScope();
        var database = scope.ServiceProvider.GetRequiredService<ZhaojianDbContext>();
        var expiredBefore = DateTimeOffset.UtcNow.AddSeconds(-protection.Value.AnalysisTaskTimeoutSeconds).ToUnixTimeMilliseconds();
        await database.AnalysisTasks
            .Where(task => (task.Status == AnalysisTaskStatuses.Understanding || task.Status == AnalysisTaskStatuses.Generating)
                && task.CreatedAtUnixMs < expiredBefore)
            .ExecuteUpdateAsync(update => update.SetProperty(task => task.Status, AnalysisTaskStatuses.Queued), cancellationToken);
        var pendingIds = await database.AnalysisTasks.AsNoTracking()
            .Where(task => task.Status == AnalysisTaskStatuses.Queued)
            .OrderBy(task => task.CreatedAtUnixMs)
            .Select(task => task.Id)
            .Take(protection.Value.AnalysisQueueCapacity)
            .ToListAsync(cancellationToken);
        foreach (var taskId in pendingIds) await queue.EnqueueAsync(taskId, cancellationToken);
        if (pendingIds.Count > 0) logger.LogInformation("已恢复 {TaskCount} 个未完成分析任务", pendingIds.Count);
    }
}
