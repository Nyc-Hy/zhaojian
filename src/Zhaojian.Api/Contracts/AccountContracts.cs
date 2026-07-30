using System.Text.Json.Serialization;

namespace Zhaojian.Api.Contracts;

public sealed record RegisterRequest(string Email, string Password, string DisplayName);
public sealed record LoginRequest(string Email, string Password, bool RememberMe = true);
public sealed record ChangePasswordRequest(string CurrentPassword, string NewPassword);
public sealed record RequestPasswordResetRequest(string Email);
public sealed record ResetPasswordRequest(string Email, string RecoveryCode, string NewPassword);
public sealed record DeleteAccountRequest(string Password);
public sealed record PasswordResetRequestedResponse(bool Accepted, bool DeliveryConfigured, string? DevelopmentRecoveryCode);
public sealed record AccountUsageSummaryResponse(int TasksThisMonth, int Completed, int Failed, int Canceled, int PromptTokens, int CompletionTokens, decimal EstimatedCostCny, int UnpricedTasks);
public sealed record OperationalCapabilitiesResponse(string ReleaseVersion, string Database, string TaskQueue, string QuotaStore, string ImageStore, bool MultiInstanceReady, bool RecoveryDeliveryConfigured, int AnalysisImageRetentionDays, string PricingVersion, bool PricingConfigured, string[] RequiredBeforeMultiInstance);
public sealed record AccountUserResponse(string Id, string Email, string DisplayName, DateTimeOffset CreatedAt, string[] Roles);
public sealed record AccountSessionResponse(
    bool Authenticated,
    AccountUserResponse? User,
    [property: JsonPropertyName("csrfToken")] string CsrfToken);
