const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { SessionStore } = require("../codex/session-store");
const { normalizeModelCatalog } = require("../codex/model-catalog");
const { buildOpeningTurnText, buildInstructionRefreshText } = require("../shared-instructions");

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TOOL_CALLS = 6;

function createOpenAiRuntimeAdapter(config, options = {}) {
  const sessionStore = new SessionStore({ filePath: config.sessionsFile, runtimeId: "openai" });
  const threadStore = new OpenAiThreadStore({
    filePath: config.openaiThreadsFile || path.join(config.stateDir, "openai-threads.json"),
  });
  const listeners = new Set();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const toolHost = options.toolHost || null;
  const runtimeId = "openai";
  let readyState = null;
  let resolvedDefaultModel = normalizeText(config.openaiModel);

  function emit(event) {
    for (const listener of listeners) {
      listener(event);
    }
  }

  async function requestChatCompletion({ model, messages, tools }) {
    const baseUrl = normalizeBaseUrl(config.openaiBaseUrl);
    if (!baseUrl) {
      throw new Error("CYBERBOSS_OPENAI_BASE_URL is required when CYBERBOSS_RUNTIME=openai");
    }
    const body = {
      model,
      messages,
      stream: false,
    };
    if (Array.isArray(tools) && tools.length) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    return await fetchOpenAiJson({
      fetchImpl,
      config,
      url: joinOpenAiUrl(baseUrl, "chat/completions"),
      method: "POST",
      body,
      label: "OpenAI chat completion",
    });
  }

  async function completeTurn({ threadId, turnId, workspaceRoot, bindingKey, metadata, model, messages }) {
    const tools = shouldEnableTools(config, toolHost) ? buildOpenAiTools(toolHost) : [];
    let remainingToolCalls = readPositiveInt(config.openaiMaxToolCalls) || DEFAULT_MAX_TOOL_CALLS;
    let lastUsage = null;

    while (true) {
      const response = await requestChatCompletion({ model, messages, tools });
      lastUsage = response?.usage || lastUsage;
      const message = extractAssistantMessage(response);
      if (!message) {
        throw new Error("OpenAI chat completion returned no assistant message");
      }

      const toolCalls = normalizeToolCalls(message.tool_calls);
      if (toolCalls.length && shouldEnableTools(config, toolHost)) {
        if (remainingToolCalls <= 0) {
          throw new Error("OpenAI runtime exceeded CYBERBOSS_OPENAI_MAX_TOOL_CALLS");
        }
        remainingToolCalls -= toolCalls.length;
        messages.push({
          role: "assistant",
          content: normalizeAssistantContent(message.content),
          tool_calls: toolCalls,
        });
        for (const toolCall of toolCalls) {
          const toolResult = await invokeOpenAiTool({
            toolHost,
            toolCall,
            context: {
              runtimeId,
              workspaceRoot,
              threadId,
              bindingKey,
              accountId: normalizeText(metadata.accountId),
              senderId: normalizeText(metadata.senderId),
            },
          });
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            name: toolCall.function.name,
            content: toolResult,
          });
        }
        threadStore.setMessages(threadId, messages, { workspaceRoot });
        continue;
      }

      const text = extractAssistantText(message) || "Completed.";
      messages.push({
        role: "assistant",
        content: text,
      });
      threadStore.setMessages(threadId, messages, { workspaceRoot });
      emitUsageEvent({ emit, runtimeId, threadId, usage: lastUsage, contextWindow: config.openaiContextWindow });
      emit({
        type: "runtime.reply.completed",
        payload: {
          threadId,
          turnId,
          itemId: `item-${turnId}`,
          text,
        },
      });
      emit({
        type: "runtime.turn.completed",
        payload: {
          threadId,
          turnId,
          text,
        },
      });
      return text;
    }
  }

  return {
    describe() {
      return {
        id: runtimeId,
        kind: "runtime",
        endpoint: normalizeBaseUrl(config.openaiBaseUrl) || "(unset)",
        model: resolvedDefaultModel || normalizeText(config.openaiModel),
        sessionsFile: config.sessionsFile,
        threadsFile: config.openaiThreadsFile,
      };
    },
    onEvent(listener) {
      if (typeof listener !== "function") {
        return () => {};
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSessionStore() {
      return sessionStore;
    },
    async initialize() {
      if (readyState) {
        return readyState;
      }
      const baseUrl = normalizeBaseUrl(config.openaiBaseUrl);
      if (!baseUrl) {
        throw new Error("CYBERBOSS_OPENAI_BASE_URL is required when CYBERBOSS_RUNTIME=openai");
      }
      if (!normalizeText(config.openaiApiKey)) {
        throw new Error("CYBERBOSS_OPENAI_API_KEY or OPENAI_API_KEY is required when CYBERBOSS_RUNTIME=openai");
      }
      const models = resolvedDefaultModel
        ? [{ id: resolvedDefaultModel, model: resolvedDefaultModel, isDefault: true }]
        : await listOpenAiModels({ fetchImpl, config, baseUrl }).catch(() => []);
      const normalizedModels = normalizeModelCatalog(models);
      if (normalizedModels.length) {
        sessionStore.setAvailableModelCatalog(normalizedModels);
        if (!resolvedDefaultModel) {
          resolvedDefaultModel = normalizedModels[0].model;
        }
      }
      readyState = {
        endpoint: baseUrl,
        models: normalizedModels,
      };
      return readyState;
    },
    async close() {},
    async startFreshThreadDraft() {
      return {};
    },
    async respondApproval({ requestId }) {
      return { requestId, decision: "accept" };
    },
    async cancelTurn({ threadId, turnId }) {
      return { threadId, turnId };
    },
    async resumeThread({ threadId }) {
      const normalizedThreadId = normalizeText(threadId);
      if (!normalizedThreadId) {
        throw new Error("openai resumeThread requires a threadId");
      }
      threadStore.ensureThread(normalizedThreadId);
      return { threadId: normalizedThreadId };
    },
    async compactThread({ threadId, workspaceRoot, model = "" }) {
      const compactText = [
        "Summarize the existing conversation into durable memory for this WeChat thread.",
        "Keep user preferences, open tasks, reminders, and important timeline facts.",
        "Reply with only the compact summary.",
      ].join("\n");
      const turn = await this.sendTextTurn({
        bindingKey: "",
        workspaceRoot,
        text: compactText,
        model,
        metadata: {},
        explicitThreadId: threadId,
      });
      return turn;
    },
    async refreshThreadInstructions({ threadId, workspaceRoot, model = "" }) {
      return this.sendTextTurn({
        bindingKey: "",
        workspaceRoot,
        text: buildInstructionRefreshText(config),
        model,
        metadata: {},
        explicitThreadId: threadId,
      });
    },
    async sendTextTurn({ bindingKey, workspaceRoot, text, metadata = {}, model = "", explicitThreadId = "" }) {
      await this.initialize();
      const selectedModel = normalizeText(model) || resolvedDefaultModel || normalizeText(config.openaiModel);
      if (!selectedModel) {
        throw new Error("CYBERBOSS_OPENAI_MODEL is required when the OpenAI-compatible API does not return /models");
      }

      let threadId = normalizeText(explicitThreadId) || sessionStore.getThreadIdForWorkspace(bindingKey, workspaceRoot);
      const openingTurn = !threadId;
      if (!threadId) {
        threadId = `openai-${crypto.randomUUID()}`;
        sessionStore.setThreadIdForWorkspace(bindingKey, workspaceRoot, threadId, metadata);
      } else if (bindingKey && workspaceRoot) {
        sessionStore.setThreadIdForWorkspace(bindingKey, workspaceRoot, threadId, metadata);
      }
      const turnId = `turn-${crypto.randomUUID()}`;
      const outboundText = openingTurn ? buildOpeningTurnText(config, text) : String(text || "").trim();
      const messages = threadStore.getMessages(threadId);
      messages.push({
        role: "user",
        content: outboundText,
      });
      threadStore.setMessages(threadId, messages, { workspaceRoot });

      emit({
        type: "runtime.turn.started",
        payload: {
          threadId,
          turnId,
        },
      });

      try {
        await completeTurn({
          threadId,
          turnId,
          workspaceRoot,
          bindingKey,
          metadata,
          model: selectedModel,
          messages,
        });
        return { threadId, turnId };
      } catch (error) {
        emit({
          type: "runtime.turn.failed",
          payload: {
            threadId,
            turnId,
            text: error instanceof Error ? error.message : String(error || "OpenAI runtime failed"),
          },
        });
        throw error;
      }
    },
  };
}

class OpenAiThreadStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.state = { threads: {} };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (parsed && typeof parsed === "object" && parsed.threads && typeof parsed.threads === "object") {
        this.state = { threads: parsed.threads };
      }
    } catch {
      this.state = { threads: {} };
    }
  }

  save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), "utf8");
  }

  ensureThread(threadId) {
    const normalizedThreadId = normalizeText(threadId);
    if (!normalizedThreadId) {
      return null;
    }
    if (!this.state.threads[normalizedThreadId]) {
      this.state.threads[normalizedThreadId] = {
        id: normalizedThreadId,
        messages: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.save();
    }
    return this.state.threads[normalizedThreadId];
  }

  getMessages(threadId) {
    const thread = this.ensureThread(threadId);
    return Array.isArray(thread?.messages)
      ? thread.messages.map((message) => cloneJson(message)).filter(Boolean)
      : [];
  }

  setMessages(threadId, messages, extra = {}) {
    const thread = this.ensureThread(threadId);
    if (!thread) {
      return null;
    }
    thread.messages = Array.isArray(messages)
      ? messages.map((message) => cloneJson(message)).filter(Boolean)
      : [];
    thread.workspaceRoot = normalizeText(extra.workspaceRoot) || normalizeText(thread.workspaceRoot);
    thread.updatedAt = new Date().toISOString();
    this.save();
    return thread;
  }
}

async function listOpenAiModels({ fetchImpl, config, baseUrl }) {
  const parsed = await fetchOpenAiJson({
    fetchImpl,
    config,
    url: joinOpenAiUrl(baseUrl, "models"),
    method: "GET",
    label: "OpenAI model list",
  });
  const data = Array.isArray(parsed?.data) ? parsed.data : [];
  return data.map((model, index) => ({
    id: normalizeText(model?.id) || normalizeText(model?.model),
    model: normalizeText(model?.id) || normalizeText(model?.model),
    displayName: normalizeText(model?.display_name || model?.owned_by),
    isDefault: index === 0,
  })).filter((model) => model.model);
}

async function fetchOpenAiJson({ fetchImpl, config, url, method, body = null, label }) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is not available in this Node.js runtime");
  }
  const controller = new AbortController();
  const timeoutMs = readPositiveInt(config.openaiTimeoutMs) || DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = {
    Authorization: `Bearer ${normalizeText(config.openaiApiKey)}`,
  };
  let requestBody = null;
  if (body != null) {
    requestBody = JSON.stringify(body);
    headers["Content-Type"] = "application/json";
  }

  try {
    const response = await fetchImpl(url, {
      method,
      headers,
      body: requestBody,
      signal: controller.signal,
    });
    const raw = await response.text();
    if (!response.ok) {
      const error = new Error(`${label} http ${response.status}: ${truncate(raw, 1000)}`);
      error.status = response.status;
      error.body = raw;
      throw error;
    }
    try {
      return raw ? JSON.parse(raw) : {};
    } catch {
      throw new Error(`${label} returned invalid JSON: ${truncate(raw, 300)}`);
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function buildOpenAiTools(toolHost) {
  if (!toolHost || typeof toolHost.listTools !== "function") {
    return [];
  }
  return toolHost.listTools()
    .map((tool) => ({
      type: "function",
      function: {
        name: normalizeToolName(tool.name),
        description: normalizeText(tool.description).slice(0, 1024) || normalizeToolName(tool.name),
        parameters: normalizeOpenAiToolSchema(tool.inputSchema),
      },
    }))
    .filter((tool) => tool.function.name);
}

async function invokeOpenAiTool({ toolHost, toolCall, context }) {
  const name = normalizeText(toolCall?.function?.name);
  if (!toolHost || typeof toolHost.invokeTool !== "function" || !name) {
    return "Tool call is not available in this runtime.";
  }
  let args = {};
  try {
    const rawArgs = toolCall?.function?.arguments || "{}";
    args = rawArgs && typeof rawArgs === "string" ? JSON.parse(rawArgs) : {};
  } catch (error) {
    return `Tool input JSON parse failed: ${error.message}`;
  }
  try {
    const result = await toolHost.invokeTool(name, args, context);
    return formatToolResult(result);
  } catch (error) {
    return `Tool ${name} failed: ${error instanceof Error ? error.message : String(error || "unknown error")}`;
  }
}

function extractAssistantMessage(response) {
  const choices = Array.isArray(response?.choices) ? response.choices : [];
  const message = choices[0]?.message;
  return message && typeof message === "object" ? message : null;
}

function extractAssistantText(message) {
  const content = message?.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (typeof item?.text === "string") return item.text;
        if (typeof item?.content === "string") return item.content;
        return "";
      })
      .join("")
      .trim();
  }
  return "";
}

function normalizeAssistantContent(content) {
  if (typeof content === "string") {
    return content;
  }
  const text = extractAssistantText({ content });
  return text || "";
}

function normalizeToolCalls(toolCalls) {
  return Array.isArray(toolCalls)
    ? toolCalls
      .filter((toolCall) => normalizeText(toolCall?.function?.name))
      .map((toolCall) => ({
        id: normalizeText(toolCall.id) || `call-${crypto.randomUUID()}`,
        type: normalizeText(toolCall.type) || "function",
        function: {
          name: normalizeText(toolCall.function.name),
          arguments: typeof toolCall.function.arguments === "string"
            ? toolCall.function.arguments
            : JSON.stringify(toolCall.function.arguments || {}),
        },
      }))
    : [];
}

function emitUsageEvent({ emit, runtimeId, threadId, usage, contextWindow }) {
  const promptTokens = numberOrZero(usage?.prompt_tokens ?? usage?.input_tokens);
  const completionTokens = numberOrZero(usage?.completion_tokens ?? usage?.output_tokens);
  const totalTokens = numberOrZero(usage?.total_tokens) || promptTokens + completionTokens;
  const configuredContextWindow = numberOrZero(contextWindow);
  if (!totalTokens && !configuredContextWindow) {
    return;
  }
  emit({
    type: "runtime.context.updated",
    payload: {
      runtimeId,
      threadId,
      inputTokens: promptTokens,
      outputTokens: completionTokens,
      currentTokens: totalTokens,
      contextWindow: configuredContextWindow,
    },
  });
}

function shouldEnableTools(config, toolHost) {
  return config.openaiEnableTools !== false && Boolean(toolHost && typeof toolHost.listTools === "function");
}

function formatToolResult(result) {
  if (!result || typeof result !== "object") {
    return String(result || "");
  }
  if (result.text && result.data) {
    return `${result.text}\n${JSON.stringify(result.data, null, 2)}`;
  }
  if (result.text) {
    return String(result.text);
  }
  return JSON.stringify(result, null, 2);
}

function normalizeJsonSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {} };
  }
  return cloneJson(schema) || { type: "object", properties: {} };
}

function normalizeOpenAiToolSchema(schema) {
  return stripUnsupportedSchemaKeywords(normalizeJsonSchema(schema));
}

function stripUnsupportedSchemaKeywords(value) {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => stripUnsupportedSchemaKeywords(item));
  }
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "additionalProperties") {
      continue;
    }
    result[key] = stripUnsupportedSchemaKeywords(child);
  }
  return result;
}

function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function normalizeBaseUrl(value) {
  return normalizeText(value).replace(/\/+$/g, "");
}

function joinOpenAiUrl(baseUrl, endpoint) {
  return `${normalizeBaseUrl(baseUrl)}/${String(endpoint || "").replace(/^\/+/g, "")}`;
}

function normalizeToolName(value) {
  return normalizeText(value).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function readPositiveInt(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function numberOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function truncate(value, maxLength) {
  const text = String(value || "");
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`;
}

module.exports = { createOpenAiRuntimeAdapter };
