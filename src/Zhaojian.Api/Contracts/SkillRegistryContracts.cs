namespace Zhaojian.Api.Contracts;

public sealed record SkillRegistryEntryResponse(
    string SkillId,
    string SkillVersion,
    string Status,
    bool Active,
    string ContentHash,
    DateTimeOffset CreatedAt);

public sealed record SkillRegistryStatusResponse(
    bool CloudSkillsEnabled,
    string RuntimeVersion,
    IReadOnlyList<SkillRegistryEntryResponse> Skills);
