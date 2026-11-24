import { describe, expect, it } from "vitest";
import { RoomManager } from "./manager.js";

const out = () => ({ toRoom() {}, toUser() {}, kill() {} });
describe("RoomManager boss floors", () => {
  it("keeps boss floors private: no matching, joinable only by code", () => {
    const m = new RoomManager(out);
    const a = m.place("a", 10) as { room: { id: string; code: string } };
    const b = m.place("b", 10) as { room: { id: string } };
    expect(a.room.id === b.room.id).toBe(false);
    const c = m.place("c", 10, a.room.code) as { room: { id: string } };
    expect(c.room.id).toBe(a.room.id);
    const x = m.place("x", 3) as { room: { id: string } }, y = m.place("y", 3) as { room: { id: string } };
    expect(x.room.id).toBe(y.room.id); // ordinary floors still share a room
  });
});
