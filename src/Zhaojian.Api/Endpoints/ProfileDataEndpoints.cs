using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Authorization;
using Microsoft.EntityFrameworkCore;
using SkiaSharp;
using Zhaojian.Api.Authorization;
using Zhaojian.Api.Contracts;
using Zhaojian.Api.Data;
using Zhaojian.Api.Infrastructure;

namespace Zhaojian.Api.Endpoints;

public static class ProfileDataEndpoints
{
    private const int MaxThumbnailBytes = 512 * 1024;
    private const int MaxThumbnailEdge = 1024;
    private const long MaxThumbnailPixels = 1_048_576;
    private const int MaxJournalEntriesPerUser = 1000;
    private const long MaxThumbnailBytesPerUser = 50L * 1024 * 1024;

    public static IEndpointRouteBuilder MapProfileDataEndpoints(this IEndpointRouteBuilder endpoints)
    {
        var gears = endpoints.MapGroup("/v1/gear-kits").RequireAuthorization(AuthorizationPolicies.AnalysisCreate);
        gears.MapGet("/", ListGearsAsync);
        gears.MapPost("/", SaveGearAsync).WithMetadata(new RequireAntiforgeryTokenAttribute());
        gears.MapDelete("/{gearId}", DeleteGearAsync).WithMetadata(new RequireAntiforgeryTokenAttribute());

        var journals = endpoints.MapGroup("/v1/journal-entries").RequireAuthorization(AuthorizationPolicies.AnalysisCreate);
        journals.MapGet("/", ListJournalsAsync);
        journals.MapPost("/", SaveJournalAsync).WithMetadata(new RequireAntiforgeryTokenAttribute());
        journals.MapGet("/{entryId}/thumbnail", GetJournalThumbnailAsync);
        journals.MapDelete("/{entryId}", DeleteJournalAsync).WithMetadata(new RequireAntiforgeryTokenAttribute());
        return endpoints;
    }

    private static async Task<IResult> ListGearsAsync(HttpContext context, ZhaojianDbContext database, CancellationToken cancellationToken)
    {
        var userId = CurrentUser.Id(context.User);
        var items = await database.GearKits.AsNoTracking()
            .Where(value => value.UserId == userId)
            .OrderByDescending(value => value.UpdatedAtUnixMs)
            .ToListAsync(cancellationToken);
        return TypedResults.Ok(new { items = items.Select(ToGearResponse) });
    }

    private static async Task<IResult> SaveGearAsync(HttpContext context, GearKitRequest request, ZhaojianDbContext database, CancellationToken cancellationToken)
    {
        ValidateGear(request);
        var userId = CurrentUser.Id(context.User);
        var existing = await database.GearKits.SingleOrDefaultAsync(value => value.Id == request.Id, cancellationToken);
        if (existing is not null && existing.UserId != userId) return TypedResults.NotFound();

        var now = DateTimeOffset.UtcNow;
        var record = existing ?? new GearKitRecord
        {
            Id = request.Id,
            UserId = userId,
            Name = request.Name.Trim(),
            Camera = request.Camera.Trim(),
            LensName = request.LensName.Trim(),
            NdStopsJson = "[]",
            CreatedAt = now,
            UpdatedAt = now,
            UpdatedAtUnixMs = now.ToUnixTimeMilliseconds()
        };
        ApplyGear(record, request, now);
        if (existing is null) database.GearKits.Add(record);
        await database.SaveChangesAsync(cancellationToken);
        return TypedResults.Ok(ToGearResponse(record));
    }

    private static async Task<IResult> DeleteGearAsync(HttpContext context, string gearId, ZhaojianDbContext database, IAuthorizationService authorization, CancellationToken cancellationToken)
    {
        var record = await database.GearKits.SingleOrDefaultAsync(value => value.Id == gearId, cancellationToken);
        if (record is null || !(await authorization.AuthorizeAsync(context.User, record, AuthorizationPolicies.OwnResource)).Succeeded) return TypedResults.NotFound();
        database.GearKits.Remove(record);
        await database.SaveChangesAsync(cancellationToken);
        return TypedResults.NoContent();
    }

    private static async Task<IResult> ListJournalsAsync(HttpContext context, ZhaojianDbContext database, int limit = 100, CancellationToken cancellationToken = default)
    {
        var userId = CurrentUser.Id(context.User);
        var safeLimit = Math.Clamp(limit, 1, 200);
        var items = await database.JournalEntries.AsNoTracking()
            .Include(value => value.CreativeIntent)
            .Where(value => value.UserId == userId)
            .OrderByDescending(value => value.CreatedAtUnixMs)
            .Take(safeLimit)
            .ToListAsync(cancellationToken);
        return TypedResults.Ok(new { items = items.Select(ToJournalResponse) });
    }

    private static async Task<IResult> SaveJournalAsync(HttpContext context, JournalEntryRequest request, ZhaojianDbContext database, CancellationToken cancellationToken)
    {
        ValidateJournal(request);
        var userId = CurrentUser.Id(context.User);
        var existing = await database.JournalEntries.SingleOrDefaultAsync(value => value.Id == request.Id, cancellationToken);
        if (existing is not null && existing.UserId != userId) return TypedResults.NotFound();
        CreativeIntentRecord? creativeIntent = null;
        if (!string.IsNullOrWhiteSpace(request.CreativeIntentId))
        {
            creativeIntent = await database.CreativeIntents.SingleOrDefaultAsync(
                value => value.Id == request.CreativeIntentId && value.UserId == userId,
                cancellationToken);
            if (creativeIntent is null) return TypedResults.NotFound();
        }

        var thumbnail = DecodeThumbnail(request.ThumbnailDataUrl);
        if (existing is null && await database.JournalEntries.CountAsync(value => value.UserId == userId, cancellationToken) >= MaxJournalEntriesPerUser)
        {
            throw new ApiException(StatusCodes.Status413PayloadTooLarge, "JOURNAL_QUOTA_EXCEEDED", "这个账号的摄影日记数量已达到当前上限，请先导出或整理已有日记。");
        }
        if (thumbnail is not null)
        {
            var usedBytes = await database.JournalEntries.Where(value => value.UserId == userId).SumAsync(value => (long)value.ThumbnailByteLength, cancellationToken);
            var existingBytes = existing?.ThumbnailByteLength ?? 0;
            if (usedBytes - existingBytes + thumbnail.Length > MaxThumbnailBytesPerUser)
                throw new ApiException(StatusCodes.Status413PayloadTooLarge, "JOURNAL_QUOTA_EXCEEDED", "这个账号的摄影日记缩略图已达到当前存储上限，请先导出或整理已有日记。");
        }
        var now = DateTimeOffset.UtcNow;
        var record = existing ?? new JournalEntryRecord
        {
            Id = request.Id,
            UserId = userId,
            Intent = request.Intent.Trim(),
            GearName = request.GearName.Trim(),
            Direction = request.Direction.Trim(),
            Focal = request.Focal.Trim(),
            Method = request.Method.Trim(),
            Reflection = request.Reflection.Trim(),
            CreatedAt = request.CreatedAt,
            UpdatedAt = now,
            CreatedAtUnixMs = request.CreatedAt.ToUnixTimeMilliseconds()
        };
        record.Intent = request.Intent.Trim();
        record.GearName = request.GearName.Trim();
        record.Direction = request.Direction.Trim();
        record.Focal = request.Focal.Trim();
        record.Method = request.Method.Trim();
        record.Reflection = request.Reflection.Trim();
        record.CreativeIntentId = creativeIntent?.Id;
        record.CreativeIntent = creativeIntent;
        record.CreatedAt = request.CreatedAt;
        record.CreatedAtUnixMs = request.CreatedAt.ToUnixTimeMilliseconds();
        record.UpdatedAt = now;
        if (thumbnail is not null)
        {
            record.Thumbnail = thumbnail;
            record.ThumbnailByteLength = thumbnail.Length;
            record.ThumbnailContentType = "image/jpeg";
        }
        if (existing is null) database.JournalEntries.Add(record);
        await database.SaveChangesAsync(cancellationToken);
        return TypedResults.Ok(ToJournalResponse(record));
    }

    private static async Task<IResult> GetJournalThumbnailAsync(HttpContext context, string entryId, ZhaojianDbContext database, IAuthorizationService authorization, CancellationToken cancellationToken)
    {
        var record = await database.JournalEntries.AsNoTracking().SingleOrDefaultAsync(value => value.Id == entryId, cancellationToken);
        if (record is null || record.Thumbnail is null || !(await authorization.AuthorizeAsync(context.User, record, AuthorizationPolicies.OwnResource)).Succeeded) return TypedResults.NotFound();
        context.Response.Headers.CacheControl = "private, max-age=300";
        return TypedResults.Bytes(record.Thumbnail, record.ThumbnailContentType ?? "image/jpeg");
    }

    private static async Task<IResult> DeleteJournalAsync(HttpContext context, string entryId, ZhaojianDbContext database, IAuthorizationService authorization, CancellationToken cancellationToken)
    {
        var record = await database.JournalEntries.SingleOrDefaultAsync(value => value.Id == entryId, cancellationToken);
        if (record is null || !(await authorization.AuthorizeAsync(context.User, record, AuthorizationPolicies.OwnResource)).Succeeded) return TypedResults.NotFound();
        database.JournalEntries.Remove(record);
        await database.SaveChangesAsync(cancellationToken);
        return TypedResults.NoContent();
    }

    private static void ValidateGear(GearKitRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Id) || request.Id.Length > 64 || string.IsNullOrWhiteSpace(request.Name) || request.Name.Trim().Length > 80 ||
            string.IsNullOrWhiteSpace(request.Camera) || request.Camera.Trim().Length > 120 || string.IsNullOrWhiteSpace(request.LensName) || request.LensName.Trim().Length > 120 ||
            request.SensorWidth is <= 0 or > 100 || request.SensorHeight is <= 0 or > 100 || request.CropFactor is <= 0 or > 10 ||
            request.FocalMin is <= 0 or > 2000 || request.FocalMax < request.FocalMin || request.FocalMax > 2000 ||
            request.Aperture is < 0.7 or > 64 || request.MinimumAperture is < 1 or > 128 || request.Aperture > (request.MinimumAperture ?? 128) ||
            request.IbisStops is < 0 or > 10 || request.MinIso is < 25 or > 1000000 || request.MaxIso is < 25 or > 1000000 || request.MinIso > request.MaxIso ||
            request.NdStops.Length > 12 || request.NdStops.Any(value => value is < 0 or > 30))
        {
            throw new ApiException(StatusCodes.Status400BadRequest, "INVALID_GEAR_KIT", "摄影包字段不完整或范围不一致。");
        }
    }

    private static void ValidateJournal(JournalEntryRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Id) || request.Id.Length > 64 || request.CreatedAt == default ||
            request.Intent.Length > 240 || request.GearName.Length > 80 || string.IsNullOrWhiteSpace(request.Direction) || request.Direction.Length > 160 ||
            request.Focal.Length > 80 || request.Method.Length > 800 || request.Reflection.Length > 1000 ||
            request.CreativeIntentId?.Length > 64)
        {
            throw new ApiException(StatusCodes.Status400BadRequest, "INVALID_JOURNAL_ENTRY", "摄影日记字段不完整或过长。");
        }
    }

    private static byte[]? DecodeThumbnail(string? dataUrl)
    {
        if (string.IsNullOrWhiteSpace(dataUrl)) return null;
        const string prefix = "data:image/jpeg;base64,";
        if (!dataUrl.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) throw new ApiException(StatusCodes.Status400BadRequest, "INVALID_THUMBNAIL", "日记缩略图必须是 JPEG。");
        byte[] bytes;
        try { bytes = Convert.FromBase64String(dataUrl[prefix.Length..]); }
        catch (FormatException) { throw new ApiException(StatusCodes.Status400BadRequest, "INVALID_THUMBNAIL", "日记缩略图无法读取。"); }
        if (bytes.Length > MaxThumbnailBytes || bytes.Length < 4 || bytes[0] != 0xff || bytes[1] != 0xd8 || bytes[^2] != 0xff || bytes[^1] != 0xd9)
        {
            throw new ApiException(StatusCodes.Status400BadRequest, "INVALID_THUMBNAIL", "日记缩略图超过 512 KiB 或不是完整 JPEG。");
        }
        var (sanitizedBytes, width, height) = JpegSanitizer.Sanitize(bytes);
        try
        {
            using var data = SKData.CreateCopy(sanitizedBytes);
            using var codec = SKCodec.Create(data);
            if (codec is null || width <= 0 || height <= 0 || codec.Info.Width != width || codec.Info.Height != height ||
                width > MaxThumbnailEdge || height > MaxThumbnailEdge || (long)width * height > MaxThumbnailPixels)
                throw InvalidThumbnail();
            var info = new SKImageInfo(width, height, SKColorType.Rgba8888, SKAlphaType.Unpremul);
            using var bitmap = new SKBitmap(info);
            if (codec.GetPixels(info, bitmap.GetPixels()) != SKCodecResult.Success) throw InvalidThumbnail();
        }
        catch (ApiException) { throw; }
        catch { throw InvalidThumbnail(); }
        return sanitizedBytes;

        static ApiException InvalidThumbnail() => new(StatusCodes.Status400BadRequest, "INVALID_THUMBNAIL", "日记缩略图无法完整解码，或像素尺寸超过 1024×1024。");
    }

    private static void ApplyGear(GearKitRecord record, GearKitRequest request, DateTimeOffset updatedAt)
    {
        record.Name = request.Name.Trim(); record.Camera = request.Camera.Trim(); record.CameraCatalogId = Clean(request.CameraCatalogId, 80);
        record.CameraMount = Clean(request.CameraMount, 80); record.CameraSourceUrl = Clean(request.CameraSourceUrl, 500); record.CameraSpecsVerifiedAt = Clean(request.CameraSpecsVerifiedAt, 32);
        record.SensorWidth = request.SensorWidth; record.SensorHeight = request.SensorHeight; record.CropFactor = request.CropFactor; record.LensName = request.LensName.Trim();
        record.FocalMin = request.FocalMin; record.FocalMax = request.FocalMax; record.Aperture = request.Aperture; record.MinimumAperture = request.MinimumAperture;
        record.IbisStops = request.IbisStops; record.Tripod = request.Tripod; record.NdStopsJson = JsonSerializer.Serialize(request.NdStops); record.MaxIso = request.MaxIso; record.MinIso = request.MinIso; record.UpdatedAt = updatedAt; record.UpdatedAtUnixMs = updatedAt.ToUnixTimeMilliseconds();
    }

    private static string? Clean(string? value, int maxLength) => string.IsNullOrWhiteSpace(value) ? null : value.Trim()[..Math.Min(value.Trim().Length, maxLength)];

    private static GearKitResponse ToGearResponse(GearKitRecord value) => new(
        value.Id, value.Name, value.Camera, value.CameraCatalogId, value.CameraMount, value.CameraSourceUrl, value.CameraSpecsVerifiedAt,
        value.SensorWidth, value.SensorHeight, value.CropFactor, value.LensName, value.FocalMin, value.FocalMax, value.Aperture,
        value.MinimumAperture, value.IbisStops, value.Tripod, JsonSerializer.Deserialize<double[]>(value.NdStopsJson) ?? [], value.MaxIso, value.MinIso, value.CreatedAt, value.UpdatedAt,
        GearWarnings(value.LensName, value.FocalMin, value.FocalMax));

    internal static string[] GearWarnings(string lensName, double focalMin, double focalMax)
    {
        var match = Regex.Match(lensName, @"(?<!\d)(?<min>\d{1,4}(?:\.\d+)?)\s*[-–—~至]\s*(?<max>\d{1,4}(?:\.\d+)?)\s*mm", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        if (!match.Success || !double.TryParse(match.Groups["min"].Value, out var namedMin) || !double.TryParse(match.Groups["max"].Value, out var namedMax)) return [];
        return Math.Abs(namedMin - focalMin) > 0.1 || Math.Abs(namedMax - focalMax) > 0.1
            ? [$"镜头名称看起来是 {namedMin:0.#}–{namedMax:0.#}mm，但摄影包记录为 {focalMin:0.#}–{focalMax:0.#}mm；参数计算会采用记录值，请核对。"]
            : [];
    }

    private static JournalEntryResponse ToJournalResponse(JournalEntryRecord value) => new(
        value.Id, value.CreatedAt, value.UpdatedAt, value.Intent, value.GearName, value.Direction, value.Focal, value.Method, value.Reflection,
        value.CreativeIntentId, ParseCreativeIntent(value.CreativeIntent),
        value.Thumbnail is null ? null : $"/api/v1/journal-entries/{value.Id}/thumbnail");

    private static JsonElement? ParseCreativeIntent(CreativeIntentRecord? value)
    {
        if (value is null) return null;
        using var document = JsonDocument.Parse(value.PayloadJson);
        return document.RootElement.Clone();
    }
}
