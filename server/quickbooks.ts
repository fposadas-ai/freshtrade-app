import OAuthClient from "intuit-oauth";
import { storage } from "./storage";
import { randomBytes } from "crypto";

const QB_TOKEN_KEY = "qb_tokens";
const QB_STATE_KEY = "qb_oauth_state";

function getRedirectUri(): string {
  if (process.env.QB_REDIRECT_URI) {
    return process.env.QB_REDIRECT_URI;
  }
  const domain = process.env.REPLIT_DOMAINS?.split(",")[0] || process.env.REPLIT_DEV_DOMAIN;
  if (domain) {
    return `https://${domain}/api/quickbooks/callback`;
  }
  return "http://localhost:5000/api/quickbooks/callback";
}

function getEnvironment(): string {
  return process.env.QB_ENVIRONMENT === "production" ? "production" : "sandbox";
}

function createOAuthClient(): OAuthClient {
  return new OAuthClient({
    clientId: process.env.QB_CLIENT_ID!,
    clientSecret: process.env.QB_CLIENT_SECRET!,
    environment: getEnvironment(),
    redirectUri: getRedirectUri(),
  });
}

export interface QBTokens {
  accessToken: string;
  refreshToken: string;
  realmId: string;
  expiresAt: number;
  refreshExpiresAt: number;
  companyName?: string;
}

function sanitizeForQBQuery(value: string): string {
  return value.replace(/[\\']/g, "\\$&").replace(/[^\x20-\x7E]/g, "");
}

async function saveTokens(tokens: QBTokens): Promise<void> {
  await storage.setTableData(QB_TOKEN_KEY, tokens);
}

async function loadTokens(): Promise<QBTokens | null> {
  const data = await storage.getTableData(QB_TOKEN_KEY);
  if (!data || !data.accessToken) return null;
  return data as QBTokens;
}

async function getValidClient(): Promise<{ client: OAuthClient; realmId: string } | null> {
  const tokens = await loadTokens();
  if (!tokens) return null;

  if (Date.now() >= tokens.refreshExpiresAt) {
    await storage.setTableData(QB_TOKEN_KEY, {});
    return null;
  }

  const client = createOAuthClient();
  client.setToken({
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    token_type: "bearer",
    expires_in: Math.floor((tokens.expiresAt - Date.now()) / 1000),
    x_refresh_token_expires_in: Math.floor((tokens.refreshExpiresAt - Date.now()) / 1000),
    realmId: tokens.realmId,
  });

  if (Date.now() >= tokens.expiresAt - 60000) {
    try {
      const authResponse = await client.refresh();
      const newToken = authResponse.getJson();
      const updatedTokens: QBTokens = {
        accessToken: newToken.access_token,
        refreshToken: newToken.refresh_token,
        realmId: tokens.realmId,
        expiresAt: Date.now() + newToken.expires_in * 1000,
        refreshExpiresAt: Date.now() + newToken.x_refresh_token_expires_in * 1000,
        companyName: tokens.companyName,
      };
      await saveTokens(updatedTokens);
      client.setToken({
        access_token: newToken.access_token,
        refresh_token: newToken.refresh_token,
        token_type: "bearer",
        expires_in: newToken.expires_in,
        x_refresh_token_expires_in: newToken.x_refresh_token_expires_in,
        realmId: tokens.realmId,
      });
    } catch (e) {
      console.error("Failed to refresh QB token:", e);
      await storage.setTableData(QB_TOKEN_KEY, {});
      return null;
    }
  }

  return { client, realmId: tokens.realmId };
}

export async function getAuthUrl(): Promise<string> {
  const state = randomBytes(24).toString("hex");
  await storage.setTableData(QB_STATE_KEY, { state, createdAt: Date.now() });
  const client = createOAuthClient();
  return client.authorizeUri({
    scope: [OAuthClient.scopes.Accounting],
    state,
  });
}

export async function handleCallback(url: string): Promise<{ success: boolean; error?: string }> {
  const parsedUrl = new URL(url, "http://localhost");
  const returnedState = parsedUrl.searchParams.get("state") || "";

  const storedStateData = await storage.getTableData(QB_STATE_KEY);
  const storedState = storedStateData?.state;
  const stateCreatedAt = storedStateData?.createdAt || 0;

  await storage.setTableData(QB_STATE_KEY, {});

  if (!storedState || storedState !== returnedState) {
    return { success: false, error: "Invalid OAuth state — possible CSRF attack" };
  }

  if (Date.now() - stateCreatedAt > 10 * 60 * 1000) {
    return { success: false, error: "OAuth state expired — please try connecting again" };
  }

  const redirectUri = getRedirectUri();
  const callbackUrl = new URL(redirectUri);
  callbackUrl.search = parsedUrl.search;
  const fullUrl = callbackUrl.toString();

  const client = createOAuthClient();
  try {
    const authResponse = await client.createToken(fullUrl);
    const token = authResponse.getJson();
    const realmId = parsedUrl.searchParams.get("realmId") || "";

    let companyName = "";
    try {
      const companyInfo = await client.makeApiCall({
        url: `https://${getEnvironment() === "production" ? "" : "sandbox-"}quickbooks.api.intuit.com/v3/company/${realmId}/companyinfo/${realmId}?minorversion=65`,
        method: "GET",
        headers: { Accept: "application/json" },
      });
      const body = JSON.parse(companyInfo.text());
      companyName = body?.CompanyInfo?.CompanyName || "";
    } catch {
      companyName = "";
    }

    const tokens: QBTokens = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      realmId,
      expiresAt: Date.now() + token.expires_in * 1000,
      refreshExpiresAt: Date.now() + token.x_refresh_token_expires_in * 1000,
      companyName,
    };
    await saveTokens(tokens);
    return { success: true };
  } catch (e: any) {
    console.error("QB OAuth callback error:", e);
    return { success: false, error: e.message || "OAuth failed" };
  }
}

export async function getConnectionStatus(): Promise<{
  connected: boolean;
  companyName?: string;
  realmId?: string;
  environment?: string;
  redirectUri?: string;
}> {
  const tokens = await loadTokens();
  if (!tokens) {
    return { connected: false, redirectUri: getRedirectUri(), environment: getEnvironment() };
  }

  if (Date.now() >= tokens.refreshExpiresAt) {
    return { connected: false, redirectUri: getRedirectUri(), environment: getEnvironment() };
  }

  return {
    connected: true,
    companyName: tokens.companyName || "QuickBooks Company",
    realmId: tokens.realmId,
    environment: getEnvironment(),
    redirectUri: getRedirectUri(),
  };
}

export async function disconnect(): Promise<void> {
  const result = await getValidClient();
  if (result) {
    try {
      await result.client.revoke({ access_token: result.client.getToken().access_token });
    } catch {
    }
  }
  await storage.setTableData(QB_TOKEN_KEY, {});
}

async function makeQBRequest(method: string, endpoint: string, body?: any): Promise<any> {
  const result = await getValidClient();
  if (!result) throw new Error("Not connected to QuickBooks");

  const baseUrl = getEnvironment() === "production"
    ? "https://quickbooks.api.intuit.com"
    : "https://sandbox-quickbooks.api.intuit.com";

  const url = `${baseUrl}/v3/company/${result.realmId}${endpoint}`;

  const response = await result.client.makeApiCall({
    url,
    method,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  return JSON.parse(response.text());
}

export async function syncCustomerToQB(customer: any): Promise<{ success: boolean; qbId?: string; error?: string }> {
  try {
    const safeName = sanitizeForQBQuery(customer.name);
    const queryResult = await makeQBRequest(
      "GET",
      `/query?query=${encodeURIComponent("SELECT * FROM Customer WHERE DisplayName = '" + safeName + "'")}&minorversion=65`
    );

    const existing = queryResult?.QueryResponse?.Customer?.[0];

    if (existing) {
      return { success: true, qbId: existing.Id };
    }

    const qbCustomer: any = {
      DisplayName: customer.name,
      CompanyName: customer.name,
    };

    if (customer.email) {
      qbCustomer.PrimaryEmailAddr = { Address: customer.email };
    }
    if (customer.phone) {
      qbCustomer.PrimaryPhone = { FreeFormNumber: customer.phone };
    }
    if (customer.address) {
      const parts = customer.address.split(",").map((p: string) => p.trim());
      qbCustomer.BillAddr = {
        Line1: parts[0] || "",
        City: parts[1] || "",
        CountrySubDivisionCode: parts[2]?.split(" ")[0] || "",
        PostalCode: parts[2]?.split(" ")[1] || "",
      };
    }
    if (customer.terms) {
      qbCustomer.Notes = `Terms: ${customer.terms}`;
    }

    const result = await makeQBRequest("POST", "/customer?minorversion=65", qbCustomer);
    return { success: true, qbId: result?.Customer?.Id };
  } catch (e: any) {
    console.error("Error syncing customer to QB:", e);
    return { success: false, error: e.message };
  }
}

export async function syncInvoiceToQB(invoice: any, customer: any, products: any[]): Promise<{ success: boolean; qbId?: string; error?: string }> {
  try {
    const safeDocNumber = sanitizeForQBQuery(invoice.id);
    const existingQuery = await makeQBRequest(
      "GET",
      `/query?query=${encodeURIComponent("SELECT * FROM Invoice WHERE DocNumber = '" + safeDocNumber + "'")}&minorversion=65`
    );
    const existingInvoice = existingQuery?.QueryResponse?.Invoice?.[0];
    if (existingInvoice) {
      return { success: true, qbId: existingInvoice.Id };
    }

    let qbCustomerId = customer.qbId;
    if (!qbCustomerId) {
      const custResult = await syncCustomerToQB(customer);
      if (!custResult.success) {
        return { success: false, error: `Failed to sync customer: ${custResult.error}` };
      }
      qbCustomerId = custResult.qbId;
    }

    const lines = (invoice.items || []).map((item: any, index: number) => {
      const product = products.find((p: any) => p.id === item.productId);
      return {
        DetailType: "SalesItemLineDetail",
        Amount: item.total || (item.qty * item.price),
        Description: product?.name || item.description || item.productId,
        SalesItemLineDetail: {
          Qty: item.qty || item.quantity || 1,
          UnitPrice: item.price || 0,
        },
        LineNum: index + 1,
      };
    });

    if (lines.length === 0) {
      lines.push({
        DetailType: "SalesItemLineDetail",
        Amount: invoice.total || 0,
        Description: `Invoice ${invoice.id}`,
        SalesItemLineDetail: {
          Qty: 1,
          UnitPrice: invoice.total || 0,
        },
        LineNum: 1,
      });
    }

    const qbInvoice: any = {
      CustomerRef: { value: qbCustomerId },
      Line: lines,
      DocNumber: invoice.id,
    };

    if (invoice.date) {
      qbInvoice.TxnDate = invoice.date;
    }
    if (invoice.dueDate) {
      qbInvoice.DueDate = invoice.dueDate;
    }

    const result = await makeQBRequest("POST", "/invoice?minorversion=65", qbInvoice);
    return { success: true, qbId: result?.Invoice?.Id };
  } catch (e: any) {
    console.error("Error syncing invoice to QB:", e);
    return { success: false, error: e.message };
  }
}

export async function syncAllCustomers(customers: any[]): Promise<{ synced: number; errors: number; details: any[] }> {
  const details: any[] = [];
  let synced = 0;
  let errors = 0;

  for (const customer of customers) {
    const result = await syncCustomerToQB(customer);
    if (result.success) {
      synced++;
      details.push({ id: customer.id, name: customer.name, qbId: result.qbId, status: "synced" });
    } else {
      errors++;
      details.push({ id: customer.id, name: customer.name, error: result.error, status: "error" });
    }
  }

  return { synced, errors, details };
}

export async function syncAllInvoices(
  invoices: any[],
  customers: any[],
  products: any[]
): Promise<{ synced: number; errors: number; details: any[] }> {
  const details: any[] = [];
  let synced = 0;
  let errors = 0;

  const customerQbIds: Record<string, string> = {};

  for (const inv of invoices) {
    const customer = customers.find((c: any) => c.id === inv.customerId);
    if (!customer) {
      errors++;
      details.push({ id: inv.id, error: "Customer not found", status: "error" });
      continue;
    }

    if (!customerQbIds[customer.id]) {
      const custResult = await syncCustomerToQB(customer);
      if (custResult.success && custResult.qbId) {
        customerQbIds[customer.id] = custResult.qbId;
      }
    }

    const customerWithQbId = { ...customer, qbId: customerQbIds[customer.id] };
    const result = await syncInvoiceToQB(inv, customerWithQbId, products);
    if (result.success) {
      synced++;
      details.push({ id: inv.id, qbId: result.qbId, status: "synced" });
    } else {
      errors++;
      details.push({ id: inv.id, error: result.error, status: "error" });
    }
  }

  return { synced, errors, details };
}

export async function syncSupplierToQB(supplier: any): Promise<{ success: boolean; qbId?: string; error?: string }> {
  try {
    const safeName = sanitizeForQBQuery(supplier.name);
    const queryResult = await makeQBRequest(
      "GET",
      `/query?query=${encodeURIComponent("SELECT * FROM Vendor WHERE DisplayName = '" + safeName + "'")}&minorversion=65`
    );

    const existing = queryResult?.QueryResponse?.Vendor?.[0];
    if (existing) {
      return { success: true, qbId: existing.Id };
    }

    const qbVendor: any = {
      DisplayName: supplier.name,
      CompanyName: supplier.name,
    };

    if (supplier.email) {
      qbVendor.PrimaryEmailAddr = { Address: supplier.email };
    }
    if (supplier.phone) {
      qbVendor.PrimaryPhone = { FreeFormNumber: supplier.phone };
    }
    if (supplier.address) {
      const parts = supplier.address.split(",").map((p: string) => p.trim());
      qbVendor.BillAddr = {
        Line1: parts[0] || "",
        City: parts[1] || "",
        CountrySubDivisionCode: parts[2]?.split(" ")[0] || "",
        PostalCode: parts[2]?.split(" ")[1] || "",
      };
    }
    if (supplier.terms) {
      qbVendor.Notes = `Terms: ${supplier.terms}`;
    }

    const result = await makeQBRequest("POST", "/vendor?minorversion=65", qbVendor);
    return { success: true, qbId: result?.Vendor?.Id };
  } catch (e: any) {
    console.error("Error syncing supplier to QB:", e);
    return { success: false, error: e.message };
  }
}

export async function syncAllSuppliers(suppliers: any[]): Promise<{ synced: number; errors: number; details: any[] }> {
  const details: any[] = [];
  let synced = 0;
  let errors = 0;

  for (const supplier of suppliers) {
    const result = await syncSupplierToQB(supplier);
    if (result.success) {
      synced++;
      details.push({ id: supplier.id, name: supplier.name, qbId: result.qbId, status: "synced" });
    } else {
      errors++;
      details.push({ id: supplier.id, name: supplier.name, error: result.error, status: "error" });
    }
  }

  return { synced, errors, details };
}

let cachedExpenseAccountId: string | null = null;

async function getExpenseAccountId(): Promise<string> {
  if (cachedExpenseAccountId) return cachedExpenseAccountId;
  try {
    const cogsQuery = await makeQBRequest(
      "GET",
      `/query?query=${encodeURIComponent("SELECT * FROM Account WHERE AccountType = 'Cost of Goods Sold' MAXRESULTS 1")}&minorversion=65`
    );
    const cogsAccount = cogsQuery?.QueryResponse?.Account?.[0];
    if (cogsAccount) {
      cachedExpenseAccountId = cogsAccount.Id;
      return cogsAccount.Id;
    }
    const expenseQuery = await makeQBRequest(
      "GET",
      `/query?query=${encodeURIComponent("SELECT * FROM Account WHERE AccountType = 'Expense' MAXRESULTS 1")}&minorversion=65`
    );
    const expenseAccount = expenseQuery?.QueryResponse?.Account?.[0];
    if (expenseAccount) {
      cachedExpenseAccountId = expenseAccount.Id;
      return expenseAccount.Id;
    }
  } catch (e) {
    console.error("Error querying expense account:", e);
  }
  return "1";
}

export async function syncBillToQB(po: any, supplier: any): Promise<{ success: boolean; qbId?: string; error?: string }> {
  try {
    const safeDocNumber = sanitizeForQBQuery(po.id);
    const existingQuery = await makeQBRequest(
      "GET",
      `/query?query=${encodeURIComponent("SELECT * FROM Bill WHERE DocNumber = '" + safeDocNumber + "'")}&minorversion=65`
    );
    const existingBill = existingQuery?.QueryResponse?.Bill?.[0];
    if (existingBill) {
      return { success: true, qbId: existingBill.Id };
    }

    let qbVendorId = supplier.qbId;
    if (!qbVendorId) {
      const vendResult = await syncSupplierToQB(supplier);
      if (!vendResult.success) {
        return { success: false, error: `Failed to sync vendor: ${vendResult.error}` };
      }
      qbVendorId = vendResult.qbId;
    }

    const expenseAccountId = await getExpenseAccountId();

    const lines = (po.lines || []).map((line: any, index: number) => ({
      DetailType: "AccountBasedExpenseLineDetail",
      Amount: (line.qtyOrdered || line.qty || 1) * (line.costPerUnit || line.price || 0),
      Description: line.description || line.productId || `Line ${index + 1}`,
      AccountBasedExpenseLineDetail: {
        AccountRef: { value: expenseAccountId },
      },
      LineNum: index + 1,
    }));

    if (lines.length === 0) {
      lines.push({
        DetailType: "AccountBasedExpenseLineDetail",
        Amount: po.total || 0,
        Description: `Purchase Order ${po.id}`,
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: expenseAccountId },
        },
        LineNum: 1,
      });
    }

    const qbBill: any = {
      VendorRef: { value: qbVendorId },
      Line: lines,
      DocNumber: po.id,
    };

    if (po.date) {
      qbBill.TxnDate = po.date;
    }
    if (po.expectedDate) {
      qbBill.DueDate = po.expectedDate;
    }

    const result = await makeQBRequest("POST", "/bill?minorversion=65", qbBill);
    return { success: true, qbId: result?.Bill?.Id };
  } catch (e: any) {
    console.error("Error syncing bill to QB:", e);
    return { success: false, error: e.message };
  }
}

export async function syncAllBills(
  purchaseOrders: any[],
  suppliers: any[]
): Promise<{ synced: number; errors: number; details: any[] }> {
  const details: any[] = [];
  let synced = 0;
  let errors = 0;

  const supplierQbIds: Record<string, string> = {};

  for (const po of purchaseOrders) {
    const supplier = suppliers.find((s: any) => s.id === po.supplierId);
    if (!supplier) {
      errors++;
      details.push({ id: po.id, error: "Supplier not found", status: "error" });
      continue;
    }

    if (!supplierQbIds[supplier.id]) {
      const vendResult = await syncSupplierToQB(supplier);
      if (vendResult.success && vendResult.qbId) {
        supplierQbIds[supplier.id] = vendResult.qbId;
      }
    }

    const supplierWithQbId = { ...supplier, qbId: supplierQbIds[supplier.id] };
    const result = await syncBillToQB(po, supplierWithQbId);
    if (result.success) {
      synced++;
      details.push({ id: po.id, qbId: result.qbId, status: "synced" });
    } else {
      errors++;
      details.push({ id: po.id, error: result.error, status: "error" });
    }
  }

  return { synced, errors, details };
}

export async function syncPaymentToQB(invoice: any, customer: any): Promise<{ success: boolean; qbId?: string; error?: string }> {
  try {
    if (!invoice.paymentAmount || invoice.paymentAmount <= 0) {
      return { success: false, error: "No payment amount recorded" };
    }

    const safeDocNumber = sanitizeForQBQuery(invoice.id);
    const invoiceQuery = await makeQBRequest(
      "GET",
      `/query?query=${encodeURIComponent("SELECT * FROM Invoice WHERE DocNumber = '" + safeDocNumber + "'")}&minorversion=65`
    );
    const qbInvoice = invoiceQuery?.QueryResponse?.Invoice?.[0];
    if (!qbInvoice) {
      const syncResult = await syncInvoiceToQB(invoice, customer, []);
      if (!syncResult.success) {
        return { success: false, error: "Invoice not found in QB and failed to create: " + syncResult.error };
      }
      const retryQuery = await makeQBRequest(
        "GET",
        `/query?query=${encodeURIComponent("SELECT * FROM Invoice WHERE DocNumber = '" + safeDocNumber + "'")}&minorversion=65`
      );
      const retryInvoice = retryQuery?.QueryResponse?.Invoice?.[0];
      if (!retryInvoice) {
        return { success: false, error: "Could not find invoice in QB after creation" };
      }
      return await createPaymentInQB(retryInvoice, invoice, customer);
    }

    return await createPaymentInQB(qbInvoice, invoice, customer);
  } catch (e: any) {
    console.error("Error syncing payment to QB:", e);
    return { success: false, error: e.message };
  }
}

async function createPaymentInQB(qbInvoice: any, localInvoice: any, customer: any): Promise<{ success: boolean; qbId?: string; error?: string }> {
  const payment: any = {
    CustomerRef: { value: qbInvoice.CustomerRef.value },
    TotalAmt: localInvoice.paymentAmount,
    Line: [{
      Amount: localInvoice.paymentAmount,
      LinkedTxn: [{
        TxnId: qbInvoice.Id,
        TxnType: "Invoice",
      }],
    }],
  };

  if (localInvoice.paymentMethod) {
    const methodMap: Record<string, string> = {
      cash: "Cash",
      check: "Check",
      credit: "Credit Card",
      "credit card": "Credit Card",
      ach: "ACH",
    };
    const mapped = methodMap[(localInvoice.paymentMethod || "").toLowerCase()];
    if (mapped) {
      payment.PaymentMethodRef = { name: mapped };
    }
  }

  if (localInvoice.checkNumber) {
    payment.PaymentRefNum = localInvoice.checkNumber;
  }

  const result = await makeQBRequest("POST", "/payment?minorversion=65", payment);
  return { success: true, qbId: result?.Payment?.Id };
}

export async function syncCreditMemoToQB(cm: any, customer: any): Promise<{ success: boolean; qbId?: string; error?: string }> {
  try {
    const safeDocNumber = sanitizeForQBQuery(cm.id);
    const existingQuery = await makeQBRequest(
      "GET",
      `/query?query=${encodeURIComponent("SELECT * FROM CreditMemo WHERE DocNumber = '" + safeDocNumber + "'")}&minorversion=65`
    );
    const existing = existingQuery?.QueryResponse?.CreditMemo?.[0];
    if (existing) {
      return { success: true, qbId: existing.Id };
    }

    let qbCustomerId = customer.qbId;
    if (!qbCustomerId) {
      const custResult = await syncCustomerToQB(customer);
      if (!custResult.success) {
        return { success: false, error: `Failed to sync customer: ${custResult.error}` };
      }
      qbCustomerId = custResult.qbId;
    }

    const lines = (cm.lines || []).map((line: any, index: number) => ({
      DetailType: "SalesItemLineDetail",
      Amount: line.total || 0,
      Description: line.description || line.productId || `Credit line ${index + 1}`,
      SalesItemLineDetail: {
        Qty: line.qty || 1,
        UnitPrice: line.priceEach || line.pricePerLb || 0,
      },
      LineNum: index + 1,
    }));

    if (lines.length === 0) {
      lines.push({
        DetailType: "SalesItemLineDetail",
        Amount: cm.total || 0,
        Description: `Credit Memo ${cm.id}`,
        SalesItemLineDetail: {
          Qty: 1,
          UnitPrice: cm.total || 0,
        },
        LineNum: 1,
      });
    }

    const qbCreditMemo: any = {
      CustomerRef: { value: qbCustomerId },
      Line: lines,
      DocNumber: cm.id,
    };

    if (cm.date) {
      qbCreditMemo.TxnDate = cm.date;
    }

    const result = await makeQBRequest("POST", "/creditmemo?minorversion=65", qbCreditMemo);
    return { success: true, qbId: result?.CreditMemo?.Id };
  } catch (e: any) {
    console.error("Error syncing credit memo to QB:", e);
    return { success: false, error: e.message };
  }
}

export async function pullVendorsFromQB(): Promise<{ imported: number; skipped: number; errors: number; details: any[] }> {
  const details: any[] = [];
  let imported = 0;
  let skipped = 0;
  let errors = 0;

  try {
    let startPosition = 1;
    const maxResults = 100;
    let hasMore = true;
    const allQBVendors: any[] = [];

    while (hasMore) {
      const queryResult = await makeQBRequest(
        "GET",
        `/query?query=${encodeURIComponent(`SELECT * FROM Vendor STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`)}&minorversion=65`
      );
      const vendors = queryResult?.QueryResponse?.Vendor || [];
      allQBVendors.push(...vendors);
      hasMore = vendors.length === maxResults;
      startPosition += maxResults;
    }

    const existingSuppliers: any[] = await storage.getTableData("suppliers") || [];
    const existingNames = new Set(existingSuppliers.map((s: any) => (s.name || "").toLowerCase().trim()));

    for (const qbVendor of allQBVendors) {
      const displayName = qbVendor.DisplayName || qbVendor.CompanyName || "";
      if (!displayName) continue;

      if (existingNames.has(displayName.toLowerCase().trim())) {
        skipped++;
        details.push({ name: displayName, qbId: qbVendor.Id, status: "skipped" });
        continue;
      }

      try {
        const addr = qbVendor.BillAddr;
        let address = "";
        if (addr) {
          const parts = [addr.Line1, addr.City, [addr.CountrySubDivisionCode, addr.PostalCode].filter(Boolean).join(" ")].filter(Boolean);
          address = parts.join(", ");
        }

        const newSupplier: any = {
          id: "S-" + Math.random().toString(36).substr(2, 6).toUpperCase(),
          name: displayName,
          contact: qbVendor.GivenName ? `${qbVendor.GivenName} ${qbVendor.FamilyName || ""}`.trim() : "",
          email: qbVendor.PrimaryEmailAddr?.Address || "",
          phone: qbVendor.PrimaryPhone?.FreeFormNumber || "",
          address: address,
          qbId: qbVendor.Id,
          terms: qbVendor.TermRef?.name || "Net 30",
          categories: [],
          notes: "",
          productIds: [],
          active: qbVendor.Active !== false,
        };

        existingSuppliers.push(newSupplier);
        existingNames.add(displayName.toLowerCase().trim());
        imported++;
        details.push({ name: displayName, qbId: qbVendor.Id, id: newSupplier.id, status: "imported" });
      } catch (e: any) {
        errors++;
        details.push({ name: displayName, qbId: qbVendor.Id, error: e.message, status: "error" });
      }
    }

    if (imported > 0) {
      await storage.setTableData("suppliers", existingSuppliers);
    }

    return { imported, skipped, errors, details };
  } catch (e: any) {
    console.error("Error pulling vendors from QB:", e);
    throw e;
  }
}

export async function pullPaymentStatusFromQB(): Promise<{ updated: number; details: any[] }> {
  const details: any[] = [];
  let updated = 0;

  try {
    const existingInvoices: any[] = await storage.getTableData("invoices") || [];
    let changed = false;

    for (const inv of existingInvoices) {
      if (inv.status === "paid" || inv.status === "voided") continue;

      try {
        const safeDocNumber = sanitizeForQBQuery(inv.id);
        const queryResult = await makeQBRequest(
          "GET",
          `/query?query=${encodeURIComponent("SELECT * FROM Invoice WHERE DocNumber = '" + safeDocNumber + "'")}&minorversion=65`
        );
        const qbInv = queryResult?.QueryResponse?.Invoice?.[0];
        if (!qbInv) continue;

        let newStatus = inv.status;
        if (qbInv.Balance === 0 && qbInv.TotalAmt > 0) {
          newStatus = "paid";
        } else if (qbInv.Balance < qbInv.TotalAmt && qbInv.Balance > 0) {
          newStatus = "partial";
        } else if (qbInv.DueDate && new Date(qbInv.DueDate) < new Date() && qbInv.Balance > 0) {
          newStatus = "overdue";
        }

        if (newStatus !== inv.status) {
          const oldStatus = inv.status;
          inv.status = newStatus;
          inv.balance = qbInv.Balance;
          changed = true;
          updated++;
          details.push({ id: inv.id, oldStatus, newStatus, balance: qbInv.Balance });
        }
      } catch {
        continue;
      }
    }

    if (changed) {
      await storage.setTableData("invoices", existingInvoices);
    }

    return { updated, details };
  } catch (e: any) {
    console.error("Error pulling payment status from QB:", e);
    throw e;
  }
}

export async function pullBillsFromQB(): Promise<{ imported: number; skipped: number; errors: number; details: any[] }> {
  const details: any[] = [];
  let imported = 0;
  let skipped = 0;
  let errors = 0;

  try {
    let startPosition = 1;
    const maxResults = 100;
    let hasMore = true;
    const allQBBills: any[] = [];

    while (hasMore) {
      const queryResult = await makeQBRequest(
        "GET",
        `/query?query=${encodeURIComponent(`SELECT * FROM Bill STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`)}&minorversion=65`
      );
      const bills = queryResult?.QueryResponse?.Bill || [];
      allQBBills.push(...bills);
      hasMore = bills.length === maxResults;
      startPosition += maxResults;
    }

    const existingPOs: any[] = await storage.getTableData("purchaseOrders") || [];
    const existingSuppliers: any[] = await storage.getTableData("suppliers") || [];
    const existingDocNumbers = new Set(existingPOs.map((po: any) => po.id));

    for (const qbBill of allQBBills) {
      const docNumber = qbBill.DocNumber || `QB-BILL-${qbBill.Id}`;

      if (existingDocNumbers.has(docNumber)) {
        skipped++;
        details.push({ id: docNumber, qbId: qbBill.Id, status: "skipped" });
        continue;
      }

      try {
        const vendorRef = qbBill.VendorRef;
        let supplierId = "";
        if (vendorRef) {
          const match = existingSuppliers.find((s: any) => s.qbId === vendorRef.value || (s.name || "").toLowerCase() === (vendorRef.name || "").toLowerCase());
          supplierId = match?.id || "";
        }

        const lines = (qbBill.Line || [])
          .filter((line: any) => line.DetailType === "AccountBasedExpenseLineDetail" || line.DetailType === "ItemBasedExpenseLineDetail")
          .map((line: any) => ({
            description: line.Description || "",
            productId: "",
            qtyOrdered: line.ItemBasedExpenseLineDetail?.Qty || 1,
            qtyReceived: 0,
            costPerUnit: line.ItemBasedExpenseLineDetail?.UnitPrice || line.Amount || 0,
            priceSet: true,
          }));

        let status = "pending";
        if (qbBill.Balance === 0 && qbBill.TotalAmt > 0) status = "received";

        const newPO: any = {
          id: docNumber,
          supplierId: supplierId,
          date: qbBill.TxnDate || "",
          expectedDate: qbBill.DueDate || "",
          status: status,
          notes: "",
          lines: lines,
          subtotal: qbBill.TotalAmt || 0,
          tax: 0,
          shippingCost: 0,
          total: qbBill.TotalAmt || 0,
          qbId: qbBill.Id,
        };

        existingPOs.push(newPO);
        existingDocNumbers.add(docNumber);
        imported++;
        details.push({ id: docNumber, qbId: qbBill.Id, status: "imported" });
      } catch (e: any) {
        errors++;
        details.push({ id: docNumber, qbId: qbBill.Id, error: e.message, status: "error" });
      }
    }

    if (imported > 0) {
      await storage.setTableData("purchaseOrders", existingPOs);
    }

    return { imported, skipped, errors, details };
  } catch (e: any) {
    console.error("Error pulling bills from QB:", e);
    throw e;
  }
}

export async function pullCustomersFromQB(): Promise<{ imported: number; skipped: number; errors: number; details: any[] }> {
  const details: any[] = [];
  let imported = 0;
  let skipped = 0;
  let errors = 0;

  try {
    let startPosition = 1;
    const maxResults = 100;
    let hasMore = true;
    const allQBCustomers: any[] = [];

    while (hasMore) {
      const queryResult = await makeQBRequest(
        "GET",
        `/query?query=${encodeURIComponent(`SELECT * FROM Customer STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`)}&minorversion=65`
      );
      const customers = queryResult?.QueryResponse?.Customer || [];
      allQBCustomers.push(...customers);
      hasMore = customers.length === maxResults;
      startPosition += maxResults;
    }

    const existingCustomers: any[] = await storage.getTableData("customers") || [];
    const existingNames = new Set(existingCustomers.map((c: any) => (c.name || "").toLowerCase().trim()));

    for (const qbCust of allQBCustomers) {
      const displayName = qbCust.DisplayName || qbCust.CompanyName || "";
      if (!displayName) continue;

      if (existingNames.has(displayName.toLowerCase().trim())) {
        skipped++;
        details.push({ name: displayName, qbId: qbCust.Id, status: "skipped" });
        continue;
      }

      try {
        const addr = qbCust.BillAddr;
        let address = "";
        if (addr) {
          const parts = [addr.Line1, addr.City, [addr.CountrySubDivisionCode, addr.PostalCode].filter(Boolean).join(" ")].filter(Boolean);
          address = parts.join(", ");
        }

        const newCustomer: any = {
          id: "C-" + Math.random().toString(36).substr(2, 6).toUpperCase(),
          name: displayName,
          email: qbCust.PrimaryEmailAddr?.Address || "",
          phone: qbCust.PrimaryPhone?.FreeFormNumber || "",
          address: address,
          qbId: qbCust.Id,
          terms: qbCust.SalesTermRef?.name || "",
          balance: qbCust.Balance || 0,
          active: qbCust.Active !== false,
        };

        existingCustomers.push(newCustomer);
        existingNames.add(displayName.toLowerCase().trim());
        imported++;
        details.push({ name: displayName, qbId: qbCust.Id, id: newCustomer.id, status: "imported" });
      } catch (e: any) {
        errors++;
        details.push({ name: displayName, qbId: qbCust.Id, error: e.message, status: "error" });
      }
    }

    if (imported > 0) {
      await storage.setTableData("customers", existingCustomers);
    }

    return { imported, skipped, errors, details };
  } catch (e: any) {
    console.error("Error pulling customers from QB:", e);
    throw e;
  }
}

export async function pullInvoicesFromQB(): Promise<{ imported: number; skipped: number; errors: number; details: any[] }> {
  const details: any[] = [];
  let imported = 0;
  let skipped = 0;
  let errors = 0;

  try {
    let startPosition = 1;
    const maxResults = 100;
    let hasMore = true;
    const allQBInvoices: any[] = [];

    while (hasMore) {
      const queryResult = await makeQBRequest(
        "GET",
        `/query?query=${encodeURIComponent(`SELECT * FROM Invoice STARTPOSITION ${startPosition} MAXRESULTS ${maxResults}`)}&minorversion=65`
      );
      const invoices = queryResult?.QueryResponse?.Invoice || [];
      allQBInvoices.push(...invoices);
      hasMore = invoices.length === maxResults;
      startPosition += maxResults;
    }

    const existingInvoices: any[] = await storage.getTableData("invoices") || [];
    const existingCustomers: any[] = await storage.getTableData("customers") || [];
    const existingDocNumbers = new Set(existingInvoices.map((i: any) => i.id));

    for (const qbInv of allQBInvoices) {
      const docNumber = qbInv.DocNumber || `QB-${qbInv.Id}`;

      if (existingDocNumbers.has(docNumber)) {
        skipped++;
        details.push({ id: docNumber, qbId: qbInv.Id, status: "skipped" });
        continue;
      }

      try {
        const custRef = qbInv.CustomerRef;
        let customerId = "";
        if (custRef) {
          const match = existingCustomers.find((c: any) => c.qbId === custRef.value || (c.name || "").toLowerCase() === (custRef.name || "").toLowerCase());
          customerId = match?.id || "";
        }

        const items = (qbInv.Line || [])
          .filter((line: any) => line.DetailType === "SalesItemLineDetail")
          .map((line: any) => ({
            description: line.Description || "",
            qty: line.SalesItemLineDetail?.Qty || 1,
            price: line.SalesItemLineDetail?.UnitPrice || 0,
            total: line.Amount || 0,
            productId: "",
          }));

        let status = "open";
        if (qbInv.Balance === 0 && qbInv.TotalAmt > 0) status = "paid";
        else if (qbInv.DueDate && new Date(qbInv.DueDate) < new Date()) status = "overdue";

        const newInvoice: any = {
          id: docNumber,
          customerId: customerId,
          date: qbInv.TxnDate || "",
          dueDate: qbInv.DueDate || "",
          items: items,
          total: qbInv.TotalAmt || 0,
          balance: qbInv.Balance || 0,
          status: status,
          qbId: qbInv.Id,
        };

        existingInvoices.push(newInvoice);
        existingDocNumbers.add(docNumber);
        imported++;
        details.push({ id: docNumber, qbId: qbInv.Id, status: "imported" });
      } catch (e: any) {
        errors++;
        details.push({ id: docNumber, qbId: qbInv.Id, error: e.message, status: "error" });
      }
    }

    if (imported > 0) {
      await storage.setTableData("invoices", existingInvoices);
    }

    return { imported, skipped, errors, details };
  } catch (e: any) {
    console.error("Error pulling invoices from QB:", e);
    throw e;
  }
}
