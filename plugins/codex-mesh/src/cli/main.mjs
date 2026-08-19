#!/usr/bin/env node

import { main } from './index.mjs';

main().catch((error) => {
  process.stderr.write(`meshctl: ${error?.message ?? String(error)}\n`);
  process.exitCode = 1;
});
