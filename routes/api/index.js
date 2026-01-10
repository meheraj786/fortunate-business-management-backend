const express=require("express")
const userRoutes = require("./user.api")
const customerRoutes = require("./customer.api")
const lcRoutes = require("./lc.api")
const salesRoutes = require("./sales.api")
const warehouseRoutes = require("./warehouse.api")
const categoryRouter = require("./category.api")
const unitRouter = require("./unit.api")
const dailyCashRouter = require("./dailyCash.api")
const invoiceRouter = require("./invoice.api")
const accountRoutes = require("./account.api")
const transactionRoutes = require("./transaction.api")
const trashRouter = require("./trash.api")
const permissionsRouter = require("./permissions.api") // New line
const apiRoutes=express.Router()

apiRoutes.use("/user", userRoutes)
apiRoutes.use("/customer", customerRoutes)
apiRoutes.use("/lc", lcRoutes)
// Product routes are nested under warehouseRoutes, no need to mount here
apiRoutes.use("/sales", salesRoutes)
apiRoutes.use("/warehouses", warehouseRoutes) // authenticate is already inside warehouseRoutes
apiRoutes.use("/category", categoryRouter)
apiRoutes.use("/unit", unitRouter)
apiRoutes.use("/cash", dailyCashRouter) // authenticate is already inside dailyCashRouter
apiRoutes.use("/invoice", invoiceRouter)
apiRoutes.use("/account", accountRoutes)
apiRoutes.use("/transactions", transactionRoutes)
apiRoutes.use("/trash", trashRouter)
apiRoutes.use("/permissions", permissionsRouter) // New line


module.exports=apiRoutes