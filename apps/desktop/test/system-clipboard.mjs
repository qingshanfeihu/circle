import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { PNG } from 'pngjs';
import { _electron as electron } from 'playwright';

if (process.platform !== 'darwin') {
  console.log('SKIP actual system clipboard: this harness verifies macOS only');
  process.exit(0);
}
const root = fileURLToPath(new URL('..', import.meta.url));
const repository = fileURLToPath(new URL('../../..', import.meta.url));
const require = createRequire(import.meta.url);
const temp = await mkdtemp(join(tmpdir(), 'circle-system-clipboard-'));
const output = join(root, 'artifacts/system-clipboard');
await mkdir(output, { recursive: true });
// The original pasteboard never leaves this helper's memory. A partial/lazy snapshot
// is refused before clearContents. EOF also restores it if the parent exits unexpectedly.
const helper = join(temp, 'pasteboard.swift');
await writeFile(
  helper,
  String.raw`
import AppKit
import Foundation
let board = NSPasteboard.general
let originalCount = board.changeCount
let source = board.pasteboardItems ?? []
var saved: [[NSPasteboard.PasteboardType: Data]] = []
var covered = Set<NSPasteboard.PasteboardType>()
for item in source {
    var values: [NSPasteboard.PasteboardType: Data] = [:]
    for type in item.types {
        guard let data = item.data(forType: type) else {
            print("blocked: a clipboard type cannot be preserved"); exit(2)
        }
        values[type] = Data(data); covered.insert(type)
    }
    saved.append(values)
}
if !Set(board.types ?? []).isSubset(of: covered) || board.changeCount != originalCount {
    print("blocked: the complete clipboard snapshot is unavailable"); exit(2)
}
var ownedCount = originalCount
var changed = false
var restored = false
func restore() -> Bool {
    if restored || !changed { return true }
    if board.changeCount != ownedCount {
        return false // Preserve a newer clipboard supplied by somebody else.
    }
    let items = saved.map { values -> NSPasteboardItem in
        let item = NSPasteboardItem()
        for (type, data) in values { item.setData(data, forType: type) }
        return item
    }
    board.clearContents()
    ownedCount = board.changeCount
    if !items.isEmpty {
        let success = board.writeObjects(items)
        ownedCount = board.changeCount
        if !success { return false }
    }
    let actual = board.pasteboardItems ?? []
    if actual.count != saved.count { return false }
    for (index, item) in actual.enumerated() {
        if Set(item.types) != Set(saved[index].keys) { return false }
        for (type, data) in saved[index] { if item.data(forType: type) != data { return false } }
    }
    if !Set(board.types ?? []).isSubset(of: covered) { return false }
    restored = true
    return true
}
func reply(_ value: String) { print(value); fflush(stdout) }
reply("ready")
defer { _ = restore() }
while let command = readLine() {
    if command == "restore" {
        reply(restore() ? "restored" : "blocked: clipboard restoration cannot safely complete")
        break
    }
    let parts = command.split(separator: "\t", maxSplits: 1)
    guard parts.count == 2 && parts[0] == "set", board.changeCount == ownedCount,
          let data = try? Data(contentsOf: URL(fileURLWithPath: String(parts[1]))) else {
        reply("blocked: fixture clipboard ownership changed"); continue
    }
    let item = NSPasteboardItem()
    item.setData(data, forType: .png)
    board.clearContents()
    ownedCount = board.changeCount; changed = true
    let success = board.writeObjects([item])
    ownedCount = board.changeCount
    guard success else { reply("blocked: synthetic image could not be set"); continue }
    reply("set")
}
`,
);
let keeper,
  application,
  server,
  keeperReady = false,
  restored = false;
const lines = [],
  waiting = [];
const nextLine = () =>
  lines.length
    ? Promise.resolve(lines.shift())
    : new Promise((resolve, reject) => waiting.push({ resolve, reject }));
const command = async (value) => {
  keeper.stdin.write(value + '\n');
  const response = await nextLine();
  if (response !== 'set' && response !== 'restored') throw Error(response);
  return response;
};
const image = (color) => {
  const png = new PNG({ width: 16, height: 16 });
  for (let offset = 0; offset < png.data.length; offset += 4)
    png.data.set([...color, 255], offset);
  return PNG.sync.write(png);
};
const first = image([230, 20, 40]),
  second = image([20, 210, 60]);
const firstPath = join(temp, 'first.png'),
  secondPath = join(temp, 'second.png');
await writeFile(firstPath, first);
await writeFile(secondPath, second);
const samePixels = (actual, expected) => {
  const a = PNG.sync.read(actual),
    b = PNG.sync.read(expected);
  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
  assert(a.data.equals(b.data));
};
const requests = [];
try {
  keeper = spawn(
    '/usr/bin/swift',
    ['-module-cache-path', join(temp, 'swift-cache'), helper],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const lineReader = createInterface({ input: keeper.stdout });
  lineReader.on('line', (line) => {
    const pending = waiting.shift();
    pending ? pending.resolve(line) : lines.push(line);
  });
  let helperErrors = '';
  keeper.stderr.on('data', (value) => (helperErrors += value.toString()));
  keeper.on('error', (error) => {
    for (const pending of waiting.splice(0)) pending.reject(error);
  });
  keeper.on('exit', (code) => {
    for (const pending of waiting.splice(0))
      pending.reject(
        Error(
          `clipboard helper exited (${code}); no clipboard content was logged`,
        ),
      );
  });
  const ready = await nextLine();
  if (ready !== 'ready') throw Error(ready);
  keeperReady = true;
  server = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'clipboard-fixture' }] }));
      return;
    }
    if (req.url !== '/v1/chat/completions') {
      res.writeHead(404);
      res.end();
      return;
    }
    let body = '';
    for await (const bytes of req) body += bytes;
    const request = JSON.parse(body);
    requests.push(request);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(
      `data: ${JSON.stringify({ id: 'local-clipboard', object: 'chat.completion.chunk', model: request.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'system clipboard received' }, finish_reason: null }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ id: 'local-clipboard', object: 'chat.completion.chunk', model: request.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
    );
    res.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const env = {
    ...process.env,
    CIRCLE_HOME: join(temp, 'home'),
    CIRCLE_WORKBENCH_DATA_DIR: join(temp, 'data'),
    CIRCLE_WORKBENCH_MODE: 'live',
    CIRCLE_WORKBENCH_LANGUAGE: 'en-US',
    CIRCLE_WORKBENCH_TEST_PROFILE: '{}',
    CIRCLE_NO_UPDATE_CHECK: '1',
    CIRCLE_NO_MODELS_REFRESH: '1',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  };
  for (const name of Object.keys(env))
    if (
      /^(https?_proxy|all_proxy|node_use_env_proxy|circle_desktop_runtime_fixture)$/i.test(
        name,
      )
    )
      delete env[name];
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    executablePath:
      process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
    args: [process.env.CIRCLE_DESKTOP_APP_PATH ?? root],
    cwd: root,
    env,
    chromiumSandbox: true,
    timeout: 45000,
  });
  const page = await application.firstWindow();
  page.setDefaultTimeout(patience(20000));
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.show();
    window.setContentSize(1400, 900);
    window.focus();
  });
  await page
    .getByRole('textbox', { name: 'base url', exact: true })
    .fill(`http://127.0.0.1:${server.address().port}/v1`);
  await page
    .getByRole('textbox', { name: 'api key', exact: true })
    .fill('system-clipboard-fixture-key');
  await page.getByRole('button', { name: 'next', exact: true }).click();
  await page
    .getByRole('option', { name: 'clipboard-fixture', exact: true })
    .click();
  await page.getByRole('button', { name: 'connect', exact: true }).click();
  const composer = page.getByRole('textbox', { name: 'message', exact: true });
  await command('set\t' + firstPath);
  await composer.focus();
  await composer.press('Meta+v');
  await page.getByText('pasted image 1.png', { exact: true }).waitFor();
  await command('set\t' + secondPath);
  await composer.focus();
  await composer.press('Meta+v');
  await page.getByText('pasted image 2.png', { exact: true }).waitFor();
  await page
    .getByRole('button', { name: 'remove pasted image 1.png', exact: true })
    .click();
  assert.equal(
    await page.getByText('pasted image 1.png', { exact: true }).count(),
    0,
  );
  await composer.fill('check the remaining synthetic clipboard image');
  await page.getByRole('button', { name: 'send message', exact: true }).click();
  await page.getByText('system clipboard received', { exact: true }).waitFor();
  const user = requests
    .at(-1)
    .messages.findLast((message) => message.role === 'user');
  const images = user.content.filter((part) => part.type === 'image_url');
  assert.equal(images.length, 1);
  const received = Buffer.from(images[0].image_url.url.split(',')[1], 'base64');
  samePixels(received, second);
  await writeFile(join(temp, 'desktop-model.png'), received);
  await page.waitForFunction(async () => {
    const { snapshot } = await window.circleDesktop.runtimeState();
    const session = snapshot.sessions.find(
      (entry) => entry.id === snapshot.activeSessionId,
    );
    return session?.state === 'idle' && !session.turn;
  });
  const desktopSession = await page.evaluate(
    async () =>
      (await window.circleDesktop.runtimeState()).snapshot.activeSessionId,
  );
  const info = await page.evaluate(() => window.circleDesktop.info());
  await application.close();
  application = undefined;
  // The real TUI's key handler calls its unmodified Clipboard reader (real osascript).
  const tuiScript = String.raw`
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {PNG} from 'pngjs';
import {SessionApp} from './src/tui/session_app.ts';
import {AgentRuntime} from './src/runtime.ts';
import {ScriptedModel} from './src/testing.ts';
import {defaultSettings} from './src/settings.ts';
import {CheckpointStore} from './src/checkpoint_store.ts';
import {createInterface} from 'node:readline';
import {createHash} from 'node:crypto';
import { patience } from './helpers/patience.mjs';
const folder=process.env.CIRCLE_CLIPBOARD_TEST_ROOT;
const workspace=join(folder,'tui-workspace'),home=join(folder,'tui-home');
mkdirSync(workspace);mkdirSync(home);
const settings=defaultSettings();
const model=new ScriptedModel([{message:{id:'answer',role:'assistant',content:'tui clipboard received'}}]);
const runtime=new AgentRuntime({workspace,home,settings,model,headless:true});
const app=new SessionApp(workspace,home,settings);
app.runtime=runtime;app.screen.render=()=>{};
app.terminal={platform:'darwin',write:()=>{},input:()=>{},kill:()=>{throw Error('unexpected terminal kill')}};
const replies=createInterface({input:process.stdin});
const acknowledgments=replies[Symbol.asyncIterator]();
const exchange=async name=>{console.log('CLIPBOARD '+name);const next=await acknowledgments.next();assert.equal(next.value,'ready');};
const wait=async check=>{const end=Date.now()+10000;while(!check()){assert(Date.now()<end,'timed out waiting for the TUI image fixture');await new Promise(resolve=>setTimeout(resolve,10));}};
const expected=PNG.sync.read(readFileSync(join(folder,'second.png')));
const checkImage=(user,encoded)=>{assert.equal(user.attachments.length,1);const bytes=Buffer.from(user.attachments[0].data,'base64');if(encoded)assert(bytes.equals(encoded),'restored checkpoint must retain exact model attachment encoded bytes');const actual=PNG.sync.read(bytes);assert(actual.data.equals(expected.data));assert.equal(actual.width,expected.width);assert.equal(actual.height,expected.height);};
try{
 await exchange('first');
 app.handle({type:'key',key:'ctrl+v',char:''});
 await wait(()=>app.state.draft.includes('[Image #1]'));
 assert.match(app.state.draft,/\[Image #1\]/);
 await exchange('second');
 app.handle({type:'key',key:'ctrl+v',char:''});
 await wait(()=>app.state.draft.includes('[Image #2]'));
 assert.match(app.state.draft,/\[Image #1\].*\[Image #2\]/);
 // These are real SessionApp/composer key paths, with terminal drawing stubbed.
 app.handle({type:'key',key:'home',char:''});
 for(let index=0;index<'[Image #1]'.length;index++)app.handle({type:'key',key:'delete',char:''});
 assert.doesNotMatch(app.state.draft,/\[Image #1\]/);
 assert.match(app.state.draft,/\[Image #2\]/);
 app.handle({type:'key',key:'end',char:''});
 for(const char of 'read synthetic picture')app.handle({type:'key',key:char,char});
 app.handle({type:'key',key:'enter',char:''});
 await wait(()=>model.requests.length>0&&!runtime.busy);
 const user=model.requests.at(-1).messages.findLast(message=>message.role==='user');
 checkImage(user);
 const tuiEncoded=Buffer.from(user.attachments[0].data,'base64');
 const sessionId=runtime.session.id;
 await runtime.close();
 await exchange('restore');
 for(const [storedHome,id,encoded] of [[home,sessionId,tuiEncoded],[join(folder,'data/runtime-home'),process.env.CIRCLE_CLIPBOARD_DESKTOP_SESSION,readFileSync(join(folder,'desktop-model.png'))]]){
   const reopened=new CheckpointStore(storedHome);
   try{assert(reopened.get(id));checkImage(reopened.messages(id).findLast(message=>message.role==='user'),encoded);}finally{reopened.close();}
 }
 console.log('TUI_RECEIPT '+JSON.stringify({encodedPNGBytes:tuiEncoded.length,encodedSHA256:createHash('sha256').update(tuiEncoded).digest('hex'),decodedPixelSHA256:createHash('sha256').update(PNG.sync.read(tuiEncoded).data).digest('hex'),reopenedExactEncodedBytes:true}));
 console.log('PASS actual TUI osascript -> two SessionApp image tokens -> delete first -> model attachment bytes -> reopened desktop and TUI checkpoints after clipboard restore');
}finally{
 if(app.flashTimer)clearTimeout(app.flashTimer);if(app.animation)clearInterval(app.animation);
 app.input.close();await runtime.close();replies.close();
}
`;
  const tui = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', tuiScript],
    {
      cwd: repository,
      env: {
        ...env,
        CIRCLE_HOME: join(temp, 'tui-home'),
        CIRCLE_CLIPBOARD_TEST_ROOT: temp,
        CIRCLE_CLIPBOARD_DESKTOP_SESSION: desktopSession,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let tuiOut = '',
    tuiError = '';
  const exchanges = [];
  let protocolError;
  const tuiLines = createInterface({ input: tui.stdout });
  tuiLines.on('line', (line) => {
    if (!line.startsWith('CLIPBOARD ')) {
      tuiOut += line + '\n';
      return;
    }
    exchanges.push(
      (async () => {
        const request = line.slice('CLIPBOARD '.length);
        if (request === 'first' || request === 'second')
          await command(
            'set\t' + (request === 'first' ? firstPath : secondPath),
          );
        else if (request === 'restore')
          restored = (await command('restore')) === 'restored';
        else throw Error('unknown synthetic clipboard fixture request');
        tui.stdin.write('ready\n');
      })().catch((error) => {
        protocolError = error;
        tui.kill();
      }),
    );
  });
  tui.stderr.on('data', (bytes) => (tuiError += bytes));
  const tuiCode = await new Promise((resolve, reject) => {
    tui.on('error', reject);
    tui.on('close', resolve);
  });
  await Promise.all(exchanges);
  if (protocolError) throw protocolError;
  assert.equal(tuiCode, 0, tuiError);
  assert.match(tuiOut, /PASS actual TUI osascript/);
  const tuiReceipt = JSON.parse(
    tuiOut
      .split('\n')
      .find((line) => line.startsWith('TUI_RECEIPT '))
      .slice('TUI_RECEIPT '.length),
  );
  assert.equal(restored, true);
  const receipt = {
    platform: 'darwin',
    packaged: info.packaged,
    verifiedAt: new Date().toISOString(),
    checks: 6,
    desktopActualMetaPaste: true,
    desktopRemovedFirstImage: true,
    modelPNGBytes: received.length,
    modelPixelsMatched: true,
    tuiActualOsascript: true,
    tuiSessionAppAndModel: true,
    tuiTwoPastesRemovedFirstThroughComposerKeys: true,
    terminalRenderingStubbed: true,
    desktopAndTuiReopenedCheckpointBytes: true,
    fixturePixels: {
      width: 16,
      height: 16,
      everyPixelRGBA: [20, 210, 60, 255],
    },
    desktop: {
      encodedPNGBytes: received.length,
      encodedSHA256: createHash('sha256').update(received).digest('hex'),
      decodedPixelSHA256: createHash('sha256')
        .update(PNG.sync.read(received).data)
        .digest('hex'),
      reopenedExactEncodedBytes: true,
    },
    tui: tuiReceipt,
    originalClipboardRestored: true,
  };
  const durableOutput = join(
    repository,
    'outputs/clipboard',
    info.packaged ? 'packaged' : 'development',
  );
  await mkdir(durableOutput, { recursive: true });
  const report = JSON.stringify(receipt, null, 2);
  await writeFile(join(output, 'report.json'), report);
  await writeFile(join(durableOutput, 'receipt.json'), report);
  console.log(
    JSON.stringify({
      checks: 6,
      packaged: info.packaged,
      clipboardRestored: true,
      output,
    }),
  );
} finally {
  const cleanupErrors = [];
  if (application)
    await application.close().catch((error) => cleanupErrors.push(error));
  if (keeperReady && !restored)
    await command('restore')
      .then(() => (restored = true))
      .catch((error) => cleanupErrors.push(error));
  if (keeper) keeper.stdin.end();
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve)).catch((error) =>
      cleanupErrors.push(error),
    );
  }
  await rm(temp, { recursive: true, force: true }).catch((error) =>
    cleanupErrors.push(error),
  );
  if (cleanupErrors.length)
    throw new AggregateError(
      cleanupErrors,
      'isolated clipboard fixture cleanup failed',
    );
}
