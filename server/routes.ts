import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import path from "path";
import { ReplitConnectors } from "@replit/connectors-sdk";

const isProduction = process.env.NODE_ENV === "production";
const FRESHTRADE_HTML = isProduction
  ? path.resolve(process.cwd(), "dist", "public", "freshtrade.html")
  : path.resolve(process.cwd(), "client", "public", "freshtrade.html");

const VALID_TABLES = [
  "products", "customers", "invoices", "routes", "salesOrders",
  "suppliers", "purchaseOrders", "salespeople", "creditMemos",
  "deliveries", "productionRuns", "receipts", "arPayments", "arDeposits", "arWriteOffs", "settings"
];

const ARRAY_TABLES = VALID_TABLES.filter(t => t !== "settings");

function validateTableData(tableName: string, data: any): { valid: boolean; error?: string } {
  if (tableName === "settings") {
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return { valid: false, error: "Settings must be an object" };
    }
    return { valid: true };
  }
  if (!Array.isArray(data)) {
    return { valid: false, error: `${tableName} must be an array` };
  }
  return { valid: true };
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  app.get("/api/data", async (_req, res) => {
    try {
      const data = await storage.getAllData();
      res.json(data);
    } catch (e: any) {
      console.error("Error loading data:", e);
      res.status(500).json({ error: "Failed to load data" });
    }
  });

  app.get("/api/data/:tableName", async (req, res) => {
    const { tableName } = req.params;
    if (!VALID_TABLES.includes(tableName)) {
      return res.status(400).json({ error: "Invalid table name" });
    }
    try {
      const data = await storage.getTableData(tableName);
      res.json(data);
    } catch (e: any) {
      console.error(`Error loading ${tableName}:`, e);
      res.status(500).json({ error: `Failed to load ${tableName}` });
    }
  });

  app.put("/api/data/:tableName", async (req, res) => {
    const { tableName } = req.params;
    if (!VALID_TABLES.includes(tableName)) {
      return res.status(400).json({ error: "Invalid table name" });
    }
    const validation = validateTableData(tableName, req.body);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }
    try {
      await storage.setTableData(tableName, req.body);
      res.json({ success: true });
    } catch (e: any) {
      console.error(`Error saving ${tableName}:`, e);
      res.status(500).json({ error: `Failed to save ${tableName}` });
    }
  });

  app.delete("/api/data/:tableName", async (req, res) => {
    const { tableName } = req.params;
    if (!VALID_TABLES.includes(tableName) || tableName === "settings") {
      return res.status(400).json({ error: "Invalid table name" });
    }
    try {
      await storage.setTableData(tableName, []);
      res.json({ success: true, cleared: tableName });
    } catch (e: any) {
      console.error(`Error clearing ${tableName}:`, e);
      res.status(500).json({ error: `Failed to clear ${tableName}` });
    }
  });

  app.post("/api/data/fix-duplicate-ids/:tableName", async (req, res) => {
    const { tableName } = req.params;
    if (!VALID_TABLES.includes(tableName) || tableName === "settings") {
      return res.status(400).json({ error: "Invalid table name" });
    }
    try {
      const data = await storage.getTableData(tableName);
      if (!Array.isArray(data)) return res.status(400).json({ error: "Not an array table" });
      const seen = new Set();
      let fixed = 0;
      const updated = data.map((item: any, idx: number) => {
        if (seen.has(item.id)) {
          const newId = `${item.id}-${Date.now().toString().slice(-4)}${String(idx).padStart(2, "0")}`;
          fixed++;
          return { ...item, id: newId };
        }
        seen.add(item.id);
        return item;
      });
      if (fixed > 0) {
        await storage.setTableData(tableName, updated);
      }
      res.json({ success: true, fixed, total: data.length });
    } catch (e: any) {
      console.error(`Error fixing IDs in ${tableName}:`, e);
      res.status(500).json({ error: `Failed to fix IDs in ${tableName}` });
    }
  });

  app.delete("/api/data/:tableName/:recordId", async (req, res) => {
    const { tableName, recordId } = req.params;
    if (!VALID_TABLES.includes(tableName) || tableName === "settings") {
      return res.status(400).json({ error: "Invalid table name" });
    }
    try {
      const data = await storage.getTableData(tableName);
      if (!Array.isArray(data)) return res.status(400).json({ error: "Not an array table" });
      const filtered = data.filter((r: any) => r.id !== recordId);
      if (filtered.length === data.length) return res.status(404).json({ error: "Record not found" });
      await storage.setTableData(tableName, filtered);
      res.json({ success: true, deleted: recordId, remaining: filtered.length });
    } catch (e: any) {
      console.error(`Error deleting from ${tableName}:`, e);
      res.status(500).json({ error: `Failed to delete from ${tableName}` });
    }
  });

  app.put("/api/data", async (req, res) => {
    if (typeof req.body !== "object" || req.body === null || Array.isArray(req.body)) {
      return res.status(400).json({ error: "Request body must be an object" });
    }
    for (const [key, value] of Object.entries(req.body)) {
      if (!VALID_TABLES.includes(key)) continue;
      const validation = validateTableData(key, value);
      if (!validation.valid) {
        return res.status(400).json({ error: `${key}: ${validation.error}` });
      }
    }
    try {
      await storage.setBulkData(req.body);
      res.json({ success: true });
    } catch (e: any) {
      console.error("Error saving bulk data:", e);
      res.status(500).json({ error: "Failed to save data" });
    }
  });

  app.post("/api/export", async (_req, res) => {
    try {
      const data = await storage.getAllData();
      data._v = "v4_6pin";
      data._exported = new Date().toISOString();
      data._app = "FreshTrade";
      res.json(data);
    } catch (e: any) {
      console.error("Error exporting:", e);
      res.status(500).json({ error: "Failed to export" });
    }
  });

  app.post("/api/import", async (req, res) => {
    try {
      const data = req.body;
      if (!data._app && !data._v) {
        return res.status(400).json({ error: "Invalid backup file" });
      }
      await storage.setBulkData(data);
      res.json({ success: true });
    } catch (e: any) {
      console.error("Error importing:", e);
      res.status(500).json({ error: "Failed to import" });
    }
  });

  app.post("/api/reset", async (_req, res) => {
    try {
      for (const table of VALID_TABLES) {
        await storage.setTableData(table, table === "settings" ? {} : []);
      }
      res.json({ success: true });
    } catch (e: any) {
      console.error("Error resetting:", e);
      res.status(500).json({ error: "Failed to reset" });
    }
  });

  // ── Stripe Payment Routes ──
  const connectors = new ReplitConnectors();

  async function stripeApi(endpoint: string, method: string, body?: any) {
    const options: any = { method };
    if (body) {
      options.headers = { "Content-Type": "application/x-www-form-urlencoded" };
      options.body = new URLSearchParams(body).toString();
    }
    const resp = await connectors.proxy("stripe", endpoint, options);
    const text = await resp.text();
    try { return JSON.parse(text); } catch { return { raw: text }; }
  }

  // Create Checkout Session for an invoice
  app.post("/api/stripe/create-checkout", async (req, res) => {
    try {
      const { invoiceId, customerName, amount, description, paymentMethods } = req.body;
      if (!amount || amount <= 0) return res.status(400).json({ error: "Invalid amount" });

      const host = req.headers.host || process.env.REPLIT_DOMAINS?.split(",")[0] || "localhost";
      const protocol = host.includes("localhost") ? "http" : "https";
      const baseUrl = `${protocol}://${host}`;

      const params: Record<string, string> = {
        "mode": "payment",
        "line_items[0][price_data][currency]": "usd",
        "line_items[0][price_data][unit_amount]": String(Math.round(amount * 100)),
        "line_items[0][price_data][product_data][name]": description || `Invoice ${invoiceId}`,
        "success_url": `${baseUrl}/api/stripe/success?session_id={CHECKOUT_SESSION_ID}&invoice_id=${encodeURIComponent(invoiceId)}`,
        "cancel_url": `${baseUrl}/api/stripe/cancel?invoice_id=${encodeURIComponent(invoiceId)}`,
        "metadata[invoice_id]": invoiceId,
        "metadata[customer_name]": customerName || "",
      };

      const methods = paymentMethods || ["card"];
      methods.forEach((m: string, i: number) => {
        params[`payment_method_types[${i}]`] = m;
      });

      const session = await stripeApi("/v1/checkout/sessions", "POST", params);
      if (session.error) {
        console.error("Stripe error:", session.error);
        return res.status(400).json({ error: session.error.message || "Stripe error" });
      }
      res.json({ url: session.url, sessionId: session.id });
    } catch (e: any) {
      console.error("Stripe checkout error:", e);
      res.status(500).json({ error: "Failed to create checkout session" });
    }
  });

  // Check payment status
  app.get("/api/stripe/session/:sessionId", async (req, res) => {
    try {
      const session = await stripeApi(`/v1/checkout/sessions/${req.params.sessionId}`, "GET");
      res.json({
        status: session.payment_status,
        amountTotal: session.amount_total ? session.amount_total / 100 : 0,
        customerEmail: session.customer_details?.email,
        invoiceId: session.metadata?.invoice_id,
      });
    } catch (e: any) {
      console.error("Stripe session check error:", e);
      res.status(500).json({ error: "Failed to check session" });
    }
  });

  // Payment success page
  app.get("/api/stripe/success", async (req, res) => {
    const { session_id, invoice_id } = req.query;
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Payment Successful</title>
      <style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f0fdf4}
      .card{background:#fff;border-radius:16px;padding:48px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:440px}
      .check{width:64px;height:64px;background:#22c55e;border-radius:50%;display:flex;align-items:center;justify-content:center;margin:0 auto 20px;font-size:32px;color:#fff}
      h1{color:#15803d;margin:0 0 8px}p{color:#64748b;margin:0 0 24px;font-size:15px}
      a{display:inline-block;padding:12px 32px;background:#1e293b;color:#fff;border-radius:8px;text-decoration:none;font-weight:600}</style>
      </head><body><div class="card"><div class="check">✓</div><h1>Payment Received</h1>
      <p>Thank you! Your payment for invoice <strong>${invoice_id || ""}</strong> has been processed successfully.</p>
      <a href="/freshtrade">Return to FreshTrade</a></div></body></html>`);
  });

  // Payment cancel page
  app.get("/api/stripe/cancel", async (_req, res) => {
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Payment Cancelled</title>
      <style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#fef2f2}
      .card{background:#fff;border-radius:16px;padding:48px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:440px}
      h1{color:#dc2626;margin:0 0 8px}p{color:#64748b;margin:0 0 24px;font-size:15px}
      a{display:inline-block;padding:12px 32px;background:#1e293b;color:#fff;border-radius:8px;text-decoration:none;font-weight:600}</style>
      </head><body><div class="card"><h1>Payment Cancelled</h1>
      <p>No payment was processed. You can try again from the payment link.</p>
      <a href="/freshtrade">Return to FreshTrade</a></div></body></html>`);
  });

  app.get("/freshtrade", (_req, res) => {
    res.sendFile(FRESHTRADE_HTML);
  });

  app.get("/app", (_req, res) => {
    res.sendFile(FRESHTRADE_HTML);
  });

  return httpServer;
}
