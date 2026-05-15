import { cp, mkdir, readdir } from 'node:fs/promises'

await mkdir('dist/ui/static', { recursive: true })
for (const entry of await readdir('src/ui', { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith('.html')) continue
  await cp(`src/ui/${entry.name}`, `dist/ui/${entry.name}`)
}
await cp('src/ui/static', 'dist/ui/static', {
  recursive: true,
})
