import { randomUUID } from 'node:crypto';
import type { Message } from '../types.js';
import { jobLine, type Job } from '../jobs.js';
export function runningJobReminder(
  jobs: Job[],
  visible: Message[],
): Message | undefined {
  const text = visible.map((message) => message.content).join('\n');
  const forgotten = jobs.filter(
    (job) => !new RegExp(`\\b${job.id}\\b`).test(text),
  );
  if (!forgotten.length) return undefined;
  return {
    id: randomUUID(),
    role: 'user',
    internal: 'job_reminder',
    content: `<system-reminder data-source="circle-jobs">\nBackground jobs you started are still running:\n${forgotten.map(jobLine).join('\n')}\nA notice arrives when each ends; stop one with stop_job.\n</system-reminder>`,
  };
}
export function pollingJobReminder(
  jobs: Job[],
  raw: Message[],
): Message | undefined {
  if (!jobs.length || raw.at(-1)?.role !== 'tool') return undefined;
  const lastUser = raw.findLastIndex(
    (message) => message.role === 'user' && !message.internal,
  );
  const previous = raw.findLastIndex(
    (message) => message.internal === 'job_poll_reminder',
  );
  const recent = raw
    .slice(Math.max(lastUser, previous) + 1)
    .flatMap((message) => message.tool_calls ?? [])
    .slice(-8);
  const polls = recent.filter(
    (call) =>
      call.name === 'list_jobs' ||
      (call.name === 'read_file' &&
        String(call.args.file_path ?? '').includes('background_jobs/')) ||
      (call.name === 'execute' &&
        !call.args.background &&
        /^\s*sleep\s/.test(String(call.args.command ?? ''))),
  );
  if (polls.length < 2) return undefined;
  return {
    id: randomUUID(),
    role: 'user',
    internal: 'job_poll_reminder',
    content: `<system-reminder data-source="circle-jobs">\nYou are waiting for background jobs by polling. A notice arrives when ${jobs.map((job) => `${job.id} (${job.title})`).join(', ')} ends and can start a turn while idle. End your turn instead of polling or sleeping.\n</system-reminder>`,
  };
}
