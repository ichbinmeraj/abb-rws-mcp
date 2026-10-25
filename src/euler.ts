/**
 * Euler angles from a pose quaternion, in the ZYX convention of RAPID's
 * EulerZYX: q = Rz(rz) * Ry(ry) * Rx(rx), angles in degrees. At ry = +-90
 * degrees only rz - rx (or rz + rx) is defined: rx is set to 0 and
 * `gimbalLock` is true.
 */

export interface EulerZyx {
  rx: number;
  ry: number;
  rz: number;
  gimbalLock: boolean;
}

/** How close to +-1 the sine of ry counts as gimbal lock (about 0.08 degrees). */
const LOCK = 1 - 1e-6;

const deg = (r: number): number => Math.round((r * 180 / Math.PI) * 1e4) / 1e4 + 0;

/** Euler angles from q = [w, x, y, z]; null for a quaternion of (near) zero length or with a non-finite part. */
export function eulerZyxFromQuaternion(q: readonly [number, number, number, number]): EulerZyx | null {
  if (!q.every(Number.isFinite)) { return null; }
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  if (n < 1e-9) { return null; }
  const [w, x, y, z] = [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
  const r00 = 1 - 2 * (y * y + z * z);
  const r01 = 2 * (x * y - w * z);
  const r10 = 2 * (x * y + w * z);
  const r11 = 1 - 2 * (x * x + z * z);
  const r20 = 2 * (x * z - w * y);
  const r21 = 2 * (y * z + w * x);
  const r22 = 1 - 2 * (x * x + y * y);
  const s = Math.max(-1, Math.min(1, -r20));
  if (Math.abs(s) >= LOCK) {
    return { rx: 0, ry: s > 0 ? 90 : -90, rz: deg(Math.atan2(-r01, r11)), gimbalLock: true };
  }
  return { rx: deg(Math.atan2(r21, r22)), ry: deg(Math.asin(s)), rz: deg(Math.atan2(r10, r00)), gimbalLock: false };
}

/** The quaternion [w, x, y, z] of Rz(rz) * Ry(ry) * Rx(rx), angles in degrees (tests and round trips). */
export function quaternionFromEulerZyx(rxDeg: number, ryDeg: number, rzDeg: number): [number, number, number, number] {
  const h = Math.PI / 360;
  const cx = Math.cos(rxDeg * h), sx = Math.sin(rxDeg * h);
  const cy = Math.cos(ryDeg * h), sy = Math.sin(ryDeg * h);
  const cz = Math.cos(rzDeg * h), sz = Math.sin(rzDeg * h);
  return [
    cz * cy * cx + sz * sy * sx,
    cz * cy * sx - sz * sy * cx,
    cz * sy * cx + sz * cy * sx,
    sz * cy * cx - cz * sy * sx,
  ];
}
