export class ScreenRenderer {
  private previous: string[] = [];
  private previousParked = '';
  constructor(private write: (text: string) => void) {}
  render(rows: string[], cursor?: { row: number; col: number }): void {
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
    // Park the real cursor on the composer's own (the IME anchors its candidates there);
    // with no composer on screen it hides, or it stays wherever the paint left it.
    const parked = cursor
      ? `\x1b[${cursor.row};${cursor.col}H\x1b[?25h`
      : '\x1b[?25l';
    if (output || parked !== this.previousParked) output += parked;
    if (output) this.write(output);
    this.previous = [...rows];
    this.previousParked = parked;
  }
  invalidate(): void {
    this.previous = [];
    this.previousParked = '';
  }
}
