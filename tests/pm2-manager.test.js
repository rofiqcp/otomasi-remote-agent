import test from 'node:test';
import assert from 'node:assert/strict';
import {managedName,npmCandidates,ecosystem,windowsStartupCmd,existingAgentForConfig,npmPackFilename,windowsHiddenLauncher} from '../bin/pm2-manager.js';
test('name is stable',()=>{assert.equal(managedName('pc','/tmp/a'),managedName('pc','/tmp/a'));assert.notEqual(managedName('pc','/tmp/a'),managedName('pc','/tmp/b'))});
test('ecosystem path and foreground mode',()=>{const s=ecosystem({name:'pc',configDir:'/tmp/a',runtime:'/tmp/runtime',nodePath:'/usr/bin/node'}).apps[0];assert.equal(s.args.at(-1),'--foreground');assert.equal(s.env.OTOMASI_RDC_CONFIG_DIR,'/tmp/a');assert.ok(s.script.includes('/node_modules/'))});
test('windows startup',()=>{assert.match(windowsStartupCmd('C:\\node\\node.exe','C:\\pm2'),/resurrect/)});
test('npm candidates',()=>{assert.equal(npmCandidates('/opt/node/bin/node').length,3)});

test('recognizes older PM2 apps with the same registered identity',()=>{
  const p={name:'otomasi-remote',pm2_env:{
    pm_exec_path:'/usr/local/lib/node_modules/@otomasi/remote/bin/rdc.js',
    status:'online',
    env:{OTOMASI_RDC_CONFIG_DIR:'/tmp/identity-owner-1'}
  }};
  assert.equal(existingAgentForConfig(p,'/tmp/identity-owner-1'),true);
  assert.equal(existingAgentForConfig(p,'/tmp/identity-owner-2'),false);
  assert.equal(existingAgentForConfig({pm2_env:{pm_exec_path:'/usr/bin/unrelated'}},
    '/tmp/identity-owner-1'),false);
});

test('npm pack accepts npm 10 array JSON',()=>{
 const item={name:'@otomasi/remote',version:'0.1.5',filename:'otomasi-remote-0.1.5.tgz'};
 assert.equal(npmPackFilename(JSON.stringify([item]),'0.1.5'),item.filename);
});
test('npm pack accepts npm 11+ package-keyed JSON seen on nuc',()=>{
 const item={name:'@otomasi/remote',version:'0.1.5',filename:'otomasi-remote-0.1.5.tgz'};
 assert.equal(npmPackFilename(JSON.stringify({'@otomasi/remote':item}),'0.1.5'),item.filename);
});
test('npm pack rejects mismatched identity, version and traversal',()=>{
 assert.throws(()=>npmPackFilename('[]','0.1.5'),/invalid filename/);
 assert.throws(()=>npmPackFilename(JSON.stringify([{
   name:'@otomasi/remote',version:'0.1.4',filename:'otomasi-remote-0.1.4.tgz'
 }]),'0.1.5'),/invalid filename/);
 assert.throws(()=>npmPackFilename(JSON.stringify({'@otomasi/remote':{
   name:'@otomasi/remote',version:'0.1.5',filename:'../escape.tgz'
 }}),'0.1.5'),/invalid filename/);
});

test('Windows autostart uses a hidden WScript window, never a visible console', () => {
  const script = windowsHiddenLauncher('C:\\Users\\Test\\.otomasi-rdc\\startup\\resurrect-pm2.cmd');
  assert.match(script, /WScript\.Shell/);
  assert.match(script, /\), 0, False/);
  assert.match(script, /resurrect-pm2\.cmd/);
});
