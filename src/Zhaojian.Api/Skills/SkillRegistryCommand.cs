using System.Text.Json;
using Zhaojian.Api.Contracts;
using Zhaojian.Api.Infrastructure;

namespace Zhaojian.Api.Skills;

internal static class SkillRegistryCommand
{
    private const string CommandOption = "--skill-command";

    public static async Task<bool> TryRunAsync(
        IReadOnlyList<string> arguments,
        IServiceProvider services,
        CancellationToken cancellationToken = default)
    {
        var optionIndex = arguments.IndexOf(CommandOption);
        if (optionIndex < 0) return false;
        if (optionIndex + 1 >= arguments.Count)
        {
            throw new SkillRegistryException("缺少 Skill 管理命令。");
        }

        var command = arguments[optionIndex + 1];
        var operands = arguments.Skip(optionIndex + 2).ToArray();
        var options = ParseOptions(operands);
        var registry = services.GetRequiredService<ISkillRegistry>();
        await registry.ReloadAsync(cancellationToken);

        switch (command)
        {
            case "validate":
                RequireOptions(command, options);
                break;
            case "audit":
                RequireOptions(command, options);
                break;
            case "shadow":
                RequireOptions(command, options, "--skill", "--version", "--report", "--actor", "--reason");
                await registry.PromoteToShadowAsync(
                    Required(options, "--skill"),
                    Required(options, "--version"),
                    Required(options, "--report"),
                    Context(command, options),
                    cancellationToken);
                break;
            case "activate":
                RequireOptions(command, options, "--skill", "--version", "--report", "--actor", "--reason");
                await registry.ActivateAsync(
                    Required(options, "--skill"),
                    Required(options, "--version"),
                    Required(options, "--report"),
                    Context(command, options),
                    cancellationToken);
                break;
            case "retire":
                RequireOptions(command, options, "--skill", "--version", "--actor", "--reason");
                await registry.RetireAsync(
                    Required(options, "--skill"),
                    Required(options, "--version"),
                    Context(command, options),
                    cancellationToken);
                break;
            case "rollback":
                RequireOptions(command, options, "--skill", "--actor", "--reason");
                await registry.RollbackAsync(
                    Required(options, "--skill"),
                    Context(command, options),
                    cancellationToken);
                break;
            case "disable":
                RequireOptions(command, options, "--actor", "--reason");
                await registry.SetCloudSkillsEnabledAsync(false, Context(command, options), cancellationToken);
                break;
            case "enable":
                RequireOptions(command, options, "--actor", "--reason");
                await registry.SetCloudSkillsEnabledAsync(true, Context(command, options), cancellationToken);
                break;
            default:
                throw new SkillRegistryException($"未知 Skill 管理命令：{command}");
        }

        var output = new
        {
            command,
            runtimeVersion = registry.RuntimeVersion,
            cloudSkillsEnabled = registry.CloudSkillsEnabled,
            revision = registry.Revision,
            skills = registry.List().Select(value => new
            {
                skillId = value.Definition.SkillId,
                skillVersion = value.Definition.SkillVersion,
                status = value.EffectiveStatus,
                active = value.Active,
                contentHash = value.Definition.ContentHash
            }),
            audit = command == "audit" ? registry.AuditLog : registry.AuditLog.TakeLast(1)
        };
        await Console.Out.WriteLineAsync(JsonSerializer.Serialize(output, SceneJson.Provider));
        return true;
    }

    private static Dictionary<string, string> ParseOptions(IReadOnlyList<string> operands)
    {
        if (operands.Count % 2 != 0)
        {
            throw new SkillRegistryException("Skill 管理命令参数必须使用 --name value。");
        }
        var parsed = new Dictionary<string, string>(StringComparer.Ordinal);
        for (var index = 0; index < operands.Count; index += 2)
        {
            var option = operands[index];
            var value = operands[index + 1];
            if (!option.StartsWith("--", StringComparison.Ordinal) || value.StartsWith("--", StringComparison.Ordinal))
            {
                throw new SkillRegistryException("Skill 管理命令参数必须使用 --name value。");
            }
            if (!parsed.TryAdd(option, value)) throw new SkillRegistryException($"Skill 管理命令参数重复：{option}");
        }
        return parsed;
    }

    private static void RequireOptions(
        string command,
        IReadOnlyDictionary<string, string> options,
        params string[] required)
    {
        var expected = new HashSet<string>(required, StringComparer.Ordinal);
        var actual = new HashSet<string>(options.Keys, StringComparer.Ordinal);
        if (!expected.SetEquals(actual))
        {
            throw new SkillRegistryException(
                $"Skill 管理命令 {command} 需要参数：{string.Join(", ", required.DefaultIfEmpty("无"))}。");
        }
    }

    private static string Required(IReadOnlyDictionary<string, string> options, string name)
    {
        if (!options.TryGetValue(name, out var value) || string.IsNullOrWhiteSpace(value))
        {
            throw new SkillRegistryException($"缺少 Skill 管理参数 {name}。");
        }
        return value;
    }

    private static SkillMutationContext Context(
        string command,
        IReadOnlyDictionary<string, string> options) =>
        new(
            Required(options, "--actor"),
            Required(options, "--reason"),
            $"npm run skill:{(command == "activate" ? "promote" : command)}");

    private static int IndexOf(this IReadOnlyList<string> values, string target)
    {
        for (var index = 0; index < values.Count; index++)
        {
            if (string.Equals(values[index], target, StringComparison.Ordinal)) return index;
        }
        return -1;
    }
}
