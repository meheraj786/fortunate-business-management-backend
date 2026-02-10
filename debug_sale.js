
require("dotenv").config();
const mongoose = require("mongoose");
const { dbConnect } = require("./database/db.config");
const Sale = require("./models/sales.model");
const Customer = require("./models/customer.model");

async function run() {
    try {
        await dbConnect();
        console.log("Connected to DB");

        const saleId = "SALE-26-000004";
        const sale = await Sale.findOne({ saleId });

        if (!sale) {
            console.log("Sale not found");
            return;
        }
        console.log("Found Sale:", sale.saleId);
        console.log("Raw Customer Field:", JSON.stringify(sale.customer, null, 2));

        let customerDoc = null;
        if (sale.customer && sale.customer.customerId) {
            const customerId = sale.customer.customerId;
            console.log("Searching for Customer ID:", customerId);
            customerDoc = await Customer.findById(customerId);
            if (customerDoc) {
                console.log("Customer Found in DB:", customerDoc.name, customerDoc._id);
            } else {
                console.log("Customer NOT FOUND in DB for ID:", customerId);
            }
        } else {
            console.log("No customerId in sale doc");
        }

        // Now verify aggregation behavior
        console.log("\nRunning Minimal Aggregation Pipeline...");
        const pipeline = [
            { $match: { saleId: saleId } },
            {
                $lookup: {
                    from: "customers",
                    localField: "customer.customerId",
                    foreignField: "_id",
                    as: "customer.customerId"
                }
            },
            { $unwind: { path: "$customer.customerId", preserveNullAndEmptyArrays: true } }
        ];

        const result = await Sale.aggregate(pipeline);
        if (result.length > 0) {
            console.log("Aggregation Result Customer Field:", JSON.stringify(result[0].customer, null, 2));
        } else {
            console.log("Aggregation returned no results");
        }

    } catch (error) {
        console.error("Error:", error);
    } finally {
        await mongoose.disconnect();
        console.log("Disconnected");
    }
}

run();
