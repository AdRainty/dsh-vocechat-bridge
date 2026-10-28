#!/usr/bin/env node
'use strict';

// Run with the DSH Electron executable in ELECTRON_RUN_AS_NODE=1 mode. Electron's
// read-only ASAR filesystem support loads the exact installed release libraries.
// A process-local module hook redirects only the plugin's three peer imports;
// nothing is extracted, installed, symlinked, or written into the host profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { registerHooks } = require('node:module');
const { Server } = require('node:http');

async function main() {
  if (!process.versions.electron || typeof registerHooks !== 'function') {
    throw new Error('Run this script using the installed DSH Electron executable with ELECTRON_RUN_AS_NODE=1 (Node with registerHooks is required).');
  }
  if (!process.argv[2]) throw new Error('Usage: <DSH Electron.exe> scripts/verify-host.cjs <absolute path to resources/app.asar>');
  const archive = path.resolve(process.argv[2]);
  // Electron's wrapped fs reports an ASAR root as a virtual directory. Stat
  // the physical archive with its original-fs view before reading inside it.
  if (!archive.endsWith('.asar') || !require('original-fs').statSync(archive).isFile()) throw new Error('Expected an existing app.asar file.');
  const root = path.resolve(__dirname, '..');
  const hostModules = path.join(archive, 'dsh', 'node_modules');
  const peers = new Set(['@deepseek-ai/schemastery', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-tools']);
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (peers.has(specifier)) {
        return { url: pathToFileURL(require.resolve(path.join(hostModules, specifier))).href, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
  const temporary = await fsp.mkdtemp(path.join(root, '.host-smoke-'));
  const originalListen = Server.prototype.listen;
  let listenCalls = 0;
  const effects = [], registered = [], logs = [];
  let bridge;
  try {
    const entry = await import(pathToFileURL(path.join(root, 'dist', 'index.js')).href);
    const hostVersion = JSON.parse(fs.readFileSync(path.join(hostModules, '@deepseek-ai/dsh-llm/package.json'), 'utf8')).version;
    const config = entry.Config({ statePath: path.join(temporary, 'state.json'), tempDir: path.join(temporary, 'tmp') });
    assert.equal(config.enabled, false);
    assert.deepEqual(config.userWhitelist, []);
    assert.deepEqual(config.groupWhitelist, []);
    assert.equal(config.allowProactive, false);
    Server.prototype.listen = function (...args) { listenCalls++; throw new Error('Smoke test must never open a socket.'); };
    const ctx = {
      agents: { get() { throw new Error('Disabled plugin must not resolve a live session.'); }, resume() { throw new Error('Disabled plugin must not resume a session.'); } },
      tools: { register(tool) { registered.push(tool); return () => {}; } },
      logger() { return Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, text => logs.push({ level, text })])); },
      get() { throw new Error('Disabled plugin must not access credentials or host services.'); },
      on() { throw new Error('Disabled plugin must not subscribe to a session.'); },
      effect(install) { const dispose = install(); effects.push(dispose); return dispose; },
    };
    bridge = entry.apply(ctx, config);
    // Give the entry startup promise and its disposal guard a complete tick.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(bridge.status().running, false);
    assert.equal(bridge.status().enabled, false);
    assert.equal(listenCalls, 0);
    assert.equal(logs.filter(item => item.level === 'error').length, 0);
    assert.deepEqual(registered.map(tool => tool.name), [
      'voce_send_text', 'voce_send_image', 'voce_send_audio', 'voce_send_file',
      'voce_send_message', 'voce_quiet', 'voce_bridge_status',
    ]);
    const status = registered.find(tool => tool.name === 'voce_bridge_status');
    assert.equal(JSON.parse(await status.execute({}, {})).running, false);
    // This invokes the real defineTool validator, not the fake registry.
    const send = registered.find(tool => tool.name === 'voce_send_text');
    await assert.rejects(send.execute({ text: 'missing destination' }, {}), /invalid arguments/);
    for (const dispose of effects.reverse()) { assert.equal(typeof dispose, 'function'); await dispose(); }
    await bridge.stop(); // repeated disposal must also finish cleanly
    assert.equal(listenCalls, 0);
    assert.deepEqual(await fsp.readdir(temporary), []);
    console.log(JSON.stringify({ ok: true, dshVersion: hostVersion, configSchema: 'real host', tools: registered.length,
      pluginEntry: 'dist/index.js', enabled: false, listenCalls, disposal: 'passed', userProfileWrites: 0,
      modelCalls: 0, realMessages: 0 }, null, 2));
  } finally {
    Server.prototype.listen = originalListen;
    if (bridge) await bridge.stop();
    hook.deregister?.();
    await fsp.rm(temporary, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(`Host smoke failed: ${error.message}`); process.exitCode = 1; });
