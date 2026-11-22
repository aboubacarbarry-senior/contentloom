/** Nest injection tokens for the seams the app is wired through. */
export const LLM_CLIENT = Symbol('LLM_CLIENT');
export const JOB_QUEUE = Symbol('JOB_QUEUE');
export const POLICY = Symbol('POLICY');
export const RANDOM = Symbol('RANDOM');
export const CLOCK = Symbol('CLOCK');
export const CONFIG = Symbol('CONFIG');
export const FETCH = Symbol('FETCH');
export const BUDGET = Symbol('BUDGET');
export const LOGGER = Symbol('LOGGER');

/** The subset of `fetch` the webhook dispatcher uses; injectable so tests can fake endpoints. */
export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;
