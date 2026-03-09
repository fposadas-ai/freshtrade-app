function ReportsModule({ customers, invoices, arPayments, creditMemos, products, settings, showToast }) {
  const [reportType, setReportType] = useState("ledger");
  const [custId, setCustId] = useState("");
  const [dateFrom, setDateFrom] = useState(() => { const d = new Date(); d.setMonth(d.getMonth() - 1); return d.toISOString().slice(0, 10); });
  const [dateTo, setDateTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [generated, setGenerated] = useState(null);

  const fmt = v => "$" + (Number(v) || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fmtDate = d => { if (!d) return "—"; try { const dt = new Date(d + "T00:00:00"); return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); } catch(e) { return d; } };
  const inRange = d => { if (!d) return false; return d >= dateFrom && d <= dateTo; };
  const companyName = (settings && settings.company && settings.company.name) || "FreshTrade Distribution";

  const reports = [
    { id: "ledger", label: "Customer Ledger", desc: "All invoices, payments & credits for a customer", needsCust: true },
    { id: "purchases", label: "Purchase History", desc: "Products purchased by a customer over a date range", needsCust: true },
    { id: "payments", label: "Payment History", desc: "All payments made by a customer", needsCust: true },
    { id: "openar", label: "Open Receivables", desc: "All unpaid invoices across all customers", needsCust: false },
    { id: "sales", label: "Sales Report", desc: "Total sales by date range with customer breakdown", needsCust: false }
  ];

  const generateReport = () => {
    const rpt = reports.find(r => r.id === reportType);
    if (rpt.needsCust && !custId) { showToast("Select a customer first", "warn"); return; }
    const cust = customers.find(c => c.id === custId);

    if (reportType === "ledger") {
      const custInvs = invoices.filter(i => i.customerId === custId).sort((a, b) => (a.date || "").localeCompare(b.date || ""));
      const custPays = (arPayments || []).filter(p => p.status !== "void" && p.status !== "returned" && (p.appliedTo || []).some(a => { const inv = invoices.find(i => i.id === a.invoiceId); return inv && inv.customerId === custId; }));
      const custCMs = (creditMemos || []).filter(cm => cm.status !== "void" && cm.customerId === custId);
      const entries = [];
      custInvs.forEach(inv => entries.push({ date: inv.date, type: "Invoice", ref: inv.id, desc: inv.lines ? inv.lines.length + " items" : "", debit: inv.total || 0, credit: 0 }));
      custPays.forEach(p => { const custAmt = (p.appliedTo || []).filter(a => { const inv = invoices.find(i => i.id === a.invoiceId); return inv && inv.customerId === custId; }).reduce((s, a) => s + a.amount, 0); if (custAmt > 0) entries.push({ date: p.date, type: "Payment", ref: p.id || "—", desc: p.method || "", debit: 0, credit: custAmt }); });
      custCMs.forEach(cm => entries.push({ date: cm.date, type: "Credit Memo", ref: cm.id, desc: cm.reason || "", debit: 0, credit: cm.total || 0 }));
      entries.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
      let running = 0;
      entries.forEach(e => { running += e.debit - e.credit; e.balance = running; });
      setGenerated({ type: "ledger", title: "Customer Ledger — " + ((cust && cust.name) || ""), customer: cust, entries, totalDebit: entries.reduce((s, e) => s + e.debit, 0), totalCredit: entries.reduce((s, e) => s + e.credit, 0), balance: running });
    }

    if (reportType === "purchases") {
      const custInvs = invoices.filter(i => i.customerId === custId && inRange(i.date));
      const prodMap = {};
      custInvs.forEach(inv => {
        (inv.lines || []).forEach(l => {
          const pid = l.productId || "misc";
          const prod = products.find(p => p.id === pid);
          const name = (prod && prod.name) || l.description || l.name || "Item";
          const cat = (prod && prod.category) || "";
          const packSize = (prod && prod.packSize) || "";
          if (!prodMap[pid]) prodMap[pid] = { name, category: cat, packSize, qty: 0, weight: 0, amount: 0, invoices: [] };
          prodMap[pid].qty += Number(l.qty) || 0;
          prodMap[pid].weight += Number(l.actualWeight) || Number(l.estWeight) || Number(l.nominalWeight) || 0;
          prodMap[pid].amount += Number(l.total) || Number(l.amount) || 0;
          prodMap[pid].invoices.push(inv.id);
        });
      });
      const items = Object.values(prodMap).sort((a, b) => b.amount - a.amount);
      setGenerated({ type: "purchases", title: "Purchase History — " + ((cust && cust.name) || ""), customer: cust, dateFrom, dateTo, items, totalAmount: items.reduce((s, i) => s + i.amount, 0), invoiceCount: custInvs.length });
    }

    if (reportType === "payments") {
      const custPays = (arPayments || []).filter(p => p.status !== "void" && p.status !== "returned" && (p.appliedTo || []).some(a => { const inv = invoices.find(i => i.id === a.invoiceId); return inv && inv.customerId === custId; }));
      const entries = custPays.map(p => {
        const custAmt = (p.appliedTo || []).filter(a => { const inv = invoices.find(i => i.id === a.invoiceId); return inv && inv.customerId === custId; }).reduce((s, a) => s + a.amount, 0);
        const appliedInvs = (p.appliedTo || []).filter(a => { const inv = invoices.find(i => i.id === a.invoiceId); return inv && inv.customerId === custId; }).map(a => a.invoiceId);
        return { date: p.date, ref: p.id || "—", method: p.method || "—", checkNo: p.checkNumber || "", amount: custAmt, appliedTo: appliedInvs.join(", ") };
      }).sort((a, b) => (a.date || "").localeCompare(b.date || ""));
      setGenerated({ type: "payments", title: "Payment History — " + ((cust && cust.name) || ""), customer: cust, entries, totalPaid: entries.reduce((s, e) => s + e.amount, 0) });
    }

    if (reportType === "openar") {
      const openInvs = invoices.filter(i => i.status === "open").map(inv => {
        const cust = customers.find(c => c.id === inv.customerId);
        const paid = (arPayments || []).filter(p => p.status !== "void" && p.status !== "returned").reduce((s, p) => s + (p.appliedTo || []).filter(a => a.invoiceId === inv.id).reduce((ss, a) => ss + a.amount, 0), 0);
        const credits = (creditMemos || []).filter(cm => cm.invoiceId === inv.id && cm.status !== "void").reduce((s, cm) => s + (cm.total || 0), 0);
        const balance = Math.round(((inv.total || 0) - paid - credits) * 100) / 100;
        if (balance <= 0) return null;
        const daysPast = inv.dueDate ? Math.max(0, Math.floor((Date.now() - new Date(inv.dueDate + "T00:00:00").getTime()) / 86400000)) : 0;
        return { invId: inv.id, date: inv.date, dueDate: inv.dueDate, custName: (cust && cust.name) || "—", custId: inv.customerId, total: inv.total || 0, paid, credits, balance, daysPast, aging: daysPast <= 0 ? "Current" : daysPast <= 30 ? "1-30" : daysPast <= 60 ? "31-60" : daysPast <= 90 ? "61-90" : "90+" };
      }).filter(Boolean).sort((a, b) => b.daysPast - a.daysPast);
      const agingBuckets = { Current: 0, "1-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
      openInvs.forEach(i => { agingBuckets[i.aging] = (agingBuckets[i.aging] || 0) + i.balance; });
      setGenerated({ type: "openar", title: "Open Receivables Report", entries: openInvs, totalBalance: openInvs.reduce((s, i) => s + i.balance, 0), agingBuckets });
    }

    if (reportType === "sales") {
      const rangeInvs = invoices.filter(i => inRange(i.date) && i.status !== "voided");
      const byCustomer = {};
      rangeInvs.forEach(inv => {
        const cust = customers.find(c => c.id === inv.customerId);
        const name = (cust && cust.name) || "Unknown";
        if (!byCustomer[name]) byCustomer[name] = { count: 0, total: 0 };
        byCustomer[name].count++;
        byCustomer[name].total += inv.total || 0;
      });
      const custBreakdown = Object.entries(byCustomer).map(([name, d]) => ({ name, count: d.count, total: d.total })).sort((a, b) => b.total - a.total);
      const byCategory = {};
      rangeInvs.forEach(inv => {
        (inv.lines || []).forEach(l => {
          const prod = products.find(p => p.id === l.productId);
          const cat = (prod && prod.category) || "Other";
          if (!byCategory[cat]) byCategory[cat] = { qty: 0, total: 0 };
          byCategory[cat].qty += Number(l.qty) || 0;
          byCategory[cat].total += Number(l.total) || Number(l.amount) || 0;
        });
      });
      const catBreakdown = Object.entries(byCategory).map(([cat, d]) => ({ category: cat, qty: d.qty, total: d.total })).sort((a, b) => b.total - a.total);
      setGenerated({ type: "sales", title: "Sales Report", dateFrom, dateTo, invoiceCount: rangeInvs.length, totalSales: rangeInvs.reduce((s, i) => s + (i.total || 0), 0), custBreakdown, catBreakdown });
    }
  };

  const printReport = () => {
    if (!generated) return;
    const el = document.getElementById("report-output");
    if (!el) return;
    const w = window.open("", "_blank", "width=900,height=700");
    if (!w) return;
    w.document.write("<html><head><title>" + generated.title + "</title><style>*{margin:0;padding:0;box-sizing:border-box;font-family:Arial,sans-serif;}body{padding:30px;font-size:12px;}table{width:100%;border-collapse:collapse;}th{background:#1e3a5f;color:#fff;padding:6px 8px;text-align:left;font-size:10px;text-transform:uppercase;}td{padding:5px 8px;border-bottom:1px solid #e5e7eb;font-size:11px;}.r{text-align:right;}.b{font-weight:700;}@media print{body{padding:15px;}}</style></head><body>" + el.innerHTML + "</body></html>");
    w.document.close();
    setTimeout(() => w.print(), 300);
  };

  const rpt = reports.find(r => r.id === reportType);

  const renderTable = (headers, rows, opts) => {
    return React.createElement("table", { style: { width: "100%", borderCollapse: "collapse", fontSize: 12 } },
      React.createElement("thead", null, React.createElement("tr", null, headers.map((h, i) => React.createElement("th", { key: i, style: { background: "#1e3a5f", color: "#fff", padding: "6px 8px", textAlign: (opts && opts.align && opts.align[i]) || "left", fontSize: 10, textTransform: "uppercase", fontWeight: 700 } }, h)))),
      React.createElement("tbody", null, rows));
  };

  const renderReportContent = () => {
    if (!generated) return null;
    const g = generated;
    const hdr = React.createElement("div", { style: { marginBottom: 20 } },
      React.createElement("div", { style: { fontSize: 18, fontWeight: 800, color: "#1e3a5f" } }, companyName),
      React.createElement("div", { style: { fontSize: 16, fontWeight: 700, marginTop: 4 } }, g.title),
      (g.dateFrom && g.dateTo) ? React.createElement("div", { style: { fontSize: 11, color: "#6b7280", marginTop: 4 } }, fmtDate(g.dateFrom), " — ", fmtDate(g.dateTo)) : null,
      g.customer ? React.createElement("div", { style: { fontSize: 12, color: "#374151", marginTop: 4 } }, g.customer.name, g.customer.address ? " · " + g.customer.address : "", g.customer.phone ? " · " + g.customer.phone : "") : null,
      React.createElement("div", { style: { fontSize: 9, color: "#9ca3af", marginTop: 4 } }, "Generated: ", new Date().toLocaleString()));

    if (g.type === "ledger") {
      const rows = g.entries.map((e, i) => React.createElement("tr", { key: i, style: { background: i % 2 === 0 ? "#fff" : "#f9fafb" } },
        React.createElement("td", { style: { padding: "5px 8px", borderBottom: "1px solid #e5e7eb" } }, fmtDate(e.date)),
        React.createElement("td", { style: { padding: "5px 8px", borderBottom: "1px solid #e5e7eb" } }, React.createElement("span", { style: { fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 3, background: e.type === "Invoice" ? "#dbeafe" : e.type === "Payment" ? "#dcfce7" : "#fef3c7", color: e.type === "Invoice" ? "#1e40af" : e.type === "Payment" ? "#166534" : "#92400e" } }, e.type)),
        React.createElement("td", { style: { padding: "5px 8px", borderBottom: "1px solid #e5e7eb", fontFamily: "monospace", fontWeight: 600 } }, e.ref),
        React.createElement("td", { style: { padding: "5px 8px", borderBottom: "1px solid #e5e7eb", color: "#6b7280" } }, e.desc),
        React.createElement("td", { style: { padding: "5px 8px", borderBottom: "1px solid #e5e7eb", textAlign: "right", color: e.debit > 0 ? "#dc2626" : "#9ca3af" } }, e.debit > 0 ? fmt(e.debit) : "—"),
        React.createElement("td", { style: { padding: "5px 8px", borderBottom: "1px solid #e5e7eb", textAlign: "right", color: e.credit > 0 ? "#16a34a" : "#9ca3af" } }, e.credit > 0 ? fmt(e.credit) : "—"),
        React.createElement("td", { style: { padding: "5px 8px", borderBottom: "1px solid #e5e7eb", textAlign: "right", fontWeight: 700 } }, fmt(e.balance))));
      const footer = React.createElement("tr", { style: { background: "#f1f5f9", fontWeight: 700 } },
        React.createElement("td", { colSpan: 4, style: { padding: "8px", borderTop: "2px solid #1e3a5f" } }, "TOTALS"),
        React.createElement("td", { style: { padding: "8px", borderTop: "2px solid #1e3a5f", textAlign: "right", color: "#dc2626" } }, fmt(g.totalDebit)),
        React.createElement("td", { style: { padding: "8px", borderTop: "2px solid #1e3a5f", textAlign: "right", color: "#16a34a" } }, fmt(g.totalCredit)),
        React.createElement("td", { style: { padding: "8px", borderTop: "2px solid #1e3a5f", textAlign: "right", fontSize: 14 } }, fmt(g.balance)));
      return React.createElement("div", null, hdr, renderTable(["Date", "Type", "Reference", "Details", "Charges", "Credits", "Balance"], [...rows, footer]));
    }

    if (g.type === "purchases") {
      const rows = g.items.map((it, i) => React.createElement("tr", { key: i, style: { background: i % 2 === 0 ? "#fff" : "#f9fafb" } },
        React.createElement("td", { style: { padding: "5px 8px", borderBottom: "1px solid #e5e7eb", fontWeight: 600 } }, it.name, it.packSize ? React.createElement("span", { style: { fontSize: 9, color: "#6b7280", marginLeft: 4 } }, it.packSize) : null),
        React.createElement("td", { style: { padding: "5px 8px", borderBottom: "1px solid #e5e7eb", color: "#6b7280" } }, it.category),
        React.createElement("td", { style: { padding: "5px 8px", borderBottom: "1px solid #e5e7eb", textAlign: "right" } }, it.qty),
        React.createElement("td", { style: { padding: "5px 8px", borderBottom: "1px solid #e5e7eb", textAlign: "right" } }, it.weight > 0 ? it.weight.toFixed(1) + " lbs" : "—"),
        React.createElement("td", { style: { padding: "5px 8px", borderBottom: "1px solid #e5e7eb", textAlign: "right", fontWeight: 600 } }, fmt(it.amount))));
      const footer = React.createElement("tr", { style: { background: "#f1f5f9", fontWeight: 700 } },
        React.createElement("td", { colSpan: 2, style: { padding: "8px", borderTop: "2px solid #1e3a5f" } }, g.items.length, " products across ", g.invoiceCount, " invoices"),
        React.createElement("td", { style: { padding: "8px", borderTop: "2px solid #1e3a5f", textAlign: "right" } }, g.items.reduce((s, i) => s + i.qty, 0)),
        React.createElement("td", { style: { padding: "8px", borderTop: "2px solid #1e3a5f", textAlign: "right" } }),
        React.createElement("td", { style: { padding: "8px", borderTop: "2px solid #1e3a5f", textAlign: "right", fontSize: 14 } }, fmt(g.totalAmount)));
      return React.createElement("div", null, hdr, renderTable(["Product", "Category", "Qty", "Weight", "Amount"], [...rows, footer]));
    }

    if (g.type === "payments") {
      const rows = g.entries.map((e, i) => React.createElement("tr", { key: i, style: { background: i % 2 === 0 ? "#fff" : "#f9fafb" } },
        React.createElement("td", { style: { padding: "5px 8px", borderBottom: "1px solid #e5e7eb" } }, fmtDate(e.date)),
        React.createElement("td", { style: { padding: "5px 8px", borderBottom: "1px solid #e5e7eb", fontFamily: "monospace" } }, e.ref),
        React.createElement("td", { style: { padding: "5px 8px", borderBottom: "1px solid #e5e7eb" } }, e.method),
        React.createElement("td", { style: { padding: "5px 8px", borderBottom: "1px solid #e5e7eb" } }, e.checkNo || "—"),
        React.createElement("td", { style: { padding: "5px 8px", borderBottom: "1px solid #e5e7eb", textAlign: "right", fontWeight: 600, color: "#16a34a" } }, fmt(e.amount)),
        React.createElement("td", { style: { padding: "5px 8px", borderBottom: "1px solid #e5e7eb", fontSize: 10, color: "#6b7280" } }, e.appliedTo)));
      const footer = React.createElement("tr", { style: { background: "#f1f5f9", fontWeight: 700 } },
        React.createElement("td", { colSpan: 4, style: { padding: "8px", borderTop: "2px solid #1e3a5f" } }, g.entries.length, " payments"),
        React.createElement("td", { style: { padding: "8px", borderTop: "2px solid #1e3a5f", textAlign: "right", fontSize: 14, color: "#16a34a" } }, fmt(g.totalPaid)),
        React.createElement("td", { style: { padding: "8px", borderTop: "2px solid #1e3a5f" } }));
      return React.createElement("div", null, hdr, renderTable(["Date", "Reference", "Method", "Check #", "Amount", "Applied To"], [...rows, footer]));
    }

    if (g.type === "openar") {
      const agingColors = { Current: "#22c55e", "1-30": "#f59e0b", "31-60": "#f97316", "61-90": "#ef4444", "90+": "#dc2626" };
      const agingSummary = React.createElement("div", { style: { display: "flex", gap: 0, marginBottom: 20, border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden" } },
        Object.entries(g.agingBuckets).map(([k, v]) => React.createElement("div", { key: k, style: { flex: 1, textAlign: "center", padding: "10px 8px", borderRight: "1px solid #e5e7eb", background: v > 0 ? (agingColors[k] || "#64748b") + "11" : "#fff" } },
          React.createElement("div", { style: { fontSize: 10, fontWeight: 700, color: "#64748b", textTransform: "uppercase" } }, k, " Days"),
          React.createElement("div", { style: { fontSize: 16, fontWeight: 800, marginTop: 4, color: v > 0 ? agingColors[k] : "#9ca3af" } }, fmt(v)))));
      const rows = g.entries.map((e, i) => React.createElement("tr", { key: i, style: { background: i % 2 === 0 ? "#fff" : "#f9fafb" } },
        React.createElement("td", { style: { padding: "5px 8px", borderBottom: "1px solid #e5e7eb", fontWeight: 600 } }, e.custName),
        React.createElement("td", { style: { padding: "5px 8px", borderBottom: "1px solid #e5e7eb", fontFamily: "monospace" } }, e.invId),
        React.createElement("td", { style: { padding: "5px 8px", borderBottom: "1px solid #e5e7eb" } }, fmtDate(e.date)),
        React.createElement("td", { style: { padding: "5px 8px", borderBottom: "1px solid #e5e7eb" } }, fmtDate(e.dueDate)),
        React.createElement("td", { style: { padding: "5px 8px", borderBottom: "1px solid #e5e7eb", textAlign: "right" } }, fmt(e.total)),
        React.createElement("td", { style: { padding: "5px 8px", borderBottom: "1px solid #e5e7eb", textAlign: "right", color: "#16a34a" } }, fmt(e.paid + e.credits)),
        React.createElement("td", { style: { padding: "5px 8px", borderBottom: "1px solid #e5e7eb", textAlign: "right", fontWeight: 700 } }, fmt(e.balance)),
        React.createElement("td", { style: { padding: "5px 8px", borderBottom: "1px solid #e5e7eb", textAlign: "center" } }, React.createElement("span", { style: { fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 3, background: (agingColors[e.aging] || "#64748b") + "22", color: agingColors[e.aging] || "#64748b" } }, e.aging === "Current" ? "Current" : e.daysPast + " days"))));
      const footer = React.createElement("tr", { style: { background: "#f1f5f9", fontWeight: 700 } },
        React.createElement("td", { colSpan: 6, style: { padding: "8px", borderTop: "2px solid #1e3a5f" } }, g.entries.length, " open invoices"),
        React.createElement("td", { style: { padding: "8px", borderTop: "2px solid #1e3a5f", textAlign: "right", fontSize: 14 } }, fmt(g.totalBalance)),
        React.createElement("td", { style: { padding: "8px", borderTop: "2px solid #1e3a5f" } }));
      return React.createElement("div", null, hdr, agingSummary, renderTable(["Customer", "Invoice", "Date", "Due Date", "Total", "Paid/Credits", "Balance", "Aging"], [...rows, footer]));
    }

    if (g.type === "sales") {
      const custRows = g.custBreakdown.map((c, i) => React.createElement("tr", { key: i, style: { background: i % 2 === 0 ? "#fff" : "#f9fafb" } },
        React.createElement("td", { style: { padding: "5px 8px", borderBottom: "1px solid #e5e7eb", fontWeight: 600 } }, c.name),
        React.createElement("td", { style: { padding: "5px 8px", borderBottom: "1px solid #e5e7eb", textAlign: "center" } }, c.count),
        React.createElement("td", { style: { padding: "5px 8px", borderBottom: "1px solid #e5e7eb", textAlign: "right", fontWeight: 600 } }, fmt(c.total)),
        React.createElement("td", { style: { padding: "5px 8px", borderBottom: "1px solid #e5e7eb", textAlign: "right", color: "#6b7280" } }, g.totalSales > 0 ? (c.total / g.totalSales * 100).toFixed(1) + "%" : "—")));
      const catRows = g.catBreakdown.map((c, i) => React.createElement("tr", { key: i, style: { background: i % 2 === 0 ? "#fff" : "#f9fafb" } },
        React.createElement("td", { style: { padding: "5px 8px", borderBottom: "1px solid #e5e7eb", fontWeight: 600 } }, c.category),
        React.createElement("td", { style: { padding: "5px 8px", borderBottom: "1px solid #e5e7eb", textAlign: "right" } }, c.qty),
        React.createElement("td", { style: { padding: "5px 8px", borderBottom: "1px solid #e5e7eb", textAlign: "right", fontWeight: 600 } }, fmt(c.total)),
        React.createElement("td", { style: { padding: "5px 8px", borderBottom: "1px solid #e5e7eb", textAlign: "right", color: "#6b7280" } }, g.totalSales > 0 ? (c.total / g.totalSales * 100).toFixed(1) + "%" : "—")));
      const summaryCards = React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, marginBottom: 24 } },
        React.createElement("div", { style: { background: "#eff6ff", borderRadius: 10, padding: 16, textAlign: "center" } },
          React.createElement("div", { style: { fontSize: 10, fontWeight: 700, color: "#3b82f6", textTransform: "uppercase" } }, "Total Sales"),
          React.createElement("div", { style: { fontSize: 24, fontWeight: 800, color: "#1e3a5f", marginTop: 4 } }, fmt(g.totalSales))),
        React.createElement("div", { style: { background: "#f0fdf4", borderRadius: 10, padding: 16, textAlign: "center" } },
          React.createElement("div", { style: { fontSize: 10, fontWeight: 700, color: "#16a34a", textTransform: "uppercase" } }, "Invoices"),
          React.createElement("div", { style: { fontSize: 24, fontWeight: 800, color: "#166534", marginTop: 4 } }, g.invoiceCount)),
        React.createElement("div", { style: { background: "#fefce8", borderRadius: 10, padding: 16, textAlign: "center" } },
          React.createElement("div", { style: { fontSize: 10, fontWeight: 700, color: "#ca8a04", textTransform: "uppercase" } }, "Avg per Invoice"),
          React.createElement("div", { style: { fontSize: 24, fontWeight: 800, color: "#854d0e", marginTop: 4 } }, g.invoiceCount > 0 ? fmt(g.totalSales / g.invoiceCount) : "—")));
      return React.createElement("div", null, hdr, summaryCards,
        React.createElement("div", { style: { fontWeight: 700, fontSize: 14, marginBottom: 8 } }, "Sales by Customer"),
        renderTable(["Customer", "Invoices", "Total", "% of Sales"], custRows),
        React.createElement("div", { style: { fontWeight: 700, fontSize: 14, marginBottom: 8, marginTop: 24 } }, "Sales by Category"),
        renderTable(["Category", "Qty Sold", "Total", "% of Sales"], catRows));
    }
    return null;
  };

  return React.createElement("div", { style: { padding: 28 } },
    React.createElement(PageHeader, { title: "Reports", subtitle: "Generate and print customer and financial reports" }),
    React.createElement(Card, { style: { marginBottom: 24 } },
      React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr auto", gap: 12, alignItems: "end" } },
        React.createElement("div", null,
          React.createElement("label", { style: { fontSize: 11, color: "#94a3b8", fontWeight: 600, display: "block", marginBottom: 4 } }, "Report Type"),
          React.createElement("select", {
            "data-testid": "select-report-type",
            value: reportType,
            onChange: e => { setReportType(e.target.value); setGenerated(null); },
            style: { width: "100%", background: "#1a2030", border: "1px solid #2d3748", borderRadius: 6, padding: "8px 10px", color: "#e2e8f0", fontSize: 13 }
          }, reports.map(r => React.createElement("option", { key: r.id, value: r.id }, r.label)))),
        rpt.needsCust && React.createElement("div", null,
          React.createElement("label", { style: { fontSize: 11, color: "#94a3b8", fontWeight: 600, display: "block", marginBottom: 4 } }, "Customer"),
          React.createElement("select", {
            "data-testid": "select-report-customer",
            value: custId,
            onChange: e => setCustId(e.target.value),
            style: { width: "100%", background: "#1a2030", border: "1px solid #2d3748", borderRadius: 6, padding: "8px 10px", color: "#e2e8f0", fontSize: 13 }
          }, React.createElement("option", { value: "" }, "— Select Customer —"), customers.sort((a, b) => (a.name || "").localeCompare(b.name || "")).map(c => React.createElement("option", { key: c.id, value: c.id }, c.name)))),
        React.createElement("div", null,
          React.createElement("label", { style: { fontSize: 11, color: "#94a3b8", fontWeight: 600, display: "block", marginBottom: 4 } }, "From"),
          React.createElement("input", {
            type: "date",
            "data-testid": "input-report-from",
            value: dateFrom,
            onChange: e => setDateFrom(e.target.value),
            style: { width: "100%", background: "#1a2030", border: "1px solid #2d3748", borderRadius: 6, padding: "8px 10px", color: "#e2e8f0", fontSize: 13 }
          })),
        React.createElement("div", null,
          React.createElement("label", { style: { fontSize: 11, color: "#94a3b8", fontWeight: 600, display: "block", marginBottom: 4 } }, "To"),
          React.createElement("input", {
            type: "date",
            "data-testid": "input-report-to",
            value: dateTo,
            onChange: e => setDateTo(e.target.value),
            style: { width: "100%", background: "#1a2030", border: "1px solid #2d3748", borderRadius: 6, padding: "8px 10px", color: "#e2e8f0", fontSize: 13 }
          })),
        React.createElement("div", { style: { display: "flex", gap: 8 } },
          React.createElement(Btn, {
            "data-testid": "button-generate-report",
            onClick: generateReport,
            icon: "dashboard"
          }, "Generate"),
          generated && React.createElement(Btn, {
            "data-testid": "button-print-report",
            variant: "secondary",
            icon: "print",
            onClick: printReport
          }, "Print"))),
      React.createElement("div", { style: { fontSize: 11, color: "#64748b", marginTop: 8 } }, rpt.desc)),
    generated && React.createElement(Card, null,
      React.createElement("div", { id: "report-output", style: { background: "#fff", color: "#1a1a2e", borderRadius: 8, padding: 20, minHeight: 200 } },
        renderReportContent())));
}

