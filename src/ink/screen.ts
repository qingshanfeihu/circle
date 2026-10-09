export class ScreenRenderer {
  private previous: string[] = [];
  constructor(private write: (text: string) => void) {}
  render(rows: string[]): void {
    let output = '';
    for (
      let index = 0;
      index < Math.max(rows.length, this.previous.length);
      index++
    ) {
      const row = rows[index] || '';
      // Erase before writing: after a full-width row the cursor sits on the last cell with
      // the wrap pending, and a trailing EL would erase that cell again on real terminals.
      if (row !== this.previous[index])
        output += `\x1b[${index + 1};1H\x1b[K` + row;
    }
    if (output) this.write(output);
    this.previous = [...rows];
  }
  invalidate(): void {
    this.previous = [];
  }
}
