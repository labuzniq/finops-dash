# Static token login — design

**Date:** 2026-07-16
**Scope:** Add a gate in front of the dashboard. One shared admin token is the only
credential. A successful login sets a browser cookie so the token isn't asked again
for 8 hours. No Entra, no MSAL, no per-user identity. Deliberately minimal; the cookie
is a convenience flag, not a security boundary.

## Decisions

- **Only credential:** a single shared secret, `STATIC_LOGIN_TOKEN`, read from backend env.
- **Session:** on successful token match, backend sets an `httpOnly` cookie `dash_session`
  with `Max-Age` = 8h. Presence of the cookie = "logged in, don't ask for token".
- **Lifetime:** 8 hours. Browser drops the cookie on expiry; next visit shows login again.
- **Security posture:** explicitly relaxed per request. Plain string compare, constant cookie
  value, no signing. The cookie is forgeable and that is accepted — it exists to save keystrokes.

## Backend (`apps/api`)

- `env.ts` — add `STATIC_LOGIN_TOKEN` (string, defaulted so a fresh clone still boots).
- `auth/session.ts` — cookie name/value/max-age constants; `setSessionCookie`,
  `clearSessionCookie`, `hasSession(request)` (parses the `Cookie` header, zero deps).
- `routes/auth.ts`:
  - `POST /api/auth/login` — body `{ token }`; match → set cookie, `{ ok: true }`; mismatch → `401`.
  - `GET  /api/auth/me` — cookie present → `{ authenticated: true }`; else `401`.
  - `POST /api/auth/logout` — clear cookie, `{ ok: true }`.
- `app.ts` — register auth routes; add an `onRequest` guard that lets `/api/health` and
  `/api/auth/*` through and returns `401` for every other `/api/*` route without the cookie.

## Frontend (`apps/web`)

- `api/client.ts` — add `login(token)`, `fetchMe()`, `logout()`.
- `hooks/useAuth.ts` — state machine `resolving → authed | unauthed`; on mount calls `/api/auth/me`.
- `components/auth/LoginScreen.tsx` (+ CSS Module) — Nocturne-styled card, single token field,
  submit, inline error on bad token. Wrapped in the same `theme acc-blurple [dark]` shell.
- `components/auth/AuthGate.tsx` — wraps `<App/>`. `resolving` → spinner; `unauthed` → `LoginScreen`;
  `authed` → the dashboard. Login screen is always the gate; the app never renders without it.
- `main.tsx` — wrap `<App/>` in `<AuthGate/>`.

## What the operator must do

- Set `STATIC_LOGIN_TOKEN` in `.env` (and prod secrets) to the shared admin secret.
- Everyone who should get in uses that one token.

## Verification (no test framework in repo — drive the app)

- Fresh load with no cookie → login screen.
- Wrong token → inline error, no cookie.
- Right token → dashboard renders, cookie set.
- Reload → straight to dashboard (cookie honoured).
- `GET /api/seats` without cookie → `401`.
