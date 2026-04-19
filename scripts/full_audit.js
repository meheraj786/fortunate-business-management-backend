/**
 * FULL PRODUCTION AUDIT — READ-ONLY
 * Performs a comprehensive integrity check of:
 *   1. Each day's daily cash: opening → transactions → running balance → closing
 *   2. Each account's stored balance vs calculated balance from transactions
 *   3. Cross-check: sum of all Cash accounts vs daily cash final running balance
 *   4. Detects orphaned/broken transactions (missing paymentMethod, etc.)
 */

const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const DailyCash = require("../models/dailyCash.model");
const Transaction = require("../models/transaction.model");
const Account = require("../models/account.model");
const mathUtil = require("../utils/math.util");
const { startOfDay, endOfDay } = require("../utils/timezone.util");

const timezone = "Asia/Dhaka";
const PROD_URI = "mongodb://fortunateuser:fortunate12345@127.0.0.1:27017/fortunatedb?replicaSet=rs0";

async function fullAudit() {
  try {
    console.log("=== FULL PRODUCTION AUDIT (READ-ONLY) ===");
    console.log(`Started at: ${new Date().toISOString()}\n`);

    await mongoose.connect(PROD_URI, { readPreference: "secondaryPreferred" });
    console.log("Connected to production DB (read-only preference).\n");

    // ============================================================
    // SECTION 1: ACCOUNT BALANCE INTEGRITY
    // ============================================================
    console.log("╔══════════════════════════════════════════════════╗");
    console.log("║     SECTION 1: ACCOUNT BALANCE INTEGRITY        ║");
    console.log("╚══════════════════════════════════════════════════╝\n");

    const allAccounts = await Account.find({ isDeleted: { $ne: true } }).lean();
    let totalAccountIssues = 0;
    let totalCashAccountBalance = 0;

    for (const acc of allAccounts) {
      const txAgg = await Transaction.aggregate([
        { $match: { accountId: acc._id, isDeleted: { $ne: true } } },
        {
          $group: {
            _id: null,
            income: { $sum: { $cond: [{ $eq: ["$transactionType", "Income"] }, "$amount", 0] } },
            expense: { $sum: { $cond: [{ $eq: ["$transactionType", "Expense"] }, "$amount", 0] } },
            count: { $sum: 1 },
          },
        },
      ]);

      const income = txAgg.length ? txAgg[0].income : 0;
      const expense = txAgg.length ? txAgg[0].expense : 0;
      const txCount = txAgg.length ? txAgg[0].count : 0;
      const calculatedBalance = mathUtil.sub(income, expense);
      const diff = mathUtil.sub(acc.balance, calculatedBalance);

      if (acc.accountType === "Cash") {
        totalCashAccountBalance = mathUtil.add(totalCashAccountBalance, acc.balance);
      }

      if (Math.abs(diff) > 0.009) {
        totalAccountIssues++;
        console.log(`  ❌ MISMATCH: [${acc.accountType}] "${acc.accountName}"`);
        console.log(`     Stored Balance:     ${acc.balance}`);
        console.log(`     Calculated (TXs):   ${calculatedBalance}  (${txCount} transactions)`);
        console.log(`     Difference:         ${diff}`);
        console.log();
      } else {
        console.log(`  ✅ OK: [${acc.accountType}] "${acc.accountName}" = ${acc.balance} (${txCount} txs)`);
      }
    }

    console.log(`\n  Summary: ${totalAccountIssues} account mismatches found out of ${allAccounts.length} accounts.`);
    console.log(`  Total Cash Account Balance (sum): ${totalCashAccountBalance}\n`);

    // ============================================================
    // SECTION 2: DAILY CASH CHAIN INTEGRITY
    // ============================================================
    console.log("╔══════════════════════════════════════════════════╗");
    console.log("║     SECTION 2: DAILY CASH CHAIN INTEGRITY       ║");
    console.log("╚══════════════════════════════════════════════════╝\n");

    const uniqueDates = await DailyCash.aggregate([
      { $group: { _id: "$date" } },
      { $sort: { _id: 1 } },
    ]);

    if (uniqueDates.length === 0) {
      console.log("  No Daily Cash sessions found.\n");
    }

    let previousClosingBalance = null;
    let chainIssues = 0;
    let dailyCashFinalBalance = null;

    for (let i = 0; i < uniqueDates.length; i++) {
      const targetDate = uniqueDates[i]._id;
      const targetDateStart = startOfDay(new Date(targetDate), timezone);
      const nextDay = new Date(endOfDay(targetDateStart, timezone).getTime() + 1);

      const sessions = await DailyCash.find({ date: targetDate }).sort({ createdAt: 1 }).lean();
      const dayOpeningBalance = sessions[0].openingBalance;

      // Get ACTUAL opening balance (from chain)
      let expectedOpening = dayOpeningBalance;
      if (i > 0 && previousClosingBalance !== null) {
        expectedOpening = previousClosingBalance;
      }

      // Fetch Cash transactions for this day
      const txResult = await Transaction.aggregate([
        {
          $match: {
            date: { $gte: targetDateStart, $lt: nextDay },
            isDeleted: { $ne: true },
            paymentMethod: "Cash",
          },
        },
        {
          $group: {
            _id: null,
            totalIncome: { $sum: { $cond: [{ $eq: ["$transactionType", "Income"] }, "$amount", 0] } },
            totalExpense: { $sum: { $cond: [{ $eq: ["$transactionType", "Expense"] }, "$amount", 0] } },
            txCount: { $sum: 1 },
          },
        },
      ]);

      const dayIncome = txResult.length > 0 ? txResult[0].totalIncome : 0;
      const dayExpense = txResult.length > 0 ? txResult[0].totalExpense : 0;
      const dayTxCount = txResult.length > 0 ? txResult[0].txCount : 0;
      const calculatedRunning = mathUtil.add(expectedOpening, mathUtil.sub(dayIncome, dayExpense));

      const lastSession = sessions[sessions.length - 1];
      const storedClosing = lastSession.status === "Closed" ? lastSession.closingBalance : null;

      let dayStatus = "✅";
      const issues = [];

      // Check opening balance chain
      if (i > 0 && previousClosingBalance !== null && dayOpeningBalance !== previousClosingBalance) {
        issues.push(`Opening mismatch: stored=${dayOpeningBalance}, expected=${previousClosingBalance}`);
      }

      // Check closing balance
      if (storedClosing !== null && Math.abs(storedClosing - calculatedRunning) > 0.009) {
        issues.push(`Closing mismatch: stored=${storedClosing}, calculated=${calculatedRunning}`);
      }

      if (issues.length > 0) {
        dayStatus = "❌";
        chainIssues++;
      }

      console.log(`  ${dayStatus} ${targetDateStart.toDateString()} | Open: ${expectedOpening} | +${dayIncome} -${dayExpense} (${dayTxCount} txs) | Running: ${calculatedRunning}${storedClosing !== null ? ` | Stored Close: ${storedClosing}` : " | (Still Open)"}`);
      if (issues.length > 0) {
        issues.forEach((iss) => console.log(`     ⚠️  ${iss}`));
      }

      previousClosingBalance = calculatedRunning;
      dailyCashFinalBalance = calculatedRunning;
    }

    console.log(`\n  Summary: ${chainIssues} daily cash chain issues found across ${uniqueDates.length} days.`);
    console.log(`  Final Calculated Cash Balance: ${dailyCashFinalBalance}\n`);

    // ============================================================
    // SECTION 3: CROSS-CHECK
    // ============================================================
    console.log("╔══════════════════════════════════════════════════╗");
    console.log("║     SECTION 3: CROSS-CHECK                     ║");
    console.log("╚══════════════════════════════════════════════════╝\n");

    console.log(`  Cash Accounts Total Balance:       ${totalCashAccountBalance}`);
    console.log(`  Daily Cash Calculated Balance:     ${dailyCashFinalBalance}`);

    if (dailyCashFinalBalance !== null) {
      const crossDiff = mathUtil.sub(totalCashAccountBalance, dailyCashFinalBalance);
      if (Math.abs(crossDiff) > 0.009) {
        console.log(`  ❌ MISMATCH! Difference: ${crossDiff}`);
      } else {
        console.log(`  ✅ MATCH — Daily Cash and Account balances are in sync!`);
      }
    }

    // ============================================================
    // SECTION 4: ORPHAN / BROKEN TRANSACTIONS
    // ============================================================
    console.log(`\n╔══════════════════════════════════════════════════╗`);
    console.log("║     SECTION 4: DATA QUALITY CHECKS              ║");
    console.log("╚══════════════════════════════════════════════════╝\n");

    // Transactions with no paymentMethod
    const noPaymentMethod = await Transaction.countDocuments({
      isDeleted: { $ne: true },
      $or: [{ paymentMethod: null }, { paymentMethod: { $exists: false } }],
    });
    console.log(`  Transactions missing paymentMethod:  ${noPaymentMethod} ${noPaymentMethod > 0 ? "❌" : "✅"}`);

    // Soft-deleted Cash transactions
    const deletedCashTx = await Transaction.countDocuments({
      isDeleted: true,
      paymentMethod: "Cash",
    });
    console.log(`  Soft-deleted Cash transactions:      ${deletedCashTx}`);

    // Transactions with amount 0 or negative
    const badAmountTx = await Transaction.countDocuments({
      isDeleted: { $ne: true },
      amount: { $lte: 0 },
    });
    console.log(`  Transactions with amount ≤ 0:        ${badAmountTx} ${badAmountTx > 0 ? "⚠️" : "✅"}`);

    // Transactions referencing deleted sales
    const Sales = require("../models/sales.model");
    const deletedSaleIds = await Sales.find({ isDeleted: true }).select("_id").lean();
    const deletedSaleIdSet = deletedSaleIds.map((s) => s._id);
    
    if (deletedSaleIdSet.length > 0) {
      const orphanedTx = await Transaction.countDocuments({
        isDeleted: { $ne: true },
        referenceModel: "Sale",
        reference: { $in: deletedSaleIdSet },
      });
      console.log(`  Active TXs linked to deleted sales:  ${orphanedTx} ${orphanedTx > 0 ? "⚠️ (expected from reversals)" : "✅"}`);
    }

    console.log(`\n=== AUDIT COMPLETE ===\n`);

  } catch (err) {
    console.error("Audit Error:", err);
  } finally {
    await mongoose.disconnect();
    console.log("Disconnected from database.");
    process.exit(0);
  }
}

fullAudit();
