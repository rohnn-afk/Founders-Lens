// Route-scoped generation use case. Owns polling, cancellation and replay
// keys while the view and injected transport own rendering and HTTP decoding.
import type { Generation, GenerationApi, GenerationReply, GenerationState, Scope } from './contracts';

export const observationPolicy = { initialMs: 1000, maximumMs: 5000, windowMs: 60_000 } as const;
export function isTerminal(state: GenerationState) {
  return state === 'COMPLETED' || state === 'FAILED' || state === 'CANCELLED';
}
type Intent = { kind: 'cancel' | 'regenerate'; target: string; key: string };
export type GenerationView = {
  value?: Generation;
  observation: 'idle' | 'observing' | 'paused' | 'blocked';
  command?: 'sending' | 'unknown' | 'rejected';
  intent?: Intent['kind'];
};

export function createGenerationController(api: GenerationApi, scope: Scope, conversationId: string,
  current: (scope: Scope) => boolean, changed: (state: GenerationView) => void, refreshTranscript: () => void,
  invalidateSession: () => void, { now = Date.now, key = () => crypto.randomUUID(),
    schedule = setTimeout, cancelTimer = clearTimeout } = {}) {
  let view: GenerationView = { observation: 'idle' };
  let id: string | undefined, intent: Intent | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline = 0, backoff: number = observationPolicy.initialMs;
  let read: AbortController | undefined, command: AbortController | undefined;
  let stream: AbortController | undefined;
  let readTimeout: ReturnType<typeof setTimeout> | undefined, commandTimeout: ReturnType<typeof setTimeout> | undefined;
  let resume = false;
  let disposed = false;
  const live = () => !disposed && current(scope) && !scope.signal.aborted;
  function update(next: GenerationView) {
    if (!live()) return;
    view = next;
    changed(next);
  }
  function clearTimer() { cancelTimer(timer); timer = undefined; }
  function stop() {
    disposed = true;
    intent = undefined;
    clearTimer();
    cancelTimer(readTimeout);
    cancelTimer(commandTimeout);
    read?.abort();
    stream?.abort();
    command?.abort();
    scope.signal.removeEventListener('abort', stop);
  }
  scope.signal.addEventListener('abort', stop, { once: true });

  function blocked(reply: GenerationReply) {
    if (reply.status === 401 || reply.status === 403) {
      invalidateSession();
      stop();
      return true;
    }
    if (reply.status === 404 || reply.status === 503) {
      clearTimer();
      stream?.abort();
      update({ observation: 'blocked', ...(intent && { intent: intent.kind, command: 'unknown' }) });
      return true;
    }
    return false;
  }

  function pause() {
    stream?.abort();
    if (view.observation !== 'blocked') update({ ...view, observation: 'paused' });
  }

  function later(retryAfterMs?: number) {
    const requested = Number.isFinite(retryAfterMs) && retryAfterMs! >= 0 ? retryAfterMs! : 0;
    const delay = Math.max(backoff, requested);
    backoff = Math.min(backoff * 2, observationPolicy.maximumMs);
    if (delay >= deadline - now()) {
      pause();
      return;
    }
    timer = schedule(() => { timer = undefined; void poll(); }, delay);
  }

  async function poll() {
    if (!live() || !id || read || command) return;
    if (now() >= deadline) { pause(); return; }
    const target = id;
    const request = new AbortController();
    read = request;
    // Bound a hanging fetch too, rather than letting it hold the observer.
    readTimeout = schedule(() => {
      request.abort();
      if (read === request && live()) pause();
    }, deadline - now());
    try {
      const reply = await api.status(target, request.signal);
      if (!live() || request.signal.aborted || id !== target || command) return;
      if (blocked(reply)) return;
      if (reply.status === 200 && reply.data.id === target && reply.data.conversationId === conversationId) {
        const terminal = isTerminal(reply.data.status);
        if (terminal) stream?.abort();
        const refresh = view.observation === 'blocked' || (terminal && view.value?.status !== reply.data.status);
        update({ ...view, value: reply.data, observation: terminal ? 'idle' : 'observing' });
        if (refresh) refreshTranscript();
        if (!terminal) later();
      } else {
        later('retryAfterMs' in reply ? reply.retryAfterMs : undefined);
      }
    } catch {
      if (live() && !request.signal.aborted && !command && id === target) later();
    } finally {
      cancelTimer(readTimeout);
      readTimeout = undefined;
      if (read === request) read = undefined;
      // A new target may have replaced this one while its transport was aborting.
      if (live() && !command && (resume || id !== target) && view.observation === 'observing') {
        resume = false;
        void poll();
      }
    }
  }

  function observe(target = id) {
    if (!live() || !target || command) return;
    if (target === id && (read || timer !== undefined)) return;
    clearTimer();
    if (target !== id) {
      read?.abort();
      stream?.abort();
      id = target;
      update({ observation: 'observing' });
    } else if (view.observation !== 'blocked') update({ ...view, observation: 'observing' });
    deadline = now() + observationPolicy.windowMs;
    backoff = observationPolicy.initialMs;
    if (api.watchTerminal && (!stream || stream.signal.aborted)) {
      const observer = new AbortController();
      stream = observer;
      void api.watchTerminal(target, observer.signal).then(terminal => {
        if (!terminal || !live() || observer.signal.aborted || id !== target || read || command) return;
        clearTimer();
        void poll();
      }).catch(() => { /* Polling continues when the stream is unavailable. */ })
        .finally(() => { if (stream === observer) stream = undefined; });
    }
    void poll();
  }

  async function send(kind: Intent['kind'], target: string) {
    const invoke = kind === 'cancel' ? api.cancel?.bind(api, target) : api.regenerate?.bind(api, conversationId, target);
    if (!invoke) return;
    if (!live() || command || (intent && (intent.kind !== kind || intent.target !== target))) return;
    intent ??= { kind, target, key: key() };
    const frozen = intent;
    clearTimer();
    read?.abort();
    stream?.abort();
    const request = new AbortController();
    command = request;
    commandTimeout = schedule(() => {
      request.abort();
      if (live() && command === request) update({ ...view, command: 'unknown', intent: kind });
    }, observationPolicy.windowMs);
    update({ ...view, command: 'sending', intent: kind });
    let follow: string | undefined;
    try {
      const reply = await invoke(frozen.key, request.signal);
      if (!live() || request.signal.aborted || blocked(reply)) return;
      if ((reply.status === 200 || reply.status === 202) && reply.data.conversationId === conversationId &&
        (kind === 'cancel' ? reply.data.id === target : reply.data.triggerMessageId === target && reply.status === 202)) {
        const previous = view.value;
        // A keyed replay can return its original acceptance after GET has
        // already observed a later state. Keep that state for the same attempt.
        const preserve = previous?.id === reply.data.id &&
          (kind === 'regenerate' || isTerminal(previous.status));
        const value = preserve ? previous : reply.data;
        const refresh = view.observation === 'blocked' || (!preserve && isTerminal(value.status));
        intent = undefined;
        id = reply.data.id;
        update({ value, observation: 'idle' });
        if (refresh) refreshTranscript();
        follow = reply.data.id;
      } else if ([400, 409, 413, 415].includes(reply.status)) {
        intent = undefined;
        update({ ...view, command: 'rejected', intent: kind });
        follow = id;
      } else update({ ...view, command: 'unknown', intent: kind });
    } catch {
      if (live() && !request.signal.aborted) update({ ...view, command: 'unknown', intent: kind });
    } finally {
      cancelTimer(commandTimeout);
      commandTimeout = undefined;
      command = undefined;
      if (follow && live()) {
        // An aborted status may still be settling. Resume only once it exits.
        if (read) {
          deadline = now() + observationPolicy.windowMs;
          update({ ...view, observation: 'observing' });
          resume = true;
        } else observe(follow);
      }
    }
  }

  return { observe, stop, cancel: () => id && send('cancel', id),
    regenerate: (trigger: string) => send('regenerate', trigger),
    retry: () => intent && send(intent.kind, intent.target) };
}
