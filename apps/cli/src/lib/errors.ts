export class CliError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = code;
    this.code = code;
  }
}

// Thrown when the user cancels a prompt. fail() turns it into exit code 130.
export class Cancelled extends CliError {
  constructor() {
    super("cancelled", "Cancelled.");
  }
}

export type ErrorBody = { name: string; statusCode: number | null; message: string };

export class ApiError extends Error {
  readonly code: string;
  readonly statusCode: number | null;

  constructor(body: ErrorBody) {
    super(body.message);
    this.name = "ApiError";
    this.code = body.name;
    this.statusCode = body.statusCode;
  }
}
