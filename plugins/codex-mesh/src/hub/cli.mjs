#!/usr/bin/env node
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { initializeHubData, rotateControllerToken } from './init.mjs';
import { listenHub } from './server.mjs';

function usage() {
  return `Codex Mesh Hub

Usage:
  codex-mesh-hub init  [--data-dir <dir>] [--hub-url <url>]
                       [--controller-config <file>] [--force]
                       [--replace-controller-config]
  codex-mesh-hub rotate-controller-token [--data-dir <dir>]
                       [--controller-config <file>]
  codex-mesh-hub serve [--data-dir <dir>] [--host <ip>] [--port <port>]

Defaults:
  data directory: ./data
  controller config: ~/.codex-mesh/controller.json
  listen address: 127.0.0.1:7337

--force replaces hub.json only. Replacing an existing controller config also
requires the explicit --replace-controller-config flag.

Stop the Hub before rotating its controller token. The old token becomes
invalid immediately.

For remote use, bind --host to the server's exact Tailscale/private IP. Public,
wildcard, and non-IP listen addresses are refused.
`;
}

function parseArgs(argv) {
  const command = argv[0];
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--force' || argument === '--replace-controller-config') {
      options[argument.slice(2)] = true;
      continue;
    }
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const key = argument.slice(2);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}`);
    options[key] = value;
  }
  return { command, options };
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv);
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(usage());
    return;
  }
  const dataDir = resolve(options['data-dir'] ?? 'data');
  if (command === 'init') {
    const result = await initializeHubData({
      dataDir,
      force: options.force ?? false,
      controllerConfigPath: options['controller-config'],
      replaceControllerConfig: options['replace-controller-config'] ?? false,
      hubUrl: options['hub-url'] ?? 'http://127.0.0.1:7337',
    });
    process.stdout.write(`${JSON.stringify({
      message: 'Codex Mesh Hub initialized. Keep controller.json private.',
      storePath: result.storePath,
      controllerConfigPath: result.controllerConfigPath,
      controllerToken: result.controllerToken,
    }, null, 2)}\n`);
    return;
  }
  if (command === 'rotate-controller-token') {
    const result = await rotateControllerToken({
      dataDir,
      controllerConfigPath: options['controller-config'],
    });
    process.stdout.write(`${JSON.stringify({
      message: 'Controller token rotated. Keep the controller config private.',
      controllerConfigPath: result.controllerConfigPath,
      controllerToken: result.controllerToken,
      rotatedAt: result.rotatedAt,
    }, null, 2)}\n`);
    return;
  }
  if (command === 'serve') {
    const port = options.port === undefined ? 7337 : Number(options.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be an integer between 0 and 65535');
    const host = options.host ?? '127.0.0.1';
    const hub = await listenHub({ storePath: join(dataDir, 'hub.json'), host, port });
    process.stdout.write(`Codex Mesh Hub listening at ${hub.url}\n`);
    const shutdown = async () => {
      process.stdout.write('Stopping Codex Mesh Hub...\n');
      await hub.close();
    };
    process.once('SIGINT', () => shutdown().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); }));
    process.once('SIGTERM', () => shutdown().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); }));
    return hub;
  }
  throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
