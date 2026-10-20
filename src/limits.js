export const REQUEST_TIMEOUT_MS = 3000;

/** Live repo runs that take longer than this fall back to the last good result. */
export const DEMO_RUN_BUDGET_MS = Number(process.env.DEMO_RUN_BUDGET_MS) || 45_000;

export const LLM_TIMEOUT_MS = 8000;
