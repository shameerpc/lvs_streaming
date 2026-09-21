import { NextFunction, Request, Response } from "express";
import { ZodSchema } from "zod";

export function validateBody(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      const message = result.error.issues[0]?.message ?? "Invalid request";

      return res.status(400).json({
        success: false,
        message,
      });
    }

    req.body = result.data;

    next();
  };
}

export function validateObjectId(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const id = req.params.id as string;

  if (!/^[0-9a-fA-F]{24}$/.test(id)) {
    return res.status(400).json({
      success: false,
      message: "Invalid room ID",
    });
  }

  next();
}