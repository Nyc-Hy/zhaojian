using Microsoft.Extensions.Options;
using Zhaojian.Api.Infrastructure;

namespace Zhaojian.Api.Services;

public sealed class AnalysisConcurrencyGate
{
    private readonly SemaphoreSlim _semaphore;

    public AnalysisConcurrencyGate(IOptions<ApiProtectionOptions> options)
    {
        _semaphore = new SemaphoreSlim(options.Value.MaxConcurrentAnalyses, options.Value.MaxConcurrentAnalyses);
    }

    public async ValueTask<IAsyncDisposable?> TryEnterAsync(CancellationToken cancellationToken)
    {
        if (!await _semaphore.WaitAsync(0, cancellationToken)) return null;
        return new Releaser(_semaphore);
    }

    private sealed class Releaser(SemaphoreSlim semaphore) : IAsyncDisposable
    {
        public ValueTask DisposeAsync()
        {
            semaphore.Release();
            return ValueTask.CompletedTask;
        }
    }
}
