#!/usr/bin/env node
/**
 * The version gate, ahead of the module graph.
 *
 * `cli.js` statically imports `index-db.js`, which imports `node:sqlite`. ESM imports
 * hoist, so on a Node without that module the entire graph fails to load with
 * `ERR_UNKNOWN_BUILTIN_MODULE` before one line of our code runs — including `doctor`,
 * whose whole job is to say the version is wrong. A user on Node 20 got an internal
 * stack trace instead of a sentence telling them what to do.
 *
 * So the check lives here, in the one file that imports nothing, and `cli.js` is
 * loaded dynamically only once the runtime is known to be capable. This is the same
 * reasoning as `atomic.js` importing nothing from the package: a guard that depends on
 * what it guards is not a guard.
 *
 * MIN_NODE is stated twice, here and in `cli.js`, because this file cannot import from
 * a module that pulls in the database. The test suite asserts the two agree.
 */
const MIN_NODE = [22, 16];

const [major, minor] = process.versions.node.split('.').map(Number);

if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])) {
  process.stderr.write(
    `agent-memory needs Node >= ${MIN_NODE.join('.')}; this process is ${process.versions.node}.\n` +
      'The store is SQLite via node:sqlite, which carries the FTS5 extension only from\n' +
      '22.16 onward, and search is built on FTS5. There is no dependency to install —\n' +
      'upgrade Node and run the same command again.\n',
  );
  process.exit(1);
}

await import('./cli.js');
