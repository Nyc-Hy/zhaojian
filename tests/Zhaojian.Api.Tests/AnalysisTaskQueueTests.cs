using Microsoft.Extensions.Options;
using Zhaojian.Api.Infrastructure;
using Zhaojian.Api.Services;

namespace Zhaojian.Api.Tests;

public sealed class AnalysisTaskQueueTests
{
    [Fact]
    public async Task Recovery_Sized_Batch_Does_Not_Block_Before_Consumers_Start()
    {
        var queue = new AnalysisTaskQueue(Options.Create(new ApiProtectionOptions { AnalysisQueueCapacity = 128 }));
        for (var index = 0; index < 100; index++)
        {
            await queue.EnqueueAsync($"scene_{index}", CancellationToken.None);
        }

        var count = 0;
        await foreach (var _ in queue.ReadAllAsync(CancellationToken.None))
        {
            if (++count == 100) break;
        }
        Assert.Equal(100, count);
    }

    [Fact]
    public async Task Bounded_Queue_Respects_Cancellation_When_Full()
    {
        var queue = new AnalysisTaskQueue(Options.Create(new ApiProtectionOptions { AnalysisQueueCapacity = 16 }));
        for (var index = 0; index < 16; index++) await queue.EnqueueAsync($"scene_{index}", CancellationToken.None);

        using var cancellation = new CancellationTokenSource(TimeSpan.FromMilliseconds(100));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () => await queue.EnqueueAsync("scene_overflow", cancellation.Token));
    }

    [Fact]
    public async Task Duplicate_Task_Ids_Do_Not_Consume_Additional_Capacity()
    {
        var queue = new AnalysisTaskQueue(Options.Create(new ApiProtectionOptions { AnalysisQueueCapacity = 16 }));
        for (var index = 0; index < 100; index++) await queue.EnqueueAsync("scene_same", CancellationToken.None);
        for (var index = 0; index < 15; index++) await queue.EnqueueAsync($"scene_unique_{index}", CancellationToken.None);

        using var cancellation = new CancellationTokenSource(TimeSpan.FromMilliseconds(100));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () => await queue.EnqueueAsync("scene_overflow", cancellation.Token));
    }
}
