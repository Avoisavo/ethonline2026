/**
 * The agent roster.
 *
 * An agent is the scarce thing being gated: one human gets exactly one, for
 * good. The roster is fixed and finite on purpose — that is what makes
 * "one per human" a meaningful claim rather than a counter that always
 * increments.
 *
 * Assignment is by position, not derived from the nullifier. Deriving the agent
 * from the nullifier (e.g. hash modulo roster size) would be tempting because
 * it needs no state, but two different humans would collide on the same agent
 * and there would be no way to tell a collision from a returning user.
 */

export type Agent = {
  id: string;
  callsign: string;
  role: string;
};

export const AGENTS: Agent[] = [
  { id: "agent-01", callsign: "Kestrel", role: "Signals" },
  { id: "agent-02", callsign: "Ardent", role: "Logistics" },
  { id: "agent-03", callsign: "Cormorant", role: "Recon" },
  { id: "agent-04", callsign: "Halcyon", role: "Analysis" },
  { id: "agent-05", callsign: "Peregrine", role: "Field" },
  { id: "agent-06", callsign: "Nightjar", role: "Counter-abuse" },
  { id: "agent-07", callsign: "Merlin", role: "Cryptography" },
  { id: "agent-08", callsign: "Osprey", role: "Liaison" },
];

export function findAgent(id: string): Agent | undefined {
  return AGENTS.find((a) => a.id === id);
}
