/**
 * ONE-TIME REPAIR SCRIPT
 * ---------------------
 * Finds sales that have payments stored on the sale document but are MISSING
 * the corresponding Transaction records in the accounts system.
 *
 * This was caused by a bug in the `updateSale` controller where payments added
 * during a sale edit were saved to the sale document but no Transaction records
 * were created and no Account balances were updated.
 *
 * What this script does:
 * 1. Finds all non-deleted sales that have at least one payment
 * 2. For each payment, checks if a matching Transaction record exists
 * 3. If missing, creates the Transaction and updates the Account balance
 * 4. Generates a detailed report of all repairs made
 *
 * Usage:
 *   node scripts/repair-missing-transactions.js [--dry-run]
 *
 *   --dry-run   Only report what would be fixed, without making changes
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Sales = require("../models/sales.model");
const Transaction = require("../models/transaction.model");
const Account = require("../models/account.model");
const { formatAccountLabel } = require("../utils/format.util");

const DRY_RUN = process.argv.includes("--dry-run");

async function connect() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error("❌ MONGO_URI or MONGODB_URI not set in environment");
    process.exit(1);
  }
  await mongoose.connect(uri);
  console.log("✅ Connected to MongoDB");
}

async function findOrphanedPayments() {
  console.log("\n🔍 Scanning all sales for payments missing Transaction records...\n");

  const sales = await Sales.find({
    isDeleted: { $ne: true },
    "payments.0": { $exists: true }, // Has at least one payment
  }).lean();

  console.log(`📋 Found ${sales.length} sales with payments to check.\n`);

  const orphans = [];

  for (const sale of sales) {
    for (const payment of sale.payments) {
      // Skip non-monetary payments (discount-only entries)
      if (!payment.amount || payment.amount <= 0) continue;

      // Skip Customer Credit payments — they don't create Transaction records
      // (they create CreditHistory records instead)
      if (payment.method === "Customer Credit") continue;

      // Skip payments without accountId (shouldn't happen, but be safe)
      if (!payment.accountId) continue;

      // Check if a matching Transaction exists
      // We look for a Transaction that matches: sale reference + account + amount + category "Sales"
      const matchingTxn = await Transaction.findOne({
        reference: sale._id,
        referenceModel: "Sale",
        accountId: payment.accountId,
        amount: payment.amount,
        transactionType: "Income",
        category: "Sales",
        isDeleted: { $ne: true },
      }).lean();

      if (!matchingTxn) {
        orphans.push({
          sale,
          payment,
          saleId: sale.saleId,
          customerName: sale.customer?.name || "Guest",
          paymentAmount: payment.amount,
          paymentMethod: payment.method,
          paymentDate: payment.date,
          accountId: payment.accountId,
        });
      }
    }
  }

  return orphans;
}

async function repairOrphans(orphans) {
  if (orphans.length === 0) {
    console.log("✅ No orphaned payments found! All sales have matching Transaction records.\n");
    return;
  }

  console.log(`⚠️  Found ${orphans.length} payment(s) WITHOUT matching Transaction records:\n`);
  console.log("─".repeat(90));

  for (const [idx, orphan] of orphans.entries()) {
    console.log(
      `  ${idx + 1}. Sale: ${orphan.saleId} | Customer: ${orphan.customerName} | ` +
      `Amount: ${orphan.paymentAmount} | Method: ${orphan.paymentMethod} | ` +
      `Account: ${orphan.accountId} | Date: ${new Date(orphan.paymentDate).toLocaleDateString()}`
    );
  }

  console.log("─".repeat(90));

  if (DRY_RUN) {
    console.log("\n🔒 DRY RUN MODE — No changes made. Run without --dry-run to apply fixes.\n");
    return;
  }

  console.log("\n🔧 Repairing...\n");

  let repaired = 0;
  let failed = 0;

  for (const orphan of orphans) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const account = await Account.findById(orphan.accountId).session(session);
      if (!account) {
        console.log(`  ❌ SKIP: Account ${orphan.accountId} not found for sale ${orphan.saleId}`);
        await session.abortTransaction();
        session.endSession();
        failed++;
        continue;
      }

      // 1. Create the missing Transaction record
      await Transaction.create(
        [
          {
            accountId: account._id,
            date: orphan.paymentDate,
            description: `[REPAIR] Payment received for Sale ID: ${orphan.saleId} from ${orphan.customerName} via ${orphan.paymentMethod} Account: ${formatAccountLabel(account)}.`,
            transactionType: "Income",
            amount: orphan.paymentAmount,
            name: "Sales Payment",
            source: "Auto",
            category: "Sales",
            paymentMethod: orphan.paymentMethod,
            reference: orphan.sale._id,
            referenceModel: "Sale",
            miscReference: {
              saleId: orphan.saleId,
              customerName: orphan.customerName,
              paymentAmount: orphan.paymentAmount,
              paymentMethod: orphan.paymentMethod,
              repairScript: true,
              repairedAt: new Date().toISOString(),
            },
          },
        ],
        { session }
      );

      // 2. Update Account balance
      account.balance = (account.balance || 0) + orphan.paymentAmount;
      await account.save({ session });

      await session.commitTransaction();
      session.endSession();

      console.log(
        `  ✅ REPAIRED: Sale ${orphan.saleId} — ` +
        `Amount ${orphan.paymentAmount} (${orphan.paymentMethod}) → Account ${formatAccountLabel(account)}`
      );
      repaired++;
    } catch (error) {
      await session.abortTransaction();
      session.endSession();
      console.log(`  ❌ FAILED: Sale ${orphan.saleId} — ${error.message}`);
      failed++;
    }
  }

  console.log("\n" + "═".repeat(90));
  console.log(`📊 REPAIR SUMMARY: ${repaired} repaired, ${failed} failed, out of ${orphans.length} total`);
  console.log("═".repeat(90) + "\n");
}

async function main() {
  try {
    console.log("═".repeat(90));
    console.log("  REPAIR SCRIPT: Fix Missing Transaction Records for Sale Payments");
    console.log("  Mode: " + (DRY_RUN ? "🔒 DRY RUN (read-only)" : "🔧 LIVE (will make changes)"));
    console.log("═".repeat(90));

    await connect();

    const orphans = await findOrphanedPayments();
    await repairOrphans(orphans);
  } catch (error) {
    console.error("❌ Fatal error:", error);
  } finally {
    await mongoose.disconnect();
    console.log("🔌 Disconnected from MongoDB");
  }
}

main();
