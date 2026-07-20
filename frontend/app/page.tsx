/* Hallmark · genre: modern-minimal · macrostructure: Map / Diagram
 * theme: project shadcn system (amber --primary · Inter + JetBrains Mono) · enrichment: none
 * nav: N9 edge-aligned · footer: Ft5 statement · tone: technical · audience: university admins
 */
import Link from "next/link";

const INPUTS = ["Departments", "Rooms", "Faculty", "Subjects", "Calendar", "Scheduling rules"];

const LEGEND = [
  {
    step: "1.0",
    label: "CONFIGURE",
    body: "Model the institution — departments, rooms, faculty availability, subjects, and the academic calendar. Entered once at the start of the year.",
  },
  {
    step: "2.0",
    label: "CONSTRAINT",
    body: "Write scheduling rules in plain language. A parser turns “no labs after 4pm” into hard constraints the solver must honour.",
  },
  {
    step: "3.0",
    label: "SOLVE",
    body: "A CP-SAT engine (Google OR-Tools) searches for a feasible, conflict-free assignment. Progress streams live over SSE while it runs.",
  },
  {
    step: "4.0",
    label: "OPERATE",
    body: "Published timetables are immutable. A lightweight greedy engine resolves absences and room blocks — the heavy solver never runs twice.",
  },
];

/* Drawn edge: horizontal line + right arrowhead on desktop,
 * vertical line + down arrowhead on mobile. */
function Connector() {
  return (
    <div aria-hidden className="flex items-center justify-center">
      {/* desktop — horizontal */}
      <div className="hidden w-10 items-center md:flex">
        <span className="h-0.5 flex-1 bg-primary/50" />
        <span className="h-0 w-0 border-y-[5px] border-l-[8px] border-y-transparent border-l-primary/70" />
      </div>
      {/* mobile — vertical */}
      <div className="flex flex-col items-center py-1 md:hidden">
        <span className="h-6 w-0.5 bg-primary/50" />
        <span className="h-0 w-0 border-x-[5px] border-t-[8px] border-x-transparent border-t-primary/70" />
      </div>
    </div>
  );
}

/* Always-vertical drop edge for the branch. */
function DropConnector() {
  return (
    <div aria-hidden className="flex flex-col items-center">
      <span className="h-8 w-0.5 bg-primary/50" />
      <span className="h-0 w-0 border-x-[5px] border-t-[8px] border-x-transparent border-t-primary/70" />
    </div>
  );
}

/* Numbered station badge sitting on a node. */
function NodeBadge({ n }: { n: number }) {
  return (
    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary font-mono text-xs font-semibold tabular-nums text-primary-foreground">
      {n}
    </span>
  );
}

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* N9 · edge-aligned nav */}
      <header className="border-b border-border">
        <div className="flex items-center justify-between px-6 py-4">
          <Link href="/" className="text-sm font-semibold tracking-tight">
            Timetable<span className="text-primary"> Optimizer</span>
          </Link>
          <Link
            href="/login"
            className="text-sm font-medium whitespace-nowrap transition-colors hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Sign in &rarr;
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6">
        {/* Orientation */}
        <section className="pt-16 pb-10 md:pt-24">
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">
            System map
          </p>
          <h1
            className="mt-4 max-w-3xl text-4xl font-semibold leading-[1.08] tracking-tight sm:text-5xl"
            style={{ overflowWrap: "anywhere" }}
          >
            Four inputs, <span className="text-primary">one solver</span>, one
            published term.
          </h1>
          <p className="mt-5 max-w-2xl text-lg leading-relaxed text-muted-foreground">
            The whole system, on one page. Configuration and rules feed a
            constraint solver that produces a conflict-free semester schedule.
            Daily changes branch off to a separate engine and never touch it.
          </p>
        </section>

        {/* The diagram · the map IS the page */}
        <section
          className="rounded-2xl border border-border bg-muted/20 p-6 sm:p-10"
          style={{
            backgroundImage:
              "radial-gradient(var(--border) 1px, transparent 1px)",
            backgroundSize: "22px 22px",
          }}
        >
          {/* Main flow: 1 INPUTS → 2 SOLVER → 3 PUBLISHED */}
          <div className="grid grid-cols-1 items-stretch gap-2 md:grid-cols-[1fr_auto_1.25fr_auto_1fr] md:gap-0">
            {/* 1 · Inputs */}
            <div className="rounded-xl border border-border bg-background p-5">
              <div className="flex items-center gap-2.5">
                <NodeBadge n={1} />
                <span className="font-mono text-[11px] uppercase tracking-[0.15em] text-muted-foreground">
                  Configure + constraint
                </span>
              </div>
              <ul className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1.5">
                {INPUTS.map((i) => (
                  <li
                    key={i}
                    className="flex items-center gap-2 text-sm text-foreground"
                  >
                    <span
                      aria-hidden
                      className="h-1 w-1 shrink-0 rounded-full bg-primary"
                    />
                    {i}
                  </li>
                ))}
              </ul>
            </div>

            <Connector />

            {/* 2 · Solver — the heart, visually dominant */}
            <div className="flex flex-col rounded-xl border-2 border-primary/50 bg-primary/5 p-5 shadow-sm ring-1 ring-primary/10">
              <div className="flex items-center gap-2.5">
                <NodeBadge n={2} />
                <span className="font-mono text-[11px] uppercase tracking-[0.15em] text-primary">
                  Solve
                </span>
              </div>
              <h2 className="mt-3 text-xl font-semibold tracking-tight">
                CP-SAT solver
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                Google OR-Tools searches for a feasible, conflict-free
                assignment. Departments run in parallel; progress streams over
                SSE.
              </p>
            </div>

            <Connector />

            {/* 3 · Published */}
            <div className="flex flex-col rounded-xl border border-border bg-background p-5">
              <div className="flex items-center gap-2.5">
                <NodeBadge n={3} />
                <span className="font-mono text-[11px] uppercase tracking-[0.15em] text-muted-foreground">
                  Publish
                </span>
              </div>
              <h2 className="mt-3 text-lg font-semibold tracking-tight">
                Published timetable
              </h2>
              <span className="mt-4 inline-flex w-fit items-center gap-1.5 rounded-full border border-primary/30 bg-primary/5 px-2.5 py-1 font-mono text-[11px] uppercase leading-none tracking-wide text-primary md:mt-auto">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-primary" />
                Immutable
              </span>
            </div>
          </div>

          {/* Branch drops off the published term */}
          <div className="mt-4 flex flex-col items-center">
            <DropConnector />
            <span className="mt-2 font-mono text-[11px] uppercase tracking-[0.15em] text-muted-foreground">
              After publishing &middot; runs daily
            </span>
          </div>

          {/* 4 · Greedy daily engine — separate lane (dashed) */}
          <div className="mt-4 flex flex-col gap-5 rounded-xl border border-dashed border-primary/40 bg-background p-5 sm:p-6 md:flex-row md:items-center md:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2.5">
                <NodeBadge n={4} />
                <span className="font-mono text-[11px] uppercase tracking-[0.15em] text-muted-foreground">
                  Operate
                </span>
              </div>
              <h2 className="mt-3 text-lg font-semibold tracking-tight">
                Greedy daily engine
              </h2>
              <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
                Append-only. Resolves changes against the published schedule
                without re-running the solver.
              </p>
            </div>
            <ul className="flex flex-wrap gap-2 md:shrink-0">
              {["Substitutes", "Room swaps", "Makeup classes"].map((t) => (
                <li
                  key={t}
                  className="rounded-lg border border-border bg-muted/40 px-3 py-1.5 text-sm text-muted-foreground"
                >
                  {t}
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* Legend — the good copy, as node annotations */}
        <section className="py-16">
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">
            Legend
          </p>
          <dl className="mt-8 grid gap-x-10 gap-y-8 sm:grid-cols-2">
            {LEGEND.map((n) => (
              <div key={n.step} className="flex gap-4">
                <span className="shrink-0 font-mono text-lg font-semibold tabular-nums text-primary">
                  {n.step}
                </span>
                <div className="min-w-0">
                  <dt className="font-mono text-xs uppercase tracking-[0.15em] text-foreground">
                    {n.label}
                  </dt>
                  <dd className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    {n.body}
                  </dd>
                </div>
              </div>
            ))}
          </dl>

          {/* Single CTA below the map */}
          <div className="mt-12">
            <Link
              href="/login"
              className="inline-flex items-center rounded-lg bg-primary px-6 py-3 text-sm font-medium whitespace-nowrap text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              Open the console &rarr;
            </Link>
          </div>
        </section>
      </main>

      {/* Ft5 · statement footer */}
      <footer className="border-t border-border">
        <div className="mx-auto max-w-6xl px-6 py-14">
          <p className="max-w-2xl text-2xl font-semibold leading-snug tracking-tight">
            A timetable is a constraint problem.{" "}
            <span className="text-muted-foreground">
              This solves it exactly, then runs the term.
            </span>
          </p>
          <div className="mt-8 flex flex-col gap-2 border-t border-border pt-6 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <span className="font-semibold text-foreground">Timetable Optimizer</span>
            <span className="font-mono text-xs uppercase tracking-[0.15em]">
              Capstone project
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
