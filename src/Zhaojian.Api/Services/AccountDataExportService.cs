using System.IO.Compression;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Zhaojian.Api.Data;
using Zhaojian.Api.Infrastructure;

namespace Zhaojian.Api.Services;

public sealed class AccountDataExportService(ZhaojianDbContext database)
{
    private const long MaxExportSourceBytes = 100L * 1024 * 1024;
    private const int MaxExportRecords = 20_000;

    public async Task<byte[]> CreateAsync(ApplicationUser user, CancellationToken cancellationToken)
    {
        var recordCount = await database.GearKits.CountAsync(value => value.UserId == user.Id, cancellationToken)
            + await database.JournalEntries.CountAsync(value => value.UserId == user.Id, cancellationToken)
            + await database.AnalysisTasks.CountAsync(value => value.UserId == user.Id, cancellationToken)
            + await database.FeedbackRecords.CountAsync(value => value.UserId == user.Id, cancellationToken)
            + await database.CreativePreferences.CountAsync(value => value.UserId == user.Id, cancellationToken)
            + await database.CreativeIntents.CountAsync(value => value.UserId == user.Id, cancellationToken);
        var sourceBytes = await database.JournalEntries.Where(value => value.UserId == user.Id).SumAsync(value => (long)value.ThumbnailByteLength, cancellationToken)
            + await database.ReferenceImages.Where(value => value.UserId == user.Id).SumAsync(value => (long)value.ByteLength, cancellationToken);
        if (recordCount > MaxExportRecords || sourceBytes > MaxExportSourceBytes)
            throw new ApiException(StatusCodes.Status413PayloadTooLarge, "ACCOUNT_EXPORT_TOO_LARGE", "账号数据超过单次在线导出的上限，请联系服务维护者协助导出。");

        var gears = await database.GearKits.AsNoTracking().Where(value => value.UserId == user.Id).ToListAsync(cancellationToken);
        var journals = await database.JournalEntries.AsNoTracking().Where(value => value.UserId == user.Id).ToListAsync(cancellationToken);
        var tasks = await database.AnalysisTasks.AsNoTracking().Where(value => value.UserId == user.Id).ToListAsync(cancellationToken);
        var settings = await database.PersonalizationSettings.AsNoTracking().SingleOrDefaultAsync(value => value.UserId == user.Id, cancellationToken);
        var feedback = await database.FeedbackRecords.AsNoTracking().Where(value => value.UserId == user.Id).ToListAsync(cancellationToken);
        var preferences = await database.CreativePreferences.AsNoTracking().Where(value => value.UserId == user.Id).ToListAsync(cancellationToken);
        var candidates = await database.GlobalExperienceCandidates.AsNoTracking()
            .Where(value => value.SourceFeedback != null && value.SourceFeedback.UserId == user.Id)
            .ToListAsync(cancellationToken);
        var creativeIntents = await database.CreativeIntents.AsNoTracking().Where(value => value.UserId == user.Id).ToListAsync(cancellationToken);
        var images = await database.ReferenceImages.AsNoTracking().Where(value => value.UserId == user.Id && value.Content != null).ToListAsync(cancellationToken);
        var availableImageIds = images.Select(value => value.Id).ToHashSet(StringComparer.Ordinal);

        await using var output = new MemoryStream();
        using (var archive = new ZipArchive(output, ZipArchiveMode.Create, leaveOpen: true))
        {
            var manifest = new
            {
                exportedAt = DateTimeOffset.UtcNow,
                account = new { user.Id, user.Email, user.DisplayName, user.CreatedAt },
                gearKits = gears.Select(value => new { value.Id, value.Name, value.Camera, value.LensName, value.FocalMin, value.FocalMax, value.SensorWidth, value.SensorHeight, value.CropFactor, value.Aperture, value.MinimumAperture, value.IbisStops, value.Tripod, value.NdStopsJson, value.MinIso, value.MaxIso, value.CreatedAt, value.UpdatedAt }),
                journalEntries = journals.Select(value => new { value.Id, value.CreatedAt, value.Intent, value.GearName, value.Direction, value.Focal, value.Method, value.Reflection, value.CreativeIntentId, thumbnailFile = value.Thumbnail is null ? null : $"journal-thumbnails/{value.Id}.jpg" }),
                analysisTasks = tasks.Select(value => new { value.Id, value.ReferenceImageId, value.Status, request = Parse(value.RequestJson), result = Parse(value.ResultJson), skillVersions = Parse(value.SkillSnapshotsJson), gearSnapshot = Parse(value.GearSnapshotJson), value.Provider, value.Model, value.PromptTokens, value.CompletionTokens, value.ProviderCalls, value.EstimatedCostCny, value.PricingVersion, value.ChargeDisposition, value.DurationMs, value.ErrorCode, value.CreatedAt, value.CompletedAt, imageFile = availableImageIds.Contains(value.ReferenceImageId) ? $"analysis-images/{value.ReferenceImageId}.jpg" : null }),
                personalization = new
                {
                    settings = settings is null ? null : new { settings.MemoryEnabled, settings.FeedbackSyncConsent, settings.UpdatedAt },
                    feedback = feedback.Select(value => new { value.Id, value.ClientFeedbackId, value.AnalysisTaskId, value.DirectionId, value.VisualStrategy, value.FeedbackType, value.Value, skillVersions = Parse(value.SkillSnapshotsJson), value.CreatedAt, value.SyncedAt }),
                    preferences = preferences.Select(value => new { value.Id, value.PreferenceKind, value.VisualStrategy, value.EvidenceCount, value.Enabled, value.CreatedAt, value.UpdatedAt }),
                    isolatedGlobalCandidates = candidates.Select(value => new { value.Id, value.SourceFeedbackId, value.CandidateType, payload = Parse(value.PayloadJson), value.Status, value.CreatedAt })
                },
                creativeIntents = creativeIntents.Select(value => Parse(value.PayloadJson))
            };
            await WriteJsonAsync(archive, "manifest.json", manifest, cancellationToken);
            foreach (var journal in journals.Where(value => value.Thumbnail is not null)) await WriteBytesAsync(archive, $"journal-thumbnails/{journal.Id}.jpg", journal.Thumbnail!, cancellationToken);
            foreach (var image in images) await WriteBytesAsync(archive, $"analysis-images/{image.Id}.jpg", image.Content!, cancellationToken);
        }
        return output.ToArray();
    }

    private static JsonElement? Parse(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        using var document = JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }

    private static async Task WriteJsonAsync(ZipArchive archive, string name, object value, CancellationToken token)
    {
        await using var stream = archive.CreateEntry(name, CompressionLevel.Fastest).Open();
        await JsonSerializer.SerializeAsync(stream, value, new JsonSerializerOptions { WriteIndented = true }, token);
    }

    private static async Task WriteBytesAsync(ZipArchive archive, string name, byte[] value, CancellationToken token)
    {
        await using var stream = archive.CreateEntry(name, CompressionLevel.Fastest).Open();
        await stream.WriteAsync(value, token);
    }
}

public interface IAccountRecoveryNotifier
{
    bool IsConfigured { get; }
    Task SendAsync(string email, string recoveryCode, CancellationToken cancellationToken);
}

public sealed class UnconfiguredAccountRecoveryNotifier(ILogger<UnconfiguredAccountRecoveryNotifier> logger) : IAccountRecoveryNotifier
{
    public bool IsConfigured => false;
    public Task SendAsync(string email, string recoveryCode, CancellationToken cancellationToken)
    {
        logger.LogInformation("账号 {EmailDomain} 请求了密码恢复，但尚未配置邮件发送器", email.Split('@').LastOrDefault() ?? "unknown");
        return Task.CompletedTask;
    }
}
