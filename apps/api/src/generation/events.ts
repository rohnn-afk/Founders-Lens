import { setTimeout as delay } from 'node:timers/promises';
import type { Response } from 'express';
import type { Generation } from './contracts.js';

function notification(value: Generation) {
  switch (value.status) {
    case 'COMPLETED':
      if (!value.outputMessageId) throw new Error('Missing committed output');
      return { name: 'generation.completed', data: { status: value.status,
        outputMessageId: value.outputMessageId, selected: value.selected }, terminal: true };
    case 'FAILED':
      return { name: 'generation.failed', data: { status: value.status,
        error: value.error ?? { code: 'GENERATION_FAILED', retryable: false } }, terminal: true };
    case 'CANCELLED':
      return { name: 'generation.cancelled', data: { status: value.status }, terminal: true };
    default:
      return { name: 'generation.status', data: { status: value.status }, terminal: false };
  }
}

/** Observe committed local state without subscribing to or cancelling provider work. */
export async function streamGeneration(response: Response, initial: Generation, read: () => Promise<Generation>) {
  const disconnected = new AbortController();
  const close = () => disconnected.abort();
  response.once('close', close);
  const write = (frame: string) => {
    if (response.destroyed || disconnected.signal.aborted) return false;
    if (Buffer.byteLength(frame) > 16_384 || !response.write(frame)) {
      response.destroy();
      return false;
    }
    return true;
  };
  const emit = (name: string, data: object) => write('event: ' + name + '\ndata: ' + JSON.stringify({
    schemaVersion: 1, generationId: initial.id, emittedAt: new Date().toISOString(), ...data
  }) + '\n\n');
  try {
    if (response.destroyed) return;
    response.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no'
    });
    response.flushHeaders();
    const deadline = performance.now() + 60_000;
    let lastFrame = performance.now();
    let current = initial, previous: Generation['status'] | undefined;
    while (!disconnected.signal.aborted) {
      if (current.status !== previous) {
        const event = notification(current);
        if (!emit(event.name, event.data) || event.terminal) break;
        previous = current.status;
        lastFrame = performance.now();
      } else if (performance.now() - lastFrame >= 15_000) {
        if (!write(': heartbeat\n\n')) break;
        lastFrame = performance.now();
      }
      if (performance.now() >= deadline) break;
      await delay(2_000, undefined, { signal: disconnected.signal });
      if (performance.now() >= deadline || disconnected.signal.aborted) break;
      current = await read();
    }
  } catch {
    if (!disconnected.signal.aborted && response.headersSent) {
      emit('stream.error', { code: 'STREAM_UNAVAILABLE', retryable: true });
    }
  } finally {
    response.off('close', close);
    if (!response.destroyed) response.end();
  }
}
