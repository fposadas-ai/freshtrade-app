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
