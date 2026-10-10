/**
 * Rule-based briefing text generation. Mirrors server.py brief_text().
 * Dates are computed in Asia/Dhaka; statistics come only from available rows.
 */
import { dhakaToday } from './util.ts';

function extract(kind: string, rows: Record<string, any>[]): Record<string, any>[] {
  return rows.filter((r) => r.kind === kind).map((r) => r.data);
}

function statusDone(d: Record<string, any>): boolean {
  return ['done', 'completed', 'complete'].includes(String(d.status ?? '').toLowerCase()) || d.completed === true;
}

export function briefText(
  type: string,
  rows: Record<string, any>[],
): { summary: string; details: string[] } {
  const tasks = extract('tasks', rows);
  const events = extract('events', rows);
  const msgs = extract('messages', rows);
  const habits = extract('habits', rows);
  const today = dhakaToday();
  const daily = tasks.filter(
    (t) => String(t.due ?? '').slice(0, 10) === today && !statusDone(t),
  );
  const overdue = tasks.filter(
    (t) =>
      String(t.due ?? '').slice(0, 10) !== '' &&
      String(t.due ?? '').slice(0, 10) < today &&
      !statusDone(t),
  );
  const schedule = events.filter((e) => String(e.start ?? '').slice(0, 10) === today);
  const unread = msgs.filter(
    (m) => m.unread === true || String(m.status ?? '').toLowerCase() === 'unread',
  );

  if (type === 'morning') {
    const summary = `Today you have ${daily.length} open due tasks, ${schedule.length} calendar events, and ${unread.length} unread messages in synced data.`;
    const details = [
      daily.length
        ? `Priority tasks: ${daily
            .slice(0, 3)
            .map((t) => String(t.title ?? 'Untitled'))
            .join(', ')}.`
        : 'No due tasks found in current snapshots.',
      overdue.length
        ? `${overdue.length} overdue tasks require review.`
        : 'No overdue tasks found.',
      'Check source freshness in Integrations before relying on this overview.',
    ];
    return { summary, details };
  }

  if (type === 'evening') {
    const completed = tasks.filter(
      (t) => statusDone(t) && String(t.completed_at ?? '').slice(0, 10) === today,
    );
    const summary = `Today’s available records show ${completed.length} completed tasks and ${daily.length} remaining due tasks.`;
    const details = [
      completed.length
        ? `Completed: ${completed
            .slice(0, 3)
            .map((t) => String(t.title ?? 'Untitled'))
            .join(', ')}.`
        : 'No completed-task timestamps recorded for today.',
      'Tomorrow’s priorities should be confirmed against the latest task and calendar sync.',
    ];
    return { summary, details };
  }

  // weekly
  const summary = `Your synced workspace currently has ${tasks.length} tasks, ${events.length} events, and ${habits.length} habits.`;
  const details = [
    'Review weekly task completion, focus records and outreach conversations.',
    'Statistics depend on available historical records.',
  ];
  return { summary, details };
}
