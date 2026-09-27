// Model/auth adapter only. Deep Agents owns all agent and tool execution.
import { JSONRPCServer } from "json-rpc-2.0";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { readFile, writeFile, rename, mkdir, chmod } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { renderImage, getImageDimensions } from "@earendil-works/pi-tui";

const send = (record) => process.stdout.write(JSON.stringify(record) + "\n");
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
let activeId;
const answers = new Map();
const exec = promisify(execFile);
let account;
async function privateFile(path) {
  if (process.platform === "win32") {
    account ??= exec("whoami", []).then(result => result.stdout.trim());
    await exec("icacls", [path, "/inheritance:r", "/grant:r", (await account) + ":(F)"]);
  } else {
    await chmod(path, 0o600);
  }
}

class FileCredentials {
  constructor(home) { this.path = join(home, "provider-credentials.json"); }
  async all() {
    try {
      const data = await readFile(this.path, "utf8");
      await privateFile(this.path);
      return JSON.parse(data);
    }
    catch (err) { if (err.code === "ENOENT") return {}; throw err; }
  }
  async read(id) { return (await this.all())[id]; }
  async list() { return Object.entries(await this.all()).map(([providerId, v]) => ({ providerId, type: v.type })); }
  async modify(id, fn) {
    await mkdir(join(this.path, ".."), { recursive: true });
    try { await writeFile(this.path, "{}", { flag: "wx", mode: 0o600 }); }
    catch (err) { if (err.code !== "EEXIST") throw err; }
    await privateFile(this.path);
    const release = await lockfile.lock(this.path, { retries: { retries: 30, minTimeout: 100, maxTimeout: 1000 } });
    try {
      const data = await this.all();
      const value = await fn(data[id]);
      if (value === null) delete data[id];
      else if (value !== undefined) data[id] = value;
      const temporary = this.path + ".tmp-" + process.pid;
      await writeFile(temporary, "", { flag: "wx", mode: 0o600 });
      await privateFile(temporary);
      await writeFile(temporary, JSON.stringify(data));
      await rename(temporary, this.path);
      return data[id];
    } finally { await release(); }
  }
  async delete(id) {
    await this.modify(id, () => Promise.resolve(null));
  }
}

const runtime = (home) => builtinModels({ credentials: new FileCredentials(home) });
const server = new JSONRPCServer();
server.addMethod("catalog", async ({ home }) => {
  const models = runtime(home);
  return models.getProviders().map(p => ({ id: p.id, name: p.name, oauth: !!p.auth.oauth,
    models: p.getModels() }));
});
server.addMethod("login", async ({ home, provider }) => {
  const models = runtime(home);
  await models.login(provider, "oauth", {
    notify: event => notify("auth_event", { request_id: activeId, event }),
    prompt: prompt => new Promise((resolve, reject) => {
      const promptId = String(activeId) + ":" + Math.random();
      answers.set(promptId, resolve);
      notify("auth_prompt", { request_id: activeId, prompt_id: promptId,
        prompt: { type: prompt.type, message: prompt.message, options: prompt.options } });
      prompt.signal?.addEventListener("abort", () => {
        answers.delete(promptId);
        notify("auth_prompt_cancelled", { prompt_id: promptId });
        reject(new Error("Prompt cancelled"));
      }, { once: true });
    }),
  });
  const p = models.getProvider(provider);
  return { provider, models: p.getModels().map(m => m.id) };
});
server.addMethod("logout", async ({ home, provider }) => {
  await runtime(home).logout(provider);
  return { logged_out: true };
});
server.addMethod("generate", async ({ home, provider, model, context, options, base_url }) => {
  const models = runtime(home);
  const selected = models.getModels(provider).find(m => m.id === model);
  if (!selected) throw new Error("Model is absent from the provider catalog; configure a LangChain compatible endpoint for custom IDs");
  const configured = base_url ? { ...selected, baseUrl: base_url } : selected;
  const stream = models.streamSimple(configured, context, { ...options, maxRetries: 0 });
  for await (const event of stream) {
    if (event.type === "text_delta" || event.type === "thinking_delta") {
      notify("model_delta", { request_id: activeId, type: event.type, delta: event.delta });
    }
  }
  const result = await stream.result();
  if (result.stopReason === "error" || result.stopReason === "aborted") throw new Error(result.errorMessage || result.stopReason);
  return result;
});
server.addMethod("image", async ({ data, mime_type, options }) => {
  const dimensions = getImageDimensions(data, mime_type);
  if (!dimensions) throw new Error("Unsupported image");
  return renderImage(data, dimensions, options);
});

// Strict LF framing; Unicode separators inside a JSON string are content.
let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  pending += chunk;
  let at;
  while ((at = pending.indexOf("\n")) !== -1) {
    const line = pending.slice(0, at); pending = pending.slice(at + 1);
    if (!line.trim()) continue;
    let request;
    try { request = JSON.parse(line); }
    catch { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } }); continue; }
    if (request.method === "auth_answer") {
      const resolve = answers.get(request.params.prompt_id);
      if (resolve) { answers.delete(request.params.prompt_id); resolve(request.params.answer); }
      continue;
    }
    activeId = request.id;
    server.receive(request).then(response => { if (response) send(response); });
  }
});
