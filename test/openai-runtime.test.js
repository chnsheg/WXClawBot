const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createOpenAiRuntimeAdapter } = require("../src/adapters/runtime/openai");

function createTempConfig(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-openai-runtime-"));
  return {
    stateDir: dir,
    sessionsFile: path.join(dir, "sessions.json"),
    openaiThreadsFile: path.join(dir, "openai-threads.json"),
    openaiBaseUrl: "https://api.example.test/v1",
    openaiApiKey: "test-key",
    openaiModel: "test-model",
    openaiMaxToolCalls: 3,
    openaiEnableTools: true,
    weixinInstructionsFile: path.join(dir, "weixin-instructions.md"),
    weixinOperationsFile: path.join(dir, "weixin-operations.md"),
    userName: "chensheng",
    ...overrides,
  };
}

test("openai runtime sends chat completions turns and emits runtime events", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    assert.equal(url, "https://api.example.test/v1/chat/completions");
    const body = JSON.parse(options.body);
    assert.equal(body.model, "test-model");
    assert.deepEqual(body.messages.at(-1), {
      role: "user",
      content: "hello",
    });
    return jsonResponse({
      choices: [
        {
          message: {
            role: "assistant",
            content: "hi from openai compatible runtime",
          },
        },
      ],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
      },
    });
  };
  const events = [];
  const adapter = createOpenAiRuntimeAdapter(createTempConfig(), { fetchImpl });
  adapter.onEvent((event) => events.push(event));

  const initialized = await adapter.initialize();
  assert.equal(initialized.endpoint, "https://api.example.test/v1");
  assert.deepEqual(initialized.models.map((model) => model.model), ["test-model"]);

  const turn = await adapter.sendTextTurn({
    bindingKey: "default:account:user",
    workspaceRoot: "C:/project",
    text: "hello",
    metadata: { accountId: "account", senderId: "user" },
  });

  assert.match(turn.threadId, /^openai-/);
  assert.match(turn.turnId, /^turn-/);
  assert.equal(calls.length, 1);
  assert.deepEqual(events.map((event) => event.type), [
    "runtime.turn.started",
    "runtime.context.updated",
    "runtime.reply.completed",
    "runtime.turn.completed",
  ]);
  assert.equal(events[1].payload.runtimeId, "openai");
  assert.equal(events[1].payload.currentTokens, 18);
  assert.equal(events[2].payload.text, "hi from openai compatible runtime");
});

test("openai runtime lists models when no explicit model is configured", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    assert.equal(url, "https://api.example.test/v1/models");
    return jsonResponse({
      data: [
        { id: "listed-model", object: "model" },
        { id: "other-model", object: "model" },
      ],
    });
  };
  const adapter = createOpenAiRuntimeAdapter(createTempConfig({
    openaiModel: "",
  }), { fetchImpl });

  const initialized = await adapter.initialize();

  assert.deepEqual(calls, ["https://api.example.test/v1/models"]);
  assert.deepEqual(initialized.models.map((model) => model.model), ["listed-model", "other-model"]);
});

test("openai runtime executes tool calls through the project tool host", async () => {
  const invoked = [];
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith("/models")) {
      return jsonResponse({ data: [] });
    }
    const body = JSON.parse(options.body);
    if (body.messages.some((message) => message.role === "tool")) {
      return jsonResponse({
        choices: [
          {
            message: {
              role: "assistant",
              content: "tool result delivered",
            },
          },
        ],
      });
    }
    assert.equal(body.tools[0].function.name, "cyberboss_diary_append");
    return jsonResponse({
      choices: [
        {
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: {
                  name: "cyberboss_diary_append",
                  arguments: JSON.stringify({ text: "entry" }),
                },
              },
            ],
          },
        },
      ],
    });
  };
  const toolHost = {
    listTools() {
      return [
        {
          name: "cyberboss_diary_append",
          description: "Append diary.",
          inputSchema: {
            type: "object",
            required: ["text"],
            properties: {
              text: { type: "string" },
            },
            additionalProperties: false,
          },
        },
      ];
    },
    async invokeTool(name, args, context) {
      invoked.push({ name, args, context });
      return { text: "Diary appended." };
    },
  };
  const events = [];
  const adapter = createOpenAiRuntimeAdapter(createTempConfig(), { fetchImpl, toolHost });
  adapter.onEvent((event) => events.push(event));

  await adapter.initialize();
  await adapter.sendTextTurn({
    bindingKey: "default:account:user",
    workspaceRoot: "C:/project",
    text: "write diary",
    metadata: { accountId: "account", senderId: "user" },
  });

  assert.equal(invoked.length, 1);
  assert.deepEqual(invoked[0], {
    name: "cyberboss_diary_append",
    args: { text: "entry" },
    context: {
      runtimeId: "openai",
      workspaceRoot: "C:/project",
      threadId: events[0].payload.threadId,
      bindingKey: "default:account:user",
      accountId: "account",
      senderId: "user",
    },
  });
  assert.equal(events.at(-2).payload.text, "tool result delivered");
});

test("openai runtime strips additionalProperties from tool schemas for compatible gateways", async () => {
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith("/models")) {
      return jsonResponse({ data: [] });
    }
    const body = JSON.parse(options.body);
    const parameters = body.tools[0].function.parameters;
    assert.equal("additionalProperties" in parameters, false);
    assert.equal("additionalProperties" in parameters.properties.items.items, false);
    return jsonResponse({
      choices: [
        {
          message: {
            role: "assistant",
            content: "schema accepted",
          },
        },
      ],
    });
  };
  const toolHost = {
    listTools() {
      return [
        {
          name: "cyberboss_nested_schema",
          description: "Nested schema.",
          inputSchema: {
            type: "object",
            required: ["items"],
            properties: {
              items: {
                type: "array",
                items: {
                  type: "object",
                  required: ["text"],
                  properties: {
                    text: { type: "string" },
                  },
                  additionalProperties: false,
                },
              },
            },
            additionalProperties: false,
          },
        },
      ];
    },
    async invokeTool() {
      throw new Error("should not invoke tools");
    },
  };
  const adapter = createOpenAiRuntimeAdapter(createTempConfig(), { fetchImpl, toolHost });

  await adapter.sendTextTurn({
    bindingKey: "default:account:user",
    workspaceRoot: "C:/project",
    text: "hello",
    metadata: { accountId: "account", senderId: "user" },
  });
});

test("openai runtime surfaces tool payload provider errors while debugging", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith("/models")) {
      return jsonResponse({ data: [] });
    }
    const body = JSON.parse(options.body);
    calls.push(body);
    return jsonResponse({
      error: {
        message: "Internal server error during chat_completion",
      },
    }, 500);
  };
  const toolHost = {
    listTools() {
      return [
        {
          name: "cyberboss_diary_append",
          description: "Append diary.",
          inputSchema: { type: "object", properties: {} },
        },
      ];
    },
    async invokeTool() {},
  };
  const adapter = createOpenAiRuntimeAdapter(createTempConfig(), { fetchImpl, toolHost });

  await assert.rejects(() => adapter.sendTextTurn({
    bindingKey: "default:account:user",
    workspaceRoot: "C:/project",
    text: "hello",
    metadata: { accountId: "account", senderId: "user" },
  }), /OpenAI chat completion http 500/);

  assert.equal(calls.length, 1);
  assert.ok(calls[0].tools);
});

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    async text() {
      return JSON.stringify(body);
    },
    async json() {
      return body;
    },
  };
}
