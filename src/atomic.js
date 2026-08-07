import { writeFileSync, renameSync, rmSync } from 'node:fs';

/**
 * Write a file atomically.
 *
 * Deliberately dependency-free and importing nothing from this package: store.js
 * already imports config.js, so putting this in either would make a cycle.
 *
 * Two properties matter, and both come from the same failure.
 *
 * The temp name is unique per process and per call. A fixed `<target>.tmp` looks
 * atomic and is not: two processes writing the same file collide on that one path,
 * so A writes tmp, B overwrites tmp, A renames and publishes B's bytes, then B
 * renames and fails ENOENT. Two windows open at once is the normal working mode
 * here, so that is the common case rather than an exotic one.
 *
 * The rename is retried briefly. On Windows a rename fails with EPERM or EBUSY when
 * anything else holds the destination open for even a moment, and on a managed
 * desktop that something is usually the antivirus scanner reading the file we just
 * wrote. Retrying turns a hard failure into a pause nobody notices.
 */

const RETRIES = 5;
const BACKOFF_MS = 20;

let counter = 0;

function sleep(ms) {
  // Synchronous by design. Every caller sits inside a synchronous write path, and
  // making them all async to absorb an antivirus hiccup is a poor trade.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function tempName(target) {
  counter += 1;
  return `${target}.${process.pid}.${counter}.tmp`;
}

export function atomicWrite(target, contents) {
  const tmp = tempName(target);
  writeFileSync(tmp, contents, 'utf8');
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, target);
      return target;
    } catch (err) {
      const transient = err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES';
      if (!transient || attempt >= RETRIES) {
        // Never leave the temp file behind; a stray file under notes/ would be
        // scanned on the next index run.
        rmSync(tmp, { force: true });
        throw err;
      }
      sleep(BACKOFF_MS * (attempt + 1));
    }
  }
}
