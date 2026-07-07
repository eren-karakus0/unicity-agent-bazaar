import type { InputField } from './api';

/** A form's working value per field (strings from inputs, booleans from checkboxes). */
export type FieldValues = Record<string, string | boolean>;

/** Initial form values for a schema — empty strings, unchecked booleans. */
export function initialValues(schema: InputField[]): FieldValues {
  const v: FieldValues = {};
  for (const f of schema) v[f.name] = f.type === 'boolean' ? false : '';
  return v;
}

/** Coerce raw form values into the typed input object the agent receives. */
export function buildInput(schema: InputField[], values: FieldValues): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of schema) {
    const raw = values[f.name];
    if (f.type === 'boolean') {
      out[f.name] = raw === true;
    } else if (f.type === 'number') {
      const s = String(raw ?? '').trim();
      if (s !== '') out[f.name] = Number(s);
    } else {
      const s = String(raw ?? '').trim();
      if (s !== '') out[f.name] = s;
    }
  }
  return out;
}

/** The first unmet required field, or null if the values satisfy the schema. */
export function firstMissingRequired(schema: InputField[], values: FieldValues): InputField | null {
  for (const f of schema) {
    if (!f.required) continue;
    const raw = values[f.name];
    if (f.type === 'boolean') {
      if (raw !== true) return f;
    } else if (String(raw ?? '').trim() === '') {
      return f;
    }
  }
  return null;
}

/** A sample JSON input matching the schema — seeds the test-invocation console. */
export function sampleJson(schema: InputField[]): string {
  const obj: Record<string, unknown> = {};
  for (const f of schema) {
    obj[f.name] =
      f.type === 'boolean' ? false : f.type === 'number' ? 0 : (f.placeholder ?? `<${f.name}>`);
  }
  return JSON.stringify(obj, null, 2);
}
