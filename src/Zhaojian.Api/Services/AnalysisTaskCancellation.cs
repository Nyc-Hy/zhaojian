using System.Collections.Concurrent;

namespace Zhaojian.Api.Services;

public sealed class AnalysisTaskCancellation
{
    private readonly ConcurrentDictionary<string, CancellationTokenSource> _running = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, byte> _userCanceled = new(StringComparer.Ordinal);

    public CancellationTokenSource Register(string taskId, CancellationToken hostToken, TimeSpan timeout)
    {
        var source = CancellationTokenSource.CreateLinkedTokenSource(hostToken);
        source.CancelAfter(timeout);
        if (!_running.TryAdd(taskId, source))
        {
            source.Dispose();
            throw new InvalidOperationException($"任务 {taskId} 已经在运行。");
        }
        return source;
    }

    public bool Request(string taskId)
    {
        _userCanceled[taskId] = 0;
        if (_running.TryGetValue(taskId, out var source)) source.Cancel();
        return true;
    }

    public bool WasRequested(string taskId) => _userCanceled.ContainsKey(taskId);

    public void Complete(string taskId)
    {
        if (_running.TryRemove(taskId, out var source)) source.Dispose();
        _userCanceled.TryRemove(taskId, out _);
    }
}
