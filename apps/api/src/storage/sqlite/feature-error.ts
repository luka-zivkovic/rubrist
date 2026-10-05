export class SqliteFeatureUnavailableError extends Error {
  constructor(message='This workflow is not yet available in the SQLite development runtime.') {
    super(message);
    this.name='SqliteFeatureUnavailableError';
  }
}
