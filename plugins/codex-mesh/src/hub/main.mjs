#!/usr/bin/env node
import { main } from './cli.mjs';

main().catch((error) => {
  process.stderr.write(`mesh-hub: ${error?.message ?? String(error)}\n`);
  process.exitCode = 1;
});
