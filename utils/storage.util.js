const fs = require("fs").promises;
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const logger = require("./logger");

const UPLOADS_BASE_DIR = process.env.UPLOADS_DIR || path.join(__dirname, "../uploads");
const LC_DOCUMENTS_DIR = path.join(UPLOADS_BASE_DIR, "lc_documents");
const CUSTOMER_DOCUMENTS_DIR = path.join(UPLOADS_BASE_DIR, "customer_documents");
const TEMP_DIR = path.join(UPLOADS_BASE_DIR, "temp");

function sanitizeForPath(name) {
  if (!name) return '';
  return name.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function sanitizeFilename(filename) {
  const nameWithoutExt = path.parse(filename).name;
  return sanitizeForPath(nameWithoutExt).slice(0, 100);
}

async function ensureDir(dirPath) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
  }
}

async function initializeStorage() {
  await ensureDir(UPLOADS_BASE_DIR);
  await ensureDir(LC_DOCUMENTS_DIR);
  await ensureDir(CUSTOMER_DOCUMENTS_DIR);
  await ensureDir(TEMP_DIR);
  logger.info("Storage directories initialized.");
}

/**
 * Prepares metadata for a new document without moving the file from temp.
 * @param {object} file The multer file object from the request.
 * @returns {object} An object containing the temporary path and the document data for the DB.
 */
function prepareDocumentData(file) {
  const now = new Date();
  const year = now.getFullYear().toString();
  const month = (now.getMonth() + 1).toString().padStart(2, '0');
  const relativePath = path.join(year, month);

  const sanitizedFilename = sanitizeFilename(file.originalname);
  const uniqueSuffix = uuidv4().slice(0, 6);
  const fileExtension = path.extname(file.originalname);
  const storedName = `${sanitizedFilename}_${uniqueSuffix}${fileExtension}`;

  return {
    tempPath: file.path,
    docData: {
      originalName: file.originalname,
      storedName: storedName,
      path: relativePath,
      mimeType: file.mimetype,
      sizeBytes: file.size,
    }
  };
}

/**
 * Commits a prepared LC document to permanent storage by moving it from temp.
 * @param {string} tempPath The path of the file in the temporary directory.
 * @param {object} docData The document's metadata (containing path and storedName).
 * @param {string} lcNumber The LC Number for the directory.
 */
async function commitDocument(tempPath, docData, lcNumber) {
    const sanitizedLcNumber = sanitizeForPath(lcNumber);
    const finalDir = path.join(LC_DOCUMENTS_DIR, docData.path, sanitizedLcNumber);
    await ensureDir(finalDir);

    const finalPath = path.join(finalDir, docData.storedName);
    await fs.rename(tempPath, finalPath);
}

/**
 * Commits a prepared customer document to permanent storage by moving it from temp.
 * @param {string} tempPath The path of the file in the temporary directory.
 * @param {object} docData The document's metadata (containing path and storedName).
 * @param {string} customerId The Customer ID for the directory.
 */
async function commitCustomerDocument(tempPath, docData, customerId) {
    const sanitizedCustomerId = sanitizeForPath(customerId);
    const finalDir = path.join(CUSTOMER_DOCUMENTS_DIR, docData.path, sanitizedCustomerId);
    await ensureDir(finalDir);

    const finalPath = path.join(finalDir, docData.storedName);
    await fs.rename(tempPath, finalPath);
}

async function deleteLcDocument(lcNumber, docPath, storedName) {
  if (!lcNumber || !docPath || !storedName) {
    logger.error("Attempted to delete a document without a valid lcNumber, path, or stored name.");
    return;
  }
  const sanitizedLcNumber = sanitizeForPath(lcNumber);
  const filePath = path.join(LC_DOCUMENTS_DIR, docPath, sanitizedLcNumber, storedName);
  try {
    await fs.unlink(filePath);
    logger.info(`Successfully deleted document: ${filePath}`);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logger.error(`Failed to delete document file: ${filePath}`, err);
      throw new Error("Could not delete the document file from storage.");
    }
    logger.warn(`Document file not found for deletion: ${filePath}`);
  }
}

async function deleteCustomerDocument(customerId, docPath, storedName) {
  if (!customerId || !docPath || !storedName) {
    logger.error("Attempted to delete a document without a valid customerId, path, or stored name.");
    return;
  }
  const sanitizedCustomerId = sanitizeForPath(customerId);
  const filePath = path.join(CUSTOMER_DOCUMENTS_DIR, docPath, sanitizedCustomerId, storedName);
  try {
    await fs.unlink(filePath);
    logger.info(`Successfully deleted document: ${filePath}`);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logger.error(`Failed to delete document file: ${filePath}`, err);
      throw new Error("Could not delete the document file from storage.");
    }
    logger.warn(`Document file not found for deletion: ${filePath}`);
  }
}

async function cleanupEmptyLcDirectory(lcNumber, docPath) {
  const sanitizedLcNumber = sanitizeForPath(lcNumber);
  const lcSpecificDir = path.join(LC_DOCUMENTS_DIR, docPath, sanitizedLcNumber);

  try {
    const files = await fs.readdir(lcSpecificDir);
    if (files.length === 0) {
      logger.info(`Cleaning up empty directory: ${lcSpecificDir}`);
      await fs.rmdir(lcSpecificDir);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.error(`Error during empty directory cleanup for ${lcSpecificDir}:`, error);
    }
  }
}

async function cleanupEmptyCustomerDirectory(customerId, docPath) {
  const sanitizedCustomerId = sanitizeForPath(customerId);
  const customerSpecificDir = path.join(CUSTOMER_DOCUMENTS_DIR, docPath, sanitizedCustomerId);

  try {
    const files = await fs.readdir(customerSpecificDir);
    if (files.length === 0) {
      logger.info(`Cleaning up empty directory: ${customerSpecificDir}`);
      await fs.rmdir(customerSpecificDir);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.error(`Error during empty directory cleanup for ${customerSpecificDir}:`, error);
    }
  }
}

async function cleanupTempFiles(tempFiles = []) {
  for (const file of tempFiles) {
    try {
      await fs.unlink(file.path);
    } catch (unlinkError) {
      if (unlinkError.code !== 'ENOENT') {
        logger.error(`Failed to delete temporary file on error: ${file.path}`, unlinkError);
      }
    }
  }
}

module.exports = {
  TEMP_DIR,
  LC_DOCUMENTS_DIR,
  CUSTOMER_DOCUMENTS_DIR,
  initializeStorage,
  prepareDocumentData,
  commitDocument,
  commitCustomerDocument,
  deleteLcDocument,
  deleteCustomerDocument,
  cleanupEmptyLcDirectory,
  cleanupEmptyCustomerDirectory,
  cleanupTempFiles
};
