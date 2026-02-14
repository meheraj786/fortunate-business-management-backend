const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const readline = require('readline');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const askQuestion = (query) => {
    return new Promise(resolve => rl.question(query, resolve));
};

async function decryptBackup() {
    console.log("=== Fortunate Business Management Backup Decryptor ===\n");

    const inputFile = await askQuestion("Enter path to encrypted file (e.g., backup_2023...zip.enc): ");

    if (!fs.existsSync(inputFile)) {
        console.error("Error: File not found!");
        rl.close();
        return;
    }

    const password = await askQuestion("Enter backup password: ");
    const outputFile = inputFile.replace('.enc', '');

    console.log(`\nDecrypting ${inputFile} to ${outputFile}...`);

    try {
        const fileBuffer = fs.readFileSync(inputFile);

        // Extract Header
        const salt = fileBuffer.slice(0, 16);
        const iv = fileBuffer.slice(16, 28); // 12 bytes IV

        // Extract Auth Tag (Last 16 bytes)
        const authTag = fileBuffer.slice(fileBuffer.length - 16);

        // Extract Encrypted Data
        const encryptedData = fileBuffer.slice(28, fileBuffer.length - 16);

        // Derive Key
        const key = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256');

        // Create Decipher
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);

        // Decrypt
        let decrypted = decipher.update(encryptedData);
        let final = decipher.final();

        const decryptedData = Buffer.concat([decrypted, final]);

        fs.writeFileSync(outputFile, decryptedData);

        console.log("\n✅ Decryption Successful!");
        console.log(`Restored file: ${outputFile}`);

    } catch (error) {
        console.error("\n❌ Decryption Failed!");
        console.error("Possible causes:");
        console.error("1. Wrong password.");
        console.error("2. Corrupted file.");
        console.error(`Error details: ${error.message}`);
    } finally {
        rl.close();
    }
}

decryptBackup();
