"use client";

import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Pencil, Trash2, X } from "lucide-react";
import { api } from "@/lib/api";
import { getToken } from "@/lib/auth";
import { API_BASE_URL, DAYS, SLOTS } from "@/lib/constants";
import { streamSse } from "@/lib/stream";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/select-native";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetClose } from "@/components/ui/sheet";

// ── Types ──────────────────────────────────────────────────────────────────────

type SessionItem = {
  day: number;
  slot: number;
  duration_slots?: number;
  batch?: number;
  subject_id?: { _id?: string; name?: string; code?: string } | string;
  faculty_id?: { _id?: string; name?: string } | string;
  room_id?: { _id?: string; name?: string } | string;
};

type ScheduleRow = {
  _id: string;
  status: string;
  created_at?: string;
  published_at?: string;
  dept_id?: { _id?: string; name?: string; code?: string } | string;
  semester_id?: { _id?: string; year?: number; semester?: number } | string;
  section_id?: { _id?: string; name?: string; year?: number } | string | null;
  sessions?: SessionItem[];
};

type ScheduleRowLabeled = ScheduleRow & { label: number };

type SolverJob = { status: string; error?: string; duration_ms?: number };
type Department = { _id: string; name: string; code: string };
type Calendar = { _id: string; year: number; semester: number };
type Section = { _id: string; name: string; dept_id: string };
type Alternative = { day: number; slot: number };

// ── Helpers ────────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const variants: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
    done: "default", running: "secondary", pending: "outline", failed: "destructive",
  };
  return (
    <Badge variant={variants[status] ?? "outline"}>
      {status === "done" ? "Completed" : status.charAt(0).toUpperCase() + status.slice(1)}
    </Badge>
  );
}

function ScheduleStatusBadge({ status }: { status: string }) {
  if (status === "published") return <Badge className="bg-green-600 text-white">Published</Badge>;
  if (status === "archived") return <Badge variant="secondary">Archived</Badge>;
  return <Badge variant="outline">Draft</Badge>;
}

function getSubjCode(val: SessionItem["subject_id"]) {
  if (!val) return "—";
  if (typeof val === "string") return val;
  return val.code ?? val.name ?? "—";
}
function getSubjName(val: SessionItem["subject_id"]) {
  if (!val || typeof val === "string") return null;
  return val.code && val.name ? val.name : null;
}
function getFacultyName(val: SessionItem["faculty_id"]) {
  if (!val || typeof val === "string") return "";
  return val.name ?? "";
}
function getRoomName(val: SessionItem["room_id"]) {
  if (!val || typeof val === "string") return "";
  return (typeof val === "object" ? val.name : null) ?? "";
}

/** Compute sequential labels per (dept+semester) group, newest gets highest number. */
function addLabels(timetables: ScheduleRow[]): ScheduleRowLabeled[] {
  // Sort ascending by creation date to assign labels 1, 2, 3…
  const asc = [...timetables].sort(
    (a, b) => new Date(a.created_at ?? 0).getTime() - new Date(b.created_at ?? 0).getTime()
  );
  const counts: Record<string, number> = {};
  const labeled = asc.map((t) => {
    const dCode  = typeof t.dept_id === "object" ? (t.dept_id?.code ?? "") : "";
    const sYear  = typeof t.semester_id === "object" ? (t.semester_id?.year ?? "") : "";
    const sSem   = typeof t.semester_id === "object" ? (t.semester_id?.semester ?? "") : "";
    const key    = `${dCode}-${sYear}-${sSem}`;
    counts[key]  = (counts[key] ?? 0) + 1;
    return { ...t, label: counts[key] } as ScheduleRowLabeled;
  });
  // Return newest-first (desc by created_at)
  return labeled.sort(
    (a, b) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime()
  );
}

// ── Component ──────────────────────────────────────────────────────────────────

export function TimetablePanel() {
  const queryClient = useQueryClient();

  // Filters / generation state
  const [deptId, setDeptId]         = useState("");
  const [semesterId, setSemesterId] = useState("");
  const [sectionId, setSectionId]   = useState("");
  const [scheduleId, setScheduleId] = useState("");
  const [solverProgress, setSolverProgress] = useState<"idle" | "pending" | "running" | "done" | "failed">("idle");
  const [solverError, setSolverError]       = useState("");

  // Constraint input
  const [constraintText, setConstraintText] = useState("");
  const [constraintLoading, setConstraintLoading] = useState(false);

  // View / edit state
  const [viewMode, setViewMode]               = useState<"grid" | "faculty">("grid");
  const [selectedFaculty, setSelectedFaculty] = useState("");
  const [editMode, setEditMode]               = useState(false);
  const [selectedSessionIdx, setSelectedSessionIdx] = useState<number | null>(null);
  const [pendingMove, setPendingMove] = useState<{ sessionIdx: number; newDay: number; newSlot: number } | null>(null);

  const timetableGridRef = useRef<HTMLDivElement>(null);

  // ── Data queries ──────────────────────────────────────────

  const { data: departments = [] } = useQuery({
    queryKey: ["departments"],
    queryFn: () => api.get<Department[]>("/departments"),
  });

  const { data: calendars = [] } = useQuery({
    queryKey: ["calendars"],
    queryFn: () => api.get<Calendar[]>("/calendars"),
  });

  const { data: sections = [] } = useQuery({
    queryKey: ["sections", deptId],
    queryFn: () => api.get<Section[]>(`/sections?dept_id=${deptId}`),
    enabled: Boolean(deptId),
  });

  const { data: rawTimetables = [], refetch: refetchTimetables } = useQuery({
    queryKey: ["timetables"],
    queryFn: () => api.get<ScheduleRow[]>("/timetables"),
  });

  const schedule = useQuery({
    queryKey: ["schedule", scheduleId],
    enabled: Boolean(scheduleId),
    queryFn: () => api.get<ScheduleRow>(`/timetables/${scheduleId}`),
  });

  const status = useQuery({
    queryKey: ["schedule-status", scheduleId],
    enabled: Boolean(scheduleId) && (solverProgress === "pending" || solverProgress === "running"),
    refetchInterval: 3000,
    queryFn: () => api.get<SolverJob[]>(`/timetables/${scheduleId}/status`),
  });

  const alternatives = useQuery({
    queryKey: ["alternatives", scheduleId, selectedSessionIdx],
    queryFn: () =>
      api.get<Alternative[]>(`/timetables/${scheduleId}/sessions/${selectedSessionIdx}/alternatives`),
    enabled: Boolean(scheduleId) && selectedSessionIdx !== null && editMode,
  });

  // ── Derived data ──────────────────────────────────────────

  const timetables = useMemo(() => addLabels(rawTimetables as ScheduleRow[]), [rawTimetables]);
  const draftTimetables     = useMemo(() => timetables.filter((t) => t.status !== "published"), [timetables]);
  const publishedTimetables = useMemo(() => timetables.filter((t) => t.status === "published"), [timetables]);

  // Matrix: key `${day}-${slot}` → { item, index }. First batch wins per cell.
  const matrixWithIndex = useMemo(() => {
    const map = new Map<string, { item: SessionItem; index: number }>();
    (schedule.data?.sessions ?? []).forEach((item, index) => {
      const key = `${item.day}-${item.slot}`;
      if (!map.has(key)) map.set(key, { item, index });
    });
    return map;
  }, [schedule.data?.sessions]);

  // Cells skipped by rowspan (occupied by a multi-slot lab)
  const skipCells = useMemo(() => {
    const skips = new Set<string>();
    (schedule.data?.sessions ?? []).forEach((s) => {
      const dur = s.duration_slots ?? 1;
      for (let i = 1; i < dur; i++) skips.add(`${s.day}-${s.slot + i}`);
    });
    return skips;
  }, [schedule.data?.sessions]);

  // Unique faculty for faculty view
  const facultyInSchedule = useMemo(() => {
    const seen = new Map<string, string>();
    (schedule.data?.sessions ?? []).forEach((s) => {
      if (s.faculty_id && typeof s.faculty_id === "object" && s.faculty_id.name) {
        if (!seen.has(s.faculty_id.name)) seen.set(s.faculty_id.name, s.faculty_id.name);
      }
    });
    return Array.from(seen.entries()).map(([k]) => ({ label: k, value: k }));
  }, [schedule.data?.sessions]);

  const selectedSession =
    selectedSessionIdx !== null ? (schedule.data?.sessions ?? [])[selectedSessionIdx] : null;

  const selectedDeptName = (departments as Department[]).find((d) => d._id === deptId)?.name ?? "";
  const selectedSemLabel = (() => {
    const c = (calendars as Calendar[]).find((c) => c._id === semesterId);
    return c ? `${c.year} — ${c.semester === 1 ? "Odd Sem" : "Even Sem"}` : "";
  })();

  // ── Mutations ─────────────────────────────────────────────

  const generate = useMutation({
    mutationFn: () =>
      api.post<{ scheduleId: string; jobId: string }>("/timetables/generate", {
        semester_id: semesterId,
        dept_id: deptId,
        ...(sectionId ? { section_id: sectionId } : {}),
      }),
    onSuccess: async (data) => {
      setScheduleId(data.scheduleId);
      setSolverProgress("pending");
      setSolverError("");
      toast.success("Generation started — solver is running");
      try {
        await streamSse(`/timetables/${data.scheduleId}/stream`, (event) => {
          const evtData = event.data as { jobs?: Array<{ status: string; error?: string }> };
          const jobStatus = evtData?.jobs?.[0]?.status;
          if (event.type === "running" || jobStatus === "running") {
            setSolverProgress("running");
          } else if (event.type === "completed" || jobStatus === "done") {
            setSolverProgress("done");
            queryClient.invalidateQueries({ queryKey: ["schedule", data.scheduleId] });
            queryClient.invalidateQueries({ queryKey: ["timetables"] });
            refetchTimetables();
          } else if (event.type === "failed" || jobStatus === "failed") {
            setSolverProgress("failed");
            setSolverError(evtData?.jobs?.[0]?.error ?? "Solver failed");
          }
        });
      } catch { /* SSE disconnect — status polling takes over */ }
    },
    onError: (error: Error) => { toast.error(error.message); setSolverProgress("idle"); },
  });

  const deleteSchedule = useMutation({
    mutationFn: (id: string) => api.del(`/timetables/${id}`),
    onSuccess: (_, id) => {
      toast.success("Timetable deleted");
      if (scheduleId === id) { setScheduleId(""); setSolverProgress("idle"); setEditMode(false); }
      queryClient.invalidateQueries({ queryKey: ["timetables"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const publishSchedule = useMutation({
    mutationFn: (id: string) => api.post(`/timetables/${id}/publish`, {}),
    onSuccess: (_, id) => {
      toast.success("Timetable published!");
      if (scheduleId === id) setEditMode(false);
      queryClient.invalidateQueries({ queryKey: ["timetables"] });
      queryClient.invalidateQueries({ queryKey: ["schedule", id] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const resetTimetableMutation = useMutation({
    mutationFn: () => api.post(`/timetables/${scheduleId}/reset`, {}),
    onSuccess: () => {
      toast.success("Timetable reset to original generated layout");
      setSelectedSessionIdx(null);
      setPendingMove(null);
      setEditMode(false);
      queryClient.invalidateQueries({ queryKey: ["schedule", scheduleId] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const moveSessionMutation = useMutation({
    mutationFn: ({ sessionIdx, newDay, newSlot }: { sessionIdx: number; newDay: number; newSlot: number }) =>
      api.patch(`/timetables/${scheduleId}/sessions/${sessionIdx}/move`, {
        new_day: newDay,
        new_slot: newSlot,
      }),
    onSuccess: () => {
      toast.success("Session moved successfully");
      setSelectedSessionIdx(null);
      setPendingMove(null);
      queryClient.invalidateQueries({ queryKey: ["schedule", scheduleId] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // ── Handlers ──────────────────────────────────────────────

  const handleGenerate = () => {
    if (!deptId || !semesterId) { toast.error("Please select a department and semester"); return; }
    setSolverProgress("idle");
    generate.mutate();
  };

  const handleAddConstraint = async () => {
    if (!constraintText.trim()) { toast.error("Please enter a constraint"); return; }
    if (!semesterId || !deptId) { toast.error("Select a department and semester first"); return; }
    setConstraintLoading(true);
    try {
      await api.post("/constraints/parse", {
        raw_text: constraintText,
        semester_id: semesterId,
        dept_id: deptId,
        auto_save: true,
      });
      toast.success("Constraint saved");
      setConstraintText("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save constraint");
    } finally {
      setConstraintLoading(false);
    }
  };

  const handleExport = async (path: string, filename: string) => {
    try {
      const token = getToken();
      const res = await fetch(`${API_BASE_URL}${path}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) { toast.error("Export failed — please try again"); return; }
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click();
      document.body.removeChild(a); URL.revokeObjectURL(url);
    } catch { toast.error("Export failed"); }
  };

  const handleViewSchedule = (id: string) => {
    setScheduleId(id);
    setSolverProgress("done");
    setSelectedFaculty("");
    setEditMode(false);
    setSelectedSessionIdx(null);
    setTimeout(() => timetableGridRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);
  };

  const handleCellClick = (dayIndex: number, slotIndex: number) => {
    if (!editMode) return;
    const cellKey = `${dayIndex + 1}-${slotIndex}`;
    const entry   = matrixWithIndex.get(cellKey);
    if (entry) setSelectedSessionIdx(entry.index);
  };

  // ── Select options ────────────────────────────────────────

  const deptOptions     = (departments as Department[]).map((d) => ({ label: `${d.name} (${d.code})`, value: d._id }));
  const semesterOptions = (calendars as Calendar[]).map((c) => ({ label: `${c.year} — ${c.semester === 1 ? "Odd Sem" : "Even Sem"}`, value: c._id }));
  const sectionOptions  = (sections as Section[]).map((s) => ({ label: s.name, value: s._id }));

  // ── Render ────────────────────────────────────────────────

  return (
    <div className="space-y-6">

      {/* ── Generate Form ─────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle>Generate Timetable</CardTitle>
          <p className="text-sm text-muted-foreground">
            Select your department and semester, then click Generate.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1">
              <label className="text-sm font-medium">Department</label>
              <NativeSelect options={deptOptions} value={deptId} onChange={setDeptId} placeholder="Select department…" />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Semester</label>
              <NativeSelect options={semesterOptions} value={semesterId} onChange={setSemesterId} placeholder="Select semester…" />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium">Section (optional)</label>
              <NativeSelect options={sectionOptions} value={sectionId} onChange={setSectionId} placeholder="All students" disabled={!deptId} />
            </div>
          </div>

          <Button
            onClick={handleGenerate}
            disabled={!deptId || !semesterId || generate.isPending || solverProgress === "running" || solverProgress === "pending"}
          >
            {generate.isPending || solverProgress === "running" || solverProgress === "pending" ? "Generating…" : "Generate Timetable"}
          </Button>

          {solverProgress !== "idle" && (
            <div className="rounded-md border p-3">
              {solverProgress === "pending"  && <p className="text-sm text-muted-foreground">⏳ Waiting for solver to start…</p>}
              {solverProgress === "running"  && <p className="text-sm text-muted-foreground">⚙️ Solver is running — building your timetable…</p>}
              {solverProgress === "done"     && (
                <p className="text-sm text-primary font-medium">
                  ✅ Timetable generated for {selectedDeptName}{selectedSemLabel ? ` — ${selectedSemLabel}` : ""}
                </p>
              )}
              {solverProgress === "failed"   && (
                <div>
                  <p className="text-sm font-medium text-destructive">❌ Generation failed</p>
                  {solverError && <p className="mt-1 text-xs text-muted-foreground">{solverError}</p>}
                </div>
              )}
            </div>
          )}

          {scheduleId && solverProgress === "done" && (
            <div className="flex flex-wrap gap-2 pt-1">
              <Button variant="outline" size="sm" onClick={() => handleExport(`/exports/${scheduleId}/pdf`, `timetable-${scheduleId}.pdf`)}>
                Export PDF
              </Button>
              <Button variant="outline" size="sm" onClick={() => handleExport(`/exports/${scheduleId}/ical`, `timetable-${scheduleId}.ics`)}>
                Export to Calendar
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Constraint Input ───────────────────────────────── */}
      {deptId && semesterId && (
        <Card>
          <CardHeader>
            <CardTitle>Add a Scheduling Rule</CardTitle>
            <p className="text-sm text-muted-foreground">
              Describe a constraint in plain English. Saved rules apply automatically on next generation.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-2">
              <Input
                placeholder='e.g. "Dr. Sharma is not available on Fridays"'
                value={constraintText}
                onChange={(e) => setConstraintText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddConstraint()}
              />
              <Button variant="outline" onClick={handleAddConstraint} disabled={constraintLoading}>
                {constraintLoading ? "Saving…" : "Add Rule"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Draft Timetables ───────────────────────────────── */}
      {draftTimetables.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Draft Timetables</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {draftTimetables.map((t) => {
                const deptName  = typeof t.dept_id === "object" ? (t.dept_id?.name ?? t.dept_id?.code ?? "—") : "—";
                const semLabel  = typeof t.semester_id === "object"
                  ? `${t.semester_id?.year ?? "?"} — ${t.semester_id?.semester === 1 ? "Odd Sem" : "Even Sem"}`
                  : "—";
                const sectionLabel = t.section_id && typeof t.section_id === "object"
                  ? `Section ${t.section_id.name ?? ""}${t.section_id.year ? ` (Yr ${t.section_id.year})` : ""}`
                  : null;
                const createdAt = t.created_at
                  ? new Date(t.created_at).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
                  : null;
                return (
                  <div key={t._id} className="flex items-center justify-between rounded-md border px-3 py-2 gap-2">
                    <div className="space-y-0.5 min-w-0">
                      <p className="text-sm font-medium leading-tight">
                        {deptName} — {semLabel}
                        {sectionLabel && <span className="ml-1 text-primary font-semibold">· {sectionLabel}</span>}
                        <span className="ml-1.5 text-xs text-muted-foreground font-normal">#{t.label}</span>
                      </p>
                      <div className="flex items-center gap-2 flex-wrap">
                        <ScheduleStatusBadge status={t.status} />
                        {createdAt && <span className="text-xs text-muted-foreground">{createdAt}</span>}
                      </div>
                    </div>
                    <div className="flex gap-1.5 items-center shrink-0">
                      <Button variant="outline" size="sm" onClick={() => handleViewSchedule(t._id)}>View</Button>
                      <Button variant="outline" size="sm" onClick={() => handleExport(`/exports/${t._id}/pdf`, `timetable-${t._id}.pdf`)}>PDF</Button>
                      <Button
                        variant="outline" size="sm"
                        onClick={() => { handleViewSchedule(t._id); setEditMode(true); }}
                        className="gap-1"
                      >
                        <Pencil className="h-3 w-3" /> Edit
                      </Button>
                      <Button
                        variant="default" size="sm"
                        disabled={publishSchedule.isPending}
                        onClick={() => {
                          toast("Publish this timetable?", {
                            description: "Published timetables cannot be edited or deleted.",
                            action: { label: "Publish", onClick: () => publishSchedule.mutate(t._id) },
                            cancel: { label: "Cancel", onClick: () => {} },
                          });
                        }}
                      >
                        Publish
                      </Button>
                      <Button
                        variant="ghost" size="sm"
                        className="text-destructive hover:text-destructive hover:bg-destructive/10 px-2"
                        disabled={deleteSchedule.isPending}
                        onClick={() => {
                          toast("Delete this timetable?", {
                            action: { label: "Delete", onClick: () => deleteSchedule.mutate(t._id) },
                            cancel: { label: "Cancel", onClick: () => {} },
                          });
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Published Timetables ───────────────────────────── */}
      {publishedTimetables.length > 0 && (
        <Card className="border-green-200 dark:border-green-900">
          <CardHeader>
            <CardTitle className="text-green-700 dark:text-green-400">Published Timetables</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {publishedTimetables.map((t) => {
                const deptName  = typeof t.dept_id === "object" ? (t.dept_id?.name ?? "—") : "—";
                const semLabel  = typeof t.semester_id === "object"
                  ? `${t.semester_id?.year ?? "?"} — ${t.semester_id?.semester === 1 ? "Odd Sem" : "Even Sem"}`
                  : "—";
                const sectionLabel = t.section_id && typeof t.section_id === "object"
                  ? `Section ${t.section_id.name ?? ""}` : null;
                const publishedAt = t.published_at
                  ? new Date(t.published_at).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
                  : null;
                return (
                  <div key={t._id} className="flex items-center justify-between rounded-md border border-green-100 dark:border-green-900 bg-green-50/50 dark:bg-green-950/20 px-3 py-2 gap-2">
                    <div className="space-y-0.5 min-w-0">
                      <p className="text-sm font-medium leading-tight">
                        {deptName} — {semLabel}
                        {sectionLabel && <span className="ml-1 text-primary font-semibold">· {sectionLabel}</span>}
                        <span className="ml-1.5 text-xs text-muted-foreground font-normal">#{t.label}</span>
                      </p>
                      <div className="flex items-center gap-2 flex-wrap">
                        <ScheduleStatusBadge status={t.status} />
                        {publishedAt && <span className="text-xs text-muted-foreground">Published {publishedAt}</span>}
                      </div>
                    </div>
                    <div className="flex gap-1.5 items-center shrink-0">
                      <Button variant="outline" size="sm" onClick={() => handleViewSchedule(t._id)}>View</Button>
                      <Button variant="outline" size="sm" onClick={() => handleExport(`/exports/${t._id}/pdf`, `timetable-${t._id}.pdf`)}>PDF</Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Timetable Grid ────────────────────────────────── */}
      {scheduleId && (
        <div ref={timetableGridRef}>
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <CardTitle>Timetable Grid</CardTitle>
                  {schedule.data?.status && <ScheduleStatusBadge status={schedule.data.status} />}
                  {editMode && (
                    <Badge variant="secondary" className="bg-accent text-accent-foreground">
                      Edit Mode
                    </Badge>
                  )}
                </div>
                <div className="flex gap-2 flex-wrap">
                  <Button size="sm" variant={viewMode === "grid" ? "default" : "outline"} onClick={() => setViewMode("grid")}>Grid</Button>
                  <Button size="sm" variant={viewMode === "faculty" ? "default" : "outline"} onClick={() => setViewMode("faculty")}>Faculty</Button>
                  {schedule.data?.status === "draft" && (
                    <>
                      <Button
                        size="sm"
                        variant={editMode ? "secondary" : "outline"}
                        className={editMode ? "bg-accent text-accent-foreground hover:bg-accent/80" : ""}
                        onClick={() => { setEditMode((e) => !e); setSelectedSessionIdx(null); setPendingMove(null); }}
                      >
                        {editMode ? "Exit Edit" : <><Pencil className="h-3 w-3 mr-1" />Edit</>}
                      </Button>
                      {editMode && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="text-destructive hover:text-destructive hover:bg-destructive/10 border-destructive/30"
                          disabled={resetTimetableMutation.isPending}
                          onClick={() => {
                            toast("Reset to original layout?", {
                              description: "All manual slot changes will be undone. This cannot be reversed.",
                              action: { label: "Reset", onClick: () => resetTimetableMutation.mutate() },
                              cancel: { label: "Cancel", onClick: () => {} },
                            });
                          }}
                        >
                          {resetTimetableMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Reset to Original"}
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </div>
              {editMode && (
                <p className="text-xs text-accent-foreground mt-1">
                  Click any session cell to see available alternative slots and move it.
                </p>
              )}
              {viewMode === "faculty" && facultyInSchedule.length > 0 && (
                <div className="mt-2">
                  <NativeSelect options={facultyInSchedule} value={selectedFaculty} onChange={setSelectedFaculty} placeholder="Select faculty member…" />
                </div>
              )}
            </CardHeader>

            <CardContent>
              {schedule.isLoading && <p className="py-8 text-center text-sm text-muted-foreground">Loading timetable…</p>}

              {/* Grid view */}
              {!schedule.isLoading && viewMode === "grid" && (
                <div className="overflow-auto">
                  <table className="w-full min-w-160 border-collapse text-sm">
                    <thead>
                      <tr className="bg-muted/50">
                        <th className="border px-3 py-2 text-left font-medium text-muted-foreground">Time</th>
                        {DAYS.map((day) => (
                          <th key={day} className="border px-3 py-2 font-medium">{day}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {SLOTS.map((slot, slotIndex) => (
                        <tr key={slot.start} className="hover:bg-muted/20 transition-colors">
                          <td className="border px-3 py-2 font-medium text-muted-foreground whitespace-nowrap">
                            {slot.label}
                          </td>
                          {DAYS.map((_, dayIndex) => {
                            const cellKey = `${dayIndex + 1}-${slotIndex}`;
                            if (skipCells.has(cellKey)) return null;

                            const entry = matrixWithIndex.get(cellKey);
                            const item  = entry?.item;
                            const dur   = item?.duration_slots ?? 1;
                            const isSelected = entry !== undefined && entry.index === selectedSessionIdx;

                            return (
                              <td
                                key={`${slot.start}-${dayIndex}`}
                                rowSpan={dur > 1 ? dur : undefined}
                                onClick={() => handleCellClick(dayIndex, slotIndex)}
                                className={cn(
                                  "border min-w-28",
                                  dur > 1 ? "relative p-0" : "px-2 py-1.5 align-top",
                                  editMode && item ? "cursor-pointer" : "",
                                  editMode && item && !isSelected ? "hover:ring-2 hover:ring-primary/40 hover:ring-inset" : "",
                                  isSelected ? "ring-2 ring-primary ring-inset" : "",
                                )}
                              >
                                {item ? (
                                  <div
                                    className={cn(
                                      "rounded px-2 py-1.5 overflow-hidden",
                                      dur > 1
                                        ? "absolute inset-0 m-px flex flex-col"
                                        : "",
                                      isSelected
                                        ? "bg-primary/20 border-l-2 border-primary"
                                        : dur > 1
                                          ? "bg-blue-50 dark:bg-blue-950/40 border-l-2 border-blue-400"
                                          : "bg-primary/10",
                                    )}
                                  >
                                    <p className="font-semibold text-xs leading-tight">{getSubjCode(item.subject_id)}</p>
                                    {getSubjName(item.subject_id) && (
                                      <p className="text-xs text-muted-foreground leading-tight truncate">{getSubjName(item.subject_id)}</p>
                                    )}
                                    <p className="text-xs text-muted-foreground leading-tight">{getFacultyName(item.faculty_id)}</p>
                                    <p className="text-xs text-muted-foreground leading-tight">{getRoomName(item.room_id)}</p>
                                    {dur > 1 && (
                                      <p className="text-xs text-blue-500 dark:text-blue-400 font-medium mt-auto pt-1">{dur}h Lab</p>
                                    )}
                                    {item.batch && item.batch > 1 && (
                                      <p className="text-xs text-muted-foreground leading-tight">Batch {item.batch}</p>
                                    )}
                                  </div>
                                ) : (
                                  <span className="text-muted-foreground/30 text-xs px-2">—</span>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Faculty view */}
              {!schedule.isLoading && viewMode === "faculty" && (
                <div className="space-y-2">
                  {!selectedFaculty ? (
                    <p className="py-4 text-sm text-muted-foreground">Select a faculty member above to see their schedule.</p>
                  ) : (() => {
                    const facultySessions = (schedule.data?.sessions ?? [])
                      .filter((s) => typeof s.faculty_id === "object" && s.faculty_id?.name === selectedFaculty)
                      .sort((a, b) => ((a.day ?? 0) * 10 + (a.slot ?? 0)) - ((b.day ?? 0) * 10 + (b.slot ?? 0)));
                    return (
                      <>
                        <h4 className="font-medium">{selectedFaculty}&apos;s Schedule</h4>
                        {facultySessions.length === 0 ? (
                          <p className="py-4 text-sm text-muted-foreground">No sessions found.</p>
                        ) : (
                          facultySessions.map((s, i) => (
                            <div key={i} className="flex items-center gap-3 rounded-md border px-3 py-2 text-sm">
                              <span className="w-10 font-medium text-muted-foreground">{DAYS[(s.day ?? 1) - 1]}</span>
                              <span className="w-28 text-muted-foreground">{SLOTS[s.slot ?? 0]?.label ?? `Slot ${s.slot}`}</span>
                              <span className="font-medium">{getSubjCode(s.subject_id)}</span>
                              <span className="text-muted-foreground">{getRoomName(s.room_id)}</span>
                              {(s.duration_slots ?? 1) > 1 && (
                                <Badge variant="outline" className="text-blue-600 border-blue-300">{s.duration_slots}h Lab</Badge>
                              )}
                            </div>
                          ))
                        )}
                      </>
                    );
                  })()}
                </div>
              )}

            </CardContent>
          </Card>
        </div>
      )}

      {/* ── Edit Sheet (slides in from right) ─────────────── */}
      <Sheet
        open={editMode && selectedSessionIdx !== null}
        onOpenChange={(open) => { if (!open) { setSelectedSessionIdx(null); setPendingMove(null); } }}
      >
        <SheetContent>
          <SheetHeader>
            <div className="flex items-start justify-between">
              <div>
                <SheetTitle>
                  {pendingMove ? "Confirm Move" : getSubjCode(selectedSession?.subject_id)}
                  {!pendingMove && selectedSession?.batch && selectedSession.batch > 1 && (
                    <Badge variant="outline" className="ml-2 text-xs">Batch {selectedSession.batch}</Badge>
                  )}
                </SheetTitle>
                <SheetDescription>
                  {pendingMove
                    ? "Review the change below before confirming."
                    : getSubjName(selectedSession?.subject_id)}
                </SheetDescription>
              </div>
              <SheetClose className="rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring">
                <X className="h-4 w-4" />
              </SheetClose>
            </div>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">

            {/* ── Confirmation view ── */}
            {pendingMove ? (
              <div className="space-y-4">
                {/* Session summary */}
                <div className="rounded-md border bg-muted/30 px-3 py-2.5 text-sm space-y-1">
                  <p className="font-semibold">{getSubjCode(selectedSession?.subject_id)}{getSubjName(selectedSession?.subject_id) ? ` — ${getSubjName(selectedSession?.subject_id)}` : ""}</p>
                  <p className="text-muted-foreground">{getFacultyName(selectedSession?.faculty_id) || "—"} · {getRoomName(selectedSession?.room_id) || "—"}</p>
                  {(selectedSession?.duration_slots ?? 1) > 1 && (
                    <Badge variant="outline" className="text-blue-600 border-blue-300 text-xs">{selectedSession?.duration_slots}h Lab</Badge>
                  )}
                </div>

                {/* From → To */}
                <div className="space-y-2 text-sm">
                  <div className="flex items-center gap-3 rounded-md border border-dashed px-3 py-2 text-muted-foreground">
                    <span className="text-xs font-semibold uppercase tracking-wide w-8">From</span>
                    <span className="font-medium text-foreground">{selectedSession?.day ? DAYS[selectedSession.day - 1] : "—"}</span>
                    <span>{selectedSession?.slot !== undefined ? SLOTS[selectedSession.slot]?.label : "—"}</span>
                  </div>
                  <div className="flex items-center justify-center text-muted-foreground text-xs">↓</div>
                  <div className="flex items-center gap-3 rounded-md border border-primary/40 bg-primary/5 px-3 py-2">
                    <span className="text-xs font-semibold uppercase tracking-wide w-8 text-primary">To</span>
                    <span className="font-medium">{DAYS[pendingMove.newDay - 1]}</span>
                    <span>{SLOTS[pendingMove.newSlot]?.label ?? `Slot ${pendingMove.newSlot}`}</span>
                  </div>
                </div>

                {/* Warning for lab sessions */}
                {(selectedSession?.duration_slots ?? 1) > 1 && (
                  <div className="rounded-md border border-accent bg-accent/20 px-3 py-2 text-xs text-accent-foreground">
                    This is a {selectedSession?.duration_slots}h lab. Moving it will occupy {selectedSession?.duration_slots} consecutive slots starting at {SLOTS[pendingMove.newSlot]?.label}.
                  </div>
                )}

                {/* Actions */}
                <div className="flex gap-2 pt-1">
                  <Button
                    className="flex-1"
                    disabled={moveSessionMutation.isPending}
                    onClick={() => moveSessionMutation.mutate(pendingMove)}
                  >
                    {moveSessionMutation.isPending ? <><Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />Moving…</> : "Confirm Move"}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={moveSessionMutation.isPending}
                    onClick={() => setPendingMove(null)}
                  >
                    Back
                  </Button>
                </div>
              </div>
            ) : (
              <>
                {/* ── Normal view: current info + alternatives ── */}
                <div className="space-y-1.5">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Current</p>
                  <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm space-y-0.5">
                    <p><span className="text-muted-foreground w-16 inline-block">Day</span> {selectedSession?.day ? DAYS[selectedSession.day - 1] : "—"}</p>
                    <p><span className="text-muted-foreground w-16 inline-block">Time</span> {selectedSession?.slot !== undefined ? SLOTS[selectedSession.slot]?.label : "—"}{(selectedSession?.duration_slots ?? 1) > 1 && ` — ${selectedSession?.duration_slots}h Lab`}</p>
                    <p><span className="text-muted-foreground w-16 inline-block">Faculty</span> {getFacultyName(selectedSession?.faculty_id) || "—"}</p>
                    <p><span className="text-muted-foreground w-16 inline-block">Room</span> {getRoomName(selectedSession?.room_id) || "—"}</p>
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Move to…</p>
                  {alternatives.isLoading && (
                    <div className="space-y-1.5">
                      {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-8 w-full rounded-md" />)}
                    </div>
                  )}
                  {!alternatives.isLoading && (alternatives.data?.length === 0) && (
                    <div className="rounded-md border border-dashed px-3 py-4 text-center">
                      <p className="text-sm text-muted-foreground">No valid slots available</p>
                      <p className="text-xs text-muted-foreground mt-0.5">All other slots have conflicts</p>
                    </div>
                  )}
                  {!alternatives.isLoading && (alternatives.data?.length ?? 0) > 0 && (
                    <div className="space-y-1">
                      {DAYS.map((dayName, dayIdx) => {
                        const dayAlts = (alternatives.data ?? []).filter((a) => a.day === dayIdx + 1);
                        if (!dayAlts.length) return null;
                        return (
                          <div key={dayName}>
                            <p className="text-xs text-muted-foreground mb-1 mt-2">{dayName}</p>
                            <div className="flex flex-wrap gap-1.5">
                              {dayAlts.map((alt) => (
                                <button
                                  key={`${alt.day}-${alt.slot}`}
                                  onClick={() => {
                                    if (selectedSessionIdx === null) return;
                                    setPendingMove({ sessionIdx: selectedSessionIdx, newDay: alt.day, newSlot: alt.slot });
                                  }}
                                  className={cn(
                                    "inline-flex items-center rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                                    "hover:bg-primary hover:text-primary-foreground hover:border-primary",
                                  )}
                                >
                                  {SLOTS[alt.slot]?.label ?? `Slot ${alt.slot}`}
                                </button>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>

    </div>
  );
}
