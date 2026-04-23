const fs = require("fs").promises;
const path = require("path");
const handlebars = require("handlebars");
const Invoice = require("../models/invoice.model");
const Customer = require("../models/customer.model");
const SystemSettings = require("../models/systemSettings.model");
const { ApiError } = require("./ApiError");
const { getBrowser } = require("./browserManager");

// --- Template Caching (Promise-based, race-condition safe) ---
const templatePath = path.resolve(__dirname, "./invoiceTemplate.html");
let templatePromise;

function getCompiledTemplate() {
  if (!templatePromise) {
    templatePromise = fs.readFile(templatePath, "utf-8").then((html) => {
      console.log("Invoice template successfully compiled and cached.");
      return handlebars.compile(html);
    });
  }
  return templatePromise;
}
// --- End Template Caching ---

/**
 * Helper to format a number with commas (matches frontend's Number.toLocaleString).
 */
function formatNumber(number) {
  if (number === undefined || number === null) return "0.00";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(number);
}

/**
 * Format a date string to match the frontend's SettingsContext.formatDate logic exactly.
 * Maps dateFormat setting to the correct Intl locale.
 */
function formatDate(dateString, dateFormat = "MM/DD/YYYY", timezone) {
  if (!dateString) return "N/A";

  try {
    const date = new Date(dateString);

    // Match frontend: MM/DD/YYYY → en-US, DD/MM/YYYY → en-GB, YYYY-MM-DD → en-CA
    const formatMap = {
      "MM/DD/YYYY": "en-US",
      "DD/MM/YYYY": "en-GB",
      "YYYY-MM-DD": "en-CA",
    };
    const locale = formatMap[dateFormat] || "en-US";

    const options = {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    };

    if (timezone) {
      options.timeZone = timezone;
    }

    return new Intl.DateTimeFormat(locale, options).format(date);
  } catch {
    return "N/A";
  }
}

// Register Handlebars helpers
handlebars.registerHelper("formatNumber", formatNumber);
handlebars.registerHelper("formatDate", formatDate);
handlebars.registerHelper("addOne", (index) => index + 1);

/**
 * Returns a human-readable payment status and its CSS class.
 */
function getPaymentStatusInfo(paymentStatus) {
  if (!paymentStatus) return { label: "", cssClass: "" };
  if (paymentStatus === "Paid payment") return { label: "PAID", cssClass: "paid" };
  if (paymentStatus === "Due payment") return { label: "DUE", cssClass: "due" };
  return { label: paymentStatus.toUpperCase(), cssClass: "due" };
}

/**
 * Fetches invoice data and prepares it for the template.
 */
async function getPreparedInvoiceData(invoiceId) {
  // Parallelize: fetch invoice and settings simultaneously
  const [invoice, settings] = await Promise.all([
    Invoice.findById(invoiceId)
      .populate("items.unit")
      .populate({
        path: "paymentAndAmountInfo.payments.accountId",
        select: "accountName",
      })
      .lean(),
    SystemSettings.getSingleton(),
  ]);

  if (!invoice) {
    throw new ApiError(404, "Invoice not found");
  }

  const currencySymbol = getCurrencySymbol(settings.currency);

  // Fetch customer credit balance if applicable
  let currentCreditBalance = null;
  if (invoice.customerDetails && invoice.customerDetails.customerId) {
    const customer = await Customer.findById(
      invoice.customerDetails.customerId,
    ).lean();
    if (customer) {
      currentCreditBalance = customer.creditBalance;
    }
  }

  // Calculate financial totals
  const totalPayments = invoice.paymentAndAmountInfo.payments
    .filter(p => !p.isReversed)
    .reduce((sum, p) => sum + p.amount, 0);

  let balanceDue =
    invoice.paymentAndAmountInfo.totalAmountToBePaid - totalPayments;
  let creditedToWallet = 0;

  if (balanceDue < 0) {
    creditedToWallet = Math.abs(balanceDue);
    balanceDue = 0;
  }

  // Format Items
  const formattedItems = (invoice.items || []).map((item) => ({
    ...item,
    unitName: item.unit?.name || item.unitName || "N/A",
    total: item.total || item.quantity * item.pricePerUnit,
  }));

  // Payment status
  const statusInfo = getPaymentStatusInfo(
    invoice.paymentAndAmountInfo.paymentStatus,
  );

  const preparedData = {
    ...invoice,
    items: formattedItems,
    settings: {
      businessName: settings.businessName,
      businessAddress: settings.businessAddress || "",
      businessEmail: settings.businessEmail || "",
      businessPhone: settings.businessPhone || "",
      currency: settings.currency,
    },
    currencySymbol,
    currentCreditBalance,
    paymentStatus: statusInfo.label,
    paymentStatusClass: statusInfo.cssClass,
    formattedInvoiceDate: formatDate(
      invoice.invoiceGeneratedDate,
      settings.dateFormat,
      settings.timezone,
    ),
    formattedSaleDate: formatDate(
      invoice.salesDate,
      settings.dateFormat,
      settings.timezone,
    ),
    shortSalesId: invoice.salesId.toString().slice(-6),
    allChargesAndCosts: [
      ...(invoice.paymentAndAmountInfo.charges || []),
      ...(invoice.paymentAndAmountInfo.costs || []),
    ],
    totalPayments,
    balanceDue,
    creditedToWallet,
    paymentAndAmountInfo: {
      ...invoice.paymentAndAmountInfo,
      payments: (invoice.paymentAndAmountInfo.payments || []).map((p) => ({
        ...p,
        formattedDate: formatDate(p.date, settings.dateFormat, settings.timezone),
        accountDetails: p.accountId
          ? { accountName: p.accountId.accountName }
          : null,
      })),
    },
  };

  return preparedData;
}

/**
 * Generates HTML from the cached Handlebars template and invoice data.
 */
async function compileTemplate(data) {
  const compiled = await getCompiledTemplate();
  return compiled(data);
}

/**
 * Generates a PDF from invoice data.
 */
async function generatePdf(invoiceId) {
  const data = await getPreparedInvoiceData(invoiceId);
  const html = await compileTemplate({ invoice: data });

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setContent(html, { waitUntil: ["load", "networkidle0"] });

    await page.emulateMediaType("print");

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: {
        top: "20px",
        right: "20px",
        bottom: "20px",
        left: "20px",
      },
    });

    return pdfBuffer;
  } finally {
    await page.close();
  }
}

/**
 * Generates a PNG image from invoice data.
 */
async function generatePng(invoiceId) {
  const data = await getPreparedInvoiceData(invoiceId);
  const html = await compileTemplate({ invoice: data });

  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 2 });

    await page.setContent(html, { waitUntil: ["load", "networkidle0"] });

    const element = await page.$("#invoice-paper");
    if (!element) {
      throw new ApiError(
        500,
        "Could not find '#invoice-paper' element in the template for PNG generation.",
      );
    }
    const imageBuffer = await element.screenshot({ type: "png" });

    return imageBuffer;
  } finally {
    await page.close();
  }
}

function getCurrencySymbol(currencyCode) {
  const symbols = {
    USD: "$",
    BDT: "৳",
    EUR: "€",
    GBP: "£",
    INR: "₹",
    JPY: "¥",
    CAD: "C$",
    AUD: "A$",
    CNY: "¥",
    AED: "AED",
    SAR: "SAR",
  };
  return symbols[currencyCode] || currencyCode;
}

module.exports = {
  generatePdf,
  generatePng,
};
