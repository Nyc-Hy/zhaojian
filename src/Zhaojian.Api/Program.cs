using System.Net;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Http.Timeouts;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Zhaojian.Api.Authorization;
using Zhaojian.Api.Contracts;
using Zhaojian.Api.Data;
using Zhaojian.Api.Endpoints;
using Zhaojian.Api.Infrastructure;
using Zhaojian.Api.Providers;
using Zhaojian.Api.Services;
using Zhaojian.Api.Skills;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddProblemDetails(options =>
{
    options.CustomizeProblemDetails = context =>
    {
        context.ProblemDetails.Extensions["request_id"] = context.HttpContext.TraceIdentifier;
    };
});
var databaseConnection = builder.Configuration.GetConnectionString("Zhaojian") ?? "Data Source=App_Data/zhaojian.db;Cache=Shared";
var sqliteConnection = new SqliteConnectionStringBuilder(databaseConnection);
if (!string.Equals(sqliteConnection.DataSource, ":memory:", StringComparison.OrdinalIgnoreCase))
{
    var databasePath = Path.IsPathRooted(sqliteConnection.DataSource)
        ? sqliteConnection.DataSource
        : Path.GetFullPath(sqliteConnection.DataSource, builder.Environment.ContentRootPath);
    Directory.CreateDirectory(Path.GetDirectoryName(databasePath) ?? builder.Environment.ContentRootPath);
    sqliteConnection.DataSource = databasePath;
    databaseConnection = sqliteConnection.ToString();
}
builder.Services.AddDbContext<ZhaojianDbContext>(options => options.UseSqlite(databaseConnection));
builder.Services.AddHealthChecks()
    .AddCheck<DatabaseHealthCheck>("database", tags: ["ready"]);
builder.Services.AddAuthentication(IdentityConstants.ApplicationScheme).AddIdentityCookies();
builder.Services.AddIdentityCore<ApplicationUser>(options =>
{
    options.User.RequireUniqueEmail = true;
    options.Password.RequiredLength = 10;
    options.Password.RequireDigit = true;
    options.Password.RequireLowercase = true;
    options.Password.RequireUppercase = false;
    options.Password.RequireNonAlphanumeric = false;
    options.Lockout.MaxFailedAccessAttempts = 5;
    options.Lockout.DefaultLockoutTimeSpan = TimeSpan.FromMinutes(15);
})
    .AddRoles<IdentityRole>()
    .AddSignInManager()
    .AddEntityFrameworkStores<ZhaojianDbContext>()
    .AddDefaultTokenProviders();
builder.Services.ConfigureApplicationCookie(options =>
{
    options.Cookie.Name = "zhaojian.auth";
    options.Cookie.HttpOnly = true;
    options.Cookie.SameSite = SameSiteMode.Strict;
    options.Cookie.SecurePolicy = builder.Environment.IsDevelopment() || builder.Environment.IsEnvironment("Testing")
        ? CookieSecurePolicy.SameAsRequest
        : CookieSecurePolicy.Always;
    options.ExpireTimeSpan = TimeSpan.FromDays(14);
    options.SlidingExpiration = true;
    options.Events = new CookieAuthenticationEvents
    {
        OnRedirectToLogin = context =>
        {
            context.Response.StatusCode = StatusCodes.Status401Unauthorized;
            return Task.CompletedTask;
        },
        OnRedirectToAccessDenied = context =>
        {
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            return Task.CompletedTask;
        }
    };
});
builder.Services.AddAntiforgery(options =>
{
    options.HeaderName = "X-CSRF-TOKEN";
    options.Cookie.Name = "zhaojian.csrf";
    options.Cookie.HttpOnly = true;
    options.Cookie.SameSite = SameSiteMode.Strict;
    options.Cookie.SecurePolicy = builder.Environment.IsDevelopment() || builder.Environment.IsEnvironment("Testing")
        ? CookieSecurePolicy.SameAsRequest
        : CookieSecurePolicy.Always;
});
builder.Services.AddAuthorizationBuilder()
    .AddPolicy(AuthorizationPolicies.AnalysisCreate, policy => policy.RequireAuthenticatedUser().RequireRole(ApplicationRoles.Member, ApplicationRoles.Admin))
    .AddPolicy(AuthorizationPolicies.OwnResource, policy => policy.RequireAuthenticatedUser().AddRequirements(new OwnResourceRequirement()));
builder.Services.AddSingleton<IAuthorizationHandler, OwnResourceAuthorizationHandler>();
builder.Services.AddHttpClient(QwenProvider.HttpClientName, client =>
{
    client.Timeout = Timeout.InfiniteTimeSpan;
});
builder.Services.AddRequestTimeouts(options =>
{
    options.AddPolicy("analysis", TimeSpan.FromSeconds(310));
});
builder.Services.Configure<FormOptions>(options =>
{
    options.MultipartBodyLengthLimit = UploadPolicy.MaxRequestBytes;
    options.ValueCountLimit = 2;
    options.ValueLengthLimit = UploadPolicy.MaxRequestJsonChars;
    options.MultipartHeadersLengthLimit = 8 * 1024;
});
builder.WebHost.ConfigureKestrel(options =>
{
    options.Limits.MaxRequestBodySize = UploadPolicy.MaxRequestBytes;
    options.Limits.RequestHeadersTimeout = TimeSpan.FromSeconds(15);
});

builder.Services.AddOptions<ModelOptions>()
    .Bind(builder.Configuration.GetSection(ModelOptions.SectionName))
    .ValidateDataAnnotations()
    .ValidateOnStart();
builder.Services.AddOptions<ApiProtectionOptions>()
    .Bind(builder.Configuration.GetSection(ApiProtectionOptions.SectionName))
    .ValidateDataAnnotations()
    .ValidateOnStart();
builder.Services.AddOptions<DataRetentionOptions>()
    .Bind(builder.Configuration.GetSection(DataRetentionOptions.SectionName))
    .ValidateDataAnnotations()
    .ValidateOnStart();
builder.Services.AddOptions<SkillRegistryOptions>()
    .Bind(builder.Configuration.GetSection(SkillRegistryOptions.SectionName))
    .ValidateDataAnnotations()
    .ValidateOnStart();

var allowedOrigins = builder.Configuration
    .GetSection($"{ApiProtectionOptions.SectionName}:AllowedOrigins")
    .Get<string[]>() ?? ["http://127.0.0.1:5173", "http://localhost:5173"];
builder.Services.AddCors(options => options.AddPolicy("web", policy =>
{
    policy.WithOrigins(allowedOrigins).AllowAnyHeader().AllowAnyMethod().AllowCredentials();
}));

builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    options.OnRejected = async (context, cancellationToken) =>
    {
        context.HttpContext.Response.ContentType = "application/problem+json";
        if (context.Lease.TryGetMetadata(MetadataName.RetryAfter, out var retryAfter))
        {
            context.HttpContext.Response.Headers.RetryAfter = Math.Max(1, (int)Math.Ceiling(retryAfter.TotalSeconds)).ToString();
        }
        await ApiProblems.WriteAsync(
            context.HttpContext,
            StatusCodes.Status429TooManyRequests,
            "RATE_LIMITED",
            "请求过于频繁，请稍后再试。",
            cancellationToken);
    };
    options.AddPolicy("analysis", httpContext =>
    {
        var protection = httpContext.RequestServices.GetRequiredService<IOptions<ApiProtectionOptions>>().Value;
        var clientId = httpContext.RequestServices.GetRequiredService<IClientIdentityResolver>().Resolve(httpContext);
        return RateLimitPartition.GetFixedWindowLimiter(clientId, _ => new FixedWindowRateLimiterOptions
        {
            AutoReplenishment = true,
            PermitLimit = protection.AnalysesPerMinute,
            QueueLimit = 0,
            Window = TimeSpan.FromMinutes(1)
        });
    });
    options.AddPolicy("account", httpContext =>
    {
        var protection = httpContext.RequestServices.GetRequiredService<IOptions<ApiProtectionOptions>>().Value;
        return RateLimitPartition.GetFixedWindowLimiter(
        $"account:{httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown"}", _ => new FixedWindowRateLimiterOptions
        {
            AutoReplenishment = true,
            PermitLimit = protection.AccountRequestsPerFiveMinutes,
            QueueLimit = 0,
            Window = TimeSpan.FromMinutes(5)
        });
    });
    options.AddPolicy("export", httpContext =>
    {
        var clientId = httpContext.RequestServices.GetRequiredService<IClientIdentityResolver>().Resolve(httpContext);
        return RateLimitPartition.GetConcurrencyLimiter($"export:{clientId}", _ => new ConcurrencyLimiterOptions
        {
            PermitLimit = 1,
            QueueLimit = 0
        });
    });
});

builder.Services.AddSingleton<UploadGuard>();
builder.Services.AddSingleton<SceneContractValidator>();
builder.Services.AddSingleton<IClientIdentityResolver, RequestClientIdentityResolver>();
builder.Services.AddSingleton<AnalysisConcurrencyGate>();
builder.Services.AddSingleton<FeedbackSyncGate>();
builder.Services.AddSingleton<IAnalysisQuotaService, InMemoryAnalysisQuotaService>();
builder.Services.AddSingleton<IUsageRecorder, InMemoryUsageRecorder>();
builder.Services.AddSingleton<IModelBillingService, ModelBillingService>();
builder.Services.AddSingleton<ISkillRegistry, FileSkillRegistry>();
builder.Services.AddSingleton<ISkillExecutionPlanner, SkillExecutionPlanner>();
builder.Services.AddScoped<IAnalysisTaskStore, EfAnalysisTaskStore>();
builder.Services.AddScoped<IBeforeVisionHook, AccountAnalysisInputHook>();
builder.Services.AddSingleton<ValidatedModelOutputHooks>();
builder.Services.AddSingleton<IAfterUnderstandingHook>(services => services.GetRequiredService<ValidatedModelOutputHooks>());
builder.Services.AddSingleton<IAfterShotOptionsHook>(services => services.GetRequiredService<ValidatedModelOutputHooks>());
builder.Services.AddSingleton<MockProvider>();
builder.Services.AddSingleton<QwenProvider>();
builder.Services.AddSingleton<IVisionProvider, ConfiguredVisionProvider>();
builder.Services.AddScoped<SceneAnalysisService>();
builder.Services.AddScoped<CreativeIntentService>();
builder.Services.AddScoped<PersonalizationService>();
builder.Services.AddScoped<IBeforeParameterEngineHook, BeforeParameterEngineHook>();
builder.Services.AddScoped<CapturePlanService>();
builder.Services.AddScoped<AccountDataExportService>();
builder.Services.AddSingleton<IAccountRecoveryNotifier, UnconfiguredAccountRecoveryNotifier>();
builder.Services.AddSingleton<IAnalysisTaskQueue, AnalysisTaskQueue>();
builder.Services.AddSingleton<AnalysisTaskCancellation>();
builder.Services.AddHostedService<AnalysisTaskWorker>();
builder.Services.AddHostedService<DataRetentionWorker>();

var app = builder.Build();

if (await SkillRegistryCommand.TryRunAsync(args, app.Services))
{
    return;
}

app.UseExceptionHandler(exceptionHandlerApp =>
{
    exceptionHandlerApp.Run(async context =>
    {
        var exception = context.Features.Get<IExceptionHandlerFeature>()?.Error;
        if (exception is ApiException apiException)
        {
            await ApiProblems.WriteAsync(context, apiException.StatusCode, apiException.Code, apiException.Message, context.RequestAborted);
            return;
        }
        if (exception is AntiforgeryValidationException)
        {
            await ApiProblems.WriteAsync(context, StatusCodes.Status400BadRequest, "INVALID_CSRF", "安全令牌已过期，请刷新页面后重试。", context.RequestAborted);
            return;
        }

        context.RequestServices.GetRequiredService<ILoggerFactory>()
            .CreateLogger("UnhandledException")
            .LogError(exception, "未处理的 API 异常，请求 {RequestId}", context.TraceIdentifier);
        await ApiProblems.WriteAsync(context, StatusCodes.Status500InternalServerError, "INTERNAL_ERROR", "服务暂时无法完成请求。", context.RequestAborted);
    });
});

app.Use(async (context, next) =>
{
    context.TraceIdentifier = $"req_{Guid.NewGuid():N}";
    context.Response.Headers["X-Request-Id"] = context.TraceIdentifier;
    context.Response.Headers["X-Content-Type-Options"] = "nosniff";
    context.Response.Headers["Referrer-Policy"] = "no-referrer";
    await next(context);
});
app.UseCors("web");
app.UseAuthentication();
app.UseAuthorization();
app.UseRateLimiter();
app.UseAntiforgery();
app.UseRequestTimeouts();

app.MapHealthChecks("/health", new HealthCheckOptions { Predicate = check => check.Tags.Contains("ready") });
app.MapHealthChecks("/health/live", new HealthCheckOptions { Predicate = _ => false });
app.MapHealthChecks("/health/ready", new HealthCheckOptions { Predicate = check => check.Tags.Contains("ready") });
app.MapAccountEndpoints();
app.MapZhaojianApi();
app.MapAnalysisHistoryEndpoints();
app.MapProfileDataEndpoints();
app.MapPersonalizationEndpoints();

await app.InitializeDatabaseAsync();
await app.Services.GetRequiredService<ISkillRegistry>().ReloadAsync();

app.Run();

public partial class Program;
