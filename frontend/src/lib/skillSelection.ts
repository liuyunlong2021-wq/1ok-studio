import type { ScriptSkill } from './scriptEditorApi';

export type SelectableSkill = ScriptSkill & { aliases: string[]; displayName: string };

/** Merge only equal executable content; retain all stored records in the manager. */
export function selectableSkills(items: ScriptSkill[]): SelectableSkill[] {
  const groups = new Map<string, SelectableSkill>();
  for (const item of [...items].sort((a, b) => Number(b.is_builtin) - Number(a.is_builtin))) {
    if (item.hidden) continue;
    const content = item.content.replace(/\r\n/g, '\n').trim();
    const key = item.validation_error ? item.id : content;
    const existing = groups.get(key);
    if (existing) existing.aliases.push(item.id);
    else groups.set(key, { ...item, aliases: [item.id], displayName: item.name });
  }
  const result = Array.from(groups.values());
  const counts = new Map<string, number>();
  for (const item of result) {
    const name = item.name.trim().toLowerCase();
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const versions = new Map<string, number>();
  for (const item of result) {
    const name = item.name.trim().toLowerCase();
    const version = (versions.get(name) ?? 0) + 1;
    versions.set(name, version);
    if ((counts.get(name) ?? 0) > 1) item.displayName = `${item.name} · ${item.is_builtin ? '内置版' : `自定义版本 ${version}`}`;
    else if (item.is_builtin) item.displayName = `${item.name} · 内置`;
  }
  return result;
}
