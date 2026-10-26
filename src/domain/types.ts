export type CredentialStatus = {
  fieldName: string;
  configured: true;
};

export class NotFoundError extends Error {
  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`);
    this.name = "NotFoundError";
  }
}

// A request the person or the assistant can correct: its message says what to change and names nothing internal, so a
// page shows it as it is. Any other error is a fault of APIUniCon and is not shown.
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}
