import { describe, expect, it } from "vitest";
import { inviteErrorOutcome, inviteSavedMessage, inviteStatus, removalProblem, roleChangeCopy, roleChangeProblem, validateInvite } from "./members";

const existing = { memberEmails: ["owner@example.com"], openInviteEmails: ["pending@example.com"] };

describe("validateInvite", () => {
  it("accepts a new email with a role", () => {
    expect(validateInvite({ email: " New@Example.com ", role: "viewer" }, existing)).toEqual({ ok: true, email: "new@example.com", role: "viewer" });
  });
  it.each([
    [{ email: "bad", role: "viewer" }, "Enter a valid email address."],
    [{ email: "owner@example.com", role: "viewer" }, "That person is already a member."],
    [{ email: "pending@example.com", role: "viewer" }, "That person is already invited."],
  ])("rejects %j", (input, message) => {
    expect(validateInvite(input, existing)).toEqual({ ok: false, fieldErrors: { email: message } });
  });
  it("rejects an unknown role", () => {
    expect(validateInvite({ email: "x@example.com", role: "admin" }, existing)).toEqual({ ok: false, fieldErrors: { role: "Pick a role." } });
  });
});

describe("last owner protection", () => {
  const owner = { id: "o1", role: "owner" as const };
  it("refuses to demote the last owner", () => {
    expect(roleChangeProblem(owner, "operator", 1)).toBe("The console needs at least one owner. Make someone else an owner first.");
    expect(roleChangeProblem(owner, "operator", 2)).toBeNull();
  });
  it("refuses to remove yourself or the last owner", () => {
    expect(removalProblem(owner, { id: "o1" }, 2)).toBe("You can't remove yourself. Ask another owner.");
    expect(removalProblem(owner, { id: "o2" }, 1)).toBe("The console needs at least one owner. Make someone else an owner first.");
    expect(removalProblem({ id: "v1", role: "viewer" }, { id: "o1" }, 1)).toBeNull();
  });
});

describe("inviteStatus", () => {
  const now = new Date("2026-10-11T10:00:00Z");
  it("is open, expired or used", () => {
    expect(inviteStatus({ expiresAt: new Date("2026-10-18T10:00:00Z"), acceptedAt: null }, now)).toBe("open");
    expect(inviteStatus({ expiresAt: new Date("2026-10-10T10:00:00Z"), acceptedAt: null }, now)).toBe("expired");
    expect(inviteStatus({ expiresAt: new Date("2026-10-18T10:00:00Z"), acceptedAt: now }, now)).toBe("used");
  });
});

describe("inviteErrorOutcome", () => {
  it("recognises an existing login", () => {
    expect(inviteErrorOutcome({ code: "email_exists", message: "A user with this email address has already been registered" })).toBe("exists");
  });
  it("asks to retry anything else", () => {
    expect(inviteErrorOutcome({ code: "unexpected_failure", message: "boom" })).toBe("retry");
    expect(inviteErrorOutcome({ code: "email_address_not_authorized", message: "Email address not authorized" })).toBe("retry");
    expect(inviteErrorOutcome({ message: "boom" })).toBe("retry");
  });
});

describe("inviteSavedMessage", () => {
  it("tells the owner where the invitee signs in, and that sign-in emails need custom SMTP", () => {
    expect(inviteSavedMessage("new@example.com", "https://console.example.com")).toBe(
      "Invite saved. Ask new@example.com to sign in at https://console.example.com/signin within 7 days. " +
        "Sign-in emails reach only Supabase team members until custom SMTP is set up.",
    );
  });
});

describe("roleChangeCopy", () => {
  it("treats promoting to Owner as dangerous", () => {
    expect(roleChangeCopy("a@b.co", "viewer", "owner")).toMatchObject({ title: "Make a@b.co an Owner?", cta: "Make Owner", danger: true });
  });
  it("treats demoting an Owner as dangerous", () => {
    const c = roleChangeCopy("a@b.co", "owner", "operator");
    expect(c).toMatchObject({ title: "Change a@b.co to Operator?", danger: true });
    expect(c.body).toMatch(/^They lose access to connections, users, and settings./);
  });
  it("is plain for operator and viewer changes", () => {
    expect(roleChangeCopy("a@b.co", "operator", "viewer")).toMatchObject({ title: "Change a@b.co to Viewer?", cta: "Change to Viewer", danger: false });
  });
});
