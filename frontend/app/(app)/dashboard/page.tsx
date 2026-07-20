/* Hallmark · genre: modern-minimal · redesign: dashboard (in place)
 * theme: project shadcn system (amber --primary · Inter + JetBrains Mono)
 * tone: technical · audience: university admins · data hooks + routes preserved
 */
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { getUser, type SessionUser } from "@/lib/auth";
import { Button } from "@/components/ui/button";

type CountResult = { total?: number } | unknown[];

function useCount(endpoint: string) {
  const { data, isLoading } = useQuery({
    queryKey: ["count", endpoint],
    queryFn: () => api.get<CountResult>(endpoint),
  });
  if (isLoading) return null;
  if (Array.isArray(data)) return data.length;
  if (data && typeof data === "object" && "total" in (data as object)) {
    return (data as { total: number }).total;
  }
  return 0;
}

type SetupItem = {
  label: string;
  href: string;
  count: number | null;
  description: string;
  required: boolean;
};

function SetupStep({ item, index }: { item: SetupItem; index: number }) {
  const isReady = item.count !== null && item.count > 0;
  const isLoading = item.count === null;

  return (
    <Link
      href={item.href}
      className="group flex items-center gap-4 px-4 py-3 transition-colors hover:bg-muted/50"
    >
      <div
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md border font-mono text-xs font-semibold tabular-nums ${
          isLoading
            ? "border-border bg-muted text-muted-foreground"
            : isReady
            ? "border-primary/30 bg-primary/10 text-primary"
            : item.required
            ? "border-destructive/30 bg-destructive/10 text-destructive"
            : "border-border bg-muted text-muted-foreground"
        }`}
      >
        {isLoading ? "··" : isReady ? "✓" : String(index + 1).padStart(2, "0")}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-sm font-medium">{item.label}</p>
          {!isLoading && (
            <span
              className={`shrink-0 font-mono text-[11px] uppercase tracking-wide tabular-nums ${
                isReady
                  ? "text-muted-foreground"
                  : item.required
                  ? "text-destructive"
                  : "text-muted-foreground"
              }`}
            >
              {isReady
                ? `${item.count} added`
                : item.required
                ? "required"
                : "optional"}
            </span>
          )}
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {item.description}
        </p>
      </div>
      <span className="shrink-0 text-muted-foreground/40 transition-colors group-hover:text-foreground">
        &rarr;
      </span>
    </Link>
  );
}

export default function DashboardPage() {
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);

  useEffect(() => {
    setUser(getUser());
  }, []);

  const deptCount = useCount("/departments");
  const facultyCount = useCount("/faculty");
  const subjectCount = useCount("/subjects");
  const roomCount = useCount("/rooms");
  const calendarCount = useCount("/calendars");
  const timetableCount = useCount("/timetables");

  const setupItems: SetupItem[] = [
    {
      label: "Departments",
      href: "/departments",
      count: deptCount,
      description: "Add your institution's academic departments first.",
      required: true,
    },
    {
      label: "Rooms",
      href: "/rooms",
      count: roomCount,
      description: "Add classrooms, labs, and halls available for scheduling.",
      required: true,
    },
    {
      label: "Faculty Members",
      href: "/faculty",
      count: facultyCount,
      description: "Add teaching staff who will be assigned to classes.",
      required: true,
    },
    {
      label: "Subjects",
      href: "/subjects",
      count: subjectCount,
      description: "Add courses with their weekly session requirements.",
      required: true,
    },
    {
      label: "Academic Calendar",
      href: "/calendars",
      count: calendarCount,
      description: "Define the semester dates for your institution.",
      required: true,
    },
    {
      label: "Sections (optional)",
      href: "/sections",
      count: null, // don't block on this
      description: "Add student sections if you split batches.",
      required: false,
    },
  ];

  const requiredCounts = [deptCount, roomCount, facultyCount, subjectCount, calendarCount];
  const requiredTotal = requiredCounts.length;
  const requiredReady = requiredCounts.filter((c) => c !== null && c > 0).length;
  const anyLoading = requiredCounts.some((c) => c === null);
  const allRequiredReady = requiredCounts.every((c) => c !== null && c > 0);
  const progressPct = Math.round((requiredReady / requiredTotal) * 100);

  const metrics = [
    { label: "Departments", value: deptCount },
    { label: "Faculty", value: facultyCount },
    { label: "Subjects", value: subjectCount },
    { label: "Rooms", value: roomCount },
    { label: "Calendars", value: calendarCount },
    { label: "Timetables", value: timetableCount },
  ];

  return (
    <div className="space-y-6">
      {/* Header · welcome + readiness status */}
      <div className="flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
            Operations Console
          </p>
          <h2 className="mt-1.5 text-2xl font-semibold tracking-tight">
            Welcome{user?.name ? `, ${user.name.split(" ")[0]}` : ""}
          </h2>
          {user?.role && (
            <p className="mt-1 text-sm capitalize text-muted-foreground">
              Signed in as {user.role}
            </p>
          )}
        </div>

        <div
          className={`inline-flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 font-mono text-xs uppercase tracking-wide ${
            anyLoading
              ? "border-border bg-muted text-muted-foreground"
              : allRequiredReady
              ? "border-primary/30 bg-primary/10 text-primary"
              : "border-destructive/30 bg-destructive/10 text-destructive"
          }`}
        >
          <span
            aria-hidden
            className={`h-1.5 w-1.5 rounded-full ${
              anyLoading
                ? "bg-muted-foreground"
                : allRequiredReady
                ? "bg-primary"
                : "bg-destructive"
            }`}
          />
          {anyLoading
            ? "Checking setup…"
            : allRequiredReady
            ? "Ready to generate"
            : "Setup incomplete"}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        {/* Setup checklist + progress */}
        <section className="rounded-lg border border-border bg-background">
          <div className="flex items-center justify-between gap-4 border-b border-border px-4 py-3">
            <div>
              <h3 className="text-sm font-semibold">Setup Checklist</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Required before generating a timetable.
              </p>
            </div>
            <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
              {anyLoading ? "—" : `${requiredReady}/${requiredTotal}`} required
            </span>
          </div>

          {/* Progress meter · computed from real counts */}
          <div className="px-4 pt-3">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
                style={{ width: anyLoading ? "0%" : `${progressPct}%` }}
              />
            </div>
          </div>

          <div className="mt-2 divide-y divide-border">
            {setupItems.map((item, i) => (
              <SetupStep key={item.href} item={item} index={i} />
            ))}
          </div>
        </section>

        <div className="space-y-4">
          {/* Quick actions */}
          <section className="rounded-lg border border-border bg-background">
            <div className="border-b border-border px-4 py-3">
              <h3 className="text-sm font-semibold">Quick Actions</h3>
            </div>
            <div className="space-y-2 p-4">
              <Button
                className="w-full justify-between"
                onClick={() => router.push("/timetables")}
                disabled={!allRequiredReady}
              >
                Generate Timetable
                <span className="font-mono text-xs opacity-70">
                  {allRequiredReady ? "→" : "setup first"}
                </span>
              </Button>
              <Button
                variant="outline"
                className="w-full justify-between"
                onClick={() => router.push("/overrides")}
              >
                Record Faculty Absence
                <span className="font-mono text-xs text-muted-foreground">→</span>
              </Button>
              <Button
                variant="outline"
                className="w-full justify-between"
                onClick={() => router.push("/constraints")}
              >
                Add Scheduling Rules
                <span className="font-mono text-xs text-muted-foreground">→</span>
              </Button>
            </div>
          </section>

          {/* At a glance · mono tabular metrics */}
          <section className="rounded-lg border border-border bg-background">
            <div className="border-b border-border px-4 py-3">
              <h3 className="text-sm font-semibold">At a Glance</h3>
            </div>
            <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-b-lg bg-border">
              {metrics.map(({ label, value }) => (
                <div key={label} className="bg-background px-4 py-3">
                  <dt className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
                    {label}
                  </dt>
                  <dd className="mt-1 font-mono text-2xl font-semibold tabular-nums">
                    {value === null ? (
                      <span className="text-muted-foreground/50">··</span>
                    ) : (
                      value
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      </div>
    </div>
  );
}
