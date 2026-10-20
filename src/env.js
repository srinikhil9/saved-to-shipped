export const XAI_BASE_URL = "https://api.x.ai/v1";
export const DEFAULT_GROK_MODEL = "grok-4.7";

const SAFE_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SHELL",
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT",
];

const SECRET = /(key|token|secret|password|credential|passwd|auth|cookie|session)/i;

export function llmSettings(source = process.env) {
  return {
    apiKey: source.XAI_API_KEY || "",
    baseUrl: XAI_BASE_URL,
    model: source.XAI_MODEL || DEFAULT_GROK_MODEL,
  };
}

/** Environment for child processes. API keys and other secrets stay out. */
export function sanitizedEnv(source = process.env) {
  const env = {};
  for (const key of SAFE_KEYS) {
    const value = source[key];
    if (typeof value === "string" && value && !SECRET.test(key)) env[key] = value;
  }
  return env;
}
