import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import path from "path";
import {
  getAuthUrl,
  handleCallback,
  getConnectionStatus,
  disconnect,
  syncCustomerToQB,
  syncInvoiceToQB,
  syncAllCustomers,
  syncAllInvoices,
} from "./quickbooks";

const VALID_TABLES = [
  "products", "customers", "invoices", "routes", "salesOrders",
  "suppliers", "purchaseOrders", "salespeople", "creditMemos",
  "deliveries", "productionRuns", "receipts", "settings"
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

  app.get("/api/quickbooks/auth", async (_req, res) => {
    try {
      const authUrl = await getAuthUrl();
      res.json({ url: authUrl });
    } catch (e: any) {
      console.error("QB auth error:", e);
      res.status(500).json({ error: "Failed to generate auth URL" });
    }
  });

  app.get("/api/quickbooks/callback", async (req, res) => {
    try {
      const fullUrl = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
      const result = await handleCallback(fullUrl);
      if (result.success) {
        res.redirect("/freshtrade?qb=connected");
      } else {
        res.redirect(`/freshtrade?qb=error&msg=${encodeURIComponent(result.error || "Unknown error")}`);
      }
    } catch (e: any) {
      console.error("QB callback error:", e);
      res.redirect(`/freshtrade?qb=error&msg=${encodeURIComponent(e.message)}`);
    }
  });

  app.get("/api/quickbooks/status", async (_req, res) => {
    try {
      const status = await getConnectionStatus();
      res.json(status);
    } catch (e: any) {
      console.error("QB status error:", e);
      res.status(500).json({ error: "Failed to check QB status" });
    }
  });

  app.post("/api/quickbooks/disconnect", async (_req, res) => {
    try {
      await disconnect();
      res.json({ success: true });
    } catch (e: any) {
      console.error("QB disconnect error:", e);
      res.status(500).json({ error: "Failed to disconnect" });
    }
  });

  app.post("/api/quickbooks/sync/customer", async (req, res) => {
    try {
      const { customer } = req.body;
      if (!customer) return res.status(400).json({ error: "Customer data required" });
      const result = await syncCustomerToQB(customer);
      res.json(result);
    } catch (e: any) {
      console.error("QB customer sync error:", e);
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/quickbooks/sync/invoice", async (req, res) => {
    try {
      const { invoice, customer, products } = req.body;
      if (!invoice || !customer) return res.status(400).json({ error: "Invoice and customer data required" });
      const result = await syncInvoiceToQB(invoice, customer, products || []);
      res.json(result);
    } catch (e: any) {
      console.error("QB invoice sync error:", e);
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/quickbooks/sync/all-customers", async (_req, res) => {
    try {
      const customers = await storage.getTableData("customers");
      if (!Array.isArray(customers) || customers.length === 0) {
        return res.json({ synced: 0, errors: 0, details: [], message: "No customers to sync" });
      }
      const result = await syncAllCustomers(customers);
      res.json(result);
    } catch (e: any) {
      console.error("QB all customers sync error:", e);
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/quickbooks/sync/all-invoices", async (_req, res) => {
    try {
      const [invoices, customers, products] = await Promise.all([
        storage.getTableData("invoices"),
        storage.getTableData("customers"),
        storage.getTableData("products"),
      ]);
      if (!Array.isArray(invoices) || invoices.length === 0) {
        return res.json({ synced: 0, errors: 0, details: [], message: "No invoices to sync" });
      }
      const result = await syncAllInvoices(invoices, customers || [], products || []);
      res.json(result);
    } catch (e: any) {
      console.error("QB all invoices sync error:", e);
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/freshtrade", (_req, res) => {
    res.sendFile(path.resolve("client/public/freshtrade.html"));
  });

  app.get("/app", (_req, res) => {
    res.sendFile(path.resolve("client/public/freshtrade.html"));
  });

  return httpServer;
}
