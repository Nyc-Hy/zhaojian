namespace Zhaojian.Api.Services;

public sealed class FeedbackSyncGate
{
    private const int StripeCount = 64;
    private readonly SemaphoreSlim[] _stripes = Enumerable.Range(0, StripeCount)
        .Select(_ => new SemaphoreSlim(1, 1))
        .ToArray();

    public async ValueTask<IAsyncDisposable> EnterAsync(string userId, CancellationToken cancellationToken)
    {
        var hash = unchecked((uint)StringComparer.Ordinal.GetHashCode(userId));
        var semaphore = _stripes[(int)(hash % StripeCount)];
        await semaphore.WaitAsync(cancellationToken);
        return new Releaser(semaphore);
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
