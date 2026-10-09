// What the welcome block shows, looked up when it can change rather than on every frame:
// the folder's own things, its recent sessions and the git branch (read again at most every
// two seconds). The lamps follow the session: unlit until the folder is trusted, blinking
// while it loads, green once loaded, red for an extension that failed.
import type { AgentRuntime } from '../runtime.js';
import type { CircleSettings } from '../settings.js';
import { isReady } from '../settings.js';
import { currentBranch } from '../git_info.js';
import { EFFORT_LEVELS } from '../model.js';
import type { LampState } from '../ink/theme.js';
import {
  age,
  type WelcomeInfo,
  type WelcomeItem,
} from '../ink/components/welcome.js';
import {
  folderInventory,
  folderItemText,
  type FolderItem,
} from './folder_inventory.js';
import { displayPath } from './status_rows.js';

export interface WelcomeInput {
  version: string;
  settings: CircleSettings;
  runtime?: AgentRuntime;
  // The session has loaded the folder's things.
  connected: boolean;
  trusted: boolean;
  // Setup is asking (first run or `--init`): no model until one is saved, lamps unlit.
  settingUp?: boolean;
}

export class WelcomeState {
  private key?: string;
  private items: FolderItem[] = [];
  private recent: [string, string][] = [];
  private more = 0;
  private branchAt = 0;
  private branchName = '';
  constructor(readonly workspace: string) {}

  branch(now = Date.now()): string {
    if (now - this.branchAt > 2000) {
      this.branchAt = now;
      this.branchName = currentBranch(this.workspace);
    }
    return this.branchName;
  }

  // Looked up again once the folder is trusted, once the session loads, and for a new session.
  private refresh(input: WelcomeInput, now: number): void {
    const runtime = input.runtime;
    const key = `${runtime?.session.id ?? ''}|${input.connected}|${input.trusted}`;
    if (key === this.key) return;
    this.key = key;
    try {
      this.items = folderInventory(this.workspace);
    } catch {
      this.items = [];
    }
    const saved =
      runtime?.store
        .list(this.workspace)
        .filter((session) => session.id !== runtime.session.id) ?? [];
    this.recent = saved
      .slice(0, 3)
      .map((session) => [
        session.title || '(untitled)',
        age(session.updated, now),
      ]);
    this.more = Math.max(0, saved.length - 3);
  }

  info(input: WelcomeInput, now = Date.now()): WelcomeInfo {
    const { settings, runtime } = input;
    this.refresh(input, now);
    const state: LampState =
      !input.trusted || input.settingUp
        ? 'none'
        : input.connected
          ? 'ok'
          : 'running';
    const failed = input.connected
      ? (runtime?.extensions.extensions ?? [])
          .filter((ext) => ext.source === 'project' && ext.error)
          .map((ext) => `${ext.name}: ${ext.error}`)
      : [];
    const items: WelcomeItem[] = this.items.map((item) => {
      const bad = item.kind === 'extensions' && failed.length > 0;
      return {
        kind: item.kind,
        text: folderItemText(item),
        state: bad ? 'error' : state,
        errors: bad ? failed : [],
      };
    });
    // Filled in as setup is answered: the model once the connection is saved.
    const ready = !input.settingUp && (Boolean(runtime) || isReady(settings));
    let model = ready
      ? (runtime?.harness.model.model ?? settings.auth.model)
      : '';
    const depth = runtime?.thinkingLevel ?? '';
    if (model && (EFFORT_LEVELS as readonly string[]).includes(depth))
      model += ` • ${depth}`;
    let endpoint = '';
    if (settings.auth.mode === 'oauth') endpoint = settings.auth.oauth_provider;
    else
      try {
        endpoint = new URL(settings.auth.base_url).hostname;
      } catch {
        endpoint = settings.auth.base_url;
      }
    return {
      version: input.version,
      model,
      endpoint: model ? endpoint : '',
      folder: displayPath(this.workspace),
      branch: this.branch(now),
      items,
      recent: this.recent,
      more: this.more,
    };
  }
}
