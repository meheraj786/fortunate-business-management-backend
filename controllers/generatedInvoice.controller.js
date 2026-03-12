const { generatePdf, generatePng } = require("../utils/invoiceGenerator");
const Invoice = require("../models/invoice.model");
const { ApiError } = require("../utils/ApiError");
const auditService = require("../services/audit.service");

/**
 * Handles the request to generate and send an invoice as a PDF.
 */
async function getInvoiceAsPdf(req, res, next) {
    try {
        const { invoiceId } = req.params;
        if (!invoiceId) {
            throw new ApiError(400, "Invoice ID is required.");
        }

        // Fetch the invoice to get the human-readable invoiceId for the filename
        const invoice = await Invoice.findById(invoiceId).select("invoiceId updatedAt").lean();
        if (!invoice) {
            throw new ApiError(404, "Invoice not found.");
        }

        const pdfBuffer = await generatePdf(invoiceId);

        // Use human-readable invoice ID (e.g., INV-26-000001) in the filename
        const safeFilename = invoice.invoiceId.replace(/[^a-zA-Z0-9-_]/g, "_");

        // Cache headers — invoice content is immutable once generated, safe to cache
        const lastModified = invoice.updatedAt || new Date();
        res.setHeader("Last-Modified", lastModified.toUTCString());
        res.setHeader("ETag", `"pdf-${invoiceId}-${lastModified.getTime()}"`);
        res.setHeader("Cache-Control", "private, max-age=300"); // 5 min cache

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader(
            "Content-Disposition",
            `attachment; filename=${safeFilename}.pdf`,
        );
        res.send(pdfBuffer);

        // Audit: Invoice downloaded as PDF (fire-and-forget)
        auditService.log({ action: "DOWNLOAD", module: "Invoice", documentId: invoiceId, displayId: invoice.invoiceId, userId: req.user?._id, description: `Downloaded invoice ${invoice.invoiceId} as PDF`, req });
    } catch (error) {
        if (error instanceof ApiError) {
            return next(error);
        }
        console.error("PDF Generation Error:", error);
        next(new ApiError(500, "Failed to generate PDF for the invoice."));
    }
}

/**
 * Handles the request to generate and send an invoice as a PNG.
 */
async function getInvoiceAsPng(req, res, next) {
    try {
        const { invoiceId } = req.params;
        if (!invoiceId) {
            throw new ApiError(400, "Invoice ID is required.");
        }

        // Fetch the invoice to get updatedAt for caching
        const invoice = await Invoice.findById(invoiceId).select("invoiceId updatedAt").lean();
        if (!invoice) {
            throw new ApiError(404, "Invoice not found.");
        }

        const pngBuffer = await generatePng(invoiceId);

        // Cache headers
        const lastModified = invoice.updatedAt || new Date();
        res.setHeader("Last-Modified", lastModified.toUTCString());
        res.setHeader("ETag", `"png-${invoiceId}-${lastModified.getTime()}"`);
        res.setHeader("Cache-Control", "private, max-age=300");

        res.setHeader("Content-Type", "image/png");
        res.send(pngBuffer);

        // Audit: Invoice downloaded as PNG (fire-and-forget)
        auditService.log({ action: "DOWNLOAD", module: "Invoice", documentId: invoiceId, displayId: invoice.invoiceId, userId: req.user?._id, description: `Downloaded invoice ${invoice.invoiceId} as PNG`, req });
    } catch (error) {
        if (error instanceof ApiError) {
            return next(error);
        }
        console.error("PNG Generation Error:", error);
        next(new ApiError(500, "Failed to generate PNG for the invoice."));
    }
}

module.exports = {
    getInvoiceAsPdf,
    getInvoiceAsPng,
};
