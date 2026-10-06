/**
 * A rejected change. The message is user-facing Portuguese without financial values. It has its own module
 * (and the package subpath `@opesvault/domain/error`) so the screens before a project is open can tell
 * these errors apart without loading the whole domain.
 */
export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainError";
  }
}
