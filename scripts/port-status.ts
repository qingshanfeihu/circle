import { readFileSync } from 'node:fs';
interface Entry {
  category: string;
  status: string;
}
const inventory = JSON.parse(
  readFileSync('docs/development/port-inventory.json', 'utf8'),
) as { entries: Entry[] };
for (const category of [
  ...new Set(inventory.entries.map((item) => item.category)),
]) {
  const entries = inventory.entries.filter(
    (item) => item.category === category,
  );
  const statuses: Record<string, number> = {};
  for (const entry of entries)
    statuses[entry.status] = (statuses[entry.status] ?? 0) + 1;
  console.log(`${category}: ${entries.length} ${JSON.stringify(statuses)}`);
}
