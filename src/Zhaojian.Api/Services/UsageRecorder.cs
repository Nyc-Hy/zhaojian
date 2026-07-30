using System.Collections.Concurrent;
using Zhaojian.Api.Contracts;

namespace Zhaojian.Api.Services;

public sealed record UsageRecord(string RequestId, string ClientId, string Provider, string Model, ProviderUsage Usage, long DurationMs, bool CacheHit, string Outcome, DateTimeOffset CreatedAt);

public interface IUsageRecorder
{
    void Record(UsageRecord record);
    IReadOnlyList<UsageRecord> Snapshot();
}

public sealed class InMemoryUsageRecorder(ILogger<InMemoryUsageRecorder> logger) : IUsageRecorder
{
    private readonly ConcurrentQueue<UsageRecord> _records = new();

    public void Record(UsageRecord record)
    {
        _records.Enqueue(record);
        while (_records.Count > 1000) _records.TryDequeue(out _);
        logger.LogInformation(
            "模型用量 {RequestId} {Provider}/{Model} 调用 {Calls} 输入 {PromptTokens} 输出 {CompletionTokens} 估算费用 {EstimatedCostCny} CNY 结果 {Outcome}",
            record.RequestId,
            record.Provider,
            record.Model,
            record.Usage.Calls,
            record.Usage.PromptTokens,
            record.Usage.CompletionTokens,
            record.Usage.EstimatedCostCny,
            record.Outcome);
    }

    public IReadOnlyList<UsageRecord> Snapshot() => _records.ToArray();
}
