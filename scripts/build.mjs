import { cp, mkdir } from 'node:fs/promises'

await mkdir('dist/ui/static', { recursive: true })
await cp('src/ui', 'dist/ui', {
  recursive: true,
  filter: (source) => source.endsWith('.html'),
})
await cp('src/ui/static', 'dist/ui/static', {
  recursive: true,
})
