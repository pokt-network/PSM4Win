export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

export function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

export function fail(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text" as const, text: `error: ${msg}` }], isError: true };
}

export function nowIso(): string {
  return new Date().toISOString();
}
