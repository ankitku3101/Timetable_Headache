const Faculty = require('../faculty/faculty.model');
const DailyOverride = require('./daily-override.model');
const Schedule = require('../timetables/schedule.model');

/**
 * Given an absent teacher, find available substitutes for the given slot.
 * Strategy:
 *  1. Find faculty from same dept with overlapping expertise
 *  2. Filter out anyone already teaching at that day/slot on the published timetable
 *  3. Filter out anyone who has another override on the same date/slot
 */
const findSubstitutes = async ({ dept_id, date, slot, subject_id }) => {
  const dayOfWeek = new Date(date).getDay(); // 0=Sun, 1=Mon … 6=Sat
  const slotIndex = slot.period;

  // All active faculty in department
  const allFaculty = await Faculty.find({ dept_id, status: 'active' });

  // Faculty busy via published timetable on this day/slot
  // A multi-slot session starting at s.slot occupies slots s.slot … s.slot + s.duration_slots - 1,
  // so we must block any faculty whose session overlaps the requested slotIndex.
  const publishedSchedules = await Schedule.find({ dept_id, status: 'published' });
  const busyFacultyIds = new Set();
  publishedSchedules.forEach((sched) => {
    sched.sessions.forEach((s) => {
      const dur = s.duration_slots || 1;
      const occupies = s.day === dayOfWeek
        && slotIndex >= s.slot
        && slotIndex < s.slot + dur;
      if (occupies) {
        busyFacultyIds.add(s.faculty_id.toString());
      }
    });
  });

  // Faculty busy via existing overrides on this date/slot
  const dayStart = new Date(date); dayStart.setHours(0, 0, 0, 0);
  const dayEnd   = new Date(date); dayEnd.setHours(23, 59, 59, 999);
  const existingOverrides = await DailyOverride.find({ date: { $gte: dayStart, $lte: dayEnd } });
  existingOverrides.forEach((o) => {
    if (o.slot?.period === slotIndex && o.substitute_teacher_id) {
      busyFacultyIds.add(o.substitute_teacher_id.toString());
    }
    if (o.slot?.period === slotIndex && o.original_teacher_id) {
      busyFacultyIds.add(o.original_teacher_id.toString());
    }
  });

  const available = allFaculty.filter((f) => !busyFacultyIds.has(f._id.toString()));

  return available.map((f) => ({
    faculty_id: f._id,
    name: f.name,
    expertise: f.expertise,
    type: f.type,
  }));
};

module.exports = { findSubstitutes };
