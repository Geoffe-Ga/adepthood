/** Lower-cap snake-case core: collapse non-alnum runs to `_`, trim edge `_`. */
export function slugifyCore(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}
