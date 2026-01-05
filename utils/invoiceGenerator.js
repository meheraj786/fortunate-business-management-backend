const fs = require("fs").promises;
const path = require("path");
const handlebars = require("handlebars");
const Invoice = require("../models/invoice.model"); // Assuming the path to your model
const { ApiError } = require("./ApiError");
const { getBrowser } = require("./browserManager"); // Import the shared browser manager

// --- Template Caching ---
// Read and compile the template once when the module is loaded.
const templatePath = path.resolve(__dirname, "./invoiceTemplate.html");
let compiledTemplate;
// Immediately-invoked function to load and compile the template
(async () => {
    try {
        const templateHtml = await fs.readFile(templatePath, "utf-8");
        compiledTemplate = handlebars.compile(templateHtml);
        console.log("Invoice template successfully compiled and cached.");
    } catch (error) {
        console.error("Failed to load and compile invoice template:", error);
        process.exit(1); // Exit if the template cannot be loaded, as it's critical
    }
})();
// --- End Template Caching ---

/**
 * Helper to format a number with commas.
 * @param {number} number - The number to format.
 * @returns {string} - The formatted number.
 */
function formatNumber(number) {
    if (number === undefined || number === null) return "0.00";
    return new Intl.NumberFormat("en-IN", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(number);
}

/**
 * Helper to format a date string.
 * @param {string | Date} dateString - The date to format.
 * @returns {string} - The formatted date.
 */
function formatDate(dateString) {
    if (!dateString) return "N/A";
    const date = new Date(dateString);
    return new Intl.DateTimeFormat("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
    }).format(date);
}

// Register the helpers with Handlebars
handlebars.registerHelper("formatNumber", formatNumber);
handlebars.registerHelper("formatDate", formatDate);


/**
 * Fetches invoice data and prepares it for the template.
 * @param {string} invoiceId - The ID of the invoice to fetch.
 * @returns {object} - The prepared invoice data.
 */
async function getPreparedInvoiceData(invoiceId) {
    const invoice = await Invoice.findById(invoiceId)
        .populate('productDetails.unit')
        .populate({
            path: 'paymentAndAmountInfo.payments.accountId',
            select: 'accountName'
        })
        .lean(); // Use .lean() for faster performance with templates

    if (!invoice) {
        throw new ApiError(404, "Invoice not found");
    }

    // --- Prepare data for the template ---
    const totalPayments = invoice.paymentAndAmountInfo.payments.reduce((sum, p) => sum + p.amount, 0);
    const balanceDue = invoice.paymentAndAmountInfo.totalAmountToBePaid - totalPayments;
    
    // Combine and format data
    const preparedData = {
        ...invoice,
        formattedInvoiceDate: formatDate(invoice.invoiceGeneratedDate),
        formattedSaleDate: formatDate(invoice.salesDate),
        shortSalesId: invoice.salesId.toString().slice(-6),
        productTotal: invoice.productDetails.quantity * invoice.productDetails.pricePerUnit,
        allChargesAndCosts: [
            ...(invoice.paymentAndAmountInfo.charges || []),
            ...(invoice.paymentAndAmountInfo.costs || [])
        ],
        totalPayments,
        balanceDue,
        paymentAndAmountInfo: {
            ...invoice.paymentAndAmountInfo,
            payments: (invoice.paymentAndAmountInfo.payments || []).map(p => ({
                ...p,
                formattedDate: formatDate(p.date),
                // Handle cases where account details might not be populated
                accountDetails: p.accountId ? { accountName: p.accountId.accountName } : { accountName: 'N/A' }
            }))
        }
    };

    return preparedData;
}


/**
 * Generates HTML from the cached Handlebars template and invoice data.
 * @param {object} data - The prepared invoice data.
 * @returns {string} - The compiled HTML string.
 */
function compileTemplate(data) {
    if (!compiledTemplate) {
        throw new Error("Invoice template is not compiled or available.");
    }
    return compiledTemplate(data);
}

/**
 * Generates a PDF from invoice data.
 * @param {string} invoiceId - The ID of the invoice.
 * @returns {Buffer} - The generated PDF buffer.
 */
async function generatePdf(invoiceId) {
    const data = await getPreparedInvoiceData(invoiceId);
    const html = compileTemplate({ invoice: data });

    const browser = await getBrowser();
    const page = await browser.newPage();
    
    try {
        await page.setContent(html, { waitUntil: 'networkidle0' });
        
        // Emulate print media type to apply print-specific CSS
        await page.emulateMediaType('print');

        const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: {
                top: '20px',
                right: '20px',
                bottom: '20px',
                left: '20px'
            }
        });

        return pdfBuffer;
    } finally {
        await page.close();
    }
}

/**
 * Generates a PNG image from invoice data.
 * @param {string} invoiceId - The ID of the invoice.
 * @returns {Buffer} - The generated PNG buffer.
 */
async function generatePng(invoiceId) {
    const data = await getPreparedInvoiceData(invoiceId);
    const html = compileTemplate({ invoice: data });

    const browser = await getBrowser();
    const page = await browser.newPage();

    try {
        await page.setViewport({ width: 800, height: 1120, deviceScaleFactor: 2 }); // A4-like aspect ratio, high-res
        
        await page.setContent(html, { waitUntil: 'networkidle0' });

        // Find the invoice element to screenshot
        const element = await page.$('#invoice-paper');
        if (!element) {
            throw new ApiError(500, "Could not find '#invoice-paper' element in the template for PNG generation.");
        }
        const imageBuffer = await element.screenshot({ type: 'png' });

        return imageBuffer;
    } finally {
        await page.close();
    }
}

module.exports = {
    generatePdf,
    generatePng,
};
