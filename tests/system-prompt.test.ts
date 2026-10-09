import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type ServerResponse } from 'node:http';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentRuntime } from '../src/runtime.js';
import { ModelCatalog } from '../src/model_catalog.js';
import { ScriptedModel } from '../src/testing.js';
import { defaultRunOptions } from '../src/run_options.js';
import { promptOverrides } from '../src/system_prompt.js';
import {
  defaultSettings,
  loadSettings,
  saveCredentials,
  saveSettings,
  trustFolder,
} from '../src/settings.js';
import type { Message } from '../src/types.js';
import { cleanup, scratch } from './helpers.js';

const reply = (text: string) => ({
  message: {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: text,
  } as Message,
});
const count = (text: string, part: string): number =>
  text.split(part).length - 1;
function skill(root: string, name: string, description: string): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(
    join(root, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${name} body marker\n`,
  );
}

test('SYSTEM.md and APPEND_SYSTEM.md in the data folder reach the model; the project and the command line win', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  mkdirSync(join(workspace, '.circle'), { recursive: true });
  mkdirSync(home);
  writeFileSync(join(workspace, 'AGENTS.md'), 'PROJECT RULES');
  writeFileSync(join(home, 'SYSTEM.md'), 'FROM HOME SYSTEM\n');
  writeFileSync(join(home, 'APPEND_SYSTEM.md'), 'FROM HOME APPEND');
  const settings = trustFolder(defaultSettings(), workspace);
  saveSettings(settings, home);
  const model = new ScriptedModel([reply('one'), reply('two'), reply('three')]);
  const runtime = new AgentRuntime({ home, workspace, settings, model });
  cleanup(t, () => runtime.close());
  await runtime.harness.run('hi');
  let system = model.requests[0]!.system;
  assert.ok(system.startsWith('FROM HOME SYSTEM\n\n'), system.slice(0, 80));
  assert.match(system, /PROJECT RULES/);
  assert.match(system, /FROM HOME APPEND/);
  assert.ok(
    !system.split('PROJECT RULES')[0]!.includes('Circle'),
    "Circle's own instructions are replaced",
  );
  // The project's files come first; the data folder's APPEND_SYSTEM.md still applies.
  writeFileSync(join(workspace, '.circle', 'SYSTEM.md'), 'FROM PROJECT SYSTEM');
  await runtime.reloadIntegrations();
  await runtime.harness.run('again');
  system = model.requests[1]!.system;
  assert.ok(system.startsWith('FROM PROJECT SYSTEM'));
  assert.ok(!system.includes('FROM HOME SYSTEM'));
  assert.match(system, /FROM HOME APPEND/);
  writeFileSync(
    join(workspace, '.circle', 'APPEND_SYSTEM.md'),
    'FROM PROJECT APPEND',
  );
  runtime.setThinkingLevel('low');
  await runtime.harness.run('once more');
  system = model.requests[2]!.system;
  assert.match(system, /FROM PROJECT APPEND/);
  assert.ok(!system.includes('FROM HOME APPEND'));
  // The command line wins over both, for the run.
  const run = defaultRunOptions();
  run.system_prompt = 'FLAG SYSTEM';
  run.append_system_prompt = ['FLAG APPEND'];
  const flagged = new ScriptedModel([reply('flag')]);
  const second = new AgentRuntime({
    home,
    workspace,
    settings,
    model: flagged,
    run,
  });
  cleanup(t, () => second.close());
  await second.harness.run('hi');
  system = flagged.requests[0]!.system;
  assert.ok(system.startsWith('FLAG SYSTEM'));
  assert.match(system, /PROJECT RULES/);
  assert.match(system, /FLAG APPEND/);
  assert.ok(!/FROM (PROJECT|HOME)/.test(system));
  // As in 0.5.0: an empty --system-prompt gives Circle's own instructions back, and a blank
  // file is not passed over for the next one.
  assert.deepEqual(
    promptOverrides(workspace, home, {
      system_prompt: '',
      append_system_prompt: [' '],
    }),
    { base: undefined, append: [] },
  );
  writeFileSync(join(workspace, '.circle', 'SYSTEM.md'), '  \n');
  assert.equal(
    promptOverrides(workspace, home, { append_system_prompt: [] }).base,
    undefined,
  );
});

test('skills are read again on every rebuild, and the list and the skill tool survive model switches, /reload and new sessions', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  const skills = join(workspace, '.circle', 'skills');
  mkdirSync(skills, { recursive: true });
  const bodies: Record<string, any>[] = [];
  const replies: ((response: ServerResponse) => void)[] = [];
  const sse = (response: ServerResponse, delta: unknown, finish: string) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(
      'data: ' +
        JSON.stringify({
          choices: [{ index: 0, delta, finish_reason: finish }],
        }) +
        '\n\ndata: [DONE]\n\n',
    );
  };
  const text = (content: string) => (response: ServerResponse) =>
    sse(response, { content }, 'stop');
  const instance = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    bodies.push(JSON.parse(body));
    (replies.shift() ?? text('ok'))(response);
  });
  await new Promise<void>((ready) =>
    instance.listen(0, '127.0.0.1', () => ready()),
  );
  cleanup(t, async () => {
    instance.closeAllConnections();
    await new Promise<void>((done) => instance.close(() => done()));
  });
  const address = instance.address();
  assert.ok(address && typeof address === 'object');
  let settings = defaultSettings();
  settings.initialized = true;
  settings.auth.base_url = `http://127.0.0.1:${address.port}/v1`;
  settings.auth.model = 'first-model';
  settings = trustFolder(settings, workspace);
  saveSettings(settings, home);
  saveCredentials({ api_key: 'test-key' }, home);
  skill(skills, 'early-skill', 'early skill marker');
  const runtime = new AgentRuntime({
    home,
    workspace,
    settings: loadSettings(home),
    catalog: new ModelCatalog(home, {
      env: { CIRCLE_NO_MODELS_REFRESH: '1' },
    }),
  });
  cleanup(t, () => runtime.close());
  const system = () => {
    const first = bodies.at(-1)!.messages[0];
    assert.equal(first.role, 'system');
    return String(first.content);
  };
  await runtime.harness.run('one');
  assert.match(system(), /- early-skill: early skill marker/);
  // Added mid-session, in a linked folder as `npx skills add` makes them.
  const elsewhere = join(root, 'shared');
  skill(elsewhere, 'late-skill', 'late skill marker');
  symlinkSync(
    join(elsewhere, 'late-skill'),
    join(skills, 'late-skill'),
    'junction',
  );
  runtime.setModel('second-model');
  replies.push(
    (response) =>
      sse(
        response,
        {
          tool_calls: [
            {
              index: 0,
              id: 'load',
              function: {
                name: 'skill',
                arguments: JSON.stringify({ name: 'late-skill' }),
              },
            },
          ],
        },
        'tool_calls',
      ),
    text('loaded'),
  );
  await runtime.harness.run('two');
  assert.equal(bodies.at(-1)!.model, 'second-model');
  assert.match(system(), /- early-skill: early skill marker/);
  assert.match(system(), /- late-skill: late skill marker/);
  const result = bodies
    .at(-1)!
    .messages.find((message: { role: string }) => message.role === 'tool');
  assert.match(String(result.content), /late-skill body marker/);
  // /reload: settings and integrations again, then the model.
  skill(skills, 'reload-skill', 'reload skill marker');
  await runtime.reloadIntegrations();
  runtime.setModel(runtime.options.settings.auth.model);
  await runtime.harness.run('three');
  assert.equal(bodies.at(-1)!.model, 'first-model');
  for (const name of ['early', 'late', 'reload'])
    assert.equal(count(system(), `- ${name}-skill: ${name} skill marker`), 1);
  skill(skills, 'new-session-skill', 'new session skill marker');
  await runtime.newSession();
  await runtime.harness.run('four');
  assert.match(system(), /- new-session-skill: new session skill marker/);
  assert.ok(runtime.skills.some((skill) => skill.name === 'new-session-skill'));
});

test('/mcp reload and /extensions reload rebuild the extension tool list instead of adding it again', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  skill(join(workspace, '.circle', 'skills'), 'kept-skill', 'kept marker');
  const extension = join(home, 'extensions', 'sample');
  mkdirSync(extension, { recursive: true });
  const schema = '{type:"object",properties:{}}';
  writeFileSync(
    join(extension, 'extension.mjs'),
    `export function register(api){api.registerTool('inspect','inspect marker',${schema},()=>'ok',{readOnly:true});api.registerSubagent({name:'inspector',description:'inspector marker',system_prompt:'x'},['inspect'])}`,
  );
  const settings = trustFolder(defaultSettings(), workspace);
  saveSettings(settings, home);
  const model = new ScriptedModel(
    Array.from({ length: 4 }, (_, index) => reply(String(index))),
  );
  const runtime = new AgentRuntime({ home, workspace, settings, model });
  cleanup(t, () => runtime.close());
  await runtime.harness.run('one');
  await runtime.reloadIntegrations();
  await runtime.reloadIntegrations();
  await runtime.harness.run('two');
  await runtime.newSession();
  await runtime.harness.run('three');
  runtime.setPlanMode(true);
  await runtime.harness.run('four');
  for (const request of model.requests) {
    assert.equal(count(request.system, 'Extension tools:'), 1);
    assert.equal(count(request.system, 'inspect: inspect marker'), 1);
    assert.equal(count(request.system, '- kept-skill: kept marker'), 1);
    const task = request.tools.find((tool) => tool.name === 'task')!;
    assert.match(task.description, /- inspector: inspector marker/);
  }
});
