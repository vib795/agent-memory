import { mkdirSync, rmSync, existsSync, lstatSync, symlinkSync, cpSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { saveConfig, loadConfig } from './config.js';

/**
 * Skill installation, in Node rather than in two shell scripts.
 *
 * This is the single implementation behind three entry points: `npm install` via
 * postinstall, `agent-memory setup`, and install.sh / install.ps1. Writing it once
 * matters because the machine that has to run it is a Windows desktop this was never
 * developed on, and a PowerShell copy of this logic would drift silently.
 */

export const SKILLS = ['handoff', 'recall', 'remember'];

/** Where the packaged skills live, whether installed globally or run from a checkout. */
export function packagedSkillsDir() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'skills');
}

/**
 * The agent skill directories.
 *
 * Windows profiles are USERPROFILE, not HOME. AGENT_MEMORY_SKILLS_HOME exists so a
 * test can point this at something disposable instead of the real profile.
 */
export function skillTargets() {
  const home = process.env.AGENT_MEMORY_SKILLS_HOME || process.env.USERPROFILE || homedir();
  return [join(home, '.agents', 'skills'), join(home, '.claude', 'skills')];
}

function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function clear(path) {
  // A stale symlink must be removed as a link rather than followed, or clearing it
  // would delete the packaged skills on the other end.
  if (isLink(path)) rmSync(path, { force: true });
  else if (existsSync(path)) rmSync(path, { recursive: true, force: true });
}

/**
 * Link one skill into one agent directory.
 *
 * 'junction' makes a directory junction on Windows, which needs neither admin rights
 * nor Developer Mode, and is ignored on POSIX where an ordinary symlink is made.
 * Junctions still fail on a network-backed profile (FSLogix, roaming), so there is a
 * copy fallback and the caller is told which one it got.
 */
export function linkSkill(name, targetDir) {
  const source = join(packagedSkillsDir(), name);
  const link = join(targetDir, name);
  mkdirSync(targetDir, { recursive: true });
  clear(link);
  try {
    symlinkSync(source, link, 'junction');
    return { name, path: link, mode: 'link' };
  } catch (err) {
    cpSync(source, link, { recursive: true });
    return { name, path: link, mode: 'copy', reason: err.message };
  }
}

/**
 * Link every skill, register the one whose description is generated, build the store.
 *
 * Only `recall` is registered. `compact` overwrites the description of every path it
 * is given, and handoff and remember describe themselves; registering all three would
 * replace two good descriptions with a third.
 *
 * A copied skill registers its copy too, because rewriting the packaged original
 * would never reach it.
 */
export function setup({ compactFn } = {}) {
  const installed = [];
  const copies = [];
  for (const name of SKILLS) {
    for (const dir of skillTargets()) {
      const r = linkSkill(name, dir);
      installed.push(r);
      if (r.mode === 'copy') copies.push(r);
    }
  }

  const skillPaths = [
    join(packagedSkillsDir(), 'recall', 'SKILL.md'),
    ...copies.filter((c) => c.name === 'recall').map((c) => join(c.path, 'SKILL.md')),
  ];
  const existing = loadConfig().skillPaths || [];
  saveConfig({ skillPaths: [...new Set([...existing, ...skillPaths])] });

  // compact is passed in so this module does not pull the database, and the whole
  // npm postinstall path with it, into memory just to make some symlinks.
  const result = compactFn ? compactFn() : null;
  return {
    installed,
    copies,
    skillPaths,
    digest: result?.digest ?? null,
    notes: result?.indexed ?? 0,
  };
}
