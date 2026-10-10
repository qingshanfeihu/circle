import type { WorkbenchPlugin } from './types.ts';
const reservedPages = new Set([
  'sessions',
  'models',
  'skills',
  'commands',
  'mcp',
  'extensions',
  'tools',
  'approvals',
  'settings',
  'help',
]);
/** Ported from the shared workbench registry; first-party composition, not a sandbox. */
export class PluginRegistry {
  readonly plugins: readonly WorkbenchPlugin[];
  constructor(plugins: WorkbenchPlugin[]) {
    const ids = new Set<string>();
    const slots = new Set<string>();
    for (const plugin of plugins) {
      if (!/^[a-z][a-z0-9-]*$/.test(plugin.id) || ids.has(plugin.id))
        throw Error('duplicate or invalid plugin id: ' + plugin.id);
      ids.add(plugin.id);
      if (plugin.apiVersion !== 1)
        throw Error('unsupported plugin API: ' + plugin.id);
      for (const kind of [
        'pages',
        'panels',
        'widgets',
        'composerActions',
      ] as const) {
        for (const slot of plugin[kind] ?? []) {
          const id = slot.id;
          if (
            !/^[a-z][a-z0-9-]*$/.test(id) ||
            slots.has(kind + ':' + id) ||
            (kind === 'pages' && reservedPages.has(id)) ||
            (kind === 'panels' && id === 'context')
          )
            throw Error('duplicate or reserved contribution: ' + id);
          slots.add(kind + ':' + id);
        }
      }
      if (
        plugin.recordPage &&
        !plugin.pages?.some((page) => page.id === plugin.recordPage)
      )
        throw Error('record page is missing: ' + plugin.id);
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string) => {
      if (visiting.has(id)) throw Error('plugin dependency cycle: ' + id);
      if (visited.has(id)) return;
      const plugin = plugins.find((item) => item.id === id);
      if (!plugin) throw Error('missing plugin dependency: ' + id);
      visiting.add(id);
      for (const dependency of plugin.requires ?? []) visit(dependency);
      visiting.delete(id);
      visited.add(id);
    };
    for (const plugin of plugins) visit(plugin.id);
    this.plugins = plugins;
  }
  active(ids: readonly string[]) {
    let active = this.plugins.filter((plugin) => ids.includes(plugin.id));
    for (let index = 0; index < this.plugins.length; index++) {
      const names = new Set(active.map((plugin) => plugin.id));
      active = active.filter((plugin) =>
        (plugin.requires ?? []).every((id) => names.has(id)),
      );
    }
    return active;
  }
  change(ids: readonly string[], id: string, enabled: boolean) {
    const plugin = this.plugins.find((item) => item.id === id);
    if (!plugin) throw Error('plugin not installed');
    if (enabled) {
      const next = new Set(ids);
      const add = (value: WorkbenchPlugin) => {
        for (const dependency of value.requires ?? [])
          add(this.plugins.find((item) => item.id === dependency)!);
        next.add(value.id);
      };
      add(plugin);
      return [...next];
    }
    const dependent = this.active(ids).find((item) =>
      item.requires?.includes(id),
    );
    if (dependent) throw Error(`disable ${dependent.title} first`);
    return ids.filter((value) => value !== id);
  }
  pages(ids: readonly string[]) {
    return this.active(ids).flatMap((plugin) =>
      (plugin.pages ?? []).map((page) => ({ plugin, page })),
    );
  }
  widgets(ids: readonly string[], kind: 'widgets' | 'composerActions') {
    return this.active(ids).flatMap((plugin) =>
      (plugin[kind] ?? []).map((widget) => ({ plugin, widget })),
    );
  }
  recordPath(ids: readonly string[], pluginId: string, recordId: string) {
    const plugin = this.active(ids).find((item) => item.id === pluginId);
    return plugin?.recordPage
      ? `/page/${plugin.recordPage}?record=${encodeURIComponent(recordId)}`
      : undefined;
  }
}
