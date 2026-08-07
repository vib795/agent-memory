#!/usr/bin/env node
/**
 * Link the skills when the package is installed.
 *
 * This must never fail an install. A missing symlink is a nuisance; an `npm install`
 * that exits non-zero on a managed desktop is the kind of thing that gets a tool
 * banned. Every failure here is reported and swallowed, and `agent-memory setup`
 * remains available to finish the job by hand.
 *
 * Note that managed npm configurations often set `ignore-scripts=true`, in which case
 * this file never runs and nothing warns you. That is precisely why the same work is
 * exposed as a command, and why `doctor` names it.
 */

const say = (msg) => process.stdout.write(`${msg}\n`);

if (process.env.AGENT_MEMORY_SKIP_POSTINSTALL) {
  process.exit(0);
}

try {
  const [maj, min] = process.versions.node.split('.').map((s) => Number.parseInt(s, 10));
  if (maj < 22 || (maj === 22 && min < 5)) {
    say(`agent-memory: Node ${process.versions.node} is too old; needs >= 22.5 for node:sqlite.`);
    say('agent-memory: skills not linked. Upgrade Node, then run: agent-memory setup');
    process.exit(0);
  }

  const { setup } = await import('../src/setup.js');
  const { compact } = await import('../src/compact.js');
  const r = setup({ compactFn: () => compact() });

  const links = r.installed.filter((s) => s.mode === 'link').length;
  const copies = r.copies.length;
  say(`agent-memory: linked ${links} skill${links === 1 ? '' : 's'}${copies ? `, copied ${copies}` : ''}.`);
  say(`agent-memory: ${r.notes} notes indexed. Restart VS Code, then try /recall.`);
  if (copies) {
    say('agent-memory: copies happen on network-backed profiles; re-run `agent-memory setup` after upgrades.');
  }
} catch (err) {
  say(`agent-memory: automatic setup did not complete (${err.message}).`);
  say('agent-memory: run `agent-memory setup` to finish. Nothing else is affected.');
}

process.exit(0);
