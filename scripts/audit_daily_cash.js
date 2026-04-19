const mongoose = require("mongoose");
const path = require("path");

const DailyCash = require("../models/dailyCash.model");
const Transaction = require("../models/transaction.model");
const Account = require("../models/account.model");
const mathUtil = require("../utils/math.util");
const { startOfDay, endOfDay } = require("../utils/timezone.util");
const timezone = "Asia/Dhaka";

const PROD_URI = "mongodb://fortunateuser:fortunate12345@127.0.0.1:27017/fortunatedb?replicaSet=rs0";

async function runAudit() {
  try {
    console.log("Connecting to PROD database (Read-Only Audit)...");
    await mongoose.connect(PROD_URI, { readPreference: 'primaryPreferred' });
    console.log("Connected.");

    // 1. Check Cash Accounts
    const cashAccounts = await Account.find({ accountType: "Cash", isDeleted: { $ne: true } });
    let totalActualCashBalance = 0;
    
    console.log(`\n--- Cash Accounts Audit ---`);
    for (const acc of cashAccounts) {
      // Sum all non-deleted transactions for this account
      const txs = await Transaction.aggregate([
        { $match: { accountId: acc._id, isDeleted: { $ne: true } } },
        { 
          $group: { 
            _id: null, 
            income: { $sum: { $cond: [{ $eq: ["$transactionType", "Income"] }, "$amount", 0] } },
            expense: { $sum: { $cond: [{ $eq: ["$transactionType", "Expense"] }, "$amount", 0] } }
          }
        }
      ]);

      const income = txs.length ? txs[0].income : 0;
      const expense = txs.length ? txs[0].expense : 0;
      const calculatedBalance = mathUtil.sub(income, expense);
      
      console.log(`Account [${acc.accountName}]: Stored Balance = ${acc.balance}, Calculated from TXs = ${calculatedBalance}`);
      if (acc.balance !== calculatedBalance) {
         console.warn(`>> MISMATCH FOUND in Account: ${acc.accountName}. Difference = ${mathUtil.sub(acc.balance, calculatedBalance)}`);
      }
      totalActualCashBalance = mathUtil.add(totalActualCashBalance, acc.balance);
    }
    
    // 2. Daily Cash Audit
    console.log(`\n--- Daily Cash Sessions Audit ---`);
    const uniqueDates = await DailyCash.aggregate([
      { $group: { _id: "$date" } },
      { $sort: { _id: 1 } }
    ]);

    let simulatedClosingBalance = null;
    let foundMismatch = false;

    for (let i = 0; i < uniqueDates.length; i++) {
        const targetDate = uniqueDates[i]._id;
        const targetDateStart = startOfDay(new Date(targetDate), timezone);
        const nextDay = new Date(endOfDay(targetDateStart, timezone).getTime() + 1);

        const sessions = await DailyCash.find({ date: targetDate }).sort({ createdAt: 1 });
        
        let initialOpeningBalance = sessions[0].openingBalance;
        
        if (i > 0 && simulatedClosingBalance !== null) {
           if (initialOpeningBalance !== simulatedClosingBalance) {
               console.log(`[${targetDateStart.toDateString()}] BUG: Expected opening balance ${simulatedClosingBalance}, but found ${initialOpeningBalance}.`);
               foundMismatch = true;
           }
           // Use what should have been the correct opening balance to find true divergence
           initialOpeningBalance = simulatedClosingBalance;
        }

        // Get transactions for that day
        const pipeline = [
          {
            $match: {
              date: { $gte: targetDateStart, $lt: nextDay },
              isDeleted: { $ne: true },
              paymentMethod: "Cash"
             }
          },
          {
            $group: {
              _id: null,
              income: { $sum: { $cond: [{ $eq: ["$transactionType", "Income"] }, "$amount", 0] } },
              expense: { $sum: { $cond: [{ $eq: ["$transactionType", "Expense"] }, "$amount", 0] } }
            }
          }
        ];

        const result = await Transaction.aggregate(pipeline);
        const inc = result.length > 0 ? result[0].income : 0;
        const exp = result.length > 0 ? result[0].expense : 0;
        
        const trueRunningBalance = mathUtil.add(initialOpeningBalance, mathUtil.sub(inc, exp));
        
        // Find last session of the day
        const lastSession = sessions[sessions.length - 1];
        if (lastSession.status === "Closed" && lastSession.closingBalance !== trueRunningBalance) {
          console.log(`[${targetDateStart.toDateString()}] BUG: Expected closing balance ${trueRunningBalance}, but stored is ${lastSession.closingBalance}.`);
          foundMismatch = true;
        }

        simulatedClosingBalance = trueRunningBalance;
    }

    console.log(`\n--- Final Results ---`);
    console.log(`Total Stored Cash Account Balance: ${totalActualCashBalance}`);
    const actualDailyCash = await DailyCash.findOne().sort({ date: -1, createdAt: -1 });
    console.log(`Stored Last Daily Cash Balance (Opening + Last Session Flow): ${actualDailyCash ? (actualDailyCash.status === 'Closed' ? actualDailyCash.closingBalance : actualDailyCash.openingBalance + ' (plus intra-day transactions)') : 0}`);
    console.log(`Calculated Daily Cash (True Balance): ${simulatedClosingBalance}`);

    if (totalActualCashBalance !== simulatedClosingBalance) {
      console.warn(">> FATAL: The true calculation of transactions does NOT match the account balances!");
    } else {
      console.log(">> OK: The true calculation matches the Account balances. The issue is only inside DailyCash stored values.");
    }
    
    // Check if there are soft deleted Cash transactions
    const deletedTxs = await Transaction.countDocuments({ isDeleted: true, paymentMethod: "Cash" });
    console.log(`Soft Deleted Cash Transactions Found: ${deletedTxs}`);

  } catch (err) {
    console.error(err);
  } finally {
    await mongoose.disconnect();
    console.log("Disconnected.");
    process.exit(0);
  }
}

runAudit();
