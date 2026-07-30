namespace Zhaojian.Api.Contracts;

public sealed record SkillVersionReference(string SchemaId, string Version);
public sealed record SkillRuntimeCompatibility(string Minimum, string MaximumExclusive);
public sealed record SkillProviderRequirements(IReadOnlyList<string> Capabilities, int MinimumContextTokens);
public sealed record SkillTrigger(
    IReadOnlyList<string> TaskTypes,
    IReadOnlyList<string> RequiredInputs,
    IReadOnlyList<string> OptionalContext);
public sealed record SkillArtifacts(
    string InstructionsPath,
    IReadOnlyList<string> ReferencePaths,
    IReadOnlyList<string> ExamplePaths,
    IReadOnlyList<string> NegativeExamplePaths,
    string ValidatorId);

public sealed record SkillDefinitionContract(
    string SchemaVersion,
    string SkillId,
    string SkillVersion,
    string Status,
    string Description,
    SkillTrigger Trigger,
    SkillVersionReference InputSchemaVersion,
    SkillVersionReference OutputSchemaVersion,
    string InstructionVersion,
    string ReferenceVersion,
    string ValidatorVersion,
    string EvaluationSetVersion,
    SkillRuntimeCompatibility CompatibleRuntime,
    SkillProviderRequirements ProviderRequirements,
    SkillArtifacts Artifacts,
    string ContentHash,
    DateTimeOffset CreatedAt);

public sealed record DatasetSplitCounts(int Training, int Regression, int Holdout, int Total);
public sealed record SkillTrainingAssetContract(
    string AssetId,
    Uri SourceUrl,
    Uri DownloadUrl,
    string Author,
    string License,
    Uri LicenseUrl,
    string SourceKind,
    string AllowedUsage,
    string Attribution,
    string SourceFileSha1,
    string ContentHash,
    DateTimeOffset DownloadedAt,
    DateTimeOffset RightsVerifiedAt,
    string PortraitOrPersonalData,
    string PrivacyReview,
    string DerivativePath,
    string DatasetSplit,
    string Category,
    string Status);

public sealed record SkillTrainingDatasetContract(
    string SchemaVersion,
    string DatasetId,
    string DatasetVersion,
    string Description,
    DateTimeOffset CreatedAt,
    string ContentHash,
    DatasetSplitCounts SplitCounts,
    IReadOnlyList<SkillTrainingAssetContract> Assets);

public sealed record VersionedArtifactReference(string Id, string Version, string ContentHash);
public sealed record SkillTrainingSelectionSplitCounts(int Training, int Regression, int Holdout);
public sealed record SkillTrainingSelection(
    string Strategy,
    int SourceAssetCount,
    int SelectedAssetCount,
    IReadOnlyList<string> AssetIds,
    SkillTrainingSelectionSplitCounts SplitCounts,
    string ContentHash);
public sealed record SkillTrainingRunConfiguration(
    string Provider,
    string Model,
    string PromptVersion,
    string SchemaVersion,
    string IndependenceLevel,
    int MaxAttempts,
    int TimeoutMs,
    int Concurrency,
    bool? FailFast,
    int MaxProviderCalls,
    string SelectionHash,
    decimal BudgetLimit,
    string Currency,
    string PricingVersion,
    DateTimeOffset PricingEffectiveAt,
    decimal InputPerMillionCny,
    decimal OutputPerMillionCny,
    decimal MaxCostPerCall,
    Uri? BaseUrl,
    string MockScenarioVersion,
    string ConfigHash);
public sealed record SkillTrainingRunBudget(
    string Currency,
    decimal Limit,
    decimal Reserved,
    int ReservedCalls,
    decimal EstimatedSpend,
    int ProviderCalls,
    int UncertainCalls,
    string PricingVersion,
    DateTimeOffset PricingEffectiveAt,
    decimal InputPerMillionCny,
    decimal OutputPerMillionCny,
    decimal MaxCostPerCall);
public sealed record SkillTrainingRunCounts(
    int Total,
    int Terminal,
    int Completed,
    int Quarantined,
    int Failed,
    int Cancelled);
public sealed record SkillTrainingAttempts(
    int Observer,
    int DirectionGenerator,
    int Critic,
    int RedTeam,
    int Curator);
public sealed record SkillTrainingProviderUsage(
    int PromptTokens,
    int CompletionTokens,
    int Calls,
    decimal EstimatedCost);
public sealed record SkillTrainingRoleArtifact(
    string Role,
    string OutputHash,
    string? OutputPath,
    SkillTrainingProviderUsage Usage,
    string Status);
public sealed record SkillTrainingFinding(
    string Code,
    string Evidence,
    string Role,
    string Severity,
    string ValidationStatus);
public sealed record SkillTrainingArtifactReference(string Path, string ContentHash);
public sealed record SkillTrainingRunError(string Code, string Message, bool Retryable);
public sealed record SkillTrainingCallRecord(
    string CallId,
    string AssetId,
    string Role,
    int Attempt,
    string Status,
    DateTimeOffset StartedAt,
    DateTimeOffset CompletedAt,
    int LatencyMs,
    SkillTrainingProviderUsage Usage,
    SkillTrainingRunError? Error);
public sealed record SkillTrainingRunItem(
    string AssetId,
    string DatasetSplit,
    string State,
    string? CurrentRole,
    SkillTrainingAttempts Attempts,
    IReadOnlyList<SkillTrainingRoleArtifact> RoleArtifacts,
    IReadOnlyList<SkillTrainingFinding> Findings,
    string? Outcome,
    SkillTrainingArtifactReference? Artifact,
    SkillTrainingRunError? LastError,
    DateTimeOffset UpdatedAt);
public sealed record SkillTrainingRunContract(
    string SchemaVersion,
    string RunId,
    string Mode,
    string Status,
    VersionedArtifactReference Dataset,
    SkillTrainingSelection Selection,
    IReadOnlyList<VersionedArtifactReference> Skills,
    SkillTrainingRunConfiguration Configuration,
    SkillTrainingRunBudget Budget,
    IReadOnlyList<SkillTrainingCallRecord> CallRecords,
    SkillTrainingRunCounts Counts,
    IReadOnlyList<SkillTrainingRunItem> Items,
    DateTimeOffset StartedAt,
    DateTimeOffset UpdatedAt,
    DateTimeOffset? CompletedAt,
    string? StopReason,
    string ContentHash);
public sealed record SkillTrainingArtifactRole(
    string Role,
    string OutputHash,
    string ValidationStatus,
    IReadOnlyList<string> EvidenceIds);
public sealed record SkillImprovementCandidate(
    string SkillId,
    string ArtifactType,
    string Summary,
    IReadOnlyList<string> EvidenceIds);
public sealed record SkillTrainingArtifactContract(
    string SchemaVersion,
    string ArtifactId,
    string RunId,
    string AssetId,
    string DatasetSplit,
    string LabelOrigin,
    bool MockOnly,
    bool EligibleForTraining,
    IReadOnlyList<SkillTrainingArtifactRole> RoleArtifacts,
    IReadOnlyList<SkillTrainingFinding> Findings,
    bool ModelDisagreement,
    string Outcome,
    IReadOnlyList<SkillImprovementCandidate> SkillImprovementCandidates,
    string ContentHash);
public sealed record SkillTrainingReportConfiguration(
    string Mode,
    string Provider,
    string Model,
    string PromptVersion,
    string SchemaVersion,
    string IndependenceLevel,
    int MaxAttempts,
    int TimeoutMs,
    int Concurrency,
    bool? FailFast,
    int MaxProviderCalls,
    string SelectionHash,
    string MockScenarioVersion,
    string ConfigHash);
public sealed record SkillRoleRun(
    string Role,
    string Provider,
    string Model,
    string PromptVersion,
    string SchemaVersion,
    string IndependenceLevel,
    int Attempts,
    int ProviderCalls,
    int SuccessfulCalls,
    int FailedCalls,
    int UncertainCalls,
    int PromptTokens,
    int CompletionTokens,
    decimal EstimatedCost,
    int TotalLatencyMs,
    int AverageLatencyMs,
    int MaxLatencyMs,
    string Status);
public sealed record SkillTrainingCounts(int Total, int Completed, int Quarantined, int Failed, int Cancelled);
public sealed record SkillTrainingMetric(
    string Dimension,
    double MeasuredValue,
    double Threshold,
    string Unit,
    bool Passed);
public sealed record SkillTrainingFailure(
    string AssetId,
    string Dimension,
    string Evidence,
    string FailureCode,
    string FailureReason,
    bool? Retryable,
    string Role,
    string ValidationStatus);
public sealed record SkillTrainingTelemetry(
    int ProviderCalls,
    int SuccessfulCalls,
    int FailedCalls,
    int UncertainCalls,
    int PromptTokens,
    int CompletionTokens,
    decimal EstimatedCost,
    int TotalLatencyMs,
    int AverageLatencyMs,
    int MaxLatencyMs);
public sealed record SkillTrainingBudget(
    string Currency,
    decimal Limit,
    decimal EstimatedSpend,
    int ProviderCalls,
    int UncertainCalls,
    string PricingVersion,
    DateTimeOffset PricingEffectiveAt,
    decimal InputPerMillionCny,
    decimal OutputPerMillionCny,
    decimal MaxCostPerCall,
    bool StoppedNewWork,
    string? StopReason);
public sealed record SkillTrainingCheckpoint(
    string RunContentHash,
    int ArtifactCount,
    string ComparableRunKey);

public sealed record SkillTrainingReportContract(
    string SchemaVersion,
    string ReportId,
    string RunId,
    string Status,
    VersionedArtifactReference Dataset,
    SkillTrainingSelection Selection,
    IReadOnlyList<VersionedArtifactReference> Skills,
    SkillTrainingReportConfiguration RunConfiguration,
    IReadOnlyList<SkillRoleRun> RoleRuns,
    SkillTrainingCounts Counts,
    IReadOnlyList<SkillTrainingMetric> Metrics,
    IReadOnlyList<SkillTrainingFailure> Failures,
    SkillTrainingTelemetry Telemetry,
    SkillTrainingBudget Budget,
    SkillTrainingCheckpoint Checkpoint,
    string ValidationStatus,
    DateTimeOffset StartedAt,
    DateTimeOffset CompletedAt,
    string ContentHash);

public sealed record SkillTrainingRoleObservation(
    string EvidenceId,
    string Statement,
    string Confidence,
    string? Uncertainty);
public sealed record SkillTrainingRoleDirection(
    string EvidenceId,
    string Statement,
    string Grounding,
    string Tradeoff);
public sealed record SkillTrainingRoleFinding(
    string Code,
    string Evidence,
    string Severity,
    string ValidationStatus);
public sealed record SkillTrainingDirectionElement(
    string EvidenceId,
    string Label);
public sealed record SkillTrainingStructuredDirectionOption(
    string OptionId,
    IReadOnlyList<SkillTrainingDirectionElement> Elements,
    string Strategy,
    string Variable,
    string Change,
    IReadOnlyList<string> PreserveElementLabels,
    IReadOnlyList<string> WeakenElementLabels,
    string PositionFreedom);
public sealed record SkillTrainingDirectionNoOptions(
    string ReasonCode,
    IReadOnlyList<string> CheckedEvidenceIds);
public sealed record SkillTrainingDirectionDecision(
    string Outcome,
    IReadOnlyList<SkillTrainingStructuredDirectionOption> Options,
    SkillTrainingDirectionNoOptions? NoOptions);
public sealed record SkillTrainingRoleResult(
    string Summary,
    IReadOnlyList<SkillTrainingRoleObservation> Observations,
    IReadOnlyList<SkillTrainingRoleDirection> Directions,
    SkillTrainingDirectionDecision? DirectionDecision,
    IReadOnlyList<SkillTrainingRoleFinding> Findings,
    IReadOnlyList<SkillImprovementCandidate> Candidates);
public sealed record SkillTrainingRoleOutputContract(
    string SchemaVersion,
    string RunId,
    string AssetId,
    string Role,
    int Attempt,
    string Provider,
    string Model,
    SkillTrainingRoleResult Result,
    SkillTrainingProviderUsage Usage,
    DateTimeOffset CreatedAt,
    string ContentHash);

public sealed record SkillEvaluationSource(
    string BaselineReportId,
    string BaselineRunId,
    string BaselineReportHash,
    string CandidateReportId,
    string CandidateRunId,
    string CandidateReportHash,
    string Provider,
    string Model,
    string PromptVersion,
    string SchemaVersion,
    string PricingVersion,
    string EvaluationSetVersion);
public sealed record SkillEvaluationDataset(
    string Id,
    string Version,
    string ContentHash,
    string SelectionHash);
public sealed record SkillEvaluationComparisonConfig(
    string RuntimeVersion,
    decimal MaxCostIncreaseRatio,
    decimal MaxAverageLatencyIncreaseRatio,
    decimal MaxLatencyIncreaseRatio,
    bool RequireAllSplits);
public sealed record SkillEvaluationMetric(
    string Dimension,
    string Direction,
    double BaselineValue,
    double CandidateValue,
    double Delta,
    double Threshold,
    bool Passed);
public sealed record SkillEvaluationSplitResult(
    string Split,
    int AssetCount,
    int BaselineBlockingFailures,
    int CandidateBlockingFailures,
    int NewBlockingFailures,
    bool Passed);
public sealed record SkillEvaluationGate(string Code, bool Passed, string Evidence);
public sealed record SkillEvaluationFailure(
    string Code,
    string Evidence,
    string? AssetId,
    string Rule,
    string BaselineVersion,
    string CandidateVersion);
public sealed record SkillEvaluationTelemetrySnapshot(
    decimal EstimatedCost,
    decimal CostPerSuccessfulCall,
    int AverageLatencyMs,
    int MaxLatencyMs);
public sealed record SkillEvaluationTelemetry(
    SkillEvaluationTelemetrySnapshot Baseline,
    SkillEvaluationTelemetrySnapshot Candidate);
public sealed record SkillEvaluationReportContract(
    string SchemaVersion,
    string EvaluationId,
    string Phase,
    string Status,
    VersionedArtifactReference BaselineSkill,
    VersionedArtifactReference CandidateSkill,
    SkillEvaluationSource Source,
    SkillEvaluationDataset Dataset,
    SkillEvaluationComparisonConfig ComparisonConfig,
    IReadOnlyList<SkillEvaluationMetric> Metrics,
    IReadOnlyList<SkillEvaluationSplitResult> SplitResults,
    IReadOnlyList<SkillEvaluationGate> Gates,
    IReadOnlyList<SkillEvaluationFailure> Failures,
    SkillEvaluationTelemetry Telemetry,
    string? ShadowObservationId,
    bool EligibleForShadow,
    bool EligibleForActivation,
    string Actor,
    string Reason,
    string Command,
    DateTimeOffset EvaluatedAt,
    string ValidationStatus,
    string ContentHash);

public sealed record SkillVersionSnapshot(string SkillId, string SkillVersion, string ContentHash);
public sealed record CreativeIntentGearSnapshot(
    string Id,
    string Name,
    string Camera,
    string Lens,
    double SensorWidth,
    double SensorHeight,
    double CropFactor,
    double FocalMin,
    double FocalMax,
    double MaximumAperture,
    double? MinimumAperture,
    int MinIso,
    int MaxIso);
public sealed record CreativeIntentContract(
    string SchemaVersion,
    string CreativeIntentId,
    IReadOnlyList<string> SubjectRelations,
    IReadOnlyList<string> AttentionPath,
    IReadOnlyList<string> Keep,
    IReadOnlyList<string> Reduce,
    string FramingIntent,
    string? TonalIntent,
    string? ColorIntent,
    string? MotionIntent,
    string? DepthIntent,
    string? TextureIntent,
    IReadOnlyList<string> Uncertainties,
    IReadOnlyList<string> Tradeoffs,
    string SourceAnalysisId,
    string SelectedInterpretationId,
    IReadOnlyList<SkillVersionSnapshot> SkillVersions,
    CreativeIntentGearSnapshot? GearSnapshot,
    DateTimeOffset CreatedAt);

public sealed record FinalPhotoObservationItem(
    string Dimension,
    string Fact,
    string Evidence,
    double Confidence,
    double[]? Region,
    string? Uncertainty);
public sealed record FinalPhotoObservationDraftContract(
    string SchemaVersion,
    string ContractStatus,
    string ObservationId,
    string SourcePhotoId,
    IReadOnlyList<FinalPhotoObservationItem> Observations,
    IReadOnlyList<string> Uncertainties,
    DateTimeOffset CreatedAt);

public sealed record PostProcessAlternative(
    string Id,
    string Intent,
    IReadOnlyList<string> TargetRegions,
    string Rationale,
    IReadOnlyList<string> ExpectedChanges,
    IReadOnlyList<string> Tradeoffs,
    bool Reversible,
    IReadOnlyList<string> Uncertainties);
public sealed record PostProcessPlanDraftContract(
    string SchemaVersion,
    string ContractStatus,
    string PlanId,
    string CreativeIntentId,
    string SourceObservationId,
    IReadOnlyList<PostProcessAlternative> Alternatives,
    DateTimeOffset CreatedAt);
