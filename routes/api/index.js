const express=require("express")
const userRoutes = require("./user.api")
const customerRoutes = require("./customer.api")
const expenseRoutes = require("./expense.api")
const lcRoutes = require("./lc.api")
const productRoutes = require("./product.api")
const salesRoutes = require("./sales.api")
const teammemberRoutes = require("./teammember.api")
const warehouseRoutes = require("./warehouse.api")
const apiRoutes=express.Router()

apiRoutes.use("/auth", userRoutes)
apiRoutes.use("/customer", customerRoutes)
apiRoutes.use("/expense", expenseRoutes)
apiRoutes.use("/lc", lcRoutes)
apiRoutes.use("/product", productRoutes)
apiRoutes.use("/sales", salesRoutes)
apiRoutes.use("/teammember", teammemberRoutes)
apiRoutes.use("/warehouse", warehouseRoutes)


module.exports=apiRoutes