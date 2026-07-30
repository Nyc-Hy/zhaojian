using System.Collections.Concurrent;
using Microsoft.Extensions.Options;
using Zhaojian.Api.Infrastructure;

namespace Zhaojian.Api.Services;

public interface IAnalysisQuotaLease : IAsyncDisposable
{
    void Commit();
}

public interface IAnalysisQuotaService
{
    ValueTask<IAnalysisQuotaLease?> TryReserveAsync(string clientId, CancellationToken cancellationToken);
}

public sealed class InMemoryAnalysisQuotaService(IOptions<ApiProtectionOptions> options) : IAnalysisQuotaService
{
    private sealed class DailyCounter
    {
        public DateOnly Day { get; set; } = DateOnly.FromDateTime(DateTime.UtcNow);
        public int Used { get; set; }
        public int Reserved { get; set; }
    }

    private sealed class Lease(InMemoryAnalysisQuotaService owner, DailyCounter counter) : IAnalysisQuotaLease
    {
        private int _state;

        public void Commit()
        {
            if (Interlocked.CompareExchange(ref _state, 1, 0) != 0) return;
            owner.Complete(counter, commit: true);
        }

        public ValueTask DisposeAsync()
        {
            if (Interlocked.CompareExchange(ref _state, 2, 0) == 0)
            {
                owner.Complete(counter, commit: false);
            }
            return ValueTask.CompletedTask;
        }
    }

    private readonly ConcurrentDictionary<string, DailyCounter> _counters = new(StringComparer.Ordinal);
    private readonly int _dailyLimit = options.Value.AnalysesPerDay;

    public ValueTask<IAnalysisQuotaLease?> TryReserveAsync(string clientId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var counter = _counters.GetOrAdd(clientId, _ => new DailyCounter());
        lock (counter)
        {
            ResetIfNeeded(counter);
            if (counter.Used + counter.Reserved >= _dailyLimit)
            {
                return ValueTask.FromResult<IAnalysisQuotaLease?>(null);
            }
            counter.Reserved++;
            return ValueTask.FromResult<IAnalysisQuotaLease?>(new Lease(this, counter));
        }
    }

    private void Complete(DailyCounter counter, bool commit)
    {
        lock (counter)
        {
            counter.Reserved = Math.Max(0, counter.Reserved - 1);
            if (commit) counter.Used++;
            ResetIfNeeded(counter);
        }
    }

    private static void ResetIfNeeded(DailyCounter counter)
    {
        var today = DateOnly.FromDateTime(DateTime.UtcNow);
        if (counter.Day == today) return;
        counter.Day = today;
        counter.Used = 0;
        counter.Reserved = 0;
    }
}
