import { NextResponse } from "next/server";
import { describe, expect, it } from "vitest";
import { clearSessionCookie, SESSION_COOKIE, sessionCookieOptions, setSessionCookie } from "./session-cookie";

describe("wp_session cookie", () => {
  it("is httpOnly, lax, path / and lives 30 days; secure only behind https", () => {
    expect(sessionCookieOptions("https://ops.example.com")).toEqual({ httpOnly: true, sameSite: "lax", secure: true, path: "/", maxAge: 30 * 24 * 60 * 60 });
    expect(sessionCookieOptions("http://127.0.0.1:3100").secure).toBe(false);
    expect(sessionCookieOptions(undefined).secure).toBe(false);
    expect(sessionCookieOptions("not a url").secure).toBe(false);
  });

  it("sets and clears the cookie with the same flags", () => {
    const res = NextResponse.next();
    setSessionCookie(res.cookies, "tok", "https://ops.example.com");
    expect(res.cookies.get(SESSION_COOKIE)).toMatchObject({ name: "wp_session", value: "tok", httpOnly: true, sameSite: "lax", secure: true, path: "/", maxAge: 2592000 });
    clearSessionCookie(res.cookies, "https://ops.example.com");
    expect(res.cookies.get(SESSION_COOKIE)).toMatchObject({ value: "", maxAge: 0, path: "/", httpOnly: true, secure: true });
    expect(res.headers.get("set-cookie")).toMatch(/^wp_session=; Path=\/; Max-Age=0; .*HttpOnly/i);
  });
});
