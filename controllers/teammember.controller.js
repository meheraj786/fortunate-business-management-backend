const TeamMember = require("../models/teamMember.model");
const Warehouse = require("../models/warehouse.model");
const { ApiError } = require("../utils/ApiError");
const { ApiResponse } = require("../utils/ApiResponse");

const createTeamMember = async (req, res, next) => {
  try {
    const { name, phone, role, warehouse } = req.body;

    if (!name || !phone || !role || !warehouse) {
      return next(new ApiError(400, "Name, phone, role, and warehouse are required"));
    }

    const newMember = await TeamMember.create({
      name,
      phone,
      role,
      warehouse,
    });

    await Warehouse.findByIdAndUpdate(warehouse, {
      $push: { manager: newMember._id },
    });

    const populatedMember = await newMember.populate("warehouse");

    return res
      .status(201)
      .json(new ApiResponse(populatedMember, "Team member created successfully"));
  } catch (error) {
    next(new ApiError(500, "Failed to create team member", [error.message]));
  }
};

const getAllTeamMembers = async (_, res, next) => {
  try {
    const members = await TeamMember.find().populate("warehouse");
    return res
      .status(200)
      .json(new ApiResponse(members, "Team members fetched successfully"));
  } catch (error) {
    next(new ApiError(500, "Failed to fetch team members", [error.message]));
  }
};

const getTeamMemberById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const member = await TeamMember.findById(id).populate("warehouse");
    if (!member) {
      return next(new ApiError(404, "Team member not found"));
    }

    return res
      .status(200)
      .json(new ApiResponse(member, "Team member fetched successfully"));
  } catch (error) {
    next(new ApiError(500, "Failed to fetch team member", [error.message]));
  }
};

const updateTeamMember = async (req, res, next) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const oldMember = await TeamMember.findById(id);
    if (!oldMember) {
      return next(new ApiError(404, "Team member not found"));
    }

    const updatedMember = await TeamMember.findByIdAndUpdate(id, updates, {
      new: true,
      runValidators: true,
    }).populate("warehouse");

    if (updates.warehouse && updates.warehouse !== oldMember.warehouse.toString()) {
      await Warehouse.findByIdAndUpdate(oldMember.warehouse, {
        $pull: { manager: oldMember._id },
      });
      await Warehouse.findByIdAndUpdate(updates.warehouse, {
        $push: { manager: oldMember._id },
      });
    }

    return res
      .status(200)
      .json(new ApiResponse(updatedMember, "Team member updated successfully"));
  } catch (error) {
    next(new ApiError(500, "Failed to update team member", [error.message]));
  }
};

const deleteTeamMember = async (req, res, next) => {
  try {
    const { id } = req.params;
    const member = await TeamMember.findByIdAndDelete(id);

    if (!member) {
      return next(new ApiError(404, "Team member not found"));
    }

    await Warehouse.findByIdAndUpdate(member.warehouse, {
      $pull: { manager: member._id },
    });

    return res
      .status(200)
      .json(new ApiResponse({}, "Team member deleted successfully"));
  } catch (error) {
    next(new ApiError(500, "Failed to delete team member", [error.message]));
  }
};

module.exports = {
  createTeamMember,
  getAllTeamMembers,
  getTeamMemberById,
  updateTeamMember,
  deleteTeamMember,
};
