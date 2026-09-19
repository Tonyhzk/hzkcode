import assert from "node:assert/strict";
import test from "node:test";
import { ThrottledText, type ThrottleClock } from "../src/hooks/throttled-text.ts";
function clock() {
  let now = 0, nextId = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const api: ThrottleClock = {
    now: () => now,
    timeout: (run, ms) => { timers.set(++nextId, { at: now + ms, run }); return nextId as unknown as ReturnType<typeof setTimeout>; },
    clearTimeout: id => { timers.delete(id as unknown as number); },
  };
  return { api, pending: () => timers.size, advance(ms: number) {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.run(); }
  } };
}
test("continuous arrivals keep a fixed deadline and publish only the latest text", () => {
  const c = clock(), t = new ThrottledText("", c.api);
  const seen: string[] = [];
  t.subscribe(() => seen.push(t.read()));
  t.update("a", 32); c.advance(8);
  t.update("ab", 32); c.advance(8);
  t.update("abc", 32); c.advance(16);
  assert.deepEqual(seen, ["abc"]);
  t.update("abcd", 32); c.advance(32);
  assert.deepEqual(seen, ["abc", "abcd"]);
  assert.equal(c.pending(), 0);
});
test("completion, longer replacement and truncation cancel obsolete tails", () => {
  const c = clock(), t = new ThrottledText("initial", c.api);
  t.update("initial pending", 128);
  assert.equal(t.bypass("a different and longer replacement", 128), true);
  t.update("a different and longer replacement", 128);
  assert.equal(t.read(), "a different and longer replacement");
  t.update("短", 128);
  t.update("短🙂", 0);
  c.advance(200);
  assert.equal(t.read(), "短🙂");
  assert.equal(c.pending(), 0);
});
test("idle arrivals publish immediately; cancel/remount preserves the pending deadline", () => {
  const c = clock(), t = new ThrottledText("", c.api);
  c.advance(200); t.update("a", 32);
  assert.equal(t.read(), "a");
  t.update("ab", 32); t.cancel();
  assert.equal(c.pending(), 0);
  c.advance(16); t.update("ab", 32); c.advance(16);
  assert.equal(t.read(), "ab");
});
