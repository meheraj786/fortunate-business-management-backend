const express=require("express")
const userRoutes = require("./user.api")
const customerRoutes = require("./customer.api")
const lcRoutes = require("./lc.api")
const productRoutes = require("./product.api")
const salesRoutes = require("./sales.api")
const warehouseRoutes = require("./warehouse.api")
const categoryRouter = require("./category.api")
const dailyCashRouter = require("./dailyCash.api")
const apiRoutes=express.Router()

apiRoutes.use("/auth", userRoutes)
apiRoutes.use("/customer", customerRoutes)
apiRoutes.use("/lc", lcRoutes)
apiRoutes.use("/product", productRoutes)
apiRoutes.use("/sales", salesRoutes)
apiRoutes.use("/warehouse", warehouseRoutes)
apiRoutes.use("/category", categoryRouter)
apiRoutes.use("/cash", dailyCashRouter)


module.exports=apiRoutes