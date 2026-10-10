/**
 * Shared allowlists and constants. Mirrors server.py / mcp_remote.py.
 */

export const SOURCES = ['ticktick', 'instantly', 'calendar', 'gmail', 'notion', 'other'];

export const KINDS = [
  'tasks',
  'events',
  'messages',
  'projects',
  'notes',
  'goals',
  'finance',
  'habits',
  'focus',
  'briefings',
  'notifications',
];

export const WIDGETS = [
  'briefing',
  'tasks',
  'schedule',
  'outreach',
  'habits',
  'focus',
  'projects',
  'analytics',
  'capture',
];

export const THEMES = ['dark', 'light', 'forest', 'mocha'];

export const SETTING_KEYS = [
  'theme',
  'widgets',
  'widget_order',
  'hero_tagline',
  'morning_time',
  'evening_time',
  'display_name',
  'focus_goal',
  'notifications',
];

export const ACTION_ALLOWLIST = [
  'task.complete',
  'task.reopen',
  'task.create',
  'task.update',
  'event.create',
  'note.create',
  'message.draft',
];

export const SUPPORTED_PROTOCOLS = ['2025-03-26', '2025-06-18', '2025-11-25'];

export const MCP_BODY_MAX_BYTES = 2_000_000;
export const SYNC_BODY_MAX_BYTES = 3_000_000;
export const RECORD_MAX_BYTES = 100_000;
