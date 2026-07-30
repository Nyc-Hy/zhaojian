import type { CreativeIntent } from "./skillContracts";

export type Gear = {
  id: string;
  name: string;
  camera: string;
  cameraCatalogId?: string;
  cameraMount?: string;
  cameraSourceUrl?: string;
  cameraSpecsVerifiedAt?: string;
  sensorWidth: number;
  sensorHeight: number;
  cropFactor: number;
  lensName: string;
  focalMin: number;
  focalMax: number;
  aperture: number;
  minimumAperture?: number;
  ibisStops: number;
  tripod: boolean;
  ndStops: number[];
  maxIso: number;
  minIso?: number;
  warnings?: string[];
};

export type Interpretation = {
  id: string;
  title: string;
  intention: string;
  viewing_question: string;
  grounding: { elements: string[]; relationship: string; intent_connection: string };
  visual_strategy: "depth_occlusion" | "scale_context" | "rhythm_line" | "light_color" | "negative_space" | "frame_edge";
  keep: string[];
  reduce: string[];
  view_width: string;
  viewpoint: {
    height: "lower" | "similar" | "higher" | "unknown";
    lateral: "left" | "similar" | "right" | "unknown";
    distance: "closer" | "similar" | "farther" | "unknown";
    orientation: "landscape" | "portrait" | "square" | "keep" | "unknown";
    description: string;
    viewfinder_check: string;
  };
  field_steps: Array<{ action: string; check: string }>;
  framing_plan: string;
  depth_of_field_intent: string;
  motion_intent: string;
  highlight_shadow_intent: string;
  uncertainty: string;
  equivalent_focal_hint_mm?: { min: number; max: number };
  suggested_crop?: [number, number, number, number];
  visual_effect: string;
  tradeoffs: string;
};

export type Analysis = {
  schema_version: "4.2" | "4.3";
  request_id: string;
  outcome: "analysis" | "clarification" | "no_options";
  clarification: null | { question: string; reason: string; options: string[] };
  no_options?: null | { reason: string; evidence: string[]; next_step?: string };
  observations: {
    summary: string;
    attention_candidates: Array<{ label: string; evidence: string; confidence: number; region?: [number, number, number, number] }>;
    visual_relations: Array<{ elements: string[]; relation: string; evidence: string; confidence: number }>;
    uncertainties: string[];
    light: { highlight_risk: string };
  };
  interpretations: Interpretation[];
  technical_observations: { motion: "static" | "subtle" | "significant" | "unknown"; dynamic_range: string; notes?: string[] };
};

export type Note = {
  id: string;
  createdAt: string;
  intent: string;
  gearName: string;
  direction: string;
  focal: string;
  method: string;
  reflection: string;
  creativeIntentId?: string;
  creativeIntent?: CreativeIntent;
  syncStatus?: "pending" | "synced";
  pendingCreativeIntent?: {
    analysisTaskId: string;
    selectedInterpretationId: string;
  };
  thumbnail?: string;
};
