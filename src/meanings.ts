/**
 * One neutral sentence per known value of the controller enums the tools
 * show. Paraphrased from ABB's RWS documentation where ABB describes a value;
 * a value ABB names without describing it says so instead of guessing.
 */

export const NOT_KNOWN = 'not a known value';
export const NOT_DESCRIBED = 'ABB does not describe this value; shown as reported.';

export const CTRL_STATE: Record<string, string> = {
  init: 'The controller is starting up. It goes to motors off when it has started.',
  motoroff: 'Motors are off (standby). The robot cannot move until the motors are switched on.',
  motoron: 'Motors are on. The robot can move, by jogging or by a running program.',
  guardstop: 'The robot is stopped because a safety circuit is open, for example a cell door.',
  emergencystop: 'The robot is stopped by an emergency stop.',
  emergencystopreset: 'The emergency stop is no longer active, but leaving the emergency stop state is not confirmed yet.',
  sysfail: 'System failure. The controller needs a restart. The event log says why.',
};

export const OP_MODE: Record<string, string> = {
  AUTO: 'Automatic mode.',
  MANR: 'Manual mode, reduced speed.',
  MANF: 'Manual mode, full speed.',
};

export const COLLISION: Record<string, string> = {
  INIT: NOT_DESCRIBED,
  TRIGGERED: 'Collision detection has triggered.',
  CONFIRMED: NOT_DESCRIBED,
  TRIGGERED_ACK: NOT_DESCRIBED,
};

export const EXEC_STATE: Record<string, string> = {
  running: 'The RAPID program is running.',
  stopped: 'The RAPID program is stopped.',
};

export const CYCLE: Record<string, string> = {
  once: 'The program runs once, then stops.',
  forever: 'The program repeats.',
  oncedone: NOT_DESCRIBED,
  asis: "ABB's \"leave the execution cycle as it is\"; shown as reported.",
};

/** ABB lists these task states (empty, initiated, linked, loaded, uninitialized) without describing them. */
export const TASK_STATE: Record<string, string> = {
  empty: NOT_DESCRIBED,
  initiated: NOT_DESCRIBED,
  linked: NOT_DESCRIBED,
  loaded: NOT_DESCRIBED,
  uninitialized: NOT_DESCRIBED,
  uninitiated: NOT_DESCRIBED,
};

/** The meaning of a value, or "not a known value". A null value means "not read". */
export function meaning(table: Record<string, string>, value: string | null | undefined, caseInsensitive = false): string {
  if (value === null || value === undefined) { return 'not read yet'; }
  if (Object.prototype.hasOwnProperty.call(table, value)) { return table[value]; }
  if (caseInsensitive) {
    const k = Object.keys(table).find(key => key.toLowerCase() === value.toLowerCase());
    if (k) { return table[k]; }
  }
  return NOT_KNOWN;
}

/** The value itself when it is known (safe for fixed text), else null. */
export function knownValue(table: Record<string, string>, value: string | null | undefined): string | null {
  return value !== null && value !== undefined && Object.prototype.hasOwnProperty.call(table, value) ? value : null;
}
