const test = require("node:test");
const assert = require("node:assert/strict");

const { readConfig } = require("../src/core/config");

test("config reads OpenAI-compatible runtime environment", () => {
  const previousEnv = { ...process.env };
  const previousArgv = process.argv.slice();
  try {
    process.argv = ["node", "cyberboss", "start"];
    process.env.CYBERBOSS_RUNTIME = "openai";
    process.env.CYBERBOSS_OPENAI_BASE_URL = "http://localhost:8132/v1";
    process.env.CYBERBOSS_OPENAI_API_KEY = "secret";
    process.env.CYBERBOSS_OPENAI_MODEL = "gemini-2.5-flash";
    process.env.CYBERBOSS_OPENAI_CONTEXT_WINDOW = "1000000";
    process.env.CYBERBOSS_OPENAI_TIMEOUT_MS = "45000";
    process.env.CYBERBOSS_OPENAI_MAX_TOOL_CALLS = "4";
    process.env.CYBERBOSS_OPENAI_ENABLE_TOOLS = "false";

    const config = readConfig();

    assert.equal(config.runtime, "openai");
    assert.equal(config.openaiBaseUrl, "http://localhost:8132/v1");
    assert.equal(config.openaiApiKey, "secret");
    assert.equal(config.openaiModel, "gemini-2.5-flash");
    assert.equal(config.openaiContextWindow, 1000000);
    assert.equal(config.openaiTimeoutMs, 45000);
    assert.equal(config.openaiMaxToolCalls, 4);
    assert.equal(config.openaiEnableTools, false);
    assert.match(config.openaiThreadsFile, /openai-threads\.json$/);
  } finally {
    process.argv = previousArgv;
    process.env = previousEnv;
  }
});
