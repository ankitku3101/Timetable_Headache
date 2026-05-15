const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema(
  {
    faculty_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Faculty' },
    subject_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Subject' },
    room_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Room' },
    day: Number,
    slot: Number,
    is_locked: { type: Boolean, default: false },
    batch: { type: Number, default: 1 },
    duration_slots: { type: Number, default: 1 },
  },
  { _id: false }
);

const scheduleSchema = new mongoose.Schema(
  {
    semester_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AcademicCalendar',
      required: true,
    },
    dept_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true },
    section_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Section', default: null }, // null = whole dept
    status: { type: String, enum: ['draft', 'published', 'archived'], default: 'draft' },
    version: { type: Number, default: 1 },
    sessions: [sessionSchema],
    original_sessions: [sessionSchema], // immutable snapshot set by solver on first write
    published_at: { type: Date },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

scheduleSchema.index({ semester_id: 1, dept_id: 1, section_id: 1, status: 1 });

module.exports = mongoose.model('Schedule', scheduleSchema);
