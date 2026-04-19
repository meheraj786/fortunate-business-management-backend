const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const DailyCash = require("../models/dailyCash.model");
const Transaction = require("../models/transaction.model");
const Account = require("../models/account.model");
const mathUtil = require("../utils/math.util");
const { startOfDay, endOfDay } = require("../utils/timezone.util");
const timezone = process.env.TZ || "Asia/Dhaka";

async function fixDailyCash() {
  try {
    await mongoose.connect('mongodb://fortunateuser:fortunate12345@127.0.0.1:27017/fortunatedb?replicaSet=rs0', { readPreference: 'primaryPreferred' });
    console.log("Connected to MongoDB.");

    // Get all unique dates from DailyCash
    const uniqueDates = await DailyCash.aggregate([
      { $group: { _id: "$date" } },
      { $sort: { _id: 1 } }
    ]);

    if (uniqueDates.length === 0) {
      console.log("No Daily Cash sessions found.");
      process.exit(0);
    }

    let previousClosingBalance = null;

    for (let i = 0; i < uniqueDates.length; i++) {
        const targetDate = uniqueDates[i]._id;
        const targetDateStart = startOfDay(new Date(targetDate), timezone);
        const nextDay = new Date(endOfDay(targetDateStart, timezone).getTime() + 1);

        console.log(`\nProcessing date: ${targetDateStart.toDateString()}`);
        
        // Find sessions for this date
        const sessions = await DailyCash.find({ date: targetDate }).sort({ createdAt: 1 });
        
        if (i === 0) {
           previousClosingBalance = sessions[0].openingBalance;
           console.log(`Day 1 opening balance: ${previousClosingBalance}`);
        } else {
           if (sessions[0].openingBalance !== previousClosingBalance) {
               console.log(`Fixing opening balance: ${sessions[0].openingBalance} -> ${previousClosingBalance}`);
               sessions[0].openingBalance = previousClosingBalance;
               await sessions[0].save();
           } else {
               console.log(`Opening balance correct: ${previousClosingBalance}`);
           }
        }
        
        const currentOpeningBalance = previousClosingBalance;

        // Calculate Cash Flow for the day
        const pipeline = [
          {
            $match: {
              date: { $gte: targetDateStart, $lt: nextDay },
              isDeleted: { $ne: true }
             }
          },
          {
            $group: {
              _id: null,
              totalCashIncome: {
                $sum: {
                  $cond: [
                    { $and: [ { $eq: ["$transactionType", "Income"] }, { $eq: ["$paymentMethod", "Cash"] } ] },
                    "$amount",
                    0
                  ]
                }
              },
              totalCashExpense: {
                $sum: {
                  $cond: [
                    { $and: [ { $eq: ["$transactionType", "Expense"] }, { $eq: ["$paymentMethod", "Cash"] } ] },
                    "$amount",
                    0
                  ]
                }
              }
            }
          }
        ];

        const result = await Transaction.aggregate(pipeline);
        const inc = result.length > 0 ? result[0].totalCashIncome : 0;
        const exp = result.length > 0 ? result[0].totalCashExpense : 0;
        
        const runningBalance = mathUtil.add(currentOpeningBalance, mathUtil.sub(inc, exp));
        console.log(`Day Income: ${inc}, Day Expense: ${exp}. Target Running Balance: ${runningBalance}`);
        
        // Apply running balance to all closed sessions for this day
        for (let j = 0; j < sessions.length; j++) {
            let sessionDoc = sessions[j];
            if (sessionDoc.status === "Closed" && sessionDoc.closingBalance !== runningBalance) {
               console.log(`Fixing session ${sessionDoc._id} closing balance: ${sessionDoc.closingBalance} -> ${runningBalance}`);
               sessionDoc.closingBalance = runningBalance;
               await sessionDoc.save();
            }
        }
        
        previousClosingBalance = runningBalance;
    }

    console.log(`\nDaily Cash history fixed. Final running balance = ${previousClosingBalance}`);

    // Verify against actual Account balances
    const cashAccounts = await Account.aggregate([
       { $match: { accountType: "Cash", isDeleted: { $ne: true } } },
       { $group: { _id: null, totalBalance: { $sum: "$balance" } } }
    ]);
    const actualCashBalance = cashAccounts.length > 0 ? cashAccounts[0].totalBalance : 0;
    
    console.log("=======================================");
    console.log(`Calculated Daily Cash Balance: ${previousClosingBalance}`);
    console.log(`Actual Cash Account(s) Balance: ${actualCashBalance}`);
    
    if (previousClosingBalance !== actualCashBalance) {
        console.log("WARNING: Mismatch still exists! Check if there's an account balance decoupled from transactions.");
    } else {
        console.log("SUCCESS: Daily Cash perfectly matches Cash Account balance!");
    }
    
  } catch (err) {
    console.error(err);
  } finally {
    await mongoose.disconnect();
    console.log("Disconnected.");
    process.exit(0);
  }
}

fixDailyCash();
