import {
  mkdirSync, rmSync, rmdirSync, existsSync, lstatSync, symlinkSync, cpSync, readlinkSync, readFileSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveConfig, loadConfig } from './config.js';
import { agentHome, installableTargets } from './targets.js';
import { atomicWrite } from './atomic.js';
import { toPromptFile, isGenerated } from './promptfile.js';

/**
 * Installation, in Node rather than in two shell scripts.
 *
 * This is the single implementation behind both entry points: `agent-memory setup`,
 * and install.sh / install.ps1 which are thin wrappers over it. Writing it once
 * matters because the machine that has to run it is a Windows desktop this was never
 * developed on, and a PowerShell copy of this logic would drift silently.
 *
 * Two formats are written, because the tools disagree about what a skill is. Agent
 * skills are directories containing SKILL.md and get linked. VS Code prompt files are
 * single `<name>.prompt.md` files and get written. Both are derived from the same
 * skills/ directory, so there is still one source of truth.
 */

export const SKILLS = ['handoff', 'recall', 'remember'];

/** Where the packaged skills live, whether installed globally or run from a checkout. */
export function packagedSkillsDir() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'skills');
}

/** Skill directories only. Kept for the dangling-link check and for uninstall. */
export function skillTargets() {
  return installableTargets().filter((t) => t.kind === 'skill-dir').map((t) => t.dir);
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
  if (isLink(path)) {
    try {
      rmSync(path, { force: true });
    } catch {
      // A Windows directory junction reports as a symbolic link but deletes like a
      // directory, and rmSync without `recursive` can reject it as EISDIR. rmdirSync
      // removes the junction itself and never descends, so the skills on the other
      // end stay put — which is exactly what passing `recursive` here would risk.
      rmdirSync(path);
    }
    // `force` tells rmSync to swallow ENOENT, and a junction whose target is gone can
    // answer the stat rmSync makes with ENOENT while the reparse point itself stays on
    // disk. The removal then reports success and changes nothing, after which
    // symlinkSync fails EEXIST and the copy fallback lands on a path that still
    // exists. Checking is what turns that silent no-op into an error naming the path.
    if (isLink(path)) rmdirSync(path);
  } else if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true });
  }
}

/**
 * Decide whether a skill link at a path we manage was put there by this tool.
 *
 * Identity cannot be "points at where we live right now". An install that has since
 * moved, or a checkout that was deleted, leaves a link that test would disown — and a
 * disowned link is unreclaimable: `uninstall` keeps it as "not ours" and `setup`
 * cannot replace what it will not clear, so the user is left holding a broken link
 * that no command in this tool will fix.
 */
function ownsLink(link, name) {
  let dest;
  try {
    dest = resolve(readlinkSync(link));
  } catch {
    // A link sitting at one of our paths whose target cannot even be read is ours to
    // clear. Nothing downstream can use it either.
    return true;
  }
  if (dest === join(packagedSkillsDir(), name)) return true;
  // Dangling. Nothing is lost by reclaiming a link that points nowhere, and leaving it
  // is precisely what deadlocks both commands.
  if (!existsSync(dest)) return true;
  // Live, but pointing into some other agent-memory tree — an older global install, or
  // a checkout the user set up from. The signature is that its parent holds all three
  // of our skills, which a hand-written skill directory would not.
  return SKILLS.every((s) => existsSync(join(dirname(dest), s, 'SKILL.md')));
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
 * Write one skill as a VS Code prompt file.
 *
 * Written rather than linked: prompt files are single files, and a symlinked one is
 * not reliably picked up across VS Code's file watching. The cost is that an upgrade
 * needs `agent-memory setup` re-run, which the installer says out loud.
 */
export function writePromptFile(name, targetDir) {
  const source = join(packagedSkillsDir(), name, 'SKILL.md');
  const dest = join(targetDir, `${name}.prompt.md`);
  mkdirSync(targetDir, { recursive: true });
  atomicWrite(dest, toPromptFile(readFileSync(source, 'utf8'), { name }));
  return { name, path: dest, mode: 'prompt' };
}

/**
 * Skill links whose target no longer exists.
 *
 * npm 7 dropped support for uninstall lifecycle hooks, so `npm uninstall -g` deletes
 * the package and leaves these behind with nothing to clean them up — and by then the
 * binary that would have done it is gone too. Detecting them is the only remedy left,
 * and a broken skill an agent keeps trying to load is worth naming out loud.
 */
export function danglingSkillLinks() {
  const out = [];
  for (const name of SKILLS) {
    for (const dir of skillTargets()) {
      const link = join(dir, name);
      // existsSync follows the link, so a true isLink with a false existsSync is
      // exactly the broken case and nothing else.
      if (isLink(link) && !existsSync(link)) out.push(link);
    }
  }
  return out;
}

/**
 * Remove everything this package installed, in both formats.
 *
 * Only entries that are ours are removed: a skill directory is ours if it resolves
 * back to this package, and a prompt file is ours if it carries the generated marker.
 * Someone may have written their own `recall.prompt.md`, and deleting it because the
 * name matched would be destroying work we were never asked to manage.
 *
 * The store is never touched. Notes are the user's own writing and outlive the tool
 * that indexed them; removing them is a separate, deliberate act.
 */
export function unlinkSkills() {
  const removed = [];
  const kept = [];

  for (const target of installableTargets()) {
    for (const name of SKILLS) {
      if (target.kind === 'skill-dir') {
        const link = join(target.dir, name);
        if (!existsSync(link) && !isLink(link)) continue;
        let owned = false;
        try {
          owned = isLink(link) ? ownsLink(link, name) : existsSync(join(link, 'SKILL.md'));
        } catch {
          // A directory we cannot stat is one we cannot claim. Leave it.
          owned = false;
        }
        if (owned) {
          clear(link);
          removed.push(link);
        } else {
          kept.push(link);
        }
      } else {
        const file = join(target.dir, `${name}.prompt.md`);
        if (!existsSync(file)) continue;
        if (isGenerated(readFileSync(file, 'utf8'))) {
          rmSync(file, { force: true });
          removed.push(file);
        } else {
          kept.push(file);
        }
      }
    }
  }
  return { removed, kept };
}

/**
 * Install into every agent present on this machine, then build the store.
 *
 * Only `recall` is registered for description regeneration. `compact` overwrites the
 * description of every path it is given, and handoff and remember describe
 * themselves; registering all three would replace two good descriptions with a third.
 * Copies and prompt files register their own path, because rewriting the packaged
 * original would never reach them.
 */
export function setup({ compactFn } = {}) {
  const targets = installableTargets();
  const installed = [];
  const copies = [];
  const failed = [];

  for (const target of targets) {
    for (const name of SKILLS) {
      // Isolated per skill. One unwritable target used to abort the whole run and
      // discard the report with it, so a user whose `.copilot` link was wedged got no
      // output at all and no hint that the other eleven had been fine. A failure here
      // is data to print, not a reason to stop.
      try {
        const r =
          target.kind === 'skill-dir'
            ? linkSkill(name, target.dir)
            : writePromptFile(name, target.dir);
        installed.push({ ...r, target: target.id, label: target.label });
        if (r.mode === 'copy') copies.push(r);
      } catch (err) {
        failed.push({
          name,
          target: target.id,
          label: target.label,
          path: join(target.dir, target.kind === 'skill-dir' ? name : `${name}.prompt.md`),
          error: err.message,
        });
      }
    }
  }

  const skillPaths = [
    join(packagedSkillsDir(), 'recall', 'SKILL.md'),
    ...copies.filter((c) => c.name === 'recall').map((c) => join(c.path, 'SKILL.md')),
    ...installed.filter((i) => i.mode === 'prompt' && i.name === 'recall').map((i) => i.path),
  ];
  // Drop registrations whose file is gone before adding the current ones. Renaming
  // the checkout, moving it, or reinstalling under a different prefix each leave a
  // path that no longer resolves, and a union that never prunes keeps it forever --
  // after which compact writes to a file that is not there and doctor reports a
  // failure while naming the path that is fine.
  const existing = (loadConfig().skillPaths || []).filter((p) => existsSync(p));
  saveConfig({ skillPaths: [...new Set([...existing, ...skillPaths])] });

  // compact is passed in so this module does not pull the database into memory just
  // to make some symlinks.
  //
  // Its failure must not sink the run. Linking is already done and written to disk by
  // this point, so throwing here would throw away an accurate report of work that
  // actually happened and leave the user with no idea any of it succeeded. compact
  // touches every registered skill path, which is exactly the set most likely to hold
  // a stale entry, so it is the step most likely to throw.
  let result = null;
  let compactError = null;
  try {
    result = compactFn ? compactFn() : null;
  } catch (err) {
    compactError = err.message;
  }
  return {
    targets,
    installed,
    copies,
    failed,
    compactError,
    skillPaths,
    home: agentHome(),
    digest: result?.digest ?? null,
    notes: result?.indexed ?? 0,
  };
}
