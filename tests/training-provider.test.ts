import { describe, expect, it, vi } from "vitest";
import {
  calculateEstimatedCost,
  createSafeTrainingRepairContext,
  createQwenTrainingProvider,
  qwenTrainingMaxCompletionTokens,
  qwenTrainingMaxImagePixels,
  qwenTrainingMaxTextPayloadBytes,
  renderTrainingDirectionDecision,
  renderTrainingNoOptions,
  validateTrainingRoleResult,
} from "../scripts/training-provider.mjs";

function observerResult() {
  return {
    summary: "记录图片中直接可见的元素与关系；具体证据见 observations。",
    observations: [{
      evidence_id: "obs_fixture_001",
      statement: "较亮区域位于画面右侧。",
      confidence: "medium",
      uncertainty: null,
    }],
    directions: [],
    findings: [],
    candidates: [],
  };
}

function structuredDirectionDecision() {
  return {
    outcome: "options",
    options: [{
      option_id: "direction_fixture_001",
      elements: [
        { evidence_id: "obs_fixture_001", label: "右侧亮区" },
        { evidence_id: "obs_fixture_001", label: "左侧暗部" },
      ],
      strategy: "light_color",
      variable: "tonal_separation",
      change: "compare",
      preserve_element_labels: ["右侧亮区"],
      weaken_element_labels: ["左侧暗部"],
      position_freedom: "same_position",
    }],
    no_options: null,
  };
}

describe("AI Skill Trainer Provider Adapter", () => {
  it("使用 DashScope 兼容接口、强制函数输出并归一化用量", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            tool_calls: [{
              function: {
                name: "submit_training_role_result",
                arguments: JSON.stringify(observerResult()),
              },
            }],
          },
        }],
        usage: { prompt_tokens: 1200, completion_tokens: 180 },
      }),
    }));
    const provider = createQwenTrainingProvider({
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: "test-only-key",
      model: "qwen-test",
      fetchImpl: fetchMock,
    });

    const response = await provider.executeRole({
      role: "observer",
      asset: {
        assetId: "photo-fixture-001",
        category: "landscape_nature",
        mimeType: "image/jpeg",
        bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      },
      previousOutputs: [],
      timeoutMs: 1000,
    });

    expect(response.usage).toEqual({
      prompt_tokens: 1200,
      completion_tokens: 180,
      calls: 1,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
    expect(request.headers.Authorization).toBe("Bearer test-only-key");
    const body = JSON.parse(request.body);
    expect(body.enable_thinking).toBe(false);
    expect(body.max_completion_tokens).toBe(qwenTrainingMaxCompletionTokens);
    expect(body.tools[0].function.parameters.required).toEqual(["summary", "observations"]);
    expect(Object.keys(body.tools[0].function.parameters.properties)).toEqual(["summary", "observations"]);
    expect(body.tools[0].function.parameters.properties.observations.minItems).toBe(1);
    expect(body.tool_choice).toEqual({
      type: "function",
      function: { name: "submit_training_role_result" },
    });
    expect(body.messages[1].content[0].image_url.url).toMatch(/^data:image\/jpeg;base64,/);
    expect(body.messages[1].content[0].max_pixels).toBe(qwenTrainingMaxImagePixels);
    expect(body.messages[1].content[1].text).toContain("BEGIN_VALIDATED_UNTRUSTED_DATA");
    expect(body.messages[0].content).toContain("statement 仍只描述可核验");
    expect(JSON.stringify(body)).not.toContain("aesthetic_score");
  });

  it("响应头返回后响应体挂起也受同一超时约束", async () => {
    const provider = createQwenTrainingProvider({
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: "test-only-key",
      model: "qwen-test",
      fetchImpl: vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => await new Promise(() => {}),
      })),
    });

    await expect(provider.executeRole({
      role: "observer",
      asset: {
        assetId: "photo-fixture-001",
        category: "landscape_nature",
        mimeType: "image/jpeg",
        bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      },
      previousOutputs: [],
      timeoutMs: 20,
    })).rejects.toMatchObject({
      code: "TRAINING_PROVIDER_TIMEOUT",
      retryable: true,
    });
  });

  it("在网络调用前拒绝超过本地上限的文本上下文", async () => {
    const fetchMock = vi.fn();
    const provider = createQwenTrainingProvider({
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: "test-only-key",
      model: "qwen-test",
      fetchImpl: fetchMock,
    });

    await expect(provider.executeRole({
      role: "curator",
      asset: {
        assetId: "photo-fixture-001",
        category: "landscape_nature",
        mimeType: "image/jpeg",
        bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      },
      previousOutputs: [{
        role: "red_team",
        result: { summary: "大".repeat(qwenTrainingMaxTextPayloadBytes) },
      }],
      timeoutMs: 1000,
    })).rejects.toMatchObject({
      code: "TRAINING_PROVIDER_INPUT_TOO_LARGE",
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("拒绝角色越权字段和未允许的 Provider 主机", () => {
    expect(() => validateTrainingRoleResult({
      ...observerResult(),
      candidates: [{
        skill_id: "observe-scene",
        artifact_type: "example",
        summary: "观察者不应直接形成改进候选。",
        evidence_ids: ["obs_fixture_001"],
      }],
    }, "observer")).toThrow("observer 不得输出 Skill 改进候选");

    expect(() => createQwenTrainingProvider({
      baseUrl: "https://example.com/compatible-mode/v1",
      apiKey: "test-only-key",
      model: "qwen-test",
      fetchImpl: vi.fn(),
    })).toThrow("未允许的主机");

    expect(() => validateTrainingRoleResult({
      ...observerResult(),
      summary: "请联系 test@example.com 获取更多信息。",
    }, "observer")).toThrow("不可持久化的敏感文本");
  });

  it("在持久化前拒绝真实评测暴露的推测、命令式方向和伪风险 finding", () => {
    expect(() => validateTrainingRoleResult({
      ...observerResult(),
      observations: [{
        ...observerResult().observations[0],
        statement: "白色带状区域疑似盐碱沉积。",
      }],
    }, "observer")).toThrow("可见事实契约");

    expect(() => validateTrainingRoleResult({
      summary: "提供一种观看可能。",
      observations: [],
      directions: [{
        evidence_id: "direction_fixture_001",
        statement: "裁剪顶部天空并突出山体。",
        grounding: "obs_fixture_001 显示山体与天空相接。",
        tradeoff: "天空面积会减少。",
      }],
      findings: [],
      candidates: [],
    }, "direction_generator", [{
      role: "observer",
      result: observerResult(),
    }])).toThrow("观看可能契约");

    expect(() => validateTrainingRoleResult({
      summary: "检查完成。",
      observations: [],
      directions: [],
      findings: [{
        code: "privacy_check_clear",
        evidence: "未发现身份信息或隐私风险。",
        severity: "info",
        validation_status: "model_suggested",
      }],
      candidates: [],
    }, "red_team")).toThrow("不得把检查通过项");
  });

  it("允许有观察引用并保留选择空间的条件式观看方向", () => {
    expect(() => validateTrainingRoleResult({
      summary: "提供由拍摄者选择的画面关系变化；具体依据与取舍见 directions。",
      observations: [],
      directions: [{
        evidence_id: "direction_fixture_001",
        statement: "若右侧亮区与左侧暗部同时保留时，两者的明暗间隔会更容易比较。",
        grounding: "obs_fixture_001 记录了较亮区域位于画面右侧。",
        tradeoff: "右侧亮区面积增加时，左侧暗部的可见范围会相对减少。",
      }],
      findings: [],
      candidates: [],
    }, "direction_generator", [{
      role: "observer",
      result: observerResult(),
    }])).not.toThrow();
  });

  it("把结构化方向决定确定性渲染为兼容 directions", () => {
    const decision = structuredDirectionDecision();
    const directions = renderTrainingDirectionDecision(decision);
    const result = {
      summary: "根据已校验观察形成结构化观看决定；中文方向由确定性渲染器生成。",
      observations: [],
      directions,
      direction_decision: decision,
      findings: [],
      candidates: [],
    };

    expect(() => validateTrainingRoleResult(result, "direction_generator", [{
      role: "observer",
      result: observerResult(),
    }])).not.toThrow();
    expect(directions).toEqual([{
      evidence_id: "direction_fixture_001",
      statement: "若在不改变机位的前提下让「右侧亮区」与「左侧暗部」的明暗分离在两种状态之间比较时，可比较明暗与色彩关系。",
      grounding: "依据 obs_fixture_001，可核对「右侧亮区」与「左侧暗部」及其可见关系。",
      tradeoff: "这一比较会保留「右侧亮区」，同时可能弱化「左侧暗部」；是否采用由拍摄者决定。",
    }]);
  });

  it("没有观察支持的弱化对象时保留空数组并诚实渲染", () => {
    const decision = structuredDirectionDecision();
    decision.options[0].weaken_element_labels = [];
    const directions = renderTrainingDirectionDecision(decision);
    const result = {
      summary: "根据已校验观察形成结构化观看决定；中文方向由确定性渲染器生成。",
      observations: [],
      directions,
      direction_decision: decision,
      findings: [],
      candidates: [],
    };

    expect(() => validateTrainingRoleResult(result, "direction_generator", [{
      role: "observer",
      result: observerResult(),
    }])).not.toThrow();
    expect(directions[0].tradeoff).toBe(
      "这一比较会保留「右侧亮区」，当前不预设会弱化的元素；是否采用由拍摄者决定。",
    );
  });

  it.each([
    "最佳构图",
    "50mm 焦段",
    "右侧亮区。",
    " 右侧亮区",
    "右侧亮区 ",
    "右侧：亮区",
    "右侧\n亮区",
    "右侧{亮区}",
  ])("统一拒绝不安全的方向元素标签：%s", (unsafeLabel) => {
    const decision = structuredDirectionDecision();
    decision.options[0].elements[0].label = unsafeLabel;
    decision.options[0].preserve_element_labels = [unsafeLabel];
    const result = {
      summary: "根据已校验观察形成结构化观看决定；中文方向由确定性渲染器生成。",
      observations: [],
      directions: renderTrainingDirectionDecision(decision),
      direction_decision: decision,
      findings: [],
      candidates: [],
    };

    expect(() => validateTrainingRoleResult(result, "direction_generator", [{
      role: "observer",
      result: observerResult(),
    }])).toThrow();
  });

  it("接受显式 no_options 且不由过滤器伪造方向", () => {
    const decision = {
      outcome: "no_options",
      options: [],
      no_options: {
        reason_code: "insufficient_distinct_relationships",
        checked_evidence_ids: ["obs_fixture_001"],
      },
    };
    const result = {
      summary: "根据已校验观察形成结构化观看决定；中文方向由确定性渲染器生成。",
      observations: [],
      directions: [],
      direction_decision: decision,
      findings: [],
      candidates: [],
    };

    expect(() => validateTrainingRoleResult(result, "direction_generator", [{
      role: "observer",
      result: observerResult(),
    }])).not.toThrow();
    expect(renderTrainingNoOptions(decision)).toEqual({
      reason_code: "insufficient_distinct_relationships",
      reason: "现有观察还不能形成彼此不同的观看可能",
      checked_evidence_ids: ["obs_fixture_001"],
    });
  });

  it("安全修复上下文只保留枚举原因与观察证据", () => {
    const context = createSafeTrainingRepairContext({
      error: Object.assign(new Error("原始脏文本不应进入修复上下文。"), {
        code: "TRAINING_PROVIDER_INVALID_OUTPUT",
      }),
      role: "direction_generator",
      previousAttempt: 1,
      previousOutputs: [{ role: "observer", result: observerResult() }],
      excludedCandidateCount: 2,
    });

    expect(context).toEqual({
      schema_version: "1.0",
      reason_code: "all_direction_options_excluded",
      role: "direction_generator",
      previous_attempt: 1,
      allowed_evidence_ids: ["obs_fixture_001"],
      excluded_candidate_count: 2,
    });
    expect(JSON.stringify(context)).not.toContain("原始脏文本");
  });

  it("真实方向请求只暴露结构化决定并携带白名单修复上下文", async () => {
    const providerDecision = structuredDirectionDecision();
    providerDecision.options[0].strategy = "provider_invented_strategy";
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            tool_calls: [{
              function: {
                name: "submit_training_role_result",
                arguments: JSON.stringify({
                  summary: "供应商摘要不会直接进入面向人的方向。",
                  direction_decision: providerDecision,
                }),
              },
            }],
          },
        }],
        usage: { prompt_tokens: 800, completion_tokens: 120 },
      }),
    }));
    const provider = createQwenTrainingProvider({
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: "test-only-key",
      model: "qwen-test",
      fetchImpl: fetchMock,
    });
    const repairContext = {
      schema_version: "1.0",
      reason_code: "direction_contract_invalid",
      role: "direction_generator",
      previous_attempt: 1,
      allowed_evidence_ids: ["obs_fixture_001"],
      excluded_candidate_count: 0,
    };

    const response = await provider.executeRole({
      role: "direction_generator",
      asset: {
        assetId: "photo-fixture-001",
        category: "landscape_nature",
        mimeType: "image/jpeg",
        bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      },
      previousOutputs: [{ role: "observer", result: observerResult() }],
      timeoutMs: 1000,
      attempt: 2,
      repairContext,
    });

    expect(response.result.directions).toEqual(
      renderTrainingDirectionDecision(structuredDirectionDecision()),
    );
    expect(response.result.direction_decision.options[0].strategy).toBe("light_color");
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody.tools[0].function.parameters.required).toEqual([
      "summary",
      "direction_decision",
    ]);
    expect(Object.keys(requestBody.tools[0].function.parameters.properties)).toEqual([
      "summary",
      "direction_decision",
    ]);
    expect(requestBody.tools[0].function.parameters.properties.direction_decision).toMatchObject({
      $ref: "#/$defs/directionDecision",
    });
    const directionOptionSchema =
      requestBody.tools[0].function.parameters.$defs.structuredDirectionOption;
    expect(directionOptionSchema.required).not.toContain("strategy");
    expect(directionOptionSchema.properties).not.toHaveProperty("strategy");
    expect(directionOptionSchema.properties.weaken_element_labels.minItems).toBe(0);
    expect(requestBody.tools[0].function.parameters.$defs.directionElement
      .properties.label.$ref).toBe("#/$defs/directionLabel");
    expect(requestBody.tools[0].function.parameters.$defs.directionLabel).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: 40,
    });
    expect(directionOptionSchema.properties.preserve_element_labels.items.$ref)
      .toBe("#/$defs/directionLabel");
    expect(directionOptionSchema.properties.weaken_element_labels.items.$ref)
      .toBe("#/$defs/directionLabel");
    expect(requestBody.messages[1].content).toContain(
      "\"reason_code\":\"direction_contract_invalid\"",
    );
    expect(requestBody.messages[1].content).not.toContain("原始脏文本");
  });

  it("不会用策略派生掩盖非法可见变量", async () => {
    const providerDecision = structuredDirectionDecision();
    providerDecision.options[0].strategy = "provider_invented_strategy";
    providerDecision.options[0].variable = "provider_invented_variable";
    const provider = createQwenTrainingProvider({
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: "test-only-key",
      model: "qwen-test",
      fetchImpl: vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              tool_calls: [{
                function: {
                  name: "submit_training_role_result",
                  arguments: JSON.stringify({
                    summary: "供应商摘要不会直接进入面向人的方向。",
                    direction_decision: providerDecision,
                  }),
                },
              }],
            },
          }],
          usage: { prompt_tokens: 800, completion_tokens: 120 },
        }),
      })),
    });

    await expect(provider.executeRole({
      role: "direction_generator",
      asset: {
        assetId: "photo-fixture-001",
        category: "landscape_nature",
        mimeType: "image/jpeg",
        bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      },
      previousOutputs: [{ role: "observer", result: observerResult() }],
      timeoutMs: 1000,
    })).rejects.toMatchObject({
      code: "TRAINING_PROVIDER_INVALID_OUTPUT",
      usage: { prompt_tokens: 800, completion_tokens: 120, calls: 1 },
    });
  });

  it("只把二次 JSON 编码的完整方向对象做传输层解码", async () => {
    const decision = structuredDirectionDecision();
    const provider = createQwenTrainingProvider({
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: "test-only-key",
      model: "qwen-test",
      fetchImpl: vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              tool_calls: [{
                function: {
                  name: "submit_training_role_result",
                  arguments: JSON.stringify({
                    summary: "供应商摘要不会直接进入面向人的方向。",
                    direction_decision: JSON.stringify(decision),
                  }),
                },
              }],
            },
          }],
          usage: { prompt_tokens: 800, completion_tokens: 120 },
        }),
      })),
    });

    const response = await provider.executeRole({
      role: "direction_generator",
      asset: {
        assetId: "photo-fixture-001",
        category: "landscape_nature",
        mimeType: "image/jpeg",
        bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      },
      previousOutputs: [{ role: "observer", result: observerResult() }],
      timeoutMs: 1000,
    });

    expect(response.result.direction_decision).toEqual(decision);
    expect(response.result.directions).toEqual(renderTrainingDirectionDecision(decision));
  });

  it("不把普通自由文本伪装成结构化方向", async () => {
    const provider = createQwenTrainingProvider({
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: "test-only-key",
      model: "qwen-test",
      fetchImpl: vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              tool_calls: [{
                function: {
                  name: "submit_training_role_result",
                  arguments: JSON.stringify({
                    summary: "供应商摘要不会直接进入面向人的方向。",
                    direction_decision: "请把亮区放在三分线，这是最佳构图。",
                  }),
                },
              }],
            },
          }],
          usage: { prompt_tokens: 800, completion_tokens: 120 },
        }),
      })),
    });

    await expect(provider.executeRole({
      role: "direction_generator",
      asset: {
        assetId: "photo-fixture-001",
        category: "landscape_nature",
        mimeType: "image/jpeg",
        bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      },
      previousOutputs: [{ role: "observer", result: observerResult() }],
      timeoutMs: 1000,
    })).rejects.toMatchObject({
      code: "TRAINING_PROVIDER_INVALID_OUTPUT",
      usage: { prompt_tokens: 800, completion_tokens: 120, calls: 1 },
    });
  });

  it("角色门禁失败时保留 Provider 已返回的可信用量", async () => {
    const invalidObserverResult = {
      ...observerResult(),
      observations: [],
    };
    const provider = createQwenTrainingProvider({
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: "test-only-key",
      model: "qwen-test",
      fetchImpl: vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              tool_calls: [{
                function: {
                  name: "submit_training_role_result",
                  arguments: JSON.stringify(invalidObserverResult),
                },
              }],
            },
          }],
          usage: { prompt_tokens: 1200, completion_tokens: 180 },
        }),
      })),
    });

    await expect(provider.executeRole({
      role: "observer",
      asset: {
        assetId: "photo-fixture-001",
        category: "landscape_nature",
        mimeType: "image/jpeg",
        bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      },
      previousOutputs: [],
      timeoutMs: 1000,
    })).rejects.toMatchObject({
      code: "TRAINING_PROVIDER_INVALID_OUTPUT",
      usage: {
        prompt_tokens: 1200,
        completion_tokens: 180,
        calls: 1,
      },
    });
  });

  it("丢弃供应商非本角色的公共字段，并规范旧版策展候选类型", async () => {
    const responses = [
      {
        summary: observerResult().summary,
        observations: [
          ...observerResult().observations,
          {
            evidence_id: "obs_fixture_002",
            statement: "白色区域疑似盐碱沉积。",
            confidence: "low",
            uncertainty: "图片无法确认物质类别。",
          },
        ],
        directions: { unexpected: "供应商格式漂移" },
        findings: "供应商格式漂移",
        candidates: null,
      },
      {
        summary: "整理经过证据支持的校验候选。",
        candidates: [{
          skill_id: "composition-relations",
          artifact_type: "constraint",
          summary: "检查方向是否保留选择空间。",
          evidence_ids: ["obs_fixture_001"],
        }],
      },
    ];
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            tool_calls: [{
              function: {
                name: "submit_training_role_result",
                arguments: JSON.stringify(responses.shift()),
              },
            }],
          },
        }],
        usage: { prompt_tokens: 1200, completion_tokens: 180 },
      }),
    }));
    const provider = createQwenTrainingProvider({
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: "test-only-key",
      model: "qwen-test",
      fetchImpl: fetchMock,
    });
    const request = {
      asset: {
        assetId: "photo-fixture-001",
        category: "landscape_nature",
        mimeType: "image/jpeg",
        bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      },
      previousOutputs: [],
      timeoutMs: 1000,
    };

    const observer = await provider.executeRole({ ...request, role: "observer" });
    expect(observer.result.summary).toBe(
      "记录图片中直接可见的元素与关系；具体证据见 observations。",
    );
    expect(observer.result.directions).toEqual([]);
    expect(observer.result.findings).toEqual([]);
    expect(observer.result.candidates).toEqual([]);
    expect(observer.result.observations).toHaveLength(1);
    expect(observer.policyExclusions).toEqual([{
      code: "deterministic_observation_exclusion",
      evidence: "确定性可见事实门禁排除 1 条观察候选；其余条目继续接受角色审查。",
    }]);

    const curator = await provider.executeRole({ ...request, role: "curator" });
    expect(curator.result.candidates[0].artifact_type).toBe("validator");
  });

  it("原子级排除受污染方向并保留同轮有证据的条件式方向", async () => {
    const provider = createQwenTrainingProvider({
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: "test-only-key",
      model: "qwen-test",
      fetchImpl: vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              tool_calls: [{
                function: {
                  name: "submit_training_role_result",
                  arguments: JSON.stringify({
                    summary: "供应商自由摘要会被确定性替换。",
                    directions: [
                      {
                        evidence_id: "direction_fixture_001",
                        statement: "若右侧亮区面积变化时，可检查它与左侧暗部的间隔。",
                        grounding: "obs_fixture_001 记录了较亮区域位于画面右侧。",
                        tradeoff: "右侧亮区面积增加时，左侧暗部的可见范围会相对减少。",
                      },
                      {
                        evidence_id: "direction_fixture_002",
                        statement: "若上下元素间距缩小时，可检查两者的接近程度。",
                        grounding: "obs_fixture_001 记录了右侧亮区的位置。",
                        tradeoff: "间距缩小会带来压迫感。",
                      },
                    ],
                  }),
                },
              }],
            },
          }],
          usage: { prompt_tokens: 1200, completion_tokens: 180 },
        }),
      })),
    });

    const response = await provider.executeRole({
      role: "direction_generator",
      asset: {
        assetId: "photo-fixture-001",
        category: "landscape_nature",
        mimeType: "image/jpeg",
        bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      },
      previousOutputs: [{ role: "observer", result: observerResult() }],
      timeoutMs: 1000,
    });

    expect(response.result.directions).toHaveLength(1);
    expect(response.result.directions[0].evidence_id).toBe("direction_fixture_001");
    expect(response.policyExclusions).toEqual([{
      code: "deterministic_direction_exclusion",
      evidence: "确定性观看边界门禁排除 1 条方向候选；其余条目继续接受角色审查。",
    }]);
  });

  it("使用显式计价快照计算六位小数估算费用", () => {
    expect(calculateEstimatedCost(
      { prompt_tokens: 1250, completion_tokens: 500, calls: 1 },
      { inputPerMillion: 2, outputPerMillion: 8 },
    )).toBe(0.0065);
  });

  it("拒绝缺失 Token 用量，避免按零费用放行", async () => {
    const provider = createQwenTrainingProvider({
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey: "test-only-key",
      model: "qwen-test",
      fetchImpl: vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              tool_calls: [{
                function: {
                  name: "submit_training_role_result",
                  arguments: JSON.stringify(observerResult()),
                },
              }],
            },
          }],
        }),
      })),
    });

    await expect(provider.executeRole({
      role: "observer",
      asset: {
        assetId: "photo-fixture-001",
        category: "landscape_nature",
        mimeType: "image/jpeg",
        bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      },
      previousOutputs: [],
      timeoutMs: 1000,
    })).rejects.toMatchObject({
      code: "TRAINING_PROVIDER_INVALID_USAGE",
      retryable: true,
    });
  });
});
