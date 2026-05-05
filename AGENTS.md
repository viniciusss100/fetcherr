# Repository Guidelines

## Project Structure & Module Organization

Fetcherr is a TypeScript/Fastify service with server-rendered UI assets.

- `src/index.ts` starts the app and wires core services.
- `src/ui/` contains UI routes, auth helpers, HTML templates, and static assets.
- `src/jellyfin/` implements Jellyfin-compatible endpoints.
- `src/db.ts`, `src/config.ts`, and provider modules such as `tmdb.ts`, `trakt.ts`, `rd.ts`, and `tvdb.ts` hold integration logic.
- `deploy/kubernetes/` contains Kubernetes manifests.
- `dist/` is generated build output; do not edit it directly.
- `data/` contains local SQLite runtime data and should be treated as environment-specific.

## Build, Test, and Development Commands

- `npm run dev` starts the app with `tsx` watch mode from `src/index.ts`.
- `npm run build` runs `tsc`, copies UI HTML, and copies `src/ui/static` into `dist/ui/static`.
- `npm start` runs the compiled app from `dist/index.js`.
- `docker compose up -d` runs the containerized service locally.
- `docker build -t fetcherr .` validates the production image build.

There is currently no `npm test` script.

## Coding Style & Naming Conventions

Use strict TypeScript with ES modules and `NodeNext` resolution. Match the existing style: two-space indentation, no semicolons, single quotes in TypeScript, and concise async functions. Prefer explicit names such as `loadStats`, `renderLibraryActionMenu`, and `setMovieReleaseMode`.

Keep UI changes in `src/ui/*.html` and `src/ui/static/app.css`; generated files in `dist/` should come only from `npm run build`.

## Testing Guidelines

No automated test framework is configured. For code changes, run `npm run build` at minimum. For UI changes, verify `/ui/login`, `/ui/dashboard`, `/ui/settings`, and affected modals in desktop and mobile widths. For integration changes, run locally with a disposable `DATABASE_PATH` and inspect logs for sync or playback errors.

## Commit & Pull Request Guidelines

Recent history uses short release commits plus descriptive imperative messages, for example `Release v1.2.4`, `Clarify GUI-first configuration`, and `UI: use consistent pill size for Hidden and Release Pending`.

Pull requests should include a summary, affected routes or services, validation steps, and screenshots for visible UI changes. Note any database schema, environment, provider, or Docker behavior changes.

## Security & Configuration Tips

Do not commit `.env`, API keys, Real-Debrid credentials, Trakt secrets, tokens, or SQLite databases. Most runtime settings belong in the web UI and database; `.env` should stay minimal. Preserve container hardening unless a deployment requirement justifies changing it.
