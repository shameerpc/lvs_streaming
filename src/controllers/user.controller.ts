import { Response } from "express";
import User from "../models/User.js";
import { AuthRequest } from "../middleware/auth.middleware.js";

export const getCurrentUser = async (
  req: AuthRequest,
  res: Response
) => {
  try {
    const user = await User.findById(req.userId).select("-password");

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: user,
    });
  } catch (error) {
    console.error("Get current user error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};