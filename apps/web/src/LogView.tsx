import { useEffect, useRef, useState } from "react";

/**
 * §10 log view — a background job's output (guard 4).
 *
 * Tail-follows by default and stops following the moment you scroll up, because the
 * reason to scroll up is to read something that would otherwise be yanked away. `k`
 * kills the job, through a warning modal rather than a danger one: killing a job is
 * reversible by running it again.
 */

export interface JobState {
  jobId: string;
  cmd: string;
  running: boolean;
  exitCode: number | null;
  killed: boolean;
  lines: string[];
}

export interface LogViewProps {
  job: JobState | undefined;
  focused: boolean;
  onKill: (jobId: string) => void;
  onEscape: () => void;
}

/** The status as the block's bottom border shows it. */
export function jobStatus(job: JobState | undefined): string {
  if (!job) return "no such job";
  if (job.running) return "running";
  if (job.killed) return "killed";
  return `exited ${job.exitCode ?? "?"}`;
}

export function LogView({ job, focused, onKill, onEscape }: LogViewProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);

  useEffect(() => {
    const el = ref.current;
    if (el && following) el.scrollTop = el.scrollHeight;
  }, [job?.lines.length, following]);

  useEffect(() => {
    if (focused) ref.current?.focus();
  }, [focused]);

  const onScroll = (): void => {
    const el = ref.current;
    if (!el) return;
    // Back at the bottom means follow again — no need for a separate control.
    setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "k" && job?.running) {
      e.preventDefault();
      onKill(job.jobId);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onEscape();
    }
  };

  return (
    <>
      <div
        className="body log"
        ref={ref}
        tabIndex={0}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
        aria-label="job output"
      >
        {job ? job.lines.map((line, i) => <div key={i} className="log-line">{line}</div>) : null}
        {job && job.lines.length === 0 && <div className="dim">(no output yet)</div>}
        {!job && <div className="dim">this job is gone — jobs do not survive a restart</div>}
      </div>
      <div className="tb log-tb">
        {jobStatus(job)}
        {job?.running ? " · k kill" : ""}
        {following ? "" : " · paused"}
      </div>
    </>
  );
}
