const PDFDocument = require("pdfkit");
const { format } = require('date-fns');

function generateLCPDF(lc, res) {
  // Validate input data - FIXED: Use camelCase
  if (!lc || !lc.basicInfo) {
    return res.status(400).json({ error: 'Invalid LC data provided' });
  }

  try {
    const doc = new PDFDocument({ 
      size: "A4", 
      margin: 40,
      info: {
        Title: `LC Document - ${lc.basicInfo.lcNumber}`,
        Author: 'LC Management System',
        Creator: 'LC Management System'
      }
    });

    // Set response headers
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="lc_${lc.basicInfo.lcNumber}_${format(new Date(), 'yyyy-MM-dd')}.pdf"`
    );

    // Handle stream errors properly
    doc.on('error', (error) => {
      console.error('PDF Stream Error:', error);
      if (!res.headersSent) {
        res.status(500).json({ 
          error: 'PDF generation failed', 
          details: error.message 
        });
      }
    });

    res.on('error', (error) => {
      console.error('Response Stream Error:', error);
    });

    doc.pipe(res);

    // Configuration
    const config = {
      primaryColor: [0, 0, 139], // Dark blue
      secondaryColor: [100, 100, 100],
      accentColor: [220, 53, 69],
      successColor: [40, 167, 69],
      warningColor: [255, 193, 7],
      lineHeight: 1.2,
      sectionSpacing: 15,
      paragraphSpacing: 8
    };

    // Generate content
    generatePDFContent(doc, lc, config);

    doc.end();

  } catch (error) {
    console.error('PDF Generation Error:', error);
    if (!res.headersSent) {
      res.status(500).json({ 
        error: 'Failed to generate PDF', 
        details: error.message 
      });
    }
  }
}

// Helper functions
function formatCurrency(amount, currency = 'BDT') {
  if (amount === null || amount === undefined || isNaN(amount)) return 'N/A';
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(amount) + ` ${currency}`;
}

function formatDate(dateString) {
  if (!dateString) return 'N/A';
  try {
    return format(new Date(dateString), 'dd MMM yyyy');
  } catch (error) {
    return 'Invalid Date';
  }
}

function drawSectionHeader(doc, config, title) {
  const startY = doc.y;
  
  doc.fillColor(config.primaryColor)
     .fontSize(16)
     .font("Helvetica-Bold")
     .text(title, { underline: false });
  
  doc.moveDown(0.3);
  doc.strokeColor(config.primaryColor)
     .lineWidth(1)
     .moveTo(40, doc.y)
     .lineTo(555, doc.y)
     .stroke();
  
  doc.moveDown(0.8);
  return startY;
}

function drawTable(doc, config, title, headers, data, columnWidths = null) {
  const startY = doc.y;
  
  if (title) {
    doc.fillColor(config.secondaryColor)
       .fontSize(12)
       .font("Helvetica-Bold")
       .text(title);
    doc.moveDown(0.5);
  }

  const tableTop = doc.y;
  const columnCount = headers.length;
  const pageWidth = 555 - 40;
  const columnSpacing = columnWidths 
    ? columnWidths 
    : Array(columnCount).fill(pageWidth / columnCount);

  // Draw table headers with background
  doc.fontSize(9).font("Helvetica-Bold");
  let x = 40;
  
  headers.forEach((header, i) => {
    // Draw header background
    doc.fillColor(config.primaryColor)
       .rect(x, tableTop, columnSpacing[i], 20)
       .fill();
    
    // Draw header text
    doc.fillColor([255, 255, 255])
       .text(header, x + 5, tableTop + 5, { 
         width: columnSpacing[i] - 10,
         align: 'left'
       });
    x += columnSpacing[i];
  });

  // Draw table rows
  doc.font("Helvetica");
  let y = tableTop + 20;
  
  data.forEach((row, rowIndex) => {
    // Check for page break before drawing row
    if (y > 700) {
      doc.addPage();
      y = 100;
      
      // Redraw headers on new page
      x = 40;
      headers.forEach((header, i) => {
        doc.fillColor(config.primaryColor)
           .rect(x, y, columnSpacing[i], 20)
           .fill()
           .fillColor([255, 255, 255])
           .font("Helvetica-Bold")
           .text(header, x + 5, y + 5, { 
             width: columnSpacing[i] - 10,
             align: 'left'
           });
        x += columnSpacing[i];
      });
      y += 20;
    }

    // Alternate row colors
    const rowColor = rowIndex % 2 === 0 ? [248, 249, 250] : [255, 255, 255];
    
    x = 40;
    let maxCellHeight = 0;
    
    // Calculate cell heights
    const cellHeights = row.map((cell, i) => {
      return doc.heightOfString(cell.toString(), { 
        width: columnSpacing[i] - 10 
      }) + 10;
    });
    maxCellHeight = Math.max(...cellHeights);

    // Draw cell backgrounds
    row.forEach((_, i) => {
      doc.fillColor(rowColor)
         .rect(x, y, columnSpacing[i], maxCellHeight)
         .fill();
      x += columnSpacing[i];
    });

    // Draw cell text
    x = 40;
    row.forEach((cell, i) => {
      doc.fillColor([0, 0, 0])
         .text(cell.toString(), x + 5, y + 5, { 
           width: columnSpacing[i] - 10,
           align: 'left'
         });
      x += columnSpacing[i];
    });

    y += maxCellHeight;
  });

  doc.y = y + 10;
  return startY;
}

function drawKeyValuePair(doc, config, key, value, indent = 0) {
  const xPos = 40 + (indent * 15);
  
  doc.fillColor(config.secondaryColor)
     .fontSize(10)
     .font("Helvetica-Bold")
     .text(`${key}:`, xPos, doc.y, { continued: true })
     .fillColor([0, 0, 0])
     .font("Helvetica")
     .text(` ${value || 'N/A'}`);
  
  doc.moveDown(0.5);
}

function drawStatusBadge(doc, config, status) {
  const statusColors = {
    'draft': config.secondaryColor,
    'active': config.successColor,
    'completed': config.primaryColor,
    'cancelled': config.accentColor
  };
  
  const statusColor = statusColors[status?.toLowerCase()] || config.secondaryColor;
  
  doc.fillColor(statusColor)
     .fontSize(10)
     .font("Helvetica-Bold")
     .text(`Status: ${status?.toUpperCase() || 'UNKNOWN'}`, { 
       align: 'right'
     });
}

function addFooter(doc, config, pageNumber, totalPages) {
  const bottomY = 800;
  
  doc.save()
     .fontSize(8)
     .fillColor(config.secondaryColor)
     .text(`Page ${pageNumber} of ${totalPages} - Generated on ${format(new Date(), 'dd MMM yyyy, HH:mm')}`, 40, bottomY, {
       align: 'center',
       width: 555 - 40
     })
     .restore();
}

function generatePDFContent(doc, lc, config) {
  let currentPage = 1;
  
  // Header
  doc.fillColor(config.primaryColor)
     .fontSize(20)
     .font("Helvetica-Bold")
     .text('LETTER OF CREDIT DOCUMENT', { align: 'center' });
  
  doc.fontSize(12)
     .font("Helvetica")
     .text(`LC Number: ${lc.basicInfo.lcNumber}`, { align: 'center' });
  
  doc.moveDown(1);

  // Status
  drawStatusBadge(doc, config, lc.basicInfo.status);
  doc.moveDown(1.5);

  // Basic Information Section
  drawSectionHeader(doc, config, 'Basic Information');
  
  drawKeyValuePair(doc, config, 'LC Number', lc.basicInfo.lcNumber);
  drawKeyValuePair(doc, config, 'LC Opening Date', formatDate(lc.basicInfo.lcOpeningDate));
  drawKeyValuePair(doc, config, 'Status', lc.basicInfo.status);
  drawKeyValuePair(doc, config, 'Bank Name', lc.basicInfo.accountId?.bankName);
  drawKeyValuePair(doc, config, 'Account Holder', lc.basicInfo.accountId?.accountHolderName);
  drawKeyValuePair(doc, config, 'Supplier Name', lc.basicInfo.supplierName);
  drawKeyValuePair(doc, config, 'Supplier Country', lc.basicInfo.supplierCountry);

  doc.moveDown(config.sectionSpacing / 2);

  // Financial Information Section
  drawSectionHeader(doc, config, 'Financial Information');
  
  drawKeyValuePair(doc, config, 'LC Amount (USD)', formatCurrency(lc.financialInfo.lcAmountUsd, 'USD'));
  drawKeyValuePair(doc, config, 'Exchange Rate', lc.financialInfo.exchangeRate?.toFixed(4));
  drawKeyValuePair(doc, config, 'LC Amount (BDT)', formatCurrency(lc.financialInfo.lcAmountBdt));

  // Financial Costs
  if (lc.financialInfo.costs && lc.financialInfo.costs.length > 0) {
    doc.moveDown(0.5);
    drawTable(
      doc,
      config,
      "Financial Costs",
      ["Date", "Description", "Payment Method", "Amount (BDT)"],
      lc.financialInfo.costs.map(e => [
        formatDate(e.date),
        e.name,
        e.paymentMethod || 'N/A',
        formatCurrency(e.amount)
      ]),
      [80, 180, 100, 90]
    );
  }

  doc.moveDown(config.sectionSpacing / 2);

  // Product Information Section
  if (lc.productInfo && lc.productInfo.length > 0) {
    drawSectionHeader(doc, config, 'Product Information');
    
    lc.productInfo.forEach((product, index) => {
      doc.fillColor(config.primaryColor)
         .fontSize(12)
         .font("Helvetica-Bold")
         .text(`Product ${index + 1}: ${product.itemName}`);
      doc.moveDown(0.3);
      
      drawKeyValuePair(doc, config, 'Item Name', product.itemName, 1);
      
      const quantityUnit = product.quantityUnit?.name || 'units';
      drawKeyValuePair(doc, config, 'Quantity', `${product.quantity} ${quantityUnit}`, 1);
      drawKeyValuePair(doc, config, 'Unit Price (USD)', formatCurrency(product.unitPriceUsd, 'USD'), 1);
      drawKeyValuePair(doc, config, 'Total Value (USD)', formatCurrency(product.totalValueUsd, 'USD'), 1);
      
      if (product.thickness || product.width || product.length || product.grade) {
        const specs = [];
        if (product.thickness) specs.push(`Thickness: ${product.thickness}`);
        if (product.width) specs.push(`Width: ${product.width}`);
        if (product.length) specs.push(`Length: ${product.length}`);
        if (product.grade) specs.push(`Grade: ${product.grade}`);
        
        drawKeyValuePair(doc, config, 'Specification', specs.join(', '), 1);
      }
      
      if (index < lc.productInfo.length - 1) {
        doc.moveDown(0.5);
        doc.strokeColor([200, 200, 200])
           .lineWidth(0.5)
           .moveTo(55, doc.y)
           .lineTo(555, doc.y)
           .stroke();
        doc.moveDown(0.5);
      }
    });
    
    doc.moveDown(config.sectionSpacing / 2);
  }

  // Shipping & Customs Information Section
  if (lc.shippingCustomsInfo && (
    lc.shippingCustomsInfo.portOfShipment ||
    lc.shippingCustomsInfo.expectedArrivalDate ||
    (lc.shippingCustomsInfo.costs && lc.shippingCustomsInfo.costs.length > 0)
  )) {
    drawSectionHeader(doc, config, 'Shipping & Customs Information');
    
    drawKeyValuePair(doc, config, 'Port of Shipment', lc.shippingCustomsInfo.portOfShipment);
    drawKeyValuePair(doc, config, 'Expected Arrival Date', formatDate(lc.shippingCustomsInfo.expectedArrivalDate));

    // Shipping Costs
    if (lc.shippingCustomsInfo.costs && lc.shippingCustomsInfo.costs.length > 0) {
      doc.moveDown(0.5);
      drawTable(
        doc,
        config,
        "Shipping & Customs Costs",
        ["Date", "Description", "Payment Method", "Amount (BDT)"],
        lc.shippingCustomsInfo.costs.map(e => [
          formatDate(e.date),
          e.name,
          e.paymentMethod || 'N/A',
          formatCurrency(e.amount)
        ]),
        [80, 180, 100, 90]
      );
    }

    doc.moveDown(config.sectionSpacing / 2);
  }

  // Agent & Transport Information Section
  if (lc.agentTransportInfo && lc.agentTransportInfo.costs && lc.agentTransportInfo.costs.length > 0) {
    drawSectionHeader(doc, config, 'Agent & Transport Information');
    
    drawTable(
      doc,
      config,
      "Agent & Transport Costs",
      ["Date", "Description", "Payment Method", "Amount (BDT)"],
      lc.agentTransportInfo.costs.map(e => [
        formatDate(e.date),
        e.name,
        e.paymentMethod || 'N/A',
        formatCurrency(e.amount)
      ]),
      [80, 180, 100, 90]
    );

    doc.moveDown(config.sectionSpacing / 2);
  }

  // Documents & Notes Section
  if (lc.documentsNotes && (
    lc.documentsNotes.note ||
    (lc.documentsNotes.uploadedDocuments && lc.documentsNotes.uploadedDocuments.length > 0)
  )) {
    drawSectionHeader(doc, config, 'Documents & Notes');
    
    if (lc.documentsNotes.note && lc.documentsNotes.note !== 'No notes given') {
      drawKeyValuePair(doc, config, 'Notes', lc.documentsNotes.note);
    }
    
    if (lc.documentsNotes.uploadedDocuments && lc.documentsNotes.uploadedDocuments.length > 0) {
      doc.moveDown(0.5);
      doc.fillColor(config.secondaryColor)
         .fontSize(11)
         .font("Helvetica-Bold")
         .text('Uploaded Documents:');
      doc.moveDown(0.3);
      
      lc.documentsNotes.uploadedDocuments.forEach((docFile, index) => {
        const sizeInKB = docFile.sizeBytes ? (docFile.sizeBytes / 1024).toFixed(2) : 'N/A';
        drawKeyValuePair(
          doc,
          config,
          `${index + 1}. ${docFile.originalName}`,
          `${sizeInKB} KB`,
          1
        );
      });
    }

    doc.moveDown(config.sectionSpacing / 2);
  }

  // Other Expenses Section
  if (lc.otherExpenses && lc.otherExpenses.costs && lc.otherExpenses.costs.length > 0) {
    drawSectionHeader(doc, config, 'Other Miscellaneous Expenses');
    drawTable(
      doc,
      config,
      null,
      ["Date", "Description", "Payment Method", "Amount (BDT)"],
      lc.otherExpenses.costs.map(e => [
        formatDate(e.date),
        e.name,
        e.paymentMethod || 'N/A',
        formatCurrency(e.amount)
      ]),
      [80, 180, 100, 90]
    );
  }

  // Total Cost Summary
  if (lc.totalCost) {
    doc.moveDown(1);
    doc.fillColor(config.primaryColor)
       .fontSize(14)
       .font("Helvetica-Bold")
       .text(`Total LC Cost: ${formatCurrency(lc.totalCost)}`, { align: 'right' });
  }

  // Add footer
  const totalPages = doc.bufferedPageRange().count + 1;
  addFooter(doc, config, currentPage, totalPages);
}

module.exports = { generateLCPDF };