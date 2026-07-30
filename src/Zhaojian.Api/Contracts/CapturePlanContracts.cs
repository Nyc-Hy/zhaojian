namespace Zhaojian.Api.Contracts;

public sealed record CapturePlanRequest(string TaskId, string DirectionId, bool UsingTripod, CurrentMeteringContext? CurrentMetering);
public sealed record CapturePlanResponse(
    string GearKitId, string DirectionId, FocalRange RequestedEquivalentMm, FocalRange ActualMm, bool Achievable,
    double Aperture, double SafeShutterSeconds, int BaseIso, int MaxIso, double? MeteredEv100,
    long? RequiredIso, int? SelectedIso, bool? IsoWithinRange, double? MeteredShutterSeconds, string Note);
