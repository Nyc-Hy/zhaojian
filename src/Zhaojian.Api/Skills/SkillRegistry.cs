using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Options;
using Zhaojian.Api.Contracts;
using Zhaojian.Api.Infrastructure;

namespace Zhaojian.Api.Skills;

public sealed record SkillArtifactText(string Path, string Content);

public sealed record SkillArtifactBundle(
    SkillArtifactText Instructions,
    IReadOnlyList<SkillArtifactText> References,
    IReadOnlyList<SkillArtifactText> Examples,
    IReadOnlyList<SkillArtifactText> NegativeExamples,
    int TotalBytes);

public sealed record SkillHandle(
    SkillDefinitionContract Definition,
    SkillArtifactBundle Artifacts,
    string EffectiveStatus,
    bool Active);

public sealed record SkillMutationContext(string Actor, string Reason, string Command);
public sealed record SkillRegistryAuditEntry(
    string EventId,
    long Revision,
    string Action,
    string? SkillId,
    string? SkillVersion,
    string? FromStatus,
    string? ToStatus,
    string Actor,
    string Reason,
    string Command,
    string? EvaluationId,
    string? EvaluationReportHash,
    DateTimeOffset OccurredAt);

public interface ISkillRegistry
{
    string RuntimeVersion { get; }
    bool CloudSkillsEnabled { get; }
    long Revision { get; }
    IReadOnlyList<SkillRegistryAuditEntry> AuditLog { get; }
    IReadOnlyList<SkillHandle> List();
    SkillHandle GetRequiredActive(string skillId);
    SkillHandle GetRequiredVersion(SkillVersionSnapshot version);
    Task ReloadAsync(CancellationToken cancellationToken = default);
    Task PromoteToShadowAsync(
        string skillId,
        string skillVersion,
        string evaluationReportPath,
        SkillMutationContext context,
        CancellationToken cancellationToken = default);
    Task ActivateAsync(
        string skillId,
        string skillVersion,
        string evaluationReportPath,
        SkillMutationContext context,
        CancellationToken cancellationToken = default);
    Task RetireAsync(
        string skillId,
        string skillVersion,
        SkillMutationContext context,
        CancellationToken cancellationToken = default);
    Task RollbackAsync(
        string skillId,
        SkillMutationContext context,
        CancellationToken cancellationToken = default);
    Task SetCloudSkillsEnabledAsync(
        bool enabled,
        SkillMutationContext context,
        CancellationToken cancellationToken = default);
}

public sealed partial class FileSkillRegistry(
    IOptions<SkillRegistryOptions> options,
    IHostEnvironment environment,
    ILogger<FileSkillRegistry> logger) : ISkillRegistry
{
    private const int SupportedSkillMajor = 1;
    private static readonly HashSet<string> Statuses = ["draft", "candidate", "shadow", "active", "retired"];
    private static readonly HashSet<string> AuditActions = ["shadow", "activate", "retire", "rollback", "disable", "enable"];
    private readonly SkillRegistryOptions _options = options.Value;
    private readonly SkillReleaseGate _releaseGate = new(options, environment);
    private readonly SemaphoreSlim _writeGate = new(1, 1);
    private RegistrySnapshot _snapshot = RegistrySnapshot.Empty;

    public string RuntimeVersion => _options.RuntimeVersion;
    public bool CloudSkillsEnabled => Volatile.Read(ref _snapshot).CloudSkillsEnabled;
    public long Revision => Volatile.Read(ref _snapshot).Revision;
    public IReadOnlyList<SkillRegistryAuditEntry> AuditLog => Volatile.Read(ref _snapshot).AuditLog;

    public IReadOnlyList<SkillHandle> List() =>
        Volatile.Read(ref _snapshot).Entries.Values
            .OrderBy(value => value.Definition.SkillId, StringComparer.Ordinal)
            .ThenByDescending(value => SemanticVersion.Parse(value.Definition.SkillVersion))
            .ToArray();

    public SkillHandle GetRequiredActive(string skillId)
    {
        var snapshot = Volatile.Read(ref _snapshot);
        if (!snapshot.CloudSkillsEnabled)
        {
            throw new ApiException(StatusCodes.Status503ServiceUnavailable, "SKILLS_DISABLED", "云端摄影分析当前已停用，本地器材与摄影笔记仍可使用。");
        }
        if (!snapshot.ActiveVersions.TryGetValue(skillId, out var version)
            || !snapshot.Entries.TryGetValue(Key(skillId, version), out var handle))
        {
            throw new ApiException(StatusCodes.Status503ServiceUnavailable, "SKILL_UNAVAILABLE", $"摄影能力 {skillId} 当前没有可用版本。");
        }
        return handle;
    }

    public SkillHandle GetRequiredVersion(SkillVersionSnapshot version)
    {
        var snapshot = Volatile.Read(ref _snapshot);
        if (!snapshot.CloudSkillsEnabled)
        {
            throw new ApiException(StatusCodes.Status503ServiceUnavailable, "SKILLS_DISABLED", "云端摄影分析当前已停用，本地器材与摄影笔记仍可使用。");
        }
        if (!snapshot.Entries.TryGetValue(Key(version.SkillId, version.SkillVersion), out var handle)
            || !string.Equals(handle.Definition.ContentHash, version.ContentHash, StringComparison.Ordinal))
        {
            throw new ApiException(
                StatusCodes.Status503ServiceUnavailable,
                "SKILL_VERSION_UNAVAILABLE",
                $"任务需要的摄影能力 {version.SkillId}@{version.SkillVersion} 不可用或内容不匹配，请重新提交分析。");
        }
        return handle;
    }

    public async Task ReloadAsync(CancellationToken cancellationToken = default)
    {
        await _writeGate.WaitAsync(cancellationToken);
        try
        {
            await using var processLock = await AcquireProcessLockAsync(cancellationToken);
            var definitions = LoadDefinitions();
            var state = await LoadStateAsync(cancellationToken);
            var next = BuildSnapshot(definitions, state);
            await PersistAsync(next, cancellationToken);
            Volatile.Write(ref _snapshot, next);
            logger.LogInformation("Skill 注册表已加载 {Count} 个版本，活动 Skill {ActiveCount} 个，云端能力 {Enabled}",
                next.Entries.Count, next.ActiveVersions.Count, next.CloudSkillsEnabled);
        }
        finally
        {
            _writeGate.Release();
        }
    }

    public Task PromoteToShadowAsync(
        string skillId,
        string skillVersion,
        string evaluationReportPath,
        SkillMutationContext context,
        CancellationToken cancellationToken = default) =>
        MutateAsync(snapshot =>
        {
            var key = Key(skillId, skillVersion);
            var handle = Required(snapshot, key);
            if (handle.EffectiveStatus != "candidate")
            {
                throw new SkillRegistryException("只有 candidate Skill 可以进入 shadow。");
            }
            var baseline = RequiredActive(snapshot, skillId);
            var proof = _releaseGate.Validate(evaluationReportPath, handle, baseline, "candidate");
            return new MutationResult(
                snapshot.WithStatus(key, "shadow"),
                new AuditMutation("shadow", skillId, skillVersion, context, proof));
        }, cancellationToken);

    public Task ActivateAsync(
        string skillId,
        string skillVersion,
        string evaluationReportPath,
        SkillMutationContext context,
        CancellationToken cancellationToken = default) =>
        MutateAsync(snapshot =>
        {
            var key = Key(skillId, skillVersion);
            var target = Required(snapshot, key);
            if (target.EffectiveStatus != "shadow")
            {
                throw new SkillRegistryException("只有 shadow Skill 可以激活。");
            }
            var baseline = RequiredActive(snapshot, skillId);
            var proof = _releaseGate.Validate(evaluationReportPath, target, baseline, "shadow");

            var statuses = snapshot.Entries.ToDictionary(value => value.Key, value => value.Value.EffectiveStatus, StringComparer.Ordinal);
            var active = new Dictionary<string, string>(snapshot.ActiveVersions, StringComparer.Ordinal);
            var rollback = new Dictionary<string, string>(snapshot.RollbackVersions, StringComparer.Ordinal);
            if (active.TryGetValue(skillId, out var currentVersion))
            {
                statuses[Key(skillId, currentVersion)] = "shadow";
                rollback[skillId] = currentVersion;
            }
            statuses[key] = "active";
            active[skillId] = skillVersion;
            return new MutationResult(
                snapshot.WithState(statuses, active, rollback, snapshot.CloudSkillsEnabled),
                new AuditMutation("activate", skillId, skillVersion, context, proof));
        }, cancellationToken);

    public Task RetireAsync(
        string skillId,
        string skillVersion,
        SkillMutationContext context,
        CancellationToken cancellationToken = default) =>
        MutateAsync(snapshot =>
        {
            var key = Key(skillId, skillVersion);
            var handle = Required(snapshot, key);
            if (handle.Active) throw new SkillRegistryException("活动 Skill 必须先切换或回滚，不能直接退休。");
            if (handle.EffectiveStatus is not ("candidate" or "shadow"))
            {
                throw new SkillRegistryException("只有 candidate 或 shadow Skill 可以退休。");
            }
            var next = snapshot.WithStatus(key, "retired");
            if (next.RollbackVersions.TryGetValue(skillId, out var rollbackVersion) && rollbackVersion == skillVersion)
            {
                var rollback = new Dictionary<string, string>(next.RollbackVersions, StringComparer.Ordinal);
                rollback.Remove(skillId);
                next = next.WithState(
                    next.Entries.ToDictionary(value => value.Key, value => value.Value.EffectiveStatus, StringComparer.Ordinal),
                    new Dictionary<string, string>(next.ActiveVersions, StringComparer.Ordinal),
                    rollback,
                    next.CloudSkillsEnabled);
            }
            return new MutationResult(
                next,
                new AuditMutation("retire", skillId, skillVersion, context, null));
        }, cancellationToken);

    public Task RollbackAsync(
        string skillId,
        SkillMutationContext context,
        CancellationToken cancellationToken = default) =>
        MutateAsync(snapshot =>
        {
            if (!snapshot.ActiveVersions.TryGetValue(skillId, out var currentVersion)
                || !snapshot.RollbackVersions.TryGetValue(skillId, out var rollbackVersion))
            {
                throw new SkillRegistryException($"Skill {skillId} 没有可回滚版本。");
            }
            var rollbackKey = Key(skillId, rollbackVersion);
            var target = Required(snapshot, rollbackKey);
            if (target.EffectiveStatus == "retired") throw new SkillRegistryException("已退休 Skill 不能回滚为活动版本。");

            var statuses = snapshot.Entries.ToDictionary(value => value.Key, value => value.Value.EffectiveStatus, StringComparer.Ordinal);
            statuses[Key(skillId, currentVersion)] = "shadow";
            statuses[rollbackKey] = "active";
            var active = new Dictionary<string, string>(snapshot.ActiveVersions, StringComparer.Ordinal)
            {
                [skillId] = rollbackVersion
            };
            var rollback = new Dictionary<string, string>(snapshot.RollbackVersions, StringComparer.Ordinal)
            {
                [skillId] = currentVersion
            };
            return new MutationResult(
                snapshot.WithState(statuses, active, rollback, snapshot.CloudSkillsEnabled),
                new AuditMutation("rollback", skillId, rollbackVersion, context, null));
        }, cancellationToken);

    public Task SetCloudSkillsEnabledAsync(
        bool enabled,
        SkillMutationContext context,
        CancellationToken cancellationToken = default) =>
        MutateAsync(snapshot =>
        {
            if (enabled && !_options.CloudSkillsEnabled)
            {
                throw new SkillRegistryException("部署配置已关闭云端 Skill，运行时不能重新启用。");
            }
            return new MutationResult(
                snapshot.WithState(
                    snapshot.Entries.ToDictionary(value => value.Key, value => value.Value.EffectiveStatus, StringComparer.Ordinal),
                    new Dictionary<string, string>(snapshot.ActiveVersions, StringComparer.Ordinal),
                    new Dictionary<string, string>(snapshot.RollbackVersions, StringComparer.Ordinal),
                    enabled),
                new AuditMutation(enabled ? "enable" : "disable", null, null, context, null));
        }, cancellationToken);

    private async Task MutateAsync(Func<RegistrySnapshot, MutationResult> mutation, CancellationToken cancellationToken)
    {
        await _writeGate.WaitAsync(cancellationToken);
        try
        {
            await using var processLock = await AcquireProcessLockAsync(cancellationToken);
            var current = BuildSnapshot(LoadDefinitions(), await LoadStateAsync(cancellationToken));
            var result = mutation(current);
            ValidateMutationContext(result.Audit.Context);
            var next = result.Snapshot.WithAudit(
                CreateAuditEntry(current, result.Snapshot, result.Audit),
                _options.MaxAuditEntries);
            await PersistAsync(next, cancellationToken);
            Volatile.Write(ref _snapshot, next);
        }
        finally
        {
            _writeGate.Release();
        }
    }

    private async Task<FileStream> AcquireProcessLockAsync(CancellationToken cancellationToken)
    {
        var statePath = ResolveStatePath();
        Directory.CreateDirectory(Path.GetDirectoryName(statePath) ?? environment.ContentRootPath);
        var lockPath = $"{statePath}.lock";
        var deadline = Environment.TickCount64 + 5_000;
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                return new FileStream(
                    lockPath,
                    FileMode.OpenOrCreate,
                    FileAccess.ReadWrite,
                    FileShare.None,
                    bufferSize: 1,
                    FileOptions.Asynchronous | FileOptions.WriteThrough);
            }
            catch (IOException) when (Environment.TickCount64 < deadline)
            {
                await Task.Delay(25, cancellationToken);
            }
            catch (IOException error)
            {
                throw new SkillRegistryException("Skill 注册表正由另一个进程修改，请稍后重试。", error);
            }
        }
    }

    private static void ValidateMutationContext(SkillMutationContext context)
    {
        if (!ActorPattern().IsMatch(context.Actor))
        {
            throw new SkillRegistryException("Skill 变更 actor 格式不正确。");
        }
        if (string.IsNullOrWhiteSpace(context.Reason) || context.Reason.Length is < 8 or > 300)
        {
            throw new SkillRegistryException("Skill 变更 reason 长度必须为 8 到 300。");
        }
        if (string.IsNullOrWhiteSpace(context.Command) || context.Command.Length > 300)
        {
            throw new SkillRegistryException("Skill 变更 command 长度不正确。");
        }
    }

    private static SkillRegistryAuditEntry CreateAuditEntry(
        RegistrySnapshot current,
        RegistrySnapshot next,
        AuditMutation audit)
    {
        var key = audit.SkillId is null || audit.SkillVersion is null
            ? null
            : Key(audit.SkillId, audit.SkillVersion);
        var fromStatus = key is not null && current.Entries.TryGetValue(key, out var before)
            ? before.EffectiveStatus
            : null;
        var toStatus = key is not null && next.Entries.TryGetValue(key, out var after)
            ? after.EffectiveStatus
            : null;
        return new SkillRegistryAuditEntry(
            $"skill_event_{Guid.NewGuid():N}",
            checked(current.Revision + 1),
            audit.Action,
            audit.SkillId,
            audit.SkillVersion,
            fromStatus,
            toStatus,
            audit.Context.Actor,
            audit.Context.Reason,
            audit.Context.Command,
            audit.Proof?.EvaluationId,
            audit.Proof?.EvaluationReportHash,
            DateTimeOffset.UtcNow);
    }

    private IReadOnlyDictionary<string, LoadedSkill> LoadDefinitions()
    {
        var root = ResolveRootPath();
        if (!Directory.Exists(root)) throw new SkillRegistryException($"Skill 模块目录不存在：{root}");
        RejectPathChain(root, root);
        var definitionPaths = Directory.EnumerateFiles(root, "skill.json", SearchOption.AllDirectories)
            .Take(_options.MaxDefinitions + 1)
            .ToArray();
        if (definitionPaths.Length == 0) throw new SkillRegistryException("Skill 模块目录中没有 skill.json。");
        if (definitionPaths.Length > _options.MaxDefinitions) throw new SkillRegistryException("Skill 定义数量超过部署上限。");

        var runtime = SemanticVersion.Parse(_options.RuntimeVersion);
        var loaded = new Dictionary<string, LoadedSkill>(StringComparer.Ordinal);
        foreach (var definitionPath in definitionPaths)
        {
            var definitionBytes = ReadCheckedFile(root, definitionPath);
            if (definitionBytes.Length is <= 0 || definitionBytes.Length > _options.MaxDefinitionBytes)
            {
                throw new SkillRegistryException($"Skill 定义大小超出范围：{definitionPath}");
            }
            SkillDefinitionContract definition;
            try
            {
                definition = JsonSerializer.Deserialize<SkillDefinitionContract>(
                    definitionBytes,
                    SceneJson.Provider) ?? throw new JsonException("定义为空");
            }
            catch (JsonException error)
            {
                throw new SkillRegistryException($"Skill 定义无法读取：{definitionPath}", error);
            }
            ValidateDefinition(definition, definitionPath, runtime);
            var artifacts = LoadArtifacts(root, definitionPath, definition, definitionBytes, out var artifactBytes);
            var computedHash = SkillContentHasher.Compute(definitionBytes, artifactBytes);
            if (!string.Equals(computedHash, definition.ContentHash, StringComparison.Ordinal))
            {
                throw new SkillRegistryException($"Skill 内容哈希不匹配：{definition.SkillId}@{definition.SkillVersion}");
            }
            var key = Key(definition.SkillId, definition.SkillVersion);
            if (!loaded.TryAdd(key, new LoadedSkill(definition, artifacts)))
            {
                throw new SkillRegistryException($"Skill 版本重复：{key}");
            }
        }
        return loaded;
    }

    private void ValidateDefinition(SkillDefinitionContract definition, string definitionPath, SemanticVersion runtime)
    {
        if (definition.SchemaVersion != "1.0") throw new SkillRegistryException($"未知 SkillDefinition 主版本：{definition.SchemaVersion}");
        if (!SkillIdPattern().IsMatch(definition.SkillId)) throw new SkillRegistryException($"Skill ID 不正确：{definition.SkillId}");
        if (definition.Trigger is null || definition.InputSchemaVersion is null || definition.OutputSchemaVersion is null
            || definition.CompatibleRuntime is null || definition.ProviderRequirements is null || definition.Artifacts is null
            || definition.Trigger.TaskTypes is null || definition.Trigger.RequiredInputs is null || definition.Trigger.OptionalContext is null
            || definition.ProviderRequirements.Capabilities is null || string.IsNullOrWhiteSpace(definition.Artifacts.InstructionsPath)
            || definition.Artifacts.ReferencePaths is null || definition.Artifacts.ExamplePaths is null || definition.Artifacts.NegativeExamplePaths is null)
        {
            throw new SkillRegistryException($"Skill {definition.SkillId} 缺少必填对象。");
        }
        var version = SemanticVersion.Parse(definition.SkillVersion);
        if (version.Major != SupportedSkillMajor) throw new SkillRegistryException($"不支持 Skill 主版本：{definition.SkillVersion}");
        if (!Statuses.Contains(definition.Status)) throw new SkillRegistryException($"Skill 生命周期状态不正确：{definition.Status}");
        var minimum = SemanticVersion.Parse(definition.CompatibleRuntime.Minimum);
        var maximum = SemanticVersion.Parse(definition.CompatibleRuntime.MaximumExclusive);
        if (minimum.CompareTo(maximum) >= 0 || runtime.CompareTo(minimum) < 0 || runtime.CompareTo(maximum) >= 0)
        {
            throw new SkillRegistryException($"Skill {definition.SkillId}@{definition.SkillVersion} 与运行时 {_options.RuntimeVersion} 不兼容。");
        }
        var moduleDirectory = Path.GetDirectoryName(definitionPath)!;
        var moduleDirectoryName = Path.GetFileName(moduleDirectory);
        var parentDirectoryName = Path.GetFileName(Path.GetDirectoryName(moduleDirectory));
        var singleVersionLayout = string.Equals(moduleDirectoryName, definition.SkillId, StringComparison.Ordinal);
        var multiVersionLayout = string.Equals(moduleDirectoryName, definition.SkillVersion, StringComparison.Ordinal)
            && string.Equals(parentDirectoryName, definition.SkillId, StringComparison.Ordinal);
        if (!singleVersionLayout && !multiVersionLayout)
        {
            throw new SkillRegistryException(
                $"Skill 目录必须使用 <skill_id>/skill.json 或 <skill_id>/<skill_version>/skill.json：{definition.SkillId}@{definition.SkillVersion}");
        }
    }

    private SkillArtifactBundle LoadArtifacts(
        string root,
        string definitionPath,
        SkillDefinitionContract definition,
        byte[] definitionBytes,
        out IReadOnlyDictionary<string, byte[]> artifactBytes)
    {
        var allPaths = new[]
        {
            definition.Artifacts.InstructionsPath
        }
        .Concat(definition.Artifacts.ReferencePaths)
        .Concat(definition.Artifacts.ExamplePaths)
        .Concat(definition.Artifacts.NegativeExamplePaths)
        .ToArray();
        if (allPaths.Length == 0 || allPaths.Length > _options.MaxArtifactCount)
        {
            throw new SkillRegistryException($"Skill {definition.SkillId} 的资源数量超出范围。");
        }
        if (allPaths.Distinct(StringComparer.Ordinal).Count() != allPaths.Length)
        {
            throw new SkillRegistryException($"Skill {definition.SkillId} 包含重复资源路径。");
        }

        var moduleDirectory = Path.GetDirectoryName(definitionPath)!;
        var bytesByPath = new Dictionary<string, byte[]>(StringComparer.Ordinal);
        var textByPath = new Dictionary<string, SkillArtifactText>(StringComparer.Ordinal);
        long totalBytes = definitionBytes.Length;
        foreach (var relativePath in allPaths)
        {
            var path = SkillContentHasher.ResolveArtifactPath(moduleDirectory, relativePath);
            if (!File.Exists(path)) throw new SkillRegistryException($"Skill 资源不存在：{relativePath}");
            var bytes = ReadCheckedFile(root, path);
            if (bytes.Length is <= 0 || bytes.Length > _options.MaxArtifactBytes)
            {
                throw new SkillRegistryException($"Skill 资源大小超出范围：{relativePath}");
            }
            totalBytes += bytes.Length;
            if (totalBytes > _options.MaxBundleBytes)
            {
                throw new SkillRegistryException($"Skill {definition.SkillId} 的资源包超过总大小上限。");
            }
            string content;
            try
            {
                content = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true).GetString(bytes);
            }
            catch (DecoderFallbackException error)
            {
                throw new SkillRegistryException($"Skill 资源必须是有效 UTF-8 文本：{relativePath}", error);
            }
            bytesByPath.Add(relativePath, bytes);
            textByPath.Add(relativePath, new SkillArtifactText(relativePath, content));
        }
        artifactBytes = bytesByPath;
        return new SkillArtifactBundle(
            textByPath[definition.Artifacts.InstructionsPath],
            Array.AsReadOnly(definition.Artifacts.ReferencePaths.Select(path => textByPath[path]).ToArray()),
            Array.AsReadOnly(definition.Artifacts.ExamplePaths.Select(path => textByPath[path]).ToArray()),
            Array.AsReadOnly(definition.Artifacts.NegativeExamplePaths.Select(path => textByPath[path]).ToArray()),
            checked((int)totalBytes));
    }

    private async Task<SkillRegistryStateContract?> LoadStateAsync(CancellationToken cancellationToken)
    {
        var path = ResolveStatePath();
        if (!File.Exists(path)) return null;
        try
        {
            return JsonSerializer.Deserialize<SkillRegistryStateContract>(
                await File.ReadAllTextAsync(path, cancellationToken),
                SceneJson.Provider) ?? throw new JsonException("状态为空");
        }
        catch (JsonException error)
        {
            throw new SkillRegistryException($"Skill 注册表状态无法读取：{path}", error);
        }
    }

    private RegistrySnapshot BuildSnapshot(IReadOnlyDictionary<string, LoadedSkill> definitions, SkillRegistryStateContract? persisted)
    {
        if (persisted is not null && persisted.SchemaVersion is not ("1.0" or "1.1"))
        {
            throw new SkillRegistryException("未知 Skill 注册表状态版本。");
        }
        var statuses = definitions.ToDictionary(value => value.Key, value => value.Value.Definition.Status, StringComparer.Ordinal);
        var active = new Dictionary<string, string>(StringComparer.Ordinal);
        var rollback = new Dictionary<string, string>(StringComparer.Ordinal);
        var enabled = _options.CloudSkillsEnabled;
        var revision = persisted?.Revision ?? 0;
        var auditLog = persisted?.AuditLog ?? [];
        if (persisted is not null
            && (persisted.Statuses is null || persisted.ActiveVersions is null || persisted.RollbackVersions is null))
        {
            throw new SkillRegistryException("Skill 注册表状态缺少必填对象。");
        }
        if (revision < 0
            || auditLog.Count > _options.MaxAuditEntries
            || auditLog.Select(value => value.EventId).Distinct(StringComparer.Ordinal).Count() != auditLog.Count
            || auditLog.Any(value => !AuditEntryIsValid(value))
            || (auditLog.Count == 0 && revision != 0)
            || (auditLog.Count > 0 && auditLog[^1].Revision != revision)
            || auditLog.Zip(auditLog.Skip(1), (before, after) => after.Revision == before.Revision + 1).Any(value => !value))
        {
            throw new SkillRegistryException("Skill 注册表审计状态不正确。");
        }

        if (persisted is null)
        {
            foreach (var definition in definitions.Values.Where(value => value.Definition.Status == "active"))
            {
                if (!active.TryAdd(definition.Definition.SkillId, definition.Definition.SkillVersion))
                {
                    throw new SkillRegistryException($"Skill {definition.Definition.SkillId} 存在多个声明为 active 的版本。");
                }
            }
        }
        else
        {
            enabled = _options.CloudSkillsEnabled && persisted.CloudSkillsEnabled;
            foreach (var (key, status) in persisted.Statuses)
            {
                if (!definitions.ContainsKey(key)) continue;
                if (!Statuses.Contains(status)) throw new SkillRegistryException($"Skill 状态文件包含未知状态：{status}");
                statuses[key] = status;
            }
            foreach (var (skillId, version) in persisted.ActiveVersions)
            {
                var key = Key(skillId, version);
                if (!definitions.ContainsKey(key)) throw new SkillRegistryException($"活动 Skill 版本不存在：{key}");
                active[skillId] = version;
                statuses[key] = "active";
            }
            foreach (var (skillId, version) in persisted.RollbackVersions)
            {
                var key = Key(skillId, version);
                if (!definitions.ContainsKey(key)) continue;
                rollback[skillId] = version;
            }
        }
        return CreateSnapshot(definitions, statuses, active, rollback, enabled, revision, auditLog);
    }

    private RegistrySnapshot CreateSnapshot(
        IReadOnlyDictionary<string, LoadedSkill> definitions,
        IReadOnlyDictionary<string, string> statuses,
        IReadOnlyDictionary<string, string> active,
        IReadOnlyDictionary<string, string> rollback,
        bool enabled,
        long revision,
        IReadOnlyList<SkillRegistryAuditEntry> auditLog)
    {
        var entries = new Dictionary<string, SkillHandle>(StringComparer.Ordinal);
        foreach (var (key, loaded) in definitions)
        {
            var status = statuses[key];
            var isActive = active.TryGetValue(loaded.Definition.SkillId, out var activeVersion)
                && activeVersion == loaded.Definition.SkillVersion;
            if (isActive && status != "active") throw new SkillRegistryException($"活动指针和 Skill 状态不一致：{key}");
            if (!isActive && status == "active") throw new SkillRegistryException($"Skill 状态为 active 但没有活动指针：{key}");
            entries[key] = new SkillHandle(loaded.Definition, loaded.Artifacts, status, isActive);
        }
        foreach (var (skillId, rollbackVersion) in rollback)
        {
            if (active.TryGetValue(skillId, out var activeVersion) && activeVersion == rollbackVersion)
            {
                throw new SkillRegistryException($"Skill {skillId} 的活动与回滚指针不能相同。");
            }
            if (!entries.TryGetValue(Key(skillId, rollbackVersion), out var rollbackTarget)
                || rollbackTarget.EffectiveStatus != "shadow")
            {
                throw new SkillRegistryException($"Skill {skillId} 的回滚目标必须是可用 shadow 版本。");
            }
        }
        return new RegistrySnapshot(entries, new Dictionary<string, string>(active, StringComparer.Ordinal),
            new Dictionary<string, string>(rollback, StringComparer.Ordinal), enabled, revision,
            Array.AsReadOnly(auditLog.ToArray()));
    }

    private static bool AuditEntryIsValid(SkillRegistryAuditEntry entry)
    {
        if (!ActorPattern().IsMatch(entry.EventId)
            || !AuditActions.Contains(entry.Action)
            || entry.Revision <= 0
            || !ActorPattern().IsMatch(entry.Actor)
            || string.IsNullOrWhiteSpace(entry.Reason)
            || entry.Reason.Length is < 8 or > 300
            || string.IsNullOrWhiteSpace(entry.Command)
            || entry.Command.Length > 300
            || entry.OccurredAt > DateTimeOffset.UtcNow.AddMinutes(5))
        {
            return false;
        }

        var hasSkill = entry.SkillId is not null
            && SkillIdPattern().IsMatch(entry.SkillId)
            && entry.SkillVersion is not null
            && SemanticVersionPattern().IsMatch(entry.SkillVersion);
        var hasEvaluation = entry.EvaluationId is not null
            && ActorPattern().IsMatch(entry.EvaluationId)
            && entry.EvaluationReportHash is not null
            && ContentHashPattern().IsMatch(entry.EvaluationReportHash);
        return entry.Action switch
        {
            "shadow" => hasSkill && hasEvaluation
                && entry.FromStatus == "candidate" && entry.ToStatus == "shadow",
            "activate" => hasSkill && hasEvaluation
                && entry.FromStatus == "shadow" && entry.ToStatus == "active",
            "retire" => hasSkill && !hasEvaluation
                && entry.FromStatus is "candidate" or "shadow" && entry.ToStatus == "retired",
            "rollback" => hasSkill && !hasEvaluation
                && entry.FromStatus == "shadow" && entry.ToStatus == "active",
            "disable" or "enable" => !hasSkill && !hasEvaluation
                && entry.FromStatus is null && entry.ToStatus is null,
            _ => false
        };
    }

    private async Task PersistAsync(RegistrySnapshot snapshot, CancellationToken cancellationToken)
    {
        var path = ResolveStatePath();
        Directory.CreateDirectory(Path.GetDirectoryName(path) ?? environment.ContentRootPath);
        var state = new SkillRegistryStateContract(
            "1.1",
            snapshot.CloudSkillsEnabled,
            snapshot.Entries.ToDictionary(value => value.Key, value => value.Value.EffectiveStatus, StringComparer.Ordinal),
            new Dictionary<string, string>(snapshot.ActiveVersions, StringComparer.Ordinal),
            new Dictionary<string, string>(snapshot.RollbackVersions, StringComparer.Ordinal),
            snapshot.Revision,
            snapshot.AuditLog,
            DateTimeOffset.UtcNow);
        var tempPath = $"{path}.{Guid.NewGuid():N}.tmp";
        try
        {
            await File.WriteAllTextAsync(tempPath, JsonSerializer.Serialize(state, SceneJson.Provider), cancellationToken);
            File.Move(tempPath, path, overwrite: true);
        }
        finally
        {
            if (File.Exists(tempPath)) File.Delete(tempPath);
        }
    }

    private string ResolveRootPath() => ResolveConfiguredPath(_options.RootPath, preferOutputDirectory: true);
    private string ResolveStatePath() => ResolveConfiguredPath(_options.StatePath, preferOutputDirectory: false);

    private string ResolveConfiguredPath(string configuredPath, bool preferOutputDirectory)
    {
        if (Path.IsPathRooted(configuredPath)) return Path.GetFullPath(configuredPath);
        var contentPath = Path.GetFullPath(Path.Combine(environment.ContentRootPath, configuredPath));
        var outputPath = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, configuredPath));
        if (preferOutputDirectory && Directory.Exists(outputPath)) return outputPath;
        if (Directory.Exists(contentPath) || File.Exists(contentPath)) return contentPath;
        return preferOutputDirectory ? outputPath : contentPath;
    }

    private static SkillHandle Required(RegistrySnapshot snapshot, string key) =>
        snapshot.Entries.TryGetValue(key, out var handle) ? handle : throw new SkillRegistryException($"Skill 版本不存在：{key}");

    private static SkillHandle RequiredActive(RegistrySnapshot snapshot, string skillId) =>
        snapshot.ActiveVersions.TryGetValue(skillId, out var version)
            ? Required(snapshot, Key(skillId, version))
            : throw new SkillRegistryException($"Skill {skillId} 当前没有活动基线版本。");

    private static string Key(string skillId, string skillVersion) => $"{skillId}@{skillVersion}";

    private static void RejectPathChain(string root, string path)
    {
        var fullRoot = Path.GetFullPath(root);
        var fullPath = Path.GetFullPath(path);
        var relative = Path.GetRelativePath(fullRoot, fullPath);
        if (Path.IsPathRooted(relative)
            || relative == ".."
            || relative.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
            || relative.StartsWith($"..{Path.AltDirectorySeparatorChar}", StringComparison.Ordinal))
        {
            throw new SkillRegistryException($"Skill 路径越出模块根目录：{path}");
        }

        FileSystemInfo current = Directory.Exists(fullPath)
            ? new DirectoryInfo(fullPath)
            : new FileInfo(fullPath);
        while (true)
        {
            current.Refresh();
            if (current.LinkTarget is not null || current.Attributes.HasFlag(FileAttributes.ReparsePoint))
            {
                throw new SkillRegistryException($"Skill 资源不能使用符号链接：{current.FullName}");
            }
            if (string.Equals(current.FullName.TrimEnd(Path.DirectorySeparatorChar), fullRoot.TrimEnd(Path.DirectorySeparatorChar), StringComparison.Ordinal))
            {
                break;
            }
            current = current switch
            {
                FileInfo file => file.Directory ?? throw new SkillRegistryException($"Skill 资源缺少父目录：{path}"),
                DirectoryInfo directory => directory.Parent ?? throw new SkillRegistryException($"Skill 资源缺少父目录：{path}"),
                _ => throw new SkillRegistryException($"Skill 资源类型不受支持：{path}")
            };
        }
    }

    private static byte[] ReadCheckedFile(string root, string path)
    {
        RejectPathChain(root, path);
        var before = new FileInfo(path);
        before.Refresh();
        var expectedLength = before.Length;
        var expectedWriteTime = before.LastWriteTimeUtc;
        byte[] bytes;
        using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            if (stream.Length > int.MaxValue) throw new SkillRegistryException($"Skill 资源过大：{path}");
            bytes = new byte[checked((int)stream.Length)];
            stream.ReadExactly(bytes);
        }
        RejectPathChain(root, path);
        var after = new FileInfo(path);
        after.Refresh();
        if (expectedLength != bytes.Length
            || after.Length != bytes.Length
            || after.LastWriteTimeUtc != expectedWriteTime)
        {
            throw new SkillRegistryException($"Skill 资源在加载期间发生变化：{path}");
        }
        return bytes;
    }

    [GeneratedRegex("^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$")]
    private static partial Regex SkillIdPattern();

    [GeneratedRegex("^[a-zA-Z0-9][a-zA-Z0-9_-]{2,127}$")]
    private static partial Regex ActorPattern();

    [GeneratedRegex("^sha256:[0-9a-f]{64}$")]
    private static partial Regex ContentHashPattern();

    [GeneratedRegex("^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?$")]
    private static partial Regex SemanticVersionPattern();

    private sealed record LoadedSkill(SkillDefinitionContract Definition, SkillArtifactBundle Artifacts);

    private sealed record RegistrySnapshot(
        IReadOnlyDictionary<string, SkillHandle> Entries,
        IReadOnlyDictionary<string, string> ActiveVersions,
        IReadOnlyDictionary<string, string> RollbackVersions,
        bool CloudSkillsEnabled,
        long Revision,
        IReadOnlyList<SkillRegistryAuditEntry> AuditLog)
    {
        public static RegistrySnapshot Empty { get; } = new(
            new Dictionary<string, SkillHandle>(StringComparer.Ordinal),
            new Dictionary<string, string>(StringComparer.Ordinal),
            new Dictionary<string, string>(StringComparer.Ordinal),
            false,
            0,
            []);

        public RegistrySnapshot WithStatus(string key, string status)
        {
            var statuses = Entries.ToDictionary(value => value.Key, value => value.Value.EffectiveStatus, StringComparer.Ordinal);
            statuses[key] = status;
            return WithState(statuses, new Dictionary<string, string>(ActiveVersions, StringComparer.Ordinal),
                new Dictionary<string, string>(RollbackVersions, StringComparer.Ordinal), CloudSkillsEnabled);
        }

        public RegistrySnapshot WithState(
            IReadOnlyDictionary<string, string> statuses,
            IReadOnlyDictionary<string, string> active,
            IReadOnlyDictionary<string, string> rollback,
            bool enabled)
        {
            var entries = Entries.ToDictionary(
                value => value.Key,
                value =>
                {
                    var isActive = active.TryGetValue(value.Value.Definition.SkillId, out var activeVersion)
                        && activeVersion == value.Value.Definition.SkillVersion;
                    return value.Value with { EffectiveStatus = statuses[value.Key], Active = isActive };
                },
                StringComparer.Ordinal);
            return new RegistrySnapshot(entries, new Dictionary<string, string>(active, StringComparer.Ordinal),
                new Dictionary<string, string>(rollback, StringComparer.Ordinal), enabled, Revision, AuditLog);
        }

        public RegistrySnapshot WithAudit(SkillRegistryAuditEntry entry, int maxAuditEntries)
        {
            var audit = AuditLog.Append(entry).TakeLast(maxAuditEntries).ToArray();
            return this with
            {
                Revision = entry.Revision,
                AuditLog = Array.AsReadOnly(audit)
            };
        }
    }

    private sealed record SkillRegistryStateContract(
        string SchemaVersion,
        bool CloudSkillsEnabled,
        Dictionary<string, string> Statuses,
        Dictionary<string, string> ActiveVersions,
        Dictionary<string, string> RollbackVersions,
        long Revision,
        IReadOnlyList<SkillRegistryAuditEntry>? AuditLog,
        DateTimeOffset UpdatedAt);

    private sealed record AuditMutation(
        string Action,
        string? SkillId,
        string? SkillVersion,
        SkillMutationContext Context,
        SkillReleaseProof? Proof);

    private sealed record MutationResult(RegistrySnapshot Snapshot, AuditMutation Audit);
}

public sealed class SkillRegistryException : Exception
{
    public SkillRegistryException(string message) : base(message) { }
    public SkillRegistryException(string message, Exception innerException) : base(message, innerException) { }
}
