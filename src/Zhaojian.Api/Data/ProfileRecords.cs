namespace Zhaojian.Api.Data;

public sealed class GearKitRecord : IUserOwnedResource
{
    public required string Id { get; set; }
    public required string UserId { get; set; }
    public required string Name { get; set; }
    public required string Camera { get; set; }
    public string? CameraCatalogId { get; set; }
    public string? CameraMount { get; set; }
    public string? CameraSourceUrl { get; set; }
    public string? CameraSpecsVerifiedAt { get; set; }
    public double SensorWidth { get; set; }
    public double SensorHeight { get; set; }
    public double CropFactor { get; set; }
    public required string LensName { get; set; }
    public double FocalMin { get; set; }
    public double FocalMax { get; set; }
    public double Aperture { get; set; }
    public double? MinimumAperture { get; set; }
    public double IbisStops { get; set; }
    public bool Tripod { get; set; }
    public required string NdStopsJson { get; set; }
    public int MaxIso { get; set; }
    public int? MinIso { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    public long UpdatedAtUnixMs { get; set; }
    public ApplicationUser? User { get; set; }
}

public sealed class JournalEntryRecord : IUserOwnedResource
{
    public required string Id { get; set; }
    public required string UserId { get; set; }
    public required string Intent { get; set; }
    public required string GearName { get; set; }
    public required string Direction { get; set; }
    public required string Focal { get; set; }
    public required string Method { get; set; }
    public required string Reflection { get; set; }
    public string? CreativeIntentId { get; set; }
    public byte[]? Thumbnail { get; set; }
    public int ThumbnailByteLength { get; set; }
    public string? ThumbnailContentType { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
    public long CreatedAtUnixMs { get; set; }
    public ApplicationUser? User { get; set; }
    public CreativeIntentRecord? CreativeIntent { get; set; }
}
