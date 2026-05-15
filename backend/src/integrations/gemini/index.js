const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GEMINI_API_KEY } = require('../../config/env');
const { logger } = require('../../common/logger');

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

const parseConstraintText = async (rawText, context = {}) => {
  const prompt = `
You are a university timetable constraint parser. Convert the following natural language constraint into a structured JSON object.

Context:
- Department: ${context.dept || 'unknown'}
- Semester: ${context.semester || 'unknown'}

Constraint text: "${rawText}"

IMPORTANT day-number mapping (always use these exact numbers — do NOT use Sunday=0):
  Monday=0, Tuesday=1, Wednesday=2, Thursday=3, Friday=4, Saturday=5

IMPORTANT slot-number mapping (0-indexed, 8 slots per day):
  Slot 0 = 08:00–09:00, Slot 1 = 09:00–10:00, Slot 2 = 10:00–11:00,
  Slot 3 = 11:00–12:00, Slot 4 = 12:00–13:00, Slot 5 = 13:00–14:00 (lunch),
  Slot 6 = 14:00–15:00, Slot 7 = 15:00–16:00

Return ONLY valid JSON with this structure (no markdown, no explanation):
{
  "type": "hard" or "soft",
  "category": one of ["faculty_availability", "room_preference", "subject_timing", "workload", "consecutive_slots", "other"],
  "weight": number 1-5 (1=low priority, 5=critical, always 5 for hard constraints),
  "entities": {
    "faculty_name": exact faculty name string as it would appear in a university roster, or null,
    "subject_code": string or null,
    "room": string or null
  },
  "rule": {
    "unavailable_days": array using the day numbers above (Monday=0, Tuesday=1, ..., Saturday=5), or null,
    "unavailable_slots": array of slot numbers (0-7) or null,
    "preferred_days": array or null,
    "preferred_slots": array or null,
    "max_consecutive": number or null,
    "min_gap_between_sessions": number or null
  },
  "summary": one-line human readable summary of the constraint
}

Example: "Dr. Smith is not available on Mondays" →
  entities.faculty_name = "Dr. Smith", rule.unavailable_days = [0], rule.unavailable_slots = null
`;

  logger.info('[Gemini:parseConstraint] Input:', JSON.stringify({ rawText, context }));
  const t0 = Date.now();

  try {
    const result = await model.generateContent(prompt);
    const rawResponse = result.response.text().trim();
    logger.info(`[Gemini:parseConstraint] Raw response (${Date.now() - t0}ms):\n${rawResponse}`);

    const clean = rawResponse.replace(/```json\n?|\n?```/g, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (jsonErr) {
      logger.error('[Gemini:parseConstraint] JSON.parse failed. Raw text was:\n', rawResponse);
      throw jsonErr;
    }

    logger.info('[Gemini:parseConstraint] Parsed result:', JSON.stringify({
      type:     parsed.type,
      category: parsed.category,
      weight:   parsed.weight,
      entities: parsed.entities,
      rule:     parsed.rule,
      summary:  parsed.summary,
    }, null, 2));

    // Warn on common mistakes Gemini makes with day numbers
    const days = parsed.rule?.unavailable_days ?? parsed.rule?.preferred_days ?? [];
    if (days.includes(6) || days.includes(7)) {
      logger.warn('[Gemini:parseConstraint] Suspicious day value (6 or 7) — Gemini may have used Sunday=0 mapping instead of Monday=0. Days returned:', days);
    }

    return parsed;
  } catch (err) {
    logger.error('[Gemini:parseConstraint] Failed:', err.message);
    throw new Error('Failed to parse constraint with LLM');
  }
};

const explainConflict = async (conflictDetails) => {
  const prompt = `
You are a university timetable advisor. Explain the following timetable conflict in simple terms and suggest how to resolve it.

Conflict details:
${JSON.stringify(conflictDetails, null, 2)}

Respond in plain English, 2-3 sentences max. Be specific about what is conflicting and give one actionable suggestion.
`;

  logger.info('[Gemini:explainConflict] Input:', JSON.stringify(conflictDetails));
  const t0 = Date.now();

  try {
    const result = await model.generateContent(prompt);
    const explanation = result.response.text().trim();
    logger.info(`[Gemini:explainConflict] Response (${Date.now() - t0}ms):\n${explanation}`);
    return explanation;
  } catch (err) {
    logger.error('[Gemini:explainConflict] Failed:', err.message);
    throw new Error('Failed to explain conflict with LLM');
  }
};

/**
 * AI Touchpoint 1 (Pre-Solve): Suggest which faculty should teach which subjects.
 * HOD reviews and tweaks before the CP-SAT solver runs.
 */
const suggestAllocation = async ({ faculty_list, subject_list, dept_name, semester_name }) => {
  if (!Array.isArray(faculty_list) || !Array.isArray(subject_list)) {
    throw new Error('suggestAllocation requires faculty_list and subject_list arrays');
  }
  const facultySummary = faculty_list.map((f) => ({
    id: f._id,
    name: f.name,
    expertise: f.expertise || [],
    max_hours: f.max_hours_per_week || 20,
    type: f.type || 'faculty',
  }));

  const subjectSummary = subject_list.map((s) => ({
    id: s._id,
    code: s.code,
    name: s.name,
    type: s.type,
    credits: s.credits,
    sessions_per_week: s.sessions_per_week,
  }));

  const prompt = `
You are a university department scheduler. Given the faculty and subjects listed below, suggest an optimal faculty-subject allocation for the ${semester_name} semester of the ${dept_name} department.

Rules:
1. Assign each subject to exactly ONE faculty member.
2. Match faculty expertise to subject (use subject code and name as hints).
3. Balance workload — no faculty should be overloaded (respect max_hours_per_week: 1 session = 1 hour).
4. Lab/practical subjects must go to faculty with relevant expertise or lab_assistant type.
5. A faculty member can teach multiple subjects.
6. If no good match exists, assign to the least-loaded faculty.

Faculty list:
${JSON.stringify(facultySummary, null, 2)}

Subject list:
${JSON.stringify(subjectSummary, null, 2)}

Return ONLY a valid JSON array (no markdown, no explanation):
[
  {
    "subject_id": "<id>",
    "subject_code": "<code>",
    "subject_name": "<name>",
    "faculty_id": "<id>",
    "faculty_name": "<name>",
    "reason": "<one sentence why this match>",
    "confidence": "high" | "medium" | "low"
  }
]
`;

  logger.info(`[Gemini:suggestAllocation] Input: ${faculty_list.length} faculty, ${subject_list.length} subjects (dept: ${dept_name}, sem: ${semester_name})`);
  const t0 = Date.now();

  try {
    const result = await model.generateContent(prompt);
    const rawResponse = result.response.text().trim();
    logger.info(`[Gemini:suggestAllocation] Raw response (${Date.now() - t0}ms):\n${rawResponse}`);

    const clean = rawResponse.replace(/```json\n?|\n?```/g, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (jsonErr) {
      logger.error('[Gemini:suggestAllocation] JSON.parse failed. Raw text was:\n', rawResponse);
      throw jsonErr;
    }

    if (!Array.isArray(parsed)) {
      logger.warn('[Gemini:suggestAllocation] Response is not an array — got:', typeof parsed);
    } else {
      const lowConf = parsed.filter((a) => a.confidence === 'low');
      logger.info(`[Gemini:suggestAllocation] Parsed ${parsed.length} allocations. Low-confidence: ${lowConf.length}`);
      if (lowConf.length) {
        logger.warn('[Gemini:suggestAllocation] Low-confidence allocations:', JSON.stringify(lowConf.map((a) => ({ subject: a.subject_code, faculty: a.faculty_name, reason: a.reason }))));
      }
    }

    return parsed;
  } catch (err) {
    logger.error('[Gemini:suggestAllocation] Failed:', err.message);
    throw new Error('Failed to generate faculty-subject allocation with LLM');
  }
};

module.exports = { parseConstraintText, explainConflict, suggestAllocation };
