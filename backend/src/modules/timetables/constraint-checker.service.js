const Faculty    = require('../faculty/faculty.model');
const Room       = require('../rooms/room.model');
const Constraint = require('../constraints/constraint.model');

const DAY_NAMES  = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SLOT_LABELS = [
  '08:00–09:00', '09:00–10:00', '10:00–11:00', '11:00–12:00',
  '12:00–13:00', '13:00–14:00', '14:00–15:00', '15:00–16:00',
];
const LUNCH_SLOT  = 5;
const TOTAL_DAYS  = 6;
const TOTAL_SLOTS = 8;

const getId = (v) =>
  v && typeof v === 'object' ? (v._id?.toString() ?? null) : (v?.toString() ?? null);

const getStr = (v, field) =>
  v && typeof v === 'object' ? (v[field] ?? null) : null;

/**
 * Check whether a session can be moved to (newDay, newSlot).
 * sessions  – populated array from findScheduleById (faculty/room/subject populated)
 * movingIdx – index of the session being moved
 * newDay    – 1-indexed (1=Mon … 6=Sat)
 * newSlot   – 0-indexed (0=08:00 … 7=15:00)
 * deptId, semesterId – ObjectId or string, for constraint lookup
 *
 * Returns { valid: boolean, reason: string | null }
 */
const validateMove = async ({ sessions, movingIdx, newDay, newSlot, deptId, semesterId }) => {
  const session = sessions[movingIdx];
  const dur     = session.duration_slots || 1;

  // ── 1. Bounds ─────────────────────────────────────────────
  if (newSlot + dur > TOTAL_SLOTS) {
    return {
      valid:  false,
      reason: `A ${dur}-hour session starting at ${SLOT_LABELS[newSlot] ?? `slot ${newSlot}`} would run past end of day`,
    };
  }

  // ── 2. Lunch break ────────────────────────────────────────
  const physSlots = Array.from({ length: dur }, (_, i) => newSlot + i);
  if (physSlots.includes(LUNCH_SLOT)) {
    return { valid: false, reason: 'Session would overlap with the lunch break (13:00–14:00)' };
  }

  const fId = getId(session.faculty_id);
  const rId = getId(session.room_id);

  // ── 3 & 4. Build busy maps from all OTHER sessions ────────
  const facultyBusy = new Map(); // `${fid}-${day}-${slot}` → subject label
  const roomBusy    = new Map(); // `${rid}-${day}-${slot}` → subject label

  sessions.forEach((s, idx) => {
    if (idx === movingIdx) return;
    const sDur   = s.duration_slots || 1;
    const sFId   = getId(s.faculty_id);
    const sRId   = getId(s.room_id);
    const sLabel = getStr(s.subject_id, 'code') ?? getStr(s.subject_id, 'name') ?? 'another class';
    for (let i = 0; i < sDur; i++) {
      const ps = s.slot + i;
      if (sFId) facultyBusy.set(`${sFId}-${s.day}-${ps}`, sLabel);
      if (sRId) roomBusy.set(`${sRId}-${s.day}-${ps}`, sLabel);
    }
  });

  // Faculty double-booking
  if (fId) {
    const facultyName = getStr(session.faculty_id, 'name') ?? 'The faculty member';
    for (const ps of physSlots) {
      const conflict = facultyBusy.get(`${fId}-${newDay}-${ps}`);
      if (conflict) {
        return {
          valid:  false,
          reason: `${facultyName} is already teaching "${conflict}" at ${DAY_NAMES[newDay - 1]}, ${SLOT_LABELS[ps]}`,
        };
      }
    }
  }

  // Room double-booking
  if (rId) {
    const roomName = getStr(session.room_id, 'name') ?? 'The room';
    for (const ps of physSlots) {
      const conflict = roomBusy.get(`${rId}-${newDay}-${ps}`);
      if (conflict) {
        return {
          valid:  false,
          reason: `${roomName} is already occupied by "${conflict}" at ${DAY_NAMES[newDay - 1]}, ${SLOT_LABELS[ps]}`,
        };
      }
    }
  }

  // ── 5. Faculty availability matrix (0-indexed day) ────────
  if (fId) {
    const fac = await Faculty.findById(fId).select('name availability').lean();
    if (fac?.availability) {
      const dayArr = fac.availability[newDay - 1]; // solver stores day 1-indexed; array is 0-indexed
      if (Array.isArray(dayArr)) {
        for (const ps of physSlots) {
          if (dayArr[ps] === false) {
            return {
              valid:  false,
              reason: `${fac.name} is marked unavailable at ${DAY_NAMES[newDay - 1]}, ${SLOT_LABELS[ps]} in their profile`,
            };
          }
        }
      }
    }
  }

  // ── 6. Room blocked slots (stored with 0-indexed day) ─────
  if (rId) {
    const room = await Room.findById(rId).select('name blocked_slots').lean();
    if (room?.blocked_slots?.length) {
      for (const b of room.blocked_slots) {
        // blocked_slots.day is 0-indexed; newDay is 1-indexed
        if ((b.day ?? 0) + 1 === newDay && physSlots.includes(b.slot)) {
          return {
            valid:  false,
            reason: `${room.name} is blocked at ${DAY_NAMES[newDay - 1]}, ${SLOT_LABELS[b.slot]}`,
          };
        }
      }
    }
  }

  // ── 7. DB constraint-based faculty unavailability ─────────
  if (fId && deptId && semesterId) {
    const constraints = await Constraint.find({
      dept_id:     deptId,
      semester_id: semesterId,
      status:      'active',
    }).select('parsed_json').lean();

    const facNameLower = (getStr(session.faculty_id, 'name') ?? '').toLowerCase();
    const facWords     = new Set(facNameLower.split(' ').filter((w) => w.length > 2));

    console.log(`[validateMove] Checking DB constraints: found ${constraints.length} for dept=${deptId} sem=${semesterId}. Faculty="${facNameLower}" moving to ${DAY_NAMES[newDay - 1]} slot=${newSlot}`);

    for (const c of constraints) {
      const pj = c.parsed_json;
      if (!pj || typeof pj !== 'object') { console.log('[validateMove]   Skipping constraint: no parsed_json'); continue; }
      const entities = pj.entities;
      const rule     = pj.rule;
      if (!entities || !rule) { console.log('[validateMove]   Skipping constraint: missing entities or rule'); continue; }

      const cName  = (entities.faculty_name ?? '').toLowerCase().trim();
      if (!cName) { console.log('[validateMove]   Skipping constraint: no faculty_name in entities'); continue; }
      const cWords = new Set(cName.split(' ').filter((w) => w.length > 2));
      const matched = [...facWords].some((w) => cWords.has(w));
      console.log(`[validateMove]   Constraint faculty="${cName}" vs session faculty="${facNameLower}" → matched=${matched}`);
      if (!matched) continue;

      const unavailDays  = (rule.unavailable_days  ?? []).map(Number).filter((d) => Number.isFinite(d) && d >= 0 && d < 6);
      const unavailSlots = (rule.unavailable_slots ?? []).map(Number).filter((s) => Number.isFinite(s) && s >= 0 && s < 8);

      // unavailDays uses 0-indexed (0=Mon); newDay is 1-indexed → compare with newDay-1
      const dayBlocked  = unavailDays.includes(newDay - 1);
      // If no specific slots are listed, blocking applies to the entire day
      const slotBlocked = unavailSlots.length === 0 || physSlots.some((ps) => unavailSlots.includes(ps));

      console.log(`[validateMove]   unavailDays=${JSON.stringify(unavailDays)} dayBlocked=${dayBlocked} slotBlocked=${slotBlocked}`);

      if (dayBlocked && slotBlocked) {
        console.log(`[validateMove]   BLOCKED: ${facNameLower} cannot go to ${DAY_NAMES[newDay - 1]}`);
        return {
          valid:  false,
          reason: `A scheduling rule blocks ${getStr(session.faculty_id, 'name') ?? 'this faculty'} on ${DAY_NAMES[newDay - 1]}`,
        };
      }
    }
  }

  return { valid: true, reason: null };
};

/**
 * Return all (day, slot) pairs where a session can validly be placed.
 */
const getAlternatives = async ({ sessions, movingIdx, deptId, semesterId }) => {
  const session = sessions[movingIdx];
  const dur     = session.duration_slots || 1;
  const results = [];

  for (let day = 1; day <= TOTAL_DAYS; day++) {
    for (let slot = 0; slot <= TOTAL_SLOTS - dur; slot++) {
      if (day === session.day && slot === session.slot) continue;
      const check = await validateMove({ sessions, movingIdx, newDay: day, newSlot: slot, deptId, semesterId });
      if (check.valid) results.push({ day, slot });
    }
  }

  return results;
};

module.exports = { validateMove, getAlternatives };
