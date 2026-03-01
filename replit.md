# FreshTrade Distribution Management System

## Overview

FreshTrade is a meat and seafood distribution management system. The main application is a single-page React app (served from `client/public/freshtrade.html` and `client/public/app.js`) that manages business operations including products, customers, invoices, sales orders, deliveries, purchase orders, suppliers, credit memos, routes, salespeople, production runs, and receipts.

The React/TypeScript frontend in `client/src/` acts as a thin redirect layer that immediately sends users to `/freshtrade` (the actual app). The real application logic lives in the plain React + vanilla JS bundle at `client/public/app.js`.

The backend is an Express.js server that persists all data to a PostgreSQL database using a simple `data_store` table (key-value store with JSONB), plus a `users` table.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture

- **Main App**: `client/public/freshtrade.html` + `client/public/app.js` — a self-contained React 18 app loaded via CDN scripts (no build step). All business logic, UI rendering, icons, and state management live here.
- **React/TypeScript shell** (`client/src/`): Minimal — `App.tsx` just redirects to `/freshtrade`. The shadcn/ui component library is set up here but the main app doesn't use it directly.
- **UI Components**: Full shadcn/ui component library (`client/src/components/ui/`) using Radix UI primitives + Tailwind CSS, available for future use.
- **State Management**: useState/useEffect/useCallback hooks inside `app.js`. No external state library.
- **Data Fetching**: TanStack React Query is configured (`client/src/lib/queryClient.ts`) for the TypeScript side. The main app uses direct fetch calls to the REST API.
- **Routing**: No client-side router. Navigation is handled by component state within `app.js`.

### Backend Architecture

- **Framework**: Express.js 5 running on Node.js with TypeScript (via `tsx` in dev, esbuild bundle in production).
- **Entry Point**: `server/index.ts` creates an HTTP server, registers routes, and serves static files.
- **API Routes** (`server/routes.ts`):
  - `GET /api/data` — fetch all tables at once
  - `GET /api/data/:tableName` — fetch one table
  - `PUT /api/data/:tableName` — save one table
  - `PUT /api/data` (bulk) — save multiple tables
  - Table names are validated against a hardcoded allowlist
- **Storage Layer** (`server/storage.ts`): `DatabaseStorage` class wraps a `pg.Pool`. Uses raw SQL queries (not Drizzle ORM) for runtime data access. Drizzle is used only for schema definition and migrations.
- **Dev Server**: Vite runs in middleware mode inside the Express server during development (`server/vite.ts`).
- **Production Build**: `script/build.ts` runs Vite for the client and esbuild for the server, bundling key server dependencies to improve cold start.

### Data Storage

- **Database**: PostgreSQL (required via `DATABASE_URL` env var).
- **Schema** (`shared/schema.ts`):
  - `users` table: `id` (UUID), `username`, `password`
  - `data_store` table: `id`, `table_name` (unique), `data` (JSONB), `updated_at`
- **ORM**: Drizzle ORM is used for schema definition and migrations (`drizzle-kit push`). Runtime queries use raw `pg` Pool calls.
- **Data Model**: All business data (products, customers, invoices, etc.) is stored as JSONB arrays in `data_store`, keyed by table name. This is a flexible schema-less approach inside a relational DB.

### Authentication

- User model exists in the schema with username/password fields.
- `connect-pg-simple`, `express-session`, `passport`, and `passport-local` are listed as dependencies, suggesting session-based auth with Passport.js is planned or partially implemented, but not wired up in the current routes.

### Build & Development

- **Dev**: `npm run dev` → `tsx server/index.ts` (Vite middleware + Express)
- **Build**: `npm run build` → Vite builds client to `dist/public`, esbuild bundles server to `dist/index.cjs`
- **DB Migrations**: `npm run db:push` → `drizzle-kit push`
- **TypeScript**: Strict mode, paths aliased (`@/*` → `client/src/*`, `@shared/*` → `shared/*`)

## External Dependencies

### Core Runtime
- **PostgreSQL** — primary database; requires `DATABASE_URL` environment variable
- **Express 5** — HTTP server framework
- **Vite** — frontend build tool and dev server (middleware mode in development)

### UI Libraries
- **React 18** — UI framework (loaded via CDN in `freshtrade.html`; also bundled via Vite for the TS shell)
- **Radix UI** — full suite of accessible UI primitives (accordion, dialog, dropdown, select, tabs, toast, etc.)
- **shadcn/ui** — component library built on Radix UI + Tailwind (New York style)
- **Tailwind CSS** — utility-first CSS with custom theme tokens (HSL CSS variables, dark mode support)
- **Recharts** — charting (via `chart.tsx`)
- **Lucide React** — icon library
- **TanStack React Query** — server state management

### Forms & Validation
- **React Hook Form** + `@hookform/resolvers`
- **Zod** — schema validation
- **drizzle-zod** — generates Zod schemas from Drizzle table definitions

### Database & ORM
- **drizzle-orm** — schema definition and query builder
- **drizzle-kit** — migration tooling
- **pg** (node-postgres) — raw PostgreSQL client for runtime queries

### Auth (configured, partially implemented)
- **express-session** — session middleware
- **connect-pg-simple** — PostgreSQL session store
- **passport** + **passport-local** — authentication framework

### Replit-specific
- `@replit/vite-plugin-runtime-error-modal` — shows runtime errors in dev
- `@replit/vite-plugin-cartographer` — Replit dev tooling
- `@replit/vite-plugin-dev-banner` — Replit dev banner

### Other Utilities
- **date-fns** — date manipulation
- **nanoid** — unique ID generation
- **class-variance-authority** + **clsx** + **tailwind-merge** — CSS class utilities
- **vaul** — drawer component
- **embla-carousel-react** — carousel
- **cmdk** — command menu