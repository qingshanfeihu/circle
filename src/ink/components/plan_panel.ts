import type { Todo } from '../../tools.js';
import { palette, sgrJoin, statusLight } from '../theme.js';
import { pad, truncate, stringWidth } from '../string_width.js';
import { terminalText } from './markdown_renderer.js';
export const PLAN_ROWS = 5;
export function planStart(todos: Todo[]): number {
  let current = todos.findIndex((todo) => todo.status === 'in_progress');
  if (current < 0)
    current = todos.findIndex((todo) => todo.status !== 'completed');
  if (current < 0) current = todos.length - 1;
  return Math.max(0, Math.min(current - 2, todos.length - PLAN_ROWS));
}
export class PlanPanel {
  private todos: Todo[] = [];
  start = 0;
  update(todos: Todo[]): void {
    if (JSON.stringify(todos) !== JSON.stringify(this.todos))
      this.start = planStart(todos);
    this.todos = structuredClone(todos);
    this.start = Math.max(
      0,
      Math.min(this.start, this.todos.length - PLAN_ROWS),
    );
  }
  scroll(delta: number): void {
    this.start = Math.max(
      0,
      Math.min(this.start + delta, this.todos.length - PLAN_ROWS),
    );
  }
  follow(): void {
    this.start = planStart(this.todos);
  }
}
export function planRows(
  todos: Todo[],
  width: number,
  start = planStart(todos),
): string[] {
  if (!todos.length) return [];
  const p = palette();
  start = Math.max(0, Math.min(start, todos.length - PLAN_ROWS));
  const shown = todos.slice(start, start + PLAN_ROWS);
  const done = todos.filter((todo) => todo.status === 'completed').length;
  const lamp = todos.some((todo) => todo.status === 'in_progress')
    ? 'running'
    : done === todos.length
      ? 'ok'
      : 'none';
  const title = `${lamp === 'none' ? ' ' : ` ${statusLight(lamp)} `}Plan ${done}/${todos.length} `;
  const rows = [
    p.line +
      '┌─' +
      title +
      '─'.repeat(Math.max(0, width - stringWidth(title) - 3)) +
      '┐' +
      p.reset,
  ];
  shown.forEach((todo, index) => {
    const status =
      todo.status === 'completed'
        ? 'ok'
        : todo.status === 'in_progress'
          ? 'running'
          : 'none';
    const color =
      todo.status === 'completed'
        ? p.dim
        : todo.status === 'in_progress'
          ? p.em
          : p.text;
    const text = terminalText(todo.content).replace(/\s+/g, ' ').trim();
    const light = status === 'none' ? ' ' : statusLight(status);
    const glyph = status === 'none' ? ' ' : '●';
    const lightColor =
      status === 'none' ? color : light.slice(0, light.indexOf('●'));
    const label = ` ${String(start + index + 1).padStart(2)}  ${truncate(text, Math.max(1, width - 10))}`;
    const cell =
      ' ' +
      sgrJoin(p.think_bg, lightColor) +
      glyph +
      sgrJoin(p.think_bg, color) +
      label;
    rows.push(
      p.line +
        '│' +
        sgrJoin(p.think_bg, color) +
        pad(cell, width - 2) +
        p.reset +
        p.line +
        '│' +
        p.reset,
    );
  });
  const range =
    todos.length > shown.length
      ? ` ${start + 1}–${start + shown.length} / ${todos.length} `
      : '';
  rows.push(
    p.line +
      '└' +
      '─'.repeat(Math.max(0, width - stringWidth(range) - 3)) +
      p.dim +
      range +
      p.line +
      '─┘' +
      p.reset,
  );
  return rows;
}
