// The alarm tools as the live bot has them, for benches that check nothing
// else got worse with them on every call. `record(name, args)` sees each call.
import { AlarmClock } from '../dist/features/alarms.js';
import { ALARM_RULE, alarmTools } from '../dist/features/alarm-tools.js';
import { Reminders } from '../dist/features/reminders.js';

export function alarmKit(timezone, record) {
  const clock = new AlarmClock(undefined, timezone, { placeFor: () => 'discord', ring: () => ({ stop() {}, alive: () => true }), dm: async () => true });
  const reminders = new Reminders(undefined, timezone, () => {});
  const tools = [
    ...reminders.tools().filter((t) => t.spec.name === 'set_reminder'),
    ...alarmTools({ clock, reminders, english: () => true, reach: () => 'call', preview: async () => true, saveClip: async () => 'Not in this bench.', musicOk: true }),
  ].map((t) => ({ ...t, run: (a, s, ctx) => (record(t.spec.name, a), t.run(a, s, ctx)) }));
  return { tools, rule: ALARM_RULE };
}
