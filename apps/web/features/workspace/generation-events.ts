const terminal = new Map([
  ['event: generation.completed', 'COMPLETED'],
  ['event: generation.failed', 'FAILED'],
  ['event: generation.cancelled', 'CANCELLED']
]);

/** A terminal notification requests canonical status. Stream data never updates the transcript. */
export async function waitForTerminalEvent(body: ReadableStream<Uint8Array>, generationId: string) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const reader = body.getReader();
  let pending = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return false;
      if (chunk.value.byteLength > 65_536) return false;
      pending += decoder.decode(Uint8Array.from(chunk.value), { stream: true });
      let boundary = pending.indexOf('\n\n');
      while (boundary !== -1) {
        if (boundary > 16_384) return false;
        const [event, data, extra] = pending.slice(0, boundary).split('\n');
        pending = pending.slice(boundary + 2);
        if (event === 'event: stream.error') return false;
        const expected = event && terminal.get(event);
        if (expected && data?.startsWith('data: ') && extra === undefined) {
          const value: unknown = JSON.parse(data.slice(6));
          if (value && typeof value === 'object' && 'schemaVersion' in value && value.schemaVersion === 1 &&
            'generationId' in value && value.generationId === generationId &&
            'status' in value && value.status === expected) return true;
        }
        boundary = pending.indexOf('\n\n');
      }
      if (pending.length > 16_384) return false;
    }
  } catch {
    return false;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
