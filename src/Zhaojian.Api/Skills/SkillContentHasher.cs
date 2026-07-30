using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using Zhaojian.Api.Contracts;

namespace Zhaojian.Api.Skills;

internal static class SkillContentHasher
{
    public static string Compute(string definitionPath, SkillDefinitionContract definition)
    {
        var skillDirectory = Path.GetDirectoryName(definitionPath)
            ?? throw new SkillRegistryException("Skill 定义缺少所在目录。");
        var artifacts = ArtifactPaths(definition).ToDictionary(
            relativePath => relativePath,
            relativePath => File.ReadAllBytes(ResolveArtifactPath(skillDirectory, relativePath)),
            StringComparer.Ordinal);
        return Compute(File.ReadAllBytes(definitionPath), artifacts);
    }

    public static string Compute(
        byte[] definitionBytes,
        IReadOnlyDictionary<string, byte[]> artifacts)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        hash.AppendData(CanonicalDocumentBytes(definitionBytes));

        foreach (var (relativePath, bytes) in artifacts.OrderBy(value => value.Key, StringComparer.Ordinal))
        {
            hash.AppendData(Encoding.UTF8.GetBytes($"\n--{relativePath}--\n"));
            hash.AppendData(bytes);
        }
        return $"sha256:{Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant()}";
    }

    public static string ComputeDocument(byte[] documentBytes)
    {
        var hash = SHA256.HashData(CanonicalDocumentBytes(documentBytes));
        return $"sha256:{Convert.ToHexString(hash).ToLowerInvariant()}";
    }

    public static IReadOnlyList<string> ArtifactPaths(SkillDefinitionContract definition) =>
        new[]
        {
            definition.Artifacts.InstructionsPath
        }
        .Concat(definition.Artifacts.ReferencePaths)
        .Concat(definition.Artifacts.ExamplePaths)
        .Concat(definition.Artifacts.NegativeExamplePaths)
        .Distinct(StringComparer.Ordinal)
        .ToArray();

    public static string ResolveArtifactPath(string skillDirectory, string relativePath)
    {
        if (string.IsNullOrWhiteSpace(relativePath) || Path.IsPathRooted(relativePath))
        {
            throw new SkillRegistryException($"Skill 资源路径必须是相对路径：{relativePath}");
        }
        var root = Path.GetFullPath(skillDirectory);
        var resolved = Path.GetFullPath(Path.Combine(skillDirectory, relativePath));
        var relative = Path.GetRelativePath(root, resolved);
        if (Path.IsPathRooted(relative)
            || relative == ".."
            || relative.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
            || relative.StartsWith($"..{Path.AltDirectorySeparatorChar}", StringComparison.Ordinal))
        {
            throw new SkillRegistryException($"Skill 资源路径越出模块目录：{relativePath}");
        }
        return resolved;
    }

    private static byte[] CanonicalDocumentBytes(byte[] documentBytes)
    {
        using var document = JsonDocument.Parse(documentBytes);
        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream, new JsonWriterOptions
        {
            Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping
        }))
        {
            WriteCanonical(document.RootElement, writer, omitContentHash: true);
        }
        return stream.ToArray();
    }

    private static void WriteCanonical(JsonElement element, Utf8JsonWriter writer, bool omitContentHash)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                writer.WriteStartObject();
                foreach (var property in element.EnumerateObject().OrderBy(value => value.Name, StringComparer.Ordinal))
                {
                    if (omitContentHash && property.NameEquals("content_hash")) continue;
                    writer.WritePropertyName(property.Name);
                    WriteCanonical(property.Value, writer, omitContentHash: false);
                }
                writer.WriteEndObject();
                break;
            case JsonValueKind.Array:
                writer.WriteStartArray();
                foreach (var item in element.EnumerateArray()) WriteCanonical(item, writer, omitContentHash: false);
                writer.WriteEndArray();
                break;
            case JsonValueKind.String:
                writer.WriteStringValue(element.GetString());
                break;
            case JsonValueKind.Number:
                writer.WriteRawValue(element.GetRawText());
                break;
            case JsonValueKind.True:
                writer.WriteBooleanValue(true);
                break;
            case JsonValueKind.False:
                writer.WriteBooleanValue(false);
                break;
            case JsonValueKind.Null:
                writer.WriteNullValue();
                break;
            default:
                throw new SkillRegistryException("Skill 定义包含不支持的 JSON 值。");
        }
    }
}
