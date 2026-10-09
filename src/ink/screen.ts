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
      if (row !== this.previous[index])
        output += `\x1b[${index + 1};1H` + row + '\x1b[K';
    }
    if (output) this.write(output);
    this.previous = [...rows];
  }
  invalidate(): void {
    this.previous = [];
  }
}
