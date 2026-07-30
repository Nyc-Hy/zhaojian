export type SemanticVersion = `${number}.${number}.${number}` | `${number}.${number}.${number}-${string}`;
export type ContentHash = `sha256:${string}`;

export type SkillStatus = "draft" | "candidate" | "shadow" | "active" | "retired";
export type SkillVersionReference = {
  schema_id: string;
  version: SemanticVersion;
};

export type SkillDefinition = {
  schema_version: "1.0";
  skill_id: string;
  skill_version: SemanticVersion;
  status: SkillStatus;
  description: string;
  trigger: {
    task_types: string[];
    required_inputs: string[];
    optional_context: string[];
  };
  input_schema_version: SkillVersionReference;
  output_schema_version: SkillVersionReference;
  instruction_version: SemanticVersion;
  reference_version: SemanticVersion;
  validator_version: SemanticVersion;
  evaluation_set_version: SemanticVersion;
  compatible_runtime: {
    minimum: SemanticVersion;
    maximum_exclusive: SemanticVersion;
  };
  provider_requirements: {
    capabilities: Array<"vision" | "text" | "structured_output" | "tool_calling">;
    minimum_context_tokens: number;
  };
  artifacts: {
    instructions_path: string;
    reference_paths: string[];
    example_paths: string[];
    negative_example_paths: string[];
    validator_id: string;
  };
  content_hash: ContentHash;
  created_at: string;
};

export type DatasetSplit = "training" | "regression" | "holdout";
export type SkillTrainingAsset = {
  asset_id: string;
  source_url: string;
  author: string;
  license: string;
  license_url: string;
  allowed_usage: "training" | "evaluation" | "training_and_evaluation";
  attribution: string;
  content_hash: ContentHash;
  downloaded_at: string;
  portrait_or_personal_data: "none" | "person_visible" | "potential_sensitive";
  dataset_split: DatasetSplit;
  category: "landscape_nature" | "urban_everyday" | "environmental_portrait" | "ordinary_difficult";
  status: "approved" | "quarantined" | "retired";
};

export type SkillTrainingDataset = {
  schema_version: "1.0";
  dataset_id: string;
  dataset_version: SemanticVersion;
  description: string;
  created_at: string;
  content_hash: ContentHash;
  split_counts: Record<DatasetSplit | "total", number>;
  assets: SkillTrainingAsset[];
};

export type SkillTrainerRole = "observer" | "direction_generator" | "critic" | "red_team" | "curator";
export type VersionedArtifactReference = {
  id: string;
  version: SemanticVersion;
  content_hash: ContentHash;
};

export type SkillTrainingSelection = {
  strategy: "all" | "explicit_asset_ids";
  source_asset_count: number;
  selected_asset_count: number;
  asset_ids: string[];
  split_counts: Record<DatasetSplit, number>;
  content_hash: ContentHash;
};

export type SkillTrainingTelemetry = {
  provider_calls: number;
  successful_calls: number;
  failed_calls?: number;
  uncertain_calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  estimated_cost: number;
  total_latency_ms: number;
  average_latency_ms: number;
  max_latency_ms: number;
};

export type SkillTrainingReport = {
  schema_version: "1.3" | "1.4" | "1.5";
  report_id: string;
  run_id: string;
  status: "completed" | "rejected" | "cancelled" | "failed";
  dataset: VersionedArtifactReference;
  selection: SkillTrainingSelection;
  skills: VersionedArtifactReference[];
  run_configuration: {
    mode: "mock" | "live";
    provider: string;
    model: string;
    prompt_version: SemanticVersion;
    schema_version: SemanticVersion;
    independence_level: "mock_fixture" | "same_model_different_roles" | "cross_model";
    max_attempts: number;
    timeout_ms: number;
    concurrency: number;
    max_provider_calls: number;
    selection_hash: ContentHash;
    mock_scenario_version: SemanticVersion;
    config_hash: ContentHash;
  };
  role_runs: Array<{
    role: SkillTrainerRole;
    provider: string;
    model: string;
    prompt_version: SemanticVersion;
    schema_version: SemanticVersion;
    independence_level: "mock_fixture" | "same_model_different_roles" | "cross_model";
    attempts: number;
    status: "completed" | "partial" | "failed" | "cancelled";
  } & SkillTrainingTelemetry>;
  counts: {
    total: number;
    completed: number;
    quarantined: number;
    failed: number;
    cancelled: number;
  };
  metrics: Array<{
    dimension:
      | "json_parse_rate"
      | "serious_hallucination_rate"
      | "intent_response_rate"
      | "direction_difference_rate"
      | "grounding_rate"
      | "clarification_effectiveness_rate"
      | "field_executability_rate"
      | "gear_feasibility_rate"
      | "judge_language_rate";
    measured_value: number;
    threshold: number;
    unit: "ratio";
    passed: boolean;
  }>;
  failures: Array<{
    asset_id: string;
    dimension: string;
    evidence: string;
    failure_code: string;
    failure_reason: string;
    retryable: boolean | null;
    role: SkillTrainerRole | "deterministic_gate";
    validation_status: "model_suggested" | "confirmed_by_gate" | "disputed" | "quarantined";
  }>;
  telemetry: SkillTrainingTelemetry;
  budget: {
    currency: "CNY";
    limit: number;
    estimated_spend: number;
    provider_calls: number;
    uncertain_calls: number;
    pricing_version: string;
    pricing_effective_at: string;
    input_per_million_cny: number;
    output_per_million_cny: number;
    max_cost_per_call: number;
    stopped_new_work: boolean;
    stop_reason: "budget_exhausted" | "provider_call_limit_reached" | "cancelled" | "fatal_error" | null;
  };
  checkpoint: {
    run_content_hash: ContentHash;
    artifact_count: number;
    comparable_run_key: ContentHash;
  };
  validation_status: "passed" | "failed" | "needs_review";
  started_at: string;
  completed_at: string;
  content_hash: ContentHash;
};

export type SkillEvaluationReport = {
  schema_version: "1.0";
  evaluation_id: string;
  phase: "candidate" | "shadow";
  status: "passed" | "blocked";
  baseline_skill: VersionedArtifactReference;
  candidate_skill: VersionedArtifactReference;
  source: {
    baseline_report_id: string;
    baseline_run_id: string;
    baseline_report_hash: ContentHash;
    candidate_report_id: string;
    candidate_run_id: string;
    candidate_report_hash: ContentHash;
    provider: string;
    model: string;
    prompt_version: SemanticVersion;
    schema_version: SemanticVersion;
    pricing_version: string;
    evaluation_set_version: SemanticVersion;
  };
  dataset: VersionedArtifactReference & { selection_hash: ContentHash };
  comparison_config: {
    runtime_version: SemanticVersion;
    max_cost_increase_ratio: number;
    max_average_latency_increase_ratio: number;
    max_latency_increase_ratio: number;
    require_all_splits: true;
  };
  metrics: Array<{
    dimension: SkillTrainingReport["metrics"][number]["dimension"];
    direction: "higher" | "lower";
    baseline_value: number;
    candidate_value: number;
    delta: number;
    threshold: number;
    passed: boolean;
  }>;
  split_results: Array<{
    split: "training" | "regression" | "holdout";
    asset_count: number;
    baseline_blocking_failures: number;
    candidate_blocking_failures: number;
    new_blocking_failures: number;
    passed: boolean;
  }>;
  gates: Array<{
    code:
      | "provenance_complete"
      | "dataset_comparable"
      | "skill_content_integrity"
      | "historical_compatibility"
      | "fixed_regression"
      | "holdout_regression"
      | "serious_failure_regression"
      | "cost_limit"
      | "latency_limit"
      | "rollback_ready"
      | "shadow_observation";
    passed: boolean;
    evidence: string;
  }>;
  failures: Array<{
    code: string;
    evidence: string;
    asset_id: string | null;
    rule: string;
    baseline_version: SemanticVersion;
    candidate_version: SemanticVersion;
  }>;
  telemetry: {
    baseline: {
      estimated_cost: number;
      cost_per_successful_call: number;
      average_latency_ms: number;
      max_latency_ms: number;
    };
    candidate: {
      estimated_cost: number;
      cost_per_successful_call: number;
      average_latency_ms: number;
      max_latency_ms: number;
    };
  };
  shadow_observation_id: string | null;
  eligible_for_shadow: boolean;
  eligible_for_activation: boolean;
  actor: string;
  reason: string;
  command: string;
  evaluated_at: string;
  validation_status: "passed" | "failed";
  content_hash: ContentHash;
};

export type SkillVersionSnapshot = {
  skill_id: string;
  skill_version: SemanticVersion;
  content_hash: ContentHash;
};

export type CreativeIntentGearSnapshot = {
  id: string;
  name: string;
  camera: string;
  lens: string;
  sensor_width: number;
  sensor_height: number;
  crop_factor: number;
  focal_min: number;
  focal_max: number;
  maximum_aperture: number;
  minimum_aperture: number | null;
  min_iso: number;
  max_iso: number;
};

export type CreativeIntent = {
  schema_version: "1.0";
  creative_intent_id: string;
  subject_relations: string[];
  attention_path: string[];
  keep: string[];
  reduce: string[];
  framing_intent: string;
  tonal_intent: string | null;
  color_intent: string | null;
  motion_intent: string | null;
  depth_intent: string | null;
  texture_intent: string | null;
  uncertainties: string[];
  tradeoffs: string[];
  source_analysis_id: string;
  selected_interpretation_id: string;
  skill_versions: SkillVersionSnapshot[];
  gear_snapshot: CreativeIntentGearSnapshot | null;
  created_at: string;
};

export type FinalPhotoObservationDraft = {
  schema_version: "0.1";
  contract_status: "draft";
  observation_id: string;
  source_photo_id: string;
  observations: Array<{
    dimension:
      | "subject_relation"
      | "attention_path"
      | "framing"
      | "tone"
      | "color"
      | "motion"
      | "depth"
      | "texture"
      | "visible_artifact";
    fact: string;
    evidence: string;
    confidence: number;
    region?: [number, number, number, number];
    uncertainty?: string;
  }>;
  uncertainties: string[];
  created_at: string;
};

export type PostProcessPlanDraft = {
  schema_version: "0.1";
  contract_status: "draft";
  plan_id: string;
  creative_intent_id: string;
  source_observation_id: string;
  alternatives: Array<{
    id: string;
    intent: string;
    target_regions: string[];
    rationale: string;
    expected_changes: string[];
    tradeoffs: string[];
    reversible: true;
    uncertainties: string[];
  }>;
  created_at: string;
};
