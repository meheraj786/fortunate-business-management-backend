const express = require("express");
const {
  createCountry,
  getCountries,
  getCountryById,
  updateCountry,
  deleteCountry,
} = require("../../controllers/country.controller");
const { authorize } = require("../../middleware/authorize.middleware");
const { authenticate } = require("../../middleware/auth.middleware");
const { PERMISSIONS } = require("../../utils/permissions.constants");
const countryRouter = express.Router();

countryRouter.post(
  "/create-country",
  authenticate,
  authorize(PERMISSIONS.COUNTRY_CREATE),
  createCountry
);
countryRouter.get(
  "/get-all-countries",
  authenticate,
  authorize(PERMISSIONS.COUNTRY_VIEW),
  getCountries
);
countryRouter.get(
  "/get-country/:id",
  authenticate,
  authorize(PERMISSIONS.COUNTRY_VIEW),
  getCountryById
);
countryRouter.put(
  "/update-country/:id",
  authenticate,
  authorize(PERMISSIONS.COUNTRY_UPDATE),
  updateCountry
);
countryRouter.delete(
  "/delete-country/:id",
  authenticate,
  authorize(PERMISSIONS.COUNTRY_DELETE),
  deleteCountry
);

module.exports = countryRouter;
