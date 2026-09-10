import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrainGateInvariantError } from "@braingate/core";
import { ProviderAcceptanceStore, SUBSCRIPTION_SELF_ATTESTATION, UNSCOPED_PROVIDER_RISK } from "./provider-acceptance.js";

function store() {
  return new ProviderAcceptanceStore(join(mkdtempSync(join(tmpdir(), "braingate-acceptance-")), "provider-acceptance.json"));
}

test("nothing is accepted until the operator says so", () => {
  const acceptance = store();
  assert.deepEqual(acceptance.load(), []);
  assert.equal(acceptance.find("google"), null);
});

test("an acceptance records what was agreed to, not just that something was", () => {
  const acceptance = store();
  const record = acceptance.accept("google");
  // A later reader — a person, or a support thread six weeks from now — must be able to see the
  // sentence the operator was shown, rather than infer it from the code as it stands then.
  assert.match(record.acknowledged, new RegExp(UNSCOPED_PROVIDER_RISK.slice(0, 40)));
  assert.match(record.acknowledged, new RegExp(SUBSCRIPTION_SELF_ATTESTATION.slice(0, 40)));
  assert.equal(acceptance.find("google")?.providerId, "google");
});

test("acceptance expires, so a decision has to be made again rather than inherited", () => {
  const acceptance = store();
  const record = acceptance.accept("google", { now: new Date("2026-01-01T00:00:00Z") });
  const days = (new Date(record.expiresAt).getTime() - new Date(record.acceptedAt).getTime()) / 86_400_000;
  assert.equal(days, 30, "the window must match the subscription attestation it also carries");
  assert.throws(
    () => acceptance.accept("google", { ttlDays: 400 }),
    (error: unknown) => error instanceof BrainGateInvariantError && error.code === "PROVIDER_ACCEPTANCE_INVALID",
  );
});

test("accepting the same provider twice replaces the decision rather than stacking it", () => {
  const acceptance = store();
  acceptance.accept("google", { now: new Date("2026-01-01T00:00:00Z") });
  acceptance.accept("google", { now: new Date("2026-02-01T00:00:00Z") });
  const all = acceptance.load();
  assert.equal(all.length, 1);
  assert.equal(all[0]!.acceptedAt, "2026-02-01T00:00:00.000Z");
});

test("revoking closes the provider again and says whether there was anything to close", () => {
  const acceptance = store();
  assert.equal(acceptance.revoke("google"), false);
  acceptance.accept("google");
  assert.equal(acceptance.revoke("google"), true);
  assert.deepEqual(acceptance.load(), []);
});

test("the store is written for its own owner and nobody else", () => {
  const acceptance = store();
  acceptance.accept("google");
  // The file records a decision about this machine's exposure. It carries no credential, and
  // it is not readable by other accounts.
  const raw = readFileSync(acceptance.path, "utf8");
  assert.doesNotMatch(raw, /token|password|secret|api[_-]?key/i);
  assert.match(raw, /"schemaVersion": 1/);
});

test("a corrupt or hand-edited store fails loudly instead of reading as 'nothing accepted'", () => {
  const acceptance = store();
  // Silently treating an unreadable store as empty would be safe here — but it would also hide
  // a tampered file, and the same helper is what tells doctor the truth about the machine.
  writeFileSync(acceptance.path, "{ not json", "utf8");
  assert.throws(() => acceptance.load(), (error: unknown) => error instanceof BrainGateInvariantError && error.code === "PROVIDER_ACCEPTANCE_PARSE");

  writeFileSync(acceptance.path, JSON.stringify({ schemaVersion: 1, records: [{ providerId: "google", source: "assumed", acceptedAt: "x", expiresAt: "y" }] }), "utf8");
  assert.throws(() => acceptance.load(), (error: unknown) => error instanceof BrainGateInvariantError && error.code === "PROVIDER_ACCEPTANCE_INVALID");
});

test("allowing the web is a different decision from accepting an unscoped provider", () => {
  const store = new ProviderAcceptanceStore(join(mkdtempSync(join(tmpdir(), "braingate-acceptance-web-")), "acceptance.json"));
  store.accept("google");
  store.accept("xai", { source: "operator-accepted-network-access" });

  // Neither answers for the other, for the same provider or across providers.
  assert.notEqual(store.find("google", "operator-accepted-unscoped-provider"), null);
  assert.equal(store.find("google", "operator-accepted-network-access"), null);
  assert.notEqual(store.find("xai", "operator-accepted-network-access"), null);
  assert.equal(store.find("xai"), null);

  // One provider can hold both, and they are revoked separately.
  store.accept("google", { source: "operator-accepted-network-access" });
  assert.equal(store.load().filter((record) => record.providerId === "google").length, 2);
  assert.equal(store.revoke("google", "operator-accepted-network-access"), true);
  assert.notEqual(store.find("google"), null, "revoking the web must not revoke the provider");
});

test("the risk each decision records is the risk that decision carries", () => {
  const store = new ProviderAcceptanceStore(join(mkdtempSync(join(tmpdir(), "braingate-acceptance-risk-")), "acceptance.json"));
  assert.match(store.accept("google").acknowledged, /cannot be scoped per invocation/);
  assert.match(store.accept("google", { source: "operator-accepted-network-access" }).acknowledged, /sends the task and the context/);
});
