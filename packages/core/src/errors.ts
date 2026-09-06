export class BrainGateInvariantError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BrainGateInvariantError";
    this.code = code;
  }
}
