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
const { runInNewContext } = require('node:vm');

// Exercise the shipped client module and its Save handler against host-shaped services.
// React hooks are a small render harness; this does not claim a real browser render.
async function verifySettingsClient(root, entry, config) {
  const state = [];
  let cursor = 0, client, card, registration;
  const keyWrites = [], mutations = [];
  const snapshot = { status:'ready',writable:true,revision:'test-revision',
    value:Object.fromEntries(Object.entries(config).map(([key,value])=>[key,typeof value?.get==='function'?value.get():value])) };
  const fetch = async(url,options)=>{
      assert.equal(url,'/api/vocechat-bridge/settings');
      assert.equal(options.credentials,'same-origin');
      const body=options.body?JSON.parse(options.body):undefined;
      if(body){
      assert.equal(body.revision,snapshot.revision);
      const next={...snapshot.value,...body.set};
      entry.Config(next); // Actual host validates the UI's persisted values.
      mutations.push(...Object.entries(body.set).map(([key,value])=>({path:[key],value})));
      for(const [mode,value] of Object.entries(body.keys || {}))if(value)keyWrites.push({ref:next[mode+'ApiKeyRef'],present:true});
      snapshot.value=next;
      }
      return new Response(JSON.stringify({ok:true,...snapshot,credentials:{},runtime:{running:false}}),{status:200});
  };
  const react = {
    createElement:(type,props,...children)=>({type,props:props||{},children:children.flat(Infinity)}),
    useSyncExternalStore:(_subscribe,get)=>get(),useEffect(){},
    useState(initial){const id=cursor++;if(!(id in state))state[id]=initial;return [state[id],value=>{state[id]=typeof value==='function'?value(state[id]):value;}];},
  };
  runInNewContext(fs.readFileSync(path.join(root,'client','index.js'),'utf8'),{
    URL,AbortController,fetch,
    window:{__ModuleLoader__:{load(spec){assert.equal(spec.id,'dsh-vocechat-bridge');client=spec.factory(name=>{assert.equal(name,'react');return react;});}}},
  });
  const ctx = {
    // The same minimal dependency as dsh-bili-scroll: no configForms/remote/locale.
    slots:{inject:(_name,fn)=>fn(),register:(spec,component)=>{registration=spec;card=component;return ()=>{};}},effect:fn=>fn(),
  };
  client.apply(ctx);
  assert.deepEqual(Array.from(client.inject),['slots']);
  assert.equal(registration.name,'settings.section');assert.equal(registration.label,'VoceChat');
  const view=card();await view.props.scope.load();
  const render=()=>{cursor=0;return view.type(view.props);};
  const nodes=(tree,type)=>[...(tree&&typeof tree==='object'&&tree.type===type?[tree]:[]),
    ...(tree?.children||[]).filter(v=>v&&typeof v==='object').flatMap(v=>nodes(v,type))];
  let tree=render();assert.equal(nodes(tree,'fieldset').length,3);
  assert(nodes(tree,'button').some(n=>n.children.includes('启动桥接后端')));
  nodes(tree,'select')[0].props.onChange({target:{value:'mimo'}});
  tree=render();nodes(nodes(tree,'label').find(n=>n.children[0]==='API Key'),'input')[0].props.onChange({target:{value:'local-smoke-key'}});
  tree=render();await nodes(tree,'button').find(n=>n.children.includes('保存')).props.onClick();
  assert(mutations.some(op=>op.path[0]==='asrProvider'&&op.value==='mimo'));
  assert.deepEqual(keyWrites,[{ref:'MIMO_API_KEY',present:true}]);
  assert(render().children.some(n=>n?.props?.role==='status'&&n.children.some(text=>typeof text==='string'&&text.startsWith('已保存'))));
}

// Mount the real entry twice over persisted enabled:true. Only credentials and
// the inactive Agent are fake; startup, disk recovery and HTTP listeners are real.
async function verifyColdStartup(entry, temporary) {
  const directory=path.join(temporary,'cold-start');await fsp.mkdir(directory);
  const settingsFile=path.join(directory,'settings.json');
  await fsp.writeFile(settingsFile,JSON.stringify({version:1,values:{enabled:true}}));
  const config=entry.Config({statePath:path.join(directory,'state.json'),tempDir:path.join(directory,'tmp'),
    baseUrl:'http://127.0.0.1',botUid:4,targetSessionId:'cold-start-test',userWhitelist:[1],webhookPort:0,
    botApiKeyRef:'VOCE_COLD_START_SMOKE_KEY',webhookSecretRef:''});
  assert.equal(process.env.VOCE_COLD_START_SMOKE_KEY,undefined);
  const waitFor=async(check)=>{for(let i=0;i<300;i++){if(check())return;await new Promise(r=>setTimeout(r,10));}throw new Error('Cold startup timed out');};
  const mount=(initiallyReady)=>{
    let credentials=initiallyReady?{resolve:async()=>({value:'cold-test-key'})}:undefined;
    const effects=[],watchers=[];
    const ctx={
      agents:{get(){throw new Error('Cold startup must not call an Agent');},resume(){throw new Error('Cold startup must not resume an Agent');}},
      tools:{register(){}},logger:()=>({debug(){},info(){},warn(){},error(){}}),
      get(name){if(name==='credentials')return credentials;throw new Error('Unexpected cold-start service');},
      effect(install){const dispose=install();effects.push(dispose);return dispose;},
      inject(names,install){if(names.includes('credentials')){watchers.push(install);if(credentials)install(ctx);}},
    };
    const runtime=entry.apply(ctx,config);
    return {runtime,ready(){credentials={resolve:async()=>({value:'cold-test-key'})};for(const install of watchers)install(ctx);},
      async dispose(){for(const dispose of effects.reverse())await dispose();}};
  };
  let first,second;
  try {
    first=mount(false);
    await waitFor(()=>first.runtime.status().error==='BRIDGE_CREDENTIAL_MISSING');
    assert.equal(first.runtime.status().running,false);
    first.ready();await waitFor(()=>first.runtime.status().running);
    let address=first.runtime.status().address;
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/vocehook`)).status,200);
    await first.dispose();first=undefined;
    assert.equal(JSON.parse(await fsp.readFile(settingsFile,'utf8')).values.enabled,true);
    second=mount(true);await waitFor(()=>second.runtime.status().running);
    address=second.runtime.status().address;
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/vocehook`)).status,200);
  } finally {
    await first?.dispose();await second?.dispose();await fsp.rm(directory,{recursive:true,force:true});
  }
}

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
  const effects = [], registered = [], logs = [], routes = [];
  let bridge;
  try {
    const entry = await import(pathToFileURL(path.join(root, 'dist', 'index.js')).href);
    const hostVersion = JSON.parse(fs.readFileSync(path.join(hostModules, '@deepseek-ai/dsh-llm/package.json'), 'utf8')).version;
    const config = entry.Config({ statePath: path.join(temporary, 'state.json'), tempDir: path.join(temporary, 'tmp') });
    assert.equal(config.enabled, false);
    assert.deepEqual(config.userWhitelist, []);
    assert.deepEqual(config.groupWhitelist, []);
    assert.equal(config.allowProactive, false);
    assert.equal(config.asrEnabled.get(), false);
    assert.equal(config.ttsEnabled.get(), false);
    assert.equal(config.asrProvider.get(), 'openai');
    Server.prototype.listen = function (...args) { listenCalls++; throw new Error('Smoke test must never open a socket.'); };
    const ctx = {
      agents: { get() { throw new Error('Disabled plugin must not resolve a live session.'); }, resume() { throw new Error('Disabled plugin must not resume a session.'); } },
      tools: { register(tool) { registered.push(tool); return () => {}; } },
      logger() { return Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, text => logs.push({ level, text })])); },
      get() { throw new Error('Disabled plugin must not access credentials or host services.'); },
      on() { throw new Error('Disabled plugin must not subscribe to a session.'); },
      effect(install) { const dispose = install(); effects.push(dispose); return dispose; },
      inject(names,install) {
        if(!names.includes('webServer'))return;
        return install({...this,webServer:{register(route){routes.push(route);return()=>routes.splice(routes.indexOf(route),1);}}});
      },
    };
    bridge = entry.apply(ctx, config);
    // Give the entry startup promise and its disposal guard a complete tick.
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(bridge.status().running, false);
    assert.equal(bridge.status().enabled, false);
    assert.equal(routes[0].path,'/api/vocechat-bridge/settings');
    assert.equal(listenCalls, 0);
    assert.equal(logs.filter(item => item.level === 'error').length, 0);
    assert.deepEqual(registered.map(tool => tool.name), [
      'voce_send_text', 'voce_send_image', 'voce_send_audio', 'voce_send_file',
      'voce_speak', 'voce_send_message', 'voce_quiet', 'voce_get_private_history', 'voce_get_group_history', 'voce_bridge_status',
    ]);
    const status = registered.find(tool => tool.name === 'voce_bridge_status');
    assert.equal(JSON.parse(await status.execute({}, {})).running, false);
    // This invokes the real defineTool validator, not the fake registry.
    const send = registered.find(tool => tool.name === 'voce_send_text');
    await assert.rejects(send.execute({ text: 'missing destination' }, {}), /invalid arguments/);
    await verifySettingsClient(root,entry,config);
    for (const dispose of effects.reverse()) { assert.equal(typeof dispose, 'function'); await dispose(); }
    assert.equal(routes.length,0);
    await bridge.stop(); // repeated disposal must also finish cleanly
    assert.equal(listenCalls, 0);
    Server.prototype.listen=originalListen;
    await verifyColdStartup(entry,temporary);
    assert.deepEqual(await fsp.readdir(temporary), []);
    console.log(JSON.stringify({ ok: true, dshVersion: hostVersion, configSchema: 'real host', tools: registered.length,
      pluginEntry: 'dist/index.js', settingsClient: 'registration, edit, credential write and save passed (mock services)',
      coldStartup: 'persisted enabled, delayed credentials, remount and real HTTP listeners passed',
      enabled: false, listenCalls, disposal: 'passed', userProfileWrites: 0,
      modelCalls: 0, realMessages: 0 }, null, 2));
  } finally {
    Server.prototype.listen = originalListen;
    if (bridge) await bridge.stop();
    hook.deregister?.();
    await fsp.rm(temporary, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(`Host smoke failed: ${error.message}`); process.exitCode = 1; });
