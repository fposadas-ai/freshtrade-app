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

### Catch Weight Tolerance Warnings
- **Tolerance Setting**: `settings.preferences.catchWeightTolerance` (default 5%)
- **Warning Detection**: When a piece weight deviates from expected (`avgWeightPerCase` or `avgWeightPerPiece`) by more than the tolerance %, a warning is shown
- **Visual Indicators**: Warning card turns orange (`#f59e0b`), shows ⚠️ icon, and displays a message like "⚠ Weight is 12% too high — expected ~8.5 lbs"
- **Apply Button**: Turns orange and shows warning count when there are active warnings; prompts confirmation before applying
- **Warning State**: `cwWarnings` state keyed by `"lineIdx-pieceIdx"`, stores `{ deviation, dir, expected, actual }`; cleared on invoice change or successful apply

### Label Customization (Shipping Labels)
- **Field Toggles**: Both Zebra and Sheet (Avery 5363) label settings now have full toggle sets: Category, Product, Unit Count, Address, Route, Delivery Date, Weight, Order, Invoice Number, Barcode
- **Invoice Number**: New `shippingShowInvoice` toggle (off by default). `buildLabels` accepts `invoices` param and includes `invoiceId` on each label. All three render functions (`renderShippingLabelHTML`, `renderShippingLabelAvery5363`, `renderShippingLabelSheet`) support it.
- **Field Ordering**: `SheetFieldOrder` component in Settings > Labels > Sheet section lets you reorder fields with up/down arrows. Stored in `labelsSheet.shippingFieldOrder` array. Avery 5363 render separates fields into top/left/right zones based on this order.
- **Barcode on Avery**: Avery 5363 labels now support barcode rendering, controlled by the Barcode toggle.
- **Field Order Sanitizer**: On load, any missing new fields are appended to existing `shippingFieldOrder` arrays to prevent stale saved settings.
- **Route-level labels**: Route print paths now use `buildLabels()` instead of manual label construction, ensuring all fields (including invoiceId) are consistent.

### Date-Based Route View
- **Date Navigator**: Command Center has a date selector bar with prev/next day arrows, "Today" button, date picker, and weekday display
- **Date Filtering**: All orders (pool + route panels) are filtered by `(deliveryDate || date) === routeDate`; only orders for the selected day are shown
- **Change Delivery Date**: Each order row has a calendar (📅) button that opens an inline date picker to move the order to a different day
- **Timezone-Safe Dates**: `today()` and `dueDate()` use local date components (getFullYear/getMonth/getDate) instead of UTC-based `toISOString()`
- **State**: `routeDate` defaults to `today()`, `changeDateTarget` stores `{id, orderType}` for inline date editing

### Routing Page Print Tracking
- **Print Status**: In-memory state tracks per-order print status (`pick`, `label`, `invoice`) with P/L/I indicators
- **Print Checkboxes**: Per-order checkboxes for selecting which invoices to print and which to include statements
- **Select All**: Button to toggle all orders for print selection
- **Print Marking**: Status marked as printed only when actual print execution occurs (not on modal open)
- Route view grid uses 11 columns (vs 8 for pool view) to accommodate print tracking columns

### Invoice Pagination (Print)
- **Row Capacity**: `ROWS_PAGE1 = ROWS_CONT = 13` — each page can hold 13 "slots" worth of line items
- **CW Slot Counting**: Catch-weight items with piece weights take multiple slots: 1-4 pieces = 2 slots, 5-8 pieces = 3 slots, 9+ pieces = 4 slots. Non-CW items = 1 slot.
- **Page Layout**: Each page div has a fixed height of `9.5in` with flexbox layout: header (flex-none), table area (flex-grow), footer with totals/signature (flex-none)
- **Print Margins**: `@page` margin is `0.5in 0.5in 0.6in 0.5in` (top/right/bottom/left), html2pdf margins match
- **Page Structure**: `fullHeader` on every page, `totalsBox` on last page only, `signatureFooter` + `pageFooter` on every page, "Continued on next page…" on non-last pages
- **Blank Fill Rows**: Pages are padded with empty alternating-color rows to fill remaining slot capacity

### USB Barcode Scanner (Proof of Delivery)
- **Toggle**: "Scanner" button in POD header toggles scanner mode on/off (green when active)
- **How it works**: USB barcode scanners act like keyboards — they type characters rapidly and end with Enter. The `useEffect` keydown listener captures rapid input (100ms buffer timeout) and processes on Enter.
- **Matching logic** (in `processScanCodeRef`): 1) Direct invoice ID match, 2) SO number prefix extraction (`SO-XXXX`), 3) Fuzzy numeric match
- **UI**: Green scanner status bar with pulsing dot, manual barcode input field, last scan result indicator
- **Barcode format from labels**: `SO-XXXX-PRODID-NNN` (order ID + product ID + sequence)
- **Manual entry**: Text input in scanner bar accepts manual barcode entry (Enter to submit)

### Customer Order History
- **Helper Function**: `getCustomerOrderHistory(custId, salesOrders, invoices)` computes per-product order history: count (times ordered), totalQty, avgQty, lastDate
- **Order Guide**: Product grid has a "History" column showing avg qty (blue) and order count for each product
- **Sales Order / Invoice Creation**: SpreadsheetGrid shows a "Hist" column when a customer is selected, computed via `useMemo`
- **Data Sources**: Aggregates from all non-cancelled SOs and non-voided invoices for the selected customer
- **Display**: Avg qty in blue monospace font, count as gray "Nx" text, tooltip shows full details

### Other Utilities
- **date-fns** — date manipulation
- **nanoid** — unique ID generation
- **class-variance-authority** + **clsx** + **tailwind-merge** — CSS class utilities
- **vaul** — drawer component
- **embla-carousel-react** — carousel
- **cmdk** — command menu