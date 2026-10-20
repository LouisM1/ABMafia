import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PersonaPrompt } from '../shared/types.js';

export function loadPersonas(root: string): PersonaPrompt[] {
  const directory = resolve(root, 'personas');
  const manifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8'));
  if (manifest.personas?.length !== 11) throw new Error('Expected eleven personas in personas/manifest.json.');
  return manifest.personas.map((entry: { file: string; persona_id: string }) => {
    if (!/^[a-z-]+\.json$/.test(entry.file)) throw new Error('Invalid persona filename.');
    const p = JSON.parse(readFileSync(resolve(directory, entry.file), 'utf8'));
    if (p.persona_id !== entry.persona_id || p.schema_version !== manifest.persona_schema_version) throw new Error('Persona version or identity mismatch.');
    const ids = [...p.runtime_profile.core_behaviour_ids, ...p.runtime_profile.provisional_behaviour_ids];
    const behaviours = ids.map((id: string) => {
      const b = p.behaviour_records.find((b: { id: string }) => b.id === id);
      if (!b?.default_enabled) throw new Error('Runtime persona references a missing or disabled behaviour.');
      return { trigger: b.trigger, tendency: b.tendency };
    });
    return {
      id: p.persona_id, name: p.display_name, text: p.runtime_profile.text, behaviours,
      examples: p.examples.slice(0, 2).map((x: { situation: string; response_text: string }) => ({ situation: x.situation, response: x.response_text })),
    };
  });
}
