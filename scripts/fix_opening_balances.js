const mongoose = require('mongoose');
require('dotenv').config({ path: '../.env' }); // Adjust path if needed
const Sales = require('../models/sales.model');

async function fixOpeningBalances() {
    try {
        await mongoose.connect(process.env.MONGODB_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
        });
        console.log('Connected to MongoDB');

        // Find all sales starting with OPEN-BAL
        const openingSales = await Sales.find({ saleId: { $regex: /^OPEN-BAL-/ } });
        console.log(`Found ${openingSales.length} opening balance sales. Fixing...`);

        let fixedCount = 0;
        for (let sale of openingSales) {
            if (sale.balanceDue === 0 && sale.totalAmountToBePaid > 0 && sale.payments.length === 0) {
                sale.balanceDue = sale.totalAmountToBePaid;
                await sale.save();
                fixedCount++;
            } else if (sale.balanceDue !== undefined) {
                // just in case they have payments, recalculate
                const totalPaid = sale.payments.reduce((sum, p) => sum + (p.amount || 0), 0);
                const diff = sale.totalAmountToBePaid - totalPaid;
                if (sale.balanceDue !== diff && diff > 0) {
                    sale.balanceDue = diff;
                    await sale.save();
                    fixedCount++;
                }
            }
        }

        console.log(`Fixed ${fixedCount} opening balance sales.`);
        process.exit(0);
    } catch (err) {
        console.error('Error fixing opening balances:', err);
        process.exit(1);
    }
}

fixOpeningBalances();
