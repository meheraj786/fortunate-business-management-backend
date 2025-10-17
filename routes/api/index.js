const express=require("express")
const userRoutes = require("./user.api")
const customerRoutes = require("./customer.api")
const expenseRoutes = require("./expense.api")
const lcRoutes = require("./lc.api")
const apiRoutes=express.Router()

apiRoutes.use("/auth", userRoutes)
apiRoutes.use("/customer", customerRoutes)
apiRoutes.use("/expense", expenseRoutes)
apiRoutes.use("/lc", lcRoutes)


module.exports=apiRoutes