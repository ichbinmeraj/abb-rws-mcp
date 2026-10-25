import { ModuleCache } from '../cache.js';
import { cleanDeep } from '../clean.js';
import type { Context } from '../context.js';
import { RAPID_NAME, answerError } from '../daemon.js';
import { ToolError, errors } from '../errors.js';
import { ModuleSource, parseAnswer, type Task } from '../schema.js';
import { limitedRead, type ReadBudget, type Scoped } from './common.js';

/**
 * A module's text, from this server's cache or from one daemon read (which
 * reaches the controller, on the daemon's read budget and on this server's
 * own limit). Checks the snapshot's lists first: a task or a module the
 * snapshot does not list is NOT_FOUND, and no controller read is spent.
 */

export interface ModuleText {
  task: string;
  module: string;
  text: string;
  kind: string | null;
  changeCount: number | null;
  readAt: number;
  fromCache: boolean;
}

export function findTask(s: Scoped, task: string): Task | null {
  const want = task.toLowerCase();
  return s.snap.rapid.tasks.find(t => t.name.toLowerCase() === want) ?? null;
}

/** `budget`, when given, counts the requests this read sends (see limitedRead); a cache hit or a NOT_FOUND from the lists sends none. */
export async function readModule(ctx: Context, s: Scoped, taskName: string, moduleName: string, budget?: ReadBudget): Promise<ModuleText> {
  const tasks = s.snap.rapid.tasks;
  const task = findTask(s, taskName);
  if (!task && tasks.length > 0) {
    throw errors.notFound('task', cleanDeep({ tasks: tasks.map(t => t.name) }));
  }
  let module = moduleName;
  if (task && task.modules.length > 0) {
    const listed = task.modules.find(m => m.toLowerCase() === moduleName.toLowerCase());
    if (!listed) { throw errors.notFound('module', cleanDeep({ task: task.name, modules: task.modules.slice(0, 200) })); }
    if (RAPID_NAME.test(listed)) { module = listed; }
  }
  const requestTask = task && RAPID_NAME.test(task.name) ? task.name : taskName;
  const key = ModuleCache.key(s.id, s.ready.health.startedAt, requestTask, module);
  const sig = ModuleCache.listSig(task?.modules ?? []);
  const hit = ctx.cache.get(key, sig);
  if (hit) { return { task: requestTask, module, ...hit, fromCache: true }; }

  const ans = await limitedRead(ctx, s.id, () => ctx.daemon.get('module', { id: s.id, task: requestTask, module }), budget);
  if (ans.status === 200) {
    const src = parseAnswer(ModuleSource, ans.body, 'module');
    const value = {
      text: src.text.replace(/\r\n/g, '\n'),
      kind: src.kind === 'program' || src.kind === 'system' ? src.kind : null,
      changeCount: typeof src.changeCount === 'number' && Number.isFinite(src.changeCount) ? src.changeCount : null,
      readAt: ctx.now(),
    };
    ctx.cache.set(key, sig, value);
    return { task: requestTask, module, ...value, fromCache: false };
  }
  const e: ToolError = answerError(ans, s.ready.ids);
  if (e.code === 'NOT_FOUND') {
    throw errors.notFound('task or module', task ? cleanDeep({ task: task.name, modules: task.modules.slice(0, 200) }) : undefined);
  }
  throw e;
}

/** The routines a module declares: PROC, FUNC (with its return type) and TRAP, LOCAL or not. */
export function declaredRoutines(lines: readonly string[]): { name: string; start: number; end: number | null }[] {
  const found: { name: string; start: number; end: number | null }[] = [];
  const head = /^\s*(?:LOCAL\s+)?(?:(PROC|TRAP)\s+([A-Za-z][A-Za-z0-9_]*)|(FUNC)\s+[A-Za-z][A-Za-z0-9_]*\s+([A-Za-z][A-Za-z0-9_]*))/i;
  const tail = /^\s*END(PROC|FUNC|TRAP)\b/i;
  let open: { name: string; start: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const h = head.exec(lines[i]);
    if (h) {
      if (open) { found.push({ name: open.name, start: open.start, end: null }); }
      open = { name: h[2] ?? h[4], start: i + 1 };
      continue;
    }
    if (open && tail.test(lines[i])) {
      found.push({ name: open.name, start: open.start, end: i + 1 });
      open = null;
    }
  }
  if (open) { found.push({ name: open.name, start: open.start, end: null }); }
  return found;
}
