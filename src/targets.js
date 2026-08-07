import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';

/**
 * Where the agents on this machine look for their instructions.
 *
 * Different tools read different places, and a user should not have to know which
 * one they are using. `setup` probes for all of them and installs wherever a tool is
 * actually present, then reports what it found and what it skipped.
 *
 * Nothing here is guessed. A path appears in this file only when the mechanism is
 * documented or observed; a tool with no verifiable user-global hook is detected and
 * reported rather than written to speculatively.
 */

/** Home, overridable so a test never touches a real profile. */
export function agentHome() {
  return process.env.AGENT_MEMORY_SKILLS_HOME || process.env.USERPROFILE || homedir();
}

/**
 * VS Code and its forks keep user data in a per-application directory, and prompt
 * files live in `User/prompts` inside it. The forks are included because they
 * inherit the mechanism; on one that does not, an extra markdown file is inert.
 */
const VSCODE_FLAVOURS = [
  ['vscode', 'VS Code', 'Code'],
  ['vscode-insiders', 'VS Code Insiders', 'Code - Insiders'],
  ['vscodium', 'VSCodium', 'VSCodium'],
  ['cursor', 'Cursor', 'Cursor'],
  ['windsurf', 'Windsurf', 'Windsurf'],
];

export function vscodeUserDir(flavourDir, home = agentHome()) {
  if (platform() === 'darwin') {
    return join(home, 'Library', 'Application Support', flavourDir, 'User');
  }
  if (platform() === 'win32') {
    // %APPDATA% is authoritative on Windows, but it points at the real profile, so
    // honouring it under an overridden home would let a test write into the actual
    // VS Code installation. When the home is overridden, derive the path instead.
    const overridden = Boolean(process.env.AGENT_MEMORY_SKILLS_HOME);
    const appData = (!overridden && process.env.APPDATA) || join(home, 'AppData', 'Roaming');
    return join(appData, flavourDir, 'User');
  }
  return join(home, '.config', flavourDir, 'User');
}

/** Every VS Code-family user directory that exists on this machine. */
export function vscodeUserDirs(home = agentHome()) {
  return VSCODE_FLAVOURS.map(([id, label, dir]) => ({
    id,
    label,
    userDir: vscodeUserDir(dir, home),
  })).filter((f) => existsSync(f.userDir));
}

/**
 * Every install location, with whether the tool behind it is actually here.
 *
 * `kind` decides the format written:
 *   skill-dir  -> <dir>/<name>/SKILL.md, linked
 *   prompt-dir -> <dir>/<name>.prompt.md, written
 */
export function detectTargets(home = agentHome()) {
  const targets = [
    {
      id: 'agents',
      label: 'Agent skills (shared convention)',
      kind: 'skill-dir',
      dir: join(home, '.agents', 'skills'),
      // Always installed: this is the location this project defines, so its absence
      // means "not set up yet" rather than "tool not present".
      detected: true,
      note: 'read by GitHub Copilot agent skills',
    },
    {
      id: 'claude-code',
      label: 'Claude Code (CLI and VS Code extension)',
      kind: 'skill-dir',
      dir: join(home, '.claude', 'skills'),
      detected: existsSync(join(home, '.claude')),
    },
  ];

  for (const f of vscodeUserDirs(home)) {
    targets.push({
      id: f.id,
      label: `${f.label} (Copilot chat prompt files)`,
      kind: 'prompt-dir',
      dir: join(f.userDir, 'prompts'),
      detected: true,
      note: 'invoked as /recall, /remember, /handoff in chat',
    });
  }

  // Detected and deliberately not written to. Copilot CLI documents no user-global
  // prompt or skill directory, and writing into its config folder on a guess is how
  // you ship a file that does nothing while claiming support for it.
  const copilotCli = join(home, '.copilot');
  if (existsSync(copilotCli)) {
    targets.push({
      id: 'copilot-cli',
      label: 'Copilot CLI',
      kind: 'unsupported',
      dir: copilotCli,
      detected: true,
      note: 'no user-global prompt directory; use .github/copilot-instructions.md per repo',
    });
  }

  return targets;
}

/** The targets setup will actually write to. */
export function installableTargets(home = agentHome()) {
  return detectTargets(home).filter((t) => t.detected && t.kind !== 'unsupported');
}
