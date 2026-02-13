const mathUtil = require('../utils/math.util');

console.log("=== Verifying Math Utility (decimal.js wrapper) ===");

function assert(condition, message) {
    if (condition) {
        console.log(`✅ PASS: ${message}`);
    } else {
        console.error(`❌ FAIL: ${message}`);
        process.exit(1);
    }
}

// 1. Addition (The classic 0.1 + 0.2)
const sum = mathUtil.add(0.1, 0.2);
assert(sum === 0.3, `0.1 + 0.2 should be 0.3. Got: ${sum}`);

// 2. Subtraction
const diff = mathUtil.sub(0.3, 0.1);
assert(diff === 0.2, `0.3 - 0.1 should be 0.2. Got: ${diff}`);

// 3. Multiplication (Floating point error check)
const product = mathUtil.mul(19.99, 100);
assert(product === 1999, `19.99 * 100 should be 1999. Got: ${product}`);

// 4. Division
const quotient = mathUtil.div(10, 2);
assert(quotient === 5, `10 / 2 should be 5. Got: ${quotient}`);

// 5. Rounding
const rounded = mathUtil.round(10.556);
assert(rounded === 10.56, `round(10.556) should be 10.56. Got: ${rounded}`);

const roundedDown = mathUtil.round(10.554);
assert(roundedDown === 10.55, `round(10.554) should be 10.55. Got: ${roundedDown}`);

// 6. Sum Array
const arraySum = mathUtil.sum([0.1, 0.2, 0.3]);
assert(arraySum === 0.6, `sum([0.1, 0.2, 0.3]) should be 0.6. Got: ${arraySum}`);

console.log("\n=== All Tests Passed Successfully ===");
