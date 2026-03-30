/**
 * Formats the account label based on the account type.
 *
 * @param {Object} account - The account object.
 * @returns {string} - The formatted label.
 */
const formatAccountLabel = (account) => {
    if (!account) return "";
    switch (account.accountType) {
        case "Bank":
            return `${account.accountNumber} - ${account.bankName} (${account.branchName})`;
        case "Mobile Banking":
            return `${account.mobileNumber} - ${account.serviceName} (${account.accountName})`;
        case "Cash":
            return `${account.accountName} - ${account.accountHolderName}`;
        default:
            return account.accountName;
    }
};

module.exports = {
    formatAccountLabel,
};
