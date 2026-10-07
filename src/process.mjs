import { execa } from "execa";

/** Limit command output and run time, and stop child processes too. */
export const runProcess = execa({
  timeout: 600_000,
  maxBuffer: 64 * 1024 * 1024,
  forceKillAfterDelay: 1000,
  killDescendants: true,
});
