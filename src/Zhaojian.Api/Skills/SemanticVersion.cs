using System.Text.RegularExpressions;

namespace Zhaojian.Api.Skills;

internal readonly partial record struct SemanticVersion(int Major, int Minor, int Patch, string? Prerelease) : IComparable<SemanticVersion>
{
    public static SemanticVersion Parse(string value)
    {
        var match = SemanticVersionPattern().Match(value);
        if (!match.Success
            || !int.TryParse(match.Groups[1].Value, out var major)
            || !int.TryParse(match.Groups[2].Value, out var minor)
            || !int.TryParse(match.Groups[3].Value, out var patch))
        {
            throw new SkillRegistryException($"语义版本格式不正确：{value}");
        }
        return new SemanticVersion(major, minor, patch, match.Groups[4].Success ? match.Groups[4].Value : null);
    }

    public int CompareTo(SemanticVersion other)
    {
        var comparison = Major.CompareTo(other.Major);
        if (comparison != 0) return comparison;
        comparison = Minor.CompareTo(other.Minor);
        if (comparison != 0) return comparison;
        comparison = Patch.CompareTo(other.Patch);
        if (comparison != 0) return comparison;
        if (Prerelease is null) return other.Prerelease is null ? 0 : 1;
        if (other.Prerelease is null) return -1;
        return string.CompareOrdinal(Prerelease, other.Prerelease);
    }

    [GeneratedRegex(@"^([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9A-Za-z.-]+))?$")]
    private static partial Regex SemanticVersionPattern();
}
