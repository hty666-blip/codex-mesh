#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { main } from './server.mjs';

export { main };

const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entryUrl) await main();
