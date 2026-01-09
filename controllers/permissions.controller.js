const { PERMISSIONS, MODULES } = require("../utils/permissions.constants");
const { ApiResponse } = require("../utils/ApiResponse");

const getAllPermissions = async (req, res) => {
  const permissionsData = {
    permissions: PERMISSIONS,
    modules: MODULES,
  };
  res
    .status(200)
    .json(
      new ApiResponse(
        200,
        permissionsData,
        "Permissions fetched successfully"
      )
    );
};

module.exports = {
  getAllPermissions,
};
