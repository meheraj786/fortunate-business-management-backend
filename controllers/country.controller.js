const Country = require("../models/country.model");
const Trash = require("../models/trash.model");
const LC = require("../models/lc.model");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");
const { now } = require("../utils/timezone.util");
const logger = require("../utils/logger");
const auditService = require("../services/audit.service");

/* ================= CREATE ================= */
exports.createCountry = async (req, res, next) => {
  try {
    const { name } = req.body;

    if (!name || !name.trim()) {
      return next(new ApiError(400, "Country name is required."));
    }

    const country = await Country.create({
      name: name.trim(),
      createdBy: req.user?._id || null,
    });

    auditService.log({
      action: "CREATE",
      module: "Country",
      documentId: country._id,
      userId: req.user?._id,
      description: `Created country "${country.name}"`,
      req,
    });

    res
      .status(201)
      .json(new ApiResponse(201, country, "Country created successfully"));
  } catch (error) {
    if (error instanceof ApiError) return next(error);

    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(
        new ApiError(
          409,
          `A country with the ${field} '${value}' already exists.`,
        ),
      );
    }

    if (error.name === "ValidationError") {
      const firstErrorField = Object.keys(error.errors)[0];
      const userFriendlyMessage = error.errors[firstErrorField].message;
      return next(new ApiError(400, userFriendlyMessage, error.errors));
    }

    logger.error(error);
    next(
      new ApiError(
        500,
        "An unexpected error occurred. Please try again.",
        [],
        error.message,
      ),
    );
  }
};

/* ================= GET ALL ================= */
exports.getCountries = async (_, res, next) => {
  try {
    const countries = await Country.find({
      isDeleted: { $ne: true },
    }).sort({ name: 1 }).lean();

    res
      .status(200)
      .json(
        new ApiResponse(200, countries, "Countries fetched successfully"),
      );
  } catch (error) {
    logger.error(error);
    next(
      new ApiError(
        500,
        "An unexpected error occurred. Please try again.",
        [],
        error.message,
      ),
    );
  }
};

/* ================= GET BY ID ================= */
exports.getCountryById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const country = await Country.findOne({
      _id: id,
      isDeleted: { $ne: true },
    }).lean();

    if (!country) return next(new ApiError(404, "Country not found"));

    res
      .status(200)
      .json(new ApiResponse(200, country, "Country fetched successfully"));
  } catch (error) {
    logger.error(error);
    next(
      new ApiError(
        500,
        "An unexpected error occurred. Please try again.",
        [],
        error.message,
      ),
    );
  }
};

/* ================= UPDATE ================= */
exports.updateCountry = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name } = req.body;

    if (!name || !name.trim()) {
      return next(new ApiError(400, "Country name is required."));
    }

    // Capture snapshot for audit diff
    const oldCountry = await Country.findById(id).lean();

    const country = await Country.findOneAndUpdate(
      { _id: id, isDeleted: { $ne: true } },
      { name: name.trim(), modifiedBy: req.user?._id || null },
      { new: true, runValidators: true },
    );

    if (!country) return next(new ApiError(404, "Country not found"));

    auditService.log({
      action: "UPDATE",
      module: "Country",
      documentId: country._id,
      userId: req.user?._id,
      description: `Updated country "${country.name}"`,
      changes: auditService.diffChanges(oldCountry, country, ["name"]),
      req,
    });

    res
      .status(200)
      .json(new ApiResponse(200, country, "Country updated successfully"));
  } catch (error) {
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      const value = error.keyValue[field];
      return next(
        new ApiError(
          409,
          `A country with the ${field} '${value}' already exists.`,
        ),
      );
    }

    logger.error(error);
    next(
      new ApiError(
        500,
        "An unexpected error occurred. Please try again.",
        [],
        error.message,
      ),
    );
  }
};

/* ================= SOFT DELETE ================= */
exports.deleteCountry = async (req, res, next) => {
  try {
    const { id } = req.params;

    // Find the country first to get its name for the LC check
    const countryDoc = await Country.findOne({
      _id: id,
      isDeleted: { $ne: true },
    }).lean();

    if (!countryDoc) return next(new ApiError(404, "Country not found"));

    // Check if any active LCs are using this country name
    const lcCount = await LC.countDocuments({
      "basicInfo.supplierCountry": countryDoc.name,
      isDeleted: false,
    });

    if (lcCount > 0) {
      return next(
        new ApiError(
          400,
          `Cannot delete country: it is currently used by ${lcCount} LC(s).`,
        ),
      );
    }

    const deletedBy = req.user?._id || null;

    const country = await Country.findOneAndUpdate(
      { _id: id, isDeleted: { $ne: true } },
      {
        isDeleted: true,
        deletedAt: now(),
        deletedBy,
      },
      { new: true },
    );

    // move to trash
    await Trash.create({
      docId: country._id,
      model: "Country",
      deletedBy,
      deletedAt: now(),
    });

    auditService.log({
      action: "DELETE",
      module: "Country",
      documentId: country._id,
      userId: deletedBy,
      description: `Deleted country "${country.name}"`,
      req,
    });

    res
      .status(200)
      .json(
        new ApiResponse(200, country, "Country moved to trash successfully"),
      );
  } catch (error) {
    logger.error(error);
    next(
      new ApiError(
        500,
        "An unexpected error occurred. Please try again.",
        [],
        error.message,
      ),
    );
  }
};

/* ================= SEARCH (lightweight, for combobox autocomplete) ================= */
exports.searchCountries = async (req, res, next) => {
  try {
    const { q = "", limit = 20 } = req.query;
    const query = { isDeleted: { $ne: true } };

    if (q.trim()) {
      query.name = { $regex: q.trim(), $options: "i" };
    }

    const countries = await Country.find(query)
      .select("name")
      .sort({ name: 1 })
      .limit(parseInt(limit, 10))
      .lean();

    res
      .status(200)
      .json(new ApiResponse(200, countries, "Countries searched successfully"));
  } catch (error) {
    logger.error(error);
    next(new ApiError(500, "Failed to search countries."));
  }
};
