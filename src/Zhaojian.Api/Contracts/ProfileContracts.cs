namespace Zhaojian.Api.Contracts;

using System.Text.Json;

public sealed record UpdateProfileRequest(string DisplayName);

public sealed record GearKitRequest(
    string Id,
    string Name,
    string Camera,
    string? CameraCatalogId,
    string? CameraMount,
    string? CameraSourceUrl,
    string? CameraSpecsVerifiedAt,
    double SensorWidth,
    double SensorHeight,
    double CropFactor,
    string LensName,
    double FocalMin,
    double FocalMax,
    double Aperture,
    double? MinimumAperture,
    double IbisStops,
    bool Tripod,
    double[] NdStops,
    int MaxIso,
    int? MinIso);

public sealed record GearKitResponse(
    string Id,
    string Name,
    string Camera,
    string? CameraCatalogId,
    string? CameraMount,
    string? CameraSourceUrl,
    string? CameraSpecsVerifiedAt,
    double SensorWidth,
    double SensorHeight,
    double CropFactor,
    string LensName,
    double FocalMin,
    double FocalMax,
    double Aperture,
    double? MinimumAperture,
    double IbisStops,
    bool Tripod,
    double[] NdStops,
    int MaxIso,
    int? MinIso,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt,
    string[] Warnings);

public sealed record JournalEntryRequest(
    string Id,
    DateTimeOffset CreatedAt,
    string Intent,
    string GearName,
    string Direction,
    string Focal,
    string Method,
    string Reflection,
    string? CreativeIntentId,
    string? ThumbnailDataUrl);

public sealed record JournalEntryResponse(
    string Id,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt,
    string Intent,
    string GearName,
    string Direction,
    string Focal,
    string Method,
    string Reflection,
    string? CreativeIntentId,
    JsonElement? CreativeIntent,
    string? ThumbnailUrl);
