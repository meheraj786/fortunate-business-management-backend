const PDFDocument = require("pdfkit");
const { format } = require("date-fns");
const SystemSettings = require("../models/systemSettings.model");

// ─── Layout Constants ────────────────────────────────────────────────────────
const PAGE = {
  marginLeft: 45,
  marginRight: 45,
  marginTop: 40,
  marginBottom: 55,
  width: 595.28, // A4
  height: 841.89,
};
PAGE.contentWidth = PAGE.width - PAGE.marginLeft - PAGE.marginRight;
PAGE.contentRight = PAGE.width - PAGE.marginRight;

// ─── Ink-friendly monochrome palette ─────────────────────────────────────────
const C = {
  black: "#000000",
  dark: "#1a1a1a",
  text: "#222222",
  label: "#555555",
  border: "#999999",
  lightBorder: "#cccccc",
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmt(amount, currency = "BDT") {
  if (amount === null || amount === undefined || isNaN(Number(amount))) return "N/A";
  const num = Number(amount);
  const symbols = {
    USD: "$", BDT: "BDT", EUR: "€", GBP: "£", INR: "INR",
    JPY: "¥", CAD: "C$", AUD: "A$", CNY: "¥", AED: "AED", SAR: "SAR",
  };
  const symbol = symbols[currency] || currency;
  return (
    symbol +
    " " +
    new Intl.NumberFormat("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(num)
  );
}

function fmtDate(dateString, dateFormat = "dd MMM yyyy") {
  if (!dateString) return "N/A";
  try {
    const d = new Date(dateString);
    if (isNaN(d.getTime())) return "N/A";
    let f = dateFormat
      .replace("DD", "dd")
      .replace("YYYY", "yyyy");
    return format(d, f);
  } catch {
    return "N/A";
  }
}

function safe(val) {
  if (val === null || val === undefined) return "N/A";
  const str = String(val).trim();
  return str.length > 0 ? str : "N/A";
}

// ─── Page Management ─────────────────────────────────────────────────────────

function needsPage(doc, space = 60) {
  return doc.y + space > PAGE.height - PAGE.marginBottom - 20;
}

function ensureSpace(doc, space = 60) {
  if (needsPage(doc, space)) {
    doc.addPage();
    doc.y = PAGE.marginTop;
  }
}

// ─── Positioned Text Helper ─────────────────────────────────────────────────
// ALL text with explicit (x, y) coordinates MUST use lineBreak: false.
// Without this, PDFKit updates doc.y past page boundaries and auto-adds
// blank pages when bufferPages is enabled.

function posText(doc, text, x, y, opts = {}) {
  doc.text(String(text), x, y, { ...opts, lineBreak: false });
}

// ─── Drawing Primitives ──────────────────────────────────────────────────────

function hr(doc, y, weight = 0.5, color = C.lightBorder) {
  doc
    .save()
    .strokeColor(color)
    .lineWidth(weight)
    .moveTo(PAGE.marginLeft, y)
    .lineTo(PAGE.contentRight, y)
    .stroke()
    .restore();
}

function borderedBox(doc, x, y, w, h) {
  doc
    .save()
    .strokeColor(C.border)
    .lineWidth(0.5)
    .rect(x, y, w, h)
    .stroke()
    .restore();
}

/**
 * Section heading with extra spacing before.
 * @param {number} minContentSpace - Minimum space (in pt) needed for the heading
 *   PLUS the first block of content that follows it. This prevents the heading
 *   from appearing at the bottom of a page with the content on the next page.
 *   Default 100 covers heading (~34pt) + an infoRow/table-header+row (~60pt).
 */
function sectionHeading(doc, title, minContentSpace = 90) {
  ensureSpace(doc, minContentSpace);
  doc.y += 12; // spacing ABOVE the heading only

  doc.fontSize(9).font("Helvetica-Bold").fillColor(C.dark);
  posText(doc, title.toUpperCase(), PAGE.marginLeft, doc.y, { width: PAGE.contentWidth });

  doc.y += 12;
  hr(doc, doc.y, 0.75, C.dark);
  doc.y += 3;
}

/**
 * A bordered info-card row with N columns, each having a label + value.
 */
function infoRow(doc, items) {
  ensureSpace(doc, 40);

  const rowY = doc.y;
  const rowH = 32;
  const colW = PAGE.contentWidth / items.length;

  borderedBox(doc, PAGE.marginLeft, rowY, PAGE.contentWidth, rowH);

  // Vertical dividers
  if (items.length > 1) {
    doc.save().strokeColor(C.border).lineWidth(0.5);
    for (let i = 1; i < items.length; i++) {
      const divX = PAGE.marginLeft + colW * i;
      doc.moveTo(divX, rowY).lineTo(divX, rowY + rowH).stroke();
    }
    doc.restore();
  }

  items.forEach((item, i) => {
    const cellX = PAGE.marginLeft + colW * i + 8;
    const cellW = colW - 16;

    doc.fontSize(6.5).font("Helvetica").fillColor(C.label);
    posText(doc, item.label.toUpperCase(), cellX, rowY + 5, { width: cellW });

    doc.fontSize(9).font("Helvetica-Bold").fillColor(C.dark);
    posText(doc, safe(item.value), cellX, rowY + 16, { width: cellW });
  });

  doc.y = rowY + rowH + 6;
}

/**
 * Print-friendly table with thin borders.
 */
function drawTable(doc, headers, rows, colWidths, options = {}) {
  const { totalLabel, totalValue } = options;
  const x0 = PAGE.marginLeft;
  const cellPad = 4;
  const headerH = 16;
  const tableWidth = colWidths.reduce((a, b) => a + b, 0);

  if (!rows || rows.length === 0) return;

  ensureSpace(doc, 50);

  const drawHeaders = (startY) => {
    doc.save().strokeColor(C.dark).lineWidth(0.75);
    doc.moveTo(x0, startY).lineTo(x0 + tableWidth, startY).stroke();
    doc.moveTo(x0, startY + headerH).lineTo(x0 + tableWidth, startY + headerH).stroke();
    doc.restore();

    let cx = x0;
    doc.fontSize(7).font("Helvetica-Bold").fillColor(C.dark);
    headers.forEach((h, i) => {
      const align = i === headers.length - 1 ? "right" : "left";
      posText(doc, String(h), cx + cellPad, startY + 4, {
        width: colWidths[i] - cellPad * 2,
        align,
      });
      cx += colWidths[i];
    });

    return startY + headerH;
  };

  let currentY = drawHeaders(doc.y);

  rows.forEach((row) => {
    const safeRow = row.map((cell) => (cell == null ? "N/A" : String(cell)));

    const cellHeights = safeRow.map((cell, i) =>
      doc.heightOfString(cell, {
        width: colWidths[i] - cellPad * 2,
        fontSize: 7.5,
      }) + 8
    );
    const rowH = Math.max(15, ...cellHeights);

    if (needsPage(doc, rowH + 10)) {
      doc.addPage();
      doc.y = PAGE.marginTop;
      currentY = drawHeaders(doc.y);
    }

    // Row bottom border
    doc.save().strokeColor(C.lightBorder).lineWidth(0.3)
      .moveTo(x0, currentY + rowH).lineTo(x0 + tableWidth, currentY + rowH).stroke().restore();

    // Cell text
    let cx = x0;
    doc.fontSize(7.5).font("Helvetica").fillColor(C.text);
    safeRow.forEach((cell, i) => {
      const align = i === safeRow.length - 1 ? "right" : "left";
      posText(doc, cell, cx + cellPad, currentY + 3, {
        width: colWidths[i] - cellPad * 2,
        align,
      });
      cx += colWidths[i];
    });

    currentY += rowH;
  });

  // Total row
  if (totalLabel && totalValue) {
    const totalH = 16;

    doc.save().strokeColor(C.dark).lineWidth(0.75);
    doc.moveTo(x0, currentY).lineTo(x0 + tableWidth, currentY).stroke();
    doc.moveTo(x0, currentY + totalH).lineTo(x0 + tableWidth, currentY + totalH).stroke();
    doc.restore();

    const lastColW = colWidths[colWidths.length - 1];
    const labelW = tableWidth - lastColW;

    doc.fontSize(7.5).font("Helvetica-Bold").fillColor(C.dark);
    posText(doc, totalLabel, x0 + cellPad, currentY + 3, {
      width: labelW - cellPad * 2,
      align: "right",
    });
    posText(doc, totalValue, x0 + labelW + cellPad, currentY + 3, {
      width: lastColW - cellPad * 2,
      align: "right",
    });

    currentY += totalH;
  }

  doc.y = currentY + 6;
}

/**
 * Build a rich account description string based on account type.
 */
function formatAccountForPdf(account) {
  if (!account || typeof account !== "object") return "N/A";

  switch (account.accountType) {
    case "Bank": {
      const parts = [account.bankName];
      if (account.accountNumber) parts.push(`A/C: ${account.accountNumber}`);
      if (account.branchName) parts.push(`Br: ${account.branchName}`);
      return parts.filter(Boolean).join(", ");
    }
    case "Mobile Banking": {
      const parts = [account.serviceName];
      if (account.mobileNumber) parts.push(account.mobileNumber);
      return parts.filter(Boolean).join(" - ");
    }
    case "Cash":
      return account.accountName || "Cash";
    default:
      return account.accountName || "N/A";
  }
}

/**
 * Render a cost table with full account details.
 * Shows 5 columns: Date, Description, Payment Method, Paid Via (account), Amount
 */
function renderCostTable(doc, costs, curr, dateFmt, subtotalLabel) {
  if (!costs || costs.length === 0) return;

  const total = costs.reduce((s, c) => s + (Number(c.amount) || 0), 0);

  drawTable(
    doc,
    ["DATE", "DESCRIPTION", "PAYMENT", "PAID VIA", `AMOUNT (${curr})`],
    costs.map((c) => {
      const account = (c.accountId && typeof c.accountId === "object")
        ? formatAccountForPdf(c.accountId)
        : "N/A";

      return [
        fmtDate(c.date, dateFmt),
        safe(c.name),
        safe(c.paymentMethod),
        account,
        fmt(c.amount, curr),
      ];
    }),
    [70, 130, 70, 120, PAGE.contentWidth - 390],
    {
      totalLabel: subtotalLabel,
      totalValue: fmt(total, curr),
    }
  );
}

function buildSpecs(product) {
  const specs = [];
  if (product.thickness) specs.push(`T: ${product.thickness}`);
  if (product.width) specs.push(`W: ${product.width}`);
  if (product.length) specs.push(`L: ${product.length}`);
  if (product.grade) specs.push(`Grade: ${product.grade}`);
  return specs.length > 0 ? specs.join(", ") : "N/A";
}

// ─── Main PDF Generation ─────────────────────────────────────────────────────

async function generateLCPDF(lc, res) {
  if (!lc || !lc.basicInfo) {
    return res.status(400).json({ error: "Invalid LC data provided" });
  }

  try {
    const settings = await SystemSettings.getSingleton();
    const curr = settings.currency || "BDT";
    const dateFmt = settings.dateFormat || "dd MMM yyyy";

    const doc = new PDFDocument({
      size: "A4",
      margins: {
        top: PAGE.marginTop,
        bottom: PAGE.marginBottom,
        left: PAGE.marginLeft,
        right: PAGE.marginRight,
      },
      bufferPages: true,
      autoFirstPage: true,
      info: {
        Title: `Letter of Credit - ${lc.basicInfo.lcNumber || "Draft"}`,
        Author: settings.businessName || "LC Management System",
        Creator: settings.businessName || "LC Management System",
        Subject: `LC Document for ${lc.basicInfo.supplierName || "N/A"}`,
      },
    });

    // Response headers
    const safeFilename = (lc.basicInfo.lcNumber || "LC-Draft").replace(/[^a-zA-Z0-9_-]/g, "_");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="LC_${safeFilename}_${format(new Date(), "yyyy-MM-dd")}.pdf"`
    );

    doc.on("error", (error) => {
      console.error("PDF Stream Error:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "PDF generation failed", details: error.message });
      }
    });
    res.on("error", (error) => {
      console.error("Response Stream Error:", error);
    });

    doc.pipe(res);

    const businessName = settings.businessName || "Business Management";

    // ═══════════════════════════════════════════════════════════════════════════
    // HEADER
    // ═══════════════════════════════════════════════════════════════════════════

    doc.fontSize(14).font("Helvetica-Bold").fillColor(C.black);
    posText(doc, businessName.toUpperCase(), PAGE.marginLeft, PAGE.marginTop, {
      width: PAGE.contentWidth,
      align: "center",
    });
    doc.y = PAGE.marginTop + 16;

    if (settings.businessAddress) {
      doc.fontSize(7.5).font("Helvetica").fillColor(C.label);
      posText(doc, settings.businessAddress, PAGE.marginLeft, doc.y, {
        width: PAGE.contentWidth,
        align: "center",
      });
      doc.y += 10;
    }

    const contactParts = [];
    if (settings.businessPhone) contactParts.push(`Tel: ${settings.businessPhone}`);
    if (settings.businessEmail) contactParts.push(`Email: ${settings.businessEmail}`);
    if (contactParts.length > 0) {
      doc.fontSize(7.5).font("Helvetica").fillColor(C.label);
      posText(doc, contactParts.join("   |   "), PAGE.marginLeft, doc.y, {
        width: PAGE.contentWidth,
        align: "center",
      });
      doc.y += 10;
    }

    doc.y += 2;
    hr(doc, doc.y, 1.5, C.dark);
    doc.y += 10;

    // Document title
    doc.fontSize(14).font("Helvetica-Bold").fillColor(C.black);
    posText(doc, "LETTER OF CREDIT", PAGE.marginLeft, doc.y, {
      width: PAGE.contentWidth,
      align: "center",
    });
    doc.y += 18;

    // LC metadata row
    infoRow(doc, [
      { label: "LC Number", value: lc.basicInfo.lcNumber },
      { label: "Opening Date", value: fmtDate(lc.basicInfo.lcOpeningDate, dateFmt) },
      { label: "Status", value: (lc.basicInfo.status || "Unknown").toUpperCase() },
    ]);

    doc.y += 2;

    // ═══════════════════════════════════════════════════════════════════════════
    // SECTION 1: PARTIES
    // ═══════════════════════════════════════════════════════════════════════════

    sectionHeading(doc, "Parties to the Credit", 130);

    const partyW = (PAGE.contentWidth - 20) / 2;
    const partyY = doc.y;

    let applicantLines = 2;
    if (lc.basicInfo.accountId && typeof lc.basicInfo.accountId === "object") {
      applicantLines += 1;
      applicantLines += 1;
      if (lc.basicInfo.accountId.branchName) applicantLines += 1;
    }
    const partyH = Math.max(52, 20 + applicantLines * 11);

    // Applicant (left)
    borderedBox(doc, PAGE.marginLeft, partyY, partyW, partyH);

    doc.fontSize(6.5).font("Helvetica-Bold").fillColor(C.label);
    posText(doc, "APPLICANT", PAGE.marginLeft + 8, partyY + 6, { width: partyW - 16 });
    doc.fontSize(9).font("Helvetica-Bold").fillColor(C.dark);
    posText(doc, safe(businessName), PAGE.marginLeft + 8, partyY + 18, { width: partyW - 16 });

    if (lc.basicInfo.accountId && typeof lc.basicInfo.accountId === "object") {
      let bankY = partyY + 32;
      doc.fontSize(7.5).font("Helvetica").fillColor(C.text);

      if (lc.basicInfo.accountId.bankName) {
        posText(doc, `Bank: ${lc.basicInfo.accountId.bankName}`, PAGE.marginLeft + 8, bankY, { width: partyW - 16 });
        bankY += 10;
      }
      if (lc.basicInfo.accountId.accountNumber) {
        posText(doc, `A/C: ${lc.basicInfo.accountId.accountNumber}`, PAGE.marginLeft + 8, bankY, { width: partyW - 16 });
        bankY += 10;
      }
      if (lc.basicInfo.accountId.branchName) {
        posText(doc, `Branch: ${lc.basicInfo.accountId.branchName}`, PAGE.marginLeft + 8, bankY, { width: partyW - 16 });
      }
    }

    // Beneficiary (right)
    const rightX = PAGE.marginLeft + partyW + 20;
    borderedBox(doc, rightX, partyY, partyW, partyH);

    doc.fontSize(6.5).font("Helvetica-Bold").fillColor(C.label);
    posText(doc, "BENEFICIARY (SUPPLIER)", rightX + 8, partyY + 6, { width: partyW - 16 });
    doc.fontSize(9).font("Helvetica-Bold").fillColor(C.dark);
    posText(doc, safe(lc.basicInfo.supplierName), rightX + 8, partyY + 18, { width: partyW - 16 });
    doc.fontSize(7.5).font("Helvetica").fillColor(C.text);
    posText(doc, `Country: ${safe(lc.basicInfo.supplierCountry)}`, rightX + 8, partyY + 32, { width: partyW - 16 });

    doc.y = partyY + partyH + 8;

    // ═══════════════════════════════════════════════════════════════════════════
    // SECTION 2: FINANCIAL TERMS
    // ═══════════════════════════════════════════════════════════════════════════

    const hasFinancial =
      lc.financialInfo?.lcAmountUsd != null ||
      lc.financialInfo?.exchangeRate != null ||
      (lc.financialInfo?.costs && lc.financialInfo.costs.length > 0);

    if (hasFinancial) {
      sectionHeading(doc, "Financial Terms", 100);

      infoRow(doc, [
        { label: `LC Amount (USD)`, value: fmt(lc.financialInfo?.lcAmountUsd, "USD") },
        { label: "Exchange Rate", value: lc.financialInfo?.exchangeRate != null ? String(lc.financialInfo.exchangeRate.toFixed(4)) : "N/A" },
        { label: `LC Amount (${curr})`, value: fmt(lc.financialInfo?.lcAmountBdt, curr) },
      ]);

      if (lc.financialInfo?.costs?.length > 0) {
        doc.fontSize(8).font("Helvetica-Bold").fillColor(C.dark);
        posText(doc, "Financial Costs", PAGE.marginLeft, doc.y, { width: PAGE.contentWidth });
        doc.y += 12;

        renderCostTable(doc, lc.financialInfo.costs, curr, dateFmt, "Subtotal - Financial Costs");
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SECTION 3: DESCRIPTION OF GOODS
    // ═══════════════════════════════════════════════════════════════════════════

    if (lc.productInfo && lc.productInfo.length > 0) {
      sectionHeading(doc, "Description of Goods", 100);

      const totalProductValue = lc.productInfo.reduce(
        (s, p) => s + (Number(p.totalValueUsd) || 0), 0
      );

      const hasSpecs = lc.productInfo.some(
        (p) => p.thickness || p.width || p.length || p.grade
      );

      if (hasSpecs) {
        drawTable(
          doc,
          ["#", "ITEM NAME", "SPECIFICATIONS", "QTY", "UNIT PRICE (USD)", "TOTAL (USD)"],
          lc.productInfo.map((p, i) => [
            String(i + 1),
            safe(p.itemName),
            buildSpecs(p),
            `${p.quantity != null ? p.quantity : "N/A"} ${p.quantityUnit?.name || ""}`.trim(),
            fmt(p.unitPriceUsd, "USD"),
            fmt(p.totalValueUsd, "USD"),
          ]),
          [25, 130, 100, 65, 85, PAGE.contentWidth - 405],
          { totalLabel: "Total Goods Value (USD)", totalValue: fmt(totalProductValue, "USD") }
        );
      } else {
        drawTable(
          doc,
          ["#", "ITEM NAME", "QTY", "UNIT PRICE (USD)", "TOTAL (USD)"],
          lc.productInfo.map((p, i) => [
            String(i + 1),
            safe(p.itemName),
            `${p.quantity != null ? p.quantity : "N/A"} ${p.quantityUnit?.name || ""}`.trim(),
            fmt(p.unitPriceUsd, "USD"),
            fmt(p.totalValueUsd, "USD"),
          ]),
          [25, 210, 80, 95, PAGE.contentWidth - 410],
          { totalLabel: "Total Goods Value (USD)", totalValue: fmt(totalProductValue, "USD") }
        );
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SECTION 4: DOCUMENT PRODUCT INFORMATION
    // ═══════════════════════════════════════════════════════════════════════════

    const hasDocProducts = lc.documentProductInfo?.products?.length > 0;
    const hasDocCosts = lc.documentProductInfo?.costs?.length > 0;

    if (hasDocProducts || hasDocCosts) {
      sectionHeading(doc, "Document Information", 100);

      if (hasDocProducts) {
        const totalDocValue = lc.documentProductInfo.products.reduce(
          (s, p) => s + (Number(p.totalValueUsd) || 0), 0
        );

        const hasDocSpecs = lc.documentProductInfo.products.some(
          (p) => p.thickness || p.width || p.length || p.grade
        );

        if (hasDocSpecs) {
          drawTable(
            doc,
            ["#", "ITEM NAME", "SPECIFICATIONS", "QTY", "UNIT PRICE (USD)", "TOTAL (USD)"],
            lc.documentProductInfo.products.map((p, i) => [
              String(i + 1),
              safe(p.itemName),
              buildSpecs(p),
              `${p.quantity != null ? p.quantity : "N/A"} ${p.quantityUnit?.name || ""}`.trim(),
              fmt(p.unitPriceUsd, "USD"),
              fmt(p.totalValueUsd, "USD"),
            ]),
            [25, 130, 100, 65, 85, PAGE.contentWidth - 405],
            { totalLabel: "Total Document Value (USD)", totalValue: fmt(totalDocValue, "USD") }
          );
        } else {
          drawTable(
            doc,
            ["#", "ITEM NAME", "QTY", "UNIT PRICE (USD)", "TOTAL (USD)"],
            lc.documentProductInfo.products.map((p, i) => [
              String(i + 1),
              safe(p.itemName),
              `${p.quantity != null ? p.quantity : "N/A"} ${p.quantityUnit?.name || ""}`.trim(),
              fmt(p.unitPriceUsd, "USD"),
              fmt(p.totalValueUsd, "USD"),
            ]),
            [25, 210, 80, 95, PAGE.contentWidth - 410],
            { totalLabel: "Total Document Value (USD)", totalValue: fmt(totalDocValue, "USD") }
          );
        }
      }

      if (hasDocCosts) {
        doc.fontSize(8).font("Helvetica-Bold").fillColor(C.dark);
        posText(doc, "Document Related Costs", PAGE.marginLeft, doc.y, { width: PAGE.contentWidth });
        doc.y += 12;

        renderCostTable(doc, lc.documentProductInfo.costs, curr, dateFmt, "Subtotal - Document Costs");
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SECTION 5: SHIPPING & CUSTOMS
    // ═══════════════════════════════════════════════════════════════════════════

    const hasShippingPorts =
      lc.shippingCustomsInfo?.portOfShipment ||
      lc.shippingCustomsInfo?.portOfDestination ||
      lc.shippingCustomsInfo?.expectedArrivalDate;
    const hasShippingCosts = lc.shippingCustomsInfo?.costs?.length > 0;

    if (hasShippingPorts || hasShippingCosts) {
      sectionHeading(doc, "Shipping & Customs", 100);

      if (hasShippingPorts) {
        infoRow(doc, [
          { label: "Port of Shipment", value: lc.shippingCustomsInfo.portOfShipment },
          { label: "Port of Destination", value: lc.shippingCustomsInfo.portOfDestination },
          { label: "Expected Arrival", value: fmtDate(lc.shippingCustomsInfo.expectedArrivalDate, dateFmt) },
        ]);
      }

      if (hasShippingCosts) {
        renderCostTable(doc, lc.shippingCustomsInfo.costs, curr, dateFmt, "Subtotal - Shipping & Customs");
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SECTION 6: AGENT & TRANSPORT
    // ═══════════════════════════════════════════════════════════════════════════

    if (lc.agentTransportInfo?.costs?.length > 0) {
      sectionHeading(doc, "Agent & Transport Costs", 100);
      renderCostTable(doc, lc.agentTransportInfo.costs, curr, dateFmt, "Subtotal - Agent & Transport");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SECTION 7: OTHER EXPENSES
    // ═══════════════════════════════════════════════════════════════════════════

    if (lc.otherExpenses?.costs?.length > 0) {
      sectionHeading(doc, "Other Miscellaneous Expenses", 100);
      renderCostTable(doc, lc.otherExpenses.costs, curr, dateFmt, "Subtotal - Other Expenses");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // GRAND TOTAL
    // ═══════════════════════════════════════════════════════════════════════════

    const hasCostSections =
      lc.financialInfo?.costs?.length > 0 ||
      lc.shippingCustomsInfo?.costs?.length > 0 ||
      lc.agentTransportInfo?.costs?.length > 0 ||
      lc.otherExpenses?.costs?.length > 0 ||
      lc.documentProductInfo?.costs?.length > 0;

    if (lc.totalCost != null && hasCostSections) {
      ensureSpace(doc, 50);
      doc.y += 6;

      hr(doc, doc.y, 1, C.dark);
      doc.y += 8;

      const totalY = doc.y;
      const totalH = 30;

      // Double-bordered total box
      borderedBox(doc, PAGE.marginLeft, totalY, PAGE.contentWidth, totalH);
      doc.save().strokeColor(C.dark).lineWidth(1)
        .rect(PAGE.marginLeft + 1, totalY + 1, PAGE.contentWidth - 2, totalH - 2)
        .stroke()
        .restore();

      doc.fontSize(10).font("Helvetica-Bold").fillColor(C.black);
      posText(doc, "GRAND TOTAL - ALL LC EXPENSES", PAGE.marginLeft + 12, totalY + 9, {
        width: PAGE.contentWidth / 2,
      });

      doc.fontSize(12).font("Helvetica-Bold").fillColor(C.black);
      posText(doc, fmt(lc.totalCost, curr), PAGE.marginLeft + PAGE.contentWidth / 2, totalY + 8, {
        width: PAGE.contentWidth / 2 - 12,
        align: "right",
      });

      doc.y = totalY + totalH + 14;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // DOCUMENTS & NOTES
    // ═══════════════════════════════════════════════════════════════════════════

    const hasUploadedDocs = lc.documentsNotes?.uploadedDocuments?.length > 0;
    const hasNotes =
      lc.documentsNotes?.note &&
      lc.documentsNotes.note.trim() !== "" &&
      lc.documentsNotes.note.trim().toLowerCase() !== "no notes given";

    if (hasUploadedDocs || hasNotes) {
      sectionHeading(doc, "Documents & Notes", 80);

      if (hasUploadedDocs) {
        doc.fontSize(8.5).font("Helvetica-Bold").fillColor(C.dark);
        posText(doc, "Attached Documents", PAGE.marginLeft, doc.y, { width: PAGE.contentWidth });
        doc.y += 14;

        lc.documentsNotes.uploadedDocuments.forEach((docFile, index) => {
          ensureSpace(doc, 16);

          const name = docFile.originalName || "Unnamed Document";
          const sizeStr = docFile.sizeBytes
            ? ` (${(docFile.sizeBytes / 1024).toFixed(1)} KB)`
            : "";
          const mimeStr = docFile.mimeType
            ? ` [${docFile.mimeType.split("/").pop().toUpperCase()}]`
            : "";

          doc.fontSize(8).font("Helvetica").fillColor(C.text);
          posText(doc, `${index + 1}.  ${name}${sizeStr}${mimeStr}`, PAGE.marginLeft + 8, doc.y, {
            width: PAGE.contentWidth - 16,
          });
          doc.y += 12;
        });

        doc.y += 6;
      }

      if (hasNotes) {
        ensureSpace(doc, 40);

        doc.fontSize(8.5).font("Helvetica-Bold").fillColor(C.dark);
        posText(doc, "Notes", PAGE.marginLeft, doc.y, { width: PAGE.contentWidth });
        doc.y += 14;

        const noteText = lc.documentsNotes.note.trim();
        const noteH = doc.heightOfString(noteText, {
          width: PAGE.contentWidth - 20,
          fontSize: 8,
        }) + 16;

        borderedBox(doc, PAGE.marginLeft, doc.y, PAGE.contentWidth, noteH);

        doc.fontSize(8).font("Helvetica").fillColor(C.text);
        posText(doc, noteText, PAGE.marginLeft + 10, doc.y + 8, {
          width: PAGE.contentWidth - 20,
        });

        doc.y += noteH + 8;
      }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PAGE FOOTERS (applied to all buffered pages)
    // ═══════════════════════════════════════════════════════════════════════════

    const generatedAt = format(new Date(), "dd MMM yyyy, HH:mm");
    const range = doc.bufferedPageRange();
    const totalPages = range.count;

    // ── Prevent ghost pages during footer rendering ─────────────────────────
    // PDFKit auto-adds pages when doc.text() writes near the bottom margin.
    // We temporarily disable addPage so the footer loop can't create blanks.
    const _origAddPage = doc.addPage.bind(doc);
    doc.addPage = () => doc; // no-op during footer rendering

    for (let i = 0; i < totalPages; i++) {
      doc.switchToPage(i);

      const footerY = PAGE.height - PAGE.marginBottom + 15;

      hr(doc, footerY, 0.5, C.border);

      doc.fontSize(6.5).font("Helvetica").fillColor(C.label);
      posText(
        doc,
        "This document is confidential and intended for authorized use only.",
        PAGE.marginLeft,
        footerY + 5,
        { width: PAGE.contentWidth * 0.55 }
      );

      doc.fontSize(7).font("Helvetica").fillColor(C.label);
      posText(
        doc,
        `Page ${i + 1} of ${totalPages}  |  Generated: ${generatedAt}`,
        PAGE.marginLeft,
        footerY + 5,
        { width: PAGE.contentWidth, align: "right" }
      );
    }

    // Restore addPage and finalize
    doc.addPage = _origAddPage;

    doc.end();
  } catch (error) {
    console.error("PDF Generation Error:", error);
    if (!res.headersSent) {
      res.status(500).json({
        error: "Failed to generate PDF",
        details: error.message,
      });
    }
  }
}

module.exports = { generateLCPDF };
