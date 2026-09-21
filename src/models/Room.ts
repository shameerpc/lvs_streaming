import mongoose, { Document, Schema, Types } from "mongoose";

export interface IRoom extends Document {
  name: string;
  host: Types.ObjectId;
  participants: Types.ObjectId[];
  status: "active" | "ended";
  participantCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const roomSchema = new Schema<IRoom>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },

    host: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    participants: [
      {
        type: Schema.Types.ObjectId,
        ref: "User",
      },
    ],

    status: {
      type: String,
      enum: ["active", "ended"],
      default: "active",
      index: true,
    },

    participantCount: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true,
  }
);

roomSchema.index({ status: 1, createdAt: -1 });

const Room = mongoose.model<IRoom>("Room", roomSchema);

export default Room;