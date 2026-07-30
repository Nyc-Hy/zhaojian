using Microsoft.Extensions.Options;
using Zhaojian.Api.Contracts;
using Zhaojian.Api.Infrastructure;

namespace Zhaojian.Api.Providers;

public sealed class ConfiguredVisionProvider : IVisionProvider
{
    private readonly MockProvider _mock;
    private readonly QwenProvider _qwen;
    private readonly bool _wantsQwen;

    public ConfiguredVisionProvider(MockProvider mock, QwenProvider qwen, IOptions<ModelOptions> options)
    {
        _mock = mock;
        _qwen = qwen;
        _wantsQwen = string.Equals(options.Value.Provider, "qwen", StringComparison.OrdinalIgnoreCase);
    }

    private IVisionProvider Active => _wantsQwen && _qwen.Status.Available ? _qwen : _mock;
    public string Name => Active.Name;
    public string Model => Active.Model;
    public string PromptVersion => Active.PromptVersion;
    public ProviderStatusResponse Status => _wantsQwen && !_qwen.Status.Available ? _qwen.Status : Active.Status;

    public async Task<ProviderResult> AnalyzeAsync(VisionInput input, CancellationToken cancellationToken)
    {
        var result = await Active.AnalyzeAsync(input, cancellationToken);
        return _wantsQwen && !_qwen.Status.Available ? result with { Degraded = true } : result;
    }
}
