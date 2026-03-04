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
  console.log("handleCallback called with url:", url);
  const parsedUrl = new URL(url, "http://localhost");
  const returnedState = parsedUrl.searchParams.get("state") || "";
  const errorParam = parsedUrl.searchParams.get("error");
  if (errorParam) {
    const errorDesc = parsedUrl.searchParams.get("error_description") || errorParam;
    console.error("QB OAuth returned error:", errorParam, errorDesc);
    return { success: false, error: `QuickBooks denied access: ${errorDesc}` };
  }

  const storedStateData = await storage.getTableData(QB_STATE_KEY);
  const storedState = storedStateData?.state;
  const stateCreatedAt = storedStateData?.createdAt || 0;
  console.log("State check — returned:", returnedState?.substring(0, 10) + "...", "stored:", storedState?.substring(0, 10) + "...");

  await storage.setTableData(QB_STATE_KEY, {});

  if (!storedState || storedState !== returnedState) {
    console.error("State mismatch! returned:", returnedState, "stored:", storedState);
    return { success: false, error: "Invalid OAuth state — please try connecting again" };
  }

  if (Date.now() - stateCreatedAt > 10 * 60 * 1000) {
    return { success: false, error: "OAuth state expired — please try connecting again" };
  }

  const redirectUri = getRedirectUri();
  const callbackUrl = new URL(redirectUri);
  callbackUrl.search = parsedUrl.search;
  const fullUrl = callbackUrl.toString();
  console.log("Token exchange URL:", fullUrl.substring(0, 80) + "...");

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
      const body = companyInfo.json || (companyInfo.body ? (typeof companyInfo.body === "string" ? JSON.parse(companyInfo.body) : companyInfo.body) : (typeof companyInfo.text === "function" ? JSON.parse(companyInfo.text()) : companyInfo));
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
  const tokens = await loadTokens();
  if (tokens) {
    try {
      const client = createOAuthClient();
      client.setToken({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        token_type: "bearer",
        expires_in: 3600,
        x_refresh_token_expires_in: 86400,
        realmId: tokens.realmId,
      });
      await client.revoke({ access_token: tokens.accessToken });
    } catch {
    }
  }
  await storage.setTableData(QB_TOKEN_KEY, {});
}

async function normalizeQBResponse(data: any): Promise<any> {
  if (!data || typeof data !== "object") return data;
  if (data.QueryResponse !== undefined) return data;
  if (data.queryResponse !== undefined || data.fault !== undefined) {
    if (data.fault?.error?.length) {
      const errMsg = data.fault.error.map((e: any) => e.message || e.detail || "Unknown QB error").join("; ");
      if (errMsg.includes("AuthorizationFailed") || errMsg.includes("3100") || errMsg.includes("401") || errMsg.includes("3200")) {
        await storage.setTableData(QB_TOKEN_KEY, {});
        throw new Error("QuickBooks authorization expired — please disconnect and reconnect to QuickBooks");
      }
      throw new Error("QuickBooks API error: " + errMsg);
    }
    const normalized: any = {};
    for (const [key, value] of Object.entries(data)) {
      const pascalKey = key.charAt(0).toUpperCase() + key.slice(1);
      normalized[pascalKey] = value;
    }
    return normalized;
  }
  return data;
}

async function getValidTokens(): Promise<{ accessToken: string; realmId: string } | null> {
  const tokens = await loadTokens();
  if (!tokens) return null;

  if (Date.now() >= tokens.refreshExpiresAt) {
    await storage.setTableData(QB_TOKEN_KEY, {});
    return null;
  }

  if (Date.now() >= tokens.expiresAt - 60000) {
    try {
      const client = createOAuthClient();
      client.setToken({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        token_type: "bearer",
        expires_in: Math.floor((tokens.expiresAt - Date.now()) / 1000),
        x_refresh_token_expires_in: Math.floor((tokens.refreshExpiresAt - Date.now()) / 1000),
        realmId: tokens.realmId,
      });
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
      return { accessToken: newToken.access_token, realmId: tokens.realmId };
    } catch (e) {
      console.error("Failed to refresh QB token:", e);
      await storage.setTableData(QB_TOKEN_KEY, {});
      return null;
    }
  }

  return { accessToken: tokens.accessToken, realmId: tokens.realmId };
}

async function makeQBRequest(method: string, endpoint: string, body?: any): Promise<any> {
  const tokenInfo = await getValidTokens();
  if (!tokenInfo) throw new Error("Not connected to QuickBooks");

  const baseUrl = getEnvironment() === "production"
    ? "https://quickbooks.api.intuit.com"
    : "https://sandbox-quickbooks.api.intuit.com";

  const url = `${baseUrl}/v3/company/${tokenInfo.realmId}${endpoint}`;

  const headers: Record<string, string> = {
    "Authorization": `Bearer ${tokenInfo.accessToken}`,
    "Accept": "application/json",
    "Content-Type": "application/json",
  };

  const fetchOptions: RequestInit = { method, headers };
  if (body) fetchOptions.body = JSON.stringify(body);

  const response = await fetch(url, fetchOptions);
  const parsed = await response.json();

  if (!response.ok) {
    const fault = parsed?.Fault || parsed?.fault;
    if (fault?.Error?.length || fault?.error?.length) {
      const errors = fault.Error || fault.error;
      const errMsg = errors.map((e: any) => e.Message || e.message || e.Detail || e.detail || "Unknown QB error").join("; ");
      if (response.status === 401 || response.status === 403) {
        await storage.setTableData(QB_TOKEN_KEY, {});
        throw new Error("QuickBooks authorization expired — please disconnect and reconnect to QuickBooks");
      }
      throw new Error("QuickBooks API error: " + errMsg);
    }
    throw new Error(`QuickBooks API error (${response.status}): ${response.statusText}`);
  }

  return parsed;
}

let _qbTermsCache: any[] | null = null;

async function getQBTerms(): Promise<any[]> {
  if (_qbTermsCache) return _qbTermsCache;
  try {
    const result = await makeQBRequest(
      "GET",
      `/query?query=${encodeURIComponent("SELECT * FROM Term MAXRESULTS 100")}&minorversion=65`
    );
    _qbTermsCache = result?.QueryResponse?.Term || [];
    return _qbTermsCache;
  } catch (e) {
    console.warn("Could not fetch QB terms:", e);
    return [];
  }
}

async function findQBTermId(termsName: string): Promise<string | null> {
  if (!termsName) return null;
  const qbTerms = await getQBTerms();
  const normalized = termsName.toLowerCase().replace(/\s+/g, " ").trim();
  const match = qbTerms.find((t: any) => (t.Name || "").toLowerCase().replace(/\s+/g, " ").trim() === normalized);
  if (match) return match.Id;
  const numMatch = termsName.match(/\d+/);
  if (numMatch) {
    const days = parseInt(numMatch[0]);
    const dayMatch = qbTerms.find((t: any) => t.DueDays === days);
    if (dayMatch) return dayMatch.Id;
  }
  return null;
}

function buildQBCustomerBody(customer: any) {
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
  return qbCustomer;
}

export async function syncCustomerToQB(customer: any): Promise<{ success: boolean; qbId?: string; error?: string }> {
  try {
    const safeName = sanitizeForQBQuery(customer.name);
    const queryResult = await makeQBRequest(
      "GET",
      `/query?query=${encodeURIComponent("SELECT * FROM Customer WHERE DisplayName = '" + safeName + "'")}&minorversion=65`
    );

    const existing = queryResult?.QueryResponse?.Customer?.[0];

    let termId: string | null = null;
    if (customer.terms) {
      termId = await findQBTermId(customer.terms);
    }

    if (existing) {
      const needsUpdate =
        (customer.terms && termId && existing.SalesTermRef?.value !== termId) ||
        (customer.email && existing.PrimaryEmailAddr?.Address !== customer.email) ||
        (customer.phone && existing.PrimaryPhone?.FreeFormNumber !== customer.phone);

      if (needsUpdate) {
        const updateBody: any = {
          Id: existing.Id,
          SyncToken: existing.SyncToken,
          DisplayName: existing.DisplayName,
          sparse: true,
        };
        if (customer.email) updateBody.PrimaryEmailAddr = { Address: customer.email };
        if (customer.phone) updateBody.PrimaryPhone = { FreeFormNumber: customer.phone };
        if (termId) updateBody.SalesTermRef = { value: termId };
        if (customer.address) {
          const parts = customer.address.split(",").map((p: string) => p.trim());
          updateBody.BillAddr = {
            Line1: parts[0] || "",
            City: parts[1] || "",
            CountrySubDivisionCode: parts[2]?.split(" ")[0] || "",
            PostalCode: parts[2]?.split(" ")[1] || "",
          };
        }
        await makeQBRequest("POST", "/customer?minorversion=65", updateBody);
      }
      return { success: true, qbId: existing.Id };
    }

    const qbCustomer = buildQBCustomerBody(customer);
    if (termId) {
      qbCustomer.SalesTermRef = { value: termId };
    }

    const result = await makeQBRequest("POST", "/customer?minorversion=65", qbCustomer);
    return { success: true, qbId: result?.Customer?.Id };
  } catch (e: any) {
    console.error("Error syncing customer to QB:", e);
    return { success: false, error: e.message };
  }
}

export async function syncInvoiceToQB(invoice: any, customer: any): Promise<{ success: boolean; qbId?: string; error?: string }> {
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

    const lines = [{
      DetailType: "SalesItemLineDetail",
      Amount: invoice.total || 0,
      Description: `Invoice ${invoice.id}`,
      SalesItemLineDetail: {
        Qty: 1,
        UnitPrice: invoice.total || 0,
      },
      LineNum: 1,
    }];

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
  customers: any[]
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
    const result = await syncInvoiceToQB(inv, customerWithQbId);
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
      const syncResult = await syncInvoiceToQB(invoice, customer);
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

    const lines = [{
      DetailType: "SalesItemLineDetail",
      Amount: cm.total || 0,
      Description: `Credit Memo ${cm.id}`,
      SalesItemLineDetail: {
        Qty: 1,
        UnitPrice: cm.total || 0,
      },
      LineNum: 1,
    }];

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
      console.log("QB Customer query raw keys:", Object.keys(queryResult || {}));
      console.log("QB Customer QueryResponse keys:", Object.keys(queryResult?.QueryResponse || {}));
      console.log("QB Customer query sample:", JSON.stringify(queryResult).substring(0, 500));
      const customers = queryResult?.QueryResponse?.Customer || [];
      console.log("QB Customers found:", customers.length);
      allQBCustomers.push(...customers);
      hasMore = customers.length === maxResults;
      startPosition += maxResults;
    }

    console.log("Total QB customers to process:", allQBCustomers.length);
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

        let status = "open";
        if (qbInv.Balance === 0 && qbInv.TotalAmt > 0) status = "paid";
        else if (qbInv.DueDate && new Date(qbInv.DueDate) < new Date()) status = "overdue";

        const newInvoice: any = {
          id: docNumber,
          customerId: customerId,
          date: qbInv.TxnDate || "",
          dueDate: qbInv.DueDate || "",
          items: [],
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
