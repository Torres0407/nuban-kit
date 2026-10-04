import { expect } from 'vitest';

export interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

export type Responder = Response | Error | ((call: RecordedCall) => Response | Promise<Response>);

/**
 * A fetch mock that serves queued responses in order and records every call.
 * No network is ever touched; running out of queued responses fails the test.
 */
export function mockFetch(...queue: Responder[]): { fetch: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const impl: typeof fetch = async (input, init) => {
    const call = { url: String(input), init };
    calls.push(call);
    const next = queue.shift();
    if (next === undefined) throw new Error('mockFetch: no response queued');
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(call) : next;
  };
  return { fetch: impl, calls };
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function text(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

/** Await a promise that must reject with `ctor`, and return the error for further assertions. */
export async function expectRejection<E extends Error>(
  promise: Promise<unknown>,
  ctor: new (...args: never[]) => E,
): Promise<E> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ctor);
  return caught as E;
}

export function headerOf(call: RecordedCall | undefined, name: string): string | undefined {
  const headers = call?.init?.headers as Record<string, string> | undefined;
  return headers?.[name];
}

/** A responder that never answers; it rejects only when the request is aborted (like real fetch). */
export const hangUntilAborted: Responder = ({ init }) =>
  new Promise<Response>((_, reject) => {
    const signal = init?.signal;
    signal?.addEventListener('abort', () => reject(signal.reason ?? new DOMException('aborted', 'AbortError')), { once: true });
  });

export const sleepNow = async (): Promise<void> => undefined;
