const { startOfDay, formatInTimeZone } = require('../utils/timezone.util');

console.log("=== Verifying Timezone Boundaries ===");

function assert(condition, message) {
    if (condition) {
        console.log(`✅ PASS: ${message}`);
    } else {
        console.error(`❌ FAIL: ${message}`);
        process.exit(1);
    }
}

// Scenario: Business is in Asia/Dhaka (UTC+6)
const BUSINESS_TZ = 'Asia/Dhaka';

// 1. "Midnight Crossing" Test
// Date: 2025-01-01 00:05:00 Dhaka Time
// UTC:  2024-12-31 18:05:00 UTC
const earlyMorningDhaka = new Date('2024-12-31T18:05:00Z');

// 2. "End of Day" Test
// Date: 2025-01-01 23:55:00 Dhaka Time
// UTC:  2025-01-01 17:55:00 UTC
const lateNightDhaka = new Date('2025-01-01T17:55:00Z');

// 3. "Previous Day" in UTC, but "Current Day" in Dhaka
// Date: 2024-12-31 23:00:00 UTC
// Dhaka: 2025-01-01 05:00:00 Dhaka
const utcLateNight = new Date('2024-12-31T23:00:00Z');

console.log(`Testing with Business Timezone: ${BUSINESS_TZ}`);

// Test 1: earlyMorningDhaka should belong to 2025-01-01
const start1 = startOfDay(earlyMorningDhaka, BUSINESS_TZ);
const fmt1 = formatInTimeZone(start1, 'yyyy-MM-dd', BUSINESS_TZ);
assert(fmt1 === '2025-01-01', `Micro-midnight (00:05 Dhaka) should map to 2025-01-01. Got: ${fmt1}`);

// Test 2: lateNightDhaka should belong to 2025-01-01
const start2 = startOfDay(lateNightDhaka, BUSINESS_TZ);
const fmt2 = formatInTimeZone(start2, 'yyyy-MM-dd', BUSINESS_TZ);
assert(fmt2 === '2025-01-01', `Late night (23:55 Dhaka) should map to 2025-01-01. Got: ${fmt2}`);

// Test 3: utcLateNight (23:00 UTC) should be NEXT DAY in Dhaka (05:00)
const start3 = startOfDay(utcLateNight, BUSINESS_TZ);
const fmt3 = formatInTimeZone(start3, 'yyyy-MM-dd', BUSINESS_TZ);
assert(fmt3 === '2025-01-01', `23:00 UTC prev day (05:00 Dhaka) should map to 2025-01-01. Got: ${fmt3}`);

console.log("\n=== Timezone Boundary Tests Passed ===");
