/**
 * DETAILED TRANSACTION AUDIT — READ-ONLY
 * Shows EVERY individual Cash transaction per day, with running balance tracking.
 * Outputs to console AND saves to a file for easy review.
 */

const mongoose = require("mongoose");
const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const DailyCash = require("../models/dailyCash.model");
const Transaction = require("../models/transaction.model");
const Account = require("../models/account.model");
const mathUtil = require("../utils/math.util");
const { startOfDay, endOfDay } = require("../utils/timezone.util");

const timezone = "Asia/Dhaka";
const PROD_URI = "mongodb://fortunateuser:fortunate12345@127.0.0.1:27017/fortunatedb?replicaSet=rs0";

// Collect output for file
const outputLines = [];
function log(msg = "") {
  console.log(msg);
  outputLines.push(msg);
}

async function detailedAudit() {
  try {
    log("=== DETAILED TRANSACTION AUDIT (READ-ONLY) ===");
    log(`Generated at: ${new Date().toISOString()}\n`);

    await mongoose.connect(PROD_URI, { readPreference: "secondaryPreferred" });
    log("Connected to production DB.\n");

    // Get all daily cash dates
    const uniqueDates = await DailyCash.aggregate([
      { $group: { _id: "$date" } },
      { $sort: { _id: 1 } },
    ]);

    let previousClosingBalance = null;

    for (let i = 0; i < uniqueDates.length; i++) {
      const targetDate = uniqueDates[i]._id;
      const targetDateStart = startOfDay(new Date(targetDate), timezone);
      const nextDay = new Date(endOfDay(targetDateStart, timezone).getTime() + 1);

      // Get daily cash session
      const sessions = await DailyCash.find({ date: targetDate }).sort({ createdAt: 1 }).lean();
      const storedOpening = sessions[0].openingBalance;
      const lastSession = sessions[sessions.length - 1];
      const storedClosing = lastSession.status === "Closed" ? lastSession.closingBalance : "(Open)";

      // Expected opening from chain
      const expectedOpening = (i === 0) ? storedOpening : previousClosingBalance;

      log("═".repeat(90));
      log(`📅 ${targetDateStart.toDateString()}`);
      log(`   Opening Balance: ${expectedOpening}${storedOpening !== expectedOpening ? ` (stored: ${storedOpening} ⚠️)` : ""}`);
      log("─".repeat(90));
      log(`   ${"#".padEnd(4)} | ${"Type".padEnd(8)} | ${"Amount".padStart(14)} | ${"Running".padStart(14)} | ${"Method".padEnd(8)} | ${"Source".padEnd(8)} | ${"Category".padEnd(22)} | Name`);
      log("─".repeat(90));

      // Fetch ALL Cash transactions for this day, sorted by date
      const transactions = await Transaction.find({
        date: { $gte: targetDateStart, $lt: nextDay },
        isDeleted: { $ne: true },
        paymentMethod: "Cash",
      })
        .sort({ date: 1, createdAt: 1 })
        .select("transactionType amount paymentMethod source category name description date")
        .lean();

      let runningBalance = expectedOpening;
      let dayIncome = 0;
      let dayExpense = 0;

      transactions.forEach((tx, idx) => {
        if (tx.transactionType === "Income") {
          runningBalance = mathUtil.add(runningBalance, tx.amount);
          dayIncome = mathUtil.add(dayIncome, tx.amount);
        } else {
          runningBalance = mathUtil.sub(runningBalance, tx.amount);
          dayExpense = mathUtil.add(dayExpense, tx.amount);
        }

        const typeIcon = tx.transactionType === "Income" ? "🟢 IN " : "🔴 OUT";
        const amtStr = (tx.transactionType === "Income" ? "+" : "-") + tx.amount.toLocaleString();
        const catStr = (tx.category || "—").substring(0, 22);
        const nameStr = (tx.name || "—").substring(0, 40);

        log(`   ${String(idx + 1).padEnd(4)} | ${typeIcon} | ${amtStr.padStart(14)} | ${runningBalance.toLocaleString().padStart(14)} | ${(tx.paymentMethod || "—").padEnd(8)} | ${(tx.source || "—").padEnd(8)} | ${catStr.padEnd(22)} | ${nameStr}`);
      });

      log("─".repeat(90));
      log(`   Total: ${transactions.length} transactions | Income: +${dayIncome.toLocaleString()} | Expense: -${dayExpense.toLocaleString()}`);
      log(`   Closing Balance: ${runningBalance.toLocaleString()}${storedClosing !== "(Open)" ? ` | Stored: ${storedClosing.toLocaleString()}${storedClosing !== runningBalance ? " ❌ MISMATCH" : " ✅"}` : " | (Still Open)"}`);
      log();

      previousClosingBalance = runningBalance;
    }

    // Final summary
    log("═".repeat(90));
    log("📊 FINAL SUMMARY");
    log("═".repeat(90));

    const cashAccounts = await Account.find({ accountType: "Cash", isDeleted: { $ne: true } }).lean();
    let totalCash = 0;
    for (const acc of cashAccounts) {
      log(`   Cash Account "${acc.accountName}": ${acc.balance.toLocaleString()}`);
      totalCash = mathUtil.add(totalCash, acc.balance);
    }
    log(`   Total Cash Account Balance:       ${totalCash.toLocaleString()}`);
    log(`   Daily Cash Calculated Balance:    ${previousClosingBalance.toLocaleString()}`);
    log(`   ${totalCash === previousClosingBalance ? "✅ MATCH" : "❌ MISMATCH (diff: " + mathUtil.sub(totalCash, previousClosingBalance) + ")"}`);

    // Also list all non-cash transactions for completeness
    log(`\n${"═".repeat(90)}`);
    log("📊 NON-CASH TRANSACTION SUMMARY (Bank/Mobile Banking)");
    log("═".repeat(90));

    const nonCashSummary = await Transaction.aggregate([
      { $match: { isDeleted: { $ne: true }, paymentMethod: { $ne: "Cash" } } },
      {
        $group: {
          _id: { method: "$paymentMethod", type: "$transactionType" },
          total: { $sum: "$amount" },
          count: { $sum: 1 },
        },
      },
      { $sort: { "_id.method": 1, "_id.type": 1 } },
    ]);

    for (const row of nonCashSummary) {
      log(`   [${row._id.method}] ${row._id.type}: ${row.total.toLocaleString()} (${row.count} txs)`);
    }

    log(`\n=== AUDIT COMPLETE ===\n`);

    // Save to file
    const outputPath = path.join(__dirname, "audit_report.txt");
    fs.writeFileSync(outputPath, outputLines.join("\n"), "utf-8");
    log(`Report saved to: ${outputPath}`);

  } catch (err) {
    console.error("Audit Error:", err);
  } finally {
    await mongoose.disconnect();
    console.log("Disconnected from database.");
    process.exit(0);
  }
}

detailedAudit();
