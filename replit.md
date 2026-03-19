# FreshTrade Distribution Management System

## Overview
FreshTrade is a comprehensive meat and seafood distribution management system designed to streamline business operations. It handles products, customers, invoices, sales orders, deliveries, purchase orders, suppliers, credit memos, routes, salespeople, production runs, and receipts. The system aims to provide a robust solution for managing complex distribution logistics.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend
The main application is a single-page React app served from `client/public/freshtrade.html` and `client/public/app.js`. It's a self-contained React 18 application loaded via CDN scripts, with all business logic, UI rendering, icons, and state management within `app.js`. A minimal React/TypeScript shell (`client/src/`) acts as a redirect to the main app, with `shadcn/ui` and `Radix UI` components configured for future use. State is managed using React hooks, and data is fetched via direct API calls. Client-side routing is handled by component state.

### Backend
The backend is an Express.js 5 server running on Node.js with TypeScript. It provides a REST API for data management, including fetching and saving tables, and integrates with Stripe for payment processing. Data is stored in a PostgreSQL database. During development, Vite runs in middleware mode within the Express server, while production builds use Vite for the client and esbuild for the server.

### Data Storage
PostgreSQL is the primary database, utilizing a `data_store` table for key-value storage of business data (products, customers, etc., as JSONB arrays) and a `users` table. Drizzle ORM is used for schema definition and migrations, while runtime queries directly use `pg.Pool`.

### Authentication
The system includes a user model with username/password fields, and dependencies for session-based authentication using `express-session`, `connect-pg-simple`, `passport`, and `passport-local` are configured, indicating a planned or partial implementation of session-based authentication.

### Core Features
- **Catch Weight Tolerance Warnings**: Implements warnings for product weight deviations, configurable via settings, with visual indicators and confirmation prompts.
- **Label Customization**: Provides comprehensive, field-order-based label designers for Zebra and sheet labels, allowing dynamic reordering and font size adjustments, with live previews.
- **Date-Based Route View**: Offers a date navigator in the Command Center to filter and manage orders by delivery date, with inline date editing capabilities.
- **Routing Page Print Tracking**: Tracks print status (pick, label, invoice) for individual orders on the routing page, with print selection checkboxes and status indicators.
- **Invoice Pagination**: Manages invoice printing with dynamic row capacity calculation, page layout, and consistent headers/footers across pages.
- **USB Barcode Scanner**: Supports USB barcode scanners for Proof of Delivery, processing rapid input to match invoice IDs or product IDs.
- **Order Guide**: A customer-specific product list manager allowing reordering and adding/removing products. Integrates with Sales Orders to pre-populate order grids.
- **Customer Order History**: Computes and displays per-product order history (count, total/avg quantity, last ordered date) for customers, visible in order guides and Sales Order/Invoice creation.
- **Pricing Center**: A dedicated module for admin/managers to manage product pricing, customer price levels, and apply bulk price adjustments, including real-time updates to open orders.
- **Reports Module**: Offers 8 types of reports (Customer Ledger, Product Ledger, Sales Report, etc.) with filtering options, print-friendly output, and data aggregation.

## External Dependencies

### Core Runtime
- **PostgreSQL**
- **Express 5**
- **Vite**

### UI Libraries
- **React 18**
- **Radix UI**
- **shadcn/ui**
- **Tailwind CSS**
- **Recharts**
- **Lucide React**
- **TanStack React Query**

### Forms & Validation
- **React Hook Form**
- **Zod**
- **drizzle-zod**

### Database & ORM
- **drizzle-orm**
- **drizzle-kit**
- **pg** (node-postgres)

### Authentication
- **express-session**
- **connect-pg-simple**
- **passport**
- **passport-local**

### Replit-specific
- `@replit/vite-plugin-runtime-error-modal`
- `@replit/vite-plugin-cartographer`
- `@replit/vite-plugin-dev-banner`

### Other Utilities
- **date-fns**
- **nanoid**
- **class-variance-authority**
- **clsx**
- **tailwind-merge**
- **vaul**
- **embla-carousel-react**
- **cmdk**