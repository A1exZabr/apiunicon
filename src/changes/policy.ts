// Why a host does not let changes run now. The message is for the AI, which passes it on to the person.
export type WriteRefusal = { reason: "plan"; message: string };

// What a host decides about changing data. The core has no plans; a host, such as the cloud, refuses by the person's plan.
export interface WritePolicy {
  // Asked when a change is requested, when its page opens and again when the person confirms, so a plan that ended in
  // between refuses the click.
  check(): Promise<WriteRefusal | null>;
  // The page where the person turns changing data on for a connection.
  settingsUrl(baseUrl: string, connectionId: string): string;
}

// The local version has no plans: changes are allowed, and the switch is on the connection's page.
export const localWritePolicy: WritePolicy = {
  check: async () => null,
  settingsUrl: (baseUrl, connectionId) => `${baseUrl}/connections/${connectionId}`,
};
