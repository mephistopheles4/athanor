// athanor's own failure: bad configuration, a failed build, Docker unreachable,
// a broken image contract, a failed snapshot or a bad environment value.
// The CLI turns it into exit 125.
export class AthanorError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AthanorError';
  }
}

export const EXIT = Object.freeze({ setup: 125, timeout: 124, interrupted: 130, memory: 137 });
