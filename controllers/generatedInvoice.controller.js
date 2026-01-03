const { generatePdf, generatePng } = require("../utils/invoiceGenerator");
const { ApiError } = require("../utils/ApiError");

/**
 * Handles the request to generate and send an invoice as a PDF.
 * @param {object} req - Express request object.
 * @param {object} res - Express response object.
 * @param {function} next - Express next middleware function.
 */
async function getInvoiceAsPdf(req, res, next) {
    try {
        const { invoiceId } = req.params;
        if (!invoiceId) {
            throw new ApiError(400, "Invoice ID is required.");
        }

        const pdfBuffer = await generatePdf(invoiceId);

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader(
            "Content-Disposition",
            `attachment; filename=invoice-${invoiceId}.pdf`
        );
        res.send(pdfBuffer);
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
 * @param {object} req - Express request object.
 * @param {object} res - Express response object.
 * @param {function} next - Express next middleware function.
 */
async function getInvoiceAsPng(req, res, next) {
    try {
        const { invoiceId } = req.params;
        if (!invoiceId) {
            throw new ApiError(400, "Invoice ID is required.");
        }

        const pngBuffer = await generatePng(invoiceId);

        res.setHeader("Content-Type", "image/png");
        res.send(pngBuffer);
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
