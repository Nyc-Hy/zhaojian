using Microsoft.Extensions.Options;
using Zhaojian.Api.Contracts;
using Zhaojian.Api.Infrastructure;

namespace Zhaojian.Api.Services;

public sealed record ModelBilling(string PricingVersion, string ChargeDisposition);

public interface IModelBillingService
{
    ModelBilling Describe(string provider, ProviderUsage usage);
}

public sealed class ModelBillingService(IOptions<ModelOptions> options) : IModelBillingService
{
    public ModelBilling Describe(string provider, ProviderUsage usage)
    {
        if (provider == "mock") return new ModelBilling("mock", "not_billable");
        var pricing = options.Value.Qwen;
        if (pricing.InputPerMillionCny <= 0 && pricing.OutputPerMillionCny <= 0) return new ModelBilling(pricing.PricingVersion, "unpriced");
        return new ModelBilling(pricing.PricingVersion, usage.EstimatedCostCny > 0 ? "estimated_success" : "estimated_zero");
    }
}
