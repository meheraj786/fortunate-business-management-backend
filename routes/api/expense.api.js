const express=require("express")
const { createExpense, getAllExpenses, getExpenseById, updateExpense, deleteExpense, getDailyCash } = require("../../controllers/expense.controller")
const expenseRoutes=express.Router()

expenseRoutes.post("/create-expense", createExpense)
expenseRoutes.get("/get-all-expenses", getAllExpenses)
expenseRoutes.get("/get-daily-cash", getDailyCash)
expenseRoutes.get("/get-expense/:id", getExpenseById)
expenseRoutes.patch("/update-expense/:id", updateExpense)
expenseRoutes.delete("/delete-expense/:id", deleteExpense)


module.exports=expenseRoutes