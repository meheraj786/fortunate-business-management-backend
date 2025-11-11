const PDFDocument = require("pdfkit");
const { format } = require('date-fns');

function generateLCPDF(lc, res) {
  // Validate input data
  if (!lc || !lc.basic_info) {
    return res.status(400).json({ error: 'Invalid LC data provided' });
  }

  try {
    const doc = new PDFDocument({ 
      size: "A4", 
      margin: 40,
      info: {
        Title: `LC Document - ${lc.basic_info.lc_number}`,
        Author: 'LC Management System',
        Creator: 'LC Management System'
      }
    });

    // Set response headers
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="lc_${lc.basic_info.lc_number}_${format(new Date(), 'yyyy-MM-dd')}.pdf"`
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
     .text(`LC Number: ${lc.basic_info.lc_number}`, { align: 'center' });
  
  doc.moveDown(1);

  // Status
  drawStatusBadge(doc, config, lc.basic_info.status);
  doc.moveDown(1.5);

  // Basic Information Section
  drawSectionHeader(doc, config, 'Basic Information');
  
  drawKeyValuePair(doc, config, 'LC Number', lc.basic_info.lc_number);
  drawKeyValuePair(doc, config, 'LC Opening Date', formatDate(lc.basic_info.lc_opening_date));
  drawKeyValuePair(doc, config, 'Status', lc.basic_info.status);
  drawKeyValuePair(doc, config, 'Bank Name', lc.basic_info.bank_name);
  drawKeyValuePair(doc, config, 'Supplier Name', lc.basic_info.supplier_name);
  drawKeyValuePair(doc, config, 'Supplier Country', lc.basic_info.supplier_country);

  doc.moveDown(config.sectionSpacing / 2);

  // Financial Information Section
  drawSectionHeader(doc, config, 'Financial Information');
  
  drawKeyValuePair(doc, config, 'LC Amount (USD)', formatCurrency(lc.financial_info.lc_amount_usd, 'USD'));
  drawKeyValuePair(doc, config, 'Exchange Rate', lc.financial_info.exchange_rate?.toFixed(4));
  drawKeyValuePair(doc, config, 'LC Amount (BDT)', formatCurrency(lc.financial_info.lc_amount_bdt));
  drawKeyValuePair(doc, config, 'LC Margin Paid (BDT)', formatCurrency(lc.financial_info.lc_margin_paid_bdt));
  drawKeyValuePair(doc, config, 'Bank Charges (BDT)', formatCurrency(lc.financial_info.bank_charges_bdt));
  drawKeyValuePair(doc, config, 'Insurance Cost (BDT)', formatCurrency(lc.financial_info.insurance_cost_bdt));

  // Financial Other Expenses
  if (lc.financial_info.other_expenses && lc.financial_info.other_expenses.length > 0) {
    doc.moveDown(0.5);
    drawTable(
      doc,
      config,
      "Other Financial Expenses",
      ["Date", "Description", "Amount (BDT)"],
      lc.financial_info.other_expenses.map(e => [
        formatDate(e.date),
        e.name,
        formatCurrency(e.amount)
      ]),
      [80, 250, 120]
    );
  }

  doc.moveDown(config.sectionSpacing / 2);

  // Product Information Section
  if (lc.product_info && lc.product_info.length > 0) {
    drawSectionHeader(doc, config, 'Product Information');
    
    lc.product_info.forEach((product, index) => {
      doc.fillColor(config.primaryColor)
         .fontSize(12)
         .font("Helvetica-Bold")
         .text(`Product ${index + 1}: ${product.item_name}`);
      doc.moveDown(0.3);
      
      drawKeyValuePair(doc, config, 'Item Name', product.item_name, 1);
      drawKeyValuePair(doc, config, 'Quantity', `${product.quantity_ton} ${product.quantity_unit}`, 1);
      drawKeyValuePair(doc, config, 'Unit Price (USD)', formatCurrency(product.unit_price_usd, 'USD'), 1);
      drawKeyValuePair(doc, config, 'Total Value (USD)', formatCurrency(product.total_value_usd, 'USD'), 1);
      
      if (product.specification) {
        const spec = product.specification;
        if (spec.thickness_mm || spec.width_mm || spec.length_mm || spec.grade) {
          drawKeyValuePair(
            doc,
            config,
            'Specification', 
            `${spec.thickness_mm || 'N/A'}mm × ${spec.width_mm || 'N/A'}mm × ${spec.length_mm || 'N/A'}mm${spec.grade ? `, Grade: ${spec.grade}` : ''}`,
            1
          );
        }
      }
      
      if (index < lc.product_info.length - 1) {
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
  if (lc.shipping_customs_info && (
    lc.shipping_customs_info.port_of_shipment ||
    lc.shipping_customs_info.expected_arrival_date ||
    lc.shipping_customs_info.customs_duty_bdt ||
    lc.shipping_customs_info.vat_bdt ||
    lc.shipping_customs_info.ait_bdt
  )) {
    drawSectionHeader(doc, config, 'Shipping & Customs Information');
    
    drawKeyValuePair(doc, config, 'Port of Shipment', lc.shipping_customs_info.port_of_shipment);
    drawKeyValuePair(doc, config, 'Expected Arrival Date', formatDate(lc.shipping_customs_info.expected_arrival_date));
    drawKeyValuePair(doc, config, 'Customs Duty (BDT)', formatCurrency(lc.shipping_customs_info.customs_duty_bdt));
    drawKeyValuePair(doc, config, 'VAT (BDT)', formatCurrency(lc.shipping_customs_info.vat_bdt));
    drawKeyValuePair(doc, config, 'AIT (BDT)', formatCurrency(lc.shipping_customs_info.ait_bdt));

    // Shipping Other Expenses
    if (lc.shipping_customs_info.other_expenses && lc.shipping_customs_info.other_expenses.length > 0) {
      doc.moveDown(0.5);
      drawTable(
        doc,
        config,
        "Other Shipping Expenses",
        ["Date", "Description", "Amount (BDT)"],
        lc.shipping_customs_info.other_expenses.map(e => [
          formatDate(e.date),
          e.name,
          formatCurrency(e.amount)
        ]),
        [80, 250, 120]
      );
    }

    doc.moveDown(config.sectionSpacing / 2);
  }

  // Agent & Transport Information Section
  if (lc.agent_transport_info && (
    lc.agent_transport_info.cnf_agent_name ||
    lc.agent_transport_info.cnf_agent_commission_bdt ||
    lc.agent_transport_info.indenting_agent_commission_bdt ||
    lc.agent_transport_info.transport_cost_bdt
  )) {
    drawSectionHeader(doc, config, 'Agent & Transport Information');
    
    drawKeyValuePair(doc, config, 'C&F Agent Name', lc.agent_transport_info.cnf_agent_name);
    drawKeyValuePair(doc, config, 'C&F Agent Commission (BDT)', formatCurrency(lc.agent_transport_info.cnf_agent_commission_bdt));
    drawKeyValuePair(doc, config, 'Indenting Agent Commission (BDT)', formatCurrency(lc.agent_transport_info.indenting_agent_commission_bdt));
    drawKeyValuePair(doc, config, 'Transport Cost (BDT)', formatCurrency(lc.agent_transport_info.transport_cost_bdt));

    // Agent Other Expenses
    if (lc.agent_transport_info.other_expenses && lc.agent_transport_info.other_expenses.length > 0) {
      doc.moveDown(0.5);
      drawTable(
        doc,
        config,
        "Other Agent Expenses",
        ["Date", "Description", "Amount (BDT)"],
        lc.agent_transport_info.other_expenses.map(e => [
          formatDate(e.date),
          e.name,
          formatCurrency(e.amount)
        ]),
        [80, 250, 120]
      );
    }

    doc.moveDown(config.sectionSpacing / 2);
  }

  // Documents & Notes Section
  if (lc.documents_notes && (
    lc.documents_notes.remarks ||
    (lc.documents_notes.uploaded_documents && lc.documents_notes.uploaded_documents.length > 0)
  )) {
    drawSectionHeader(doc, config, 'Documents & Notes');
    
    if (lc.documents_notes.remarks) {
      drawKeyValuePair(doc, config, 'Remarks', lc.documents_notes.remarks);
    }
    
    if (lc.documents_notes.uploaded_documents && lc.documents_notes.uploaded_documents.length > 0) {
      doc.moveDown(0.5);
      doc.fillColor(config.secondaryColor)
         .fontSize(11)
         .font("Helvetica-Bold")
         .text('Uploaded Documents:');
      doc.moveDown(0.3);
      
      lc.documents_notes.uploaded_documents.forEach((docFile, index) => {
        const sizeInKB = docFile.size_bytes ? (docFile.size_bytes / 1024).toFixed(2) : 'N/A';
        drawKeyValuePair(
          doc,
          config,
          `${index + 1}. ${docFile.original_name}`,
          `${sizeInKB} KB`,
          1
        );
      });
    }

    doc.moveDown(config.sectionSpacing / 2);
  }

  // Other Expenses Section
  if (lc.other_expenses && lc.other_expenses.length > 0) {
    drawSectionHeader(doc, config, 'Other Miscellaneous Expenses');
    drawTable(
      doc,
      config,
      null,
      ["Date", "Description", "Amount (BDT)"],
      lc.other_expenses.map(e => [
        formatDate(e.date),
        e.name,
        formatCurrency(e.amount)
      ]),
      [80, 250, 120]
    );
  }

  // Add footer
  const totalPages = doc.bufferedPageRange().count + 1;
  addFooter(doc, config, currentPage, totalPages);
}

module.exports = { generateLCPDF };