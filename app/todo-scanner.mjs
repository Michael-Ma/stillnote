// Finds the todos in meetings, one at a time, behind the user's back: it holds no lock on the AI,
// so Enhance and Chat are never told to wait for it. Everything it touches is passed in.
import { parseTodoResponse, proposedTodos, todoInstructions, todoRequest } from './todos.mjs';

export function todoScanner({
  store,
  respond,
  recordingMeeting,
  onChange,
  onError,
  limit = 300000,
}) {
  let queue = [];
  let running = null;
  let controller = null;
  let progress = { done: 0, total: 0 };

  const state = () => ({
    running: !!running,
    meetingId: controller?.meetingId ?? null,
    ...progress,
  });

  async function scan(id) {
    let meeting;
    try {
      meeting = store.get(id);
    } catch {
      return;
    }
    if (meeting.deletedAt || recordingMeeting() === id) return;
    const names = store.settings().myNames ?? '';
    let request;
    try {
      request = todoRequest(meeting, names);
    } catch {
      return store.failTodoScan(id);
    }
    const current = new AbortController();
    current.meetingId = id;
    controller = current;
    onChange();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      current.abort();
    }, limit);
    let answer;
    try {
      answer = await respond({
        instructions: todoInstructions,
        input: [{ role: 'user', content: request }],
        signal: current.signal,
      });
    } catch (error) {
      if (current.signal.aborted && !timedOut) return;
      // The account or the plan said no, and would say no to every meeting after this one.
      queue = [];
      onError(timedOut ? 'Finding todos timed out after 5 minutes.' : error.message);
      return store.failTodoScan(id);
    } finally {
      clearTimeout(timeout);
      controller = null;
    }
    try {
      store.saveTodoScan(id, proposedTodos(meeting, parseTodoResponse(answer), names));
    } catch {
      // This answer was unusable; the meeting stays due and the next one may be fine.
      store.failTodoScan(id);
    }
  }

  async function drain() {
    while (queue.length) {
      await scan(queue.shift());
      progress.done++;
      onChange();
    }
    running = null;
    progress = { done: 0, total: 0 };
    onChange();
  }

  return {
    state,
    add(ids) {
      const waiting = new Set([...queue, ...(controller ? [controller.meetingId] : [])]);
      const fresh = [...new Set(ids)].filter((id) => !waiting.has(id));
      if (!fresh.length) return state();
      queue.push(...fresh);
      progress.total += fresh.length;
      running ??= Promise.resolve().then(drain);
      return state();
    },
    // Scans already saved stay saved; the rest can be started again later.
    cancel() {
      queue = [];
      controller?.abort();
      return running;
    },
  };
}
