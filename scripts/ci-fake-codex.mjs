#!/usr/bin/env node

if (process.argv.length === 3 && process.argv[2] === "--version") {
  process.stdout.write("codex-cli 0.0.0-ci\n");
  process.exit(0);
}

process.stderr.write("The CI fake Codex supports only --version.\n");
process.exit(64);
